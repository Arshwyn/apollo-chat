import fs from 'node:fs';
import path from 'node:path';
import { transcriptPath } from './files.js';
import { userPaths } from './store.js';

function stamp(ms, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(ms));
  const g = (t) => parts.find((p) => p.type === t).value;
  return `${g('year')}-${g('month')}-${g('day')} ${g('hour')}:${g('minute')}`;
}

export function renderTranscript(conversation, messages, timeZone) {
  const out = [`# ${conversation.title}`, ''];
  for (const m of messages) {
    if (m.status === 'running') continue;
    const who = m.role === 'user' ? 'user' : 'apollo';
    const lines = String(m.text || '').split('\n');
    const note = m.status === 'error' || m.status === 'cancelled' ? ` (${m.status}, incomplete)` : '';
    out.push(`[${stamp(m.created, timeZone)}] ${who}${note}: ${lines[0]}`);
    for (const l of lines.slice(1)) out.push(`  ${l}`);
    for (let i = 0; i < m.photoCount; i++) out.push('  [photo analysed]');
  }
  return out.join('\n') + '\n';
}

// Plain text only, no image data. Written atomically with mode 0600 so a reader never sees a half file.
export function writeTranscript({ dataDir, user, store, conversationId, timeZone }) {
  const conv = store.getConversation(conversationId);
  if (!conv) return null;
  const file = transcriptPath(dataDir, user, conversationId);
  fs.mkdirSync(userPaths(dataDir, user).transcripts, { recursive: true, mode: 0o700 });
  const tmp = path.join(path.dirname(file), `.${conversationId}.tmp`);
  fs.writeFileSync(tmp, renderTranscript(conv, store.allMessages(conversationId), timeZone), { mode: 0o600 });
  fs.renameSync(tmp, file);
  return file;
}
