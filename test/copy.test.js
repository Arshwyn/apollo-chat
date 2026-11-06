import test from 'node:test';
import assert from 'node:assert/strict';
import { conversationToText, messageText, copyText } from '../public/js/copy.js';

test('conversation text uses role labels, keeps markdown and skips empty messages', () => {
  const text = conversationToText([
    { role: 'user', text: 'What should I eat?', photoCount: 1 },
    { role: 'assistant', text: '### Plan\n\n- **Protein** first\n\n| a | b |\n| - | - |\n| 1 | 2 |' },
    { role: 'user', text: '', photoCount: 2 },
    { role: 'assistant', text: '   ', status: 'error' },
    { role: 'user', text: '  Thanks  ' },
  ]);
  assert.equal(
    text,
    'You: What should I eat?\n\nApollo: ### Plan\n\n- **Protein** first\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\nYou: Thanks',
  );
  assert.equal(text.includes('photo'), false);
  assert.equal(conversationToText([]), '');
  assert.equal(conversationToText(undefined), '');
});

test('message text is the stored source, trimmed, never markup', () => {
  assert.equal(messageText({ text: ' **hi** ' }), '**hi**');
  assert.equal(messageText({ text: null }), '');
  assert.equal(messageText(undefined), '');
});

test('copyText prefers the clipboard API and falls back to a hidden textarea', async () => {
  const written = [];
  const nav = { clipboard: { writeText: async (t) => written.push(t) } };
  assert.equal(await copyText('a', { navigator: nav, document: undefined }), true);
  assert.deepEqual(written, ['a']);

  const events = [];
  const ta = {
    style: {},
    setAttribute() {},
    focus: () => events.push('focus'),
    select: () => events.push('select'),
    setSelectionRange: () => {},
    remove: () => events.push('remove'),
  };
  const doc = {
    createElement: () => ta,
    body: { append: () => events.push('append') },
    activeElement: null,
    execCommand: (c) => (events.push(c), true),
  };
  const failing = { clipboard: { writeText: async () => Promise.reject(new Error('denied')) } };
  assert.equal(await copyText('b', { navigator: failing, document: doc }), true);
  assert.equal(ta.value, 'b');
  assert.deepEqual(events, ['append', 'focus', 'select', 'copy', 'remove']);
  assert.equal(await copyText('c', { navigator: {}, document: { ...doc, execCommand: () => false } }), false);
  assert.equal(await copyText('d', { navigator: {}, document: undefined }), false);
});
