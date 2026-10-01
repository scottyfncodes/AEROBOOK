/**
 * Regenerates AEROBOOK's home-screen icon set: a gold jet on the navy tile.
 *
 *   node scripts/build-brand.mjs
 *
 * Output: public/brand/icon*.png|svg
 *
 * The icons are drawn from geometry in this file. Run it when that changes;
 * the outputs are committed, so a normal build does not need Chromium.
 */
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';

const OUT = 'public/brand';
const CHROME = process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const browser = await chromium.launch({ executablePath: CHROME });

// ------------------------------------------------------------------ icons
/**
 * The home-screen icon is AEROBOOK's own: a private jet, climbing — legible
 * as an aircraft at every size down to a phone home screen, where the
 * wordmark would not be. It wears the shared house style (gold on navy) but
 * carries no other product's mark. The silhouette is Google's Material
 * Symbols "flight" glyph (Apache 2.0).
 */
const PLANE_PATH =
  'M21 16v-2l-8-5V3.5C13 2.67 12.33 2 11.5 2S10 2.67 10 3.5V9l-8 5v2l8-2.5V19l-2.5 1.5V22l4-1 4 1v-1.5L13 19v-5.5l8 2.5z';
const PLANE_VIEWBOX = 24;

/**
 * `marginPct` is how much empty tile the plane leaves on every side —
 * maskable art needs more of it, since Android crops 20% off each edge
 * before applying its own mask, and a tight silhouette would lose its
 * wingtips to that crop.
 */
function iconSvg({ size, marginPct, weightPct, radiusPct }) {
  const r = (radiusPct / 100) * size;
  const scale = (size * (1 - (2 * marginPct) / 100)) / PLANE_VIEWBOX;
  const inset = (size - PLANE_VIEWBOX * scale) / 2;
  const strokeWidth = (weightPct / 100) * PLANE_VIEWBOX;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#113a5e"/>
      <stop offset="1" stop-color="#0B2D4A"/>
    </linearGradient>
    <!-- In the plane's own units, since it is painted inside the scaled group. -->
    <linearGradient id="ink" gradientUnits="userSpaceOnUse" x1="2" y1="2" x2="22" y2="22">
      <stop offset="0" stop-color="#EBD6A6"/>
      <stop offset="0.55" stop-color="#C9A96B"/>
      <stop offset="1" stop-color="#A88849"/>
    </linearGradient>
  </defs>
  <rect width="${size}" height="${size}" rx="${r}" fill="url(#bg)"/>
  <rect x="0.5" y="0.5" width="${size - 1}" height="${size - 1}" rx="${r}" fill="none"
        stroke="#ffffff" stroke-opacity="0.07" stroke-width="1"/>
  <g transform="translate(${inset.toFixed(3)} ${inset.toFixed(3)}) scale(${scale.toFixed(6)})"
     fill="url(#ink)" stroke="url(#ink)" stroke-width="${strokeWidth.toFixed(3)}"
     stroke-linejoin="round" stroke-linecap="round">
    <path d="${PLANE_PATH}"/>
  </g>
</svg>`;
}

const TARGETS = [
  // iOS applies its own mask, so the PNG it uses is drawn square.
  { file: 'icon-180.png', size: 180, marginPct: 20, weightPct: 1.4, radiusPct: 0 },
  { file: 'icon-192.png', size: 192, marginPct: 20, weightPct: 1.3, radiusPct: 22 },
  { file: 'icon-512.png', size: 512, marginPct: 20, weightPct: 0.9, radiusPct: 22 },
  // Maskable art must survive a 20% crop on every side.
  { file: 'icon-maskable-512.png', size: 512, marginPct: 32, weightPct: 0.9, radiusPct: 0 },
];

for (const target of TARGETS) {
  const shot = await browser.newPage({ viewport: { width: target.size, height: target.size } });
  await shot.setContent(`<body style="margin:0">${iconSvg(target)}</body>`);
  await shot.screenshot({ path: `${OUT}/${target.file}`, omitBackground: true });
  await shot.close();
  console.log('wrote', target.file);
}

writeFileSync(`${OUT}/icon.svg`, iconSvg({ size: 64, marginPct: 20, weightPct: 1.8, radiusPct: 22 }));
console.log('wrote icon.svg');

await browser.close();
