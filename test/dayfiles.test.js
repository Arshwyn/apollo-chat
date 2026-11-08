import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { validateDayfileRequest, parseDate, DayfileError } from '../gateway/dayfiles.mjs';
import { createGateway, loadGatewayConfig } from '../gateway/gateway.mjs';
import { tmpDir, rmDir } from './helpers.js';

const cfg = { users: { alice: [], bob: [] } };
const bad = (req) =>
  assert.throws(
    () => validateDayfileRequest(cfg, req),
    (e) => e instanceof DayfileError && e.code === 'invalid',
    JSON.stringify(req),
  );
const read = (extra) => ({ op: 'dayfile_read', user: 'alice', date: '2026-11-05', name: 'day.md', ...extra });
const list = (extra) => ({ op: 'dayfiles_list', user: 'alice', ...extra });

test('valid list and read requests are accepted and normalised', () => {
  assert.deepEqual(validateDayfileRequest(cfg, list()), {
    op: 'dayfiles_list',
    user: 'alice',
    limit: 30,
    before: null,
  });
  assert.deepEqual(validateDayfileRequest(cfg, list({ limit: 100, before: '2026-02-28' })), {
    op: 'dayfiles_list',
    user: 'alice',
    limit: 100,
    before: '2026-02-28',
  });
  assert.deepEqual(validateDayfileRequest(cfg, read()), {
    op: 'dayfile_read',
    user: 'alice',
    date: '2026-11-05',
    name: 'day.md',
  });
  assert.equal(validateDayfileRequest(cfg, read({ name: 'a_b-9.md' })).name, 'a_b-9.md');
  assert.equal(validateDayfileRequest(cfg, read({ date: '2024-02-29' })).date, '2024-02-29');
});

test('user must be a known, well-formed id', () => {
  for (const user of [
    'carol',
    'Alice',
    '',
    'al ice',
    '../alice',
    'alice\0',
    5,
    null,
    ['alice'],
    'constructor',
  ]) {
    bad(read({ user }));
    bad(list({ user }));
  }
  bad({ op: 'dayfile_read', date: '2026-11-05', name: 'day.md' });
});

test('op must be a known string and keys are exact', () => {
  for (const op of [undefined, null, 5, 'run', 'toString', '__proto__', ['dayfiles_list'], 'DAYFILES_LIST']) {
    bad({ op, user: 'alice' });
  }
  bad(null);
  bad([]);
  bad('dayfiles_list');
  bad(list({ extra: 1 }));
  bad(read({ extra: 1 }));
  bad(read({ limit: 5 }));
  bad(list({ date: '2026-11-05' }));
  bad(list({ name: 'day.md' }));
  bad(read({ prompt: 'x' }));
});

test('dates must be real calendar dates in the fixed format', () => {
  for (const date of [
    '2026-02-30',
    '2026-13-01',
    '2026-00-10',
    '2026-04-31',
    '2025-02-29',
    '26-1-1',
    '2026-1-01',
    '2026-01-1',
    ' 2026-01-01',
    '2026-01-01 ',
    '2026-01-01\n',
    '2026/01/01',
    '1999-12-31',
    '2101-01-01',
    '../2026-01-01',
    '2026-01-01/..',
    '2026-01-01\0',
    '%32026-01-01',
    20260101,
    null,
    ['2026-01-01'],
    {},
    undefined,
  ]) {
    bad(read({ date }));
    if (date !== undefined) bad(list({ before: date }));
  }
  assert.equal(parseDate('2000-01-01').year, '2000');
  assert.equal(parseDate('2100-12-31').day, '31');
});

test('names are one lowercase segment ending in .md', () => {
  for (const name of [
    '..',
    '../day.md',
    '../../etc/passwd',
    '/etc/passwd',
    '/day.md',
    'a/b.md',
    'a\\b.md',
    '..\\day.md',
    '%2e%2e%2fday.md',
    '%2fday.md',
    'day\0.md',
    'day.md\0',
    'day.md\0.txt',
    'Day.md',
    'DAY.MD',
    'day.MD',
    'a.md.txt',
    'a.txt',
    'a',
    '.md',
    '.hidden.md',
    'a b.md',
    'a.b.md',
    'day.md\n',
    ' day.md',
    '-day.md',
    '_day.md',
    `${'a'.repeat(65)}.md`,
    '',
    5,
    null,
    ['day.md'],
    {},
    undefined,
  ]) {
    bad(read({ name }));
  }
  assert.ok(validateDayfileRequest(cfg, read({ name: `${'a'.repeat(64)}.md` })));
});

test('limit is a strict integer from 1 to 100 and before a valid date', () => {
  for (const limit of [0, -1, 1.5, 101, 1e9, NaN, Infinity, '10', null, [], {}, true]) bad(list({ limit }));
  for (const before of ['', '2026-1-1', null, 5, [], {}]) bad(list({ before }));
});

// ---- gateway harness: two users, synthetic day files in a temp memory root ----

