import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGateway, loadGatewayConfig, toolLists, buildArgv, buildEnv } from '../gateway/gateway.mjs';
import { tmpDir, rmDir } from './helpers.js';

const FAKE_SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-claude.mjs');
const USERS = {
  alice: ['mcp__claude_ai_Onyx_-_Alice', 'mcp__claude_ai_Oura'],
  bob: ['mcp__claude_ai_Onyx_-_Bob'],
};

async function setup(extra = {}) {
  const root = tmpDir();
  const dataDir = path.join(root, 'data');
  const bin = path.join(root, 'bin');
  const sockDir = path.join(root, 'sock');
  const memory = path.join(root, 'memory');
  for (const d of [dataDir, bin, memory]) fs.mkdirSync(d, { recursive: true });
  fs.copyFileSync(FAKE_SRC, path.join(bin, 'fake-claude.mjs'));
  fs.chmodSync(path.join(bin, 'fake-claude.mjs'), 0o755);
  const cfg = loadGatewayConfig({
    DATA_DIR: dataDir,
    SOCKET_DIR: sockDir,
    CLAUDE_BIN: path.join(bin, 'fake-claude.mjs'),
    GATEWAY_USERS: JSON.stringify(USERS),
    APOLLO_MEMORY_ROOT: memory,
    RUN_TIMEOUT_MS: '60000',
    KILL_GRACE_MS: '200',
    ...extra,
  });
  const logs = [];
  const gw = createGateway(cfg, { log: (o) => logs.push(JSON.stringify(o)) });
  const sock = await gw.listen();
  const spawned = () =>
    fs.existsSync(path.join(bin, 'fake.log')) ? fs.readFileSync(path.join(bin, 'fake.log'), 'utf8') : '';
  return {
    cfg,
    gw,
    sock,
    root,
    dataDir: cfg.dataDir,
    memory,
    logs,
    spawned,
    request: (obj, { raw } = {}) => request(sock, raw ?? JSON.stringify(obj) + '\n'),
    open: (obj) => open(sock, obj),
    async close() {
      await gw.close();
      rmDir(root);
    },
  };
}

function open(sock, obj) {
  const events = [];
  const c = net.createConnection(sock);
  c.setEncoding('utf8');
  let buf = '';
  const done = new Promise((resolve) => {
    c.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        events.push(JSON.parse(buf.slice(0, i)));
        buf = buf.slice(i + 1);
      }
    });
    c.on('close', () => resolve(events));
    c.on('error', () => resolve(events));
  });
  c.write(typeof obj === 'string' ? obj : JSON.stringify(obj) + '\n');
  return { events, done, conn: c };
}
const request = (sock, raw) => open(sock, raw).done;

function runDir(t, user, runId, files = ['p.jpg']) {
  const dir = path.join(t.dataDir, 'users', user, 'tmp', runId);
  fs.mkdirSync(dir, { recursive: true });
  return files.map((f) => {
    const p = path.join(dir, f);
    fs.writeFileSync(p, 'img');
    return p;
  });
}

const base = (o = {}) => ({ user: 'alice', prompt: 'hi', run_id: 'run-aaaaaaaa', ...o });
const exitOf = (events) => events.find((e) => e.type === 'exit');

test('a valid request streams the fake output and reports exit 0', async () => {
  const t = await setup();
  try {
    const ev = await t.request(base());
    const lines = ev.filter((e) => e.type === 'line').map((e) => JSON.parse(e.data));
    assert.equal(lines.at(-1).type, 'result');
    assert.equal(lines[0].event.delta.text, 'Hello ');
    assert.deepEqual(
      { ...exitOf(ev), dayfile: undefined },
      { type: 'exit', code: 0, signal: null, timedOut: false, cancelled: false, dayfile: undefined },
    );
    assert.equal(t.gw.active.size, 0);
  } finally {
    await t.close();
  }
});

