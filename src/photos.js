import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { HttpError } from './errors.js';
import { ensureUserDirs, userPaths } from './store.js';
import { sanitizeImage, ImageError, MAX_IMAGE_BYTES } from './images.js';
import { RUN_ID } from './files.js';

export const MAX_PHOTOS_PER_MESSAGE = 4;
export const MAX_MESSAGE_PHOTO_BYTES = 25 * 1024 * 1024;
const MAX_PENDING = 8;
const PHOTO_ID = /^[0-9a-f]{32}$/;

export async function readBuffer(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new HttpError(413, 'image too large');
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

// Stage one sanitised photo under users/<user>/tmp/stg-<id>/. Photos are transient: they exist only
// until the run that uses them succeeds (or the TTL sweep removes them).
export async function stagePhoto({ dataDir, user, buffer }) {
  let clean;
  try {
    clean = await sanitizeImage(buffer);
  } catch (e) {
    if (e instanceof ImageError) throw new HttpError(e.status, e.message);
    throw e;
  }
  const p = ensureUserDirs(dataDir, user);
  const pending = fs.readdirSync(p.tmp).filter((n) => n.startsWith('stg-')).length;
  if (pending >= MAX_PENDING) throw new HttpError(429, 'too many unsent photos');
  const id = crypto.randomBytes(16).toString('hex');
  const dir = path.join(p.tmp, `stg-${id}`);
  fs.mkdirSync(dir, { mode: 0o700 });
  fs.writeFileSync(path.join(dir, `${id}.${clean.ext}`), clean.buffer, { mode: 0o600 });
  return id;
}

function stagedFile(dataDir, user, id) {
  if (typeof id !== 'string' || !PHOTO_ID.test(id)) throw new HttpError(400, 'unknown photo');
  const dir = path.join(userPaths(dataDir, user).tmp, `stg-${id}`);
  if (!fs.existsSync(dir)) throw new HttpError(400, 'unknown photo');
  const name = fs.readdirSync(dir)[0];
  if (!name) throw new HttpError(400, 'unknown photo');
  return { dir, file: path.join(dir, name), name };
}

// Move staged photos into the run directory the gateway will accept paths from.
export function claimPhotos({ dataDir, user, runId, photoIds }) {
  if (!RUN_ID.test(runId)) throw new Error('invalid run id');
  if (!Array.isArray(photoIds) || photoIds.length > MAX_PHOTOS_PER_MESSAGE) {
    throw new HttpError(400, `at most ${MAX_PHOTOS_PER_MESSAGE} photos per message`);
  }
  if (new Set(photoIds).size !== photoIds.length) throw new HttpError(400, 'duplicate photo');
  const staged = photoIds.map((id) => stagedFile(dataDir, user, id));
  const total = staged.reduce((n, s) => n + fs.statSync(s.file).size, 0);
  if (total > MAX_MESSAGE_PHOTO_BYTES) throw new HttpError(413, 'photos too large');
  const dest = path.join(userPaths(dataDir, user).tmp, runId);
  fs.mkdirSync(dest, { recursive: true, mode: 0o700 });
  const paths = staged.map((s) => {
    const to = path.join(dest, s.name);
    fs.renameSync(s.file, to);
    fs.rmSync(s.dir, { recursive: true, force: true });
    return to;
  });
  return paths;
}

export function photoRoutes({ config }) {
  return [
    [
      'POST',
      '/api/photos',
      async ({ req, user }) => {
        const buffer = await readBuffer(req, MAX_IMAGE_BYTES);
        const id = await stagePhoto({ dataDir: config.dataDir, user, buffer });
        return { photoId: id };
      },
    ],
  ];
}
