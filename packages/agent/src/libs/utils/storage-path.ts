/**
 * Shared per-user S3 storage-path helpers.
 *
 * Single source of truth for how a user's storage path is normalized and how
 * their object-key prefix is built. Previously this convention was inlined in
 * `s3-list-files`, `browser/client.ts`, and `services/workspace-sync.ts`; if the
 * layout ever changes (e.g. `users/` → `user-data/`) those sites would drift and
 * a tool could read from a different prefix than another wrote to.
 */

/**
 * Normalize a storage path by stripping leading and trailing slashes. Interior
 * slashes are preserved. Root (`/`) and empty input normalize to `''`.
 */
export function normalizePath(input: string): string {
  return input.replace(/^\/+|\/+$/g, '');
}

/**
 * Build the per-user S3 key prefix (no trailing slash).
 *
 * `userId` here is the Cognito Identity Pool identityId used as the storage key
 * (format: `"REGION:uuid"`).
 */
export function getUserStoragePrefix(userId: string): string {
  return `users/${userId}`;
}

/**
 * Build the full per-user object-key prefix WITH a trailing slash, optionally
 * scoped to a sub-path: `users/{storageKey}/{storagePath}/` (or
 * `users/{storageKey}/` when the path is empty).
 *
 * The `storagePath` is normalized first, so leading/trailing slashes never
 * produce a doubled separator. This is the single source of truth for the
 * S3 prefix used by WorkspaceSync writes and s3_list_files reads.
 */
export function buildUserPrefix(storageKey: string, storagePath: string): string {
  const base = getUserStoragePrefix(storageKey);
  const normalized = normalizePath(storagePath);
  return normalized ? `${base}/${normalized}/` : `${base}/`;
}

/**
 * Resolve a user-supplied storage sub-path to an absolute directory that is
 * guaranteed to stay within `baseDir`.
 *
 * The sub-path is split into segments; `.` and empty segments are dropped and
 * `..` segments pop the accumulated path but are clamped at the base (they can
 * never climb above it). The result is therefore always `baseDir` or a
 * descendant — this is the sanitization that lets the join be safe against
 * path traversal (`../../etc/passwd` → `baseDir/etc/passwd`).
 */
export function safeWorkspaceDir(baseDir: string, storagePath: string): string {
  const safeSegments = normalizePath(storagePath)
    .split('/')
    .reduce<string[]>((acc, segment) => {
      if (segment === '' || segment === '.') return acc;
      if (segment === '..') {
        acc.pop(); // clamp: never escape baseDir
        return acc;
      }
      acc.push(segment);
      return acc;
    }, []);

  if (safeSegments.length === 0) return baseDir;

  // Every segment is now a plain name (no '', '.', or '..'), so concatenating
  // them under baseDir cannot escape it. We build the path by hand (rather than
  // path.join) because the segments are already sanitized and to keep the
  // construction an explicit allowlist join.
  const base = baseDir.replace(/\/+$/, '');
  return `${base}/${safeSegments.join('/')}`;
}
