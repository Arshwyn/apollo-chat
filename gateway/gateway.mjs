#!/usr/bin/env node
// Host-side gateway: launches `claude -p --agent apollo` for the app container over a unix socket.
//
// Dependency-free (node: built-ins only, Node 20 compatible). The app sends only
// { user, prompt, run_id, photo_paths, check_dayfile }; this script builds the argv, environment and
// working directory itself, validates every field, and never logs content.
//
// Protocol: newline-delimited JSON, one request per connection.
//   run:    {"user":"...","prompt":"...","run_id":"...","photo_paths":[...],"check_dayfile":true}
//   cancel: {"cancel":"<run_id>"}
// Responses: {"type":"line","data":"<raw stream-json line>"} ..., then
//   {"type":"exit","code":0,"signal":null,"timedOut":false,"cancelled":false,"dayfile":true|false|null}
//   or {"type":"error","code":"invalid|busy|capacity|too_large|spawn"} (generic codes only).
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const USER_ID = /^[a-z][a-z0-9_]{1,19}$/;
const RUN_ID = /^[A-Za-z0-9_-]{8,64}$/;
const MAX_REQUEST_BYTES = 256 * 1024;
const MAX_PHOTOS = 4;
const RUN_KEYS = new Set(['user', 'prompt', 'run_id', 'photo_paths', 'check_dayfile']);

const BASE_ALLOWED = ['Read', 'Write', 'Edit', 'Grep', 'Glob', 'Bash', 'WebSearch', 'WebFetch'];
// Connectors that are never available to a chat run. The host hook denies them as well.
const NEVER = [
  'mcp__claude_ai_Gmail',
  'mcp__claude_ai_Google_Calendar',
  'mcp__claude_ai_Google_Drive',
  'mcp__claude_ai_Claude_Docs',
];

export function loadGatewayConfig(env = process.env) {
  const need = (k) => {
    if (!env[k] || !path.isAbsolute(env[k])) throw new Error(`${k} must be an absolute path`);
    return env[k];
  };
  const dataDir = fs.realpathSync(need('DATA_DIR'));
  let users;
  try {
    users = JSON.parse(env.GATEWAY_USERS || '');
  } catch {
    throw new Error('GATEWAY_USERS must be JSON: {"<user>": ["<connector tool prefix>", ...], ...}');
  }
  for (const [u, list] of Object.entries(users)) {
    if (
      !USER_ID.test(u) ||
      !Array.isArray(list) ||
      !list.every((s) => typeof s === 'string' && /^mcp__[\w-]+$/.test(s))
    ) {
      throw new Error('GATEWAY_USERS has an invalid entry');
    }
  }
  if (Object.keys(users).length === 0) throw new Error('GATEWAY_USERS is empty');
  const int = (k, d) => {
    const n = env[k] === undefined || env[k] === '' ? d : Number(env[k]);
    if (!Number.isInteger(n) || n < 1) throw new Error(`${k} must be a positive integer`);
    return n;
  };
  return {
    dataDir,
    socketDir: need('SOCKET_DIR'),
    claudeBin: env.CLAUDE_BIN || 'claude',
    users,
    memoryRoot: env.APOLLO_MEMORY_ROOT ? need('APOLLO_MEMORY_ROOT') : null,
    runTimeoutMs: int('RUN_TIMEOUT_MS', 300_000),
    maxRuns: int('MAX_RUNS', 2),
    killGraceMs: int('KILL_GRACE_MS', 3000),
  };
}

export function toolLists(users, user) {
  const own = users[user];
  const others = new Set(Object.values(users).flat());
  for (const t of own) others.delete(t);
  return { allowed: [...BASE_ALLOWED, ...own], disallowed: [...NEVER, ...others] };
}

function fail(reason) {
  const e = new Error(reason);
  e.invalid = true;
  return e;
}

