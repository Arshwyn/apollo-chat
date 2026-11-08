import test from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './api-helpers.js';
import { dayfileRoutes } from '../src/dayfiles.js';
import { GatewayError } from '../src/gatewayClient.js';

// The app only talks to the gateway through this client interface, so a fake records every call.
function fakeGateway(over = {}) {
  const calls = [];
  return {
    calls,
    async listDayfiles(req) {
      calls.push(['list', req]);
      if (over.list) return over.list(req);
      return [{ date: '2026-11-05', files: ['day.md', 'morning.md'] }];
    },
    async readDayfile(req) {
      calls.push(['read', req]);
      if (over.read) return over.read(req);
      return { date: req.date, name: req.name, text: '# Day\n' };
    },
  };
}

async function app(over) {
  const gw = fakeGateway(over);
  const t = await startApp({ routes: dayfileRoutes({ gateway: gw }) });
  return { t, gw };
}

test('both endpoints need identity, like every other route', async () => {
  const { t, gw } = await app();
  try {
    for (const u of ['/api/dayfiles', '/api/dayfiles/2026-11-05/day.md']) {
      assert.equal((await t.call(null, 'GET', u)).status, 401);
      assert.equal((await t.call('mallory', 'GET', u)).status, 403);
      assert.equal((await t.call('alice', 'POST', u)).status, 405);
    }
    assert.equal(gw.calls.length, 0);
  } finally {
    await t.close();
  }
});

test('the gateway always sees the session user, whatever the request supplies', async () => {
  const { t, gw } = await app();
  try {
    const list = await t.call('alice', 'GET', '/api/dayfiles?user=bob&limit=5', undefined, {
      'x-user': 'bob',
      'x-forwarded-user': 'bob',
      'x-test-user-override': 'bob',
    });
    assert.equal(list.status, 200);
    const read = await t.call('alice', 'GET', '/api/dayfiles/2026-11-05/day.md?user=bob', undefined, {
      'x-user': 'bob',
    });
    assert.equal(read.status, 200);
    await t.call('bob', 'GET', '/api/dayfiles');
    assert.deepEqual(
      gw.calls.map(([k, r]) => [k, r.user]),
      [
        ['list', 'alice'],
        ['read', 'alice'],
        ['list', 'bob'],
      ],
    );
    // a request body is never read as an identity either
    await t.call('alice', 'GET', '/api/dayfiles', undefined, { 'content-type': 'application/json' });
    assert.equal(gw.calls.at(-1)[1].user, 'alice');
  } finally {
    await t.close();
  }
});

test('list returns days, a cursor when the page is full, and no-store', async () => {
  const days = [
    { date: '2026-11-05', files: ['day.md'] },
    { date: '2026-11-04', files: ['day.md', 'morning.md'] },
  ];
  const { t, gw } = await app({ list: () => days });
  try {
    const full = await t.call('alice', 'GET', '/api/dayfiles?limit=2&before=2026-11-06');
    assert.equal(full.status, 200);
    assert.deepEqual(full.json, { days, next: '2026-11-04' });
    assert.equal(full.headers.get('cache-control'), 'no-store');
    assert.deepEqual(gw.calls[0][1], { user: 'alice', limit: 2, before: '2026-11-06' });
    const part = await t.call('alice', 'GET', '/api/dayfiles?limit=3');
    assert.equal(part.json.next, null);
    const dflt = await t.call('alice', 'GET', '/api/dayfiles');
    assert.equal(gw.calls.at(-1)[1].limit, 30);
    assert.equal(dflt.json.next, null);
  } finally {
    await t.close();
  }
});

test('read returns the text with no-store', async () => {
  const { t } = await app();
  try {
    const r = await t.call('alice', 'GET', '/api/dayfiles/2026-11-05/day.md');
    assert.deepEqual(r.json, { date: '2026-11-05', name: 'day.md', text: '# Day\n' });
    assert.equal(r.headers.get('cache-control'), 'no-store');
  } finally {
    await t.close();
  }
});

