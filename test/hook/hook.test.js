// Proves the isolation hook keeps two users apart, including when both run at the same time.
// APOLLO_HOOK_PATH selects the hook under test: `npm test` points it at the proposed hook in docs/host;
// the host operator re-runs this with the installed hook path after installing it.
//
// Chat runs have no shell and a default-deny tool surface: file tools are allowed only on canonical
// paths inside the user's own memory folder, transcripts folder or this run's photo folder.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { tmpDir, rmDir } from '../helpers.js';

const HOOK = process.env.APOLLO_HOOK_PATH;
const haveTools =
  spawnSync('bash', ['-c', 'command -v jq && command -v realpath'], { encoding: 'utf8' }).status === 0;
const skip = !HOOK
  ? 'APOLLO_HOOK_PATH is not set'
  : !fs.existsSync(HOOK)
    ? 'APOLLO_HOOK_PATH does not exist'
    : !haveTools
      ? 'jq and realpath are required'
      : false;

const RUN = 'run-12345678';
const fx = {};
if (!skip) {
  fx.dir = tmpDir('ac-hook-');
  fx.root = path.join(fx.dir, 'agent-memory', 'apollo');
  fx.data = path.join(fx.dir, 'chatdata');
  for (const u of ['alice', 'bob']) {
    fs.mkdirSync(path.join(fx.root, u, 'history'), { recursive: true });
    fs.mkdirSync(path.join(fx.data, 'users', u, 'transcripts'), { recursive: true });
    fs.mkdirSync(path.join(fx.data, 'users', u, 'tmp', RUN), { recursive: true });
    fs.mkdirSync(path.join(fx.data, 'users', u, 'tmp', 'run-other-000'), { recursive: true });
  }
  // Shared start-up files in the memory root, plus look-alikes, and a mailbox directory next to the root.
  for (const f of ['persona.md', 'rules.md', 'MEMORY.md', 'persona.md.bak', 'rules.md~', 'other.md'])
    fs.writeFileSync(path.join(fx.root, f), 'shared');
  fs.mkdirSync(path.join(path.dirname(fx.root), 'mailbox', 'apollo', 'inbox'), { recursive: true });
  fs.writeFileSync(path.join(path.dirname(fx.root), 'mailbox', 'apollo', 'inbox', 'note.md'), 'mail');
  // Symlinks planted inside each user's own folders that point at the other user's folders.
  for (const [me, other] of [
    ['alice', 'bob'],
    ['bob', 'alice'],
  ]) {
    fs.symlinkSync(path.join(fx.root, other), path.join(fx.root, me, 'link-to-other'));
    fs.symlinkSync(
      path.join(fx.data, 'users', other, 'transcripts'),
      path.join(fx.data, 'users', me, 'transcripts', 'escape'),
    );
  }
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
  APOLLO_RUN_ID: RUN,
  ...extra,
});

function callRaw(env, raw, cwd) {
  return new Promise((resolve, reject) => {
    const p = spawn('bash', [HOOK], { env, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', () => {});
    p.on('error', reject);
    p.on('close', () => {
      if (!out.trim()) return resolve({ decision: 'allow' });
      const o = JSON.parse(out).hookSpecificOutput;
      resolve({ decision: o.permissionDecision, reason: o.permissionDecisionReason });
    });
    p.stdin.on('error', () => {});
    p.stdin.end(raw);
  });
}
const call = (env, tool, input, { agent = 'apollo', cwd } = {}) =>
  callRaw(
    env,
    JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, agent_type: agent }),
    cwd,
  );

const p = (...parts) => path.join(...parts);
const cap = (s) => s[0].toUpperCase() + s.slice(1);
const mem = (u, f = 'profile.md') => p(fx.root, u, f);
const tr = (u, f = 'a.txt') => p(fx.data, 'users', u, 'transcripts', f);
const photo = (u, run = RUN) => p(fx.data, 'users', u, 'tmp', run, 'a.jpg');

