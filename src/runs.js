import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { HttpError } from './errors.js';
import { claimPhotos } from './photos.js';
import { removeRunDir, runDir } from './files.js';
import { buildPrompt } from './prompt.js';
import { createStreamParser } from './streamParser.js';
import { writeTranscript } from './transcript.js';
import { isTrigger } from './triggers.js';
import { userPaths } from './store.js';
import { GatewayError } from './gatewayClient.js';
import fs from 'node:fs';
import path from 'node:path';

const MAX_TEXT = 8000;
const HOUR = 3600 * 1000;
const TRAILER = /^(mail|temp):.*$/i;
export const BLOCKED_NOTE = 'That request was blocked.';

// "That request was blocked (file access)." Categories are generic words, never paths.
export function blockedNote(categories) {
  const list = [...categories].filter(Boolean);
  return list.length ? `That request was blocked (${list.join(', ')}).` : BLOCKED_NOTE;
}

// Apollo ends its replies with housekeeping lines (mail:, temp:). They are for the agent fleet, not
// for the person chatting, so trailing ones are removed from what the app shows and stores.
export function stripTrailer(text) {
  const lines = text.replace(/\s+$/, '').split('\n');
  while (
    lines.length &&
    (lines[lines.length - 1].trim() === '' || TRAILER.test(lines[lines.length - 1].trim()))
  )
    lines.pop();
  return lines.join('\n').trim();
}

// One run at a time per user, users in parallel, bounded globally. The CLI is launched by the host
// gateway; this class owns queueing, persistence, cleanup and the event stream for the browser.
export class RunManager {
  constructor({ config, stores, gateway, logger, now = Date.now }) {
    this.config = config;
    this.stores = stores;
    this.gateway = gateway;
    this.logger = logger;
    this.now = now;
    this.running = new Map(); // user -> state
    this.sent = new Map(); // user -> [timestamps] for the rate limit
  }

  isBusy(user) {
    return this.running.has(user);
  }

  activeRunIds() {
    return new Set([...this.running.values()].map((s) => s.runId));
  }

  resetOrphans() {
    for (const user of this.config.userIds) this.stores.forUser(user).resetRunning();
  }

