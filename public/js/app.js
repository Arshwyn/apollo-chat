import { api, ApiError } from './api.js';
import { messageEl, renderBody, turnEl } from './render.js';
import { conversationToText, copyText } from './copy.js';
import { createDrawer } from './drawer.js';
import { createStagedPhotos } from './staged.js';

// Photo limits come from the server (GET /api/me) so there is one place to change them.
let limits = null;
const $ = (id) => document.getElementById(id);
const els = {
  title: $('title'),
  messages: $('messages'),
  status: $('status'),
  input: $('input'),
  send: $('send-btn'),
  cancel: $('cancel-btn'),
  form: $('composer'),
  file: $('file'),
  attach: $('attach-btn'),
  previews: $('previews'),
  list: $('chat-list'),
  offline: $('offline'),
  toast: $('toast'),
};

const drawer = createDrawer({
  drawer: $('drawer'),
  scrim: $('scrim'),
  opener: $('menu-btn'),
  closeButton: $('close-drawer'),
  background: ['bar', 'offline', 'messages', 'status', 'composer'].map($),
});

const staged = createStagedPhotos({ api });
const state = { conv: null, convs: [], busy: false, oldest: null, poll: null };

function note(text, cls = '') {
  const n = document.createElement('div');
  n.className = `note ${cls}`.trim();
  n.textContent = text;
  els.messages.append(n);
  return n;
}

let toastTimer = null;
// Brief visible feedback; the element is an aria-live status region so screen readers announce it too.
function toast(text) {
  clearTimeout(toastTimer);
  els.toast.textContent = text;
  toastTimer = setTimeout(() => (els.toast.textContent = ''), 1800);
}

async function copyWithFeedback(text) {
  toast((await copyText(text)) ? 'Copied' : 'Could not copy');
}

async function copyConversation() {
  if (!state.conv) return;
  drawer.close();
  try {
    // Page back through the whole chat, not just the part currently on screen.
    let all = [];
    let before;
    for (;;) {
      const data = await api.messages(state.conv.id, before);
      all = data.messages.concat(all);
      if (data.messages.length < 50) break;
      before = data.messages[0].seq;
    }
    const text = conversationToText(all);
    if (!text) return toast('Nothing to copy');
    await copyWithFeedback(text);
  } catch {
    toast('Could not copy');
  }
}

function nearBottom() {
  const m = els.messages;
  return m.scrollHeight - m.scrollTop - m.clientHeight < 80;
}
function toBottom() {
  els.messages.scrollTop = els.messages.scrollHeight;
}

function setBusy(busy, label = '') {
  state.busy = busy;
  els.send.disabled = busy;
  els.send.hidden = busy;
  els.cancel.hidden = !busy;
  els.status.hidden = !label;
  els.status.textContent = label;
  els.input.placeholder = busy ? 'Apollo is still replying' : 'Message Apollo';
}

async function loadConversations() {
  state.convs = (await api.conversations()).conversations;
  renderList();
}

function renderList() {
  els.list.replaceChildren();
  for (const c of state.convs) {
    const li = document.createElement('li');
    if (state.conv && c.id === state.conv.id) li.className = 'current';
    const open = document.createElement('button');
    open.className = 'open';
    open.type = 'button';
    open.textContent = c.title;
    open.addEventListener('click', () => openConversation(c.id));
    const ren = document.createElement('button');
    ren.className = 'small';
    ren.type = 'button';
    ren.textContent = 'Rename';
    ren.addEventListener('click', () => renameConversation(c));
    const del = document.createElement('button');
    del.className = 'small danger';
    del.type = 'button';
    del.textContent = 'Delete';
    del.addEventListener('click', () => deleteConversation(c));
    li.append(open, ren, del);
    els.list.append(li);
  }
}

async function renameConversation(c) {
  const title = window.prompt('Chat name', c.title);
  if (title === null) return;
  try {
    await api.rename(c.id, title);
    if (state.conv && state.conv.id === c.id) els.title.textContent = title.trim();
    await loadConversations();
  } catch {
    window.alert('Could not rename (1 to 80 characters).');
  }
}

async function deleteConversation(c) {
  if (!window.confirm(`Delete "${c.title}"?`)) return;
  try {
    await api.remove(c.id);
  } catch (e) {
    if (e instanceof ApiError && e.status === 409)
      return window.alert('Apollo is still replying. Try again in a moment.');
    throw e;
  }
  await loadConversations();
  if (state.conv && state.conv.id === c.id) {
    if (state.convs.length) await openConversation(state.convs[0].id);
    else await newConversation();
  }
}

