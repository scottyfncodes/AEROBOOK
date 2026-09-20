/**
 * Regenerates AEROBOOK's brand assets from the owner's own signature.
 *
 *   node scripts/build-brand.mjs
 *
 * Input:  brand-source/signature.jpg   (dark ink on a flat light background)
 * Output: public/brand/signature.svg   (the full signature, traced, tight
 *                                       viewBox, currentColor — the footer)
 *         public/brand/mark.svg        (just its capital "A", traced from
 *                                       the same ink — the logo and the
 *                                       home-screen icon)
 *         public/brand/icon*.png|svg   (home-screen icon set, built from
 *                                       the "A")
 *
 * The full signature is illegible at the sizes a logo or a home-screen icon
 * actually get used at, so the two are traced separately: the whole hand for
 * the quiet sign-off at the foot of the dashboard, and a tight crop around
 * just its capital "A" — peak, the long downstroke, the short one, the
 * crossbar — for everywhere the mark has to read small.
 *
 * Run it only when the source signature changes; the outputs are committed,
 * so a normal build needs neither Chromium nor potrace.
 */
import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { trace } from 'potrace';

const SOURCE = 'brand-source/signature.jpg';
const OUT = 'public/brand';
const CHROME = process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

// The "A" is a tight crop of the source photo, in its pixel coordinates —
// found by scanning ink columns row by row until the two strokes that
// converge on the peak, and only those, were pinned down. Everything past
// this box is the rest of the name and is deliberately left out.
const A_CROP = { x: 10, y: 78, w: 145, h: 145 };

const browser = await chromium.launch({ executablePath: CHROME });

/**
 * Ink extraction, shared by both traces. Separates ink from background by
 * distance from the sampled corner colour, so antialiased edges survive as
 * partial coverage rather than being thresholded away, then upscales before
 * tracing — potrace follows the pixel grid, and a larger bitmap yields
 * noticeably smoother curves.
 */
async function inkMatte(page, crop) {
  return page.evaluate(async ({ dataUrl, crop }) => {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = dataUrl; });

    const src = document.createElement('canvas');
    const w = crop ? crop.w : img.naturalWidth;
    const h = crop ? crop.h : img.naturalHeight;
    src.width = w; src.height = h;
    const sctx = src.getContext('2d', { willReadFrequently: true });
    if (crop) sctx.drawImage(img, crop.x, crop.y, crop.w, crop.h, 0, 0, w, h);
    else sctx.drawImage(img, 0, 0);
    const d = sctx.getImageData(0, 0, w, h).data;

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

    const FLOOR = 0.12; // keeps JPEG noise in the background at zero coverage
    const SCALE = 6;
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
  }, { dataUrl: `data:image/jpeg;base64,${readFileSync(SOURCE).toString('base64')}`, crop });
}

/**
 * Trace a matte, then tighten its viewBox to the ink's own bounding box.
 *
 * `strokeWidthPct` widens every line by stroking it in the same paint as the
 * fill, as a percentage of the mark's own size. The full signature is never
 * shown below ~150px so its hairlines survive on their own; the "A" gets
 * reused as small as a 22px header icon, where the same hairlines would fall
 * below a pixel and disappear without this.
 */
async function traceTight(inkDataUrl, tmpPath, label, strokeWidthPct = 0) {
  writeFileSync(tmpPath, Buffer.from(inkDataUrl.split(',')[1], 'base64'));
  const svg = await promisify(trace)(tmpPath, {
    threshold: 128,
    turdSize: 2,
    optCurve: true,
    optTolerance: 0.2,
    alphaMax: 1.3,
    color: 'currentColor',
    background: 'transparent',
  });

  const measure = await browser.newPage();
  await measure.setContent(`<body>${svg}</body>`);
  const bb = await measure.evaluate(() => {
    const { x, y, width, height } = document.querySelector('svg').getBBox();
    return { x, y, width, height };
  });
  await measure.close();

  const strokeWidth = (Math.max(bb.width, bb.height) * strokeWidthPct) / 100;
  const margin = Math.max(Math.max(bb.width, bb.height) * 0.03, strokeWidth / 2);
  const box = {
    x: bb.x - margin,
    y: bb.y - margin,
    w: bb.width + margin * 2,
    h: bb.height + margin * 2,
  };

  // The fill (and stroke, when there is one) lives on the root only, so the
  // mark inherits currentColor wherever it is reused and can be recoloured
  // by a wrapping element.
  const body = svg.split('>').slice(1).join('>').replace(/ fill="currentColor"/g, '').replace(/\n\t/g, '\n');
  const paint = strokeWidth
    ? `fill="currentColor" stroke="currentColor" stroke-width="${strokeWidth.toFixed(2)}" stroke-linejoin="round" stroke-linecap="round"`
    : 'fill="currentColor"';
  const tight =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${box.x.toFixed(2)} ${box.y.toFixed(2)} ${box.w.toFixed(2)} ${box.h.toFixed(2)}" ` +
    `${paint} role="img" aria-label="${label}">${body}`;

  return { svg: tight, box, inner: body.replace('</svg>', '') };
}

