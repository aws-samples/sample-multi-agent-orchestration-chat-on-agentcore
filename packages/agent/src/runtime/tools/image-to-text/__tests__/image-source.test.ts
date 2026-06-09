import { describe, it, expect } from '@jest/globals';
import { parseS3Uri, detectImageFormat } from '../image-source.js';

describe('parseS3Uri', () => {
  it('parses a well-formed s3://bucket/key URI', () => {
    expect(parseS3Uri('s3://my-bucket/path/to/image.png')).toEqual({
      bucket: 'my-bucket',
      key: 'path/to/image.png',
    });
  });

  it('parses a single-segment key', () => {
    expect(parseS3Uri('s3://bucket/image.jpg')).toEqual({
      bucket: 'bucket',
      key: 'image.jpg',
    });
  });

  it('returns null when the scheme is not s3://', () => {
    expect(parseS3Uri('https://bucket.s3.amazonaws.com/image.png')).toBeNull();
  });

  it('returns null when there is no key', () => {
    expect(parseS3Uri('s3://bucket-only')).toBeNull();
    expect(parseS3Uri('s3://bucket/')).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(parseS3Uri('')).toBeNull();
  });
});

describe('detectImageFormat', () => {
  it('detects JPEG from its magic bytes', () => {
    const buf = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    expect(detectImageFormat(buf)).toBe('jpeg');
  });

  it('detects PNG from its magic bytes', () => {
    const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(detectImageFormat(buf)).toBe('png');
  });

  it('detects GIF from its magic bytes', () => {
    const buf = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
    expect(detectImageFormat(buf)).toBe('gif');
  });

  it('detects WebP from the RIFF/WEBP header', () => {
    // "RIFF" + 4-byte size + "WEBP"
    const buf = Buffer.from([
      0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
    ]);
    expect(detectImageFormat(buf)).toBe('webp');
  });

  it('returns null for an unrecognized format', () => {
    const buf = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05]);
    expect(detectImageFormat(buf)).toBeNull();
  });

  it('returns null for an empty buffer', () => {
    expect(detectImageFormat(Buffer.alloc(0))).toBeNull();
  });

  // A RIFF container that is NOT WebP (e.g. WAV audio: "RIFF"…"WAVE") must not
  // be misdetected as an image — this is why we check the "WEBP" sub-chunk at
  // offset 8 rather than just the RIFF prefix the validator uses.
  it('returns null for a non-WebP RIFF container (WAV)', () => {
    const buf = Buffer.from([
      0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45,
    ]);
    expect(detectImageFormat(buf)).toBeNull();
  });

  // A buffer too short to hold the WEBP sub-chunk must not throw or false-match.
  it('returns null for a truncated RIFF header (no out-of-range read)', () => {
    const buf = Buffer.from([0x52, 0x49, 0x46, 0x46]);
    expect(detectImageFormat(buf)).toBeNull();
  });

  it('does not misread a 3-byte buffer as a format', () => {
    expect(detectImageFormat(Buffer.from([0xff, 0xd8]))).toBeNull();
  });
});
