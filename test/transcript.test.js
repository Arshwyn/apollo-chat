import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { StoreRegistry } from '../src/store.js';
import { writeTranscript } from '../src/transcript.js';
import { buildPrompt, localClock } from '../src/prompt.js';
import { isTrigger } from '../src/triggers.js';
import { tmpDir, rmDir } from './helpers.js';

const NOW = Date.parse('2026-11-05T21:30:00Z');

test('transcript is text only, per user, in the configured time zone, and rewritten atomically', () => {
  const dataDir = tmpDir();
  const reg = new StoreRegistry({
    dataDir,
    userIds: ['alice', 'bob'],
    tzName: 'Europe/Berlin',
    now: () => NOW,
  });
  try {
    const s = reg.forUser('alice');
    const c = s.createConversation();
    s.addMessage({ conversationId: c.id, role: 'user', text: 'lunch?\nsecond line', photoCount: 2 });
    s.addMessage({ conversationId: c.id, role: 'assistant', text: 'about 600 kcal' });
    s.addMessage({ conversationId: c.id, role: 'assistant', text: 'part', status: 'error' });
    s.addMessage({ conversationId: c.id, role: 'assistant', text: '', status: 'running' });
    const file = writeTranscript({
      dataDir,
      user: 'alice',
      store: s,
      conversationId: c.id,
      timeZone: 'Europe/Berlin',
    });
    assert.equal(file, path.join(dataDir, 'users', 'alice', 'transcripts', `${c.id}.txt`));
    const text = fs.readFileSync(file, 'utf8');
    assert.match(text, /^# 2026-11-05\n/);
    assert.match(
      text,
      /\[2026-11-05 22:30\] user: lunch\?\n {2}second line\n {2}\[photo analysed\]\n {2}\[photo analysed\]/,
    );
    assert.match(text, /apollo: about 600 kcal/);
    assert.match(text, /apollo \(error, incomplete\): part/);
    assert.equal((text.match(/apollo/g) || []).length, 2, 'the running placeholder is skipped');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(path.dirname(file)), [`${c.id}.txt`]);
    assert.equal(fs.existsSync(path.join(dataDir, 'users', 'bob', 'transcripts', `${c.id}.txt`)), false);
    assert.equal(
      writeTranscript({
        dataDir,
        user: 'alice',
        store: s,
        conversationId: '00000000-0000-4000-8000-000000000000',
        timeZone: 'UTC',
      }),
      null,
    );
  } finally {
    reg.closeAll();
    rmDir(dataDir);
  }
});

test('prompt names exactly one user and never the other', () => {
  for (const [me, other] of [
    ['alice', 'bob'],
    ['bob', 'alice'],
  ]) {
    const p = buildPrompt({
      user: me,
      memoryRoot: '/path/to/memory',
      transcriptsDir: `/path/to/data/users/${me}/transcripts`,
      photoPaths: [`/path/to/data/users/${me}/tmp/run-12345678/a.jpg`],
      history: [
        { role: 'user', text: 'hi', photoCount: 1 },
        { role: 'assistant', text: 'hello', photoCount: 0 },
      ],
      text: 'what now?',
    });
    assert.ok(p.includes(`/path/to/memory/${me}/`));
    assert.ok(p.includes('a.jpg'));
    assert.equal(p.includes(other), false);
    assert.match(p, /user: hi\n {2}\[photo analysed\]\napollo: hello/);
    assert.ok(p.endsWith('Message:\nwhat now?'));
    assert.match(p, /BEFORE replying/);
    for (const f of ['persona.md', 'rules.md', 'MEMORY.md']) assert.ok(p.includes(`/path/to/memory/${f}`), f);
    assert.match(p, /Mailbox handling .* is not available in chat runs: skip it/);
    assert.match(p, /If a call is blocked, say so honestly/);
    assert.match(p, /must not stop the reply/);
  }
  const bare = buildPrompt({ user: 'alice', memoryRoot: '/m', transcriptsDir: '/t', text: 'x' });
  assert.equal(bare.includes('Attached photos'), false);
  const long = buildPrompt({
    user: 'alice',
    memoryRoot: '/m',
    transcriptsDir: '/t',
    history: [{ role: 'user', text: 'x'.repeat(5000), photoCount: 0 }],
    text: 'y',
  });
  assert.ok(long.includes('[...]'));
});

