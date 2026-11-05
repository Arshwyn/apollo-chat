import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { buildService } from '../src/service.js';
import { createGatewayClient } from '../src/gatewayClient.js';
import { createGateway, loadGatewayConfig } from '../gateway/gateway.mjs';
import { makeLogger } from '../src/log.js';
import { testAuth, testConfig } from './api-helpers.js';
import { tmpDir, rmDir } from './helpers.js';

const FAKE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-claude.mjs');

export async function boot() {
  const root = tmpDir();
  const dataDir = path.join(root, 'data');
  const sockDir = path.join(root, 'sock');
  const memory = path.join(root, 'memory');
  fs.mkdirSync(path.join(root, 'bin'));
  fs.mkdirSync(dataDir);
  fs.mkdirSync(memory);
  fs.copyFileSync(FAKE, path.join(root, 'bin', 'fake-claude.mjs'));
  fs.chmodSync(path.join(root, 'bin', 'fake-claude.mjs'), 0o755);
  const gcfg = loadGatewayConfig({
    DATA_DIR: dataDir,
    SOCKET_DIR: sockDir,
    CLAUDE_BIN: path.join(root, 'bin', 'fake-claude.mjs'),
    GATEWAY_USERS: JSON.stringify({ alice: ['mcp__claude_ai_Oura'], bob: ['mcp__claude_ai_Onyx_-_Bob'] }),
    APOLLO_MEMORY_ROOT: memory,
    KILL_GRACE_MS: '200',
  });
  let gw = createGateway(gcfg, { log: () => {} });
  await gw.listen();
  const config = testConfig(gcfg.dataDir, { memoryRoot: memory, tzName: 'UTC' });
  const logs = [];
  const gateway = createGatewayClient({
    socketPath: path.join(sockDir, 'gateway.sock'),
    backoffMs: [100, 200, 400, 800, 1600],
  });
  const svc = buildService({
    config,
    authenticate: testAuth,
    gateway,
    logger: makeLogger((l) => logs.push(l)),
  });
  await new Promise((r) => svc.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${svc.server.address().port}`;
  const call = async (user, method, url, body, headers = {}) => {
    const res = await fetch(base + url, {
      method,
      headers: { 'x-test-user': user, ...headers },
      body: body && !Buffer.isBuffer(body) ? JSON.stringify(body) : body,
    });
    return res;
  };
  return {
    root,
    base,
    config,
    svc,
    logs,
    call,
    get gw() {
      return gw;
    },
    restartGateway: async () => {
      await gw.close();
      gw = createGateway(gcfg, { log: () => {} });
      await gw.listen();
    },
    async close() {
      await gw.close();
      await new Promise((r) => svc.server.close(r));
      svc.server.closeAllConnections?.();
      svc.close();
      rmDir(root);
    },
  };
}

export async function readSse(res) {
  const text = await res.text();
  return text
    .split('\n\n')
    .filter(Boolean)
    .map((block) => {
      const ev = /^event: (.*)$/m.exec(block)[1];
      return [ev, JSON.parse(/^data: (.*)$/m.exec(block)[1])];
    });
}

export const send = (t, user, convId, body) =>
  t.call(user, 'POST', `/api/conversations/${convId}/messages`, body, { 'content-type': 'application/json' });
export const newConv = async (t, user) =>
  (await (await t.call(user, 'POST', '/api/conversations')).json()).id;
export const photo = async (t, user) => {
  const jpg = await sharp({ create: { width: 40, height: 30, channels: 3, background: '#555' } })
    .jpeg()
    .toBuffer();
  return (await (await t.call(user, 'POST', '/api/photos', jpg)).json()).photoId;
};
