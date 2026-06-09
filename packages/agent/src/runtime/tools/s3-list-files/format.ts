/**
 * Pure formatting helpers for the s3_list_files tool output.
 *
 * No I/O, no clock except `formatRelativeTime` which compares against the
 * current time. All produce the exact strings the model sees in the rendered
 * file list, so they are unit-tested in isolation.
 */

// Byte-size formatting is shared across tools (see libs/utils/format-size).
// Re-exported here so the tool's own modules keep importing from one place.
export { formatFileSize } from '../../../libs/utils/format-size.js';

/**
 * Convert a date to a coarse relative-time expression (e.g. `3 hours ago`).
 */
export function formatRelativeTime(date: Date): string {
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days} days ago`;
  if (hours > 0) return `${hours} hours ago`;
  if (minutes > 0) return `${minutes} minutes ago`;
  return `${seconds} seconds ago`;
}

/**
 * Format a presigned-URL expiry duration (seconds) in human-readable form.
 */
export function formatExpiryTime(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  if (hours > 0 && minutes > 0) return `${hours}h ${minutes}m`;
  if (hours > 0) return `${hours} hour${hours > 1 ? 's' : ''}`;
  if (minutes > 0) return `${minutes} minute${minutes > 1 ? 's' : ''}`;
  return `${seconds} seconds`;
}
