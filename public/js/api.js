import { SseParser } from './sse.js';

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error || `http ${status}`);
    this.status = status;
    this.body = body || {};
  }
}

async function json(res) {
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* empty body */
  }
  if (!res.ok) throw new ApiError(res.status, body);
  return body;
}

const opts = (method, body) => ({
  method,
  credentials: 'same-origin',
  headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
});

// The browser's IANA time zone, so Apollo's dates follow where the user is. The server validates it.
const zone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
};

export const api = {
  me: () => fetch('/api/me', opts('GET')).then(json),
  conversations: () => fetch('/api/conversations', opts('GET')).then(json),
  createConversation: () => fetch('/api/conversations', opts('POST', { timeZone: zone() })).then(json),
  messages: (id, before) =>
    fetch(`/api/conversations/${id}/messages?limit=50${before ? `&before=${before}` : ''}`, opts('GET')).then(
      json,
    ),
  // Read-only day files of the signed-in user; the server decides whose.
  dayfiles: (before) =>
    fetch(`/api/dayfiles?limit=30${before ? `&before=${before}` : ''}`, opts('GET')).then(json),
  dayfile: (date, name) => fetch(`/api/dayfiles/${date}/${name}`, opts('GET')).then(json),
  rename: (id, title) => fetch(`/api/conversations/${id}`, opts('PATCH', { title })).then(json),
  remove: (id) => fetch(`/api/conversations/${id}`, opts('DELETE')).then(json),
  removeAll: () => fetch('/api/me/data', opts('DELETE')).then(json),
  cancel: (id) => fetch(`/api/conversations/${id}/cancel`, opts('POST')).then(json),
  uploadPhoto: (file) =>
    fetch('/api/photos', { method: 'POST', credentials: 'same-origin', body: file }).then(json),
  deletePhoto: (id) => fetch(`/api/photos/${id}`, opts('DELETE')).then(json),
  // Best effort for page exit: keepalive lets the request outlive the page; the result is ignored.
  deletePhotoOnExit: (id) =>
    fetch(`/api/photos/${id}`, { ...opts('DELETE'), keepalive: true }).catch(() => {}),
  // Streams a reply: calls onEvent({event, data}) for start, delta, tool, done and error.
  async stream(path, body, onEvent) {
    const res = await fetch(path, opts('POST', body));
    if (!res.ok) throw new ApiError(res.status, await res.json().catch(() => null));
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    const parser = new SseParser();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      for (const ev of parser.push(dec.decode(value, { stream: true }))) onEvent(ev);
    }
  },
  send: (id, text, photoIds, onEvent) =>
    api.stream(`/api/conversations/${id}/messages`, { text, photoIds, timeZone: zone() }, onEvent),
  retry: (id, onEvent) => api.stream(`/api/conversations/${id}/retry`, { timeZone: zone() }, onEvent),
};
