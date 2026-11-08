// Read-only access to a user's Apollo day files: <memoryRoot>/<user>/history/YYYY/MM/DD/<name>.md.
//
// Every request field is validated by validateDayfileRequest (one shared function) and paths are only ever built
// from the validated parts, never from a client string. Errors carry generic codes only: no path, errno or
// content ever leaves this module.

import fs from 'node:fs';
import path from 'node:path';

const USER_ID = /^[a-z][a-z0-9_]{1,19}$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
export const DAYFILE_NAME = /^[a-z0-9][a-z0-9_-]{0,63}\.md$/;
export const DEFAULT_LIMIT = 30;
export const MAX_LIMIT = 100;
export const MAX_DAYFILE_BYTES = 256 * 1024;

export const DAYFILE_OPS = {
  dayfiles_list: new Set(['op', 'user', 'limit', 'before']),
  dayfile_read: new Set(['op', 'user', 'date', 'name']),
};

export class DayfileError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

// A real calendar date between 2000 and 2100, as numeric parts, or null.
export function parseDate(s) {
  if (typeof s !== 'string') return null;
  const m = DATE.exec(s);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 2000 || y > 2100) return null;
  const t = new Date(Date.UTC(y, mo - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return null;
  return { year: m[1], month: m[2], day: m[3] };
}

const invalid = () => new DayfileError('invalid');

// Returns the checked request, or throws DayfileError('invalid').
export function validateDayfileRequest(cfg, req) {
  if (req === null || typeof req !== 'object' || Array.isArray(req)) throw invalid();
  const keys = typeof req.op === 'string' ? DAYFILE_OPS[req.op] : undefined;
  if (!keys || !Object.hasOwn(DAYFILE_OPS, req.op)) throw invalid();
  for (const k of Object.keys(req)) if (!keys.has(k)) throw invalid();
  const { op, user } = req;
  if (typeof user !== 'string' || !USER_ID.test(user) || !Object.hasOwn(cfg.users, user)) throw invalid();
  if (op === 'dayfile_read') {
    if (!parseDate(req.date) || typeof req.name !== 'string' || !DAYFILE_NAME.test(req.name)) throw invalid();
    return { op, user, date: req.date, name: req.name };
  }
  let limit = DEFAULT_LIMIT;
  if (req.limit !== undefined) {
    if (!Number.isInteger(req.limit) || req.limit < 1 || req.limit > MAX_LIMIT) throw invalid();
    limit = req.limit;
  }
  if (req.before !== undefined && !parseDate(req.before)) throw invalid();
  return { op, user, limit, before: req.before ?? null };
}

const MAX_FILES_PER_DAY = 50;
const YEAR_DIR = /^\d{4}$/;
const PART_DIR = /^\d{2}$/;

function lstatOrNull(p) {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
}

// The user's history folder, or null when the user has none yet. The user folder and the history folder must be
// real directories (no links) and must resolve inside the real memory root; the root is re-resolved on every
// request. Anything else, including an unset root, is 'unavailable'.
function historyRoot(cfg, user) {
  if (!cfg.memoryRoot) throw new DayfileError('unavailable');
  let memReal;
  try {
    memReal = fs.realpathSync(cfg.memoryRoot);
  } catch {
    throw new DayfileError('unavailable');
  }
  const userDir = path.join(cfg.memoryRoot, user);
  const histDir = path.join(userDir, 'history');
  const userSt = lstatOrNull(userDir);
  if (!userSt) return null;
  if (!userSt.isDirectory()) throw new DayfileError('unavailable');
  const histSt = lstatOrNull(histDir);
  if (!histSt) return null;
  if (!histSt.isDirectory()) throw new DayfileError('unavailable');
  let real;
  try {
    real = fs.realpathSync(histDir);
  } catch {
    throw new DayfileError('unavailable');
  }
  if (real !== path.join(memReal, user, 'history')) throw new DayfileError('unavailable');
  return real;
}

// Names of the real (not linked) sub-directories of `dir` whose names match `re`, newest (largest) first.
function subdirs(dir, re) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => re.test(n) && lstatOrNull(path.join(dir, n))?.isDirectory())
    .sort()
    .reverse();
}

// Regular, correctly named .md files directly inside a day folder.
function dayNames(dir) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => DAYFILE_NAME.test(n) && lstatOrNull(path.join(dir, n))?.isFile())
    .sort()
    .slice(0, MAX_FILES_PER_DAY);
}

// Newest-first page of days that have at least one eligible file. `before` is an exclusive cursor.
export function listDays(cfg, { user, limit, before }) {
  const root = historyRoot(cfg, user);
  const days = [];
  if (!root) return days;
  for (const y of subdirs(root, YEAR_DIR)) {
    for (const m of subdirs(path.join(root, y), PART_DIR)) {
      for (const d of subdirs(path.join(root, y, m), PART_DIR)) {
        const date = `${y}-${m}-${d}`;
        if (!parseDate(date) || (before && date >= before)) continue;
        const files = dayNames(path.join(root, y, m, d));
        if (files.length === 0) continue;
        days.push({ date, files });
        if (days.length >= limit) return days;
      }
    }
  }
  return days;
}
