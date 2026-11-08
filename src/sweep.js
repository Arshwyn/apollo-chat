import fs from 'node:fs';
import path from 'node:path';
import { userPaths } from './store.js';

const STAGED_PREFIX = 'stg-';

// Removes temp photo directories older than their TTL: photos staged but never sent (stg-*) use the short
// stagedTtlMs, run directories (kept after a failed or cancelled run) use ttlMs. Each user is swept only
// inside their own tmp tree. Directories of runs that are still active are never touched.
export function sweepPhotos({
  dataDir,
  userIds,
  ttlMs,
  stagedTtlMs = 60 * 60 * 1000,
  now = Date.now(),
  activeRunIds = new Set(),
}) {
  let removed = 0;
  for (const user of userIds) {
    const tmp = userPaths(dataDir, user).tmp;
    if (!fs.existsSync(tmp)) continue;
    for (const name of fs.readdirSync(tmp)) {
      if (activeRunIds.has(name)) continue;
      const p = path.join(tmp, name);
      let st;
      try {
        st = fs.lstatSync(p);
      } catch {
        continue;
      }
      const limit = name.startsWith(STAGED_PREFIX) ? stagedTtlMs : ttlMs;
      if (now - st.mtimeMs > limit) {
        fs.rmSync(p, { recursive: true, force: true });
        removed++;
      }
    }
  }
  return removed;
}

// Sweep now and then every `everyMs`. The timer is unref'd so it never keeps the process alive.
export function startSweeper({ everyMs = 30 * 60 * 1000, sweep }) {
  sweep();
  const timer = setInterval(sweep, everyMs);
  timer.unref();
  return () => clearInterval(timer);
}
