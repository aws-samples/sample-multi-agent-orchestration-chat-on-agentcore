/**
 * Image builders for the view_image tests. Everything is generated in-process
 * with the same codecs the tool uses, so no binary fixtures are checked in.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { crc32 } from 'node:zlib';
import { createJimp } from '@jimp/core';
import gif from '@jimp/js-gif';
import jpeg from '@jimp/js-jpeg';
import png from '@jimp/js-png';
import { methods as crop } from '@jimp/plugin-crop';
import { methods as flip } from '@jimp/plugin-flip';
import { methods as rotate } from '@jimp/plugin-rotate';
import encodeWebp, { init as initWebpEncoder } from '@jsquash/webp/encode.js';
import type { Orientation } from '../exif-orientation.js';

export const Jimp = createJimp({ formats: [png, jpeg, gif], plugins: [crop, flip, rotate] });
export type JimpImage = ReturnType<typeof Jimp.fromBitmap>;

export type RGB = [number, number, number];
export const RED: RGB = [255, 0, 0];
export const GREEN: RGB = [0, 255, 0];
export const BLUE: RGB = [0, 0, 255];
export const WHITE: RGB = [255, 255, 255];

/** One RGBA pixel per call: `paint(x, y) -> [r, g, b, a]`. */
export function image(
  width: number,
  height: number,
  paint: (x: number, y: number) => [number, number, number, number]
): JimpImage {
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      data.set(paint(x, y), (y * width + x) * 4);
    }
  }
  return Jimp.fromBitmap({ data, width, height });
}

export const solid = (width: number, height: number, [r, g, b]: RGB = [0x33, 0x66, 0x99]) =>
  image(width, height, () => [r, g, b, 255]);

/** Incompressible content, so the PNG step of the encoding ladder overflows the budget. */
export function noise(width: number, height: number): JimpImage {
  let seed = 1;
  const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) & 0xff;
  return image(width, height, () => [next(), next(), next(), 255]);
}

/** Red top-left, green top-right, blue bottom-left, white (or transparent) bottom-right. */
export function quadrants(width = 600, height = 400, transparentCorner = false): JimpImage {
  return image(width, height, (x, y) => {
    const right = x >= width / 2;
    const bottom = y >= height / 2;
    if (!bottom) return right ? [...GREEN, 255] : [...RED, 255];
    if (!right) return [...BLUE, 255];
    return transparentCorner ? [0, 0, 0, 0] : [...WHITE, 255];
  });
}

// Unfiltered rows: pngjs's adaptive filter selection runs ~100x slower inside jest's VM.
export const pngOf = (img: JimpImage) => img.getBuffer('image/png', { filterType: 0 });
export const jpegOf = (img: JimpImage, quality = 92) => img.getBuffer('image/jpeg', { quality });
export const gifOf = (img: JimpImage) => img.getBuffer('image/gif');

/**
 * Store `img` the way a camera would for `orientation`: the inverse transform
 * of the one a viewer applies, so honouring the tag restores `img`.
 */
export function storedFor(img: JimpImage, orientation: Orientation): JimpImage {
  const stored = img.clone();
  const mirror = () => stored.flip({ horizontal: true, vertical: false });
  switch (orientation) {
    case 2:
      mirror();
      break;
    case 3:
      stored.rotate(180);
      break;
    case 4:
      stored.flip({ horizontal: false, vertical: true });
      break;
    case 5:
      mirror();
      stored.rotate(90);
      break;
    case 6:
      stored.rotate(90);
      break;
    case 7:
      mirror();
      stored.rotate(-90);
      break;
    case 8:
      stored.rotate(-90);
      break;
  }
  return stored;
}

/** A minimal TIFF block holding only the orientation tag. */
export function tiffWithOrientation(orientation: number, byteOrder: 'II' | 'MM' = 'II'): Buffer {
  const tiff = Buffer.alloc(26);
  const le = byteOrder === 'II';
  const u16 = (v: number, o: number) => (le ? tiff.writeUInt16LE(v, o) : tiff.writeUInt16BE(v, o));
  const u32 = (v: number, o: number) => (le ? tiff.writeUInt32LE(v, o) : tiff.writeUInt32BE(v, o));
  tiff.write(byteOrder, 0, 'latin1');
  u16(42, 2);
  u32(8, 4); // IFD0 offset
  u16(1, 8); // one entry
  u16(0x0112, 10); // Orientation
  u16(3, 12); // SHORT
  u32(1, 14); // count
  u16(orientation, 18);
  u32(0, 22); // no next IFD
  return tiff;
}

