import { formatText } from './format.js';
import { messageText } from './copy.js';

function inline(parent, parts) {
  for (const part of parts) {
    if (part.bold) {
      const b = document.createElement('strong');
      b.textContent = part.text;
      parent.append(b);
    } else {
      parent.append(document.createTextNode(part.text));
    }
  }
}

// Builds message content with textContent only; nothing is ever assigned through innerHTML.
export function renderBody(el, text) {
  el.replaceChildren();
  for (const block of formatText(text)) {
    if (block.type === 'ul') {
      const ul = document.createElement('ul');
      for (const item of block.items) {
        const li = document.createElement('li');
        inline(li, item);
        ul.append(li);
      }
      el.append(ul);
    } else if (block.type === 'heading') {
      const h = document.createElement(`h${block.level}`);
      inline(h, block.parts);
      el.append(h);
    } else if (block.type === 'table') {
      const wrap = document.createElement('div');
      wrap.className = 'table-wrap';
      const table = document.createElement('table');
      const thead = table.createTHead().insertRow();
      for (const cell of block.header) inline(thead.appendChild(document.createElement('th')), cell);
      const tbody = table.createTBody();
      for (const row of block.rows) {
        const tr = tbody.insertRow();
        for (const cell of row) inline(tr.insertCell(), cell);
      }
      wrap.append(table);
      el.append(wrap);
    } else {
      const p = document.createElement('p');
      block.lines.forEach((line, i) => {
        if (i) p.append(document.createElement('br'));
        inline(p, line);
      });
      el.append(p);
    }
  }
}

// Two overlapping sheets, built with DOM calls only (no innerHTML).
function copyIcon() {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const back = document.createElementNS(ns, 'path');
  back.setAttribute('d', 'M15 8V6.5A1.5 1.5 0 0 0 13.5 5h-7A1.5 1.5 0 0 0 5 6.5v7A1.5 1.5 0 0 0 6.5 15H8');
  const front = document.createElementNS(ns, 'rect');
  front.setAttribute('x', '9');
  front.setAttribute('y', '9');
  front.setAttribute('width', '10');
  front.setAttribute('height', '10');
  front.setAttribute('rx', '1.8');
  svg.append(back, front);
  return svg;
}

// One turn = the message (`.msg`, the bubble for the person's turn) plus, beneath it and outside it, a row
// of actions. The wrapper owns the alignment; the streaming placeholder uses the same wrapper.
export function turnEl(role) {
  const turn = document.createElement('div');
  turn.className = `turn ${role === 'user' ? 'user' : 'apollo'}`;
  return turn;
}

export function messageEl(m, onCopy) {
  const turn = turnEl(m.role);
  turn.dataset.id = m.id;
  const el = document.createElement('div');
  el.className = `msg ${m.role === 'user' ? 'user' : 'apollo'}`;
  el.dataset.id = m.id;
  for (let i = 0; i < (m.photoCount || 0); i++) {
    const chip = document.createElement('span');
    chip.className = 'photo-chip';
    chip.textContent = 'photo analysed';
    el.append(chip);
  }
  const body = document.createElement('div');
  body.className = 'body';
  renderBody(body, m.text || '');
  el.append(body);
  turn.append(el);
  if (onCopy && messageText(m)) {
    const actions = document.createElement('div');
    actions.className = 'msg-actions';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'icon-btn copy-btn';
    btn.setAttribute('aria-label', `Copy ${m.role === 'user' ? 'your' : "Apollo's"} message`);
    btn.title = 'Copy';
    btn.append(copyIcon());
    btn.addEventListener('click', () => onCopy(messageText(m)));
    actions.append(btn);
    turn.append(actions);
  }
  return turn;
}
