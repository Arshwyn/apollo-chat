// Proves the isolation hook keeps two users apart, including when both run at the same time.
// APOLLO_HOOK_PATH selects the hook under test: `npm test` points it at the proposed hook in docs/host;
// the host operator re-runs this with the installed hook path after installing it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { tmpDir, rmDir } from '../helpers.js';

const HOOK = process.env.APOLLO_HOOK_PATH;
const haveTools = spawnSync('bash', ['-c', 'command -v jq'], { encoding: 'utf8' }).status === 0;
const skip = !HOOK
  ? 'APOLLO_HOOK_PATH is not set'
  : !fs.existsSync(HOOK)
    ? 'APOLLO_HOOK_PATH does not exist'
    : !haveTools
      ? 'jq is not installed'
      : false;

const fx = {};
if (!skip) {
  fx.dir = tmpDir('ac-hook-');
  fx.root = path.join(fx.dir, 'agent-memory', 'apollo');
  fx.data = path.join(fx.dir, 'chatdata');
  for (const u of ['alice', 'bob']) fs.mkdirSync(path.join(fx.root, u, 'history'), { recursive: true });
  fs.mkdirSync(fx.data, { recursive: true });
  test.after(() => rmDir(fx.dir));
}

const BASE_ENV = () => ({
  PATH: process.env.PATH,
  APOLLO_ROOT: fx.root,
  APOLLO_USERS: 'alice bob',
  APOLLO_CONNECTORS_alice: 'mcp__*Onyx*Alice* mcp__*Oura*',
  APOLLO_CONNECTORS_bob: 'mcp__*Onyx*Bob*',
});
const chatEnv = (user, extra = {}) => ({
  ...BASE_ENV(),
  APOLLO_CHAT_RUN: '1',
  ...(user === undefined ? {} : { APOLLO_USER: user }),
  APOLLO_CHAT_DATA: fx.data,
  ...extra,
});

function call(env, tool, input, { agent = 'apollo' } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn('bash', [HOOK], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('error', reject);
    p.on('close', () => {
      if (!out.trim()) return resolve({ decision: 'allow' });
      const o = JSON.parse(out).hookSpecificOutput;
      resolve({ decision: o.permissionDecision, reason: o.permissionDecisionReason });
    });
    p.stdin.end(
      JSON.stringify({
        hook_event_name: 'PreToolUse',
        tool_name: tool,
        tool_input: input,
        agent_type: agent,
      }),
    );
  });
}

const p = (...parts) => path.join(...parts);
const mem = (u, f = 'profile.md') => p(fx.root, u, f);
const tr = (u, f = 'a.txt') => p(fx.data, 'users', u, 'transcripts', f);
const photo = (u) => p(fx.data, 'users', u, 'tmp', 'run-12345678', 'a.jpg');