async function newConversation() {
  const c = await api.createConversation();
  await loadConversations();
  await openConversation(c.id);
}

function renderMessages(list, { prepend = false } = {}) {
  const frag = document.createDocumentFragment();
  for (const m of list) {
    frag.append(messageEl(m, copyWithFeedback));
    if (m.role === 'assistant' && (m.status === 'error' || m.status === 'cancelled')) {
      frag.append(failedNote(m));
    }
  }
  if (prepend) els.messages.prepend(frag);
  else els.messages.append(frag);
}

function failedNote(m) {
  const wrap = document.createElement('div');
  wrap.className = 'note err';
  wrap.textContent = m.status === 'cancelled' ? 'Stopped. ' : 'Apollo could not complete this reply. ';
  const retry = document.createElement('button');
  retry.type = 'button';
  retry.textContent = 'Retry';
  retry.addEventListener('click', () => retryLast());
  wrap.append(retry);
  return wrap;
}

async function openConversation(id) {
  drawer.close();
  clearInterval(state.poll);
  const data = await api.messages(id);
  state.conv = data.conversation;
  els.title.textContent = state.conv.title;
  els.messages.replaceChildren();
  state.oldest = data.messages.length ? data.messages[0].seq : null;
  if (data.messages.length >= 50) addOlderButton();
  renderMessages(data.messages);
  toBottom();
  renderList();
  const last = data.messages[data.messages.length - 1];
  if (last && last.status === 'running') watchRunning(id);
  else setBusy(false);
}

function addOlderButton() {
  const b = document.createElement('button');
  b.className = 'older';
  b.type = 'button';
  b.textContent = 'Load older';
  b.addEventListener('click', async () => {
    const data = await api.messages(state.conv.id, state.oldest);
    b.remove();
    if (data.messages.length) state.oldest = data.messages[0].seq;
    if (data.messages.length >= 50) addOlderButton();
    renderMessages(data.messages, { prepend: true });
  });
  els.messages.prepend(b);
}

// After a reload mid-run the reply is still being produced on the server: poll until it is saved.
function watchRunning(id) {
  setBusy(true, 'Apollo is replying');
  state.poll = setInterval(async () => {
    const data = await api.messages(id).catch(() => null);
    if (!data || !state.conv || state.conv.id !== id) return;
    const last = data.messages[data.messages.length - 1];
    if (last && last.status !== 'running') {
      clearInterval(state.poll);
      await openConversation(id);
    }
  }, 2000);
}

function bubble() {
  const el = turnEl('apollo');
  const msg = document.createElement('div');
  msg.className = 'msg apollo';
  const body = document.createElement('div');
  body.className = 'body';
  msg.append(body);
  el.append(msg);
  els.messages.append(el);
  return { el, body, text: '' };
}

function handleStream(b) {
  return ({ event, data }) => {
    const stick = nearBottom();
    if (event === 'delta') {
      b.text += data.text;
      renderBody(b.body, b.text);
      els.status.hidden = true;
    } else if (event === 'interim') {
      // Narration before a tool call: transient status only, the reply restarts after the last tool call.
      b.text = '';
      renderBody(b.body, '');
      els.status.hidden = false;
      els.status.textContent = String(data.text).trim().split('\n').pop().slice(0, 140);
    } else if (event === 'tool') {
      els.status.hidden = false;
      els.status.textContent = `Apollo is ${data.name === 'reading' || data.name === 'writing notes' || data.name === 'working' || data.name === 'searching the web' ? data.name : `checking ${data.name}`}...`;
    } else if (event === 'done') {
      renderBody(b.body, data.text);
      if (data.status === 'cancelled') els.messages.append(failedNote({ status: 'cancelled' }));
    } else if (event === 'error') {
      b.el.remove();
      els.messages.append(failedNote({ status: 'error' }));
    }
    if (stick) toBottom();
  };
}

async function run(startStream) {
  setBusy(true, 'Apollo is replying');
  const b = bubble();
  try {
    await startStream(handleStream(b));
  } catch (e) {
    b.el.remove();
    if (e instanceof ApiError && e.body.busy) note('Apollo is still replying.', 'err');
    else if (e instanceof ApiError && e.status === 429)
      note('Too many messages this hour. Try again later.', 'err');
    else if (e instanceof ApiError && e.status === 410)
      note('The photos have expired. Send them again.', 'err');
    else note('Could not reach Apollo. Check your connection.', 'err');
  } finally {
    setBusy(false);
    state.conv = (await api.messages(state.conv.id)).conversation;
    await loadConversations();
    toBottom();
  }
}

