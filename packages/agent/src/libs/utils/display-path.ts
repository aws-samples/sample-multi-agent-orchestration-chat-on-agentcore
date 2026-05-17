import { WORKSPACE_DIRECTORY } from '../../config/index.js';

/**
 * Convert a local filesystem path to an S3 display path for chat UI.
 *
 * Because the workspace directory mirrors the S3 path hierarchy
 * (e.g., /tmp/ws/dev2/file.txt for storagePath="/dev2"),
 * the display path is simply the local path with WORKSPACE_DIRECTORY stripped.
 *
 * @example
 * // storagePath="/dev2" → workspaceDir="/tmp/ws/dev2"
 * toDisplayPath("/tmp/ws/dev2/report.md") // → "/dev2/report.md"
 * toDisplayPath("/tmp/ws/notes.md")       // → "/notes.md"
 */
export function toDisplayPath(filePath: string): string {
  if (filePath.startsWith(WORKSPACE_DIRECTORY)) {
    return filePath.slice(WORKSPACE_DIRECTORY.length) || '/';
  }
  return filePath;
}