test('fixed argv, cwd and an exact minimal environment, set by the gateway only', async () => {
  const t = await setup();
  process.env.SENTINEL_SECRET = 'leak-me';
  try {
    const paths = runDir(t, 'alice', 'run-aaaaaaaa');
    const ev = await t.request(base({ prompt: 'INFO', photo_paths: paths }));
    const info = JSON.parse(ev.find((e) => e.type === 'line' && e.data.includes('"fake"')).data);
    assert.equal(info.argv[0], '-p');
    assert.deepEqual(info.argv.slice(1, 4), ['--agent', 'apollo', '--no-session-persistence']);
    assert.ok(info.argv.includes('dontAsk'));
    const adds = info.argv.flatMap((a, i) => (a === '--add-dir' ? [info.argv[i + 1]] : []));
    assert.deepEqual(adds, [
      path.join(t.dataDir, 'users', 'alice', 'tmp', 'run-aaaaaaaa'),
      path.join(t.dataDir, 'users', 'alice', 'transcripts'),
    ]);
    assert.equal(info.cwd, fs.realpathSync(path.join(t.dataDir, 'users', 'alice', 'work')));
    const allowed = new Set(['PATH', 'HOME', 'LANG', 'APOLLO_USER', 'APOLLO_CHAT_RUN', 'APOLLO_CHAT_DATA']);
    for (const k of Object.keys(info.env)) assert.ok(allowed.has(k), `unexpected env ${k}`);
    assert.equal(info.env.APOLLO_USER, 'alice');
    assert.equal(info.env.APOLLO_CHAT_RUN, '1');
    assert.equal(info.env.APOLLO_CHAT_DATA, t.dataDir);
    assert.equal(info.env.SENTINEL_SECRET, undefined);
    assert.equal(info.prompt, 'INFO');
  } finally {
    delete process.env.SENTINEL_SECRET;
    await t.close();
  }
});

test('tool lists: own connectors allowed, other users and non-health connectors denied', () => {
  const a = toolLists(USERS, 'alice');
  assert.ok(a.allowed.includes('mcp__claude_ai_Onyx_-_Alice') && a.allowed.includes('mcp__claude_ai_Oura'));
  assert.ok(a.disallowed.includes('mcp__claude_ai_Onyx_-_Bob'));
  assert.ok(!a.disallowed.includes('mcp__claude_ai_Oura'));
  for (const n of ['Gmail', 'Google_Calendar', 'Google_Drive', 'Claude_Docs'])
    assert.ok(a.disallowed.includes(`mcp__claude_ai_${n}`));
  const b = toolLists(USERS, 'bob');
  assert.ok(
    b.disallowed.includes('mcp__claude_ai_Oura') && b.disallowed.includes('mcp__claude_ai_Onyx_-_Alice'),
  );
  assert.ok(!b.allowed.includes('mcp__claude_ai_Oura'));
});

test('argv has no photo dir without photos and the env builder ignores everything else', () => {
  const cfg = { dataDir: '/path/to/data', users: USERS };
  const argv = buildArgv(cfg, { user: 'bob', runId: 'run-bbbbbbbb', photos: [] });
  assert.deepEqual(argv.filter((a) => a === '--add-dir').length, 1);
  assert.deepEqual(buildEnv(cfg, 'bob', { PATH: '/bin', HOME: '/h', SECRET: 'x', LANG: 'C' }), {
    PATH: '/bin',
    APOLLO_USER: 'bob',
    APOLLO_CHAT_RUN: '1',
    APOLLO_CHAT_DATA: '/path/to/data',
    HOME: '/h',
    LANG: 'C',
  });
});

