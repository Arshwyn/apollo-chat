import { localDate } from './naming.js';

const MAX_TURN_CHARS = 4000;
// Shared start-up files in the memory root. Keep in step with the host hook's APOLLO_SHARED_FILES.
export const SHARED_FILES = ['persona.md', 'rules.md', 'MEMORY.md'];

function clip(s) {
  return s.length > MAX_TURN_CHARS ? s.slice(0, MAX_TURN_CHARS) + ' [...]' : s;
}

// The user's local clock, e.g. "Thursday 2026-11-05, 19:14 (America/New_York)". The host clock is UTC and
// chat runs have no shell, so this line is the only reliable "today" the agent gets.
export function localClock(ms, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'long',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(ms));
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get('weekday')} ${localDate(ms, timeZone)}, ${get('hour')}:${get('minute')} (${timeZone})`;
}

// The prompt names exactly one user and that user's folders. The other user is never mentioned.
export function buildPrompt({
  user,
  memoryRoot,
  transcriptsDir,
  photoPaths = [],
  history = [],
  text,
  sharedFiles = SHARED_FILES,
  nowMs = Date.now(),
  timeZone = 'UTC',
}) {
  const parts = [
    `Current date and time for this user: ${localClock(nowMs, timeZone)}. Use this as today for every date decision: the day-file folder (history/YYYY/MM/DD), "yesterday" and "today", and Onyx and Oura date arguments (the Oura sleep for today is the night that ended this morning). Ignore any other date you are shown, such as the host clock, which is UTC.`,
    '',
    `Chat message from the user \`${user}\`. This run is for exactly this user; their folder is \`${memoryRoot}/${user}/\`.`,
    '',
    `Shared start-up files are readable (read only) at ${sharedFiles.map((f) => `\`${memoryRoot}/${f}\``).join(', ')}: read exactly those paths with the Read tool. Mailbox handling (inbox, archive, sending notes) is not available in chat runs: skip it and do not retry it.`,
    'Chat runs have no shell and no /tmp access. Do not list or clean /tmp, and skip the temp-file and mail trailer steps from your start-up text: end the reply without `temp:` or `mail:` lines. Never call Glob or Grep without a path inside your own folder; prefer reading the specific day files you need over globbing. Never call a tool only to satisfy a start-up checklist item that needs a shell or another folder.',
    'If a call is blocked, say so honestly and briefly in your reply, then carry on and answer with what you can; a blocked call must not stop the reply.',
    'This is the chat channel (a phone screen). Reply in plain text, no tables wider than a few columns.',
    "Free chat: when the message contains a durable fact (an injury, a preference, a correction to one of your estimates, a goal change), save a short dated note in that user's history folder before replying; profile changes are only proposed, never applied without approval.",
    `Earlier chat is stored as text transcripts in \`${transcriptsDir}/\`. Search them only if the user asks about something said earlier; never read any chat database. Day files stay the source of truth for analysis.`,
  ];
  if (photoPaths.length) {
    parts.push(
      '',
      'Attached photos are temporary and are deleted when this run ends. Read each one with the Read tool and, BEFORE replying, write what you extracted to the day file as your rules require (an `Intake:` line for food, recovery numbers, estimates marked with a range).',
      'Attached photos:',
      ...photoPaths.map((p) => `- ${p}`),
    );
  }
  if (history.length) {
    parts.push('', 'Conversation so far (oldest first):');
    for (const m of history) {
      parts.push(`${m.role === 'user' ? 'user' : 'apollo'}: ${clip(m.text)}`);
      for (let i = 0; i < m.photoCount; i++) parts.push('  [photo analysed]');
    }
  }
  parts.push('', 'Message:', text);
  return parts.join('\n');
}