async function send() {
  const text = els.input.value.trim();
  if ((!text && staged.ready().length === 0) || state.busy || staged.hasPending()) return;
  els.input.value = '';
  autosize();
  for (const p of staged.entries()) URL.revokeObjectURL(p.url);
  const ids = staged.takeForSend();
  const shown = { id: 'tmp', role: 'user', text, photoCount: ids.length };
  els.messages.append(messageEl(shown, copyWithFeedback));
  els.previews.replaceChildren();
  toBottom();
  await run((onEvent) => api.send(state.conv.id, text, ids, onEvent));
  await openConversation(state.conv.id);
}

async function retryLast() {
  if (state.busy) return;
  await run((onEvent) => api.retry(state.conv.id, onEvent));
  await openConversation(state.conv.id);
}

function autosize() {
  els.input.style.height = 'auto';
  els.input.style.height = `${Math.min(els.input.scrollHeight, 140)}px`;
}

// Small "x" glyph built with DOM APIs (no innerHTML).
function closeIcon() {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', 'M6 6l12 12M18 6 6 18');
  svg.append(path);
  return svg;
}

function addPreview(file) {
  const url = URL.createObjectURL(file);
  const { entry: photo, settled } = staged.add(file, { url });
  const wrap = document.createElement('div');
  wrap.className = 'preview uploading';
  const img = document.createElement('img');
  img.src = photo.url;
  img.alt = '';
  const x = document.createElement('button');
  x.type = 'button';
  x.append(closeIcon());
  x.setAttribute('aria-label', 'Remove photo');
  x.addEventListener('click', () => {
    staged.remove(photo);
    URL.revokeObjectURL(photo.url);
    wrap.remove();
  });
  wrap.append(img, x);
  els.previews.append(wrap);
  settled.then((status) => {
    if (status === 'ready') wrap.classList.remove('uploading');
    else if (status === 'failed') {
      URL.revokeObjectURL(photo.url);
      wrap.remove();
      const e = photo.error;
      note(e instanceof ApiError && e.status === 415 ? e.message : 'Could not upload that photo.', 'err');
    }
  });
}

els.attach.addEventListener('click', () => els.file.click());
els.file.addEventListener('change', () => {
  if (!limits) {
    els.file.value = '';
    return note('Photos are not ready yet. Try again in a moment.', 'err');
  }
  for (const file of els.file.files) {
    if (staged.count() >= limits.maxPhotos)
      return note(
        `At most ${limits.maxPhotos} ${limits.maxPhotos === 1 ? 'photo' : 'photos'} per message.`,
        'err',
      );
    if (file.size > limits.maxPhotoBytes) {
      note(`That photo is larger than ${Math.round(limits.maxPhotoBytes / (1024 * 1024))} MB.`, 'err');
      continue;
    }
    addPreview(file);
  }
  els.file.value = '';
});
// Unsent photos are deleted when the page goes away. A page kept for back/forward restore keeps its chips,
// and hiding the page (switching to the camera or gallery to pick a photo) must not drop them either, so
// only a real exit counts.
window.addEventListener('pagehide', (e) => {
  if (!e.persisted) staged.discardAll(api.deletePhotoOnExit);
});
els.form.addEventListener('submit', (e) => {
  e.preventDefault();
  send();
});
els.input.addEventListener('input', autosize);
els.cancel.addEventListener('click', () => state.conv && api.cancel(state.conv.id).catch(() => {}));
$('copy-chat').addEventListener('click', () => copyConversation());
$('new-btn').addEventListener('click', () => newConversation());
$('delete-all').addEventListener('click', async () => {
  if (!window.confirm('Delete all your chats? This cannot be undone.')) return;
  try {
    await api.removeAll();
  } catch {
    return window.alert('Apollo is still replying. Try again in a moment.');
  }
  await newConversation();
});
const syncOnline = () => (els.offline.hidden = navigator.onLine);
window.addEventListener('online', syncOnline);
window.addEventListener('offline', syncOnline);
syncOnline();

(async function init() {
  try {
    limits = (await api.me()).limits;
    await loadConversations();
    if (state.convs.length) await openConversation(state.convs[0].id);
    else await newConversation();
  } catch {
    note('Could not load your chats.', 'err');
  }
})();

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
