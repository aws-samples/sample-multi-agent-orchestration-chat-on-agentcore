/**
 * Prepare an image for delivery to the model: optional crop, downscale to the
 * edge limit, and re-encode until it fits the byte budget.
 *
 * Pure JS/WASM codecs (jimp, jsquash) rather than sharp: sharp's prebuilt
 * libvips binaries are LGPL-3.0, which this repository cannot ship. The codecs
 * are synchronous, so the tool runs this in a worker thread (fit-image-off-thread.ts).
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createJimp } from '@jimp/core';
import gif from '@jimp/js-gif';
import jpeg from '@jimp/js-jpeg';
import png from '@jimp/js-png';
import { methods as crop } from '@jimp/plugin-crop';
import { methods as flip } from '@jimp/plugin-flip';
import { methods as resize } from '@jimp/plugin-resize';
import { methods as rotate } from '@jimp/plugin-rotate';
import decodeWebp, { init as initWebpDecoder } from '@jsquash/webp/decode.js';
import { imageSize } from 'image-size';
import type { ImageFormat } from '../../../libs/utils/image-source.js';
import { isAnimatedWebp, readContainerOrientation, type Orientation } from './exif-orientation.js';

/**
 * Long-edge limit in pixels. Claude downscales larger images itself, so sending
 * more only costs request bytes and hides the real scale from the model.
 */
export const MAX_EDGE_PX = 1568;

/**
 * Byte budget per delivered image. Token cost depends on pixels, not bytes, but
 * every image is re-sent on each model call of the turn; without a cap a few
 * screenshots grow the request by tens of megabytes.
 */
export const MAX_IMAGE_BYTES = 1024 * 1024;

/**
 * Decoded pixel limit, checked from the header before decoding. The JS JPEG
 * decoder needs roughly 40 bytes per pixel, so a 48 MP photo peaks near 2 GB;
 * the limit also stops small files that declare huge dimensions.
 */
export const MAX_PIXELS = 25_000_000;

export interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FittedImage {
  bytes: Buffer;
  format: ImageFormat;
  width: number;
  height: number;
  original: { width: number; height: number; format: ImageFormat; bytes: number };
  /** The crop applied, clamped to the image bounds. Absent when the whole image was used. */
  region?: Region;
}

interface Encoding {
  edge: number;
  format: 'png' | 'jpeg';
  quality?: number;
}

const Jimp = createJimp({
  formats: [png, jpeg, gif],
  plugins: [crop, flip, resize, rotate],
});
type JimpImage = ReturnType<typeof Jimp.fromBitmap>;

let webpDecoderReady: Promise<void> | undefined;

// Passing the bytes as `wasmBinary` (not a compiled WebAssembly.Module) avoids
// jsquash's `instanceof WebAssembly.Module` check, which fails across VM realms
// (jest), and its default loader, which fetches the .wasm over HTTP.
function ensureWebpDecoder(): Promise<void> {
  webpDecoderReady ??= (async () => {
    const require = createRequire(import.meta.url);
    const wasmBinary = readFileSync(require.resolve('@jsquash/webp/codec/dec/webp_dec.wasm'));
    await initWebpDecoder({ wasmBinary } as never);
  })();
  return webpDecoderReady;
}

/**
 * Encodings tried in order until one fits the byte budget. PNG first keeps
 * screenshots and diagrams lossless; the later steps trade JPEG quality, then
 * resolution, for size.
 */
function encodingLadder(sourceFormat: ImageFormat): Encoding[] {
  const lossy: Encoding[] = [
    { edge: MAX_EDGE_PX, format: 'jpeg', quality: 85 },
    { edge: MAX_EDGE_PX, format: 'jpeg', quality: 60 },
    { edge: MAX_EDGE_PX, format: 'jpeg', quality: 40 },
    { edge: 1024, format: 'jpeg', quality: 60 },
    { edge: 768, format: 'jpeg', quality: 60 },
  ];
  // Re-encoding a JPEG as PNG only inflates it.
  return sourceFormat === 'jpeg' ? lossy : [{ edge: MAX_EDGE_PX, format: 'png' }, ...lossy];
}

function clampRegion(region: Region, width: number, height: number): Region {
  const x = Math.floor(region.x);
  const y = Math.floor(region.y);
  if (x >= width || y >= height) {
    throw new Error(
      `region starts at (${x}, ${y}), outside the ${width}x${height} image. ` +
        'Region coordinates are pixels of the original image.'
    );
  }
  return {
    x,
    y,
    width: Math.min(Math.ceil(region.width), width - x),
    height: Math.min(Math.ceil(region.height), height - y),
  };
}

interface Header {
  /** Dimensions as displayed, after EXIF orientation. */
  width: number;
  height: number;
  orientation: Orientation;
}

