/**
 * Pure path-scoping helpers for the s3_list_files tool.
 *
 * These contain no I/O and no request-context access — they only transform
 * strings — so they are unit-tested in isolation. Path-scope enforcement keeps
 * a user from listing objects outside their permitted storage directory.
 *
 * `normalizePath` / `getUserStoragePrefix` are the shared storage-path helpers
 * (re-exported so this tool's modules import from one place);
 * `isPathWithinAllowedScope` is the s3_list_files-specific traversal guard.
 */

import { normalizePath, getUserStoragePrefix } from '../../../libs/utils/storage-path.js';

export { normalizePath, getUserStoragePrefix };

/**
 * Verify whether `inputPath` is within the `allowedBasePath` scope.
 *
 * Prevents path-traversal (`../`) escapes: a request is allowed only when it
 * targets the allowed directory itself or a descendant of it. An empty/root
 * base path permits everything.
 */
export function isPathWithinAllowedScope(inputPath: string, allowedBasePath: string): boolean {
  // Normalize paths
  const normalizedInput = normalizePath(inputPath);
  const normalizedBase = normalizePath(allowedBasePath);

  // Allow all if base path is root (empty string)
  if (!normalizedBase || normalizedBase === '/') {
    return true;
  }

  // Check if input path starts with base path or is the same
  return normalizedInput === normalizedBase || normalizedInput.startsWith(normalizedBase + '/');
}
