/**
 * Prepare an image for delivery to the model: optional crop, downscale to the
 * edge limit, and re-encode until it fits the byte budget.
 */

import sharp from 'sharp';
import type { ImageFormat } from '../../../libs/utils/image-source.js';

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

export async function fitImage(
  source: { data: Buffer; format: ImageFormat },
  region?: Region
): Promise<FittedImage> {
  const metadata = await sharp(source.data).metadata();
  // EXIF orientation swaps the stored width/height; `autoOrient` holds the
  // dimensions as displayed, which is what region coordinates refer to.
  const width = metadata.autoOrient?.width ?? metadata.width;
  const height = metadata.autoOrient?.height ?? metadata.height;
  if (!width || !height) {
    throw new Error('Could not read the image dimensions');
  }
  const original = { width, height, format: source.format, bytes: source.data.length };
  const upright = (metadata.orientation ?? 1) === 1;

  if (
    !region &&
    upright &&
    Math.max(width, height) <= MAX_EDGE_PX &&
    source.data.length <= MAX_IMAGE_BYTES
  ) {
    return { bytes: source.data, format: source.format, width, height, original };
  }

  const crop = region ? clampRegion(region, width, height) : undefined;

  for (const encoding of encodingLadder(source.format)) {
    let pipeline = sharp(source.data).autoOrient();
    if (crop) {
      pipeline = pipeline.extract({
        left: crop.x,
        top: crop.y,
        width: crop.width,
        height: crop.height,
      });
    }
    pipeline = pipeline.resize({
      width: encoding.edge,
      height: encoding.edge,
      fit: 'inside',
      withoutEnlargement: true,
    });
    pipeline =
      encoding.format === 'png'
        ? pipeline.png()
        : // JPEG has no alpha channel; flatten onto white rather than sharp's default black.
          pipeline.flatten({ background: '#ffffff' }).jpeg({ quality: encoding.quality });

    const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });
    if (data.length <= MAX_IMAGE_BYTES) {
      return {
        bytes: data,
        format: encoding.format,
        width: info.width,
        height: info.height,
        original,
        ...(crop ? { region: crop } : {}),
      };
    }
  }

  throw new Error(
    `Could not reduce the image below ${MAX_IMAGE_BYTES} bytes. Crop a smaller region and try again.`
  );
}
