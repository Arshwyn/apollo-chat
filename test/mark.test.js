import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const header = /<svg class="mark"[\s\S]*?<\/svg>/.exec(read('public/index.html'))[0];

test('header mark is a laurel wreath of 2x8 leaves around one A, with no sun remnant', () => {
  assert.doesNotMatch(header, /<circle|<line/);
  assert.equal(header.match(/<ellipse /g).length, 16);
  assert.equal(header.match(/<path\b/g).length, 1);
  assert.match(header, /aria-hidden="true"/);
  assert.match(header, /focusable="false"/);
});

test('header mark carries no raw colours; colour comes from the tokens in CSS', () => {
  assert.doesNotMatch(header, /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
  assert.doesNotMatch(header, /\b(fill|stroke)="(?!none)/);
});

test('header A path is the one traced constant in the icon script', () => {
  const script = read('scripts/make-icons.mjs');
  const traced = /A_PATH =\s*'([^']+)'/.exec(script)[1];
  const inline = /<path[^>]*\sd="([^"]+)"/.exec(header)[1];
  assert.equal(inline, traced);
});

test('icon script draws the same 16 leaves and keeps the wreath motif only', () => {
  const script = read('scripts/make-icons.mjs');
  assert.doesNotMatch(script, /sun/i);
  assert.match(script, /i < 8/);
  assert.match(script, /\[-1, 1\]/);
});
