import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createDrawer } from '../public/js/drawer.js';

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

function fakeEl(name, log) {
  const handlers = {};
  return {
    name,
    hidden: true,
    inert: false,
    addEventListener: (type, fn) => (handlers[type] = fn),
    fire: (type, ev = {}) => handlers[type]?.(ev),
    focus: () => log.push(name),
  };
}

function setup() {
  const log = [];
  const doc = fakeEl('doc', log);
  const parts = Object.fromEntries(
    ['drawer', 'scrim', 'opener', 'closeButton', 'bar', 'messages'].map((n) => [n, fakeEl(n, log)]),
  );
  parts.opener.hidden = false;
  const d = createDrawer({
    drawer: parts.drawer,
    scrim: parts.scrim,
    opener: parts.opener,
    closeButton: parts.closeButton,
    background: [parts.bar, parts.messages],
    doc,
  });
  return { d, doc, log, ...parts };
}

test('opening shows drawer and scrim together, makes the page behind inert and focuses the drawer', () => {
  const t = setup();
  t.opener.fire('click');
  assert.equal(t.d.isOpen(), true);
  assert.equal(t.drawer.hidden, false);
  assert.equal(t.scrim.hidden, false);
  assert.equal(t.bar.inert && t.messages.inert, true);
  assert.deepEqual(t.log, ['closeButton']);
});

test('the scrim, the close button, Escape and close() all close and return focus to the opener', () => {
  for (const how of [
    (t) => t.scrim.fire('click'),
    (t) => t.closeButton.fire('click'),
    (t) => t.doc.fire('keydown', { key: 'Escape', preventDefault() {} }),
    (t) => t.d.close(),
  ]) {
    const t = setup();
    t.opener.fire('click');
    t.log.length = 0;
    how(t);
    assert.equal(t.d.isOpen(), false);
    assert.equal(t.drawer.hidden, true);
    assert.equal(t.scrim.hidden, true);
    assert.equal(t.bar.inert || t.messages.inert, false);
    assert.deepEqual(t.log, ['opener']);
  }
});

test('Escape and other keys do nothing while the drawer is closed or for keys other than Escape', () => {
  const t = setup();
  let prevented = 0;
  const key = (k) => t.doc.fire('keydown', { key: k, preventDefault: () => prevented++ });
  key('Escape');
  assert.equal(prevented, 0, 'closed: Escape is left to the page');
  assert.deepEqual(t.log, []);
  t.opener.fire('click');
  key('Enter');
  key('Tab');
  assert.equal(t.d.isOpen(), true);
  key('Escape');
  assert.equal(t.d.isOpen(), false);
  assert.equal(prevented, 1);
});

test('closing twice or opening twice does not repeat focus changes', () => {
  const t = setup();
  t.d.close();
  assert.deepEqual(t.log, []);
  t.d.open();
  t.d.open();
  assert.deepEqual(t.log, ['closeButton']);
});

test('the page has the scrim and a dialog-like drawer wired to the script', () => {
  const html = read('public/index.html');
  assert.match(html, /<div id="scrim" aria-hidden="true" hidden><\/div>/);
  assert.match(html, /<aside id="drawer" role="dialog" aria-modal="true" aria-label="Chats" hidden>/);
  assert.ok(
    html.indexOf('id="scrim"') < html.indexOf('id="drawer"'),
    'scrim is the drawer sibling before it',
  );
  assert.ok(!/<[^>]*id="scrim"[^>]*(tabindex|href)/.test(html), 'the scrim is not focusable');
  const css = read('public/style.css');
  assert.match(/#scrim \{[^}]*\}/.exec(css)[0], /background: var\(--scrim\)/);
  const z = (id) => Number(new RegExp(`${id} \\{[^}]*z-index: (\\d+)`).exec(css)[1]);
  assert.ok(z('#scrim') < z('#drawer'));
  const app = read('public/js/app.js');
  assert.match(app, /createDrawer\(/);
  assert.ok(!app.includes('drawer.hidden'), 'app code never toggles the drawer directly');
});
