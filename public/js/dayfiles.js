// "Daily logs": a read-only screen for the signed-in user's own day files. This module holds the pure helpers
// (date label, file label, paging state, error wording) and createDailyLogs, the DOM controller. File text is
// rendered through renderBody (textContent only) and is never stored by the page, the service worker or
// anything else beyond what is on screen.
import { renderBody } from './render.js';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

// "Thursday 5 November", with the year added when it is not the current one. The date is a plain calendar
// date, so no time zone is involved.
export function dateLabel(date, currentYear = new Date().getFullYear()) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return date;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const wd = WEEKDAYS[new Date(Date.UTC(y, mo - 1, d)).getUTCDay()];
  return `${wd} ${d} ${MONTHS[mo - 1]}${y === currentYear ? '' : ` ${y}`}`;
}

export const fileLabel = (name) => name.replace(/\.md$/, '');
export const fileCount = (files) => `${files.length} ${files.length === 1 ? 'file' : 'files'}`;
// The file shown first for a day: `day.md` when present, else the first one.
export const firstFile = (files) => (files.includes('day.md') ? 'day.md' : files[0]);

// Paging state for the date list: pages are appended in order, a date is never listed twice and `next` is the
// cursor for older days (null when there are none).
export const emptyPaging = () => ({ days: [], next: null, loaded: false });
export function applyPage(state, page) {
  const seen = new Set(state.days.map((d) => d.date));
  const days = state.days.concat(page.days.filter((d) => !seen.has(d.date)));
  return { days, next: page.next || null, loaded: true };
}

// Neutral wording for every failure; nothing from the server is shown.
export function errorText(status, online = true) {
  if (!online) return 'Daily logs are not available offline.';
  if (status === 404) return 'That file is no longer there.';
  if (status === 413) return 'That file is too large to show here.';
  return 'Daily logs are not available right now.';
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

// Controls the screen. `root` holds the date list and the day view; the page chrome (header title, back and
// menu buttons, the chat area) is switched by the caller-provided show/hide hooks so the chat, its draft and
// any running reply stay untouched underneath.
export function createDailyLogs({ root, api, chrome, doc = document, win = window }) {
  let paging = emptyPaging();
  let day = null; // { date, files, file }
  let isOpen = false;
  let token = 0;

  const list = el('ul', 'log-list');
  const more = el('button', 'older', 'Load older');
  const message = el('p', 'log-note');
  const dayView = el('div', 'log-day');
  const dayTitle = el('h2', 'day-title');
  const tabs = el('div', 'file-tabs');
  const text = el('div', 'msg apollo day-text');
  const body = el('div', 'body');
  text.append(body);
  const dayNote = el('p', 'log-note');
  dayView.append(dayTitle, tabs, dayNote, text);
  more.type = 'button';
  root.append(list, more, message, dayView);

  const online = () => navigator.onLine !== false;

  function showList() {
    token++;
    day = null;
    dayView.hidden = true;
    list.hidden = false;
    renderList();
  }

  function renderList() {
    list.replaceChildren();
    for (const d of paging.days) {
      const li = el('li');
      const b = el('button', 'log-row');
      b.type = 'button';
      b.append(el('span', 'when', dateLabel(d.date)), el('span', 'count', fileCount(d.files)));
      b.addEventListener('click', () => openDay(d));
      li.append(b);
      list.append(li);
    }
    more.hidden = !paging.next;
    if (paging.loaded && paging.days.length === 0 && !message.textContent)
      message.textContent = 'No daily logs yet.';
  }

  async function loadPage() {
    const mine = ++token;
    message.textContent = '';
    more.disabled = true;
    try {
      const page = await api.dayfiles(paging.next || undefined);
      if (mine !== token || !isOpen) return;
      paging = applyPage(paging, page);
    } catch (e) {
      if (mine !== token || !isOpen) return;
      message.textContent = errorText(e?.status, online());
    } finally {
      more.disabled = false;
    }
    renderList();
  }

  async function loadFile(name) {
    const mine = ++token;
    day.file = name;
    dayNote.textContent = '';
    body.replaceChildren();
    renderTabs();
    try {
      const out = await api.dayfile(day.date, name);
      if (mine !== token || !isOpen) return;
      renderBody(body, out.text);
    } catch (e) {
      if (mine !== token || !isOpen) return;
      dayNote.textContent = errorText(e?.status, online());
    }
  }

  function renderTabs() {
    tabs.replaceChildren();
    tabs.hidden = day.files.length < 2;
    for (const f of day.files) {
      const b = el('button', 'file-tab', fileLabel(f));
      b.type = 'button';
      b.setAttribute('aria-pressed', String(f === day.file));
      b.addEventListener('click', () => f !== day.file && loadFile(f));
      tabs.append(b);
    }
  }

  function openDay(d) {
    win.history.pushState({ logs: 'day' }, '');
    day = { date: d.date, files: d.files, file: null };
    dayTitle.textContent = dateLabel(d.date);
    list.hidden = true;
    more.hidden = true;
    message.textContent = '';
    dayView.hidden = false;
    loadFile(firstFile(d.files));
    chrome.focusBack();
  }

  function open() {
    if (isOpen) return;
    isOpen = true;
    win.history.pushState({ logs: 'list' }, '');
    paging = emptyPaging();
    message.textContent = '';
    chrome.show();
    showList();
    loadPage();
    chrome.focusBack();
  }

  function leave() {
    if (!isOpen) return;
    isOpen = false;
    token++;
    day = null;
    list.replaceChildren();
    body.replaceChildren();
    paging = emptyPaging();
    chrome.hide();
  }

  // The back control, Escape and the phone's back gesture all end up here: one step back in the history.
  const back = () => isOpen && win.history.back();
  win.addEventListener('popstate', (e) => {
    const kind = e.state?.logs;
    if (!kind) return leave();
    if (!isOpen) return;
    if (kind === 'day' && day) return;
    showList();
  });
  doc.addEventListener('keydown', (e) => {
    if (isOpen && e.key === 'Escape') {
      e.preventDefault();
      back();
    }
  });
  more.addEventListener('click', () => loadPage());

  // A reload keeps the history entry of the screen it happened on; the page itself starts in the chat.
  if (win.history.state?.logs) win.history.replaceState(null, '');

  return { open, back, isOpen: () => isOpen };
}