test('invalid requests are rejected and nothing is spawned', async () => {
  const t = await setup();
  try {
    const own = runDir(t, 'alice', 'run-aaaaaaaa');
    const bobPhoto = runDir(t, 'bob', 'run-aaaaaaaa');
    const otherRun = runDir(t, 'alice', 'run-bbbbbbbb');
    const outside = path.join(t.root, 'outside.jpg');
    fs.writeFileSync(outside, 'x');
    const link = path.join(t.dataDir, 'users', 'alice', 'tmp', 'run-aaaaaaaa', 'link.jpg');
    fs.symlinkSync(outside, link);
    const dirLink = path.join(t.dataDir, 'users', 'alice', 'tmp', 'run-cccccccc');
    fs.mkdirSync(path.join(t.root, 'elsewhere'));
    fs.writeFileSync(path.join(t.root, 'elsewhere', 'p.jpg'), 'x');
    fs.symlinkSync(path.join(t.root, 'elsewhere'), dirLink);
    const cases = {
      'unknown user': base({ user: 'mallory' }),
      'bad user pattern': base({ user: '../alice' }),
      'prototype user': base({ user: 'constructor' }),
      'dotdot path': base({
        photo_paths: [
          path.join(t.dataDir, 'users', 'alice', 'tmp', 'run-aaaaaaaa', '..', 'run-bbbbbbbb', 'p.jpg'),
        ],
      }),
      'symlink escape': base({ photo_paths: [link] }),
      'symlinked run dir': base({ run_id: 'run-cccccccc', photo_paths: [path.join(dirLink, 'p.jpg')] }),
      'other user path': base({ photo_paths: bobPhoto }),
      'wrong run id': base({ photo_paths: otherRun }),
      'relative path': base({ photo_paths: ['p.jpg'] }),
      'outside data dir': base({ photo_paths: [outside] }),
      'missing file': base({
        photo_paths: [path.join(t.dataDir, 'users', 'alice', 'tmp', 'run-aaaaaaaa', 'nope.jpg')],
      }),
      'too many photos': base({ photo_paths: [own[0], own[0], own[0], own[0], own[0]] }),
      'photos not array': base({ photo_paths: own[0] }),
      'bad run id': base({ run_id: '../x' }),
      'short run id': base({ run_id: 'abc' }),
      'empty prompt': base({ prompt: '' }),
      'extra args': base({ args: ['--dangerously-skip-permissions'] }),
      'extra env': base({ env: { A: 'b' } }),
      'extra cwd': base({ cwd: '/' }),
      'extra model': base({ model: 'x' }),
      'bad dayfile flag': base({ check_dayfile: 'yes' }),
      array: [base()],
      'cancel with extras': { cancel: 'run-aaaaaaaa', user: 'alice' },
    };
    for (const [name, req] of Object.entries(cases)) {
      const ev = await t.request(req);
      assert.deepEqual(ev, [{ type: 'error', code: 'invalid' }], name);
    }
    assert.deepEqual(await t.request(null, { raw: 'not json\n' }), [{ type: 'error', code: 'invalid' }]);
    assert.equal(t.spawned(), '', 'nothing was spawned');
    assert.equal(t.gw.active.size, 0);
  } finally {
    await t.close();
  }
});

test('oversized requests are refused', async () => {
  const t = await setup();
  try {
    const ev = await t.request(null, {
      raw: JSON.stringify(base({ prompt: 'x'.repeat(300 * 1024) })) + '\n',
    });
    assert.deepEqual(ev, [{ type: 'error', code: 'too_large' }]);
    assert.equal(t.spawned(), '');
  } finally {
    await t.close();
  }
});

test('timeout kills the child and reports it', async () => {
  const t = await setup({ RUN_TIMEOUT_MS: '300' });
  try {
    const ev = await t.request(base({ prompt: 'SLEEP 30000' }));
    const x = exitOf(ev);
    assert.equal(x.timedOut, true);
    const pid = Number(t.spawned().match(/start (\d+)/)[1]);
    await new Promise((r) => setTimeout(r, 100));
    assert.throws(() => process.kill(pid, 0), 'child is gone');
  } finally {
    await t.close();
  }
});