const SHARED = ['persona.md', 'rules.md', 'MEMORY.md'];
const allowedFor = (me) => [
  ['Read own memory', 'Read', { file_path: mem(me) }],
  [
    'Write new nested file in own memory',
    'Write',
    { file_path: mem(me, 'history/2026/11/05/new/analysis.md'), content: 'notes' },
  ],
  ['Edit own memory', 'Edit', { file_path: mem(me, 'history/x.md'), old_string: 'a', new_string: 'b' }],
  ['Read own transcript', 'Read', { file_path: tr(me) }],
  [
    'Grep own transcripts',
    'Grep',
    { pattern: 'knee', path: p(fx.data, 'users', me, 'transcripts'), glob: '*.txt' },
  ],
  ['Grep own memory', 'Grep', { pattern: 'Intake', path: mem(me, 'history') }],
  ['Glob own memory', 'Glob', { pattern: 'history/**/*.md', path: p(fx.root, me) }],
  ...['**/*', '**/*.md', '*.md', 'history/**/*.md'].flatMap((pat) => [
    [`Glob own memory with ${pat}`, 'Glob', { pattern: pat, path: p(fx.root, me) }],
    [`Grep own memory with glob filter ${pat}`, 'Grep', { pattern: 'x', path: p(fx.root, me), glob: pat }],
  ]),
  [
    'Glob ** naming another user only filters under the own folder',
    'Glob',
    { pattern: `**/${me === 'alice' ? 'bob' : 'alice'}/**`, path: p(fx.root, me) },
  ],
  ['Glob own transcripts', 'Glob', { pattern: '*.txt', path: p(fx.data, 'users', me, 'transcripts') }],
  ...SHARED.flatMap((n) => [
    [`Read shared ${n}`, 'Read', { file_path: p(fx.root, n) }],
    [`Grep exactly shared ${n}`, 'Grep', { pattern: 'x', path: p(fx.root, n) }],
  ]),
  ['Read shared file via ./', 'Read', { file_path: `${fx.root}/./persona.md` }],
  ['Read shared file via //', 'Read', { file_path: `${fx.root}//rules.md` }],
  ['Read this run photo', 'Read', { file_path: photo(me) }],
  ['own Onyx connector', 'mcp__claude_ai_Onyx_-_' + cap(me) + '__get_user_settings', {}],
  ['WebSearch', 'WebSearch', { query: 'protein sources' }],
  ['ToolSearch', 'ToolSearch', { query: 'select:something' }],
];

