import { chromium } from 'playwright';
import { mkdirSync, readFileSync } from 'node:fs';

/**
 * Drives the built app in Chromium at iPhone dimensions and walks the core
 * journey through the real UI: import the supplied CSV, find the aircraft by
 * a lowercase tail, generate the email, record it, set a follow-up, reload,
 * re-import, and export. Fails on any console error, any horizontal overflow
 * or any link without a destination.
 *
 *   npm run build && npm run preview &
 *   node e2e-check.mjs
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:4173';
const SHOTS = process.env.SHOTS_DIR ?? resolve(here, '.e2e-shots');
const CSV = resolve(here, 'sample-data/owners-cirrus-design-corp-sr22t.csv');
const CHROME = process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const errors = [];
const log = (...a) => console.log(...a);

mkdirSync(SHOTS, { recursive: true });
const browser = await chromium.launch({ executablePath: CHROME });
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },       // iPhone 14 Pro logical size
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
});
const page = await context.newPage();

page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('requestfailed', (r) => {
  if (!r.url().startsWith(BASE)) return;
  errors.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`);
});

async function shot(name) {
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

async function checkOverflow(label) {
  const w = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  if (w.scroll > w.client + 1) errors.push(`horizontal overflow on ${label}: ${w.scroll} > ${w.client}`);
}

// ------------------------------------------------------- 0. brand assets
for (const asset of [
  '/brand/signature.svg', '/brand/icon.svg', '/brand/icon-180.png',
  '/brand/icon-192.png', '/brand/icon-512.png', '/brand/icon-maskable-512.png',
  '/manifest.webmanifest',
]) {
  const res = await page.request.get(BASE + asset);
  if (!res.ok()) errors.push(`asset ${asset} returned ${res.status()}`);
}

// ---------------------------------------------------------------- 1. empty
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForSelector('.quick-actions');
log('home loaded:', await page.title());
if (!(await page.getByText('Nothing in the book yet').isVisible())) errors.push('empty state missing on home');
await checkOverflow('home empty');
const sigBox = await page.evaluate(() => {
  const el = document.querySelector('.colophon .signature');
  if (!el) return null;
  const cs = getComputedStyle(el);
  const r = el.getBoundingClientRect();
  return { mask: cs.webkitMaskImage || cs.maskImage, w: Math.round(r.width), h: Math.round(r.height) };
});
if (!sigBox || !sigBox.mask.includes('signature.svg') || sigBox.w < 100) {
  errors.push(`signature did not render: ${JSON.stringify(sigBox)}`);
}
log('signature mark:', JSON.stringify(sigBox));
await shot('01-home-empty');

// ---------------------------------------------------------------- 2. import
await page.getByRole('link', { name: 'Import CSV' }).click();
await page.waitForSelector('input[type=file]', { state: 'attached' });
await page.setInputFiles('input[type=file]', CSV);
await page.waitForSelector('text=Column mapping');
await checkOverflow('import map');
await shot('02-import-map');

const detected = await page.locator('.chip:has-text("Detected")').count();
log('columns detected:', detected);
if (detected !== 13) errors.push(`expected 13 detected columns, got ${detected}`);

await page.getByRole('button', { name: /Preview 117 rows/ }).click();
await page.waitForSelector('text=Import preview');
await checkOverflow('import preview');
await shot('03-import-preview');

const metrics = await page.locator('.metric').allInnerTexts();
log('preview metrics:', metrics.join(' | '));

await page.getByRole('button', { name: /^Import 117 records$/ }).click();
await page.waitForSelector('text=Import complete');
await checkOverflow('import done');
await shot('04-import-done');
log('result metrics:', (await page.locator('.metric').allInnerTexts()).join(' | '));

// ------------------------------------------------------------- 3. search N917JH
await page.goto(`${BASE}/search`, { waitUntil: 'networkidle' });
await page.fill('input[type=search]', 'n917jh');
await page.waitForSelector('.tile');
await page.waitForTimeout(400);
const results = await page.locator('.tile').allInnerTexts();
log('search n917jh ->', results.length, 'results:', results[0]?.replace(/\n/g, ' / '));
if (!results[0]?.includes('N917JH')) errors.push('lowercase tail search did not find N917JH first');
await shot('05-search');

// ------------------------------------------------------- 4. aircraft detail
await page.locator('.tile').first().click();
await page.waitForSelector('h1.tail');
const tail = await page.locator('h1.tail').innerText();
const desc = await page.locator('h1.tail + div').innerText();
const owner = await page.locator('section:has(h2:text("Owner")) .tile .strong').first().innerText();
log('aircraft page:', tail, '|', desc, '| owner:', owner);
if (tail !== 'N917JH') errors.push(`expected N917JH, got ${tail}`);
if (!owner.includes('Heine')) errors.push(`expected Heine as owner, got ${owner}`);
await checkOverflow('aircraft detail');
await shot('06-aircraft-detail');

// --------------------------------------------------------- 5. email owner
await page.getByRole('button', { name: 'Email owner' }).click();
await page.waitForSelector('.sheet');
const to = await page.locator('.kv:has(.kv__key:text("To")) .kv__value').innerText();
const subject = await page.locator('.kv:has(.kv__key:text("Subject")) .kv__value').innerText();
const body = await page.locator('.sheet pre').innerText();
log('email to:', to);
log('email subject:', subject);
log('email body first line:', body.split('\n')[0]);
if (subject !== 'RE: N917JH') errors.push(`subject was "${subject}"`);
if (!body.startsWith('Hi John,')) errors.push(`body started "${body.slice(0, 20)}"`);
if (!body.includes('N917JH')) errors.push('body does not mention the tail');
const mailto = await page.getByRole('link', { name: 'Open in Mail' }).getAttribute('href');
log('mailto starts:', mailto.slice(0, 90));
if (!mailto.startsWith('mailto:jheine%40acentech.com?subject=RE%3A%20N917JH')) errors.push('mailto malformed');
await checkOverflow('email sheet');
await shot('07-email-preview');

// edit the message
await page.getByRole('button', { name: 'Edit this message' }).click();
await page.waitForSelector('textarea');
await page.fill('textarea', 'Hi John,\n\nEdited by the acceptance test.');
const mailto2 = await page.getByRole('link', { name: 'Open in Mail' }).getAttribute('href');
if (!mailto2.includes('Edited%20by%20the%20acceptance%20test')) errors.push('edited body did not reach the mailto');
log('edited mailto ok');

await page.getByRole('button', { name: 'Record as prepared' }).click();
await page.waitForTimeout(300);
await page.locator('.sheet__header button[aria-label=Close]').click();
await page.waitForTimeout(300);

const timeline = await page.locator('.timeline__item').allInnerTexts();
log('timeline entries:', timeline.length);
if (!timeline.join(' ').includes('RE: N917JH')) errors.push('email activity not on the timeline');
await shot('08-timeline');

// ---------------------------------------------------------- 6. follow up
await page.getByRole('button', { name: 'Follow up' }).click();
await page.waitForSelector('.sheet');
await page.getByRole('button', { name: '1 week' }).click();
await page.getByRole('button', { name: 'Set follow-up' }).click();
await page.waitForTimeout(400);
await shot('09-followup-set');

await page.goto(`${BASE}/follow-ups`, { waitUntil: 'networkidle' });
await page.waitForSelector('.metric');
const fu = await page.locator('.card').first().innerText();
log('follow-up dashboard:', fu.replace(/\n/g, ' / '));
const upcoming = await page.locator('section:has(h2:text("Upcoming")) .card').first().innerText();
log('upcoming item:', upcoming.replace(/\n/g, ' / '));
if (!upcoming.includes('N917JH')) errors.push('follow-up does not name the aircraft');
await checkOverflow('follow-ups');
await shot('10-followups');

// ---------------------------------------------------- 7. persistence reload
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.reload({ waitUntil: 'networkidle' });
await page.waitForSelector('.metric-grid');
const homeText = await page.locator('main').innerText();
log('after reload, home shows aircraft count:', /(\d+)\s*\nAircraft/.exec(homeText)?.[1]);
if (!homeText.includes('117')) errors.push('aircraft count missing after reload');
await checkOverflow('home populated');
await shot('11-home-populated');

// ------------------------------------------------------- 8. re-import file
await page.goto(`${BASE}/import`, { waitUntil: 'networkidle' });
await page.setInputFiles('input[type=file]', CSV);
await page.waitForSelector('text=Column mapping');
await page.getByRole('button', { name: /Preview 117 rows/ }).click();
await page.waitForSelector('text=Import preview');
const reMetrics = await page.locator('.metric').allInnerTexts();
log('re-import preview:', reMetrics.join(' | '));
const importBtn = page.getByRole('button', { name: /^Import \d+ records?$/ });
const disabled = await importBtn.isDisabled().catch(() => 'n/a');
log('re-import button disabled (nothing to do):', disabled);
if (disabled !== true) errors.push('re-import would still write records');
await shot('12-reimport-preview');

// ------------------------------------------------------------ 9. prospects
await page.goto(`${BASE}/prospects`, { waitUntil: 'networkidle' });
await page.waitForSelector('.card');
log('prospect count text:', await page.locator('main .small.muted').first().innerText());
await checkOverflow('prospects');
await shot('13-prospects');

// ---------------------------------------------------------- 10. other pages
for (const [path, name] of [
  ['/contacts', '14-contacts'],
  ['/aircraft', '15-aircraft'],
  ['/opportunities', '16-opportunities'],
  ['/tools', '17-tools'],
  ['/layover', '18-layover'],
  ['/templates', '19-templates'],
  ['/settings', '20-settings'],
  ['/import/history', '21-import-history'],
  ['/nope', '22-notfound'],
]) {
  await page.goto(BASE + path, { waitUntil: 'networkidle' });
  await page.waitForSelector('main');
  await checkOverflow(path);
  await shot(name);
}

// tools: exercise a calculator
await page.goto(`${BASE}/tools`, { waitUntil: 'networkidle' });
await page.waitForSelector('.card');
const windResult = await page.locator('.card').nth(1).innerText();
log('wind tool:', windResult.replace(/\n/g, ' / '));
await page.getByRole('button', { name: 'Density altitude' }).click();
await page.waitForTimeout(200);
log('DA tool:', (await page.locator('.card').nth(1).innerText()).replace(/\n/g, ' / '));
await shot('23-tools-da');

// layover: check a link is a live search
await page.goto(`${BASE}/layover`, { waitUntil: 'networkidle' });
await page.fill('input', 'Santa Barbara');
await page.waitForTimeout(300);
const michelin = await page.locator('a:has-text("Michelin")').first().getAttribute('href');
log('michelin link:', michelin);
if (!michelin?.startsWith('https://guide.michelin.com')) errors.push('michelin link wrong');
await shot('24-layover-filled');

// --------------------------------------------------------- 11. dead buttons
await page.goto(BASE, { waitUntil: 'networkidle' });
const deadLinks = await page.evaluate(() =>
  [...document.querySelectorAll('a')]
    .filter((a) => !a.getAttribute('href') || a.getAttribute('href') === '#')
    .map((a) => a.textContent?.trim()),
);
if (deadLinks.length) errors.push(`links with no destination: ${deadLinks.join(', ')}`);

// --------------------------------------------------------------- 12. export
await page.goto(`${BASE}/settings`, { waitUntil: 'networkidle' });
const download = page.waitForEvent('download');
await page.getByRole('button', { name: 'Export contacts' }).click();
const d = await download;
const path = await d.path();
const csvOut = readFileSync(path, 'utf8');
const lines = csvOut.trim().split('\r\n');
log('exported contacts CSV:', lines.length - 1, 'rows; header:', lines[0].slice(0, 60));
if (lines.length - 1 !== 115) errors.push(`export had ${lines.length - 1} contact rows, expected 115`);

// ------------------------------------------------------------------ report
await browser.close();
log('\n=== console/page errors and layout problems ===');
if (errors.length === 0) log('none');
else for (const e of errors) log(' -', e);
process.exit(errors.length ? 1 : 0);
