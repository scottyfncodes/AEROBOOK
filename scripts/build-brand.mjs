/**
 * Regenerates AEROBOOK's brand assets from the source signature.
 *
 *   node scripts/build-brand.mjs
 *
 * Input:  brand-source/signature.jpg  (dark ink on a flat light background)
 * Output: public/brand/signature.svg  (traced, tight viewBox, currentColor)
 *         public/brand/icon*.png|svg  (home-screen and favicon set)
 *
 * Run it only when the source changes; the outputs are committed so a normal
 * build needs neither Chromium nor potrace.
 */
import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { trace } from 'potrace';

const SOURCE = 'brand-source/signature.jpg';
const OUT = 'public/brand';
const CHROME = process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const browser = await chromium.launch({ executablePath: CHROME });

// ---------------------------------------------------------------- 1. matte
// Separate ink from background by distance from the sampled corner colour, so
// antialiased edges survive as partial coverage rather than being thresholded
// away. Upscale before tracing — potrace follows the pixel grid, and a larger
// bitmap yields noticeably smoother curves.
const page = await browser.newPage();
await page.setContent('<div></div>');
const ink = await page.evaluate(async (dataUrl) => {
  const img = new Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = dataUrl; });
  const w = img.naturalWidth, h = img.naturalHeight;

  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const d = ctx.getImageData(0, 0, w, h).data;

  const corners = [[2, 2], [w - 3, 2], [2, h - 3], [w - 3, h - 3]].map(([x, y]) => {
    const i = (y * w + x) * 4;
    return [d[i], d[i + 1], d[i + 2]];
  });
  const bg = [0, 1, 2].map((k) => corners.reduce((s, p) => s + p[k], 0) / corners.length);

  const dist = new Float32Array(w * h);
  let max = 0;
  for (let p = 0; p < w * h; p++) {
    const i = p * 4;
    const dr = bg[0] - d[i], dg = bg[1] - d[i + 1], db = bg[2] - d[i + 2];
    const v = Math.sqrt(dr * dr + dg * dg + db * db);
    dist[p] = v;
    if (v > max) max = v;
  }

  const FLOOR = 0.12;   // keeps JPEG noise in the background at zero coverage
  const SCALE = 4;
  const up = document.createElement('canvas');
  up.width = w * SCALE; up.height = h * SCALE;
  const uctx = up.getContext('2d');
  uctx.imageSmoothingEnabled = true;
  uctx.imageSmoothingQuality = 'high';

  const matte = document.createElement('canvas');
  matte.width = w; matte.height = h;
  const mctx = matte.getContext('2d');
  const out = mctx.createImageData(w, h);
  for (let p = 0; p < w * h; p++) {
    let a = (dist[p] / max - FLOOR) / (1 - FLOOR);
    a = a > 0 ? Math.min(1, a) : 0;
    const o = p * 4;
    out.data[o] = out.data[o + 1] = out.data[o + 2] = 0;
    out.data[o + 3] = Math.round(a * 255);
  }
  mctx.putImageData(out, 0, 0);

  uctx.fillStyle = '#ffffff';
  uctx.fillRect(0, 0, up.width, up.height);
  uctx.drawImage(matte, 0, 0, up.width, up.height);
  return up.toDataURL('image/png');
}, `data:image/jpeg;base64,${readFileSync(SOURCE).toString('base64')}`);

const inkPath = `${OUT}/.signature-ink.png`;
writeFileSync(inkPath, Buffer.from(ink.split(',')[1], 'base64'));

// ---------------------------------------------------------------- 2. trace
const svg = await promisify(trace)(inkPath, {
  threshold: 128,
  turdSize: 2,
  optCurve: true,
  optTolerance: 0.2,
  alphaMax: 1.3,
  color: 'currentColor',
  background: 'transparent',
});

