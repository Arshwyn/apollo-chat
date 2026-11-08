import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { startApp } from './api-helpers.js';
import crypto from 'node:crypto';
import { photoRoutes, claimPhotos, MAX_MESSAGE_PHOTO_BYTES } from '../src/photos.js';

const jpeg = (w = 64) =>
  sharp({ create: { width: w, height: 32, channels: 3, background: '#777' } })
    .jpeg()
    .toBuffer();
const withPhotos = () => startApp({ build: ({ config }) => ({ routes: photoRoutes({ config }) }) });
const files = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }) : []);

test('upload stages a sanitised photo under the caller only', async () => {
  const t = await withPhotos();
  try {
    const r = await t.call('alice', 'POST', '/api/photos', await jpeg(), { 'content-type': 'image/jpeg' });
    assert.equal(r.status, 200);
    assert.match(r.json.photoId, /^[0-9a-f]{32}$/);
    const a = path.join(t.dataDir, 'users', 'alice', 'tmp');
    const staged = files(a).filter((f) => f.endsWith('.jpg'));
    assert.equal(staged.length, 1);
    assert.ok(staged[0].startsWith(`stg-${r.json.photoId}`));
    assert.equal(files(path.join(t.dataDir, 'users', 'bob')).length, 0);
    assert.equal((await t.call(null, 'POST', '/api/photos', await jpeg())).status, 401);
  } finally {
    await t.close();
  }
});

test('type is checked by bytes, not by declared type or name; oversize is 413', async () => {
  const t = await withPhotos();
  try {
    const txt = await t.call(
      'alice',
      'POST',
      '/api/photos?name=x.jpg',
      Buffer.from('plain text pretending'),
      {
        'content-type': 'image/jpeg',
      },
    );
    assert.equal(txt.status, 415);
    const big = await t.call('alice', 'POST', '/api/photos', Buffer.alloc(10 * 1024 * 1024 + 1, 1), {
      'content-type': 'image/jpeg',
    });
    assert.equal(big.status, 413);
    assert.equal(files(path.join(t.dataDir, 'users', 'alice', 'tmp')).length, 0);
  } finally {
    await t.close();
  }
});

test('at most 8 unsent photos are staged per user', async () => {
  const t = await withPhotos();
  try {
    for (let i = 0; i < 8; i++)
      assert.equal((await t.call('alice', 'POST', '/api/photos', await jpeg(10 + i))).status, 200);
    const ninth = await t.call('alice', 'POST', '/api/photos', await jpeg());
    assert.equal(ninth.status, 429);
    assert.match(ninth.json.error, /too many unsent photos/);
    assert.equal((await t.call('bob', 'POST', '/api/photos', await jpeg())).status, 200);
  } finally {
    await t.close();
  }
});

test('claiming moves photos into the run dir and rejects foreign, bad or too many ids', async () => {
  const t = await withPhotos();
  try {
    const ids = [];
    for (let i = 0; i < 9; i++)
      ids.push((await t.call('alice', 'POST', '/api/photos', await jpeg(10 + i))).json.photoId);
    const bob = (await t.call('bob', 'POST', '/api/photos', await jpeg())).json.photoId;
    const claim = (user, photoIds, runId = 'run-12345678', maxPhotos) =>
      claimPhotos({ dataDir: t.dataDir, user, runId, photoIds, maxPhotos });
    assert.throws(() => claim('alice', ids), /at most 8 photos per message/);
    assert.throws(
      () => claim('alice', [bob]),
      (e) => e.status === 400,
    );
    assert.throws(
      () => claim('alice', ['../../etc/passwd']),
      (e) => e.status === 400,
    );
    assert.throws(
      () => claim('alice', [ids[0], ids[0]]),
      (e) => e.status === 400,
    );
    assert.throws(() => claim('alice', ids.slice(0, 1), '../escape'), /invalid run id/);
    assert.throws(() => claim('alice', ids.slice(0, 3), 'run-00000009', 2), /at most 2 photos per message/);
    const paths = claim('alice', ids.slice(0, 2));
    assert.equal(paths.length, 2);
    for (const p of paths) {
      assert.ok(p.startsWith(path.join(t.dataDir, 'users', 'alice', 'tmp', 'run-12345678') + path.sep));
      assert.ok(fs.existsSync(p));
    }
    assert.throws(
      () => claim('alice', ids.slice(0, 1), 'run-87654321'),
      (e) => e.status === 400,
      'already claimed',
    );
    assert.equal(fs.existsSync(path.join(t.dataDir, 'users', 'bob', 'tmp', 'run-12345678')), false);
  } finally {
    await t.close();
  }
});

test('an unsent photo can be removed by its owner only', async () => {
  const t = await withPhotos();
  try {
    const id = (await t.call('alice', 'POST', '/api/photos', await jpeg())).json.photoId;
    assert.equal((await t.call('bob', 'DELETE', `/api/photos/${id}`)).status, 400);
    assert.equal((await t.call('alice', 'DELETE', `/api/photos/${id}`)).status, 200);
    assert.equal((await t.call('alice', 'DELETE', `/api/photos/${id}`)).status, 400);
    assert.equal(files(path.join(t.dataDir, 'users', 'alice', 'tmp')).length, 0);
  } finally {
    await t.close();
  }
});