const deniedFor = (me, other) => {
  const mine = p(fx.root, me);
  const wide = [
    fx.root,
    path.dirname(fx.root),
    path.dirname(path.dirname(fx.root)),
    fx.data,
    p(fx.data, 'users'),
  ];
  return [
    // no shell at all
    ['Bash ls', 'Bash', { command: 'ls' }],
    ['Bash own file', 'Bash', { command: `cat ${mem(me)}` }],
    ['Bash find over the parent', 'Bash', { command: `find ${path.dirname(fx.root)} -name '*'` }],
    ['Bash with quoting and variables', 'Bash', { command: `d=${fx.root}; cat "$d"/'${other}'/profile.md` }],
    ['BashOutput', 'BashOutput', { bash_id: '1' }],
    // shared files are read-only and matched by equality
    ...SHARED.flatMap((n) => [
      [`Write shared ${n}`, 'Write', { file_path: p(fx.root, n), content: 'x' }],
      [`Edit shared ${n}`, 'Edit', { file_path: p(fx.root, n), old_string: 'a', new_string: 'b' }],
      [`Glob over shared ${n}`, 'Glob', { pattern: n, path: fx.root }],
      [`Read ${n} with a backup suffix`, 'Read', { file_path: `${p(fx.root, n)}.bak` }],
      [`Read ${n} with a trailing space`, 'Read', { file_path: `${p(fx.root, n)} ` }],
      [`Read ${n} as a directory`, 'Read', { file_path: `${p(fx.root, n)}/x` }],
      [
        `Read ${n} with a parent hop into the other user`,
        'Read',
        { file_path: `${p(fx.root, n)}/../${other}/profile.md` },
      ],
      [`Read ${n} with different case`, 'Read', { file_path: p(fx.root, n.toUpperCase()) }],
      [`Grep ${n} with a parent hop`, 'Grep', { pattern: 'x', path: `${fx.root}/x/../../${n}` }],
      [`Read ${n} one directory up`, 'Read', { file_path: p(path.dirname(fx.root), n) }],
    ]),
    ['Read a look-alike backup file', 'Read', { file_path: p(fx.root, 'persona.md.bak') }],
    ['Read another file in the root', 'Read', { file_path: p(fx.root, 'other.md') }],
    ['Read the root directory', 'Read', { file_path: fx.root }],
    ['Grep the root directory', 'Grep', { pattern: 'x', path: fx.root }],
    ['Grep shared file with wildcard', 'Grep', { pattern: 'x', path: p(fx.root, '*.md') }],
    ['Read shared file with wildcard', 'Read', { file_path: p(fx.root, 'pers*.md') }],
    [
      'Read the mailbox inbox note',
      'Read',
      { file_path: p(path.dirname(fx.root), 'mailbox', 'apollo', 'inbox', 'note.md') },
    ],
    [
      'Glob the mailbox inbox',
      'Glob',
      { pattern: '*', path: p(path.dirname(fx.root), 'mailbox', 'apollo', 'inbox') },
    ],
    ['Grep the mailbox dir', 'Grep', { pattern: 'x', path: p(path.dirname(fx.root), 'mailbox') }],
    [
      'Write into the mailbox',
      'Write',
      { file_path: p(path.dirname(fx.root), 'mailbox', 'apollo', 'archive', 'x.md'), content: 'x' },
    ],
    // the other user's data, literally
    ['Read other memory', 'Read', { file_path: mem(other) }],
    ['Read other transcript', 'Read', { file_path: tr(other) }],
    ['Read other photo', 'Read', { file_path: photo(other) }],
    ['Write other memory', 'Write', { file_path: mem(other, 'x.md'), content: 'x' }],
    ['Edit other memory', 'Edit', { file_path: mem(other), old_string: 'a', new_string: 'b' }],
    // own folders that are not allowed
    ['Read own chat db', 'Read', { file_path: p(fx.data, 'users', me, 'chat.db') }],
    ['Read own work dir', 'Read', { file_path: p(fx.data, 'users', me, 'work', 'x') }],
    ['Read another run photo dir of mine', 'Read', { file_path: photo(me, 'run-other-000') }],
    ['Write into own transcripts', 'Write', { file_path: tr(me, 'new.txt'), content: 'x' }],
    ['Write into own photo dir', 'Write', { file_path: photo(me), content: 'x' }],
    ['Write own chat db', 'Write', { file_path: p(fx.data, 'users', me, 'chat.db'), content: 'x' }],
    // wildcards in the user segment or above it
    ...['*', '?ob', '[b]ob', '{alice,bob}', '[a-z]*'].flatMap((seg) => [
      [`Read wildcard user segment ${seg}`, 'Read', { file_path: p(fx.root, seg, 'profile.md') }],
      [`Grep wildcard user segment ${seg}`, 'Grep', { pattern: 'x', path: p(fx.root, seg) }],
      [`Glob wildcard user segment ${seg}`, 'Glob', { pattern: '*', path: p(fx.root, seg) }],
    ]),
    [
      'Glob wildcard in the data users segment',
      'Glob',
      { pattern: '*', path: p(fx.data, 'users', '*', 'transcripts') },
    ],
    // parent directories and the roots themselves
    ...wide.flatMap((d) => [
      [`Grep path ${path.basename(d)}`, 'Grep', { pattern: 'x', path: d }],
      [`Glob path ${path.basename(d)}`, 'Glob', { pattern: '*', path: d }],
      [`Read path ${path.basename(d)}`, 'Read', { file_path: d }],
    ]),
    ['Glob pattern into the other user from the parent', 'Glob', { pattern: `${other}/**`, path: fx.root }],
    // relative paths
    ['Read relative other', 'Read', { file_path: `${other}/profile.md` }],
    ['Read relative dot', 'Read', { file_path: './profile.md' }],
    ['Read bare name', 'Read', { file_path: 'profile.md' }],
    ['Grep relative dot', 'Grep', { pattern: 'x', path: '.' }],
    ['Glob relative path', 'Glob', { pattern: '*', path: 'history' }],
    ['Write relative', 'Write', { file_path: 'x.md', content: 'x' }],
    // symlinks planted inside the user's own folders
    ['Read through a memory symlink', 'Read', { file_path: p(mine, 'link-to-other', 'profile.md') }],
    ['Grep through a memory symlink', 'Grep', { pattern: 'x', path: p(mine, 'link-to-other') }],
    ['Glob through a memory symlink', 'Glob', { pattern: '*', path: p(mine, 'link-to-other') }],
    [
      'Write through a memory symlink',
      'Write',
      { file_path: p(mine, 'link-to-other', 'x.md'), content: 'x' },
    ],
    ['Read through a transcripts symlink', 'Read', { file_path: tr(me, 'escape/a.txt') }],
    ['Grep through a transcripts symlink', 'Grep', { pattern: 'x', path: tr(me, 'escape') }],
    // parent hops and sibling-prefix names
    ['Read with parent hop', 'Read', { file_path: p(mine, '..', other, 'profile.md') }],
    [
      'Grep with parent hop',
      'Grep',
      { pattern: 'x', path: p(fx.data, 'users', me, 'transcripts', '..', '..', other, 'transcripts') },
    ],
    ['Write with parent hop', 'Write', { file_path: `${mine}/../${other}/x.md`, content: 'x' }],
    ['Read sibling prefix of memory folder', 'Read', { file_path: `${mine}-evil/x` }],
    [
      'Read sibling prefix of transcripts folder',
      'Read',
      { file_path: `${p(fx.data, 'users', me, 'transcripts')}-evil/x` },
    ],
    // missing or wrongly typed arguments
    ['Grep without path', 'Grep', { pattern: 'x' }],
    ['Glob without path', 'Glob', { pattern: '*.md' }],
    ['Glob without pattern', 'Glob', { path: mine }],
    ['Read without file_path', 'Read', {}],
    ['Write without file_path', 'Write', { content: 'x' }],
    ['Read non-string path', 'Read', { file_path: 123 }],
    ['Grep non-string path', 'Grep', { pattern: 'x', path: ['/a'] }],
    ['Read null path', 'Read', { file_path: null }],
    ['Read with control character path', 'Read', { file_path: `${mine}/a\nb` }],
    // patterns
    ...['**/*', '**/*.md', '*.md', 'history/**/*.md'].flatMap((pat) =>
      [
        ['memory root', fx.root],
        ["the other user's folder", p(fx.root, other)],
        ['the data root', fx.data],
        ['the parent of the memory root', path.dirname(fx.root)],
      ].map(([what, dir]) => [`Glob ${pat} over ${what}`, 'Glob', { pattern: pat, path: dir }]),
    ),
    ['Grep glob filter ** over the memory root', 'Grep', { pattern: 'x', path: fx.root, glob: '**/*.md' }],
    ['Glob ** pattern with parent hop', 'Glob', { pattern: `**/../${other}/*`, path: mine }],
    ['Glob ** pattern with trailing parent hop', 'Glob', { pattern: '**/..', path: mine }],
    ['Glob ** pattern absolute', 'Glob', { pattern: `/${'**'}/*`, path: mine }],
    ['Glob brace pattern', 'Glob', { pattern: '{a,b}/*.md', path: mine }],
    ['Glob brace parent hop', 'Glob', { pattern: '{..,x}/*', path: mine }],
    ['Glob bracket parent hop', 'Glob', { pattern: '[.][.]/*', path: mine }],
    ['Glob bracket class', 'Glob', { pattern: 'a[0-9].md', path: mine }],
    ['Glob closing bracket only', 'Glob', { pattern: 'a].md', path: mine }],
    ['Grep brace glob filter', 'Grep', { pattern: 'x', path: mine, glob: '*.{md,txt}' }],
    ['Grep bracket glob filter', 'Grep', { pattern: 'x', path: mine, glob: '[.][.]/*' }],
    ['Glob pattern with a control character', 'Glob', { pattern: '*.md\nx', path: mine }],
    ['Glob ** without path', 'Glob', { pattern: '**/*' }],
    ['Glob pattern starting with /', 'Glob', { pattern: `${fx.root}/*/profile.md`, path: mine }],
    ['Glob pattern with parent hop', 'Glob', { pattern: `../${other}/*`, path: mine }],
    ['Glob pattern with home', 'Glob', { pattern: '~/x', path: mine }],
    ['Grep glob filter with parent hop', 'Grep', { pattern: 'x', path: mine, glob: `../${other}/*` }],
    ['Grep glob filter absolute', 'Grep', { pattern: 'x', path: mine, glob: '/etc/*' }],
    // connectors
    ['other Onyx connector', 'mcp__claude_ai_Onyx_-_' + cap(other) + '__get_user_settings', {}],
    ['Gmail', 'mcp__claude_ai_Gmail__search_threads', {}],
    ['Drive', 'mcp__claude_ai_Google_Drive__search_files', {}],
    // tools not on the list
    ['Agent', 'Agent', { subagent_type: 'Explore', prompt: 'look around' }],
    ['Task', 'Task', { prompt: 'x' }],
    ['Skill', 'Skill', { skill: 'x' }],
    ['NotebookEdit', 'NotebookEdit', { notebook_path: mem(me, 'n.ipynb') }],
    ['TodoWrite', 'TodoWrite', { todos: [] }],
  ];
};

