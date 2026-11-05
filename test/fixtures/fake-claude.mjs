#!/usr/bin/env node
// Stand-in for the claude CLI: behaviour is chosen by the prompt it reads from stdin. No model, no network.
import fs from 'node:fs';
import path from 'node:path';

const here = path.dirname(process.argv[1]);
const log = (s) => fs.appendFileSync(path.join(here, 'fake.log'), s + '\n');
let prompt = '';
process.stdin.setEncoding('utf8');
for await (const c of process.stdin) prompt += c;
log(`start ${process.pid} ${Date.now()}`);
const msg = prompt.includes('Message:\n') ? prompt.slice(prompt.lastIndexOf('Message:\n') + 9) : prompt;
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const delta = (text) =>
  out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } });

if (msg.startsWith('SLEEP')) {
  const ms = Number(msg.split(' ')[1] || 60000);
  out({ type: 'system', subtype: 'init', session_id: 'fake' });
  await new Promise((r) => setTimeout(r, ms));
  delta('woke');
  out({ type: 'result', subtype: 'success', is_error: false, result: 'woke' });
  log(`end ${process.pid} ${Date.now()}`);
} else if (msg.startsWith('INFO')) {
  out({ type: 'fake', env: process.env, argv: process.argv.slice(2), cwd: process.cwd(), prompt });
  out({ type: 'result', subtype: 'success', is_error: false, result: 'info' });
} else if (msg.startsWith('FAIL')) {
  out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: '' });
  process.exitCode = 1;
} else if (msg.startsWith('TRAILER')) {
  delta('Answer text');
  delta('\n\nmail: none\ntemp: clean');
  out({ type: 'result', subtype: 'success', is_error: false, result: 'Answer text' });
} else if (msg.startsWith('PHOTOS')) {
  const files = [...prompt.matchAll(/^- (\/\S+)$/gm)].map((m) => m[1]);
  const seen = files.map((f) => fs.existsSync(f));
  delta(`photos:${seen.join(',')}`);
  out({ type: 'result', subtype: 'success', is_error: false, result: 'x' });
} else {
  for (const part of ['Hello ', 'there']) delta(part);
  if (msg.includes('WRITEDAY')) {
    const m = msg.match(/DAYDIR=(\S+)/);
    fs.mkdirSync(m[1], { recursive: true });
    fs.writeFileSync(path.join(m[1], 'trigger.md'), 'day file');
  }
  out({ type: 'result', subtype: 'success', is_error: false, result: 'Hello there' });
}
