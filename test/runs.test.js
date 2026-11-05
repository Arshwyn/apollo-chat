import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { RunManager, stripTrailer, blockedNote } from '../src/runs.js';
import { blockCategory } from '../src/streamParser.js';
import { StoreRegistry } from '../src/store.js';
import { stagePhoto } from '../src/photos.js';
import { sweepPhotos } from '../src/sweep.js';
import { makeLogger } from '../src/log.js';
import { GatewayError } from '../src/gatewayClient.js';
import { testConfig } from './api-helpers.js';
import { tmpDir, rmDir } from './helpers.js';

const delta = (text) =>
  JSON.stringify({
    type: 'stream_event',
    event: { type: 'content_block_delta', delta: { type: 'text_delta', text } },
  });
const result = (text = '', isError = false) =>
  JSON.stringify({ type: 'result', subtype: 'success', is_error: isError, result: text });
const ok = (extra = {}) => ({
  type: 'exit',
  code: 0,
  signal: null,
  timedOut: false,
  cancelled: false,
  dayfile: null,
  ...extra,
});
const jpeg = () =>
  sharp({ create: { width: 32, height: 32, channels: 3, background: '#666' } })
    .jpeg()
    .toBuffer();

function setup(gatewayImpl, configExtra = {}, now = () => Date.now()) {
  const dataDir = tmpDir();
  const config = testConfig(dataDir, configExtra);
  const stores = new StoreRegistry({ dataDir, userIds: config.userIds, tzName: 'UTC', now });
  const logs = [];
  const calls = [];
  const gateway = {
    run: async (req, opts) => {
      calls.push(req);
      return gatewayImpl(req, opts, calls.length);
    },
    cancel: async () => true,
  };
  const runs = new RunManager({ config, stores, gateway, logger: makeLogger((l) => logs.push(l)), now });
  return { dataDir, config, stores, runs, logs, calls, done: () => (stores.closeAll(), rmDir(dataDir)) };
}

function collect(handle) {
  const seen = [];
  for (const n of ['delta', 'interim', 'tool', 'done', 'error'])
    handle.events.on(n, (d) => seen.push([n, d]));
  return seen;
}

const textStart = () =>
  JSON.stringify({
    type: 'stream_event',
    event: { type: 'content_block_start', content_block: { type: 'text' } },
  });
const toolStart = (id) =>
  JSON.stringify({
    type: 'stream_event',
    event: { type: 'content_block_start', content_block: { type: 'tool_use', id, name: 'Read' } },
  });

async function savedReply(lines) {
  const t = setup(async (_req, { onLine }) => {
    for (const l of lines) onLine(l);
    return ok();
  });
  try {
    const conv = t.stores.forUser('alice').createConversation();
    const h = t.runs.start({ user: 'alice', conversationId: conv.id, text: 'hi' });
    const seen = collect(h);
    await h.done;
    const msgs = t.stores.forUser('alice').allMessages(conv.id);
    const transcript = fs.readFileSync(
      path.join(t.dataDir, 'users', 'alice', 'transcripts', `${conv.id}.txt`),
      'utf8',
    );
    return { text: msgs.at(-1).text, seen, transcript };
  } finally {
    t.done();
  }
}

test('interim narration before a tool call is not stored, shown as done text or exported', async () => {
  const r = await savedReply([
    textStart(),
    delta('Writing the day file now.'),
    toolStart('t1'),
    textStart(),
    delta('Final answer'),
    result('Final answer'),
  ]);
  assert.equal(r.text, 'Final answer');
  assert.equal(r.seen.at(-1)[1].text, 'Final answer');
  assert.deepEqual(
    r.seen.filter((s) => s[0] === 'interim'),
    [['interim', { text: 'Writing the day file now.' }]],
  );
  assert.match(r.transcript, /apollo: Final answer/);
  assert.doesNotMatch(r.transcript, /day file now/);
});

test('a run ending in a tool call falls back to the last narration, never an empty reply', async () => {
  const r = await savedReply([textStart(), delta('Checking.'), toolStart('t1'), result('')]);
  assert.equal(r.text, 'Checking.');
});

