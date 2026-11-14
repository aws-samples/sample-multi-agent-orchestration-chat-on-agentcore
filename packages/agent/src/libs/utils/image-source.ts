/**
 * Loads image bytes from the two places agents keep images: the local
 * workspace and the user's S3 storage.
 */

import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { readFile, stat } from 'fs/promises';
import { resolve } from 'path';
import { config } from '../../config/index.js';
import { logger } from '../logger/index.js';
import { createUserScopedS3Client } from './scoped-credentials.js';

export type ImageFormat = 'jpeg' | 'png' | 'gif' | 'webp';

export interface ImageSource {
  type: 's3' | 'local';
  data: Buffer;
  format: ImageFormat;
}

export interface LoadImageOptions {
  /** Reject sources larger than this before reading them into memory. */
  maxBytes?: number;
  /** Directory that relative local paths resolve against (default: process cwd). */
  baseDir?: string;
}

const UNSUPPORTED_FORMAT_MESSAGE =
  'Unsupported image format. Supported formats: JPEG, PNG, GIF, WebP';

async function getS3Client(userId: string): Promise<S3Client> {
  if (config.IDENTITY_POOL_ID) {
    return createUserScopedS3Client(userId);
  }
  logger.warn(
    `[IMAGE_SOURCE] IDENTITY_POOL_ID is not set. ` +
      `Using execution role for user=${userId} — ` +
      `ensure IAM policy restricts access to the users/${userId}/* prefix.`
  );
  return new S3Client({ region: config.AWS_REGION });
}

function parseS3Uri(s3Uri: string): { bucket: string; key: string } | null {
  const match = s3Uri.match(/^s3:\/\/([^/]+)\/(.+)$/);
  if (!match) return null;
  return { bucket: match[1], key: match[2] };
}

/**
 * Detect the image format from magic bytes, so a wrong file extension cannot
 * mislabel the bytes sent to the model.
 */
export function detectImageFormat(buffer: Buffer): ImageFormat | null {
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'jpeg';
  }
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return 'png';
  }
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
    return 'gif';
  }
  if (buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) {
    return 'webp';
  }
  return null;
}

/**
 * Duck-typed rather than `instanceof Error`: Node raises fs errors from its own
 * realm, which fails `instanceof` wherever this module runs in a VM context.
 */
function messageOf(error: unknown): string {
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === 'string' ? message : 'Unknown error';
}

function assertWithinLimit(bytes: number | undefined, maxBytes: number | undefined): void {
  if (maxBytes !== undefined && bytes !== undefined && bytes > maxBytes) {
    throw new Error(`Image is too large: ${bytes} bytes (limit ${maxBytes} bytes)`);
  }
}

async function fetchImageFromS3(
  s3Uri: string,
  userId: string,
  options: LoadImageOptions
): Promise<ImageSource> {
  const parsed = parseS3Uri(s3Uri);
  if (!parsed) {
    throw new Error(`Invalid S3 URI format: ${s3Uri}`);
  }

  logger.debug(`[IMAGE_SOURCE] Fetching image from S3: ${s3Uri}`);

  try {
    const s3Client = await getS3Client(userId);
    const response = await s3Client.send(
      new GetObjectCommand({ Bucket: parsed.bucket, Key: parsed.key })
    );

    if (!response.Body) {
      throw new Error('Empty response body from S3');
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = response.Body as any;
    try {
      assertWithinLimit(response.ContentLength, options.maxBytes);
    } catch (error) {
      // The body is never read on this path; release its connection.
      body.destroy?.();
      throw error;
    }

    const chunks: Uint8Array[] = [];
    for await (const chunk of body) {
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks);

    const format = detectImageFormat(buffer);
    if (!format) {
      throw new Error(UNSUPPORTED_FORMAT_MESSAGE);
    }

    return { type: 's3', data: buffer, format };
  } catch (error) {
    const errorMessage = messageOf(error);
    logger.error(`[IMAGE_SOURCE] Failed to fetch image from S3: ${errorMessage}`);
    throw new Error(`S3 fetch failed: ${errorMessage}`, { cause: error });
  }
}

async function readLocalImage(filePath: string, options: LoadImageOptions): Promise<ImageSource> {
  // nosemgrep: path-join-resolve-traversal - baseDir is the working directory relative paths start from, not a containment boundary; the agent may name any image path, as with an absolute one
  const absolutePath = options.baseDir ? resolve(options.baseDir, filePath) : filePath;
  logger.debug(`[IMAGE_SOURCE] Reading local image: ${absolutePath}`);

  try {
    if (options.maxBytes !== undefined) {
      assertWithinLimit((await stat(absolutePath)).size, options.maxBytes);
    }
    const buffer = await readFile(absolutePath);

    const format = detectImageFormat(buffer);
    if (!format) {
      throw new Error(UNSUPPORTED_FORMAT_MESSAGE);
    }

    return { type: 'local', data: buffer, format };
  } catch (error) {
    const errorMessage = messageOf(error);
    logger.error(`[IMAGE_SOURCE] Failed to read local image: ${errorMessage}`);
    throw new Error(`Local file processing failed: ${errorMessage}`, { cause: error });
  }
}

/**
 * Load an image from an `s3://` URI (with the user's scoped credentials) or a
 * local file path.
 */
export async function loadImageSource(
  imagePath: string,
  userId: string,
  options: LoadImageOptions = {}
): Promise<ImageSource> {
  if (imagePath.startsWith('s3://')) {
    return fetchImageFromS3(imagePath, userId, options);
  }
  return readLocalImage(imagePath, options);
}
