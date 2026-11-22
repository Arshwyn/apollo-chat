// Optional content-free signal to a hosting page. Only active when the page is framed AND the server
// named one allowed parent origin (EMBED_ANCESTOR, sent as `embedParent` by GET /api/me). The messages
// are `{type:'apollo-ready'}` and `{type:'apollo-state', state}` with state idle, thinking or speaking:
// never text, ids, titles or counts. The target origin is always the exact configured origin, never '*',
// so a different parent receives nothing. Nothing is read from the parent.

export const STATES = ['idle', 'thinking', 'speaking'];

// `win` exists so the logic can be tested without a browser.
export function createEmbedSignal(parentOrigin, win = globalThis.window) {
  const framed = !!win && win.parent && win.parent !== win;
  if (typeof parentOrigin !== 'string' || parentOrigin === '' || parentOrigin === '*' || !framed) {
    return { active: false, ready() {}, state() {} };
  }
  let last = null;
  const post = (msg) => {
    try {
      win.parent.postMessage(msg, parentOrigin);
    } catch {
      /* the parent is gone or the origin is invalid: nothing to do */
    }
  };
  return {
    active: true,
    ready() {
      post({ type: 'apollo-ready' });
    },
    state(s) {
      if (!STATES.includes(s) || s === last) return;
      last = s;
      post({ type: 'apollo-state', state: s });
    },
  };
}
