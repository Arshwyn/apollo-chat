import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, ConfigError, parseUsers } from '../src/config.js';

const base = {
  DATA_DIR: '/path/to/data',
  CF_ACCESS_TEAM_DOMAIN: 'example-team.cloudflareaccess.com',
  CF_ACCESS_AUD: 'aud-tag',
  USERS: 'a@example.com:alice,b@example.com:bob',
  GATEWAY_SOCKET_DIR: '/path/to/socket',
  APOLLO_MEMORY_ROOT: '/path/to/memory',
};

test('loads a valid configuration with defaults', () => {
  const c = loadConfig(base, { appDir: '/srv/app' });
  assert.equal(c.maxRuns, 2);
  assert.equal(c.tzName, 'UTC');
  assert.deepEqual(c.userIds, ['alice', 'bob']);
  assert.equal(c.users.get('a@example.com'), 'alice');
  assert.equal(c.photoTtlHours, 24);
  assert.equal(c.stagedPhotoTtlMinutes, 60);
});

test('STAGED_PHOTO_TTL_MINUTES is validated like the other integers', () => {
  assert.equal(loadConfig({ ...base, STAGED_PHOTO_TTL_MINUTES: '15' }).stagedPhotoTtlMinutes, 15);
  assert.equal(loadConfig({ ...base, STAGED_PHOTO_TTL_MINUTES: '' }).stagedPhotoTtlMinutes, 60);
  for (const bad of ['0', '-5', '1.5', 'soon'])
    assert.throws(() => loadConfig({ ...base, STAGED_PHOTO_TTL_MINUTES: bad }), ConfigError, bad);
});

test('refuses a DATA_DIR that is relative or inside the app directory', () => {
  assert.throws(() => loadConfig({ ...base, DATA_DIR: 'data' }), ConfigError);
  assert.throws(
    () => loadConfig({ ...base, DATA_DIR: '/srv/app/data' }, { appDir: '/srv/app' }),
    ConfigError,
  );
  assert.throws(() => loadConfig({ ...base, DATA_DIR: '/srv/app' }, { appDir: '/srv/app' }), ConfigError);
  assert.doesNotThrow(() => loadConfig({ ...base, DATA_DIR: '/srv/app-data' }, { appDir: '/srv/app' }));
});

test('rejects bad USERS, time zone and numbers', () => {
  assert.throws(() => parseUsers(''), ConfigError);
  assert.throws(() => parseUsers('nocolon'), ConfigError);
  assert.throws(() => parseUsers('a@example.com:Bad Name'), ConfigError);
  assert.throws(() => parseUsers('a@example.com:alice,A@example.com:bob'), ConfigError);
  assert.throws(() => loadConfig({ ...base, TZ_NAME: 'Not/AZone' }), ConfigError);
  assert.throws(() => loadConfig({ ...base, MAX_RUNS: '0' }), ConfigError);
});

test('MAX_PHOTOS_PER_MESSAGE defaults to 8 and is validated between 1 and 16', () => {
  assert.equal(loadConfig(base).maxPhotosPerMessage, 8);
  assert.equal(loadConfig({ ...base, MAX_PHOTOS_PER_MESSAGE: '2' }).maxPhotosPerMessage, 2);
  assert.equal(loadConfig({ ...base, MAX_PHOTOS_PER_MESSAGE: '16' }).maxPhotosPerMessage, 16);
  for (const bad of ['0', '17', '-1', '2.5', 'many'])
    assert.throws(() => loadConfig({ ...base, MAX_PHOTOS_PER_MESSAGE: bad }), ConfigError, bad);
});