test('stripTrailer removes only trailing housekeeping lines', () => {
  assert.equal(stripTrailer('Answer\n\nmail: none\ntemp: clean\n'), 'Answer');
  assert.equal(stripTrailer('mail: sent in the middle\nmore text'), 'mail: sent in the middle\nmore text');
  assert.equal(stripTrailer('only text'), 'only text');
});

test('a successful run saves the reply, strips the trailer, deletes photos and writes the transcript', async () => {
  const t = setup(async (req, { onLine }) => {
    assert.ok(
      req.photo_paths.every((p) => fs.existsSync(p)),
      'photos exist while the run is going',
    );
    onLine(delta('Hello '));
    onLine(delta('there\n\nmail: none\ntemp: clean'));
    onLine(result('Hello there'));
    return ok({ dayfile: true });
  });
  try {
    const conv = t.stores.forUser('alice').createConversation();
    const id = await stagePhoto({ dataDir: t.dataDir, user: 'alice', buffer: await jpeg() });
    const h = t.runs.start({ user: 'alice', conversationId: conv.id, text: 'analyze this', photoIds: [id] });
    const seen = collect(h);
    assert.equal(t.runs.isBusy('alice'), true);
    await h.done;
    assert.equal(t.runs.isBusy('alice'), false);
    assert.deepEqual(
      seen.map((s) => s[0]),
      ['delta', 'delta', 'done'],
    );
    assert.equal(seen.at(-1)[1].text, 'Hello there');
    const msgs = t.stores.forUser('alice').allMessages(conv.id);
    assert.deepEqual(
      msgs.map((m) => [m.role, m.text, m.status, m.photoCount]),
      [
        ['user', 'analyze this', 'done', 1],
        ['assistant', 'Hello there', 'done', 0],
      ],
    );
    const tmp = path.join(t.dataDir, 'users', 'alice', 'tmp');
    assert.deepEqual(fs.readdirSync(tmp), [], 'photos are gone after a successful run');
    assert.match(
      fs.readFileSync(path.join(t.dataDir, 'users', 'alice', 'transcripts', `${conv.id}.txt`), 'utf8'),
      /apollo: Hello there/,
    );
    assert.equal(
      t.logs.some((l) => l.includes('dayfile_missing')),
      false,
    );
    const req = t.calls[0];
    assert.equal(req.user, 'alice');
    assert.ok(req.prompt.includes('analyze this'));
    assert.deepEqual(Object.keys(req).sort(), ['check_dayfile', 'photo_paths', 'prompt', 'run_id', 'user']);
  } finally {
    t.done();
  }
});

test('failed runs keep photos, retry reuses them, success then deletes them', async () => {
  let n = 0;
  const t = setup(async (req, { onLine }) => {
    n++;
    if (n <= 2) return ok({ code: 1 }); // first send plus its automatic retry fail
    assert.ok(req.photo_paths.every((p) => fs.existsSync(p)));
    onLine(delta('fine now'));
    onLine(result('fine now'));
    return ok();
  });
  try {
    const conv = t.stores.forUser('alice').createConversation();
    const id = await stagePhoto({ dataDir: t.dataDir, user: 'alice', buffer: await jpeg() });
    const h = t.runs.start({ user: 'alice', conversationId: conv.id, text: 'look', photoIds: [id] });
    const seen = collect(h);
    await h.done;
    assert.equal(seen.at(-1)[0], 'error');
    assert.equal(n, 2, 'one automatic retry');
    const s = t.stores.forUser('alice');
    assert.equal(s.lastMessage(conv.id).status, 'error');
    const runDirPath = path.join(t.dataDir, 'users', 'alice', 'tmp', h.userMessage.runId);
    assert.equal(fs.readdirSync(runDirPath).length, 1, 'photo kept after failure');
    const h2 = t.runs.retry({ user: 'alice', conversationId: conv.id });
    await h2.done;
    assert.equal(s.lastMessage(conv.id).text, 'fine now');
    assert.equal(s.lastMessage(conv.id).status, 'done');
    assert.equal(fs.existsSync(runDirPath), false);
    assert.equal(s.allMessages(conv.id).length, 2, 'retry reuses the failed reply slot');
    assert.throws(
      () => t.runs.retry({ user: 'alice', conversationId: conv.id }),
      (e) => e.status === 409,
    );
  } finally {
    t.done();
  }
});

