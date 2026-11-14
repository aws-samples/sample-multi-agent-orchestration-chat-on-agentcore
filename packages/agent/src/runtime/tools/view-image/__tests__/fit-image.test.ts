/**
 * Unit tests for fitImage: what reaches the model must fit the edge limit and
 * the byte budget, and `region` must address the image as the user sees it.
 */

import { describe, it, expect } from '@jest/globals';
import sharp from 'sharp';
import { fitImage, MAX_EDGE_PX, MAX_IMAGE_BYTES } from '../fit-image.js';

const flat = (width: number, height: number, background = '#336699') =>
  sharp({ create: { width, height, channels: 3, background } });

const noise = (width: number, height: number, channels: 3 | 4 = 3) =>
  sharp({
    create: { width, height, channels, noise: { type: 'gaussian', mean: 128, sigma: 60 } },
  });

async function pixelAt(image: Buffer, x: number, y: number): Promise<number[]> {
  const { data, info } = await sharp(image).raw().toBuffer({ resolveWithObject: true });
  const offset = (y * info.width + x) * info.channels;
  return [...data.subarray(offset, offset + 3)];
}

/** A 200x400 portrait as displayed (red on top, blue below), stored sideways with EXIF orientation 6. */
async function sidewaysPortrait(): Promise<Buffer> {
  const red = await flat(200, 200, '#ff0000').png().toBuffer();
  const blue = await flat(200, 200, '#0000ff').png().toBuffer();
  return flat(400, 200, '#000000')
    .composite([
      { input: red, left: 0, top: 0 },
      { input: blue, left: 200, top: 0 },
    ])
    .jpeg()
    .withMetadata({ orientation: 6 })
    .toBuffer();
}

describe('fitImage', () => {
  it('passes a small image through untouched', async () => {
    const data = await flat(800, 600).png().toBuffer();

    const fitted = await fitImage({ data, format: 'png' });

    expect(fitted.bytes).toBe(data);
    expect(fitted).toMatchObject({ format: 'png', width: 800, height: 600 });
    expect(fitted.region).toBeUndefined();
  });

  it('downscales to the edge limit, keeps the aspect ratio and reports the original', async () => {
    const data = await flat(3000, 2000).png().toBuffer();

    const fitted = await fitImage({ data, format: 'png' });

    expect(fitted).toMatchObject({ format: 'png', width: MAX_EDGE_PX, height: 1045 });
    expect(fitted.original).toEqual({
      width: 3000,
      height: 2000,
      format: 'png',
      bytes: data.length,
    });
    const decoded = await sharp(fitted.bytes).metadata();
    expect([decoded.width, decoded.height]).toEqual([MAX_EDGE_PX, 1045]);
  });

  it('crops the region from the original before scaling', async () => {
    const marker = await flat(100, 100, '#ff0000').png().toBuffer();
    const data = await flat(3000, 2000)
      .composite([{ input: marker, left: 2500, top: 1500 }])
      .png()
      .toBuffer();

    const fitted = await fitImage(
      { data, format: 'png' },
      { x: 2500, y: 1500, width: 100, height: 100 }
    );

    expect(fitted).toMatchObject({ width: 100, height: 100 });
    expect(fitted.region).toEqual({ x: 2500, y: 1500, width: 100, height: 100 });
    expect(await pixelAt(fitted.bytes, 50, 50)).toEqual([255, 0, 0]);
  });

  it('clamps a region that runs past the image edge', async () => {
    const data = await flat(3000, 2000).png().toBuffer();

    const fitted = await fitImage(
      { data, format: 'png' },
      { x: 2900.4, y: 1900, width: 500, height: 500 }
    );

    expect(fitted.region).toEqual({ x: 2900, y: 1900, width: 100, height: 100 });
    expect(fitted).toMatchObject({ width: 100, height: 100 });
  });

  it('rejects a region that starts outside the image, naming its size', async () => {
    const data = await flat(3000, 2000).png().toBuffer();

    await expect(
      fitImage({ data, format: 'png' }, { x: 3000, y: 0, width: 10, height: 10 })
    ).rejects.toThrow('3000x2000');
  });

  it('applies EXIF orientation so the image and its regions are upright', async () => {
    const data = await sidewaysPortrait();

    const whole = await fitImage({ data, format: 'jpeg' });
    expect(whole).toMatchObject({ width: 200, height: 400 });
    expect(whole.original).toMatchObject({ width: 200, height: 400 });
    const [topRed, , topBlue] = await pixelAt(whole.bytes, 100, 100);
    expect(topRed).toBeGreaterThan(200);
    expect(topBlue).toBeLessThan(50);

    const lowerHalf = await fitImage(
      { data, format: 'jpeg' },
      { x: 0, y: 200, width: 200, height: 200 }
    );
    const [red, , blue] = await pixelAt(lowerHalf.bytes, 100, 100);
    expect(blue).toBeGreaterThan(200);
    expect(red).toBeLessThan(50);
  });

  it('falls back to JPEG when lossless output exceeds the byte budget', async () => {
    const data = await noise(3000, 3000).png().toBuffer();

    const fitted = await fitImage({ data, format: 'png' });

    expect(fitted.format).toBe('jpeg');
    expect(fitted.bytes.length).toBeLessThanOrEqual(MAX_IMAGE_BYTES);
    expect(Math.max(fitted.width, fitted.height)).toBeLessThanOrEqual(MAX_EDGE_PX);
  });

  it('re-encodes an oversized file even when its dimensions already fit', async () => {
    const data = await noise(1500, 1500).png().toBuffer();
    expect(data.length).toBeGreaterThan(MAX_IMAGE_BYTES);

    const fitted = await fitImage({ data, format: 'png' });

    expect(fitted.bytes.length).toBeLessThanOrEqual(MAX_IMAGE_BYTES);
    expect(fitted).toMatchObject({ width: 1500, height: 1500 });
  });

  it('flattens transparency onto white when it has to switch to JPEG', async () => {
    const half = await noise(1200, 2400).png().toBuffer();
    const data = await sharp({
      create: { width: 2400, height: 2400, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .composite([{ input: half, left: 0, top: 0 }])
      .png()
      .toBuffer();

    const fitted = await fitImage({ data, format: 'png' });

    expect(fitted.format).toBe('jpeg');
    const transparentArea = await pixelAt(fitted.bytes, fitted.width - 10, 10);
    transparentArea.forEach((channel) => expect(channel).toBeGreaterThan(245));
  });
});