test('trigger detection', () => {
  const phrases = ['good morning', 'workout complete'];
  assert.equal(isTrigger('Good morning!', 0, phrases), true);
  assert.equal(isTrigger('my knee hurts', 0, phrases), false);
  assert.equal(isTrigger('my knee hurts', 1, phrases), true);
});

test('prompt opens with the local date and time in the configured zone', () => {
  const NY = 'America/New_York';
  const cases = [
    ['2026-11-06T00:14:00Z', NY, 'Thursday 2026-11-05, 19:14 (America/New_York)'],
    ['2026-11-05T04:30:00Z', NY, 'Wednesday 2026-11-04, 23:30 (America/New_York)'],
    ['2026-11-05T05:30:00Z', NY, 'Thursday 2026-11-05, 00:30 (America/New_York)'],
    // DST: spring forward 2026-03-08 (EST to EDT at 07:00Z), fall back 2026-11-01 (EDT to EST at 06:00Z).
    ['2026-03-08T06:59:00Z', NY, 'Sunday 2026-03-08, 01:59 (America/New_York)'],
    ['2026-03-08T07:00:00Z', NY, 'Sunday 2026-03-08, 03:00 (America/New_York)'],
    ['2026-03-09T03:59:00Z', NY, 'Sunday 2026-03-08, 23:59 (America/New_York)'],
    ['2026-03-09T04:00:00Z', NY, 'Monday 2026-03-09, 00:00 (America/New_York)'],
    ['2026-11-01T05:30:00Z', NY, 'Sunday 2026-11-01, 01:30 (America/New_York)'],
    ['2026-11-01T06:30:00Z', NY, 'Sunday 2026-11-01, 01:30 (America/New_York)'],
    ['2026-11-02T04:59:00Z', NY, 'Sunday 2026-11-01, 23:59 (America/New_York)'],
    ['2026-11-02T05:00:00Z', NY, 'Monday 2026-11-02, 00:00 (America/New_York)'],
    ['2026-11-06T00:14:00Z', 'UTC', 'Friday 2026-11-06, 00:14 (UTC)'],
  ];
  for (const [iso, zone, want] of cases)
    assert.equal(localClock(Date.parse(iso), zone), want, `${iso} ${zone}`);
  const base = { user: 'alice', memoryRoot: '/m', transcriptsDir: '/t', text: 'x' };
  const p = buildPrompt({ ...base, nowMs: Date.parse('2026-11-06T00:14:00Z'), timeZone: 'America/New_York' });
  assert.ok(
    p.startsWith('Current date and time for this user: Thursday 2026-11-05, 19:14 (America/New_York).'),
  );
  assert.match(p, /history\/YYYY\/MM\/DD/);
  assert.match(p, /Ignore any other date you are shown/);
  // Without a zone or clock the prompt still carries a date (UTC).
  assert.match(
    buildPrompt(base),
    /^Current date and time for this user: \w+ \d{4}-\d{2}-\d{2}, \d{2}:\d{2} \(UTC\)\./,
  );
});

test('prompt tells chat runs to skip /tmp, trailer lines and pathless globbing', () => {
  const p = buildPrompt({ user: 'alice', memoryRoot: '/m', transcriptsDir: '/t', text: 'x' });
  assert.match(p, /Do not list or clean \/tmp/);
  assert.match(p, /without `temp:` or `mail:` lines/);
  assert.match(p, /Never call Glob or Grep without a path inside your own folder/);
  assert.match(p, /prefer reading the specific day files/);
  assert.match(p, /only to satisfy a start-up checklist item/);
});
