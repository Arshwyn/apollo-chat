// Read-only access to a user's Apollo day files: <memoryRoot>/<user>/history/YYYY/MM/DD/<name>.md.
//
// Every request field is validated by validateDayfileRequest (one shared function) and paths are only ever built
// from the validated parts, never from a client string. Errors carry generic codes only: no path, errno or
// content ever leaves this module.

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
