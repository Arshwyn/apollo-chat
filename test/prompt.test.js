import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPrompt } from '../src/prompt.js';

const base = {
  user: 'alice',
  memoryRoot: '/path/to/memory',
  transcriptsDir: '/path/to/transcripts',
  text: 'hello',
  nowMs: Date.parse('2026-11-05T10:00:00Z'),
  timeZone: 'UTC',
};

test('the photo instruction states retention accurately and keeps the write-before-reply rule', () => {
  const p = buildPrompt({ ...base, photoPaths: ['/path/to/tmp/run-1/photo-1.jpg'] });
  assert.match(p, /Attached photos are temporary/);
  assert.match(p, /removed after a successful run/);
  assert.match(p, /after the retention window if the run fails or is cancelled/);
  assert.ok(!p.includes('deleted when this run ends'));
  assert.ok(!/\d+\s*(h|hours)\b/i.test(p.split('Attached photos are temporary')[1].split('\n')[0]));
  assert.match(p, /BEFORE replying/);
  assert.match(p, /\/path\/to\/tmp\/run-1\/photo-1\.jpg/);
});

test('without photos the prompt has no photo instruction', () => {
  assert.ok(!buildPrompt(base).includes('Attached photos'));
});
