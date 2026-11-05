import test from 'node:test';
import assert from 'node:assert/strict';
import { localDate, nextAutoName, cleanTitle } from '../src/naming.js';

const at = (iso) => Date.parse(iso);

test('local date uses the configured time zone', () => {
  // 23:30 UTC on the 4th is already the 5th in a UTC+2 zone, and still the 4th in UTC.
  assert.equal(localDate(at('2026-11-04T23:30:00Z'), 'UTC'), '2026-11-04');
  assert.equal(localDate(at('2026-11-04T23:30:00Z'), 'Europe/Berlin'), '2026-11-05');
  // 01:30 UTC on the 5th is still the 4th in a UTC-5 zone.
  assert.equal(localDate(at('2026-11-05T01:30:00Z'), 'America/New_York'), '2026-11-04');
});

test('first, second and third chat the same day', () => {
  const now = at('2026-11-05T10:00:00Z');
  assert.equal(nextAutoName([], now, 'UTC'), '2026-11-05');
  assert.equal(nextAutoName(['2026-11-05'], now, 'UTC'), '2026-11-05 (2)');
  assert.equal(nextAutoName(['2026-11-05', '2026-11-05 (2)'], now, 'UTC'), '2026-11-05 (3)');
});

test('other days do not count and renamed or deleted chats free or keep slots', () => {
  const now = at('2026-11-05T10:00:00Z');
  assert.equal(nextAutoName(['2026-11-04', '2026-11-04 (2)'], now, 'UTC'), '2026-11-05');
  assert.equal(nextAutoName(['My plan'], now, 'UTC'), '2026-11-05');
  // The first auto-name was renamed away, the second still exists: first free slot is reused, never a duplicate.
  assert.equal(nextAutoName(['2026-11-05 (2)'], now, 'UTC'), '2026-11-05');
});

test('DST change day keeps one name per local day', () => {
  // US clocks go back on 2026-11-01: 05:30 UTC and 06:30 UTC are both the 1st in New York.
  assert.equal(localDate(at('2026-11-01T05:30:00Z'), 'America/New_York'), '2026-11-01');
  assert.equal(localDate(at('2026-11-01T06:30:00Z'), 'America/New_York'), '2026-11-01');
  assert.equal(localDate(at('2026-11-02T04:59:00Z'), 'America/New_York'), '2026-11-01');
  assert.equal(localDate(at('2026-11-02T05:00:00Z'), 'America/New_York'), '2026-11-02');
});

test('rename validation trims, strips control characters and bounds length', () => {
  assert.equal(cleanTitle('  Leg day  '), 'Leg day');
  assert.equal(cleanTitle('a\nb'), 'a b');
  assert.equal(cleanTitle(''), null);
  assert.equal(cleanTitle('   '), null);
  assert.equal(cleanTitle('x'.repeat(81)), null);
  assert.equal(cleanTitle('x'.repeat(80)).length, 80);
  assert.equal(cleanTitle(5), null);
});
