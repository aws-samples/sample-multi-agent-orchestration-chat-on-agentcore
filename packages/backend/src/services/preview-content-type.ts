/**
 * Content-Type to force on inline (preview) presigned URLs.
 *
 * Stored objects may carry `application/octet-stream` (browser uploads of
 * unknown types) or `text/html`; inline responses must be renderable by the
 * browser's native viewers yet never executable. Anything outside the
 * allow-list is served as plain text, so HTML/SVG/JS opened from a preview URL
 * in a new tab cannot run scripts on the S3 origin.
 */

const INLINE_CONTENT_TYPES: Record<string, string> = {
  pdf: 'application/pdf',

  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif',

  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',

  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  flac: 'audio/flac',
};

const SAFE_FALLBACK = 'text/plain; charset=utf-8';

export function inlinePreviewContentType(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  const ext = dot > 0 ? fileName.slice(dot + 1).toLowerCase() : '';
  return INLINE_CONTENT_TYPES[ext] ?? SAFE_FALLBACK;
}

/** RFC 6266 `inline` disposition carrying a UTF-8 file name (for PDF titles / save-as). */
export function inlineContentDisposition(fileName: string): string {
  const encoded = encodeURIComponent(fileName).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );
  return `inline; filename*=UTF-8''${encoded}`;
}
