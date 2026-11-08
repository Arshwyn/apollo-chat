import { Worker } from 'node:worker_threads';
import { ImageError } from './images.js';

export const MAX_HEIC_PIXELS = 50_000_000;
export const HEIC_TIMEOUT_MS = 10_000;
const MAX_QUEUED = 16;
const WORKER_URL = new URL('./heicWorker.js', import.meta.url);

let running = 0;
let queued = 0;
let tail = Promise.resolve();

// Number of decoder threads alive right now (always 0 or 1; tests use it to see that none is left behind).
export const activeDecoders = () => running;

function decodeOnce(buffer, { maxPixels, timeoutMs }) {
  return new Promise((resolve, reject) => {
    // The upload is copied so the worker owns its bytes; nothing is written to disk.
    const copy = new Uint8Array(buffer).buffer;
    const worker = new Worker(WORKER_URL, {
      workerData: { buffer: copy, maxPixels },
      transferList: [copy],
      resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 },
    });
    running++;
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      running--;
      worker.terminate().catch(() => {});
      fn(value);
    };
    const timer = setTimeout(
      () => finish(reject, new ImageError(415, 'could not read the image')),
      timeoutMs,
    );
    worker.once('message', (m) => {
      if (m.error === 'too-large') finish(reject, new ImageError(413, 'image too large'));
      else if (m.error) finish(reject, new ImageError(415, 'could not read the image'));
      else finish(resolve, { width: m.width, height: m.height, data: Buffer.from(m.data) });
    });
    worker.once('error', () => finish(reject, new ImageError(415, 'could not read the image')));
    worker.once('exit', () => finish(reject, new ImageError(415, 'could not read the image')));
  });
}

// Decodes the primary image of a HEIC/HEIF buffer to raw RGBA in a worker thread, one at a time. Rejects with
// ImageError: 413 above `maxPixels` (checked before any pixels are decoded), 415 for anything unreadable or
// slower than `timeoutMs` (the worker is terminated).
export function decodeHeic(buffer, { maxPixels = MAX_HEIC_PIXELS, timeoutMs = HEIC_TIMEOUT_MS } = {}) {
  if (queued >= MAX_QUEUED) return Promise.reject(new ImageError(429, 'busy, try again shortly'));
  queued++;
  const job = tail.then(() => decodeOnce(buffer, { maxPixels, timeoutMs }));
  tail = job.then(
    () => undefined,
    () => undefined,
  );
  return job.finally(() => queued--);
}
