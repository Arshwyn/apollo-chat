// Generates the PWA icons (plain geometric sun, no third-party artwork) into public/icons.
import fs from 'node:fs';
import sharp from 'sharp';

// Aegean palette (docs/DESIGN.md): accent blue ground, gold sun.
const BG = '#1f4e6b';
const SUN = '#d6b360';

// Capital A outline of Literata (opsz 12, wght 400, the variable font's default instance in
// public/fonts, SIL OFL, see OFL-Literata.txt), traced once from the font file. Units: 705 wide,
// 700 tall, y down, baseline at y=700. The inline header mark in public/index.html uses the same
// path (test/mark.test.js keeps them identical); fill-rule evenodd cuts the counter.
export const A_PATH =
  'M242 700L0 700L0 652L48 644Q66 640 74.5 630.5Q83 621 94 590L94 590L305 0L411 0L620 591Q630 616 636.5 626Q643 636 664 641L664 641L705 650L705 700L438 700L438 652L496 645Q516 642 520.5 631Q525 620 516 595L516 595L472 469L204 469L162 591Q155 611 157 625.5Q159 640 185 644L185 644L242 653L242 700M338 83L224 412L453 412L342 83L338 83';

function svg(size, { maskable = false } = {}) {
  const c = size / 2;
  const scale = maskable ? 0.6 : 0.78; // maskable icons keep the motif inside the safe zone
  const r = size * 0.17 * (scale / 0.78);
  const inner = size * 0.25 * (scale / 0.78);
  const outer = size * 0.38 * (scale / 0.78);
  const rays = Array.from({ length: 8 }, (_, i) => {
    const a = (i * Math.PI) / 4;
    const [x1, y1] = [c + Math.cos(a) * inner, c + Math.sin(a) * inner];
    const [x2, y2] = [c + Math.cos(a) * outer, c + Math.sin(a) * outer];
    return `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${SUN}" stroke-width="${(size * 0.05).toFixed(1)}" stroke-linecap="round"/>`;
  }).join('');
  const radius = maskable ? 0 : size * 0.22;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><rect width="${size}" height="${size}" rx="${radius}" fill="${BG}"/><circle cx="${c}" cy="${c}" r="${r.toFixed(1)}" fill="${SUN}"/>${rays}</svg>`;
}

fs.mkdirSync('public/icons', { recursive: true });
const jobs = [
  ['icon-192.png', 192, {}],
  ['icon-512.png', 512, {}],
  ['icon-maskable-512.png', 512, { maskable: true }],
  ['apple-touch-icon.png', 180, { maskable: true }],
];
for (const [name, size, opts] of jobs) {
  await sharp(Buffer.from(svg(size, opts)))
    .png()
    .toFile(`public/icons/${name}`);
}
