// Runs inside a worker thread (see heic.js). Decodes the primary image of one HEIC/HEIF file to raw RGBA.
// libheif is WebAssembly: it has no file, network or process access, and this thread has its own memory limits.
import { parentPort, workerData } from 'node:worker_threads';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { HeifDecoder } = require('libheif-js/wasm-bundle');

function fail(code) {
  parentPort.postMessage({ error: code });
  process.exit(0);
}

try {
  const { buffer, maxPixels } = workerData;
  // decode() parses the container and lists the images; no pixels are decoded yet.
  const handles = new HeifDecoder().decode(new Uint8Array(buffer));
  if (!handles.length) fail('unreadable');
  // Only the primary image is decoded: thumbnails, depth maps, auxiliary and burst items are ignored.
  const handle = handles.find((h) => h.is_primary()) || handles[0];
  const width = handle.get_width();
  const height = handle.get_height();
  if (!(width > 0 && height > 0)) fail('unreadable');
  if (width * height > maxPixels) fail('too-large');
  const image = { data: new Uint8ClampedArray(width * height * 4), width, height };
  const out = await new Promise((resolve) => handle.display(image, resolve));
  if (!out) fail('unreadable');
  const data = image.data.buffer;
  parentPort.postMessage({ width, height, data }, [data]);
} catch {
  fail('unreadable');
}
