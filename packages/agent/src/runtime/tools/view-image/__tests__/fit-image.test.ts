/**
 * Unit tests for fitImage: what reaches the model must fit the edge limit and
 * the byte budget, and `region` must address the image as the user sees it.
 */

import { describe, it, expect } from '@jest/globals';
import type { Orientation } from '../exif-orientation.js';
import { MAX_EDGE_PX, MAX_IMAGE_BYTES } from '../fit-image.js';
// Through the worker the tool uses: the codecs run outside jest's VM, where
// they are ~100x faster, and the worker round trip is covered too.
import { fitImageOffThread as fitImage } from '../fit-image-off-thread.js';
import {
  BLUE,
  GREEN,
  Jimp,
  RED,
  WHITE,
  dimensionsOf,
  expectColor,
  gifOf,
  image,
  jpegOf,
  jpegWithOrientation,
  noise,
  pixelAt,
  pngDeclaring,
  pngOf,
  pngWithOrientation,
  quadrants,
  solid,
  storedFor,
  webpOf,
  type RGB,
} from './images.js';

/** Sample the centre of each quadrant: top-left, top-right, bottom-left, bottom-right. */
async function quadrantColors(data: Buffer, width: number, height: number): Promise<RGB[]> {
  return Promise.all(
    [
      [width / 4, height / 4],
      [(3 * width) / 4, height / 4],
      [width / 4, (3 * height) / 4],
      [(3 * width) / 4, (3 * height) / 4],
    ].map(([x, y]) => pixelAt(data, Math.floor(x), Math.floor(y)))
  );
}

function expectQuadrants(colors: RGB[]): void {
  [RED, GREEN, BLUE, WHITE].forEach((expected, i) => expectColor(colors[i], expected));
}

// Small, because building fixtures runs the JS encoders inside jest's slow VM.
const W = 120;
const H = 80;
// Forces a decode: without a region, a small upright image is passed through untouched.
const WHOLE = { x: 0, y: 0, width: W, height: H };