test('removing a photo leaves other users and other photos alone, and odd ids are rejected', async () => {
  const t = await withPhotos();
  try {
    const a1 = (await t.call('alice', 'POST', '/api/photos', await jpeg())).json.photoId;
    const a2 = (await t.call('alice', 'POST', '/api/photos', await jpeg(80))).json.photoId;
    const b1 = (await t.call('bob', 'POST', '/api/photos', await jpeg())).json.photoId;
    const aliceTmp = path.join(t.dataDir, 'users', 'alice', 'tmp');
    assert.equal((await t.call('bob', 'DELETE', `/api/photos/${a1}`)).status, 400);
    assert.equal(files(aliceTmp).filter((f) => f.endsWith('.jpg')).length, 2, 'owner files untouched');
    for (const bad of ['..%2f', '%2e%2e%2f', 'a'.repeat(31), 'A'.repeat(32), `${a1}%2f..`, `..%2f${b1}`]) {
      assert.equal((await t.call('alice', 'DELETE', `/api/photos/${bad}`)).status, 400, bad);
    }
    assert.equal((await t.call('alice', 'DELETE', `/api/photos/${a1}`)).status, 200);
    assert.deepEqual(
      files(aliceTmp).filter((f) => f.endsWith('.jpg')),
      [`stg-${a2}/${a2}.jpg`],
    );
    assert.equal(
      files(path.join(t.dataDir, 'users', 'bob', 'tmp')).filter((f) => f.endsWith('.jpg')).length,
      1,
    );
  } finally {
    await t.close();
  }
});

test('a staged directory that is a symlink out of the user tree is never followed', async () => {
  const t = await withPhotos();
  try {
    const outside = path.join(t.dataDir, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'keep.jpg'), 'x');
    const id = 'd'.repeat(32);
    const tmp = path.join(t.dataDir, 'users', 'alice', 'tmp');
    fs.mkdirSync(tmp, { recursive: true });
    fs.symlinkSync(outside, path.join(tmp, `stg-${id}`));
    assert.equal((await t.call('alice', 'DELETE', `/api/photos/${id}`)).status, 400);
    assert.equal(fs.existsSync(path.join(outside, 'keep.jpg')), true, 'the target is untouched');
    assert.throws(() =>
      claimPhotos({ dataDir: t.dataDir, user: 'alice', runId: 'run-symlink01', photoIds: [id] }),
    );
    assert.equal(fs.existsSync(path.join(outside, 'keep.jpg')), true, 'claiming does not move it either');
  } finally {
    await t.close();
  }
});

test('the configured limit drives the staging cap and the claim check', async () => {
  const t = await startApp({
    configExtra: { maxPhotosPerMessage: 2 },
    build: ({ config }) => ({ routes: photoRoutes({ config }) }),
  });
  try {
    const ids = [];
    for (let i = 0; i < 2; i++) {
      const r = await t.call('alice', 'POST', '/api/photos', await jpeg(10 + i));
      assert.equal(r.status, 200);
      ids.push(r.json.photoId);
    }
    assert.equal((await t.call('alice', 'POST', '/api/photos', await jpeg())).status, 429);
    assert.throws(
      () =>
        claimPhotos({
          dataDir: t.dataDir,
          user: 'alice',
          runId: 'run-limit001',
          photoIds: [...ids, ids[0]],
          maxPhotos: t.config.maxPhotosPerMessage,
        }),
      /at most 2 photos per message/,
    );
  } finally {
    await t.close();
  }
});

test('8 photos at the largest sanitised size fit under the combined cap, and more than the cap is 413', async () => {
  const t = await withPhotos();
  try {
    const big = await sharp({ create: { width: 2000, height: 1500, channels: 3, background: '#000' } })
      .composite([
        { input: crypto.randomBytes(2000 * 1500 * 3), raw: { width: 2000, height: 1500, channels: 3 } },
      ])
      .jpeg({ quality: 95 })
      .toBuffer();
    const ids = [];
    for (let i = 0; i < 8; i++) {
      const r = await t.call('alice', 'POST', '/api/photos', big);
      assert.equal(r.status, 200);
      ids.push(r.json.photoId);
    }
    const sizes = files(path.join(t.dataDir, 'users', 'alice', 'tmp'))
      .filter((f) => f.endsWith('.jpg'))
      .map((f) => fs.statSync(path.join(t.dataDir, 'users', 'alice', 'tmp', f)).size);
    assert.equal(sizes.length, 8);
    assert.ok(sizes.reduce((a, b) => a + b, 0) <= MAX_MESSAGE_PHOTO_BYTES, 'eight noisy 2000 px photos fit');
    assert.equal(
      claimPhotos({ dataDir: t.dataDir, user: 'alice', runId: 'run-eight001', photoIds: ids }).length,
      8,
    );
  } finally {
    await t.close();
  }
});

test('combined size over the cap is 413', async () => {
  const t = await withPhotos();
  try {
    const id = (await t.call('alice', 'POST', '/api/photos', await jpeg())).json.photoId;
    const dir = path.join(t.dataDir, 'users', 'alice', 'tmp', `stg-${id}`);
    fs.truncateSync(path.join(dir, `${id}.jpg`), MAX_MESSAGE_PHOTO_BYTES + 1);
    assert.throws(
      () => claimPhotos({ dataDir: t.dataDir, user: 'alice', runId: 'run-cap00001', photoIds: [id] }),
      (e) => e.status === 413,
    );
  } finally {
    await t.close();
  }
});
