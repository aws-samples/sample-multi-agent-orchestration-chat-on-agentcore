/**
 * Text file Content-Type mappings (with charset=utf-8).
 */
const TEXT_CONTENT_TYPES: Record<string, string> = {
  // Text files
  txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  html: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  xml: 'application/xml; charset=utf-8',

  // Programming languages
  js: 'application/javascript; charset=utf-8',
  mjs: 'application/javascript; charset=utf-8',
  cjs: 'application/javascript; charset=utf-8',
  ts: 'application/typescript; charset=utf-8',
  tsx: 'application/typescript; charset=utf-8',
  jsx: 'application/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  py: 'text/x-python; charset=utf-8',
  java: 'text/x-java; charset=utf-8',
  cpp: 'text/x-c++src; charset=utf-8',
  c: 'text/x-c; charset=utf-8',
  h: 'text/x-c; charset=utf-8',
  go: 'text/x-go; charset=utf-8',
  rs: 'text/x-rust; charset=utf-8',
  rb: 'text/x-ruby; charset=utf-8',
  sh: 'application/x-sh; charset=utf-8',
  sql: 'application/sql; charset=utf-8',

  // Configuration files
  yaml: 'application/x-yaml; charset=utf-8',
  yml: 'application/x-yaml; charset=utf-8',
  toml: 'application/toml; charset=utf-8',
  ini: 'text/plain; charset=utf-8',
  conf: 'text/plain; charset=utf-8',
  env: 'text/plain; charset=utf-8',
};

/**
 * Binary file Content-Type mappings (no charset).
 */
const BINARY_CONTENT_TYPES: Record<string, string> = {
  // Documents
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',

  // Images
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  webp: 'image/webp',
  ico: 'image/x-icon',

  // Audio / Video
  mp3: 'audio/mpeg',
  mp4: 'video/mp4',
  webm: 'video/webm',
  wav: 'audio/wav',

  // Archives
  zip: 'application/zip',
  tar: 'application/x-tar',
  gz: 'application/gzip',

  // Fonts
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
};

/**
 * Guess the Content-Type of a file based on its extension.
 * Text files include `charset=utf-8`.
 *
 * @param filename - File name or path (only the extension is used)
 * @returns MIME type string, defaults to `application/octet-stream`
 */
export function guessContentType(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase();
  if (!ext) return 'application/octet-stream';

  return TEXT_CONTENT_TYPES[ext] ?? BINARY_CONTENT_TYPES[ext] ?? 'application/octet-stream';
}