export function validateRun(cfg, req) {
  if (req === null || typeof req !== 'object' || Array.isArray(req)) throw fail('shape');
  for (const k of Object.keys(req)) if (!RUN_KEYS.has(k)) throw fail('field');
  const { user, prompt, run_id: runId } = req;
  if (typeof user !== 'string' || !USER_ID.test(user) || !Object.hasOwn(cfg.users, user)) throw fail('user');
  if (typeof runId !== 'string' || !RUN_ID.test(runId)) throw fail('run_id');
  if (typeof prompt !== 'string' || prompt.length === 0) throw fail('prompt');
  const photos = req.photo_paths === undefined ? [] : req.photo_paths;
  if (!Array.isArray(photos) || photos.length > MAX_PHOTOS) throw fail('photos');
  if (req.check_dayfile !== undefined && typeof req.check_dayfile !== 'boolean') throw fail('check_dayfile');
  const base = path.join(cfg.dataDir, 'users', user, 'tmp', runId) + path.sep;
  for (const p of photos) {
    if (typeof p !== 'string' || !path.isAbsolute(p) || p.includes('\0') || path.normalize(p) !== p)
      throw fail('photo');
    let real;
    try {
      real = fs.realpathSync(p);
    } catch {
      throw fail('photo');
    }
    if (!real.startsWith(base) || !fs.statSync(real).isFile()) throw fail('photo');
  }
  return { user, prompt, runId, photos, checkDayfile: req.check_dayfile === true };
}

export function buildArgv(cfg, { user, runId, photos }) {
  const { allowed, disallowed } = toolLists(cfg.users, user);
  const root = path.join(cfg.dataDir, 'users', user);
  const argv = [
    '-p',
    '--agent',
    'apollo',
    '--no-session-persistence',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--permission-mode',
    'dontAsk',
    '--allowedTools',
    allowed.join(','),
    '--disallowedTools',
    disallowed.join(','),
  ];
  const dirs = [];
  if (photos.length) dirs.push(path.join(root, 'tmp', runId));
  dirs.push(path.join(root, 'transcripts'));
  for (const d of dirs) argv.push('--add-dir', d);
  return argv;
}

export function buildEnv(cfg, user, base = process.env) {
  const env = {
    PATH: base.PATH || '/usr/local/bin:/usr/bin:/bin',
    APOLLO_USER: user,
    APOLLO_CHAT_RUN: '1',
    APOLLO_CHAT_DATA: cfg.dataDir,
  };
  if (base.HOME) env.HOME = base.HOME;
  if (base.LANG) env.LANG = base.LANG;
  return env;
}

function walkNewest(dir, depth = 0) {
  let newest = 0;
  if (depth > 5) return newest;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return newest;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) newest = Math.max(newest, walkNewest(p, depth + 1));
    else if (e.isFile()) newest = Math.max(newest, fs.statSync(p).mtimeMs);
  }
  return newest;
}

// True when a file under <memoryRoot>/<user>/history/<year>/ was written at or after `sinceMs`.
export function dayfileTouched(memoryRoot, user, sinceMs, nowMs = Date.now()) {
  if (!memoryRoot) return null;
  const year = new Date(nowMs).getUTCFullYear();
  for (const y of [year, year - 1]) {
    const newest = walkNewest(path.join(memoryRoot, user, 'history', String(y)));
    if (newest >= sinceMs - 1000) return true;
  }
  return false;
}

