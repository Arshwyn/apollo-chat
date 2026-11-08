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
  const stores = new StoreRegistry({ dataDir, userIds: config.userIds, tzName: config.tzName, now });
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

test('a message with eight photos reaches the run with all eight paths', async () => {
  const t = setup(async (req, { onLine }) => {
    onLine(delta('ok'));
    onLine(result('ok'));
    return ok();
  });
  try {
    const conv = t.stores.forUser('alice').createConversation();
    const ids = [];
    for (let i = 0; i < 8; i++) {
      const buffer = await sharp({ create: { width: 20 + i, height: 20, channels: 3, background: '#777' } })
        .jpeg()
        .toBuffer();
      ids.push(await stagePhoto({ dataDir: t.dataDir, user: 'alice', buffer }));
    }
    const h = t.runs.start({ user: 'alice', conversationId: conv.id, text: 'analyze this', photoIds: ids });
    await h.done;
    assert.equal(t.calls[0].photo_paths.length, 8);
    assert.equal(new Set(t.calls[0].photo_paths).size, 8);
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

test('retries count toward the hourly limit and rejected retries do not', async () => {
  const t = setup(async () => ok({ code: 1 }), { rateLimitPerHour: 2 });
  try {
    const a = t.stores.forUser('alice').createConversation();
    const b = t.stores.forUser('bob').createConversation();
    await t.runs.start({ user: 'alice', conversationId: a.id, text: '1' }).done;
    await t.runs.retry({ user: 'alice', conversationId: a.id }).done;
    assert.throws(
      () => t.runs.retry({ user: 'alice', conversationId: a.id }),
      (e) => e.status === 429 && e.extra.rateLimited,
    );
    // Another user's budget is unaffected, and a retry with nothing to retry takes no slot.
    await t.runs.start({ user: 'bob', conversationId: b.id, text: '1' }).done;
    assert.throws(
      () => t.runs.retry({ user: 'bob', conversationId: t.stores.forUser('bob').createConversation().id }),
      (e) => e.status === 409,
    );
    await t.runs.retry({ user: 'bob', conversationId: b.id }).done;
  } finally {
    t.done();
  }
});

test('a run that throws outside the gateway attempt still finalises once', async () => {
  const t = setup(async (req, { onLine }) => (onLine(delta('fine')), onLine(result('fine')), ok()));
  try {
    const store = t.stores.forUser('alice');
    const c = store.createConversation();
    const real = store.recentTurns.bind(store);
    store.recentTurns = () => {
      throw new Error('SECRET-PATH boom');
    };
    const h = t.runs.start({ user: 'alice', conversationId: c.id, text: 'hello' });
    const seen = collect(h);
    let ends = 0;
    h.events.on('end', () => ends++);
    await h.done;
    assert.deepEqual(
      seen.map((s) => s[0]),
      ['error'],
    );
    assert.equal(seen[0][1].message, 'Apollo could not complete this reply.');
    assert.equal(ends, 1);
    assert.equal(store.lastMessage(c.id).status, 'error');
    assert.equal(t.runs.isBusy('alice'), false);
    assert.ok(t.logs.some((l) => l.includes('run_crashed')));
    assert.ok(!t.logs.join('').includes('SECRET-PATH'));
    store.recentTurns = real;
    const h2 = t.runs.start({ user: 'alice', conversationId: c.id, text: 'again' });
    await h2.done;
    assert.equal(store.lastMessage(c.id).status, 'done');
  } finally {
    t.done();
  }
});

test('a failing run keeps its photos for Retry, and a throw after the end event does not emit twice', async () => {
  const t = setup(async (req, { onLine }) => (onLine(delta('fine')), onLine(result('fine')), ok()));
  try {
    const store = t.stores.forUser('alice');
    const c = store.createConversation();
    const id = await stagePhoto({ dataDir: t.dataDir, user: 'alice', buffer: await jpeg() });
    const real = store.recentTurns.bind(store);
    store.recentTurns = () => {
      throw new Error('boom');
    };
    const h = t.runs.start({ user: 'alice', conversationId: c.id, text: 'p', photoIds: [id] });
    await h.done;
    const runDirPath = path.join(t.dataDir, 'users', 'alice', 'tmp');
    assert.equal(fs.readdirSync(runDirPath).length, 1, 'the run directory is kept');
    store.recentTurns = real;
    const h2 = t.runs.retry({ user: 'alice', conversationId: c.id });
    await h2.done;
    assert.equal(store.lastMessage(c.id).status, 'done');

    // A listener that throws on 'end' (after done was emitted) must not cause a second emission.
    const h3 = t.runs.start({ user: 'alice', conversationId: c.id, text: 'q' });
    const seen = collect(h3);
    let ends = 0;
    h3.events.on('end', () => {
      ends++;
      throw new Error('listener failure');
    });
    await h3.done;
    assert.deepEqual(
      seen.map((s) => s[0]).filter((n) => n !== 'delta'),
      ['done'],
    );
    assert.equal(ends, 1);
    assert.equal(store.lastMessage(c.id).status, 'done');
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

const toolUse = (id, name) =>
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input: {} }] } });
const toolResult = (id, blocked) =>
  JSON.stringify({
    type: 'user',
    message: {
      content: [
        {
          type: 'tool_result',
          tool_use_id: id,
          is_error: blocked,
          content: blocked ? 'apollo-isolation: denied' : 'fine',
        },
      ],
    },
  });

async function replyFor(lines, finalText) {
  const t = setup(async (req, { onLine }) => {
    for (const l of lines) onLine(l);
    if (finalText) onLine(delta(finalText));
    onLine(result(finalText));
    return ok();
  });
  try {
    const conv = t.stores.forUser('alice').createConversation();
    const h = t.runs.start({ user: 'alice', conversationId: conv.id, text: 'hi' });
    await h.done;
    return t.stores.forUser('alice').lastMessage(conv.id);
  } finally {
    t.done();
  }
}

test('no blocked note when a blocked call was followed by a successful tool call', async () => {
  const last = await replyFor(
    [toolUse('a', 'Glob'), toolResult('a', true), toolUse('b', 'Read'), toolResult('b', false)],
    'All good.',
  );
  assert.equal(last.status, 'done');
  assert.equal(last.text, 'All good.');
});

test('blocked note when the last tool call was blocked', async () => {
  const last = await replyFor(
    [toolUse('a', 'Read'), toolResult('a', false), toolUse('b', 'Glob'), toolResult('b', true)],
    'Partial answer.',
  );
  assert.equal(last.text, 'Partial answer.\n\nThat request was blocked (file access).');
});

test('blocked note when the final text is empty after a blocked call mid-run', async () => {
  const last = await replyFor(
    [toolUse('a', 'Glob'), toolResult('a', true), toolUse('b', 'Read'), toolResult('b', false)],
    '',
  );
  assert.equal(last.text, 'That request was blocked (file access).');
});

function clockSetup(clockRef, configExtra = { tzName: 'America/New_York' }) {
  return setup(
    async (req, { onLine }) => {
      onLine(delta('ok'));
      onLine(result('ok'));
      return ok();
    },
    configExtra,
    () => clockRef.ms,
  );
}
const clockLine = (call) =>
  /^Current date and time for this user: ([^\n]*?)\. Use this/.exec(call.prompt)?.[1];

test('the run prompt carries the local date at run time, not at start-up', async () => {
  const clock = { ms: Date.parse('2026-11-05T12:00:00Z') };
  const t = clockSetup(clock);
  try {
    const conv = t.stores.forUser('alice').createConversation();
    await t.runs.start({ user: 'alice', conversationId: conv.id, text: 'hi' }).done;
    clock.ms = Date.parse('2026-11-06T00:14:00Z');
    await t.runs.start({ user: 'alice', conversationId: conv.id, text: 'again' }).done;
    assert.equal(clockLine(t.calls[0]), 'Thursday 2026-11-05, 07:00 (America/New_York, UTC-05:00)');
    assert.equal(clockLine(t.calls[1]), 'Thursday 2026-11-05, 19:14 (America/New_York, UTC-05:00)');
  } finally {
    t.done();
  }
});

test('the client time zone wins, differs by place at the same instant and is remembered', async () => {
  const clock = { ms: Date.parse('2026-11-06T00:14:00Z') };
  const t = clockSetup(clock);
  try {
    const conv = t.stores.forUser('alice').createConversation();
    const go = (timeZone) =>
      t.runs.start({ user: 'alice', conversationId: conv.id, text: 'hi', timeZone }).done;
    await go('America/New_York');
    await go('Asia/Singapore');
    // No zone sent: the last valid one (Singapore) is used, not the configured fallback.
    await go(undefined);
    // Invalid, oversized or odd values are ignored, never an error, and do not replace the stored zone.
    for (const bad of [
      'Not/AZone',
      'x'.repeat(65),
      '../../etc',
      'UTC; rm -rf /',
      42,
      null,
      '',
      ['UTC'],
      '+05:00',
    ])
      await go(bad);
    assert.equal(clockLine(t.calls[0]), 'Thursday 2026-11-05, 19:14 (America/New_York, UTC-05:00)');
    assert.equal(clockLine(t.calls[1]), 'Friday 2026-11-06, 08:14 (Asia/Singapore, UTC+08:00)');
    for (const c of t.calls.slice(2))
      assert.equal(clockLine(c), 'Friday 2026-11-06, 08:14 (Asia/Singapore, UTC+08:00)');
    assert.equal(t.calls.length, 12);
  } finally {
    t.done();
  }
});

test('with no valid zone known the configured TZ_NAME is the fallback; zones are per user', async () => {
  const clock = { ms: Date.parse('2026-11-06T00:14:00Z') };
  const t = clockSetup(clock, { tzName: 'UTC' });
  try {
    const a = t.stores.forUser('alice').createConversation();
    const b = t.stores.forUser('bob').createConversation();
    await t.runs.start({ user: 'alice', conversationId: a.id, text: 'hi', timeZone: 'Not/AZone' }).done;
    await t.runs.start({ user: 'alice', conversationId: a.id, text: 'hi', timeZone: 'Asia/Tokyo' }).done;
    await t.runs.start({ user: 'bob', conversationId: b.id, text: 'hi' }).done;
    assert.equal(clockLine(t.calls[0]), 'Friday 2026-11-06, 00:14 (UTC, UTC+00:00)');
    assert.equal(clockLine(t.calls[1]), 'Friday 2026-11-06, 09:14 (Asia/Tokyo, UTC+09:00)');
    assert.equal(clockLine(t.calls[2]), 'Friday 2026-11-06, 00:14 (UTC, UTC+00:00)');
    assert.equal(t.logs.join('\n').includes('Tokyo'), false, 'the zone is not logged');
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