const page = await browser.newPage();
await page.setContent('<div></div>');

// --------------------------------------------------------------- signature
const sigInk = await inkMatte(page, null);
const signature = await traceTight(sigInk, `${OUT}/.signature-ink.png`, 'Signature');
writeFileSync(`${OUT}/signature.svg`, `${signature.svg}\n`);
console.log('wrote signature.svg — viewBox', signature.box);

// ---------------------------------------------------------------------- A
const aInk = await inkMatte(page, A_CROP);
// Raw, for the icon set below, which calibrates its own stroke per size.
const mark = await traceTight(aInk, `${OUT}/.mark-ink.png`, 'AEROBOOK');
// Widened, for every other use, which is a single CSS size, not a fixed
// pixel grid, and has no other way to keep the hand's fine strokes visible.
const markFile = await traceTight(aInk, `${OUT}/.mark-ink.png`, 'AEROBOOK', 6);
writeFileSync(`${OUT}/mark.svg`, `${markFile.svg}\n`);
console.log('wrote mark.svg — viewBox', markFile.box);

// ------------------------------------------------------------------ icons
/**
 * The traced mark is a filled silhouette, so at icon sizes its hairlines
 * would fall below a pixel and vanish. Stroking it in the same paint widens
 * every stroke evenly without distorting the hand.
 */
function iconSvg({ size, widthPct, weight, radiusPct }) {
  const r = (radiusPct / 100) * size;
  const scale = (size * widthPct) / 100 / mark.box.w;
  const tx = (size - mark.box.w * scale) / 2 - mark.box.x * scale;
  const ty = (size - mark.box.h * scale) / 2 - mark.box.y * scale;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#151b23"/>
      <stop offset="1" stop-color="#080b0f"/>
    </linearGradient>
    <linearGradient id="ink" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="${size}" y2="${size}">
      <stop offset="0" stop-color="#ffc061"/>
      <stop offset="1" stop-color="#e2952f"/>
    </linearGradient>
  </defs>
  <rect width="${size}" height="${size}" rx="${r}" fill="url(#bg)"/>
  <rect x="0.5" y="0.5" width="${size - 1}" height="${size - 1}" rx="${r}" fill="none"
        stroke="#ffffff" stroke-opacity="0.07" stroke-width="1"/>
  <g transform="translate(${tx.toFixed(3)} ${ty.toFixed(3)}) scale(${scale.toFixed(6)})"
     fill="url(#ink)" stroke="url(#ink)" stroke-width="${(weight / scale).toFixed(3)}"
     stroke-linejoin="round" stroke-linecap="round">${mark.inner}</g>
</svg>`;
}

const TARGETS = [
  // iOS applies its own mask, so the PNG it uses is drawn square.
  { file: 'icon-180.png', size: 180, widthPct: 78, weight: 3.2, radiusPct: 0 },
  { file: 'icon-192.png', size: 192, widthPct: 78, weight: 3.0, radiusPct: 22 },
  { file: 'icon-512.png', size: 512, widthPct: 78, weight: 2.0, radiusPct: 22 },
  // Maskable art must survive a 20% crop on every side.
  { file: 'icon-maskable-512.png', size: 512, widthPct: 56, weight: 2.4, radiusPct: 0 },
];

for (const target of TARGETS) {
  const shot = await browser.newPage({ viewport: { width: target.size, height: target.size } });
  await shot.setContent(`<body style="margin:0">${iconSvg(target)}</body>`);
  await shot.screenshot({ path: `${OUT}/${target.file}`, omitBackground: true });
  await shot.close();
  console.log('wrote', target.file);
}

writeFileSync(`${OUT}/icon.svg`, iconSvg({ size: 64, widthPct: 78, weight: 5.6, radiusPct: 22 }));
console.log('wrote icon.svg');

await browser.close();