const USERS = { alice: ['mcp__a'], bob: ['mcp__b'] };

async function setup({ memory = true } = {}) {
  const root = tmpDir();
  const dataDir = path.join(root, 'data');
  const mem = path.join(root, 'memory');
  fs.mkdirSync(dataDir);
  fs.mkdirSync(mem);
  const cfg = loadGatewayConfig({
    DATA_DIR: dataDir,
    SOCKET_DIR: path.join(root, 'sock'),
    GATEWAY_USERS: JSON.stringify(USERS),
    ...(memory ? { APOLLO_MEMORY_ROOT: mem } : {}),
  });
  const logs = [];
  const gw = createGateway(cfg, { log: (o) => logs.push(JSON.stringify(o)) });
  const sock = await gw.listen();
  const ask = (obj) =>
    new Promise((resolve) => {
      const events = [];
      let buf = '';
      const c = net.createConnection(sock);
      c.setEncoding('utf8');
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
      c.write(typeof obj === 'string' ? obj : JSON.stringify(obj) + '\n');
    });
  const put = (user, date, name, text = `# ${user} ${date}\n`) => {
    const [y, m, d] = date.split('-');
    const dir = path.join(mem, user, 'history', y, m, d);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
    return path.join(dir, name);
  };
  return {
    mem,
    root,
    logs,
    ask,
    put,
    async close() {
      await gw.close();
      rmDir(root);
    },
  };
}

// A recursive listing with sizes and mtimes, to prove a call changed nothing.
function snapshot(dir) {
  const out = [];
  const walk = (d) => {
    for (const n of fs.readdirSync(d).sort()) {
      const p = path.join(d, n);
      const st = fs.lstatSync(p);
      out.push(`${p}|${st.size}|${st.mtimeMs}`);
      if (st.isDirectory()) walk(p);
    }
  };
  walk(dir);
  return out.join('\n');
}

const listOf = (ev) => ev.find((e) => e.type === 'dayfiles')?.days;
const codeOf = (ev) => ev.find((e) => e.type === 'error')?.code;

test('listing is newest first, scoped to the requesting user, and omits empty days', async () => {
  const t = await setup();
  try {
    t.put('alice', '2026-11-05', 'day.md');
    t.put('alice', '2026-11-05', 'morning.md');
    t.put('alice', '2026-10-31', 'day.md');
    t.put('alice', '2025-12-31', 'day.md');
    t.put('bob', '2026-11-06', 'bobday.md');
    fs.mkdirSync(path.join(t.mem, 'alice', 'history', '2026', '11', '04'), { recursive: true });
    t.put('alice', '2026-11-03', 'notes.txt');
    const before = snapshot(t.mem);

    const a = listOf(await t.ask({ op: 'dayfiles_list', user: 'alice' }));
    assert.deepEqual(a, [
      { date: '2026-11-05', files: ['day.md', 'morning.md'] },
      { date: '2026-10-31', files: ['day.md'] },
      { date: '2025-12-31', files: ['day.md'] },
    ]);
    const b = listOf(await t.ask({ op: 'dayfiles_list', user: 'bob' }));
    assert.deepEqual(b, [{ date: '2026-11-06', files: ['bobday.md'] }]);
    assert.equal(JSON.stringify(a).includes('bobday'), false);
    assert.equal(snapshot(t.mem), before);
  } finally {
    await t.close();
  }
});

test('listing honours limit and the exclusive before cursor', async () => {
  const t = await setup();
  try {
    for (const d of ['2026-11-05', '2026-11-04', '2026-10-30', '2026-01-02']) t.put('alice', d, 'day.md');
    const first = listOf(await t.ask({ op: 'dayfiles_list', user: 'alice', limit: 2 }));
    assert.deepEqual(
      first.map((x) => x.date),
      ['2026-11-05', '2026-11-04'],
    );
    const next = listOf(await t.ask({ op: 'dayfiles_list', user: 'alice', limit: 2, before: '2026-11-04' }));
    assert.deepEqual(
      next.map((x) => x.date),
      ['2026-10-30', '2026-01-02'],
    );
    assert.deepEqual(listOf(await t.ask({ op: 'dayfiles_list', user: 'alice', before: '2026-01-02' })), []);
    assert.deepEqual(listOf(await t.ask({ op: 'dayfiles_list', user: 'alice', before: '2000-01-01' })), []);
  } finally {
    await t.close();
  }
});

test('the default page is 30 days and the maximum is 100', async () => {
  const t = await setup();
  try {
    for (let i = 0; i < 120; i++) {
      const dt = new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10);
      t.put('alice', dt, 'day.md');
    }
    assert.equal(listOf(await t.ask({ op: 'dayfiles_list', user: 'alice' })).length, 30);
    assert.equal(listOf(await t.ask({ op: 'dayfiles_list', user: 'alice', limit: 100 })).length, 100);
    assert.equal(codeOf(await t.ask({ op: 'dayfiles_list', user: 'alice', limit: 101 })), 'invalid');
  } finally {
    await t.close();
  }
});

