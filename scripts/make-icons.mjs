// Generates the PWA icons (plain geometric sun, no third-party artwork) into public/icons.
import fs from 'node:fs';
import sharp from 'sharp';

// Aegean palette (docs/DESIGN.md): accent blue ground, gold sun.
const BG = '#1f4e6b';
const SUN = '#d6b360';
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
