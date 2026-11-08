import { createApp } from '../src/server.js';
import { StoreRegistry } from '../src/store.js';
import { makeLogger } from '../src/log.js';
import { HttpError } from '../src/errors.js';
import { tmpDir, rmDir } from './helpers.js';

export const NOW = Date.parse('2026-11-05T10:00:00Z');

export function testConfig(dataDir, extra = {}) {
  return {
    dataDir,
    userIds: ['alice', 'bob'],
    tzName: 'UTC',
    memoryRoot: '/path/to/memory',
    maxRuns: 2,
    rateLimitPerHour: 30,
    photoTtlHours: 24,
    stagedPhotoTtlMinutes: 60,
    replayTurns: 20,
    runTimeoutMs: 5000,
    stripTrailerLines: true,
    triggerPhrases: ['good morning', 'analyze this'],
    ...extra,
  };
}

// Test-only identity: the harness injects the authenticator, there is no switch in production code.
export function testAuth(req) {
  const u = req.headers['x-test-user'];
  if (!u) throw new HttpError(401, 'unauthorized');
  if (u === 'mallory') throw new HttpError(403, 'forbidden');
  return u;
}

export async function startApp({ routes, isBusy, configExtra, now = () => NOW, build } = {}) {
  const dataDir = tmpDir();
  const config = testConfig(dataDir, configExtra);
  const stores = new StoreRegistry({ dataDir, userIds: config.userIds, tzName: 'UTC', now });
  const logs = [];
  const logger = makeLogger((l) => logs.push(l));
  const extra = build ? build({ config, stores, logger, dataDir }) : {};
  const app = createApp({
    config,
    authenticate: testAuth,
    stores,
    logger,
    routes: routes || extra.routes || [],
    isBusy: isBusy || extra.isBusy,
  });
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.address().port}`;
  const call = async (user, method, url, body, headers = {}) => {
    const h = { ...headers };
    if (user) h['x-test-user'] = user;
    let payload = body;
    if (body !== undefined && !Buffer.isBuffer(body) && typeof body !== 'string') {
      payload = JSON.stringify(body);
      h['content-type'] = 'application/json';
    }
    const res = await fetch(base + url, { method, headers: h, body: payload });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not json */
    }
    return { status: res.status, json, text, headers: res.headers };
  };
  return {
    base,
    call,
    config,
    stores,
    logs,
    dataDir,
    extra,
    async close() {
      await new Promise((r) => app.close(r));
      app.closeAllConnections?.();
      stores.closeAll();
      await extra.close?.();
      rmDir(dataDir);
    },
  };
}
