import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { startApp } from './api-helpers.js';
import { photoRoutes, claimPhotos } from '../src/photos.js';

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
    assert.equal((await t.call('alice', 'POST', '/api/photos', await jpeg())).status, 429);
    assert.equal((await t.call('bob', 'POST', '/api/photos', await jpeg())).status, 200);
  } finally {
    await t.close();
  }
});

test('claiming moves photos into the run dir and rejects foreign, bad or too many ids', async () => {
  const t = await withPhotos();
  try {
    const ids = [];
    for (let i = 0; i < 5; i++)
      ids.push((await t.call('alice', 'POST', '/api/photos', await jpeg(10 + i))).json.photoId);
    const bob = (await t.call('bob', 'POST', '/api/photos', await jpeg())).json.photoId;
    const claim = (user, photoIds, runId = 'run-12345678') =>
      claimPhotos({ dataDir: t.dataDir, user, runId, photoIds });
    assert.throws(() => claim('alice', ids), /at most 4/);
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
