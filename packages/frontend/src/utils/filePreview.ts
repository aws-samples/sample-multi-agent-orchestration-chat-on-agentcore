/**
 * Maps a file name to the viewer that can preview it.
 *
 * HTML is rendered only inside a sandboxed iframe (see utils/htmlSandbox.ts),
 * never in the app's origin.
 */

export type PreviewKind =
  | 'image'
  | 'video'
  | 'audio'
  | 'pdf'
  | 'markdown'
  | 'html'
  | 'csv'
  | 'code'
  | 'text'
  | 'unsupported';

export interface PreviewInfo {
  kind: PreviewKind;
  /** Prism language for `code` (and Markdown source view). */
  language?: string;
  /** Field delimiter for `csv`. */
  delimiter?: ',' | '\t';
}

const MEDIA_KINDS: Record<string, PreviewKind> = {
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  bmp: 'image',
  ico: 'image',
  avif: 'image',
  // Rendered via <img>, which never executes embedded scripts.
  svg: 'image',

  mp4: 'video',
  webm: 'video',
  mov: 'video',
  m4v: 'video',

  mp3: 'audio',
  wav: 'audio',
  ogg: 'audio',
  m4a: 'audio',
  aac: 'audio',
  flac: 'audio',

  pdf: 'pdf',
};

/** Extension → Prism language. */
const CODE_LANGUAGES: Record<string, string> = {
  json: 'json',
  jsonl: 'json',
  ndjson: 'json',
  geojson: 'json',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'jsx',
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'tsx',
  py: 'python',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  swift: 'swift',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  hpp: 'cpp',
  cc: 'cpp',
  cs: 'csharp',
  php: 'php',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  ps1: 'powershell',
  sql: 'sql',
  r: 'r',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  ini: 'ini',
  xml: 'markup',
  css: 'css',
  scss: 'scss',
  graphql: 'graphql',
  tf: 'hcl',
  diff: 'diff',
  patch: 'diff',
};

const TEXT_EXTENSIONS = new Set(['txt', 'log', 'conf', 'cfg', 'env', 'out', 'err']);

/** Extension-less files recognised by name. */
const NAMED_FILES: Record<string, PreviewInfo> = {
  dockerfile: { kind: 'code', language: 'docker' },
  makefile: { kind: 'code', language: 'makefile' },
  readme: { kind: 'text' },
  license: { kind: 'text' },
  '.gitignore': { kind: 'text' },
  '.env': { kind: 'text' },
};

export function getFileExtension(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot > 0 ? fileName.slice(dot + 1).toLowerCase() : '';
}

export function getPreviewInfo(fileName: string): PreviewInfo {
  const named = NAMED_FILES[fileName.toLowerCase()];
  if (named) return named;

  const ext = getFileExtension(fileName);
  const media = MEDIA_KINDS[ext];
  if (media) return { kind: media };
  if (ext === 'md' || ext === 'markdown') return { kind: 'markdown', language: 'markdown' };
  if (ext === 'html' || ext === 'htm') return { kind: 'html', language: 'markup' };
  if (ext === 'csv') return { kind: 'csv', delimiter: ',' };
  if (ext === 'tsv') return { kind: 'csv', delimiter: '\t' };
  const language = CODE_LANGUAGES[ext];
  if (language) return { kind: 'code', language };
  if (TEXT_EXTENSIONS.has(ext)) return { kind: 'text' };
  return { kind: 'unsupported' };
}

export function getPreviewKind(fileName: string): PreviewKind {
  return getPreviewInfo(fileName).kind;
}
