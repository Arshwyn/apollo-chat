const MAX_TURN_CHARS = 4000;

function clip(s) {
  return s.length > MAX_TURN_CHARS ? s.slice(0, MAX_TURN_CHARS) + ' [...]' : s;
}

// The prompt names exactly one user and that user's folders. The other user is never mentioned.
export function buildPrompt({ user, memoryRoot, transcriptsDir, photoPaths = [], history = [], text }) {
  const parts = [
    `Chat message from the user \`${user}\`. This run is for exactly this user; their folder is \`${memoryRoot}/${user}/\`.`,
    '',
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
