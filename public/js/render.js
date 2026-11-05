import { formatText } from './format.js';

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

export function messageEl(m) {
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
  return el;
}