function readHeader(data: Buffer, format: ImageFormat): Header {
  let size: ReturnType<typeof imageSize>;
  try {
    size = imageSize(data);
  } catch {
    throw new Error(`Could not read the ${format} image header; the file may be corrupt.`);
  }
  const { width, height } = size;
  if (!width || !height) {
    throw new Error('Could not read the image dimensions');
  }
  if (width * height > MAX_PIXELS) {
    throw new Error(
      `Image is ${width}x${height} (${((width * height) / 1e6).toFixed(1)} MP), ` +
        `over the ${MAX_PIXELS / 1e6} MP limit. Downscale it first, for example with the code interpreter.`
    );
  }
  const orientation =
    format === 'jpeg'
      ? ((size.orientation ?? 1) as Orientation)
      : format === 'png' || format === 'webp'
        ? readContainerOrientation(data, format)
        : 1;
  const swap = orientation >= 5;
  return { width: swap ? height : width, height: swap ? width : height, orientation };
}

/** Rotate/flip a bitmap stored with `orientation` so it is upright. */
function applyOrientation(image: JimpImage, orientation: Orientation): void {
  // jimp rotates counter-clockwise for positive degrees.
  const mirror = () => image.flip({ horizontal: true, vertical: false });
  switch (orientation) {
    case 2:
      mirror();
      break;
    case 3:
      image.rotate(180);
      break;
    case 4:
      image.flip({ horizontal: false, vertical: true });
      break;
    case 5:
      image.rotate(-90);
      mirror();
      break;
    case 6:
      image.rotate(-90);
      break;
    case 7:
      image.rotate(90);
      mirror();
      break;
    case 8:
      image.rotate(90);
      break;
  }
}

async function decode(
  data: Buffer,
  format: ImageFormat,
  orientation: Orientation
): Promise<JimpImage> {
  try {
    if (format === 'webp') {
      if (isAnimatedWebp(data)) {
        throw new Error('animated WebP is not supported; extract a frame as PNG first');
      }
      await ensureWebpDecoder();
      const { data: pixels, width, height } = await decodeWebp(data);
      const image = Jimp.fromBitmap({
        data: Buffer.from(pixels.buffer, pixels.byteOffset, pixels.byteLength),
        width,
        height,
      });
      applyOrientation(image, orientation);
      return image;
    }
    // The JPEG decoder applies EXIF orientation itself.
    const image = await Jimp.fromBuffer(data, {
      'image/jpeg': { maxMemoryUsageInMB: 2048, maxResolutionInMP: MAX_PIXELS / 1e6 },
    });
    if (format === 'png') applyOrientation(image, orientation);
    return image;
  } catch (error) {
    const message = (error as { message?: unknown } | null)?.message;
    throw new Error(
      `Could not decode the ${format} image: ${typeof message === 'string' ? message : 'unknown error'}`,
      { cause: error }
    );
  }
}

function isOpaque(rgba: Buffer): boolean {
  for (let i = 3; i < rgba.length; i += 4) {
    if (rgba[i] !== 255) return false;
  }
  return true;
}

/** JPEG has no alpha channel; composite onto white rather than letting transparent pixels go black. */
function flattenOntoWhite(rgba: Buffer): void {
  for (let i = 0; i < rgba.length; i += 4) {
    const alpha = rgba[i + 3];
    if (alpha === 255) continue;
    for (let c = i; c < i + 3; c++) {
      rgba[c] = Math.round((rgba[c] * alpha + 255 * (255 - alpha)) / 255);
    }
    rgba[i + 3] = 255;
  }
}

export async function fitImage(
  source: { data: Buffer; format: ImageFormat },
  region?: Region
): Promise<FittedImage> {
  const { width, height, orientation } = readHeader(source.data, source.format);
  const original = { width, height, format: source.format, bytes: source.data.length };

  if (
    !region &&
    orientation === 1 &&
    Math.max(width, height) <= MAX_EDGE_PX &&
    source.data.length <= MAX_IMAGE_BYTES
  ) {
    return { bytes: source.data, format: source.format, width, height, original };
  }

  const cropRegion = region ? clampRegion(region, width, height) : undefined;
  const image = await decode(source.data, source.format, orientation);
  if (cropRegion) {
    image.crop({ x: cropRegion.x, y: cropRegion.y, w: cropRegion.width, h: cropRegion.height });
  }
  const opaque = isOpaque(image.bitmap.data);

  for (const encoding of encodingLadder(source.format)) {
    const step = image.clone();
    if (Math.max(step.bitmap.width, step.bitmap.height) > encoding.edge) {
      // jimp's default strategy averages source pixels when shrinking; the
      // interpolating strategies (bilinear, bicubic, …) alias small text badly.
      step.scaleToFit({ w: encoding.edge, h: encoding.edge });
    }
    let data: Buffer;
    if (encoding.format === 'png') {
      // colorType 2 = RGB: dropping an all-opaque alpha channel cuts the PNG by ~10%.
      data = await step.getBuffer('image/png', opaque ? { colorType: 2 } : {});
    } else {
      flattenOntoWhite(step.bitmap.data);
      data = await step.getBuffer('image/jpeg', { quality: encoding.quality });
    }
    if (data.length <= MAX_IMAGE_BYTES) {
      return {
        bytes: data,
        format: encoding.format,
        width: step.bitmap.width,
        height: step.bitmap.height,
        original,
        ...(cropRegion ? { region: cropRegion } : {}),
      };
    }
  }

  throw new Error(
    `Could not reduce the image below ${MAX_IMAGE_BYTES} bytes. Crop a smaller region and try again.`
  );
}
