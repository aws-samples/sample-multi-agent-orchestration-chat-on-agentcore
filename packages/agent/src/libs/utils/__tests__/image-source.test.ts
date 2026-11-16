/**
 * Unit tests for loadImageSource: the two storage locations, format sniffing,
 * and the size guard that runs before bytes are read into memory.
 */

import { describe, it, expect, jest, beforeAll, afterAll, beforeEach } from '@jest/globals';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Readable } from 'stream';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
const GIF = Buffer.from('GIF89a------', 'latin1');
const WEBP = Buffer.from('RIFF----WEBP', 'latin1');

const mockSend = jest.fn<(command: { input: unknown }) => Promise<unknown>>();
const mockCreateUserScopedS3Client = jest
  .fn<(userId: string) => Promise<{ send: typeof mockSend }>>()
  .mockResolvedValue({ send: mockSend });

jest.unstable_mockModule('../scoped-credentials.js', () => ({
  createUserScopedS3Client: mockCreateUserScopedS3Client,
}));
jest.unstable_mockModule('../../logger/index.js', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { loadImageSource, detectImageFormat } = await import('../image-source.js');

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'image-source-'));
  await writeFile(join(dir, 'pic.png'), PNG);
  await writeFile(join(dir, 'mislabelled.png'), JPEG);
  await writeFile(join(dir, 'notes.png'), 'plain text');
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

beforeEach(() => {
  mockSend.mockReset();
  mockCreateUserScopedS3Client.mockClear();
});

describe('detectImageFormat', () => {
  it.each([
    ['png', PNG],
    ['jpeg', JPEG],
    ['gif', GIF],
    ['webp', WEBP],
  ])('recognises %s', (format, bytes) => {
    expect(detectImageFormat(bytes)).toBe(format);
  });

  it('returns null for anything else', () => {
    expect(detectImageFormat(Buffer.from('%PDF-1.7 ...'))).toBeNull();
  });
});

describe('loadImageSource (local)', () => {
  it('reads a file and takes the format from its bytes, not its extension', async () => {
    const source = await loadImageSource(join(dir, 'mislabelled.png'), 'user-sub');

    expect(source.type).toBe('local');
    expect(source.format).toBe('jpeg');
    expect(source.data.equals(JPEG)).toBe(true);
    expect(mockCreateUserScopedS3Client).not.toHaveBeenCalled();
  });

  it('resolves a relative path against baseDir', async () => {
    const source = await loadImageSource('pic.png', 'user-sub', { baseDir: dir });

    expect(source.format).toBe('png');
  });

  it('rejects a file that is not an image', async () => {
    await expect(loadImageSource(join(dir, 'notes.png'), 'user-sub')).rejects.toThrow(
      'Unsupported image format'
    );
  });

  it('rejects a file over maxBytes', async () => {
    await expect(
      loadImageSource(join(dir, 'pic.png'), 'user-sub', { maxBytes: PNG.length - 1 })
    ).rejects.toThrow('too large');
  });

  it('says why a missing file could not be read', async () => {
    await expect(loadImageSource(join(dir, 'nope.png'), 'user-sub')).rejects.toThrow('ENOENT');
  });
});

describe('loadImageSource (S3)', () => {
  it('fetches the object with the user-scoped client', async () => {
    mockSend.mockResolvedValue({ Body: Readable.from([PNG]), ContentLength: PNG.length });

    const source = await loadImageSource('s3://bucket/users/u/pic.png', 'user-sub');

    expect(mockCreateUserScopedS3Client).toHaveBeenCalledWith('user-sub');
    expect(mockSend.mock.calls[0][0].input).toEqual({ Bucket: 'bucket', Key: 'users/u/pic.png' });
    expect(source).toMatchObject({ type: 's3', format: 'png' });
    expect(source.data.equals(PNG)).toBe(true);
  });

  it('rejects an oversized object without reading its body', async () => {
    const body = Readable.from([PNG]);
    mockSend.mockResolvedValue({ Body: body, ContentLength: 50_000_000 });

    await expect(
      loadImageSource('s3://bucket/huge.png', 'user-sub', { maxBytes: 1_000_000 })
    ).rejects.toThrow('too large');
    expect(body.destroyed).toBe(true);
  });

  it('rejects a malformed S3 URI', async () => {
    await expect(loadImageSource('s3://bucket-only', 'user-sub')).rejects.toThrow(
      'Invalid S3 URI format'
    );
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('surfaces the S3 failure reason', async () => {
    mockSend.mockRejectedValue(new Error('Access Denied'));

    await expect(loadImageSource('s3://bucket/pic.png', 'user-sub')).rejects.toThrow(
      'S3 fetch failed: Access Denied'
    );
  });
});
