/**
 * EXIF orientation for PNG (`eXIf` chunk) and WebP (`EXIF` chunk). JPEG is not
 * handled here: its orientation comes from the image header, and the JPEG
 * decoder applies it itself.
 */

/** EXIF orientation 1–8; 1 means stored upright. */
export type Orientation = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

const ORIENTATION_TAG = 0x0112;
const EXIF_PREFIX = Buffer.from('Exif\0\0', 'latin1');

/** Orientation from a raw TIFF/EXIF block, or 1 when it is missing or malformed. */
export function orientationFromTiff(block: Buffer): Orientation {
  // Some writers keep the JPEG APP1 prefix inside PNG/WebP chunks.
  const tiff = block.subarray(0, 6).equals(EXIF_PREFIX) ? block.subarray(6) : block;
  if (tiff.length < 8) return 1;
  const marker = tiff.toString('latin1', 0, 2);
  if (marker !== 'II' && marker !== 'MM') return 1;
  const le = marker === 'II';
  const u16 = (o: number) => (le ? tiff.readUInt16LE(o) : tiff.readUInt16BE(o));
  const u32 = (o: number) => (le ? tiff.readUInt32LE(o) : tiff.readUInt32BE(o));

  const ifd = u32(4);
  if (ifd + 2 > tiff.length) return 1;
  const count = u16(ifd);
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > tiff.length) return 1;
    if (u16(entry) === ORIENTATION_TAG) {
      const value = u16(entry + 8);
      return value >= 1 && value <= 8 ? (value as Orientation) : 1;
    }
  }
  return 1;
}

function pngExif(data: Buffer): Buffer | undefined {
  let offset = 8;
  while (offset + 8 <= data.length) {
    const length = data.readUInt32BE(offset);
    const type = data.toString('latin1', offset + 4, offset + 8);
    if (type === 'eXIf') return data.subarray(offset + 8, offset + 8 + length);
    if (type === 'IEND') return undefined;
    offset += 12 + length;
  }
  return undefined;
}

function webpChunks(data: Buffer): Map<string, Buffer> {
  const chunks = new Map<string, Buffer>();
  let offset = 12;
  while (offset + 8 <= data.length) {
    const type = data.toString('latin1', offset, offset + 4);
    const length = data.readUInt32LE(offset + 4);
    chunks.set(type, data.subarray(offset + 8, offset + 8 + length));
    offset += 8 + length + (length % 2);
  }
  return chunks;
}

export function readContainerOrientation(data: Buffer, format: 'png' | 'webp'): Orientation {
  const exif = format === 'png' ? pngExif(data) : webpChunks(data).get('EXIF');
  return exif ? orientationFromTiff(exif) : 1;
}

/** Animated WebP has no single bitmap to decode; the WebP decoder rejects it. */
export function isAnimatedWebp(data: Buffer): boolean {
  const vp8x = webpChunks(data).get('VP8X');
  return vp8x !== undefined && vp8x.length > 0 && (vp8x[0] & 0x02) !== 0;
}
