// Guards the public-repo rules: no personal names, real hostnames, IP addresses, host paths or real
// email addresses in any file that could be committed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const files = () => {
  const r = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
    encoding: 'utf8',
  });
  if (r.status !== 0) return null;
  return r.stdout.split('\n').filter(Boolean);
};

const FORBIDDEN = [
  [new RegExp(['der', 'rick'].join(''), 'i'), 'personal name'],
  [new RegExp(['nao', 'mi'].join(''), 'i'), 'personal name'],
  [/\/home\/[a-z_][\w-]*/i, 'host home path'],
  [/\b(?!127\.0\.0\.1\b|0\.0\.0\.0\b)(?:\d{1,3}\.){3}\d{1,3}\b/, 'IP address'],
  [/\.(?:vercel\.app|onrender\.com|ts\.net|trycloudflare\.com)\b/i, 'deployment hostname'],
  [/[\w.+-]+@(?!example\.(?:com|org)\b)(?!users\.noreply)[\w-]+\.[a-z]{2,}/i, 'non-example email'],
  [new RegExp(['Co-Authored', 'By|Claude', 'Session'].join('-')), 'attribution trailer'],
];

test('no personal or infrastructure details in repository files', (t) => {
  const list = files();
  if (!list) return t.skip('not a git checkout');
  const bad = [];
  for (const f of list) {
    if (
      /\.(png|ico|lock)$/.test(f) ||
      f === 'package-lock.json' ||
      f.endsWith('-TASK.md') ||
      f === 'BACKLOG.md'
    )
      continue;
    if (!fs.existsSync(f)) continue;
    const text = fs.readFileSync(path.resolve(f), 'utf8');
    for (const [re, label] of FORBIDDEN) {
      const m = re.exec(text);
      if (m) bad.push(`${f}: ${label} (${m[0].slice(0, 30)})`);
    }
  }
  assert.deepEqual(bad, []);
});
