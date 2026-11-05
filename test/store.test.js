import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { StoreRegistry, userPaths } from '../src/store.js';
import { tmpDir, rmDir } from './helpers.js';

function setup(now = () => Date.parse('2026-11-05T10:00:00Z')) {
  const dataDir = tmpDir();
  const reg = new StoreRegistry({ dataDir, userIds: ['alice', 'bob'], tzName: 'UTC', now });
  return { dataDir, reg, done: () => (reg.closeAll(), rmDir(dataDir)) };
}

test('each user has a separate database file and unknown users are refused', () => {
  const { dataDir, reg, done } = setup();
  try {
    const a = reg.forUser('alice');
    const b = reg.forUser('bob');
    const ca = a.createConversation();
    assert.equal(a.getConversation(ca.id).id, ca.id);
    assert.equal(b.getConversation(ca.id), null);
    assert.deepEqual(b.listConversations(), []);
    assert.ok(fs.existsSync(userPaths(dataDir, 'alice').db));
    assert.ok(fs.existsSync(userPaths(dataDir, 'bob').db));
    assert.notEqual(userPaths(dataDir, 'alice').db, userPaths(dataDir, 'bob').db);
    assert.throws(() => reg.forUser('mallory'));
    assert.throws(() => reg.forUser('../bob'));
    assert.equal(fs.statSync(userPaths(dataDir, 'alice').db).mode & 0o777, 0o600);
    assert.equal(fs.statSync(userPaths(dataDir, 'alice').root).mode & 0o777, 0o700);
  } finally {
    done();
  }
});

test('conversations are auto-named per day and can be renamed and deleted', () => {
  const { reg, done } = setup();
  try {
    const s = reg.forUser('alice');
    const c1 = s.createConversation();
    const c2 = s.createConversation();
    assert.equal(c1.title, '2026-11-05');
    assert.equal(c2.title, '2026-11-05 (2)');
    assert.equal(reg.forUser('bob').createConversation().title, '2026-11-05');
    assert.deepEqual(s.renameConversation(c1.id, 'Leg day'), { ok: true, title: 'Leg day' });
    // The renamed chat freed its auto-name; the next new chat takes the first free slot, never a duplicate.
    assert.equal(s.createConversation().title, '2026-11-05');
    assert.equal(s.createConversation().title, '2026-11-05 (3)');
    assert.equal(s.renameConversation(c1.id, '  ').ok, false);
    assert.equal(s.renameConversation('missing', 'x').ok, false);
    assert.equal(s.deleteConversation(c2.id), true);
    assert.equal(s.deleteConversation(c2.id), false);
  } finally {
    done();
  }
});

test('messages persist, page, replay and orphaned runs are reset', () => {
  const { dataDir, reg } = setup();
  try {
    const s = reg.forUser('alice');
    const c = s.createConversation();
    for (let i = 0; i < 5; i++) {
      s.addMessage({ conversationId: c.id, role: 'user', text: `q${i}`, photoCount: i === 4 ? 1 : 0 });
      s.addMessage({ conversationId: c.id, role: 'assistant', text: `a${i}` });
    }
    const run = s.addMessage({ conversationId: c.id, role: 'assistant', status: 'running' });
    const page = s.getMessages(c.id, { limit: 4 });
    assert.deepEqual(
      page.map((m) => m.text),
      ['a3', 'q4', 'a4', ''],
    );
    const older = s.getMessages(c.id, { limit: 3, beforeSeq: page[0].seq });
    assert.deepEqual(
      older.map((m) => m.text),
      ['q2', 'a2', 'q3'],
    );
    assert.deepEqual(
      s.recentTurns(c.id, run.id, 3).map((m) => m.text),
      ['a3', 'q4', 'a4'],
    );
    assert.equal(s.resetRunning(), 1);
    assert.equal(s.getMessage(run.id).status, 'error');
    reg.closeAll();
    const again = new StoreRegistry({ dataDir, userIds: ['alice'], tzName: 'UTC' }).forUser('alice');
    assert.equal(again.allMessages(c.id).length, 11);
    again.close();
  } finally {
    rmDir(dataDir);
  }
});

test('the database holds no image bytes or filenames: only a photo count', () => {
  const { dataDir, reg, done } = setup();
  try {
    const s = reg.forUser('alice');
    const c = s.createConversation();
    s.addMessage({
      conversationId: c.id,
      role: 'user',
      text: 'see photo',
      photoCount: 2,
      runId: 'run-abc12345',
    });
    s.close();
    const bytes = fs.readFileSync(path.join(dataDir, 'users', 'alice', 'chat.db'));
    assert.equal(bytes.includes(Buffer.from([0xff, 0xd8, 0xff])), false);
    assert.equal(bytes.includes(Buffer.from('SENTINEL_FILENAME.jpg')), false);
    reg.stores.clear();
  } finally {
    done();
  }
});
