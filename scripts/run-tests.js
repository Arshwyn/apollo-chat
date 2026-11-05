// Runs `node --test` on every test file, listed explicitly (directory arguments are rejected on Node 22+
// and globs are not expanded on Node 20). TMPDIR points at a per-run dir and the run fails if the tests
// leave anything behind in it. The hook test reads APOLLO_HOOK_PATH; unless set, it targets the proposed
// hook shipped in docs/host so the suite is reproducible without a host checkout.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const roots = ['test', 'test/hook'];
const testFiles = roots.flatMap((d) =>
  fs.existsSync(d)
    ? fs
        .readdirSync(d)
        .filter((f) => f.endsWith('.test.js'))
        .sort()
        .map((f) => path.join(d, f))
    : [],
);
const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-run-'));
const res = spawnSync(process.execPath, ['--test', ...testFiles, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: {
    ...process.env,
    TMPDIR: runDir,
    TMP: runDir,
    TEMP: runDir,
    APOLLO_HOOK_PATH:
      process.env.APOLLO_HOOK_PATH || path.resolve('docs/host/apollo-isolation-pre.proposed.sh'),
  },
});
let code = res.status === null ? 1 : res.status;
const leftovers = fs.readdirSync(runDir);
if (leftovers.length > 0) {
  console.error(`Tests left temp files behind in ${runDir}:\n  ${leftovers.join('\n  ')}`);
  code = code || 1;
}
fs.rmSync(runDir, { recursive: true, force: true });
process.exit(code);