test('photos of a failed run are removed by the TTL sweep after 24 hours, and retry then says expired', async () => {
  const t = setup(async () => ok({ code: 1 }));
  try {
    const conv = t.stores.forUser('alice').createConversation();
    const id = await stagePhoto({ dataDir: t.dataDir, user: 'alice', buffer: await jpeg() });
    const h = t.runs.start({ user: 'alice', conversationId: conv.id, text: 'look', photoIds: [id] });
    await h.done;
    const dir = path.join(t.dataDir, 'users', 'alice', 'tmp', h.userMessage.runId);
    const now = Date.now();
    assert.equal(
      sweepPhotos({ dataDir: t.dataDir, userIds: ['alice'], ttlMs: 24 * 3600e3, now: now + 23 * 3600e3 }),
      0,
    );
    assert.equal(fs.existsSync(dir), true);
    assert.equal(
      sweepPhotos({ dataDir: t.dataDir, userIds: ['alice'], ttlMs: 24 * 3600e3, now: now + 25 * 3600e3 }),
      1,
    );
    assert.equal(fs.existsSync(dir), false);
    assert.throws(
      () => t.runs.retry({ user: 'alice', conversationId: conv.id }),
      (e) => e.status === 410,
    );
  } finally {
    t.done();
  }
});

test('a connector cold-start failure is retried once automatically', async () => {
  const t = setup(async (req, { onLine }, call) => {
    if (call === 1) return ok({ code: 1 });
    onLine(delta('ok second time'));
    onLine(result('ok second time'));
    return ok();
  });
  try {
    const conv = t.stores.forUser('alice').createConversation();
    const h = t.runs.start({ user: 'alice', conversationId: conv.id, text: 'hi' });
    await h.done;
    assert.equal(t.calls.length, 2);
    assert.equal(t.stores.forUser('alice').lastMessage(conv.id).text, 'ok second time');
  } finally {
    t.done();
  }
});

test('a gateway that is down ends in a generic error and keeps the user message', async () => {
  const t = setup(async () => {
    throw new GatewayError('unavailable');
  });
  try {
    const conv = t.stores.forUser('alice').createConversation();
    const h = t.runs.start({ user: 'alice', conversationId: conv.id, text: 'hi' });
    const seen = collect(h);
    await h.done;
    assert.deepEqual(seen.at(-1), [
      'error',
      { message: 'Apollo could not complete this reply.', message_id: h.assistantMessage.id },
    ]);
    assert.equal(t.stores.forUser('alice').allMessages(conv.id)[0].text, 'hi');
  } finally {
    t.done();
  }
});

test('one run per user, parallel across users', async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const t = setup(
    async (req, { onLine }) => {
      await gate;
      onLine(delta('x'));
      onLine(result('x'));
      return ok();
    },
    { maxRuns: 2 },
  );
  try {
    const a = t.stores.forUser('alice').createConversation();
    const b = t.stores.forUser('bob').createConversation();
    const ha = t.runs.start({ user: 'alice', conversationId: a.id, text: 'one' });
    assert.throws(
      () => t.runs.start({ user: 'alice', conversationId: a.id, text: 'two' }),
      (e) => e.status === 409 && e.extra.busy === true,
    );
    const hb = t.runs.start({ user: 'bob', conversationId: b.id, text: 'parallel' });
    assert.equal(t.runs.activeRunIds().size, 2);
    assert.throws(
      () => t.runs.start({ user: 'bob', conversationId: b.id, text: 'again' }),
      (e) => e.status === 409,
    );
    release();
    await Promise.all([ha.done, hb.done]);
    assert.equal(t.runs.isBusy('alice'), false);
  } finally {
    t.done();
  }
});

