import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { boot, readSse, send, newConv, photo } from './e2e-helpers.js';

const UNKNOWN = '00000000-0000-4000-8000-000000000000';
const text = async (res) => res.text();

// Everything below runs through the full service (HTTP, runner, real gateway, fake CLI).
test('user A can do nothing with user B conversations, photos or transcripts, by any route', async () => {
  const t = await boot();
  try {
    const b = await newConv(t, 'bob');
    const done = await readSse(await send(t, 'bob', b, { text: 'SECRET-B message' }));
    assert.equal(done.at(-1)[0], 'done');
    const bobPhoto = await photo(t, 'bob');

    const attempts = [
      ['GET', `/api/conversations/${b}/messages`],
      ['PATCH', `/api/conversations/${b}`, { title: 'x' }],
      ['DELETE', `/api/conversations/${b}`],
      ['POST', `/api/conversations/${b}/messages`, { text: 'hijack' }],
      ['POST', `/api/conversations/${b}/messages`, { text: 'hijack', photoIds: [bobPhoto] }],
      ['POST', `/api/conversations/${b}/retry`],
      ['POST', `/api/conversations/${b}/cancel`],
      ['GET', `/api/conversations/../${b}/messages`],
      ['GET', `/api/conversations/${UNKNOWN}/messages`],
    ];
    for (const [m, u, body] of attempts) {
      const res = await t.call('alice', m, u, body, body ? { 'content-type': 'application/json' } : {});
      assert.ok([404, 405].includes(res.status), `${m} ${u} -> ${res.status}`);
      assert.equal((await text(res)).includes('SECRET-B'), false);
    }
    // alice's own conversation cannot use bob's staged photo id either
    const a = await newConv(t, 'alice');
    const res = await send(t, 'alice', a, { text: 'look', photoIds: [bobPhoto] });
    assert.equal(res.status, 400);
    assert.equal(t.svc.runs.isBusy('alice'), false);
    // bob's data is untouched
    const msgs = (await (await t.call('bob', 'GET', `/api/conversations/${b}/messages`)).json()).messages;
    assert.equal(msgs[0].text, 'SECRET-B message');
    assert.ok(fs.existsSync(path.join(t.config.dataDir, 'users', 'bob', 'transcripts', `${b}.txt`)));
    assert.equal((await (await t.call('alice', 'GET', '/api/conversations')).json()).conversations.length, 1);
  } finally {
    await t.close();
  }
});

test('anonymous is 401, an unmapped identity is 403, on every route family', async () => {
  const t = await boot();
  try {
    for (const [m, u] of [
      ['GET', '/api/conversations'],
      ['POST', '/api/photos'],
      ['POST', `/api/conversations/${UNKNOWN}/messages`],
      ['GET', '/'],
      ['GET', '/js/app.js'],
    ]) {
      const anon = await fetch(t.base + u, { method: m });
      assert.equal(anon.status, 401, `${m} ${u}`);
      const bad = await t.call('mallory', m, u);
      assert.equal(bad.status, 403, `${m} ${u}`);
    }
    assert.equal((await fetch(t.base + '/healthz')).status, 200);
  } finally {
    await t.close();
  }
});

test('storage: each user writes only inside their own tree, and the gateway only sees their own paths', async () => {
  const t = await boot();
  try {
    const a = await newConv(t, 'alice');
    const b = await newConv(t, 'bob');
    const pa = await photo(t, 'alice');
    await readSse(await send(t, 'alice', a, { text: 'PHOTOS', photoIds: [pa] }));
    await readSse(await send(t, 'bob', b, { text: 'hello' }));
    const walk = (dir) =>
      fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).map((f) => path.join(dir, f)) : [];
    const root = t.config.dataDir;
    for (const f of walk(path.join(root, 'users', 'alice')))
      assert.equal(f.includes(`${path.sep}bob${path.sep}`), false);
    const bobFiles = walk(path.join(root, 'users', 'bob')).map((f) => path.basename(f));
    assert.ok(bobFiles.includes('chat.db'));
    assert.ok(bobFiles.includes(`${b}.txt`));
    assert.equal(bobFiles.includes(`${a}.txt`), false);
    assert.deepEqual(fs.readdirSync(path.join(root, 'users')).sort(), ['alice', 'bob']);
    // deleting bob's conversation never touches alice's files
    assert.equal((await t.call('bob', 'DELETE', `/api/conversations/${b}`)).status, 200);
    assert.ok(fs.existsSync(path.join(root, 'users', 'alice', 'transcripts', `${a}.txt`)));
  } finally {
    await t.close();
  }
});

test('privacy: no image bytes in either database after a photo run', async () => {
  const t = await boot();
  try {
    const a = await newConv(t, 'alice');
    const pa = await photo(t, 'alice');
    await readSse(await send(t, 'alice', a, { text: 'PHOTOS', photoIds: [pa] }));
    t.svc.stores.closeAll();
    const db = fs.readFileSync(path.join(t.config.dataDir, 'users', 'alice', 'chat.db'));
    assert.equal(db.includes(Buffer.from([0xff, 0xd8, 0xff])), false);
    assert.equal(db.includes(Buffer.from('JFIF')), false);
    assert.equal(fs.readdirSync(path.join(t.config.dataDir, 'users', 'alice', 'tmp')).length, 0);
    assert.equal(
      (await t.call('alice', 'GET', '/api/photos')).status,
      405,
      'there is no image-serving route',
    );
  } finally {
    await t.close();
  }
});

test('day files: each user reads only their own through the app and the real gateway', async () => {
  const t = await boot();
  try {
    const put = (user, date, name, text) => {
      const [y, m, d] = date.split('-');
      const dir = path.join(t.root, 'memory', user, 'history', y, m, d);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, name), text);
    };
    put('alice', '2026-11-05', 'day.md', 'ALICE-DAY');
    put('bob', '2026-11-06', 'bobday.md', 'BOB-ONLY');
    const list = async (u) => (await t.call(u, 'GET', '/api/dayfiles')).json();
    assert.deepEqual(await list('alice'), {
      days: [{ date: '2026-11-05', files: ['day.md'] }],
      next: null,
    });
    assert.deepEqual((await list('bob')).days, [{ date: '2026-11-06', files: ['bobday.md'] }]);
    const own = await t.call('alice', 'GET', '/api/dayfiles/2026-11-05/day.md');
    assert.equal((await own.json()).text, 'ALICE-DAY');
    for (const u of ['/api/dayfiles/2026-11-06/bobday.md', '/api/dayfiles/2026-11-05/bobday.md']) {
      const r = await t.call('alice', 'GET', u);
      assert.equal(r.status, 404);
      assert.equal((await r.text()).includes('BOB-ONLY'), false);
    }
    assert.equal((await t.call('alice', 'GET', '/api/dayfiles/2026-11-05/day.md?user=bob')).status, 200);
    assert.equal((await fetch(t.base + '/api/dayfiles')).status, 401);
    // nothing in the app log names a file, date or its content
    const logged = t.logs.map((l) => String(l).replace(/"t":"[^"]*"/, '')).join('\n');
    assert.equal(/bobday|ALICE-DAY|BOB-ONLY|2026-11-0/.test(logged), false);
    // a gateway restart is survived by the next request
    await t.restartGateway();
    assert.equal((await list('alice')).days.length, 1);
  } finally {
    await t.close();
  }
});
