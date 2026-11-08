import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// A minimal DOM with tables, enough for renderBody.
class Node {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.className = '';
    this.textContent = '';
  }
  append(...kids) {
    this.children.push(...kids);
  }
  appendChild(k) {
    this.children.push(k);
    return k;
  }
  replaceChildren() {
    this.children = [];
  }
  createTHead() {
    const head = new Node('thead');
    this.append(head);
    head.insertRow = () => {
      const r = new Node('tr');
      head.append(r);
      return r;
    };
    return head;
  }
  createTBody() {
    const body = new Node('tbody');
    this.append(body);
    body.insertRow = () => {
      const r = new Node('tr');
      r.insertCell = () => {
        const c = new Node('td');
        r.append(c);
        return c;
      };
      body.append(r);
      return r;
    };
    return body;
  }
  find(tag, out = []) {
    for (const c of this.children) {
      if (c.tag === tag) out.push(c);
      c.find(tag, out);
    }
    return out;
  }
  text() {
    return this.textContent + this.children.map((c) => c.text()).join('');
  }
}
globalThis.document = {
  createElement: (t) => new Node(t),
  createTextNode: (t) => Object.assign(new Node('#text'), { textContent: t }),
};
const { dateLabel, fileLabel, fileCount, firstFile, emptyPaging, applyPage, errorText } =
  await import('../public/js/dayfiles.js');
const { renderBody } = await import('../public/js/render.js');

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('date labels give weekday, day and month, and add the year only when it differs', () => {
  assert.equal(dateLabel('2026-11-05', 2026), 'Thursday 5 November');
  assert.equal(dateLabel('2026-01-01', 2026), 'Thursday 1 January');
  assert.equal(dateLabel('2025-12-30', 2026), 'Tuesday 30 December 2025');
  assert.equal(dateLabel('2024-02-29', 2026), 'Thursday 29 February 2024');
  assert.equal(dateLabel('not a date'), 'not a date');
});

test('file labels drop the extension; counts and the first file follow the list', () => {
  assert.equal(fileLabel('morning.md'), 'morning');
  assert.equal(fileLabel('a_b-1.md'), 'a_b-1');
  assert.equal(fileCount(['a.md']), '1 file');
  assert.equal(fileCount(['a.md', 'b.md']), '2 files');
  assert.equal(firstFile(['morning.md', 'day.md']), 'day.md');
  assert.equal(firstFile(['morning.md', 'notes.md']), 'morning.md');
});

test('paging appends older pages in order, never lists a date twice and follows the cursor', () => {
  const d = (date) => ({ date, files: ['day.md'] });
  let s = emptyPaging();
  assert.deepEqual(s, { days: [], next: null, loaded: false });
  s = applyPage(s, { days: [d('2026-11-05'), d('2026-11-04')], next: '2026-11-04' });
  assert.equal(s.next, '2026-11-04');
  assert.equal(s.loaded, true);
  s = applyPage(s, { days: [d('2026-11-04'), d('2026-11-03')], next: null });
  assert.deepEqual(
    s.days.map((x) => x.date),
    ['2026-11-05', '2026-11-04', '2026-11-03'],
  );
  assert.equal(s.next, null);
  const e = applyPage(emptyPaging(), { days: [], next: null });
  assert.deepEqual(e, { days: [], next: null, loaded: true });
});

test('error wording is neutral and offline-aware', () => {
  assert.equal(errorText(503), 'Daily logs are not available right now.');
  assert.equal(errorText(502), 'Daily logs are not available right now.');
  assert.equal(errorText(undefined), 'Daily logs are not available right now.');
  assert.equal(errorText(404), 'That file is no longer there.');
  assert.equal(errorText(413), 'That file is too large to show here.');
  assert.equal(errorText(503, false), 'Daily logs are not available offline.');
});

test('day text renders headings, bullets, bold and a pipe table through the chat renderer', () => {
  const el = new Node('div');
  renderBody(
    el,
    '# Check-in\n\nSlept **well**.\n\n- one\n- two\n\n| Meal | Calories |\n|---|---|\n| Oats | 520 |\n| Rice | 680 |\n',
  );
  assert.deepEqual(
    el.children.map((c) => c.tag),
    ['h3', 'p', 'ul', 'div'],
  );
  assert.equal(el.children[3].className, 'table-wrap');
  const table = el.children[3].find('table')[0];
  assert.equal(table.find('th').length, 2);
  assert.equal(table.find('td').length, 4);
  assert.equal(table.text(), 'MealCaloriesOats520Rice680');
});

test('markup in a day file is shown as text, never built into elements', () => {
  const el = new Node('div');
  renderBody(el, '<img src=x onerror=alert(1)>\n\n<script>alert(1)</script>');
  assert.deepEqual(
    el.children.map((c) => c.tag),
    ['p', 'p'],
  );
  assert.ok(el.text().includes('<script>'));
});

test('the Daily logs screen is read-only and keeps day content out of storage', () => {
  const src = read('public/js/dayfiles.js').replace(/\/\/.*$/gm, '');
  for (const bad of [
    'innerHTML',
    'localStorage',
    'sessionStorage',
    'indexedDB',
    'caches',
    "'POST'",
    "'PUT'",
    "'DELETE'",
    "'PATCH'",
  ])
    assert.equal(src.includes(bad), false, bad);
  const html = read('public/index.html');
  assert.match(html, /id="open-logs"[^>]*>Daily logs</);
  assert.ok(html.indexOf('id="open-logs"') < html.indexOf('id="copy-chat"'));
  assert.ok(html.indexOf('id="copy-chat"') < html.indexOf('id="delete-all"'));
  const api = read('public/js/api.js');
  for (const line of api.split('\n').filter((l) => l.includes('/api/dayfile')))
    assert.ok(!/DELETE|POST|PUT|PATCH/.test(line), line);
});
