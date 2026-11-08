import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { decodeHeic, activeDecoders } from '../src/heic.js';

const fixture = (name) => fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
const px = ({ width, data }, x, y) => [...data.subarray((y * width + x) * 4, (y * width + x) * 4 + 4)];

// Corner colours of the plain fixture: top-left, top-right, bottom-left, bottom-right.
const TL = [5, 151, 132, 255];
const TR = [5, 0, 250, 255];
const BL = [21, 232, 42, 255];
const BR = [253, 0, 0, 255];

test('a valid HEIC decodes to raw RGBA', async () => {
  const img = await decodeHeic(fixture('heic-plain.heic'));
  assert.equal(img.width, 64);
  assert.equal(img.height, 64);
  assert.equal(img.data.length, 64 * 64 * 4);
  assert.deepEqual([px(img, 0, 0), px(img, 63, 0), px(img, 0, 63), px(img, 63, 63)], [TL, TR, BL, BR]);
  assert.equal(activeDecoders(), 0);
});

test('the container rotation is applied by the decoder', async () => {
  const img = await decodeHeic(fixture('heic-rotated.heic'));
  assert.deepEqual([px(img, 0, 0), px(img, 63, 0), px(img, 0, 63), px(img, 63, 63)], [TR, BR, TL, BL]);
});

test('truncated, corrupt and empty HEIC files are 415', async () => {
  const good = fixture('heic-plain.heic');
  const flipped = Buffer.from(good);
  for (let i = 340; i < flipped.length; i++) flipped[i] ^= 0xff;
  const header = Buffer.concat([Buffer.alloc(4), Buffer.from('ftypheic'), Buffer.alloc(40, 7)]);
  for (const bad of [
    good.subarray(0, 200),
    good.subarray(0, good.length - 60),
    flipped,
    header,
    Buffer.alloc(0),
  ]) {
    await assert.rejects(
      decodeHeic(bad),
      (e) => e.status === 415 && e.message === 'could not read the image',
    );
  }
  assert.equal(activeDecoders(), 0);
});

test('an image over the pixel cap is 413, also when the header claims a huge size', async () => {
  const good = fixture('heic-plain.heic');
  await assert.rejects(
    decodeHeic(good, { maxPixels: 100 }),
    (e) => e.status === 413 && e.message === 'image too large',
  );
  const huge = Buffer.from(good);
  const ispe = huge.indexOf('ispe');
  huge.writeUInt32BE(30000, ispe + 8);
  huge.writeUInt32BE(30000, ispe + 12);
  const before = process.memoryUsage().arrayBuffers;
  await assert.rejects(decodeHeic(huge), (e) => e.status === 413);
  assert.ok(process.memoryUsage().arrayBuffers - before < 100_000_000, 'no full-size buffer was allocated');
  assert.equal(activeDecoders(), 0);
});

test('a decode that runs out of time is 415 and its worker is gone', async () => {
  await assert.rejects(
    decodeHeic(fixture('heic-plain.heic'), { timeoutMs: 1 }),
    (e) => e.status === 415 && e.message === 'could not read the image',
  );
  assert.equal(activeDecoders(), 0);
  const img = await decodeHeic(fixture('heic-plain.heic'));
  assert.equal(img.width, 64, 'the next decode still works');
});

test('decodes run one at a time', async () => {
  const good = fixture('heic-plain.heic');
  let max = 0;
  const watch = setInterval(() => (max = Math.max(max, activeDecoders())), 1);
  const all = await Promise.all([1, 2, 3, 4].map(() => decodeHeic(good)));
  clearInterval(watch);
  assert.equal(all.length, 4);
  assert.ok(max <= 1);
});
