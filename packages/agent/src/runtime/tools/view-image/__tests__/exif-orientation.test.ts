import { describe, it, expect } from '@jest/globals';
import {
  isAnimatedWebp,
  orientationFromTiff,
  readContainerOrientation,
} from '../exif-orientation.js';
import {
  pngOf,
  pngWithOrientation,
  quadrants,
  solid,
  tiffWithOrientation,
  webpOf,
} from './images.js';

describe('orientationFromTiff', () => {
  it.each(['II', 'MM'] as const)('reads the tag in %s byte order', (order) => {
    expect(orientationFromTiff(tiffWithOrientation(6, order))).toBe(6);
  });

  it('accepts a block that keeps the JPEG "Exif\\0\\0" prefix', () => {
    const block = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiffWithOrientation(8)]);
    expect(orientationFromTiff(block)).toBe(8);
  });

  it.each([
    ['an empty block', Buffer.alloc(0)],
    ['a bad byte-order marker', Buffer.from('XX*\0\x08\0\0\0', 'latin1')],
    [
      'an IFD offset past the end',
      (() => {
        const t = tiffWithOrientation(6);
        t.writeUInt32LE(9999, 4);
        return t;
      })(),
    ],
    ['a truncated entry', tiffWithOrientation(6).subarray(0, 16)],
    ['an out-of-range value', tiffWithOrientation(9)],
  ])('falls back to 1 for %s', (_label, block) => {
    expect(orientationFromTiff(block)).toBe(1);
  });
});

describe('readContainerOrientation', () => {
  it('reads a PNG eXIf chunk', async () => {
    expect(readContainerOrientation(pngWithOrientation(await pngOf(solid(4, 4)), 3), 'png')).toBe(
      3
    );
  });

  it('reads a WebP EXIF chunk', async () => {
    expect(readContainerOrientation(await webpOf(solid(4, 4), { orientation: 5 }), 'webp')).toBe(5);
  });

  it('returns 1 when there is no EXIF', async () => {
    expect(readContainerOrientation(await pngOf(solid(4, 4)), 'png')).toBe(1);
    expect(readContainerOrientation(await webpOf(solid(4, 4)), 'webp')).toBe(1);
  });
});

describe('isAnimatedWebp', () => {
  it('detects the VP8X animation flag', async () => {
    expect(isAnimatedWebp(await webpOf(quadrants(), { animated: true }))).toBe(true);
    expect(isAnimatedWebp(await webpOf(quadrants(), { orientation: 1 }))).toBe(false);
    expect(isAnimatedWebp(await webpOf(quadrants()))).toBe(false);
  });
});
