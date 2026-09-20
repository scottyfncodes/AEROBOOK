/**
 * Generates AEROBOOK's icon set.
 *
 *   node scripts/build-brand.mjs
 *
 * The mark takes the asymmetry of the owner's own signature — a capital "A"
 * whose left downstroke sweeps hard past the baseline into a small hook,
 * while the right stroke is short and steep — and pushes it the rest of the
 * way toward a paper-airplane silhouette: the long stroke becomes a swept
 * wing with its wingtip hook, the short stroke becomes a tail, and the
 * crossbar becomes the wing's leading edge, landing exactly on both legs
 * (a delta wing) rather than spanning past them.
 *
 * Outputs are committed, so a normal build needs neither Chromium nor this
 * script. Run it only when the mark changes.
 */
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';

const OUT = 'public/brand';
const CHROME = process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

/** The mark's paths, on a 0–100 grid. Shared by every rendering below. */
function markPaths({ legWeight, wingWeight }) {
  return `
    <path d="M56 16 L18 76 Q16.5 80 21 81" stroke-width="${legWeight}"/>
    <path d="M56 16 L70 52" stroke-width="${legWeight}"/>
    <path d="M32.5 63.5 L52 51 L67 59" stroke-width="${wingWeight}"/>`;
}

/**
 * Stroke weight is set per size rather than scaled. Weights that look right
 * at 512px fall below a pixel at 29px and disappear, so the small sizes are
 * drawn deliberately heavier.
 */
function iconSvg({ size, radiusPct, legWeight, wingWeight, inset = 0 }) {
  const r = (radiusPct / 100) * 100;
  // `inset` shrinks the mark for the maskable variant, whose art must survive
  // a 20% crop on every side. The mark also sits a touch high in its own
  // geometry, so it's nudged down slightly to sit optically centred.
  const scale = 1 - inset / 50;
  const transform = `translate(50 51.5) scale(${scale.toFixed(4)}) translate(-50 -50)`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 100 100">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#151b23"/>
      <stop offset="1" stop-color="#080b0f"/>
    </linearGradient>
    <!--
      userSpaceOnUse: the wing is a near-horizontal stroke with a small
      bounding box, which makes an objectBoundingBox gradient degenerate and
      paint nothing at all.
    -->
    <linearGradient id="ink" gradientUnits="userSpaceOnUse" x1="10" y1="15" x2="90" y2="85">
      <stop offset="0" stop-color="#ffc061"/>
      <stop offset="1" stop-color="#e2952f"/>
    </linearGradient>
  </defs>
  <rect width="100" height="100" rx="${r}" fill="url(#bg)"/>
  <rect x="0.25" y="0.25" width="99.5" height="99.5" rx="${r}" fill="none"
        stroke="#ffffff" stroke-opacity="0.07" stroke-width="0.5"/>
  <g transform="${transform}" fill="none" stroke="url(#ink)" stroke-linecap="round" stroke-linejoin="round">
    ${markPaths({ legWeight, wingWeight })}
  </g>
</svg>`;
}

const TARGETS = [
  // iOS masks the home-screen icon itself, so its PNG is drawn square.
  { file: 'icon-180.png', size: 180, radiusPct: 0, legWeight: 5.0, wingWeight: 3.4 },
  { file: 'icon-192.png', size: 192, radiusPct: 22, legWeight: 5.0, wingWeight: 3.4 },
  { file: 'icon-512.png', size: 512, radiusPct: 22, legWeight: 4.4, wingWeight: 3.0 },
  { file: 'icon-maskable-512.png', size: 512, radiusPct: 0, legWeight: 5.0, wingWeight: 3.4, inset: 12 },
];

const browser = await chromium.launch({ executablePath: CHROME });

for (const target of TARGETS) {
  const page = await browser.newPage({ viewport: { width: target.size, height: target.size } });
  await page.setContent(`<body style="margin:0">${iconSvg(target)}</body>`);
  await page.screenshot({ path: `${OUT}/${target.file}`, omitBackground: true });
  await page.close();
  console.log('wrote', target.file);
}

// Favicon stays vector so it stays crisp at 16px; heavier strokes for that.
writeFileSync(`${OUT}/icon.svg`, iconSvg({ size: 64, radiusPct: 22, legWeight: 6.0, wingWeight: 4.2 }));

// The same mark without a tile, tightly cropped, for use inside the app.
writeFileSync(
  `${OUT}/mark.svg`,
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="15 13.4 57.6 70.2" fill="none" stroke="currentColor"
     stroke-linecap="round" stroke-linejoin="round" role="img" aria-label="AEROBOOK">${markPaths({ legWeight: 5.6, wingWeight: 3.8 })}</svg>\n`,
);

console.log('wrote icon.svg and mark.svg');
await browser.close();
