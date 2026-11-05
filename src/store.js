import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { USER_ID } from './config.js';
import { nextAutoName, cleanTitle } from './naming.js';

// One SQLite file per user (users/<user>/chat.db). There is no shared database, so a store opened
// for one user physically cannot return another user's rows. The user id is validated against the
// configured set and a strict pattern before any path is built.
export function userPaths(dataDir, user) {
  if (!USER_ID.test(user)) throw new Error('invalid user');
  const root = path.join(dataDir, 'users', user);
  return {
    root,
    db: path.join(root, 'chat.db'),
    tmp: path.join(root, 'tmp'),
    transcripts: path.join(root, 'transcripts'),
    work: path.join(root, 'work'),
  };
}

export function ensureUserDirs(dataDir, user) {
  const p = userPaths(dataDir, user);
  for (const d of [path.join(dataDir, 'users'), p.root, p.tmp, p.transcripts, p.work]) {
    fs.mkdirSync(d, { recursive: true, mode: 0o700 });
    fs.chmodSync(d, 0o700);
  }
  return p;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user','assistant')),
  text TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'done' CHECK (status IN ('done','running','error','cancelled')),
  created INTEGER NOT NULL,
  photo_count INTEGER NOT NULL DEFAULT 0,
  run_id TEXT
);
CREATE INDEX IF NOT EXISTS messages_conv ON messages(conversation_id, seq);
`;

const MSG_COLS =
  'id, conversation_id AS conversationId, role, text, status, created, photo_count AS photoCount, run_id AS runId, seq';

export class UserStore {
  constructor({ dataDir, user, tzName, now = Date.now }) {
    this.user = user;
    this.tzName = tzName;
    this.now = now;
    this.paths = ensureUserDirs(dataDir, user);
    this.db = new Database(this.paths.db);
    fs.chmodSync(this.paths.db, 0o600);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(SCHEMA);
  }

  close() {
    this.db.close();
  }

  createConversation() {
    const now = this.now();
    const titles = this.db
      .prepare('SELECT title FROM conversations')
      .all()
      .map((r) => r.title);
    const c = {
      id: crypto.randomUUID(),
      title: nextAutoName(titles, now, this.tzName),
      created: now,
      updated: now,
    };
    this.db
      .prepare(
        'INSERT INTO conversations (id, title, created, updated) VALUES (@id, @title, @created, @updated)',
      )
      .run(c);
    return c;
  }

  listConversations() {
    return this.db
      .prepare('SELECT id, title, created, updated FROM conversations ORDER BY updated DESC, rowid DESC')
      .all();
  }

  getConversation(id) {
    return (
      this.db.prepare('SELECT id, title, created, updated FROM conversations WHERE id = ?').get(id) || null
    );
  }

  renameConversation(id, title) {
    const t = cleanTitle(title);
    if (!t) return { ok: false, reason: 'invalid' };
    const r = this.db.prepare('UPDATE conversations SET title = ? WHERE id = ?').run(t, id);
    return r.changes ? { ok: true, title: t } : { ok: false, reason: 'missing' };
  }

  deleteConversation(id) {
    return this.db.prepare('DELETE FROM conversations WHERE id = ?').run(id).changes > 0;
  }

  addMessage({ conversationId, role, text = '', status = 'done', photoCount = 0, runId = null }) {
    const now = this.now();
    const id = crypto.randomUUID();
    this.db
      .prepare(
        'INSERT INTO messages (id, conversation_id, role, text, status, created, photo_count, run_id) VALUES (?,?,?,?,?,?,?,?)',
      )
      .run(id, conversationId, role, text, status, now, photoCount, runId);
    this.db.prepare('UPDATE conversations SET updated = ? WHERE id = ?').run(now, conversationId);
    return this.getMessage(id);
  }

  updateMessage(id, { text, status }) {
    const cur = this.getMessage(id);
    if (!cur) return null;
    this.db
      .prepare('UPDATE messages SET text = ?, status = ? WHERE id = ?')
      .run(text ?? cur.text, status ?? cur.status, id);
    this.db.prepare('UPDATE conversations SET updated = ? WHERE id = ?').run(this.now(), cur.conversationId);
    return this.getMessage(id);
  }

  getMessage(id) {
    return this.db.prepare(`SELECT ${MSG_COLS} FROM messages WHERE id = ?`).get(id) || null;
  }

  // Newest `limit` messages older than `beforeSeq`, returned oldest first.
  getMessages(conversationId, { limit = 50, beforeSeq = null } = {}) {
    const lim = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const rows = this.db
      .prepare(
        `SELECT ${MSG_COLS} FROM messages WHERE conversation_id = ? AND (? IS NULL OR seq < ?) ORDER BY seq DESC LIMIT ?`,
      )
      .all(conversationId, beforeSeq, beforeSeq, lim);
    return rows.reverse();
  }

  allMessages(conversationId) {
    return this.db
      .prepare(`SELECT ${MSG_COLS} FROM messages WHERE conversation_id = ? ORDER BY seq`)
      .all(conversationId);
  }

  // Finished text turns before the message `beforeId`, for replay into the prompt.
  recentTurns(conversationId, beforeId, n) {
    const cur = this.getMessage(beforeId);
    const rows = this.db
      .prepare(
        `SELECT ${MSG_COLS} FROM messages WHERE conversation_id = ? AND seq < ? AND status = 'done' ORDER BY seq DESC LIMIT ?`,
      )
      .all(conversationId, cur ? cur.seq : Number.MAX_SAFE_INTEGER, n);
    return rows.reverse();
  }

  lastMessage(conversationId) {
    return (
      this.db
        .prepare(`SELECT ${MSG_COLS} FROM messages WHERE conversation_id = ? ORDER BY seq DESC LIMIT 1`)
        .get(conversationId) || null
    );
  }

  // After a restart no run can still be going: orphaned running messages become errors.
  resetRunning() {
    return this.db.prepare("UPDATE messages SET status = 'error' WHERE status = 'running'").run().changes;
  }

  conversationIds() {
    return this.db
      .prepare('SELECT id FROM conversations')
      .all()
      .map((r) => r.id);
  }

  deleteAll() {
    this.db.exec('DELETE FROM messages; DELETE FROM conversations;');
  }
}

export class StoreRegistry {
  constructor({ dataDir, userIds, tzName, now }) {
    this.args = { dataDir, tzName, now };
    this.userIds = new Set(userIds);
    this.stores = new Map();
  }

  forUser(user) {
    if (!this.userIds.has(user)) throw new Error('unknown user');
    let s = this.stores.get(user);
    if (!s) {
      s = new UserStore({ ...this.args, user });
      this.stores.set(user, s);
    }
    return s;
  }

  closeAll() {
    for (const s of this.stores.values()) s.close();
    this.stores.clear();
  }
}
