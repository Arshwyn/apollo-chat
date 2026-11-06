// Copy helpers. The text copied is always the stored markdown source of a message, never rendered DOM,
// so headings and bold survive pasting. Photo placeholder chips are not part of a message's text.

const LABELS = { user: 'You', assistant: 'Apollo' };

// One message as copyable text: its stored text, trimmed. Empty for a photo-only message.
export function messageText(m) {
  return typeof m?.text === 'string' ? m.text.trim() : '';
}

// The whole chat as plain text with simple role labels, oldest first, blank line between messages.
// Messages with no text (photo-only, failed or still running with nothing saved) are skipped.
export function conversationToText(messages) {
  return (messages || [])
    .map((m) => [m, messageText(m)])
    .filter(([, t]) => t !== '')
    .map(([m, t]) => `${LABELS[m.role] || LABELS.assistant}: ${t}`)
    .join('\n\n');
}

// Writes `text` to the clipboard. Uses the async Clipboard API where the context allows it and falls
// back to a hidden textarea with execCommand('copy') (non-secure contexts, older WebViews).
// Resolves true on success, false when both paths fail. `env` exists so the logic can be tested.
export async function copyText(
  text,
  env = { navigator: globalThis.navigator, document: globalThis.document },
) {
  const clip = env.navigator?.clipboard;
  if (clip && typeof clip.writeText === 'function' && globalThis.isSecureContext !== false) {
    try {
      await clip.writeText(text);
      return true;
    } catch {
      /* permission or focus problem: try the fallback */
    }
  }
  return fallbackCopy(text, env.document);
}

function fallbackCopy(text, doc) {
  if (!doc || typeof doc.createElement !== 'function' || typeof doc.execCommand !== 'function') return false;
  const ta = doc.createElement('textarea');
  ta.value = text;
  ta.readOnly = true;
  ta.setAttribute('aria-hidden', 'true');
  ta.tabIndex = -1;
  Object.assign(ta.style, {
    position: 'fixed',
    top: '0',
    left: '0',
    opacity: '0',
    fontSize: '16px',
    userSelect: 'text',
    webkitUserSelect: 'text',
  });
  const active = doc.activeElement;
  doc.body.append(ta);
  let ok;
  try {
    ta.focus();
    ta.select();
    ta.setSelectionRange?.(0, text.length);
    ok = doc.execCommand('copy') === true;
  } catch {
    ok = false;
  } finally {
    ta.remove();
    if (active && typeof active.focus === 'function') active.focus();
  }
  return ok;
}
