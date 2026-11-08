import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startApp } from './api-helpers.js';

const UNKNOWN = '00000000-0000-4000-8000-000000000000';

test('health is open, everything else needs identity', async () => {
  const t = await startApp();
  try {
    assert.equal((await t.call(null, 'GET', '/healthz')).status, 200);
    assert.equal((await t.call(null, 'GET', '/api/conversations')).status, 401);
    assert.equal((await t.call(null, 'GET', '/')).status, 401);
    assert.equal((await t.call('mallory', 'GET', '/api/conversations')).status, 403);
    assert.deepEqual((await t.call('alice', 'GET', '/api/me')).json, { user: 'alice' });
  } finally {
    await t.close();
  }
});

test('conversation lifecycle: create, auto-name, rename, list, delete', async () => {
  const t = await startApp();
  try {
    const c1 = (await t.call('alice', 'POST', '/api/conversations')).json;
    const c2 = (await t.call('alice', 'POST', '/api/conversations')).json;
    assert.equal(c1.title, '2026-11-05');
    assert.equal(c2.title, '2026-11-05 (2)');
    const r = await t.call('alice', 'PATCH', `/api/conversations/${c1.id}`, { title: 'Leg day' });
    assert.equal(r.json.title, 'Leg day');
    assert.equal((await t.call('alice', 'PATCH', `/api/conversations/${c1.id}`, { title: '' })).status, 400);
    const list = (await t.call('alice', 'GET', '/api/conversations')).json.conversations;
    assert.equal(list.length, 2);
    const msgs = await t.call('alice', 'GET', `/api/conversations/${c1.id}/messages`);
    assert.equal(msgs.json.conversation.title, 'Leg day');
    assert.deepEqual(msgs.json.messages, []);
    assert.equal((await t.call('alice', 'DELETE', `/api/conversations/${c2.id}`)).status, 200);
    assert.equal((await t.call('alice', 'GET', `/api/conversations/${c2.id}/messages`)).status, 404);
  } finally {
    await t.close();
  }
});

test('messages page and persist across a store reopen', async () => {
  const t = await startApp();
  try {
    const c = (await t.call('alice', 'POST', '/api/conversations')).json;
    const s = t.stores.forUser('alice');
    for (let i = 0; i < 6; i++)
      s.addMessage({ conversationId: c.id, role: i % 2 ? 'assistant' : 'user', text: `m${i}` });
    const page = (await t.call('alice', 'GET', `/api/conversations/${c.id}/messages?limit=3`)).json.messages;
    assert.deepEqual(
      page.map((m) => m.text),
      ['m3', 'm4', 'm5'],
    );
    const older = (
      await t.call('alice', 'GET', `/api/conversations/${c.id}/messages?limit=3&before=${page[0].seq}`)
    ).json.messages;
    assert.deepEqual(
      older.map((m) => m.text),
      ['m0', 'm1', 'm2'],
    );
  } finally {
    await t.close();
  }
});

test('user A cannot list, read, rename or delete user B conversations (404, no data)', async () => {
  const t = await startApp();
  try {
    const b = (await t.call('bob', 'POST', '/api/conversations')).json;
    t.stores.forUser('bob').addMessage({ conversationId: b.id, role: 'user', text: 'SECRET-B' });
    const attempts = [
      ['GET', `/api/conversations/${b.id}/messages`],
      ['PATCH', `/api/conversations/${b.id}`, { title: 'hijack' }],
      ['DELETE', `/api/conversations/${b.id}`],
      ['GET', `/api/conversations/${b.id}/messages?user=bob`],
      ['GET', `/api/conversations/..%2F..%2Fusers%2Fbob/messages`],
      ['GET', `/api/conversations/${UNKNOWN}/messages`],
    ];
    for (const [m, u, body] of attempts) {
      const r = await t.call('alice', m, u, body);
      assert.equal(r.status, 404, `${m} ${u}`);
      assert.equal(r.text.includes('SECRET-B'), false);
    }
    assert.deepEqual((await t.call('alice', 'GET', '/api/conversations')).json.conversations, []);
    const still = await t.call('bob', 'GET', `/api/conversations/${b.id}/messages`);
    assert.equal(still.json.messages[0].text, 'SECRET-B');
    assert.equal(still.json.conversation.title, '2026-11-05');
    // the identity is never taken from query, header names or body
    const spoof = await t.call('alice', 'GET', '/api/conversations?user=bob', undefined, { 'x-user': 'bob' });
    assert.deepEqual(spoof.json.conversations, []);
  } finally {
    await t.close();
  }
});