// [tool, input] pairs for a chat run as `me` against `other`.
const allowedFor = (me) => [
  ['Read', { file_path: mem(me) }],
  ['Write', { file_path: mem(me, 'history/2026/11/05/analysis.md'), content: 'notes' }],
  ['Read', { file_path: tr(me) }],
  ['Grep', { pattern: 'knee', path: p(fx.data, 'users', me, 'transcripts') }],
  ['Read', { file_path: photo(me) }],
  ['Bash', { command: `grep -ri knee ${p(fx.data, 'users', me, 'transcripts')}/` }],
  ['mcp__claude_ai_Onyx_-_' + me[0].toUpperCase() + me.slice(1) + '__get_user_settings', {}],
  ['WebSearch', { query: 'protein sources' }],
];
const deniedFor = (me, other) => [
  ['Read', { file_path: mem(other) }],
  ['Read', { file_path: p(fx.root, `${other}-profile.md`) }],
  ['Read', { file_path: tr(other) }],
  ['Read', { file_path: photo(other) }],
  ['Bash', { command: `cat ${p(fx.data, 'users', other, 'chat.db')}` }],
  ['Read', { file_path: p(fx.data, 'users', me, 'chat.db') }],
  ['Read', { file_path: p(fx.data, 'users', me, 'work', 'x') }],
  ['Grep', { pattern: 'x', path: p(fx.data, 'users') }],
  ['Grep', { pattern: 'x', path: fx.data }],
  ['Bash', { command: `ls ${fx.data}` }],
  ['Glob', { pattern: p(fx.data, 'users', '*', 'transcripts', '*') }],
  ['Glob', { pattern: p(fx.root, '*', 'history', '*') }],
  ['Read', { file_path: p(fx.data, 'users', me, 'transcripts', '..', '..', other, 'chat.db') }],
  ['Bash', { command: 'cat ../../' + other + '/chat.db' }],
  ['Bash', { command: 'ls ..' }],
  ['Grep', { pattern: 'x', path: p(fx.root) }],
  ['mcp__claude_ai_Onyx_-_' + other[0].toUpperCase() + other.slice(1) + '__get_user_settings', {}],
  ['mcp__claude_ai_Gmail__search_threads', {}],
  ['mcp__claude_ai_Google_Drive__search_files', {}],
  ['Agent', { subagent_type: 'Explore', prompt: 'look around' }],
];

test('chat run: each user may use their own data and is denied the other users', { skip }, async () => {
  for (const [me, other] of [
    ['alice', 'bob'],
    ['bob', 'alice'],
  ]) {
    for (const [tool, input] of allowedFor(me)) {
      const r = await call(chatEnv(me), tool, input);
      assert.equal(
        r.decision,
        'allow',
        `${me} should be allowed ${tool} ${JSON.stringify(input)}: ${r.reason}`,
      );
    }
    for (const [tool, input] of deniedFor(me, other)) {
      const r = await call(chatEnv(me), tool, input);
      assert.equal(r.decision, 'deny', `${me} should be denied ${tool} ${JSON.stringify(input)}`);
    }
  }
});

test(
  'chat run: the health connector for one user is denied to the other (Oura example)',
  { skip },
  async () => {
    assert.equal(
      (await call(chatEnv('alice'), 'mcp__claude_ai_Oura__get_daily_sleep', {})).decision,
      'allow',
    );
    assert.equal((await call(chatEnv('bob'), 'mcp__claude_ai_Oura__get_daily_sleep', {})).decision, 'deny');
  },
);

test('chat run: enforced for every agent type, not only apollo', { skip }, async () => {
  const r = await call(chatEnv('alice'), 'Read', { file_path: mem('bob') }, { agent: 'Explore' });
  assert.equal(r.decision, 'deny');
  const none = await call(chatEnv('alice'), 'Read', { file_path: mem('bob') }, { agent: '' });
  assert.equal(none.decision, 'deny');
});

test('chat run fails closed: missing or invalid user denies even harmless calls', { skip }, async () => {
  for (const user of [undefined, '', 'mallory', 'ALICE', '../alice', 'alice bob', 'alice\n', 'a*']) {
    for (const [tool, input] of [
      ['Read', { file_path: '/path/to/harmless.txt' }],
      ['WebSearch', { query: 'x' }],
      ['mcp__claude_ai_Oura__get_daily_sleep', {}],
    ]) {
      const r = await call(chatEnv(user), tool, input);
      assert.equal(r.decision, 'deny', `user=${JSON.stringify(user)} ${tool}`);
    }
  }
});

test('chat run fails closed without a usable data directory', { skip }, async () => {
  for (const data of [undefined, '', 'relative/path']) {
    const env = chatEnv('alice');
    if (data === undefined) delete env.APOLLO_CHAT_DATA;
    else env.APOLLO_CHAT_DATA = data;
    assert.equal(
      (await call(env, 'Read', { file_path: mem('alice') })).decision,
      'deny',
      JSON.stringify(data),
    );
  }
});

