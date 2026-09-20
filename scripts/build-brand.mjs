/**
 * Generates AEROBOOK's icon set.
 *
 *   node scripts/build-brand.mjs
 *
 * The mark is an "A" whose crossbar runs well past both legs, drawn in fine
 * strokes that lean forward. Outputs are committed, so a normal build needs
 * neither Chromium nor this script — run it only when the mark changes.
 */
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';

const OUT = 'public/brand';
const CHROME = process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

/**
 * Stroke weight is set per size rather than scaled. A hairline that looks
 * right at 512px falls below a pixel at 29px and disappears, so the small
 * sizes are drawn deliberately heavier.
 */
function markSvg({ size, radiusPct, legWeight, barWeight, inset = 0 }) {
  const r = (radiusPct / 100) * 100;
  // `inset` shrinks the mark for the maskable variant, whose art must survive
  // a 20% crop on every side.
  // The crossbar carries weight low in the mark, so it is nudged up a touch to
  // sit optically centred rather than mathematically centred.
  const scale = 1 - inset / 50;
  const transform = ` transform="translate(50 47.5) scale(${scale.toFixed(4)}) translate(-50 -50)"`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 100 100">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#151b23"/>
      <stop offset="1" stop-color="#080b0f"/>
    </linearGradient>
    <!--
      userSpaceOnUse: the crossbar is a horizontal stroke with a zero-height
      bounding box, which makes an objectBoundingBox gradient degenerate and
      paint nothing at all.
    -->
    <linearGradient id="ink" gradientUnits="userSpaceOnUse" x1="15" y1="20" x2="85" y2="80">
      <stop offset="0" stop-color="#ffc061"/>
      <stop offset="1" stop-color="#e2952f"/>
    </linearGradient>
  </defs>
  <rect width="100" height="100" rx="${r}" fill="url(#bg)"/>
  <rect x="0.25" y="0.25" width="99.5" height="99.5" rx="${r}" fill="none"
        stroke="#ffffff" stroke-opacity="0.07" stroke-width="0.5"/>
  <g${transform} fill="none" stroke="url(#ink)" stroke-linecap="round" stroke-linejoin="round">
    <path d="M26 80 L58 22 L72 80" stroke-width="${legWeight}"/>
    <path d="M15 62 H85" stroke-width="${barWeight}"/>
  </g>
</svg>`;
}

const TARGETS = [
  // iOS masks the home-screen icon itself, so its PNG is drawn square.
  { file: 'icon-180.png', size: 180, radiusPct: 0, legWeight: 4.6, barWeight: 3.1 },
  { file: 'icon-192.png', size: 192, radiusPct: 22, legWeight: 4.6, barWeight: 3.1 },
  { file: 'icon-512.png', size: 512, radiusPct: 22, legWeight: 4.2, barWeight: 2.7 },
  { file: 'icon-maskable-512.png', size: 512, radiusPct: 0, legWeight: 4.6, barWeight: 3.0, inset: 11 },
];

const browser = await chromium.launch({ executablePath: CHROME });

for (const target of TARGETS) {
  const page = await browser.newPage({ viewport: { width: target.size, height: target.size } });
  await page.setContent(`<body style="margin:0">${markSvg(target)}</body>`);
  await page.screenshot({ path: `${OUT}/${target.file}`, omitBackground: true });
  await page.close();
  console.log('wrote', target.file);
}

// Favicon stays vector so it stays crisp at 16px; heavier strokes for that.
writeFileSync(`${OUT}/icon.svg`, markSvg({ size: 64, radiusPct: 22, legWeight: 5.4, barWeight: 4.0 }));

// The same mark without a tile, for use inside the app.
writeFileSync(
  `${OUT}/mark.svg`,
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="10 17 80 68" fill="none" stroke="currentColor"
     stroke-linecap="round" stroke-linejoin="round" role="img" aria-label="AEROBOOK">
  <path d="M26 80 L58 22 L72 80" stroke-width="5"/>
  <path d="M15 62 H85" stroke-width="3.4"/>
</svg>\n`,
);

console.log('wrote icon.svg and mark.svg');
await browser.close();