test('chat run: each user may use their own data and tools', { skip }, async () => {
  for (const me of ['alice', 'bob']) {
    for (const [label, tool, input] of allowedFor(me)) {
      const r = await call(chatEnv(me), tool, input);
      assert.equal(r.decision, 'allow', `${me}: ${label} should be allowed (${r.reason})`);
    }
  }
});

test(
  'chat run: shared-file and connector lists are not expanded against the working directory',
  { skip },
  async () => {
    const cwd = tmpDir('ac-hook-cwd-');
    try {
      for (const f of ['other.md', 'mcp__Gmail__x']) fs.writeFileSync(path.join(cwd, f), 'x');
      const env = chatEnv('alice', {
        APOLLO_SHARED_FILES: '*.md persona.md',
        APOLLO_CONNECTORS_alice: 'mcp__*',
      });
      // '*.md' is not a plain filename, so it is ignored (and never expanded to other.md); persona.md still works.
      assert.equal(
        (await call(env, 'Read', { file_path: p(fx.root, 'other.md') }, { cwd })).decision,
        'deny',
      );
      assert.equal(
        (await call(env, 'Read', { file_path: p(fx.root, 'persona.md') }, { cwd })).decision,
        'allow',
      );
      // A connector glob still matches by pattern, not by files in the working directory.
      const env2 = chatEnv('alice', { APOLLO_CONNECTORS_alice: 'mcp__*Oura*' });
      assert.equal((await call(env2, 'mcp__Gmail__x', {}, { cwd })).decision, 'deny');
      assert.equal((await call(env2, 'mcp__claude_ai_Oura__get', {}, { cwd })).decision, 'allow');
    } finally {
      rmDir(cwd);
    }
  },
);

