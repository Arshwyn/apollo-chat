import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createEmbedSignal, STATES } from '../public/js/embed.js';

function fakeWin(framed = true) {
  const sent = [];
  const win = { parent: framed ? { postMessage: (m, o) => sent.push([m, o]) } : null };
  if (!framed) win.parent = win;
  return { win, sent };
}

test('inert when not framed, when no parent origin is configured or when it is a wildcard', () => {
  for (const [origin, framed] of [
    ['https://hub.example.com', false],
    [undefined, true],
    ['', true],
    ['*', true],
  ]) {
    const { win, sent } = fakeWin(framed);
    const s = createEmbedSignal(origin, win);
    assert.equal(s.active, false);
    s.ready();
    s.state('thinking');
    assert.deepEqual(sent, []);
  }
});

test('posts only ready and the three states, to the exact origin, without repeats', () => {
  const { win, sent } = fakeWin();
  const s = createEmbedSignal('https://hub.example.com', win);
  assert.equal(s.active, true);
  s.ready();
  s.state('thinking');
  s.state('thinking');
  s.state('speaking');
  s.state('bogus');
  s.state('<script>');
  s.state(undefined);
  s.state('idle');
  assert.deepEqual(sent, [
    [{ type: 'apollo-ready' }, 'https://hub.example.com'],
    [{ type: 'apollo-state', state: 'thinking' }, 'https://hub.example.com'],
    [{ type: 'apollo-state', state: 'speaking' }, 'https://hub.example.com'],
    [{ type: 'apollo-state', state: 'idle' }, 'https://hub.example.com'],
  ]);
  assert.deepEqual(STATES, ['idle', 'thinking', 'speaking']);
  for (const [, origin] of sent) assert.notEqual(origin, '*');
});

test('a throwing parent never breaks the app', () => {
  const win = {
    parent: {
      postMessage() {
        throw new Error('gone');
      },
    },
  };
  const s = createEmbedSignal('https://hub.example.com', win);
  assert.doesNotThrow(() => s.ready());
});

test('the module carries no wildcard target, no listener and nothing but the fixed shapes', () => {
  const src = fs.readFileSync(new URL('../public/js/embed.js', import.meta.url), 'utf8');
  assert.equal(/postMessage\([^)]*['"]\*['"]/.test(src), false);
  assert.equal(/addEventListener|onmessage/.test(src), false);
  const app = fs.readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
  const calls = [...app.matchAll(/signal\.(?:ready|state)\(([^)]*)\)/g)].map((m) => m[1]);
  assert.deepEqual(calls, ["busy ? 'thinking' : 'idle'", "'speaking'", '']);
});
