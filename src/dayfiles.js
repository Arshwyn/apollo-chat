import { HttpError } from './errors.js';
import { GatewayError } from './gatewayClient.js';

// Read-only day files of the signed-in user. The user comes from the verified session only; nothing in the
// query, headers or body is read as an identity. The same patterns as the gateway are checked here first so a
// bad request never reaches the socket.
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAME = /^[a-z0-9][a-z0-9_-]{0,63}\.md$/;
const LIMIT = /^\d{1,3}$/;
export const DEFAULT_DAYS = 30;
export const MAX_DAYS = 100;

export function isRealDate(s) {
  if (typeof s !== 'string') return false;
  const m = DATE.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 2000 || y > 2100) return false;
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

// Generic statuses only: no gateway code, path or message is passed on.
function mapError(e) {
  if (!(e instanceof GatewayError)) return e;
  if (e.code === 'not_found') return new HttpError(404, 'not found');
  if (e.code === 'too_large') return new HttpError(413, 'file too large');
  if (e.code === 'unavailable') return new HttpError(503, 'daily logs unavailable');
  return new HttpError(502, 'daily logs unavailable');
}

const bad = () => new HttpError(502, 'daily logs unavailable');

export function dayfileRoutes({ gateway }) {
  return [
    [
      'GET',
      '/api/dayfiles',
      async ({ user, url }) => {
        const rawLimit = url.searchParams.get('limit');
        const before = url.searchParams.get('before');
        let limit = DEFAULT_DAYS;
        if (rawLimit !== null) {
          limit = LIMIT.test(rawLimit) ? Number(rawLimit) : 0;
          if (limit < 1 || limit > MAX_DAYS) throw new HttpError(400, 'invalid limit');
        }
        if (before !== null && !isRealDate(before)) throw new HttpError(400, 'invalid date');
        let days;
        try {
          days = await gateway.listDayfiles({ user, limit, before: before || undefined });
        } catch (e) {
          throw mapError(e);
        }
        if (!Array.isArray(days)) throw bad();
        const clean = days.map((d) => {
          const ok =
            d &&
            isRealDate(d.date) &&
            Array.isArray(d.files) &&
            d.files.every((f) => typeof f === 'string' && NAME.test(f));
          if (!ok) throw bad();
          return { date: d.date, files: d.files };
        });
        return { days: clean, next: clean.length >= limit ? clean.at(-1).date : null };
      },
    ],
    [
      'GET',
      '/api/dayfiles/:date/:name',
      async ({ user, params }) => {
        if (!isRealDate(params.date) || !NAME.test(params.name)) throw new HttpError(400, 'invalid request');
        let out;
        try {
          out = await gateway.readDayfile({ user, date: params.date, name: params.name });
        } catch (e) {
          throw mapError(e);
        }
        if (typeof out?.text !== 'string') throw bad();
        return { date: params.date, name: params.name, text: out.text };
      },
    ],
  ];
}
