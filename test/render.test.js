import test from 'node:test';
import assert from 'node:assert/strict';

// A minimal DOM: just enough for messageEl (no tables, no innerHTML).
class Node {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.attrs = {};
    this.dataset = {};
    this.handlers = {};
    this.className = '';
    this.textContent = '';
    this.parent = null;
  }
  append(...kids) {
    for (const k of kids) {
      k.parent = this;
      this.children.push(k);
    }
  }
  replaceChildren() {
    this.children = [];
  }
  setAttribute(k, v) {
    this.attrs[k] = v;
  }
  addEventListener(type, fn) {
    this.handlers[type] = fn;
  }
  click() {
    this.handlers.click();
  }
  find(pred, out = []) {
    for (const c of this.children) {
      if (pred(c)) out.push(c);
      c.find(pred, out);
    }
    return out;
  }
  text() {
    return this.textContent + this.children.map((c) => c.text()).join('');
  }
}
globalThis.document = {
  createElement: (t) => new Node(t),
  createElementNS: (ns, t) => new Node(t),
  createTextNode: (t) => Object.assign(new Node('#text'), { textContent: t }),
};
const { messageEl } = await import('../public/js/render.js');

const hasClass = (n, c) => n.className.split(' ').includes(c);

test('a message is a turn wrapper holding the bubble and an icon-only copy button outside it', () => {
  const copied = [];
  const turn = messageEl({ id: 7, role: 'user', text: 'hello **there**' }, (t) => copied.push(t));
  assert.ok(hasClass(turn, 'turn') && hasClass(turn, 'user'));
  assert.equal(turn.dataset.id, 7);
  const [msg, actions] = turn.children;
  assert.ok(hasClass(msg, 'msg') && hasClass(msg, 'user'));
  assert.equal(msg.dataset.id, 7, 'the message keeps its id');
  assert.ok(hasClass(actions, 'msg-actions'));
  const btn = actions.children[0];
  assert.equal(btn.tag, 'button');
  assert.equal(btn.type, 'button');
  assert.equal(btn.attrs['aria-label'], 'Copy your message');
  assert.ok(btn.children.some((c) => c.tag === 'svg'));
  assert.equal(btn.text(), '', 'no text in the button');
  assert.equal(msg.find((n) => n === btn).length, 0, 'the button is not inside the bubble');
  btn.click();
  assert.deepEqual(copied, ['hello **there**'], 'the stored source text is copied');
});

test('the coach turn is labelled for Apollo and left aligned by class', () => {
  const turn = messageEl({ id: 8, role: 'assistant', text: 'Reply' }, () => {});
  assert.ok(hasClass(turn, 'apollo'));
  assert.equal(turn.children[1].children[0].attrs['aria-label'], "Copy Apollo's message");
});

test('no copy control without text or without a callback', () => {
  assert.equal(messageEl({ id: 1, role: 'assistant', text: '' }, () => {}).children.length, 1);
  assert.equal(messageEl({ id: 2, role: 'user', text: 'x' }).children.length, 1);
});