test(
  'chat run: a lock held for a different user is a conflict and denies; same user or no lock is fine',
  { skip },
  async () => {
    const lock = path.join(fx.root, '.active-user');
    try {
      fs.writeFileSync(lock, 'bob\n');
      assert.equal((await call(chatEnv('alice'), 'Read', { file_path: mem('alice') })).decision, 'deny');
      assert.equal((await call(chatEnv('bob'), 'Read', { file_path: mem('bob') })).decision, 'allow');
      fs.writeFileSync(lock, '');
      assert.equal((await call(chatEnv('alice'), 'Read', { file_path: mem('alice') })).decision, 'allow');
    } finally {
      fs.rmSync(lock, { force: true });
    }
    assert.equal((await call(chatEnv('alice'), 'Read', { file_path: mem('alice') })).decision, 'allow');
  },
);

test('APOLLO_USER alone (no chat flag) never overrides the lock', { skip }, async () => {
  const lock = path.join(fx.root, '.active-user');
  try {
    fs.writeFileSync(lock, 'bob\n');
    const env = { ...BASE_ENV(), APOLLO_USER: 'alice' };
    assert.equal((await call(env, 'Read', { file_path: mem('alice') })).decision, 'deny', 'lock says bob');
    assert.equal((await call(env, 'Read', { file_path: mem('bob') })).decision, 'allow');
  } finally {
    fs.rmSync(lock, { force: true });
  }
  const env = { ...BASE_ENV(), APOLLO_USER: 'alice' };
  assert.equal(
    (await call(env, 'Read', { file_path: mem('alice') })).decision,
    'deny',
    'no lock means no user data',
  );
  assert.equal((await call(env, 'mcp__claude_ai_Oura__get_daily_sleep', {})).decision, 'deny');
});

test(
  'orchestrator flow is unchanged: lock-based, other agents unrestricted, spawn guard intact',
  { skip },
  async () => {
    const lock = path.join(fx.root, '.active-user');
    try {
      fs.writeFileSync(lock, 'alice\n');
      const env = BASE_ENV();
      assert.equal((await call(env, 'Read', { file_path: mem('alice') })).decision, 'allow');
      assert.equal((await call(env, 'Read', { file_path: mem('bob') })).decision, 'deny');
      assert.equal(
        (await call(env, 'Read', { file_path: mem('bob') }, { agent: '' })).decision,
        'allow',
        'the orchestrator itself is not restricted',
      );
      assert.equal(
        (await call(env, 'Agent', { subagent_type: 'apollo', prompt: `work on ${mem('bob')}` })).decision,
        'deny',
      );
      assert.equal(
        (await call(env, 'Agent', { subagent_type: 'apollo', prompt: 'work on alice' })).decision,
        'allow',
      );
      assert.equal(
        (await call(env, 'Agent', { subagent_type: 'Explore', prompt: 'anything' })).decision,
        'allow',
      );
    } finally {
      fs.rmSync(lock, { force: true });
    }
    assert.equal(
      (await call(BASE_ENV(), 'Agent', { subagent_type: 'apollo', prompt: 'x' })).decision,
      'deny',
      'no lock, no spawn',
    );
  },
);

test(
  'parallel runs for both users never leak: interleaved calls keep their own verdicts',
  { skip },
  async () => {
    const jobs = [];
    for (let round = 0; round < 6; round++) {
      for (const [me, other] of [
        ['alice', 'bob'],
        ['bob', 'alice'],
      ]) {
        for (const [tool, input] of allowedFor(me).slice(0, 5))
          jobs.push(call(chatEnv(me), tool, input).then((r) => ({ want: 'allow', r, me, tool })));
        for (const [tool, input] of deniedFor(me, other).slice(0, 8))
          jobs.push(call(chatEnv(me), tool, input).then((r) => ({ want: 'deny', r, me, tool })));
      }
    }
    const results = await Promise.all(jobs);
    assert.ok(results.length > 150);
    for (const x of results) assert.equal(x.r.decision, x.want, `${x.me} ${x.tool}`);
  },
);
