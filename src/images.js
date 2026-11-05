import sharp from 'sharp';

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_LONG_EDGE = 2000;

// The type is decided from the leading bytes, never from a filename or declared content type.
export function detectType(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP')
    return 'webp';
  if (buf.subarray(4, 8).toString('latin1') === 'ftyp') {
    const brand = buf.subarray(8, 12).toString('latin1');
    if (['heic', 'heix', 'hevc', 'mif1', 'msf1', 'heim', 'heis'].includes(brand)) return 'heic';
  }
  return null;
}

export class ImageError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Auto-orient, cap the long edge, and re-encode. sharp drops all metadata (EXIF, GPS, ICC, XMP)
// unless asked to keep it, and this never asks.
export async function sanitizeImage(buf) {
  const type = detectType(buf);
  if (!type) throw new ImageError(415, 'unsupported image type');
  if (type === 'heic')
    throw new ImageError(415, 'HEIC photos are not supported; share as JPEG or take a screenshot');
  try {
    let img = sharp(buf, { limitInputPixels: 100_000_000, failOn: 'error' })
      .rotate()
      .resize({ width: MAX_LONG_EDGE, height: MAX_LONG_EDGE, fit: 'inside', withoutEnlargement: true });
    if (type === 'png') {
      img = img.png();
      return { buffer: await img.toBuffer(), ext: 'png' };
    }
    return { buffer: await img.jpeg({ quality: 85 }).toBuffer(), ext: 'jpg' };
  } catch {
    throw new ImageError(415, 'could not read the image');
  }
}
