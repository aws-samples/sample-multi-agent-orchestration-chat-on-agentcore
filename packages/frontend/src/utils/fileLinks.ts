import { isStoragePath } from './storagePath';

// Inline markdown links, including the `[t](<path with spaces>)` form.
const MARKDOWN_LINK = /\]\(\s*<?([^)>\s]+)/g;
const VIDEO = /\.(mp4|webm|mov|avi|mkv|m4v)$/i;

/**
 * Does this markdown render an in-app file link (what S3FileLink opens in
 * the preview dock)? Videos render inline players instead. A link this
 * misses still opens the dock when clicked; it only keeps the toggle hidden.
 */
export function hasInAppFileLink(markdown: string): boolean {
  for (const [, href] of markdown.matchAll(MARKDOWN_LINK)) {
    if (isStoragePath(href) && !VIDEO.test(href.split(/[?#]/)[0])) return true;
  }
  return false;
}