  #checkRate(user) {
    const t = this.now();
    const list = (this.sent.get(user) || []).filter((x) => t - x < HOUR);
    if (list.length >= this.config.rateLimitPerHour)
      throw new HttpError(429, 'rate limit', { rateLimited: true });
    this.sent.set(user, list);
    return list;
  }

  #admit(user) {
    if (this.running.has(user)) throw new HttpError(409, 'busy', { busy: true });
    if (this.running.size >= this.config.maxRuns) throw new HttpError(429, 'busy', { busy: true });
  }

  start({ user, conversationId, text, photoIds = [] }) {
    const store = this.stores.forUser(user);
    const conv = store.getConversation(conversationId);
    if (!conv) throw new HttpError(404, 'not found');
    const clean = typeof text === 'string' ? text.trim() : '';
    if (!clean && photoIds.length === 0) throw new HttpError(400, 'empty message');
    if (clean.length > MAX_TEXT) throw new HttpError(400, 'message too long');
    this.#admit(user);
    const list = this.#checkRate(user);
    const runId = 'run-' + crypto.randomBytes(12).toString('hex');
    const photoPaths = claimPhotos({ dataDir: this.config.dataDir, user, runId, photoIds });
    list.push(this.now());
    const userMessage = store.addMessage({
      conversationId,
      role: 'user',
      text: clean,
      photoCount: photoPaths.length,
      runId,
    });
    const assistantMessage = store.addMessage({
      conversationId,
      role: 'assistant',
      status: 'running',
      runId,
    });
    return this.#launch({
      user,
      conversationId,
      runId,
      text: clean,
      photoPaths,
      userMessage,
      assistantMessage,
    });
  }

  // Re-run the last user message of a conversation whose last reply failed or was cancelled. Photos from
  // the failed run are still on disk (24 h at most), so the same run directory is reused.
  retry({ user, conversationId }) {
    const store = this.stores.forUser(user);
    const conv = store.getConversation(conversationId);
    if (!conv) throw new HttpError(404, 'not found');
    const last = store.lastMessage(conversationId);
    if (!last || last.role !== 'assistant' || !['error', 'cancelled'].includes(last.status)) {
      throw new HttpError(409, 'nothing to retry');
    }
    const turns = store.allMessages(conversationId);
    const userMessage = [...turns].reverse().find((m) => m.role === 'user');
    if (!userMessage) throw new HttpError(409, 'nothing to retry');
    this.#admit(user);
    this.#checkRate(user);
    let photoPaths = [];
    if (userMessage.photoCount > 0) {
      const dir = userMessage.runId ? runDir(this.config.dataDir, user, userMessage.runId) : null;
      photoPaths = dir && fs.existsSync(dir) ? fs.readdirSync(dir).map((n) => path.join(dir, n)) : [];
      if (photoPaths.length === 0) throw new HttpError(410, 'photos expired');
    }
    const assistantMessage = store.updateMessage(last.id, { text: '', status: 'running' });
    return this.#launch({
      user,
      conversationId,
      runId: userMessage.runId,
      text: userMessage.text,
      photoPaths,
      userMessage,
      assistantMessage,
    });
  }

  async cancel({ user, conversationId }) {
    const state = this.running.get(user);
    if (!state || state.conversationId !== conversationId) throw new HttpError(404, 'not found');
    state.cancelRequested = true;
    if (!state.started) {
      state.abort.abort();
      return;
    }
    // The request may not have reached the gateway yet; retry briefly until it is registered there.
    for (let i = 0; i < 10 && this.running.get(user) === state; i++) {
      if (await this.gateway.cancel(state.runId)) return;
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  #launch(args) {
    const events = new EventEmitter();
    const trigger = isTrigger(args.text, args.photoPaths.length, this.config.triggerPhrases);
    const state = {
      ...args,
      trigger,
      events,
      text: '',
      blocked: false,
      lastCallBlocked: false,
      blockedCategories: new Set(),
      cancelRequested: false,
      started: false,
      abort: new AbortController(),
    };
    this.running.set(args.user, state);
    const done = this.#execute(state)
      .catch(() => {})
      .finally(() => this.running.delete(args.user));
    return { userMessage: args.userMessage, assistantMessage: args.assistantMessage, events, done };
  }

  async #attempt(state, prompt) {
    const parser = createStreamParser();
    state.text = '';
    state.lastInterim = '';
    state.lastCallBlocked = false;
    let result = null;
    if (state.abort.signal.aborted || state.cancelRequested)
      return { exit: null, result, error: new GatewayError('aborted') };
    const backstop = setTimeout(() => state.abort.abort(), this.config.runTimeoutMs + 15_000);
    try {
      state.started = true;
      const exit = await this.gateway.run(
        {
          user: state.user,
          prompt,
          run_id: state.runId,
          photo_paths: state.photoPaths,
          check_dayfile: state.trigger,
        },
        {
          signal: state.abort.signal,
          onLine: (line) => {
            for (const ev of parser.push(line)) {
              if (ev.kind === 'delta') {
                state.text += ev.text;
                state.events.emit('delta', { text: ev.text });
              } else if (ev.kind === 'interim') {
                // Narration before a tool call: shown transiently, not part of the stored reply.
                state.lastInterim = ev.text;
                state.text = '';
                state.events.emit('interim', { text: ev.text });
              } else if (ev.kind === 'tool') {
                state.lastCallBlocked = false;
                state.events.emit('tool', { name: ev.name });
              } else if (ev.kind === 'blocked') {
                state.blocked = true;
                state.lastCallBlocked = true;
                state.blockedCategories.add(ev.category);
              } else if (ev.kind === 'result') result = ev;
            }
          },
        },
      );
      return { exit, result, error: null };
    } catch (e) {
      return { exit: null, result, error: e };
    } finally {
      clearTimeout(backstop);
    }
  }

  async #execute(state) {
    await Promise.resolve();
    const { user, conversationId, userMessage, assistantMessage } = state;
    const store = this.stores.forUser(user);
    const started = this.now();
    const history = store.recentTurns(conversationId, userMessage.id, this.config.replayTurns);
    const prompt = buildPrompt({
      user,
      memoryRoot: this.config.memoryRoot,
      transcriptsDir: userPaths(this.config.dataDir, user).transcripts,
      photoPaths: state.photoPaths,
      history,
      text: userMessage.text,
    });

    let res = await this.#attempt(state, prompt);
    const failedNoText = (r) =>
      state.text.trim() === '' &&
      !state.lastInterim?.trim() &&
      (r.error || r.exit?.code !== 0 || r.result?.isError);
    // A cold start can race the connectors; one automatic retry, never after a cancel.
    if (failedNoText(res) && !state.cancelRequested && !state.abort.signal.aborted)
      res = await this.#attempt(state, prompt);

    const exit = res.exit;
    const cancelled = state.cancelRequested || exit?.cancelled === true;
    let text = state.text;
    // A run that ends in a tool call has no final block: fall back to the last narration.
    if (!text.trim() && state.lastInterim?.trim()) text = state.lastInterim;
    if (!text.trim() && res.result?.text) text = res.result.text;
    if (this.config.stripTrailerLines) text = stripTrailer(text);
    // The generic note is for a reply that reports or depends on a blocked call: the last tool call was
    // blocked, or there is no text at all. A blocked call followed by a successful one is not mentioned.
    if (state.blocked && (state.lastCallBlocked || !text.trim()))
      text = (text ? text + '\n\n' : '') + blockedNote(state.blockedCategories);
    const failed =
      Boolean(res.error) || !exit || exit.code !== 0 || exit.timedOut || res.result?.isError === true;
    const status = cancelled ? 'cancelled' : failed ? 'error' : 'done';

    const saved = store.updateMessage(assistantMessage.id, { text, status });
    if (status === 'done') removeRunDir(this.config.dataDir, user, state.runId);
    try {
      writeTranscript({
        dataDir: this.config.dataDir,
        user,
        store,
        conversationId,
        timeZone: this.config.tzName,
      });
    } catch {
      this.logger.event('transcript_failed', { user });
    }
    if (status === 'done' && state.trigger && exit?.dayfile === false) {
      this.logger.event('dayfile_missing', { user, run: state.runId });
    }
    this.logger.event('run_finished', {
      user,
      run: state.runId,
      status,
      code: exit?.code ?? null,
      ms: this.now() - started,
    });
    if (status === 'error')
      state.events.emit('error', { message: 'Apollo could not complete this reply.', message_id: saved.id });
    else state.events.emit('done', { status, text, message_id: saved.id });
    state.events.emit('end');
  }
}