export function createGateway(cfg, { log = (o) => process.stdout.write(JSON.stringify(o) + '\n') } = {}) {
  const active = new Map(); // runId -> { user, child, cancelled }
  const busyUsers = new Set();

  function send(sock, obj) {
    if (!sock.destroyed && sock.writable) sock.write(JSON.stringify(obj) + '\n');
  }

  function killGroup(child, grace) {
    const sig = (s) => {
      try {
        process.kill(-child.pid, s);
      } catch {
        /* already gone */
      }
    };
    sig('SIGTERM');
    const t = setTimeout(() => sig('SIGKILL'), grace);
    t.unref();
    child.once('exit', () => clearTimeout(t));
  }

  function startRun(sock, req) {
    let run;
    try {
      run = validateRun(cfg, req);
    } catch (e) {
      return (send(sock, { type: 'error', code: e.invalid ? 'invalid' : 'spawn' }), sock.end());
    }
    if (busyUsers.has(run.user)) return (send(sock, { type: 'error', code: 'busy' }), sock.end());
    if (active.size >= cfg.maxRuns) return (send(sock, { type: 'error', code: 'capacity' }), sock.end());
    if (active.has(run.runId)) return (send(sock, { type: 'error', code: 'invalid' }), sock.end());

    const root = path.join(cfg.dataDir, 'users', run.user);
    const cwd = path.join(root, 'work');
    try {
      fs.mkdirSync(cwd, { recursive: true, mode: 0o700 });
      fs.mkdirSync(path.join(root, 'transcripts'), { recursive: true, mode: 0o700 });
    } catch {
      return (send(sock, { type: 'error', code: 'spawn' }), sock.end());
    }

    const started = Date.now();
    let child;
    try {
      child = spawn(cfg.claudeBin, buildArgv(cfg, run), {
        cwd,
        env: buildEnv(cfg, run.user),
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      return (send(sock, { type: 'error', code: 'spawn' }), sock.end());
    }
    const state = { user: run.user, child, cancelled: false, timedOut: false };
    active.set(run.runId, state);
    busyUsers.add(run.user);

    let buf = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line) send(sock, { type: 'line', data: line });
      }
    });
    child.stderr.on('data', () => {}); // drained, never stored or logged
    child.stdin.on('error', () => {});
    child.stdin.end(run.prompt);

    const timer = setTimeout(() => {
      state.timedOut = true;
      killGroup(child, cfg.killGraceMs);
    }, cfg.runTimeoutMs);

    let finished = false;
    const finish = (code, signal) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (buf) send(sock, { type: 'line', data: buf });
      active.delete(run.runId);
      busyUsers.delete(run.user);
      const dayfile = run.checkDayfile ? dayfileTouched(cfg.memoryRoot, run.user, started) : null;
      send(sock, {
        type: 'exit',
        code,
        signal,
        timedOut: state.timedOut,
        cancelled: state.cancelled,
        dayfile,
      });
      sock.end();
      log({
        t: new Date().toISOString(),
        event: 'run',
        user: run.user,
        run_id: run.runId,
        code,
        ms: Date.now() - started,
      });
    };
    child.on('error', () => {
      finish(null, null);
    });
    child.on('close', finish);
  }

  function handle(sock, req) {
    if (req && typeof req === 'object' && !Array.isArray(req) && 'cancel' in req) {
      const keys = Object.keys(req);
      const st = keys.length === 1 && typeof req.cancel === 'string' ? active.get(req.cancel) : null;
      if (st) {
        st.cancelled = true;
        killGroup(st.child, cfg.killGraceMs);
        send(sock, { type: 'cancelled' });
      } else {
        send(sock, { type: 'error', code: 'invalid' });
      }
      return sock.end();
    }
    startRun(sock, req);
  }

  const server = net.createServer((sock) => {
    let data = '';
    let handled = false;
    sock.setEncoding('utf8');
    sock.on('error', () => {});
    sock.on('data', (chunk) => {
      if (handled) return;
      data += chunk;
      if (data.length > MAX_REQUEST_BYTES) {
        handled = true;
        send(sock, { type: 'error', code: 'too_large' });
        return sock.end();
      }
      const i = data.indexOf('\n');
      if (i < 0) return;
      handled = true;
      let req;
      try {
        req = JSON.parse(data.slice(0, i));
      } catch {
        send(sock, { type: 'error', code: 'invalid' });
        return sock.end();
      }
      handle(sock, req);
    });
  });

  return {
    server,
    active,
    async listen() {
      fs.mkdirSync(cfg.socketDir, { recursive: true, mode: 0o750 });
      fs.chmodSync(cfg.socketDir, 0o750);
      const sockPath = path.join(cfg.socketDir, 'gateway.sock');
      fs.rmSync(sockPath, { force: true });
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(sockPath, resolve);
      });
      fs.chmodSync(sockPath, 0o660);
      return sockPath;
    },
    async close() {
      for (const s of active.values()) killGroup(s.child, 100);
      await new Promise((r) => server.close(r));
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cfg = loadGatewayConfig();
  const gw = createGateway(cfg);
  const sock = await gw.listen();
  process.stdout.write(
    JSON.stringify({ t: new Date().toISOString(), event: 'listening', socket: path.basename(sock) }) + '\n',
  );
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => gw.close().then(() => process.exit(0)));
}