test('chat run: every denied input class is denied for both users', { skip }, async () => {
  for (const [me, other] of [
    ['alice', 'bob'],
    ['bob', 'alice'],
  ]) {
    for (const [label, tool, input] of deniedFor(me, other)) {
      const r = await call(chatEnv(me), tool, input);
      assert.equal(r.decision, 'deny', `${me}: ${label} should be denied`);
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
  for (const agent of ['Explore', '', 'apollo']) {
    const r = await call(chatEnv('alice'), 'Read', { file_path: mem('bob') }, { agent });
    assert.equal(r.decision, 'deny', `agent ${JSON.stringify(agent)}`);
    const ok = await call(chatEnv('alice'), 'Read', { file_path: mem('alice') }, { agent });
    assert.equal(ok.decision, 'allow', `own file, agent ${JSON.stringify(agent)}`);
  }
});

test('chat run fails closed: malformed or incomplete hook input is never allowed', { skip }, async () => {
  const inputs = {
    empty: '',
    whitespace: '  \n ',
    garbage: 'this is not json',
    truncated: '{"tool_name":"Read","tool_input":{"file_path":"' + mem('alice'),
    null: 'null',
    array: '[]',
    string: '"Read"',
    number: '5',
    'empty object': '{}',
    'no tool_name': JSON.stringify({ tool_input: { file_path: mem('alice') } }),
    'empty tool_name': JSON.stringify({ tool_name: '', tool_input: { file_path: mem('alice') } }),
    'numeric tool_name': JSON.stringify({ tool_name: 5, tool_input: { file_path: mem('alice') } }),
    'null tool_name': JSON.stringify({ tool_name: null }),
    'tool_input is a string': JSON.stringify({ tool_name: 'Read', tool_input: mem('alice') }),
    'tool_input missing': JSON.stringify({ tool_name: 'Read' }),
    'binary junk': '\u0000\u0001\u0002{',
  };
  for (const [label, raw] of Object.entries(inputs)) {
    for (const user of ['alice', 'bob']) {
      const r = await callRaw(chatEnv(user), raw);
      assert.equal(r.decision, 'deny', `${user}: ${label}`);
    }
  }
});

test('chat run fails closed: missing or invalid user, data directory or run id', { skip }, async () => {
  for (const user of [undefined, '', 'mallory', 'ALICE', '../alice', 'alice bob', 'alice\n', 'a*']) {
    for (const [tool, input] of [
      ['Read', { file_path: mem('alice') }],
      ['WebSearch', { query: 'x' }],
      ['mcp__claude_ai_Oura__get_daily_sleep', {}],
    ]) {
      const r = await call(chatEnv(user), tool, input);
      assert.equal(r.decision, 'deny', `user=${JSON.stringify(user)} ${tool}`);
    }
  }
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
  for (const run of [undefined, '', 'short', '../x', 'run id with spaces', 'x'.repeat(65)]) {
    const env = chatEnv('alice');
    if (run === undefined) delete env.APOLLO_RUN_ID;
    else env.APOLLO_RUN_ID = run;
    assert.equal(
      (await call(env, 'Read', { file_path: mem('alice') })).decision,
      'deny',
      JSON.stringify(run),
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
  'a shared file swapped for a symlink to another user is denied (equality, not target)',
  { skip },
  async () => {
    const root2 = p(fx.dir, 'root2');
    fs.mkdirSync(p(root2, 'bob'), { recursive: true });
    fs.writeFileSync(p(root2, 'bob', 'profile.md'), 'private');
    fs.writeFileSync(p(root2, 'MEMORY.md'), 'shared');
    fs.symlinkSync(p(root2, 'bob', 'profile.md'), p(root2, 'persona.md'));
    const env = chatEnv('alice', { APOLLO_ROOT: root2 });
    assert.equal((await call(env, 'Read', { file_path: p(root2, 'persona.md') })).decision, 'deny');
    assert.equal((await call(env, 'Grep', { pattern: 'x', path: p(root2, 'persona.md') })).decision, 'deny');
    assert.equal((await call(env, 'Read', { file_path: p(root2, 'bob', 'profile.md') })).decision, 'deny');
    assert.equal((await call(env, 'Read', { file_path: p(root2, 'MEMORY.md') })).decision, 'allow');
  },
);

test('the shared file list is configurable and only plain file names count', { skip }, async () => {
  const env = chatEnv('alice', { APOLLO_SHARED_FILES: 'rules.md ../escape sub/x.md .' });
  assert.equal((await call(env, 'Read', { file_path: p(fx.root, 'rules.md') })).decision, 'allow');
  assert.equal((await call(env, 'Read', { file_path: p(fx.root, 'persona.md') })).decision, 'deny');
  assert.equal((await call(env, 'Read', { file_path: p(path.dirname(fx.root), 'escape') })).decision, 'deny');
  assert.equal((await call(env, 'Read', { file_path: p(fx.root, 'sub', 'x.md') })).decision, 'deny');
  assert.equal((await call(env, 'Read', { file_path: fx.root })).decision, 'deny');
});

test(
  'parallel runs for both users never leak: interleaved calls keep their own verdicts',
  { skip },
  async () => {
    const jobs = [];
    for (let round = 0; round < 3; round++) {
      for (const [me, other] of [
        ['alice', 'bob'],
        ['bob', 'alice'],
      ]) {
        for (const [label, tool, input] of allowedFor(me))
          jobs.push(call(chatEnv(me), tool, input).then((r) => ({ want: 'allow', r, me, label })));
        for (const [label, tool, input] of deniedFor(me, other))
          jobs.push(call(chatEnv(me), tool, input).then((r) => ({ want: 'deny', r, me, label })));
      }
    }
    const results = await Promise.all(jobs);
    assert.ok(results.length > 500);
    for (const x of results) assert.equal(x.r.decision, x.want, `${x.me}: ${x.label}`);
  },
);
