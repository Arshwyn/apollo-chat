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

test('headings map to two display levels and keep bold', () => {
  const blocks = formatText('# One\n## Two\n### Three **x**\n#### Four\n##### Five\n#NoSpace');
  assert.deepEqual(
    blocks.map((b) => b.type + (b.level || '')),
    ['heading3', 'heading3', 'heading4', 'heading4', 'p'],
  );
  assert.equal(blocks[2].parts[1].bold, true);
  assert.equal(blocks[2].parts[1].text, 'x');
  assert.equal(blocks[4].lines.length, 2, '5 hashes and no-space hashes stay plain text');
});

test('pipe tables parse into header and padded rows with bold cells', () => {
  const blocks = formatText('Intro\n\n| Day | Kcal |\n|---|:--:|\n| Mon | **2100** |\n| Tue |\n\nAfter');
  assert.deepEqual(
    blocks.map((b) => b.type),
    ['p', 'table', 'p'],
  );
  const t = blocks[1];
  assert.equal(t.header.length, 2);
  assert.equal(t.rows.length, 2);
  assert.equal(t.rows[0][1][0].bold, true);
  assert.deepEqual(t.rows[1][1], [{ text: '', bold: false }]);
});

test('a pipe line without a separator row is plain text', () => {
  assert.deepEqual(
    formatText('a | b\nc | d').map((b) => b.type),
    ['p'],
  );
});

test('HTML in message text is only ever data, in every block type', () => {
  const evil = '<script>alert(1)</script><img src=x onerror=alert(1)>';
  const text = `# ${evil}\n\n${evil}\n\n- ${evil}\n\n| ${evil} | b |\n|---|---|\n| ${evil} | **${evil}** |`;
  const strings = [];
  const walk = (v) => {
    if (typeof v === 'string') strings.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  const blocks = formatText(text);
  walk(blocks);
  assert.deepEqual(
    blocks.map((b) => b.type),
    ['heading', 'p', 'ul', 'table'],
  );
  assert.ok(strings.some((s) => s.includes('<script>')));
  // Only the whitelisted structural keys exist; there is no html/markup field to be rendered.
  const keys = new Set();
  const keyWalk = (v) => {
    if (Array.isArray(v)) v.forEach(keyWalk);
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) (keys.add(k), keyWalk(x));
  };
  keyWalk(blocks);
  assert.deepEqual([...keys].sort(), [
    'bold',
    'header',
    'items',
    'level',
    'lines',
    'parts',
    'rows',
    'text',
    'type',
  ]);
});

test('the renderer never uses innerHTML or other HTML sinks', async () => {
  const fs = await import('node:fs');
  for (const f of ['render.js', 'format.js', 'app.js']) {
    const src = fs.readFileSync(new URL(`../public/js/${f}`, import.meta.url), 'utf8');
    const code = src
      .split('\n')
      .filter((l) => !l.trim().startsWith('//'))
      .join('\n');
    assert.doesNotMatch(code, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  }
});
