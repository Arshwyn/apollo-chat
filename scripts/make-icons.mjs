// Generates the PWA icons (a serif A inside a gold laurel wreath, no third-party artwork) into public/icons.
import fs from 'node:fs';
import sharp from 'sharp';

// Aegean palette (docs/DESIGN.md): accent blue ground, dark-mode gold wreath, dark-mode text for the A.
const BG = '#1f4e6b';
const GOLD = '#d6b360';
const STONE = '#ecebe4';

// Capital A outline of Literata (opsz 12, wght 400, the variable font's default instance in
// public/fonts, SIL OFL, see OFL-Literata.txt), traced once from the font file. Units: 705 wide,
// 700 tall, y down, baseline at y=700. The inline header mark in public/index.html uses the same
// path (test/mark.test.js keeps them identical); fill-rule evenodd cuts the counter.
const A_PATH =
  'M242 700L0 700L0 652L48 644Q66 640 74.5 630.5Q83 621 94 590L94 590L305 0L411 0L620 591Q630 616 636.5 626Q643 636 664 641L664 641L705 650L705 700L438 700L438 652L496 645Q516 642 520.5 631Q525 620 516 595L516 595L472 469L204 469L162 591Q155 611 157 625.5Q159 640 185 644L185 644L242 653L242 700M338 83L224 412L453 412L342 83L338 83';

// Wreath in a 512 canvas: two branches of 8 leaves on an arc around (256,262), open at the top.
function leaves() {
  const cy = 262;
  const R = 178;
  let s = '';
  for (const side of [-1, 1]) {
    for (let i = 0; i < 8; i++) {
      const t = i / 7;
      const ang = Math.PI / 2 + side * (0.35 + t * 2.1);
      const x = (256 + Math.cos(ang) * R).toFixed(1);
      const y = (cy + Math.sin(ang) * R).toFixed(1);
      const rot = ((ang * 180) / Math.PI + (side > 0 ? -90 : 90) + side * -30).toFixed(1);
      s += `<ellipse cx="${x}" cy="${y}" rx="${(30 - t * 6).toFixed(1)}" ry="11" transform="rotate(${rot} ${x} ${y})"/>`;
    }
  }
  return s;
}
const LEAVES = leaves();

function svg(size, { maskable = false } = {}) {
  // The wreath spans about 400 x 350 of the 512 canvas, centred on (256,280). Maskable and
  // apple-touch icons keep it inside the central 60%; the plain icons use 78%.
  const k = ((maskable ? 0.6 : 0.78) * size) / 400;
  const m = `translate(${size / 2} ${size / 2}) scale(${k.toFixed(4)}) translate(-256 -280)`;
  const radius = maskable ? 0 : size * 0.22;
  const a = 0.25;
  const art = `<g fill="${GOLD}">${LEAVES}</g><path fill="${STONE}" fill-rule="evenodd" transform="translate(${256 - (705 * a) / 2} ${262 - (700 * a) / 2}) scale(${a})" d="${A_PATH}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><rect width="${size}" height="${size}" rx="${radius}" fill="${BG}"/><g transform="${m}">${art}</g></svg>`;
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