test('bad date, name, limit and cursor are 400 and never reach the gateway', async () => {
  const { t, gw } = await app();
  try {
    for (const u of [
      '/api/dayfiles?limit=0',
      '/api/dayfiles?limit=-1',
      '/api/dayfiles?limit=1.5',
      '/api/dayfiles?limit=101',
      '/api/dayfiles?limit=abc',
      '/api/dayfiles?limit=',
      '/api/dayfiles?limit=0010',
      '/api/dayfiles?before=2026-02-30',
      '/api/dayfiles?before=26-1-1',
      '/api/dayfiles?before=',
      '/api/dayfiles/2026-02-30/day.md',
      '/api/dayfiles/2026-13-01/day.md',
      '/api/dayfiles/26-1-1/day.md',
      '/api/dayfiles/2026-11-05/Day.md',
      '/api/dayfiles/2026-11-05/day.txt',
      '/api/dayfiles/2026-11-05/day',
      '/api/dayfiles/2026-11-05/.md',
      '/api/dayfiles/2026-11-05/.hidden.md',
      '/api/dayfiles/2026-11-05/a.md.txt',
      '/api/dayfiles/2026-11-05/..%2fday.md',
      '/api/dayfiles/2026-11-05/a%5cb.md',
      '/api/dayfiles/2026-11-05/day.md%00',
    ]) {
      const r = await t.call('alice', 'GET', u);
      assert.equal(r.status, 400, u);
    }
    assert.equal(gw.calls.length, 0);
  } finally {
    await t.close();
  }
});

test('gateway errors map to generic statuses with no internals', async () => {
  const cases = [
    ['not_found', 404],
    ['too_large', 413],
    ['unavailable', 503],
    ['invalid', 502],
    ['closed', 502],
  ];
  for (const [code, status] of cases) {
    const fail = () => {
      throw new GatewayError(code);
    };
    const { t } = await app({ list: fail, read: fail });
    try {
      for (const u of ['/api/dayfiles', '/api/dayfiles/2026-11-05/day.md']) {
        const r = await t.call('alice', 'GET', u);
        assert.equal(r.status, status, `${code} ${u}`);
        assert.ok(!/gateway|path|errno|memory|ENOENT/i.test(r.text), r.text);
      }
    } finally {
      await t.close();
    }
  }
});

test('an unexpected failure is a generic 500 and a malformed gateway answer is a generic 502', async () => {
  const { t } = await app({
    list: () => {
      throw new Error('/secret/path ENOENT');
    },
  });
  try {
    const r = await t.call('alice', 'GET', '/api/dayfiles');
    assert.equal(r.status, 500);
    assert.deepEqual(r.json, { error: 'internal error' });
  } finally {
    await t.close();
  }
  for (const list of [
    () => 'nope',
    () => [{ date: '../x', files: [] }],
    () => [{ date: '2026-11-05', files: ['../x.md'] }],
  ]) {
    const a = await app({ list, read: () => ({ text: 5 }) });
    try {
      assert.equal((await a.t.call('alice', 'GET', '/api/dayfiles')).status, 502);
      assert.equal((await a.t.call('alice', 'GET', '/api/dayfiles/2026-11-05/day.md')).status, 502);
    } finally {
      await a.t.close();
    }
  }
});

test('app log lines carry only the route template, never dates, names or content', async () => {
  const { t } = await app({ read: () => ({ text: 'PRIVATE-CONTENT' }) });
  try {
    await t.call('alice', 'GET', '/api/dayfiles?before=2026-11-05&limit=3');
    await t.call('alice', 'GET', '/api/dayfiles/2026-11-05/morning.md');
    await t.call('alice', 'GET', '/api/dayfiles/2026-02-30/morning.md');
    const lines = t.logs.map((l) => (typeof l === 'string' ? l : JSON.stringify(l)));
    assert.ok(lines.length >= 3);
    for (const l of lines) {
      assert.ok(!/2026-11|2026-02|morning|PRIVATE|limit=/.test(l.replace(/"t":"[^"]*"/, '')), l);
    }
    assert.ok(lines.some((l) => l.includes('/api/dayfiles/:date/:name')));
  } finally {
    await t.close();
  }
});
