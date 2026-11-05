import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const USER_ID = /^[a-z][a-z0-9_]{1,19}$/;
const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export class ConfigError extends Error {}

function int(env, key, def, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = env[key];
  if (raw === undefined || raw === '') return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max)
    throw new ConfigError(`${key} must be an integer in ${min}..${max}`);
  return n;
}

export function parseUsers(raw) {
  const map = new Map();
  for (const part of String(raw || '').split(',')) {
    const item = part.trim();
    if (!item) continue;
    const i = item.lastIndexOf(':');
    if (i < 1) throw new ConfigError('USERS entries must look like email:user');
    const email = item.slice(0, i).trim().toLowerCase();
    const user = item.slice(i + 1).trim();
    if (!email.includes('@')) throw new ConfigError('USERS entries must look like email:user');
    if (!USER_ID.test(user)) throw new ConfigError('USERS user ids must match ' + USER_ID);
    if (map.has(email)) throw new ConfigError('USERS lists an email twice');
    map.set(email, user);
  }
  if (map.size === 0) throw new ConfigError('USERS is required');
  return map;
}

export function validateTimeZone(tz) {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: tz });
  } catch {
    throw new ConfigError('TZ_NAME is not a valid IANA time zone');
  }
  return tz;
}

export function loadConfig(env = process.env, { appDir = APP_DIR } = {}) {
  const dataDir = env.DATA_DIR;
  if (!dataDir || !path.isAbsolute(dataDir)) throw new ConfigError('DATA_DIR must be an absolute path');
  const resolved = path.resolve(dataDir);
  const rel = path.relative(appDir, resolved);
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
    throw new ConfigError('DATA_DIR must not be inside the application directory');
  }
  const team = env.CF_ACCESS_TEAM_DOMAIN;
  const aud = env.CF_ACCESS_AUD;
  if (!team || !aud) throw new ConfigError('CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD are required');
  const users = parseUsers(env.USERS);
  const socketDir = env.GATEWAY_SOCKET_DIR;
  if (!socketDir || !path.isAbsolute(socketDir))
    throw new ConfigError('GATEWAY_SOCKET_DIR must be an absolute path');
  const memoryRoot = env.APOLLO_MEMORY_ROOT;
  if (!memoryRoot || !path.isAbsolute(memoryRoot))
    throw new ConfigError('APOLLO_MEMORY_ROOT must be an absolute path');
  return {
    port: int(env, 'PORT', 8790, { max: 65535 }),
    dataDir: resolved,
    cfTeamDomain: team.replace(/^https?:\/\//, '').replace(/\/+$/, ''),
    cfAud: aud,
    users,
    userIds: [...new Set(users.values())],
    tzName: validateTimeZone(env.TZ_NAME || 'UTC'),
    socketPath: path.join(socketDir, 'gateway.sock'),
    memoryRoot: path.resolve(memoryRoot),
    runTimeoutMs: int(env, 'RUN_TIMEOUT_MS', 300_000, { min: 1000 }),
    maxRuns: int(env, 'MAX_RUNS', 2),
    rateLimitPerHour: int(env, 'RATE_LIMIT_PER_HOUR', 30),
    photoTtlHours: int(env, 'PHOTO_TTL_HOURS', 24),
    replayTurns: int(env, 'REPLAY_TURNS', 20, { max: 100 }),
    stripTrailerLines: env.STRIP_TRAILER_LINES !== '0',
    triggerPhrases: (
      env.TRIGGER_PHRASES ||
      'good morning,workout complete,food log,weekly wrap up,recalibrate,analyze this,analyse this'
    )
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  };
}
