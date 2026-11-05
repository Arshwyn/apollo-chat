import test from 'node:test';
import assert from 'node:assert/strict';
import { SseParser } from '../public/js/sse.js';
import { formatText, parseInline } from '../public/js/format.js';

test('SSE parser handles chunk splits, multiple events and junk', () => {
  const p = new SseParser();
  assert.deepEqual(p.push('event: delta\ndata: {"text":"Hel'), []);
  const out = p.push('lo"}\n\nevent: done\ndata: {"status":"done"}\n\n: comment\n\nevent: x\ndata: nope\n\n');
  assert.deepEqual(out, [
    { event: 'delta', data: { text: 'Hello' } },
    { event: 'done', data: { status: 'done' } },
  ]);
  assert.deepEqual(p.push('data: {"a":1}\n\n'), [{ event: 'message', data: { a: 1 } }]);
});

test('inline parser splits bold and leaves everything else as text', () => {
  assert.deepEqual(parseInline('a **b** c'), [
    { text: 'a ', bold: false },
    { text: 'b', bold: true },
    { text: ' c', bold: false },
  ]);
  assert.deepEqual(parseInline('<script>alert(1)</script>'), [
    { text: '<script>alert(1)</script>', bold: false },
  ]);
  assert.deepEqual(parseInline(''), [{ text: '', bold: false }]);
});

test('format groups paragraphs and bullets and never produces markup', () => {
  const blocks = formatText('Intro line\nsecond line\n\n- one\n- **two**\n\nEnd');
  assert.deepEqual(
    blocks.map((b) => b.type),
    ['p', 'ul', 'p'],
  );
  assert.equal(blocks[0].lines.length, 2);
  assert.equal(blocks[1].items.length, 2);
  assert.equal(blocks[1].items[1][0].bold, true);
  assert.deepEqual(formatText(''), []);
});
