import test from 'node:test';
import assert from 'node:assert/strict';
import { createStreamParser } from '../src/streamParser.js';

const textStart = () => ({
  type: 'stream_event',
  event: { type: 'content_block_start', content_block: { type: 'text' } },
});
const delta = (text) => ({
  type: 'stream_event',
  event: { type: 'content_block_delta', delta: { type: 'text_delta', text } },
});
const toolStart = (id) => ({
  type: 'stream_event',
  event: { type: 'content_block_start', content_block: { type: 'tool_use', id, name: 'Read' } },
});

// Replays lines through the parser and applies them the way the run manager does.
function run(lines) {
  const p = createStreamParser();
  let final = '';
  let lastInterim = '';
  const interims = [];
  for (const l of lines) {
    for (const ev of p.push(JSON.stringify(l))) {
      if (ev.kind === 'delta') final += ev.text;
      else if (ev.kind === 'interim') {
        interims.push(ev.text);
        lastInterim = ev.text;
        final = '';
      }
    }
  }
  return { final, lastInterim, interims };
}

test('a run with no tool calls keeps all text, blocks joined by a blank line', () => {
  const r = run([textStart(), delta('One'), textStart(), delta('Two')]);
  assert.equal(r.final, 'One\n\nTwo');
  assert.deepEqual(r.interims, []);
});

test('text before a tool call is interim, only the text after it is final', () => {
  const r = run([
    textStart(),
    delta('Pulling things together.'),
    toolStart('t1'),
    textStart(),
    delta('Answer'),
  ]);
  assert.equal(r.final, 'Answer');
  assert.deepEqual(r.interims, ['Pulling things together.']);
});

test('two tool calls with text between keep only the last block', () => {
  const r = run([
    textStart(),
    delta('First'),
    toolStart('t1'),
    textStart(),
    delta('Second'),
    toolStart('t2'),
    textStart(),
    delta('Final'),
  ]);
  assert.equal(r.final, 'Final');
  assert.deepEqual(r.interims, ['First', 'Second']);
});

test('a run ending in a tool call has no final text and exposes the last narration', () => {
  const r = run([textStart(), delta('Looking.'), toolStart('t1')]);
  assert.equal(r.final, '');
  assert.equal(r.lastInterim, 'Looking.');
});

test('a repeated tool_use for the same id does not emit a second interim', () => {
  const p = createStreamParser();
  const out = [
    textStart(),
    delta('Hi'),
    toolStart('t1'),
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Read' }] } },
  ].flatMap((l) => p.push(JSON.stringify(l)));
  assert.equal(out.filter((e) => e.kind === 'interim').length, 1);
  assert.equal(out.filter((e) => e.kind === 'tool').length, 1);
});
