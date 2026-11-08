import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sweepPhotos, startSweeper } from '../src/sweep.js';
import { ensureUserDirs } from '../src/store.js';
import { removeRunDir } from '../src/files.js';
import { tmpDir, rmDir } from './helpers.js';

const HOUR = 3600 * 1000;
const MIN = 60 * 1000;

function mkRun(dataDir, user, name, ageHours, now) {
  const p = ensureUserDirs(dataDir, user);
  const dir = path.join(p.tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'photo.jpg'), 'x');
  const t = new Date(now - ageHours * HOUR);
  fs.utimesSync(dir, t, t);
  return dir;
}

test('sweep removes run and staging dirs older than the TTL, keeps fresh ones', () => {
  const dataDir = tmpDir();
  try {
    const now = Date.now();
    const old = mkRun(dataDir, 'alice', 'run-old00001', 25, now);
    const oldStage = mkRun(dataDir, 'alice', 'stg-abc', 30, now);
    const fresh = mkRun(dataDir, 'alice', 'run-new00001', 2, now);
    const bobOld = mkRun(dataDir, 'bob', 'run-bobold01', 48, now);
    const removed = sweepPhotos({ dataDir, userIds: ['alice', 'bob'], ttlMs: 24 * HOUR, now });
    assert.equal(removed, 3);
    assert.equal(fs.existsSync(old), false);
    assert.equal(fs.existsSync(oldStage), false);
    assert.equal(fs.existsSync(bobOld), false);
    assert.equal(fs.existsSync(fresh), true);
  } finally {
    rmDir(dataDir);
  }
});

test('staged photos use the short TTL, run directories keep the long one', () => {
  const dataDir = tmpDir();
  try {
    const now = Date.now();
    const stgOld = mkRun(dataDir, 'alice', 'stg-' + 'a'.repeat(32), 1.5, now);
    const stgNew = mkRun(dataDir, 'alice', 'stg-' + 'b'.repeat(32), 0.5, now);
    const run90 = mkRun(dataDir, 'alice', 'run-ninety01', 1.5, now);
    const run25h = mkRun(dataDir, 'alice', 'run-old25h01', 25, now);
    const active = mkRun(dataDir, 'alice', 'run-active01', 100, now);
    const removed = sweepPhotos({
      dataDir,
      userIds: ['alice'],
      ttlMs: 24 * HOUR,
      stagedTtlMs: 60 * MIN,
      now,
      activeRunIds: new Set(['run-active01']),
    });
    assert.equal(removed, 2);
    assert.equal(fs.existsSync(stgOld), false, 'a 90 minute old staged photo is removed');
    assert.equal(fs.existsSync(stgNew), true);
    assert.equal(fs.existsSync(run90), true, 'a 90 minute old run directory is kept');
    assert.equal(fs.existsSync(run25h), false);
    assert.equal(fs.existsSync(active), true);
  } finally {
    rmDir(dataDir);
  }
});

test('the staged TTL defaults to 60 minutes and custom values are honoured', () => {
  const dataDir = tmpDir();
  try {
    const now = Date.now();
    const a = mkRun(dataDir, 'alice', 'stg-' + 'c'.repeat(32), 0.75, now);
    sweepPhotos({ dataDir, userIds: ['alice'], ttlMs: 24 * HOUR, now });
    assert.equal(fs.existsSync(a), true, 'default is 60 minutes');
    sweepPhotos({ dataDir, userIds: ['alice'], ttlMs: 24 * HOUR, stagedTtlMs: 30 * MIN, now });
    assert.equal(fs.existsSync(a), false, '30 minutes removes it');
    const r = mkRun(dataDir, 'alice', 'run-custom001', 3, now);
    sweepPhotos({ dataDir, userIds: ['alice'], ttlMs: 2 * HOUR, stagedTtlMs: 5 * MIN, now });
    assert.equal(fs.existsSync(r), false, 'a custom run TTL is honoured');
  } finally {
    rmDir(dataDir);
  }
});

test('sweep skips active runs and uses only the given users trees', () => {
  const dataDir = tmpDir();
  try {
    const now = Date.now();
    const active = mkRun(dataDir, 'alice', 'run-active01', 100, now);
    const bobOld = mkRun(dataDir, 'bob', 'run-bobold01', 100, now);
    sweepPhotos({
      dataDir,
      userIds: ['alice'],
      ttlMs: 24 * HOUR,
      now,
      activeRunIds: new Set(['run-active01']),
    });
    assert.equal(fs.existsSync(active), true);
    assert.equal(fs.existsSync(bobOld), true);
  } finally {
    rmDir(dataDir);
  }
});

test('the sweeper runs once immediately and returns a stopper', () => {
  let n = 0;
  const stop = startSweeper({ everyMs: 1e9, sweep: () => n++ });
  assert.equal(n, 1);
  stop();
});

test('removing a run dir ignores invalid ids and deletes the dir otherwise', () => {
  const dataDir = tmpDir();
  try {
    const dir = mkRun(dataDir, 'alice', 'run-gone0001', 0, Date.now());
    removeRunDir(dataDir, 'alice', '../alice');
    removeRunDir(dataDir, 'alice', null);
    assert.equal(fs.existsSync(dir), true);
    removeRunDir(dataDir, 'alice', 'run-gone0001');
    assert.equal(fs.existsSync(dir), false);
  } finally {
    rmDir(dataDir);
  }
});