test('listing skips linked and oddly named entries at every level', async () => {
  const t = await setup();
  try {
    t.put('alice', '2026-11-05', 'day.md');
    t.put('bob', '2026-09-09', 'secret.md');
    const hist = path.join(t.mem, 'alice', 'history');
    // linked year, month and day folders pointing at bob's data, and a linked file
    fs.symlinkSync(path.join(t.mem, 'bob', 'history', '2026'), path.join(hist, '2027'));
    fs.symlinkSync(path.join(t.mem, 'bob', 'history', '2026', '09'), path.join(hist, '2026', '10'));
    fs.symlinkSync(
      path.join(t.mem, 'bob', 'history', '2026', '09', '09'),
      path.join(hist, '2026', '11', '06'),
    );
    fs.symlinkSync(
      path.join(t.mem, 'bob', 'history', '2026', '09', '09', 'secret.md'),
      path.join(hist, '2026', '11', '05', 'linked.md'),
    );
    fs.mkdirSync(path.join(hist, '2026', '11', '05', 'dir.md'));
    fs.mkdirSync(path.join(hist, 'abcd'));
    t.put('alice', '2026-11-05', 'Upper.md');
    t.put('alice', '2026-11-05', 'a.md.txt');
    t.put('alice', '2026-02-30', 'day.md');
    const days = listOf(await t.ask({ op: 'dayfiles_list', user: 'alice', limit: 100 }));
    assert.deepEqual(days, [{ date: '2026-11-05', files: ['day.md'] }]);
    assert.equal(JSON.stringify(days).includes('secret'), false);
  } finally {
    await t.close();
  }
});

test('a user with no folder gets an empty list; a linked user root is refused', async () => {
  const t = await setup();
  try {
    assert.deepEqual(listOf(await t.ask({ op: 'dayfiles_list', user: 'alice' })), []);
    const outside = path.join(t.root, 'outside');
    fs.mkdirSync(path.join(outside, 'history', '2026', '11', '05'), { recursive: true });
    fs.writeFileSync(path.join(outside, 'history', '2026', '11', '05', 'day.md'), 'x');
    fs.symlinkSync(outside, path.join(t.mem, 'alice'));
    assert.equal(codeOf(await t.ask({ op: 'dayfiles_list', user: 'alice' })), 'unavailable');
    fs.rmSync(path.join(t.mem, 'alice'));
    fs.mkdirSync(path.join(t.mem, 'alice'));
    fs.symlinkSync(path.join(outside, 'history'), path.join(t.mem, 'alice', 'history'));
    assert.equal(codeOf(await t.ask({ op: 'dayfiles_list', user: 'alice' })), 'unavailable');
  } finally {
    await t.close();
  }
});

test('an unset memory root is unavailable; bad requests are invalid; run keys stay rejected', async () => {
  const t = await setup({ memory: false });
  try {
    assert.equal(codeOf(await t.ask({ op: 'dayfiles_list', user: 'alice' })), 'unavailable');
  } finally {
    await t.close();
  }
  const u = await setup();
  try {
    for (const req of [
      { op: 'dayfiles_list', user: 'carol' },
      { op: 'dayfiles_list', user: 'alice', limit: 0 },
      { op: 'dayfiles_list', user: 'alice', before: '2026-13-01' },
      { op: 'dayfiles_list', user: 'alice', prompt: 'x' },
      { op: 'nope', user: 'alice' },
      { op: 'dayfiles_list', user: 'alice', cancel: 'x' },
      { user: 'alice', prompt: 'hi', run_id: 'run-aaaaaaaa', op: 'dayfiles_list' },
    ]) {
      assert.equal(codeOf(await u.ask(req)), 'invalid', JSON.stringify(req));
    }
    assert.equal(codeOf(await u.ask('not json\n')), 'invalid');
  } finally {
    await u.close();
  }
});

test('gateway log lines for day files carry no dates, names, paths or content', async () => {
  const t = await setup();
  try {
    t.put('alice', '2026-11-05', 'day.md', 'PRIVATE-CONTENT');
    await t.ask({ op: 'dayfiles_list', user: 'alice' });
    await t.ask({ op: 'dayfiles_list', user: 'alice', limit: 0, before: '2026-11-05' });
    await t.ask({ op: 'dayfiles_list', user: '../etc' });
    await t.ask({ op: '../x/day.md', user: 'alice' });
    assert.equal(t.logs.length, 4);
    for (const l of t.logs) {
      const o = JSON.parse(l);
      assert.deepEqual(Object.keys(o), ['t', 'event', 'op', 'user', 'code']);
      assert.equal(o.event, 'dayfiles');
      assert.ok(!/2026|day\.md|PRIVATE|memory|etc|\.\./.test(l.replace(o.t, '')), l);
    }
    assert.deepEqual(
      t.logs.map((l) => JSON.parse(l).code),
      ['ok', 'invalid', 'invalid', 'invalid'],
    );
  } finally {
    await t.close();
  }
});
