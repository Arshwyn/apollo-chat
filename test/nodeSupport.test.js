// Keeps the Node support policy honest: the floor in package.json, the container image and the
// dependency-free host gateway.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel) => fs.readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');

test('the container image runs at least the Node major that engines allows', () => {
  const floor = Number(/>=\s*(\d+)/.exec(JSON.parse(read('package.json')).engines.node)?.[1]);
  assert.ok(floor >= 20);
  const majors = [...read('Dockerfile').matchAll(/^FROM\s+node:(\d+)/gm)].map((m) => Number(m[1]));
  assert.ok(majors.length > 0, 'no node base image found');
  for (const m of majors) assert.ok(m >= floor, `base image Node ${m} is below the engines floor ${floor}`);
});

// The gateway is gateway/gateway.mjs plus the sibling modules it imports with a relative path; every one of
// them may import only node: built-ins or another sibling.
test('the host gateway imports only node: built-ins and its own sibling modules', () => {
  const seen = new Set();
  const check = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const src = read(`gateway/${file}`);
    const specs = [
      ...src.matchAll(/^\s*import\s[^'"]*?from\s+['"]([^'"]+)['"]/gm),
      ...src.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm),
      ...src.matchAll(/\b(?:import|require)\(\s*['"]([^'"]+)['"]\s*\)/g),
    ].map((m) => m[1]);
    for (const s of specs) {
      if (/^\.\/[\w-]+\.mjs$/.test(s)) check(s.slice(2));
      else assert.ok(s.startsWith('node:'), `${file} imports ${s}`);
    }
  };
  check('gateway.mjs');
  assert.ok(seen.size >= 1);
  assert.deepEqual([...seen].sort(), ['dayfiles.mjs', 'gateway.mjs']);
});
