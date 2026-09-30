/**
 * Regenerates AEROBOOK's brand assets.
 *
 *   node scripts/build-brand.mjs
 *
 * Input:  brand-source/signature.jpg   (dark ink on a flat light background)
 * Output: public/brand/signature.svg   (the owner's full signature, traced,
 *                                       tight viewBox, currentColor — the
 *                                       quiet sign-off at the foot of the
 *                                       dashboard)
 *         public/brand/icon*.png|svg   (home-screen icon set: a gold jet
 *                                       on the navy tile)
 *
 * The icons are drawn from geometry in this file; only the signature is
 * traced. Run it when either changes; the outputs are
 * committed, so a normal build needs neither Chromium nor potrace.
 */
import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { trace } from 'potrace';

const SOURCE = 'brand-source/signature.jpg';
const OUT = 'public/brand';
const CHROME = process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const browser = await chromium.launch({ executablePath: CHROME });

/**
 * Ink extraction for the signature trace. Separates ink from background by
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

/** Trace a matte, then tighten its viewBox to the ink's own bounding box. */
async function traceTight(inkDataUrl, tmpPath, label) {
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

  const margin = Math.max(bb.width, bb.height) * 0.03;
  const box = {
    x: bb.x - margin,
    y: bb.y - margin,
    w: bb.width + margin * 2,
    h: bb.height + margin * 2,
  };

  // The fill lives on the root only, so the signature inherits currentColor
  // wherever it is reused and can be recoloured by a wrapping element.
  const body = svg.split('>').slice(1).join('>').replace(/ fill="currentColor"/g, '').replace(/\n\t/g, '\n');
  const tight =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${box.x.toFixed(2)} ${box.y.toFixed(2)} ${box.w.toFixed(2)} ${box.h.toFixed(2)}" ` +
    `fill="currentColor" role="img" aria-label="${label}">${body}`;

  return { svg: tight, box, inner: body.replace('</svg>', '') };
}

const page = await browser.newPage();
await page.setContent('<div></div>');

// --------------------------------------------------------------- signature
const sigInk = await inkMatte(page, null);
const signature = await traceTight(sigInk, `${OUT}/.signature-ink.png`, 'Signature');
writeFileSync(`${OUT}/signature.svg`, `${signature.svg}\n`);
console.log('wrote signature.svg — viewBox', signature.box);

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
