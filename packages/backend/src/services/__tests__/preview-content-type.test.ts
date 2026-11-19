import { describe, it, expect } from '@jest/globals';
import { contentDisposition, inlinePreviewContentType } from '../preview-content-type.js';

describe('inlinePreviewContentType', () => {
  it.each([
    ['report.pdf', 'application/pdf'],
    ['Clip.MP4', 'video/mp4'],
    ['voice.m4a', 'audio/mp4'],
    ['photo.jpeg', 'image/jpeg'],
  ])('maps %s to %s', (name, type) => {
    expect(inlinePreviewContentType(name)).toBe(type);
  });

  it.each(['page.html', 'page.htm', 'logo.svg', 'app.js', 'noext', '.pdf'])(
    'never serves %s as an executable type',
    (name) => {
      expect(inlinePreviewContentType(name)).toBe('text/plain; charset=utf-8');
    }
  );
});

describe('contentDisposition', () => {
  it('encodes non-ASCII and RFC 5987 reserved characters', () => {
    expect(contentDisposition('inline', "報告書 (1)'.pdf")).toBe(
      "inline; filename*=UTF-8''%E5%A0%B1%E5%91%8A%E6%9B%B8%20%281%29%27.pdf"
    );
  });

  it('marks downloads as attachments so stored HTML/Markdown is saved, not rendered', () => {
    expect(contentDisposition('attachment', '修正一覧.md')).toBe(
      "attachment; filename*=UTF-8''%E4%BF%AE%E6%AD%A3%E4%B8%80%E8%A6%A7.md"
    );
  });
});