// ------------------------------------------------------------- 3. tighten
const measure = await browser.newPage();
await measure.setContent(`<body>${svg}</body>`);
const bb = await measure.evaluate(() => {
  const { x, y, width, height } = document.querySelector('svg').getBBox();
  return { x, y, width, height };
});
await measure.close();

const margin = Math.max(bb.width, bb.height) * 0.012;
const SIG = {
  x: Math.floor(bb.x - margin),
  y: Math.floor(bb.y - margin),
  w: Math.ceil(bb.width + margin * 2),
  h: Math.ceil(bb.height + margin * 2),
};

// The fill lives on the root only, so the mark inherits currentColor wherever
// it is reused and can be recoloured by a wrapping <g>.
const body = svg.split('>').slice(1).join('>').replace(/ fill="currentColor"/g, '').replace(/\n\t/g, '\n');
const signature =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${SIG.x} ${SIG.y} ${SIG.w} ${SIG.h}" ` +
  `fill="currentColor" role="img" aria-label="Signature">${body}`;
writeFileSync(`${OUT}/signature.svg`, signature);

// ---------------------------------------------------------------- 4. icons
const inner = signature.split('>').slice(1).join('>').replace('</svg>', '');

function place(size, widthPct) {
  const width = (size * widthPct) / 100;
  const scale = width / SIG.w;
  return [
    `translate(${((size - width) / 2 - SIG.x * scale).toFixed(3)}`,
    `${((size - SIG.h * scale) / 2 - SIG.y * scale).toFixed(3)})`,
    `scale(${scale.toFixed(6)})`,
  ].join(' ');
}

/**
 * The traced mark is a filled outline, so at icon sizes its hairlines would
 * fall below a pixel and disappear. Stroking it in the same paint widens every
 * stroke evenly without distorting the hand.
 */
function iconSvg({ size, widthPct, weight, radiusPct }) {
  const r = (radiusPct / 100) * size;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#151b23"/>
      <stop offset="1" stop-color="#080b0f"/>
    </linearGradient>
    <linearGradient id="ink" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#e2952f"/>
      <stop offset="0.5" stop-color="#ffc061"/>
      <stop offset="1" stop-color="#e2952f"/>
    </linearGradient>
  </defs>
  <rect width="${size}" height="${size}" rx="${r}" fill="url(#bg)"/>
  <rect x="0.5" y="0.5" width="${size - 1}" height="${size - 1}" rx="${r}" fill="none"
        stroke="#ffffff" stroke-opacity="0.07" stroke-width="1"/>
  <g transform="${place(size, widthPct)}" fill="url(#ink)" stroke="url(#ink)"
     stroke-width="${weight}" stroke-linejoin="round" stroke-linecap="round">${inner}</g>
</svg>`;
}

const TARGETS = [
  // iOS applies its own mask, so the PNG it uses is drawn square.
  { file: 'icon-180.png', size: 180, widthPct: 86, weight: 14, radiusPct: 0 },
  { file: 'icon-192.png', size: 192, widthPct: 86, weight: 13, radiusPct: 22 },
  { file: 'icon-512.png', size: 512, widthPct: 86, weight: 9, radiusPct: 22 },
  // Maskable art must survive a 20% crop on every side.
  { file: 'icon-maskable-512.png', size: 512, widthPct: 62, weight: 12, radiusPct: 0 },
];

for (const target of TARGETS) {
  const shot = await browser.newPage({ viewport: { width: target.size, height: target.size } });
  await shot.setContent(`<body style="margin:0">${iconSvg(target)}</body>`);
  await shot.screenshot({ path: `${OUT}/${target.file}`, omitBackground: true });
  await shot.close();
  console.log('wrote', target.file);
}

writeFileSync(`${OUT}/icon.svg`, iconSvg({ size: 64, widthPct: 86, weight: 26, radiusPct: 22 }));
console.log('wrote icon.svg and signature.svg — viewBox', SIG.x, SIG.y, SIG.w, SIG.h);

await browser.close();