test('the rate limit applies per user per hour', async () => {
  const t = setup(async (req, { onLine }) => (onLine(delta('x')), onLine(result('x')), ok()), {
    rateLimitPerHour: 2,
  });
  try {
    const a = t.stores.forUser('alice').createConversation();
    const b = t.stores.forUser('bob').createConversation();
    for (const text of ['1', '2']) await t.runs.start({ user: 'alice', conversationId: a.id, text }).done;
    assert.throws(
      () => t.runs.start({ user: 'alice', conversationId: a.id, text: '3' }),
      (e) => e.status === 429 && e.extra.rateLimited,
    );
    await t.runs.start({ user: 'bob', conversationId: b.id, text: '1' }).done;
  } finally {
    t.done();
  }
});

test('the global cap rejects a run beyond MAX_RUNS', async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const t = setup(async () => (await gate, ok()), { maxRuns: 1 });
  try {
    const a = t.stores.forUser('alice').createConversation();
    const b = t.stores.forUser('bob').createConversation();
    const h = t.runs.start({ user: 'alice', conversationId: a.id, text: 'one' });
    assert.throws(
      () => t.runs.start({ user: 'bob', conversationId: b.id, text: 'two' }),
      (e) => e.status === 429,
    );
    release();
    await h.done;
  } finally {
    t.done();
  }
});

test('hook denials show a generic note and tool details never reach events', async () => {
  const t = setup(async (req, { onLine }) => {
    onLine(
      JSON.stringify({
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          content_block: {
            type: 'tool_use',
            id: 't1',
            name: 'mcp__claude_ai_Onyx_-_Alice__get_user_settings',
          },
        },
      }),
    );
    onLine(
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 't1',
              name: 'mcp__claude_ai_Onyx_-_Alice__get_user_settings',
              input: { secret: 'INPUT-SENTINEL' },
            },
          ],
        },
      }),
    );
    onLine(
      JSON.stringify({
        type: 'user',
        message: {
          content: [{ type: 'tool_result', is_error: true, content: 'apollo-isolation: REASON-SENTINEL' }],
        },
      }),
    );
    onLine(delta('Sorry.'));
    onLine(result('Sorry.'));
    return ok();
  });
  try {
    const conv = t.stores.forUser('alice').createConversation();
    const h = t.runs.start({ user: 'alice', conversationId: conv.id, text: 'hi' });
    const seen = collect(h);
    await h.done;
    const all = JSON.stringify(seen);
    assert.equal(all.includes('SENTINEL'), false);
    assert.deepEqual(
      seen.filter((s) => s[0] === 'tool'),
      [['tool', { name: 'Onyx' }]],
    );
    assert.equal(t.stores.forUser('alice').lastMessage(conv.id).text, 'Sorry.\n\nThat request was blocked.');
  } finally {
    t.done();
  }
});

test('cancel ends the run as cancelled, only for the owner', async () => {
  let abortRun;
  const t = setup((req, { onLine }) => {
    onLine(delta('partial'));
    return new Promise((resolve) => {
      abortRun = () => resolve(ok({ cancelled: true, code: null }));
    });
  });
  t.runs.gateway.cancel = async () => (abortRun(), true);
  try {
    const a = t.stores.forUser('alice').createConversation();
    const b = t.stores.forUser('bob').createConversation();
    const h = t.runs.start({ user: 'alice', conversationId: a.id, text: 'long' });
    await new Promise((r) => setTimeout(r, 20));
    await assert.rejects(t.runs.cancel({ user: 'bob', conversationId: a.id }), (e) => e.status === 404);
    await assert.rejects(t.runs.cancel({ user: 'alice', conversationId: b.id }), (e) => e.status === 404);
    await t.runs.cancel({ user: 'alice', conversationId: a.id });
    await h.done;
    const last = t.stores.forUser('alice').lastMessage(a.id);
    assert.equal(last.status, 'cancelled');
    assert.equal(last.text, 'partial');
  } finally {
    t.done();
  }
});

