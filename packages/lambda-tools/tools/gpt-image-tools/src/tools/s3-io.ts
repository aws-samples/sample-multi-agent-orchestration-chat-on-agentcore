/**
 * S3 helpers shared by the gpt-image generate and edit tools.
 *
 * Images live under the caller's per-user prefix `users/{identityId}/...`, the
 * same isolation scheme nova-canvas uses. Generation writes there; editing reads
 * a previously written image back (enabling stateless multi-turn editing: the
 * agent re-feeds an earlier s3:// path into the edit tool).
 */

import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { logger } from '@moca/lambda-tools-shared';

const s3Client = new S3Client({});

export function getUserStorageBucketName(): string | undefined {
  return process.env.USER_STORAGE_BUCKET_NAME;
}

export function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

/**
 * Persist a base64 image to the user's storage prefix and return its s3:// path.
 * Returns '' (and logs a warning) when no bucket is configured.
 */
export async function saveImageToS3(
  imageBase64: string,
  storagePath: string,
  filename: string,
  identityId: string,
  generatedBy: string
): Promise<string> {
  const bucket = getUserStorageBucketName();
  if (!bucket) {
    logger.warn('USER_STORAGE_BUCKET_NAME not configured, skipping S3 upload');
    return '';
  }

  const basePath = `users/${identityId}/${storagePath}`.replace(/\/+/g, '/');
  const s3Key = `${basePath}/${filename}`.replace(/\/+/g, '/');
  const imageBuffer = Buffer.from(imageBase64, 'base64');

  await s3Client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: s3Key,
      Body: imageBuffer,
      ContentType: 'image/png',
      Metadata: {
        'generated-by': generatedBy,
        'generated-at': new Date().toISOString(),
      },
    })
  );

  const s3Path = `s3://${bucket}/${s3Key}`;
  logger.info('Image saved to S3', { s3Path, size: formatFileSize(imageBuffer.length) });
  return s3Path;
}

/**
 * Parse an `s3://bucket/key` URI into its parts. Throws on malformed input.
 */
export function parseS3Uri(uri: string): { bucket: string; key: string } {
  const match = /^s3:\/\/([^/]+)\/(.+)$/.exec(uri);
  if (!match) {
    throw new Error(`Invalid S3 URI: ${uri}. Expected format: s3://bucket/key`);
  }
  return { bucket: match[1], key: match[2] };
}

/**
 * Read an object's bytes from S3. Callers are responsible for authorizing the
 * bucket/key — the Lambda role scopes s3:GetObject to the user storage bucket.
 */
export async function readS3Object(uri: string): Promise<Buffer> {
  const { bucket, key } = parseS3Uri(uri);
  const response = await s3Client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!response.Body) {
    throw new Error(`S3 object ${uri} has no body`);
  }
  const bytes = await response.Body.transformToByteArray();
  return Buffer.from(bytes);
}
