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
 *         public/brand/mark.svg        (the winged emblem, gold — the
 *                                       app-bar and splash logo)
 *         public/brand/icon*.png|svg   (home-screen icon set: the emblem on
 *                                       the brand navy tile)
 *
 * The emblem and icons are drawn from geometry in this file; only the
 * signature is traced. Run it when either changes; the outputs are
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

// ----------------------------------------------------------------- emblem
/**
 * The brand emblem: a pair of swept gold wings either side of a tall,
 * faceted keel. It is drawn here by hand rather than traced — straight
 * edges and flat facets, so it stays crisp from a 24px header down to a
 * favicon. The left half catches the light and the right half sits in
 * shade, which is what gives the flat shapes their bevelled, metallic read.
 */
const EMBLEM_VIEWBOX = { w: 120, h: 40 };
const EMBLEM_DEFS = `
    <linearGradient id="lit" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#EBD6A6"/>
      <stop offset="0.55" stop-color="#C9A96B"/>
      <stop offset="1" stop-color="#A88849"/>
    </linearGradient>
    <linearGradient id="shade" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#C9A96B"/>
      <stop offset="0.6" stop-color="#A5843F"/>
      <stop offset="1" stop-color="#7E6230"/>
    </linearGradient>`;
const UPPER_WING = 'M53 12.6 L1 10.2 L14 14.9 L53 18.6 Z';
const LOWER_WING = 'M53 21.4 L17 19.4 L27 23.6 L53 26.2 Z';
const KEEL = 'M60 1 L60 39 L53.4 28.5 L53.4 11.5 Z';
const EMBLEM_BODY = `
    <path fill="url(#lit)" d="${UPPER_WING}"/>
    <path fill="url(#shade)" d="${LOWER_WING}"/>
    <path fill="url(#lit)" d="${KEEL}"/>
    <g transform="matrix(-1 0 0 1 ${EMBLEM_VIEWBOX.w} 0)">
      <path fill="url(#shade)" d="${UPPER_WING}"/>
      <path fill="url(#shade)" d="${LOWER_WING}"/>
      <path fill="url(#shade)" d="${KEEL}"/>
    </g>`;

writeFileSync(
  `${OUT}/mark.svg`,
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${EMBLEM_VIEWBOX.w} ${EMBLEM_VIEWBOX.h}" role="img" aria-label="AEROBOOK">
  <defs>${EMBLEM_DEFS}
  </defs>${EMBLEM_BODY}
</svg>
`,
);
console.log('wrote mark.svg');

// ------------------------------------------------------------------ icons
/**
 * The home-screen icon is the emblem alone, gold on the brand navy — the
 * wings read at every size down to a phone home screen, where the wordmark
 * would not.
 *
 * `marginPct` is how much empty tile the emblem leaves either side —
 * maskable art needs more of it, since Android crops 20% off each edge
 * before applying its own mask, and the wingtips would be lost to that crop.
 */
function iconSvg({ size, marginPct, radiusPct }) {
  const r = (radiusPct / 100) * size;
  const scale = (size * (1 - (2 * marginPct) / 100)) / EMBLEM_VIEWBOX.w;
  const x = (size - EMBLEM_VIEWBOX.w * scale) / 2;
  // Optically centred: a hair above the true middle, as the keel's long
  // lower point pulls the eye down.
  const y = (size - EMBLEM_VIEWBOX.h * scale) / 2 - size * 0.01;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#113a5e"/>
      <stop offset="1" stop-color="#0B2D4A"/>
    </linearGradient>${EMBLEM_DEFS}
  </defs>
  <rect width="${size}" height="${size}" rx="${r}" fill="url(#bg)"/>
  <rect x="0.5" y="0.5" width="${size - 1}" height="${size - 1}" rx="${r}" fill="none"
        stroke="#ffffff" stroke-opacity="0.07" stroke-width="1"/>
  <g transform="translate(${x.toFixed(3)} ${y.toFixed(3)}) scale(${scale.toFixed(6)})">${EMBLEM_BODY}
  </g>
</svg>`;
}

const TARGETS = [
  // iOS applies its own mask, so the PNG it uses is drawn square.
  { file: 'icon-180.png', size: 180, marginPct: 12, radiusPct: 0 },
  { file: 'icon-192.png', size: 192, marginPct: 12, radiusPct: 22 },
  { file: 'icon-512.png', size: 512, marginPct: 12, radiusPct: 22 },
  // Maskable art must survive a 20% crop on every side.
  { file: 'icon-maskable-512.png', size: 512, marginPct: 24, radiusPct: 0 },
];

for (const target of TARGETS) {
  const shot = await browser.newPage({ viewport: { width: target.size, height: target.size } });
  await shot.setContent(`<body style="margin:0">${iconSvg(target)}</body>`);
  await shot.screenshot({ path: `${OUT}/${target.file}`, omitBackground: true });
  await shot.close();
  console.log('wrote', target.file);
}

writeFileSync(`${OUT}/icon.svg`, iconSvg({ size: 64, marginPct: 8, radiusPct: 22 }));
console.log('wrote icon.svg');

await browser.close();
