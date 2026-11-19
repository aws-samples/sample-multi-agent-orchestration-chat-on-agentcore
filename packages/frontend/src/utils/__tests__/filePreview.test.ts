import { describe, expect, it } from 'vitest';
import { getPreviewInfo, getPreviewKind } from '../filePreview';
import {
  decodeText,
  isRangeTruncated,
  TEXT_PREVIEW_MAX_BYTES,
} from '../../components/storage/preview/useFileText';
import { resolveStorageHref } from '../../components/markdown/markdownComponents';

describe('getPreviewInfo', () => {
  it.each([
    ['a.png', 'image'],
    ['icon.SVG', 'image'],
    ['clip.mov', 'video'],
    ['voice.m4a', 'audio'],
    ['report.pdf', 'pdf'],
    ['README.md', 'markdown'],
    ['app.log', 'text'],
    ['README', 'text'],
  ])('%s → %s', (name, kind) => {
    expect(getPreviewKind(name)).toBe(kind);
  });

  it('carries the Prism language for code and JSON', () => {
    expect(getPreviewInfo('main.ts')).toEqual({ kind: 'code', language: 'typescript' });
    expect(getPreviewInfo('data.json')).toEqual({ kind: 'code', language: 'json' });
    expect(getPreviewInfo('Dockerfile')).toEqual({ kind: 'code', language: 'docker' });
  });

  it('picks the delimiter for CSV and TSV', () => {
    expect(getPreviewInfo('a.csv')).toEqual({ kind: 'csv', delimiter: ',' });
    expect(getPreviewInfo('a.tsv')).toEqual({ kind: 'csv', delimiter: '\t' });
  });

  it('previews HTML (sandboxed) with markup source highlighting', () => {
    expect(getPreviewInfo('index.html')).toEqual({ kind: 'html', language: 'markup' });
    expect(getPreviewInfo('PAGE.HTM')).toEqual({ kind: 'html', language: 'markup' });
  });

  it.each(['doc.docx', 'archive.zip', 'noext', '.png'])(
    'falls back to unsupported for %s',
    (name) => {
      expect(getPreviewKind(name)).toBe('unsupported');
    }
  );
});

describe('decodeText', () => {
  it('decodes UTF-8', () => {
    expect(decodeText(new TextEncoder().encode('日本語,abc').buffer)).toBe('日本語,abc');
  });

  it('does not fall back when the byte limit cuts a multi-byte character', () => {
    const bytes = new TextEncoder().encode('あい').slice(0, 4); // "あ" + 1 byte of "い"
    expect(decodeText(bytes.buffer)).toBe('あ');
  });

  it('falls back to Shift_JIS for invalid UTF-8', () => {
    // "日本" in Shift_JIS
    const sjis = new Uint8Array([0x93, 0xfa, 0x96, 0x7b]);
    expect(decodeText(sjis.buffer)).toBe('日本');
  });

  it('decodes UTF-16LE with a BOM (Excel "Unicode Text")', () => {
    const utf16 = new Uint8Array([0xff, 0xfe, 0x41, 0x00, 0xe5, 0x65, 0x09, 0x00, 0x42, 0x00]);
    expect(decodeText(utf16.buffer)).toBe('A日\tB');
  });

  it('keeps UTF-8 when a large text has a single stray byte', () => {
    const head = new TextEncoder().encode('ログ行です。\n'.repeat(500));
    const bytes = new Uint8Array(head.length + 1);
    bytes.set(head);
    bytes[200] = 0xff; // one invalid byte in the middle
    const text = decodeText(bytes.buffer);
    expect(text).toContain('ログ行です。');
    expect(text).toContain('�');
  });
});

describe('isRangeTruncated', () => {
  const MAX = TEXT_PREVIEW_MAX_BYTES;
  const res = (contentRange?: string) => ({
    headers: new Headers(contentRange ? { 'Content-Range': contentRange } : {}),
  });

  it('trusts the Content-Range total over the listed size', () => {
    expect(isRangeTruncated(res(`bytes 0-${MAX - 1}/${3 * MAX}`), MAX, undefined)).toBe(true);
    expect(isRangeTruncated(res(`bytes 0-${MAX - 1}/${MAX}`), MAX, 5 * MAX)).toBe(false);
  });

  it('falls back to the listed size when Content-Range is unreadable', () => {
    expect(isRangeTruncated(res(), MAX, MAX + 1)).toBe(true);
    expect(isRangeTruncated(res('bytes 0-9/*'), 10, 10)).toBe(false);
  });

  it('treats a full buffer as truncated when the size is unknown (chat dock)', () => {
    expect(isRangeTruncated(res(), MAX, undefined)).toBe(true);
    expect(isRangeTruncated(res(), 10, undefined)).toBe(false);
  });
});

describe('resolveStorageHref', () => {
  it('resolves relative paths against the file folder', () => {
    expect(resolveStorageHref('./img/a.png', '/docs/')).toBe('/docs/img/a.png');
    expect(resolveStorageHref('../a.png', '/docs/sub/')).toBe('/docs/a.png');
    expect(resolveStorageHref('a%20b.png', '/')).toBe('/a b.png');
  });

  it('keeps a malformed percent escape as written instead of throwing', () => {
    expect(resolveStorageHref('a%zz.png', '/docs/')).toBe('/docs/a%zz.png');
  });

  it('clamps at the storage root', () => {
    expect(resolveStorageHref('../../../a.png', '/docs/')).toBe('/a.png');
  });

  it('keeps absolute storage paths', () => {
    expect(resolveStorageHref('/x/y.png', '/docs/')).toBe('/x/y.png');
  });

  it.each(['https://example.com/a.png', 'mailto:a@b.c', '//cdn/a.png', '#section', '/api/x'])(
    'treats %s as a regular URL',
    (href) => {
      expect(resolveStorageHref(href, '/docs/')).toBeNull();
    }
  );
});
