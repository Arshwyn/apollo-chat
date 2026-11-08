import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { createGatewayClient, GatewayError } from '../src/gatewayClient.js';
import { tmpDir, rmDir } from './helpers.js';

// A fake gateway: replies to each request line with `reply(req)` (an array of events) and ends the connection.
function fakeGateway(sockPath, reply) {
  const seen = [];
  const server = net.createServer((c) => {
    let buf = '';
    c.setEncoding('utf8');
    c.on('error', () => {});
    c.on('data', (d) => {
      buf += d;
      const i = buf.indexOf('\n');
      if (i < 0) return;
      const req = JSON.parse(buf.slice(0, i));
      seen.push(req);
      c.end(
        reply(req)
          .map((e) => JSON.stringify(e) + '\n')
          .join(''),
      );
    });
  });
  return new Promise((resolve) => server.listen(sockPath, () => resolve({ server, seen })));
}
const stop = (server) => new Promise((r) => server.close(r));

async function withDir(fn) {
  const dir = tmpDir();
  try {
    await fn(path.join(dir, 'gateway.sock'));
  } finally {
    rmDir(dir);
  }
}

test('listDayfiles sends the list op and resolves with the days', async () => {
  await withDir(async (sock) => {
    const days = [{ date: '2026-11-05', files: ['day.md'] }];
    const gw = await fakeGateway(sock, () => [{ type: 'dayfiles', days }]);
    const client = createGatewayClient({ socketPath: sock });
    assert.deepEqual(await client.listDayfiles({ user: 'alice' }), days);
    assert.deepEqual(await client.listDayfiles({ user: 'alice', limit: 5, before: '2026-11-05' }), days);
    assert.deepEqual(gw.seen, [
      { op: 'dayfiles_list', user: 'alice' },
      { op: 'dayfiles_list', user: 'alice', limit: 5, before: '2026-11-05' },
    ]);
    await stop(gw.server);
  });
});

test('readDayfile sends the read op and resolves with date, name and text', async () => {
  await withDir(async (sock) => {
    const gw = await fakeGateway(sock, (r) => [
      { type: 'dayfile', date: r.date, name: r.name, text: '# Hi' },
    ]);
    const client = createGatewayClient({ socketPath: sock });
    assert.deepEqual(await client.readDayfile({ user: 'bob', date: '2026-11-05', name: 'day.md' }), {
      date: '2026-11-05',
      name: 'day.md',
      text: '# Hi',
    });
    assert.deepEqual(gw.seen, [{ op: 'dayfile_read', user: 'bob', date: '2026-11-05', name: 'day.md' }]);
    await stop(gw.server);
  });
});

test('gateway error codes reject as GatewayError with the generic code', async () => {
  await withDir(async (sock) => {
    for (const code of ['invalid', 'not_found', 'too_large', 'unavailable']) {
      const gw = await fakeGateway(sock, () => [{ type: 'error', code }]);
      const client = createGatewayClient({ socketPath: sock });
      for (const call of [
        () => client.listDayfiles({ user: 'alice' }),
        () => client.readDayfile({ user: 'alice', date: '2026-11-05', name: 'day.md' }),
      ]) {
        await assert.rejects(call(), (e) => e instanceof GatewayError && e.code === code);
      }
      await stop(gw.server);
      fs.rmSync(sock, { force: true });
    }
  });
});

test('a connection that closes without an answer rejects as closed', async () => {
  await withDir(async (sock) => {
    const gw = await fakeGateway(sock, () => []);
    const client = createGatewayClient({ socketPath: sock });
    await assert.rejects(client.listDayfiles({ user: 'alice' }), (e) => e.code === 'closed');
    await stop(gw.server);
  });
});

test('a run exit event does not resolve a day-file call, and runs still resolve on exit', async () => {
  await withDir(async (sock) => {
    const gw = await fakeGateway(sock, (r) =>
      r.op
        ? [{ type: 'exit', code: 0 }]
        : [
            { type: 'line', data: 'x' },
            { type: 'exit', code: 0 },
          ],
    );
    const client = createGatewayClient({ socketPath: sock });
    await assert.rejects(client.listDayfiles({ user: 'alice' }), (e) => e.code === 'closed');
    const lines = [];
    const out = await client.run(
      { user: 'alice', prompt: 'p', run_id: 'run-aaaaaaaa' },
      { onLine: (l) => lines.push(l) },
    );
    assert.equal(out.type, 'exit');
    assert.deepEqual(lines, ['x']);
    await stop(gw.server);
  });
});

test('calls survive a gateway restart through the connect retry', async () => {
  await withDir(async (sock) => {
    const client = createGatewayClient({ socketPath: sock, backoffMs: [20, 50, 100, 200, 400, 800] });
    // nothing is listening yet: the call retries, then succeeds once the gateway appears
    const pending = client.listDayfiles({ user: 'alice' });
    await new Promise((r) => setTimeout(r, 100));
    const gw = await fakeGateway(sock, () => [{ type: 'dayfiles', days: [] }]);
    assert.deepEqual(await pending, []);
    await stop(gw.server);
    fs.rmSync(sock, { force: true });
    const pendingRead = client.readDayfile({ user: 'alice', date: '2026-11-05', name: 'day.md' });
    await new Promise((r) => setTimeout(r, 100));
    const gw2 = await fakeGateway(sock, (r) => [{ type: 'dayfile', date: r.date, name: r.name, text: 't' }]);
    assert.equal((await pendingRead).text, 't');
    await stop(gw2.server);
  });
});

test('with no gateway at all the call fails as unavailable after the retries', async () => {
  await withDir(async (sock) => {
    const client = createGatewayClient({ socketPath: sock, backoffMs: [5, 5] });
    await assert.rejects(client.listDayfiles({ user: 'alice' }), (e) => e.code === 'unavailable');
  });
});
