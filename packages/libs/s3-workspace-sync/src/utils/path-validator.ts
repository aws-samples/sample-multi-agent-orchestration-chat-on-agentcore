import { PathValidationError } from '../errors.js';

/**
 * Maximum length of a storage path in UTF-8 bytes.
 * Mirrors the S3 object key size limit so we reject oversize input
 * before it reaches the SDK or expensive string operations.
 *
 * @see https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-keys.html
 */
const MAX_STORAGE_PATH_BYTES = 1024;

/**
 * Validate a storage path for security.
 *
 * The intent of this validator is **path traversal / injection prevention**,
 * not character-set restriction. S3 object keys legitimately contain
 * non-ASCII characters (Japanese folder names, spaces, etc.) and rejecting
 * them here breaks the working-directory feature for those users
 *
 * The following are still rejected because they are unsafe regardless of
 * locale:
 *  - Non-string inputs (callers receive `storagePath` from JSON bodies; a
 *    raw `TypeError` would otherwise surface as an unhandled HTTP 500)
 *  - Paths longer than 1024 UTF-8 bytes (S3 object key limit)
 *  - `..` traversal sequences
 *  - NUL and other ASCII control characters (log/terminal injection)
 *  - Backslash `\` (Windows-style path confusion)
 *  - Protocol-relative `//` prefix
 *  - Excessive depth (> 50 components)
 *
 * @param storagePath - Path string to validate
 * @throws {PathValidationError} if the path is invalid
 */
export function validateStoragePath(storagePath: string): void {
  if (typeof storagePath !== 'string') {
    throw new PathValidationError('Invalid storage path: must be a string');
  }

  // Reject before any further work. Byte length (not code-unit length)
  // matches the S3 limit and prevents pathological inputs from being
  // split / regex-tested.
  const byteLength = Buffer.byteLength(storagePath, 'utf8');
  if (byteLength > MAX_STORAGE_PATH_BYTES) {
    throw new PathValidationError(
      `Invalid storage path: exceeds maximum length of ${MAX_STORAGE_PATH_BYTES} bytes (got ${byteLength})`
    );
  }

  if (storagePath.includes('..')) {
    throw new PathValidationError(
      "Invalid storage path: path traversal sequences ('..') are not allowed"
    );
  }

  // Reject NUL and other ASCII control characters (0x00-0x1F, 0x7F).
  // These can corrupt logs, terminals, and downstream parsers.
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1F\x7F]/.test(storagePath)) {
    throw new PathValidationError(
      'Invalid storage path: control characters (including null bytes) are not allowed'
    );
  }

  if (storagePath.includes('\\')) {
    throw new PathValidationError('Invalid storage path: backslashes are not allowed');
  }

  if (storagePath.startsWith('//')) {
    throw new PathValidationError('Invalid storage path: protocol-relative paths are not allowed');
  }

  const depth = storagePath.split('/').filter((p) => p.length > 0).length;
  if (depth > 50) {
    throw new PathValidationError('Invalid storage path: path depth exceeds maximum allowed (50)');
  }
}