test('a missing day file after a trigger logs a content-free warning', async () => {
  const t = setup(
    async (req, { onLine }) => (onLine(delta('SENTINEL-REPLY')), onLine(result('x')), ok({ dayfile: false })),
  );
  try {
    const conv = t.stores.forUser('alice').createConversation();
    await t.runs.start({ user: 'alice', conversationId: conv.id, text: 'Good morning SENTINEL-TEXT' }).done;
    const warn = t.logs.filter((l) => l.includes('dayfile_missing'));
    assert.equal(warn.length, 1);
    assert.equal(t.logs.join('\n').includes('SENTINEL'), false);
    await t.runs.start({ user: 'alice', conversationId: conv.id, text: 'my knee hurts' }).done;
    assert.equal(t.logs.filter((l) => l.includes('dayfile_missing')).length, 1, 'no warning for free chat');
  } finally {
    t.done();
  }
});

test('orphaned running replies become errors after a restart', () => {
  const t = setup(async () => ok());
  try {
    const s = t.stores.forUser('alice');
    const conv = s.createConversation();
    s.addMessage({ conversationId: conv.id, role: 'assistant', status: 'running' });
    t.runs.resetOrphans();
    assert.equal(s.lastMessage(conv.id).status, 'error');
  } finally {
    t.done();
  }
});

test('validation: empty, oversized and unknown conversation', () => {
  const t = setup(async () => ok());
  try {
    const conv = t.stores.forUser('alice').createConversation();
    assert.throws(
      () => t.runs.start({ user: 'alice', conversationId: conv.id, text: '  ' }),
      (e) => e.status === 400,
    );
    assert.throws(
      () => t.runs.start({ user: 'alice', conversationId: conv.id, text: 'x'.repeat(8001) }),
      (e) => e.status === 400,
    );
    assert.throws(
      () => t.runs.start({ user: 'bob', conversationId: conv.id, text: 'x' }),
      (e) => e.status === 404,
    );
  } finally {
    t.done();
  }
});

test('a blocked call names only its category, never a path or reason', async () => {
  const t = setup(async (req, { onLine }) => {
    onLine(
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: '/PATH-SENTINEL/x' } },
          ],
        },
      }),
    );
    onLine(
      JSON.stringify({
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool-1',
              is_error: true,
              content: [{ type: 'text', text: 'apollo-isolation: REASON-SENTINEL /PATH-SENTINEL/x' }],
            },
          ],
        },
      }),
    );
    onLine(
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'tool-2',
              name: 'mcp__claude_ai_Onyx_-_Alice__get_user_settings',
              input: {},
            },
          ],
        },
      }),
    );
    onLine(
      JSON.stringify({
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool-2',
              is_error: true,
              content: 'apollo-isolation: denied',
            },
          ],
        },
      }),
    );
    onLine(delta('Here is what I can tell you.'));
    onLine(result('Here is what I can tell you.'));
    return ok();
  });
  try {
    const conv = t.stores.forUser('alice').createConversation();
    const h = t.runs.start({ user: 'alice', conversationId: conv.id, text: 'hi' });
    const seen = collect(h);
    await h.done;
    const last = t.stores.forUser('alice').lastMessage(conv.id);
    assert.equal(last.status, 'done');
    assert.equal(
      last.text,
      'Here is what I can tell you.\n\nThat request was blocked (file access, connector access).',
    );
    assert.equal(JSON.stringify(seen).includes('SENTINEL'), false);
  } finally {
    t.done();
  }
});

test('blockedNote falls back to the generic note and blockCategory is generic', () => {
  assert.equal(blockedNote(new Set()), 'That request was blocked.');
  assert.equal(blockedNote(new Set(['file access'])), 'That request was blocked (file access).');
  assert.equal(blockCategory('Grep'), 'file access');
  assert.equal(blockCategory('Bash'), 'command access');
  assert.equal(blockCategory('mcp__claude_ai_Oura__x'), 'connector access');
  assert.equal(blockCategory(undefined), 'tool access');
});
