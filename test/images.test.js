import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
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

test('png stays png, webp becomes jpeg, junk is rejected with 415', async () => {
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
  await assert.rejects(
    sanitizeImage(Buffer.from('plain text that is long enough')),
    (e) => e.status === 415 && e.message === 'unsupported image type',
  );
});

const heicFixture = (name) => fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url));

test('HEIC becomes a JPEG without metadata, at the same size caps', async () => {
  const { buffer, ext } = await sanitizeImage(heicFixture('heic-plain.heic'));
  assert.equal(ext, 'jpg');
  assert.equal(buffer.subarray(0, 3).toString('hex'), 'ffd8ff');
  const meta = await sharp(buffer).metadata();
  assert.equal(meta.format, 'jpeg');
  assert.equal(meta.exif, undefined);
  assert.equal(meta.xmp, undefined);
  assert.equal(meta.icc, undefined);
  assert.equal(meta.width, 64);
  assert.ok(Math.max(meta.width, meta.height) <= 2000);
});

test('HEIC orientation follows the container rotation', async () => {
  const corner = async (name, x, y) => {
    const { data } = await sharp((await sanitizeImage(heicFixture(name))).buffer)
      .raw()
      .toBuffer({ resolveWithObject: true });
    return [data[(y * 64 + x) * 3], data[(y * 64 + x) * 3 + 1], data[(y * 64 + x) * 3 + 2]];
  };
  const near = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 40);
  assert.ok(near(await corner('heic-plain.heic', 63, 0), [5, 0, 250]), 'plain: top-right is blue');
  assert.ok(near(await corner('heic-rotated.heic', 0, 0), [5, 0, 250]), 'rotated: blue moved to top-left');
});

test('bad, huge and slow HEIC files keep their error statuses', async () => {
  const good = heicFixture('heic-plain.heic');
  await assert.rejects(
    sanitizeImage(good.subarray(0, 250)),
    (e) => e instanceof ImageError && e.status === 415 && e.message === 'could not read the image',
  );
  await assert.rejects(sanitizeImage(good, { heic: { maxPixels: 10 } }), (e) => e.status === 413);
  await assert.rejects(sanitizeImage(good, { heic: { timeoutMs: 1 } }), (e) => e.status === 415);
});
