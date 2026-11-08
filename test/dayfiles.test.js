import test from 'node:test';
import assert from 'node:assert/strict';
import { validateDayfileRequest, parseDate, DayfileError } from '../gateway/dayfiles.mjs';

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
