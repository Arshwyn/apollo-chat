import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpError } from './errors.js';
import { UUID, removeRunDir, removeTranscript, removeUserFiles } from './files.js';

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

export const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' blob: data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-store',
};

export function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8' });
  res.end(data);
}

export async function readJson(req, limit = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new HttpError(413, 'too large');
    chunks.push(c);
  }
  if (size === 0) return {};
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error('shape');
    return v;
  } catch {
    throw new HttpError(400, 'invalid json');
  }
}

// Routes: [method, template, handler]. Templates use :name segments. Handlers get
// { req, res, user, params, url, services } and return a JSON body or handle the response themselves
// (returning undefined after writing).
export function createApp({
  config,
  authenticate,
  stores,
  logger,
  routes = [],
  isBusy = () => false,
  publicDir = PUBLIC_DIR,
}) {
  const table = [...coreRoutes({ config, stores, isBusy }), ...routes].map(([method, template, handler]) => ({
    method,
    template,
    handler,
    parts: template.split('/').filter(Boolean),
  }));

  function match(method, pathname) {
    const segs = pathname.split('/').filter(Boolean);
    let pathMatched = false;
    for (const r of table) {
      if (r.parts.length !== segs.length) continue;
      const params = {};
      let ok = true;
      for (let i = 0; i < segs.length && ok; i++) {
        if (r.parts[i].startsWith(':')) params[r.parts[i].slice(1)] = segs[i];
        else ok = r.parts[i] === segs[i];
      }
      if (!ok) continue;
      pathMatched = true;
      if (r.method === method) return { route: r, params };
    }
    return { pathMatched };
  }

  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    let user = null;
    let routeName = 'unmatched';
    try {
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/healthz') {
        routeName = '/healthz';
        return sendJson(res, 200, { ok: true });
      }
      user = await authenticate(req);
      const m = match(req.method, url.pathname);
      if (m.route) {
        routeName = m.route.template;
        const out = await m.route.handler({ req, res, user, params: m.params, url });
        if (out !== undefined && !res.headersSent) sendJson(res, 200, out);
        return;
      }
      if (m.pathMatched) throw new HttpError(405, 'method not allowed');
      if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
        routeName = 'static';
        return serveStatic(res, url.pathname, publicDir);
      }
      throw new HttpError(404, 'not found');
    } catch (err) {
      if (res.headersSent) {
        res.end();
      } else if (err instanceof HttpError) {
        sendJson(res, err.status, { error: err.message, ...err.extra });
      } else {
        sendJson(res, 500, { error: 'internal error' });
      }
    } finally {
      logger.request({
        user,
        method: req.method,
        route: routeName,
        status: res.statusCode,
        ms: Date.now() - started,
      });
    }
  });
  return server;
}

function serveStatic(res, pathname, publicDir) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = path.resolve(publicDir, rel);
  if (!file.startsWith(publicDir + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    throw new HttpError(404, 'not found');
  }
  const type = MIME[path.extname(file)];
  if (!type) throw new HttpError(404, 'not found');
  res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': type, 'Cache-Control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
}

function ownConversation(stores, user, id) {
  const store = stores.forUser(user);
  const conv = UUID.test(id) ? store.getConversation(id) : null;
  if (!conv) throw new HttpError(404, 'not found');
  return { store, conv };
}

function coreRoutes({ config, stores, isBusy }) {
  const dataDir = config.dataDir;
  return [
    ['GET', '/api/me', ({ user }) => ({ user })],
    [
      'GET',
      '/api/conversations',
      ({ user }) => ({ conversations: stores.forUser(user).listConversations() }),
    ],
    [
      'POST',
      '/api/conversations',
      async ({ req, user }) => {
        // The body (a client time zone) is optional and never an error: a bad one is ignored.
        const body = await readJson(req).catch(() => ({}));
        return stores.forUser(user).createConversation(body.timeZone);
      },
    ],
    [
      'GET',
      '/api/conversations/:id/messages',
      ({ user, params, url }) => {
        const { store, conv } = ownConversation(stores, user, params.id);
        const before = url.searchParams.get('before');
        const messages = store.getMessages(conv.id, {
          limit: url.searchParams.get('limit'),
          beforeSeq: before === null ? null : Number(before) || 0,
        });
        return { conversation: conv, messages };
      },
    ],
    [
      'PATCH',
      '/api/conversations/:id',
      async ({ req, user, params }) => {
        const { store, conv } = ownConversation(stores, user, params.id);
        const body = await readJson(req);
        const r = store.renameConversation(conv.id, body.title);
        if (!r.ok) throw new HttpError(400, 'invalid title');
        return { id: conv.id, title: r.title };
      },
    ],
    [
      'DELETE',
      '/api/conversations/:id',
      ({ user, params }) => {
        const { store, conv } = ownConversation(stores, user, params.id);
        if (isBusy(user)) throw new HttpError(409, 'busy', { busy: true });
        const runIds = store.allMessages(conv.id).map((m) => m.runId);
        store.deleteConversation(conv.id);
        removeTranscript(dataDir, user, conv.id);
        for (const r of runIds) removeRunDir(dataDir, user, r);
        return { ok: true };
      },
    ],
    [
      'DELETE',
      '/api/me/data',
      ({ user }) => {
        if (isBusy(user)) throw new HttpError(409, 'busy', { busy: true });
        stores.forUser(user).deleteAll();
        removeUserFiles(dataDir, user);
        return { ok: true };
      },
    ],
  ];
}