test('cancel kills a running run; unknown run ids are invalid', async () => {
  const t = await setup();
  try {
    const run = t.open(base({ prompt: 'SLEEP 30000' }));
    for (let i = 0; i < 100 && t.gw.active.size === 0; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(t.gw.active.size, 1);
    assert.deepEqual(await t.request({ cancel: 'run-aaaaaaaa' }), [{ type: 'cancelled' }]);
    const x = exitOf(await run.done);
    assert.equal(x.cancelled, true);
    assert.deepEqual(await t.request({ cancel: 'run-zzzzzzzz' }), [{ type: 'error', code: 'invalid' }]);
  } finally {
    await t.close();
  }
});

test('different users run in parallel, the same user is serialised, capacity is capped', async () => {
  const t = await setup({ MAX_RUNS: '2' });
  try {
    const a = t.open(base({ prompt: 'SLEEP 600', run_id: 'run-aaaaaaaa' }));
    const b = t.open(base({ user: 'bob', prompt: 'SLEEP 600', run_id: 'run-bbbbbbbb' }));
    for (let i = 0; i < 100 && t.gw.active.size < 2; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(t.gw.active.size, 2, 'both users are running at once');
    assert.deepEqual(await t.request(base({ run_id: 'run-dddddddd' })), [{ type: 'error', code: 'busy' }]);
    assert.deepEqual(await t.request(base({ user: 'bob', run_id: 'run-eeeeeeee' })), [
      { type: 'error', code: 'busy' },
    ]);
    await Promise.all([a.done, b.done]);
    assert.equal(exitOf(await a.done).code, 0);
    const log = t.spawned();
    const starts = [...log.matchAll(/start \d+ (\d+)/g)].map((m) => Number(m[1]));
    const ends = [...log.matchAll(/end \d+ (\d+)/g)].map((m) => Number(m[1]));
    assert.ok(Math.max(...starts) < Math.min(...ends), 'runs overlapped in time');
  } finally {
    await t.close();
  }
});

test('the global cap rejects extra runs from other users', async () => {
  const t = await setup({ MAX_RUNS: '1' });
  try {
    const a = t.open(base({ prompt: 'SLEEP 500' }));
    for (let i = 0; i < 100 && t.gw.active.size < 1; i++) await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(await t.request(base({ user: 'bob', run_id: 'run-bbbbbbbb' })), [
      { type: 'error', code: 'capacity' },
    ]);
    await a.done;
  } finally {
    await t.close();
  }
});

test('day-file check reports whether the history folder changed during the run', async () => {
  const t = await setup();
  try {
    const dir = path.join(t.memory, 'alice', 'history', String(new Date().getUTCFullYear()), '11', '05');
    let ev = await t.request(base({ prompt: 'plain', check_dayfile: true }));
    assert.equal(exitOf(ev).dayfile, false);
    ev = await t.request(
      base({ prompt: `WRITEDAY DAYDIR=${dir}`, check_dayfile: true, run_id: 'run-aaaaaab2' }),
    );
    assert.equal(exitOf(ev).dayfile, true);
    ev = await t.request(base({ prompt: 'plain', run_id: 'run-aaaaaab3' }));
    assert.equal(exitOf(ev).dayfile, null);
  } finally {
    await t.close();
  }
});

test('failing child reports its exit code', async () => {
  const t = await setup();
  try {
    assert.equal(exitOf(await t.request(base({ prompt: 'FAIL' }))).code, 1);
  } finally {
    await t.close();
  }
});

test('socket directory and socket have restrictive modes; logs hold no content', async () => {
  const t = await setup();
  try {
    assert.equal(fs.statSync(t.cfg.socketDir).mode & 0o777, 0o750);
    assert.equal(fs.statSync(t.sock).mode & 0o777, 0o660);
    const photo = runDir(t, 'alice', 'run-aaaaaaaa', ['SENTINEL_NAME.jpg']);
    await t.request(base({ prompt: 'SENTINEL_PROMPT text', photo_paths: photo }));
    const all = t.logs.join('\n');
    assert.equal(all.includes('SENTINEL'), false);
    assert.match(all, /"event":"run"/);
    assert.match(all, /"user":"alice"/);
  } finally {
    await t.close();
  }
});

test('config loader refuses incomplete or malformed settings', () => {
  const ok = { DATA_DIR: tmpDir('gw-'), SOCKET_DIR: '/path/to/sock', GATEWAY_USERS: JSON.stringify(USERS) };
  try {
    assert.doesNotThrow(() => loadGatewayConfig(ok));
    assert.throws(() => loadGatewayConfig({ ...ok, SOCKET_DIR: 'relative' }));
    assert.throws(() => loadGatewayConfig({ ...ok, GATEWAY_USERS: '{}' }));
    assert.throws(() => loadGatewayConfig({ ...ok, GATEWAY_USERS: '{"Bad User":[]}' }));
    assert.throws(() => loadGatewayConfig({ ...ok, GATEWAY_USERS: '{"alice":["not-a-prefix; rm"]}' }));
    assert.throws(() => loadGatewayConfig({ ...ok, MAX_RUNS: '0' }));
  } finally {
    rmDir(ok.DATA_DIR);
  }
});