test('deleting a conversation removes its transcript and run dirs only for that user', async () => {
  const t = await startApp();
  try {
    const a = (await t.call('alice', 'POST', '/api/conversations')).json;
    const b = (await t.call('bob', 'POST', '/api/conversations')).json;
    const mk = (user, convId, runId) => {
      const root = path.join(t.dataDir, 'users', user);
      fs.mkdirSync(path.join(root, 'transcripts'), { recursive: true });
      fs.writeFileSync(path.join(root, 'transcripts', `${convId}.txt`), 'x');
      fs.mkdirSync(path.join(root, 'tmp', runId), { recursive: true });
      fs.writeFileSync(path.join(root, 'tmp', runId, 'p.jpg'), 'x');
      t.stores.forUser(user).addMessage({ conversationId: convId, role: 'user', text: 'x', runId });
      return root;
    };
    const ra = mk('alice', a.id, 'run-alice-1');
    const rb = mk('bob', b.id, 'run-bob-001');
    assert.equal((await t.call('alice', 'DELETE', `/api/conversations/${a.id}`)).status, 200);
    assert.equal(fs.existsSync(path.join(ra, 'transcripts', `${a.id}.txt`)), false);
    assert.equal(fs.existsSync(path.join(ra, 'tmp', 'run-alice-1')), false);
    assert.equal(fs.existsSync(path.join(rb, 'transcripts', `${b.id}.txt`)), true);
    assert.equal(fs.existsSync(path.join(rb, 'tmp', 'run-bob-001', 'p.jpg')), true);
    // delete-all removes the caller's data and leaves the other user alone
    assert.equal((await t.call('alice', 'DELETE', '/api/me/data')).status, 200);
    assert.equal((await t.call('bob', 'GET', '/api/conversations')).json.conversations.length, 1);
    assert.equal(fs.existsSync(path.join(rb, 'tmp', 'run-bob-001', 'p.jpg')), true);
    await t.call('bob', 'DELETE', '/api/me/data');
    assert.equal(fs.readdirSync(path.join(rb, 'tmp')).length, 0);
    assert.equal(fs.readdirSync(path.join(rb, 'transcripts')).length, 0);
  } finally {
    await t.close();
  }
});

test('security headers, unknown routes and methods', async () => {
  const t = await startApp();
  try {
    const r = await t.call('alice', 'GET', '/api/me');
    assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
    assert.match(r.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
    assert.equal((await t.call('alice', 'GET', '/api/nope')).status, 404);
    assert.equal((await t.call('alice', 'PUT', '/api/conversations')).status, 405);
  } finally {
    await t.close();
  }
});

test('request logs carry no content, ids in paths, or identity details', async () => {
  const t = await startApp();
  try {
    const c = (await t.call('alice', 'POST', '/api/conversations')).json;
    await t.call('alice', 'PATCH', `/api/conversations/${c.id}`, { title: 'SENTINEL-TITLE' });
    t.stores.forUser('alice').addMessage({ conversationId: c.id, role: 'user', text: 'SENTINEL-MESSAGE' });
    await t.call('alice', 'GET', `/api/conversations/${c.id}/messages`);
    const all = t.logs.join('\n');
    assert.equal(all.includes('SENTINEL'), false);
    assert.equal(all.includes(c.id), false);
    assert.match(all, /"route":"\/api\/conversations\/:id\/messages"/);
  } finally {
    await t.close();
  }
});

test('the app shell is served to authenticated users only, with safe paths and types', async () => {
  const t = await startApp();
  try {
    const index = await t.call('alice', 'GET', '/');
    assert.equal(index.status, 200);
    assert.match(index.headers.get('content-type'), /text\/html/);
    assert.match(index.text, /<script type="module" src="\/js\/app.js">/);
    assert.equal(index.text.includes('<script>'), false, 'no inline scripts under the CSP');
    assert.match((await t.call('alice', 'GET', '/js/app.js')).headers.get('content-type'), /javascript/);
    assert.match((await t.call('alice', 'GET', '/style.css')).headers.get('content-type'), /text\/css/);
    assert.equal((await t.call(null, 'GET', '/style.css')).status, 401);
    const font = await t.call('alice', 'GET', '/fonts/public-sans-latin-wght-normal.woff2');
    assert.equal(font.status, 200);
    assert.equal(font.headers.get('content-type'), 'font/woff2');
    assert.equal(font.headers.get('x-content-type-options'), 'nosniff');
    assert.match(font.headers.get('content-security-policy'), /^default-src 'self';/);
    assert.equal((await t.call(null, 'GET', '/fonts/public-sans-latin-wght-normal.woff2')).status, 401);
    assert.equal((await t.call('alice', 'GET', '/..%2Fpackage.json')).status, 404);
    assert.equal((await t.call('alice', 'GET', '/%2e%2e/package.json')).status, 404);
    assert.equal((await t.call('alice', 'GET', '/js')).status, 404);
    for (const bad of ['/%E0%A4%A', '/%', '/%zz', '/..%2f..%2fetc%2fpasswd', '/js/%E0%A4%A.js']) {
      const r = await t.call('alice', 'GET', bad);
      assert.equal(r.status, 404, bad);
      assert.deepEqual(r.json, { error: 'not found' });
      assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
      assert.match(r.headers.get('content-security-policy'), /^default-src 'self';/);
    }
    assert.equal((await t.call('alice', 'GET', '/')).status, 200);
  } finally {
    await t.close();
  }
});

test('creating a conversation ignores unparseable bodies but not oversized ones', async () => {
  const t = await startApp();
  try {
    const big = JSON.stringify({ timeZone: 'UTC', pad: 'x'.repeat(70 * 1024) });
    const r = await t.call('alice', 'POST', '/api/conversations', big, {
      'content-type': 'application/json',
    });
    assert.equal(r.status, 413);
    assert.equal((await t.call('alice', 'GET', '/api/conversations')).json.conversations.length, 0);
    for (const body of ['not json {', '[1,2]', '"str"', '']) {
      const ok = await t.call('alice', 'POST', '/api/conversations', body, {
        'content-type': 'application/json',
      });
      assert.equal(ok.status, 200, JSON.stringify(body));
      assert.ok(ok.json.id);
    }
    // 10:00 UTC is already the next day on the far east side of the date line.
    const tz = await t.call('bob', 'POST', '/api/conversations', { timeZone: 'Pacific/Kiritimati' });
    assert.equal(tz.status, 200);
    assert.equal(tz.json.title, '2026-11-06');
  } finally {
    await t.close();
  }
});
