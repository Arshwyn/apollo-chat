import test from 'node:test';
import assert from 'node:assert/strict';
import { parseZone } from '../src/timezone.js';
import { startApp } from './api-helpers.js';

test('parseZone accepts IANA names and ignores everything else', () => {
  for (const ok of [
    'UTC',
    'America/New_York',
    'Asia/Singapore',
    'Etc/GMT+5',
    'America/Argentina/Buenos_Aires',
  ])
    assert.equal(parseZone(ok), ok);
  for (const bad of [
    undefined,
    null,
    42,
    {},
    ['UTC'],
    '',
    'x'.repeat(65),
    'Not/AZone',
    '../etc/passwd',
    'America/New_York/../../x',
    'UTC\n',
    'UTC; id',
    '+05:00',
    ' UTC',
    'a/b/c/d',
  ])
    assert.equal(parseZone(bad), null, String(bad));
});

test('chat auto-naming follows the client zone, then the stored zone, then TZ_NAME', async () => {
  // NOW is 2026-11-05T10:00Z; pin the clock to 2026-11-06T00:14Z (still 5 Nov evening in New York).
  const at = Date.parse('2026-11-06T00:14:00Z');
  const t = await startApp({ now: () => at });
  try {
    const create = (user, body) => t.call(user, 'POST', '/api/conversations', body);
    assert.equal((await create('alice', {})).json.title, '2026-11-06');
    assert.equal((await create('alice', { timeZone: 'America/New_York' })).json.title, '2026-11-05');
    // Remembered: no zone sent now still names for New York, the next one gets (2).
    assert.equal((await create('alice', {})).json.title, '2026-11-05 (2)');
    // Garbage is ignored and the stored zone stays.
    assert.equal((await create('alice', { timeZone: 'Nope/Zone' })).json.title, '2026-11-05 (3)');
    // A change of place applies from the next request.
    assert.equal((await create('alice', { timeZone: 'Asia/Singapore' })).json.title, '2026-11-06 (2)');
    // Another user is unaffected by alice's zone.
    assert.equal((await create('bob', {})).json.title, '2026-11-06');
    // A request without a body works as before.
    assert.equal((await t.call('bob', 'POST', '/api/conversations')).status, 200);
  } finally {
    await t.close();
  }
});

test('deleting all data forgets the stored zone', async () => {
  const at = Date.parse('2026-11-06T00:14:00Z');
  const t = await startApp({ now: () => at });
  try {
    await t.call('alice', 'POST', '/api/conversations', { timeZone: 'America/New_York' });
    await t.call('alice', 'DELETE', '/api/me/data');
    assert.equal((await t.call('alice', 'POST', '/api/conversations', {})).json.title, '2026-11-06');
  } finally {
    await t.close();
  }
});
