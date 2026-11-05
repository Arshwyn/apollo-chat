import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { detectType, sanitizeImage, ImageError } from '../src/images.js';

async function jpegWithGps({ width = 64, height = 32 } = {}) {
  return sharp({ create: { width, height, channels: 3, background: '#808080' } })
    .withExif({
      IFD0: { Make: 'SENTINEL_CAMERA' },
      IFD3: {
        GPSLatitudeRef: 'N',
        GPSLatitude: '51/1 30/1 0/1',
        GPSLongitudeRef: 'W',
        GPSLongitude: '0/1 7/1 0/1',
      },
    })
    .jpeg()
    .toBuffer();
}

test('type is decided from magic bytes', async () => {
  assert.equal(detectType(await jpegWithGps()), 'jpeg');
  const png = await sharp({ create: { width: 8, height: 8, channels: 4, background: '#fff' } })
    .png()
    .toBuffer();
  assert.equal(detectType(png), 'png');
  const webp = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#fff' } })
    .webp()
    .toBuffer();
  assert.equal(detectType(webp), 'webp');
  assert.equal(detectType(Buffer.from('GIF89a......padding')), null);
  assert.equal(detectType(Buffer.from('<?xml version="1.0"?><svg/>')), null);
  assert.equal(detectType(Buffer.alloc(4)), null);
  const heic = Buffer.concat([Buffer.alloc(4), Buffer.from('ftypheic'), Buffer.alloc(8)]);
  assert.equal(detectType(heic), 'heic');
});

test('sanitising strips EXIF and GPS data', async () => {
  const src = await jpegWithGps();
  assert.ok(src.includes(Buffer.from('SENTINEL_CAMERA')), 'fixture carries EXIF');
  assert.ok((await sharp(src).metadata()).exif, 'fixture has an EXIF block');
  const { buffer, ext } = await sanitizeImage(src);
  assert.equal(ext, 'jpg');
  const meta = await sharp(buffer).metadata();
  assert.equal(meta.exif, undefined);
  assert.equal(meta.xmp, undefined);
  assert.equal(buffer.includes(Buffer.from('SENTINEL_CAMERA')), false);
  assert.equal(buffer.includes(Buffer.from('Exif')), false);
  assert.equal(buffer.includes(Buffer.from('GPS')), false);
});

test('orientation is applied before metadata is dropped', async () => {
  const tall = await sharp({ create: { width: 40, height: 20, channels: 3, background: '#123456' } })
    .withMetadata({ orientation: 6 })
    .jpeg()
    .toBuffer();
  const { buffer } = await sanitizeImage(tall);
  const meta = await sharp(buffer).metadata();
  assert.equal(meta.width, 20);
  assert.equal(meta.height, 40);
  assert.equal(meta.orientation, undefined);
});

test('long edge is capped at 2000 px, small images are not enlarged', async () => {
  const big = await sharp({ create: { width: 3000, height: 1000, channels: 3, background: '#fff' } })
    .jpeg()
    .toBuffer();
  const m = await sharp((await sanitizeImage(big)).buffer).metadata();
  assert.equal(m.width, 2000);
  assert.equal(m.height, 667);
  const small = await jpegWithGps({ width: 100, height: 50 });
  assert.equal((await sharp((await sanitizeImage(small)).buffer).metadata()).width, 100);
});

test('png stays png, webp becomes jpeg, junk and heic are rejected with 415', async () => {
  const png = await sharp({ create: { width: 8, height: 8, channels: 4, background: '#ffffff80' } })
    .png()
    .toBuffer();
  assert.equal((await sanitizeImage(png)).ext, 'png');
  const webp = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#fff' } })
    .webp()
    .toBuffer();
  assert.equal((await sanitizeImage(webp)).ext, 'jpg');
  await assert.rejects(
    sanitizeImage(Buffer.from('not an image at all, just text')),
    (e) => e instanceof ImageError && e.status === 415,
  );
  const truncated = (await jpegWithGps()).subarray(0, 40);
  await assert.rejects(sanitizeImage(truncated), (e) => e.status === 415);
  const heic = Buffer.concat([Buffer.alloc(4), Buffer.from('ftypheic'), Buffer.alloc(32)]);
  await assert.rejects(sanitizeImage(heic), (e) => e.status === 415 && /HEIC/.test(e.message));
});