export function jpegWithOrientation(data: Buffer, orientation: number): Buffer {
  const payload = Buffer.concat([
    Buffer.from('Exif\0\0', 'latin1'),
    tiffWithOrientation(orientation),
  ]);
  const app1 = Buffer.alloc(4);
  app1.writeUInt16BE(0xffe1, 0);
  app1.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([data.subarray(0, 2), app1, payload, data.subarray(2)]);
}

function pngChunk(type: string, body: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
  return Buffer.concat([head, body, crc]);
}

/** Insert an `eXIf` chunk right after IHDR. */
export function pngWithOrientation(data: Buffer, orientation: number): Buffer {
  const afterIhdr = 8 + 12 + data.readUInt32BE(8);
  return Buffer.concat([
    data.subarray(0, afterIhdr),
    pngChunk('eXIf', tiffWithOrientation(orientation)),
    data.subarray(afterIhdr),
  ]);
}

/** Rewrite the IHDR dimensions without touching the pixel data. */
export function pngDeclaring(data: Buffer, width: number, height: number): Buffer {
  const out = Buffer.from(data);
  out.writeUInt32BE(width, 16);
  out.writeUInt32BE(height, 20);
  return out;
}

let webpEncoderReady: Promise<unknown> | undefined;

export async function webpOf(
  img: JimpImage,
  options: { lossless?: boolean; orientation?: number; animated?: boolean } = {}
): Promise<Buffer> {
  // Node 22 always has WASM SIMD, so jsquash picks the SIMD build of the encoder.
  webpEncoderReady ??= initWebpEncoder({
    wasmBinary: readFileSync(
      createRequire(import.meta.url).resolve('@jsquash/webp/codec/enc/webp_enc_simd.wasm')
    ),
  } as never);
  await webpEncoderReady;
  const { data, width, height } = img.bitmap;
  const encoded = Buffer.from(
    await encodeWebp(
      {
        data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength),
        width,
        height,
      } as ImageData,
      options.lossless ? { lossless: 1 } : { quality: 90 }
    )
  );
  if (!options.orientation && !options.animated) return encoded;

  // Rebuild as an extended (VP8X) container so it can carry EXIF / the animation flag.
  const chunks: Buffer[] = [];
  let flags = 0;
  for (let offset = 12; offset + 8 <= encoded.length;) {
    const type = encoded.toString('latin1', offset, offset + 4);
    const length = encoded.readUInt32LE(offset + 4);
    const end = offset + 8 + length + (length % 2);
    if (type === 'VP8X') flags |= encoded[offset + 8];
    else chunks.push(encoded.subarray(offset, end));
    offset = end;
  }
  if (options.orientation) {
    const exif = tiffWithOrientation(options.orientation);
    const head = Buffer.alloc(8);
    head.write('EXIF', 0, 'latin1');
    head.writeUInt32LE(exif.length, 4);
    chunks.push(head, exif);
    flags |= 0x08;
  }
  if (options.animated) flags |= 0x02;
  const vp8x = Buffer.alloc(18);
  vp8x.write('VP8X', 0, 'latin1');
  vp8x.writeUInt32LE(10, 4);
  vp8x[8] = flags;
  vp8x.writeUIntLE(width - 1, 12, 3);
  vp8x.writeUIntLE(height - 1, 15, 3);
  const body = Buffer.concat([Buffer.from('WEBP', 'latin1'), vp8x, ...chunks]);
  const riff = Buffer.alloc(8);
  riff.write('RIFF', 0, 'latin1');
  riff.writeUInt32LE(body.length, 4);
  return Buffer.concat([riff, body]);
}

/** Decode a PNG or JPEG and read one pixel, ignoring alpha. */
export async function pixelAt(data: Buffer, x: number, y: number): Promise<RGB> {
  const { bitmap } = await Jimp.fromBuffer(data);
  const offset = (y * bitmap.width + x) * 4;
  return [bitmap.data[offset], bitmap.data[offset + 1], bitmap.data[offset + 2]];
}

export async function dimensionsOf(data: Buffer): Promise<[number, number]> {
  const { bitmap } = await Jimp.fromBuffer(data);
  return [bitmap.width, bitmap.height];
}

/** Within `tolerance` per channel; JPEG never reproduces a colour exactly. */
export function expectColor(actual: RGB, expected: RGB, tolerance = 40): void {
  actual.forEach((channel, i) => {
    if (Math.abs(channel - expected[i]) > tolerance) {
      throw new Error(`expected ~rgb(${expected.join(',')}), got rgb(${actual.join(',')})`);
    }
  });
}
