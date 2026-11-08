import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { boot, readSse, send, newConv, photo } from './e2e-helpers.js';

test('end to end: streamed reply over SSE, photo seen by the run then deleted, history persisted', async () => {
  const t = await boot();
  try {
    const id = await newConv(t, 'alice');
    const pid = await photo(t, 'alice');
    const res = await send(t, 'alice', id, { text: 'PHOTOS please', photoIds: [pid] });
    assert.equal(res.headers.get('content-type').split(';')[0], 'text/event-stream');
    const ev = await readSse(res);
    assert.equal(ev[0][0], 'start');
    assert.equal(ev.at(-1)[0], 'done');
    assert.equal(ev.at(-1)[1].text, 'photos:true', 'the run could read the photo while it ran');
    const msgs = (await (await t.call('alice', 'GET', `/api/conversations/${id}/messages`)).json()).messages;
    assert.deepEqual(
      msgs.map((m) => [m.role, m.text, m.photoCount]),
      [
        ['user', 'PHOTOS please', 1],
        ['assistant', 'photos:true', 0],
      ],
    );
    assert.deepEqual(fs.readdirSync(path.join(t.config.dataDir, 'users', 'alice', 'tmp')), []);
  } finally {
    await t.close();
  }
});

test('end to end: trailer lines are stripped and a second send while busy is 409, other user in parallel', async () => {
  const t = await boot();
  try {
    const a = await newConv(t, 'alice');
    const b = await newConv(t, 'bob');
    const slow = send(t, 'alice', a, { text: 'SLEEP 500' });
    await new Promise((r) => setTimeout(r, 150));
    const busy = await send(t, 'alice', a, { text: 'second' });
    assert.equal(busy.status, 409);
    assert.equal((await busy.json()).busy, true);
    const other = await readSse(await send(t, 'bob', b, { text: 'TRAILER' }));
    assert.equal(other.at(-1)[1].text, 'Answer text');
    const first = await readSse(await slow);
    assert.equal(first.at(-1)[0], 'done');
  } finally {
    await t.close();
  }
});

test('end to end: a client that disconnects does not stop the run; the reply is there on reload', async () => {
  const t = await boot();
  try {
    const id = await newConv(t, 'alice');
    const ctl = new AbortController();
    const p = fetch(`http://127.0.0.1:${t.svc.server.address().port}/api/conversations/${id}/messages`, {
      method: 'POST',
      headers: { 'x-test-user': 'alice', 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'SLEEP 400' }),
      signal: ctl.signal,
    });
    await new Promise((r) => setTimeout(r, 150));
    ctl.abort();
    await p.catch(() => {});
    for (let i = 0; i < 100 && t.svc.runs.isBusy('alice'); i++) await new Promise((r) => setTimeout(r, 50));
    const msgs = (await (await t.call('alice', 'GET', `/api/conversations/${id}/messages`)).json()).messages;
    assert.equal(msgs.at(-1).status, 'done');
    assert.equal(msgs.at(-1).text, 'woke');
  } finally {
    await t.close();
  }
});

test('end to end: cancel stops a running reply', async () => {
  const t = await boot();
  try {
    const id = await newConv(t, 'alice');
    const sending = send(t, 'alice', id, { text: 'SLEEP 30000' });
    await new Promise((r) => setTimeout(r, 200));
    assert.equal((await t.call('bob', 'POST', `/api/conversations/${id}/cancel`)).status, 404);
    assert.equal((await t.call('alice', 'POST', `/api/conversations/${id}/cancel`)).status, 200);
    const ev = await readSse(await sending);
    assert.equal(ev.at(-1)[0], 'done');
    assert.equal(ev.at(-1)[1].status, 'cancelled');
    assert.equal(t.svc.runs.isBusy('alice'), false);
  } finally {
    await t.close();
  }
});

test('end to end: the client reconnects after a gateway restart', async () => {
  const t = await boot();
  try {
    const id = await newConv(t, 'alice');
    await t.restartGateway();
    const ev = await readSse(await send(t, 'alice', id, { text: 'hello' }));
    assert.equal(ev.at(-1)[1].text, 'Hello there');
    // gateway down for a moment, then back while the app is retrying the connection
    await t.gw.close();
    const pending = send(t, 'alice', id, { text: 'again' });
    await new Promise((r) => setTimeout(r, 300));
    await t.restartGateway();
    const ev2 = await readSse(await pending);
    assert.equal(ev2.at(-1)[1].text, 'Hello there');
  } finally {
    await t.close();
  }
});

test('end to end: logs hold no message content', async () => {
  const t = await boot();
  try {
    const id = await newConv(t, 'alice');
    await readSse(await send(t, 'alice', id, { text: 'SENTINEL-MESSAGE-TEXT' }));
    assert.equal(t.logs.join('\n').includes('SENTINEL'), false);
  } finally {
    await t.close();
  }
});

test('end to end: a run that throws ends the SSE stream with an error event', async () => {
  const t = await boot();
  try {
    const id = await newConv(t, 'alice');
    t.svc.stores.forUser('alice').recentTurns = () => {
      throw new Error('boom');
    };
    const ev = await readSse(await send(t, 'alice', id, { text: 'hello' }));
    assert.deepEqual(
      ev.map((e) => e[0]),
      ['start', 'error'],
    );
    const msgs = (await (await t.call('alice', 'GET', `/api/conversations/${id}/messages`)).json()).messages;
    assert.equal(msgs.at(-1).status, 'error');
  } finally {
    await t.close();
  }
});
