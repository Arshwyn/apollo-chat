import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const css = read('public/style.css').replace(/\/\*[\s\S]*?\*\//g, '');

// The two colour token blocks: the light set in :root and the dark set under the colour-scheme media query.
const lightBlock = /^:root \{([^}]*)\}/m.exec(css)[1];
const darkBlock = /prefers-color-scheme: dark\) \{\s*:root \{([^}]*)\}/.exec(css)[1];
const decls = (block) => [...block.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]);
const isColour = (v) => /^(#[0-9a-f]{3,8}|rgba?\(|hsla?\()/i.test(v);
const colourNames = (block) =>
  decls(block)
    .filter(([, v]) => isColour(v))
    .map(([n]) => n)
    .sort();

test('light and dark token sets define the same colour roles and declare color-scheme', () => {
  const light = colourNames(lightBlock);
  assert.ok(light.length >= 15, 'a full role set');
  assert.deepEqual(colourNames(darkBlock), light);
  assert.match(lightBlock, /color-scheme:\s*light/);
  assert.match(darkBlock, /color-scheme:\s*dark/);
  for (const role of ['--bg', '--surface', '--text', '--muted', '--line', '--accent', '--on-accent']) {
    assert.ok(light.includes(role), role);
  }
});

// Every declaration outside the token blocks, with var() references removed.
function rawValues() {
  const rest = css.replace(/^:root \{[^}]*\}/m, '').replace(/:root \{[^}]*\}/g, '');
  return [...rest.matchAll(/([a-z-]+)\s*:\s*([^;{}]+);/g)].map(([, prop, val]) => [
    prop,
    val.replace(/var\([^)]*\)/g, ''),
  ]);
}

test('no raw colour values outside the token blocks', () => {
  const names =
    /\b(white|black|red|green|blue|gray|grey|orange|yellow|purple|pink|brown|silver|gold|olive|navy|teal|maroon|aqua|lime|fuchsia|transparent)\b/i;
  for (const [prop, val] of rawValues()) {
    if (prop === 'font' || prop === 'font-family' || prop === 'src' || prop === 'unicode-range') continue;
    assert.doesNotMatch(val, /#[0-9a-f]{3,8}\b/i, `${prop}: ${val}`);
    assert.doesNotMatch(val, /\b(rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/i, `${prop}: ${val}`);
    assert.doesNotMatch(val, names, `${prop}: ${val}`);
  }
});

function rulesUsing(token) {
  const rest = css.replace(/:root \{[^}]*\}/g, '');
  return [...rest.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((m) => m[2].includes(`var(${token})`))
    .map((m) => m[1].trim().replace(/\s+/g, ' '));
}

test('gold, olive and danger keep their single semantic roles', () => {
  assert.deepEqual(rulesUsing('--gold'), ['.mark']);
  assert.deepEqual(rulesUsing('--olive'), ['.on-plan']);
  assert.deepEqual(rulesUsing('--olive-bg'), ['.on-plan']);
  assert.deepEqual(rulesUsing('--danger').sort(), [
    '#chat-list .small.danger',
    '#delete-all',
    '#offline',
    '.note.err',
  ]);
});

test('transitions exist only under prefers-reduced-motion: no-preference; mobile-first queries', () => {
  const block = /@media \(prefers-reduced-motion: no-preference\) \{([\s\S]*?)\n\}/.exec(css)[1];
  const all = css.match(/\b(transition|animation)\b/g) || [];
  const inside = block.match(/\b(transition|animation)\b/g) || [];
  assert.ok(inside.length > 0);
  assert.equal(all.length, inside.length);
  assert.doesNotMatch(css, /@media \(max-width/);
});

test('focus ring and touch targets are defined through tokens', () => {
  assert.match(css, /:focus-visible \{\s*outline: 2px solid var\(--accent\);/);
  assert.match(lightBlock, /--tap:\s*40px/);
  assert.match(css, /pointer: coarse\) \{\s*:root \{\s*--tap:\s*44px/);
});

test('the stylesheet and page make no external requests; fonts are same-origin', () => {
  for (const file of ['public/style.css', 'public/index.html']) {
    assert.doesNotMatch(read(file), /(https?:)?\/\/[a-z0-9.-]+\.[a-z]{2,}/i, file);
  }
  for (const m of css.matchAll(/url\(['"]?([^)'"]+)['"]?\)/g)) assert.match(m[1], /^\/fonts\//);
});

test('theme-color has light and dark variants and the manifest colours come from the tokens', () => {
  const html = read('public/index.html');
  assert.match(html, /name="theme-color" content="#[0-9a-f]{6}" media="\(prefers-color-scheme: light\)"/);
  assert.match(html, /name="theme-color" content="#[0-9a-f]{6}" media="\(prefers-color-scheme: dark\)"/);
  const m = JSON.parse(read('public/manifest.webmanifest'));
  const all = [...decls(lightBlock), ...decls(darkBlock)].map(([, v]) => v.toLowerCase());
  assert.ok(all.includes(m.theme_color.toLowerCase()));
  assert.ok(all.includes(m.background_color.toLowerCase()));
});

test('font licences are OFL 1.1 with an upstream copyright line', () => {
  for (const f of ['Literata', 'PublicSans']) {
    const t = read(`public/fonts/OFL-${f}.txt`);
    assert.match(t, /Copyright \d{4} The .* Project Authors/);
    assert.match(t, /SIL OPEN FONT LICENSE Version 1\.1/);
  }
});

test('coach replies take a definite width so wide tables scroll inside their frame', () => {
  const rule = /\.msg\.apollo \{([^}]*)\}/.exec(css)[1];
  assert.match(rule, /width:\s*100%/);
  assert.match(rule, /max-width:\s*var\(--measure\)/);
  assert.match(/\.table-wrap \{([^}]*)\}/.exec(css)[1], /overflow-x:\s*auto/);
});