describe('fitImage', () => {
  it('passes a small image through untouched', async () => {
    const data = await pngOf(solid(800, 600));

    const fitted = await fitImage({ data, format: 'png' });

    expect(fitted.bytes.equals(data)).toBe(true);
    expect(fitted).toMatchObject({ format: 'png', width: 800, height: 600 });
    expect(fitted.region).toBeUndefined();
  });

  it('downscales to the edge limit, keeps the aspect ratio and reports the original', async () => {
    const data = await pngOf(solid(3000, 2000));

    const fitted = await fitImage({ data, format: 'png' });

    expect(fitted).toMatchObject({ format: 'png', width: MAX_EDGE_PX, height: 1045 });
    expect(fitted.original).toEqual({
      width: 3000,
      height: 2000,
      format: 'png',
      bytes: data.length,
    });
    expect(await dimensionsOf(fitted.bytes)).toEqual([MAX_EDGE_PX, 1045]);
  });

  it('crops the region from the original before scaling', async () => {
    const data = await pngOf(
      image(3000, 2000, (x, y) =>
        x >= 2500 && x < 2600 && y >= 1500 && y < 1600 ? [...RED, 255] : [0x33, 0x66, 0x99, 255]
      )
    );

    const fitted = await fitImage(
      { data, format: 'png' },
      { x: 2500, y: 1500, width: 100, height: 100 }
    );

    expect(fitted).toMatchObject({ width: 100, height: 100 });
    expect(fitted.region).toEqual({ x: 2500, y: 1500, width: 100, height: 100 });
    expect(await pixelAt(fitted.bytes, 50, 50)).toEqual(RED);
    expect(await pixelAt(fitted.bytes, 0, 0)).toEqual(RED);
    expect(await pixelAt(fitted.bytes, 99, 99)).toEqual(RED);
  });

  it('clamps a region that runs past the image edge', async () => {
    const data = await pngOf(solid(3000, 2000));

    const fitted = await fitImage(
      { data, format: 'png' },
      { x: 2900.4, y: 1900, width: 500, height: 500 }
    );

    expect(fitted.region).toEqual({ x: 2900, y: 1900, width: 100, height: 100 });
    expect(fitted).toMatchObject({ width: 100, height: 100 });
  });

  it('rejects a region that starts outside the image, naming its size', async () => {
    const data = await pngOf(solid(3000, 2000));

    await expect(
      fitImage({ data, format: 'png' }, { x: 3000, y: 0, width: 10, height: 10 })
    ).rejects.toThrow('3000x2000');
  });

  it('falls back to JPEG when lossless output exceeds the byte budget', async () => {
    const data = await pngOf(noise(1700, 1700));

    const fitted = await fitImage({ data, format: 'png' });

    expect(fitted.format).toBe('jpeg');
    expect(fitted.bytes.length).toBeLessThanOrEqual(MAX_IMAGE_BYTES);
    expect(Math.max(fitted.width, fitted.height)).toBeLessThanOrEqual(MAX_EDGE_PX);
  });

  it('re-encodes an oversized file even when its dimensions already fit', async () => {
    const data = await pngOf(noise(1500, 1500));
    expect(data.length).toBeGreaterThan(MAX_IMAGE_BYTES);

    const fitted = await fitImage({ data, format: 'png' });

    expect(fitted.bytes.length).toBeLessThanOrEqual(MAX_IMAGE_BYTES);
    expect(fitted).toMatchObject({ width: 1500, height: 1500 });
  });

  it('flattens transparency onto white when it has to switch to JPEG', async () => {
    const left = noise(850, 1700).bitmap.data;
    const data = await pngOf(
      image(1700, 1700, (x, y) => {
        if (x >= 850) return [0, 0, 0, 0];
        const o = (y * 850 + x) * 4;
        return [left[o], left[o + 1], left[o + 2], 255];
      })
    );

    const fitted = await fitImage({ data, format: 'png' });

    expect(fitted.format).toBe('jpeg');
    const transparentArea = await pixelAt(fitted.bytes, fitted.width - 10, 10);
    transparentArea.forEach((channel) => expect(channel).toBeGreaterThan(245));
  });

  it('keeps transparency when the PNG fits', async () => {
    const data = await pngOf(quadrants(W, H, true));

    const fitted = await fitImage({ data, format: 'png' }, WHOLE);

    expect(fitted.format).toBe('png');
    const { bitmap } = await Jimp.fromBuffer(fitted.bytes);
    const alphaAt = (x: number, y: number) => bitmap.data[(y * bitmap.width + x) * 4 + 3];
    expect(alphaAt((3 * W) / 4, (3 * H) / 4)).toBe(0);
    expect(alphaAt(W / 4, H / 4)).toBe(255);
  });

  describe('decodes every supported format', () => {
    it.each([
      ['PNG', 'png', () => pngOf(quadrants(W, H))],
      ['JPEG', 'jpeg', () => jpegOf(quadrants(W, H))],
      ['GIF', 'gif', () => gifOf(quadrants(W, H))],
      ['lossy WebP', 'webp', () => webpOf(quadrants(W, H))],
      ['lossless WebP', 'webp', () => webpOf(quadrants(W, H), { lossless: true })],
      ['WebP with alpha', 'webp', () => webpOf(quadrants(W, H, true))],
    ] as const)('%s', async (_label, format, build) => {
      const data = await build();

      const fitted = await fitImage({ data, format }, WHOLE);

      expect(fitted).toMatchObject({ width: W, height: H });
      expect(fitted.original).toMatchObject({ width: W, height: H, format });
      const colors = await quadrantColors(fitted.bytes, W, H);
      [RED, GREEN, BLUE].forEach((expected, i) => expectColor(colors[i], expected));
    });
  });

  describe('applies EXIF orientation, so the image and its regions are upright', () => {
    const orientations: Orientation[] = [1, 2, 3, 4, 5, 6, 7, 8];
    const builders = {
      jpeg: async (o: Orientation) =>
        jpegWithOrientation(await jpegOf(storedFor(quadrants(W, H), o)), o),
      png: async (o: Orientation) =>
        pngWithOrientation(await pngOf(storedFor(quadrants(W, H), o)), o),
      webp: (o: Orientation) =>
        webpOf(storedFor(quadrants(W, H), o), { lossless: true, orientation: o }),
    } as const;

    describe.each(Object.keys(builders) as (keyof typeof builders)[])('%s', (format) => {
      it.each(orientations)('orientation %i', async (orientation) => {
        const data = await builders[format](orientation);

        const whole = await fitImage({ data, format }, WHOLE);
        expect(whole.original).toMatchObject({ width: W, height: H });
        expect(whole).toMatchObject({ width: W, height: H });
        expectQuadrants(await quadrantColors(whole.bytes, W, H));

        const bottomRight = await fitImage(
          { data, format },
          { x: W / 2, y: H / 2, width: W / 2, height: H / 2 }
        );
        expectColor(await pixelAt(bottomRight.bytes, W / 4, H / 4), WHITE);
      });
    });

    it('re-encodes a small rotated image instead of passing it through sideways', async () => {
      const data = jpegWithOrientation(await jpegOf(storedFor(quadrants(W, H), 6)), 6);

      const fitted = await fitImage({ data, format: 'jpeg' });

      expect(fitted.bytes.equals(data)).toBe(false);
      expect(fitted).toMatchObject({ width: W, height: H });
    });
  });

  it('rejects an image whose header declares too many pixels, before decoding it', async () => {
    const data = pngDeclaring(await pngOf(solid(10, 10)), 20000, 20000);

    await expect(fitImage({ data, format: 'png' })).rejects.toThrow('20000x20000');
  });

  it('rejects animated WebP when it has to be decoded', async () => {
    const data = await webpOf(quadrants(W, H), { animated: true });

    await expect(fitImage({ data, format: 'webp' }, WHOLE)).rejects.toThrow('animated WebP');
  });

  it.each([
    ['truncated PNG', 'png', async () => (await pngOf(noise(400, 400))).subarray(0, 2000)],
    ['truncated JPEG', 'jpeg', async () => (await jpegOf(noise(400, 400))).subarray(0, 2000)],
    ['truncated WebP', 'webp', async () => (await webpOf(noise(400, 400))).subarray(0, 200)],
    [
      'garbage after a PNG signature',
      'png',
      async () => Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(200, 7)]),
    ],
  ] as const)('reports a %s as an error', async (_label, format, build) => {
    const data = await build();

    await expect(fitImage({ data, format }, { x: 0, y: 0, width: 10, height: 10 })).rejects.toThrow(
      /Could not (decode|read)/
    );
  });
});
