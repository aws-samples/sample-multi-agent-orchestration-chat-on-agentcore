/**
 * Image source resolution for the image_to_text tool.
 *
 * Pure helpers (`parseS3Uri`, `detectImageFormat`) are isolated for unit
 * testing; the I/O helpers (`getS3Client`, `fetchImageFromS3`,
 * `processLocalFile`, `getImageSource`) read from S3 or the local filesystem
 * and are exercised through the tool.
 */

import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { readFile } from 'fs/promises';
import { config } from '../../../config/index.js';
import { logger } from '../../../libs/logger/index.js';
import { createUserScopedS3Client } from '../../../libs/utils/scoped-credentials.js';
import type { ImageFormat, ImageSource } from './types.js';

/**
 * Parse an `s3://bucket/key` URI into its bucket and key parts.
 *
 * @returns `{ bucket, key }` for a well-formed URI, or `null` otherwise.
 */
export function parseS3Uri(s3Uri: string): { bucket: string; key: string } | null {
  const match = s3Uri.match(/^s3:\/\/([^/]+)\/(.+)$/);
  if (!match) return null;
  return { bucket: match[1], key: match[2] };
}

/**
 * Detect the image format from a buffer's magic bytes.
 *
 * Intentionally NOT shared with `types/validation/image-validator.ts`'s
 * `MAGIC_NUMBERS`: that table keys WebP on the 4-byte `RIFF` prefix alone, which
 * also matches WAV/AVI containers. Here we additionally require the `WEBP`
 * sub-chunk at offset 8, so this detector is stricter. If a new format is added
 * to the validator, add it here too (the two are deliberately distinct, not a
 * single source of truth).
 *
 * @returns the detected {@link ImageFormat}, or `null` when unrecognized.
 */
export function detectImageFormat(buffer: Buffer): ImageFormat | null {
  // Check magic bytes
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
 * Get an S3 client scoped to the current user, or fall back to default.
 */
export async function getS3Client(userId: string): Promise<S3Client> {
  if (config.IDENTITY_POOL_ID) {
    return createUserScopedS3Client(userId);
  }
  logger.warn(
    `[IMAGE_TO_TEXT] IDENTITY_POOL_ID is not set. ` +
      `Using execution role for user=${userId} — ` +
      `ensure IAM policy restricts access to the users/${userId}/* prefix.`
  );
  return new S3Client({ region: config.AWS_REGION });
}

/**
 * Fetch an image from S3 and resolve its format.
 */
export async function fetchImageFromS3(s3Uri: string, userId: string): Promise<ImageSource> {
  const parsed = parseS3Uri(s3Uri);
  if (!parsed) {
    throw new Error(`Invalid S3 URI format: ${s3Uri}`);
  }

  logger.debug(`[IMAGE_TO_TEXT] Fetching image from S3: ${s3Uri}`);

  try {
    const s3Client = await getS3Client(userId);
    const command = new GetObjectCommand({
      Bucket: parsed.bucket,
      Key: parsed.key,
    });

    const response = await s3Client.send(command);

    if (!response.Body) {
      throw new Error('Empty response body from S3');
    }

    // Convert stream to buffer
    const chunks: Uint8Array[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for await (const chunk of response.Body as any) {
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks);

    // Detect format
    const format = detectImageFormat(buffer);
    if (!format) {
      throw new Error('Unsupported image format. Supported formats: JPEG, PNG, GIF, WebP');
    }

    logger.debug(
      `[IMAGE_TO_TEXT] Image fetched successfully: ${format.toUpperCase()}, ${buffer.length} bytes`
    );

    return {
      type: 's3',
      data: buffer,
      format,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[IMAGE_TO_TEXT] Failed to fetch image from S3: ${errorMessage}`);
    throw new Error(`S3 fetch failed: ${errorMessage}`, { cause: error });
  }
}

/**
 * Read a local file and resolve its format.
 */
export async function processLocalFile(filePath: string): Promise<ImageSource> {
  logger.debug(`[IMAGE_TO_TEXT] Processing local file: ${filePath}`);

  try {
    // Read file
    const buffer = await readFile(filePath);

    // Detect format
    const format = detectImageFormat(buffer);
    if (!format) {
      throw new Error('Unsupported image format. Supported formats: JPEG, PNG, GIF, WebP');
    }

    logger.debug(
      `[IMAGE_TO_TEXT] Local file processed: ${format.toUpperCase()}, ${buffer.length} bytes`
    );

    return {
      type: 'local',
      data: buffer,
      format,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[IMAGE_TO_TEXT] Failed to process local file: ${errorMessage}`);
    throw new Error(`Local file processing failed: ${errorMessage}`, { cause: error });
  }
}

/**
 * Resolve an image source from a path, routing `s3://` URIs to S3 and all
 * other paths to the local filesystem.
 */
export async function getImageSource(imagePath: string, userId: string): Promise<ImageSource> {
  if (imagePath.startsWith('s3://')) {
    return fetchImageFromS3(imagePath, userId);
  } else {
    return processLocalFile(imagePath);
  }
}
