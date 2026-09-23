import { chromium } from 'playwright';
import { mkdirSync, readFileSync } from 'node:fs';

/**
 * Drives the built app in Chromium at iPhone dimensions and walks the journeys
 * the app exists for: import the supplied CSV, find the aircraft by a
 * lowercase tail, generate the email, record it, set a follow-up, add an
 * insurance policy and check the renewal countdown, open a brokerage
 * opportunity and move it through the pipeline, record what the owner wants,
 * reload, re-import, and export. Fails on any console error, any horizontal
 * overflow or any link without a destination.
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

/**
 * Section titles and chips are uppercased in CSS, and innerText reports what
 * is painted, so text assertions compare case-insensitively.
 */
function has(haystack, needle) {
  return haystack.toLowerCase().includes(needle.toLowerCase());
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
  '/brand/icon.svg', '/brand/icon-180.png', '/brand/icon-192.png',
  '/brand/icon-512.png', '/brand/icon-maskable-512.png', '/manifest.webmanifest',
  '/brand/mark.svg', '/brand/signature.svg',
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
// The footer signature is a CSS mask, not inline SVG (the app bar is plain
// text now): check that it has real size and that its mask actually points
// at the traced asset (a 404'd background-image degrades silently, a 404'd mask does not
// even fail loudly — the box just renders empty).
const markBox = await page.evaluate(() => {
  const els = [...document.querySelectorAll('.colophon .signature')];
  return els.map((el) => {
    const r = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    const mask = style.maskImage || style.webkitMaskImage || '';
    return { w: Math.round(r.width), h: Math.round(r.height), mask };
  });
});
if (
  markBox.length < 1 ||
  markBox.some((m) => m.w < 12 || m.h < 8 || !/signature\.svg/.test(m.mask))
) {
  errors.push(`brand mark did not render: ${JSON.stringify(markBox)}`);
}
log('brand mark:', JSON.stringify(markBox));
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
if (!has(timeline.join(' '), 'RE: N917JH')) errors.push('email activity not on the timeline');
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
const upcoming = await page.locator('section:has(h2:text("This week")) .card').first().innerText();
log('this week item:', upcoming.replace(/\n/g, ' / '));
if (!has(upcoming, 'N917JH')) errors.push('follow-up does not name the aircraft');
await checkOverflow('follow-ups');
await shot('10-followups');

// -------------------------------------------------- 6b. insurance renewal
// The scenario the app exists for: the owner's policy renews in 47 days.
const in47 = (() => {
  const d = new Date();
  d.setDate(d.getDate() + 47);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
})();

await page.goto(`${BASE}/search`, { waitUntil: 'networkidle' });
await page.fill('input[type=search]', 'n917jh');
await page.waitForSelector('.tile');
await page.waitForTimeout(400);
await page.locator('.tile').first().click();
await page.waitForSelector('h1.tail');

await page.locator('section:has(h2:text("Insurance"))').getByRole('button', { name: 'Add', exact: true }).click();
await page.waitForSelector('.sheet');
await page.getByLabel('Carrier').fill('Global Aerospace');
await page.getByLabel('Hull value').fill('$1,250,000');
await page.getByLabel('Expiration date').fill(in47);
await page.waitForTimeout(200);
const previewChip = await page.locator('.sheet .chip').first().innerText();
log('renewal preview chip:', previewChip);
if (previewChip.toLowerCase() !== 'renewal in 47 days') errors.push(`renewal preview read "${previewChip}"`);
await checkOverflow('policy sheet');
await shot('10a-policy-sheet');
await page.getByRole('button', { name: 'Save', exact: true }).click();
await page.waitForTimeout(400);

const glance = await page.locator('section[aria-label="At a glance"]').innerText();
log('aircraft glance:', glance.replace(/\n/g, ' / '));
for (const expected of ['Heine', 'Renewal in 47 days', 'Global Aerospace']) {
  if (!has(glance, expected)) errors.push(`glance panel is missing "${expected}"`);
}
await checkOverflow('aircraft with policy');
await shot('10b-aircraft-insurance');

// A renewal task, straight off the aircraft.
await page.getByRole('button', { name: 'Renewal task' }).click();
await page.waitForSelector('.sheet');
const renewalNote = await page.getByLabel(/Why/).inputValue();
log('renewal follow-up note:', renewalNote);
if (!renewalNote.includes('N917JH') || !renewalNote.includes('Global Aerospace')) {
  errors.push(`renewal follow-up note read "${renewalNote}"`);
}
await page.getByRole('button', { name: 'Set follow-up' }).click();
await page.waitForTimeout(400);

// ------------------------------------------------ 6c. brokerage pipeline
await page.getByRole('button', { name: 'Add opportunity' }).click();
await page.waitForSelector('.sheet');
await page.getByLabel('Type').selectOption('Sale + Insurance');
await page.getByLabel('Next action').fill('Send comparable sales');
await page.getByRole('button', { name: 'Create' }).click();
await page.waitForTimeout(400);

await page.locator('section:has(h2:text("Opportunities")) .tile').first().click();
await page.waitForSelector('.stage-track');
await checkOverflow('opportunity detail');
await page.getByRole('button', { name: 'Quoting', exact: true }).click();
await page.waitForTimeout(400);
const oppText = await page.locator('main').innerText();
log('opportunity after stage move:', oppText.split('\n').slice(0, 6).join(' / '));
if (!has(oppText, 'Quoting')) errors.push('stage did not move to Quoting');
if (!has(oppText, 'Send comparable sales')) errors.push('next action missing from the opportunity');
if (!has(oppText, 'Lead → Quoting')) errors.push('stage change was not recorded on the timeline');
await shot('10c-opportunity');

// -------------------------------------- 6c2. purchase opportunity, no aircraft
// Scenario B: John is selling N917JH (opportunity above, created from the
// aircraft) AND separately shopping for a different aircraft. The purchase
// opportunity must not stay silently linked to the plane he already owns.
await page.goto(`${BASE}/search`, { waitUntil: 'networkidle' });
await page.fill('input[type=search]', 'heine');
await page.waitForSelector('.tile');
await page.waitForTimeout(400);
await page.locator('.tile:has-text("Heine")').first().click();
await page.waitForSelector('h1');
await page.getByRole('button', { name: 'Add opportunity' }).click();
await page.waitForSelector('.sheet');
const preselectedAircraft = await page.getByLabel('Aircraft').inputValue();
log('new opportunity aircraft defaults to:', preselectedAircraft);
await page.getByLabel('Type').selectOption('Aircraft Purchase');
await page.waitForTimeout(150);
const warned = await page.locator('.sheet').innerText();
if (!has(warned, 'already owns')) errors.push('no warning shown when a purchase opportunity is linked to the owner\'s own aircraft');
await page.getByLabel('Aircraft').selectOption({ label: 'No aircraft' });
await page.getByLabel('Title', { exact: true }).fill('Looking for a newer aircraft');
await page.getByRole('button', { name: 'Create' }).click();
await page.waitForTimeout(400);

const contactAfterPurchase = await page.locator('main').innerText();
if (!has(contactAfterPurchase, 'Looking for a newer aircraft')) {
  errors.push('the purchase opportunity did not appear on the contact');
}
const oppRows = await page.locator('section:has(h2:text("Opportunities")) .tile').allInnerTexts();
log('contact opportunities:', oppRows.map((r) => r.replace(/\n/g, ' / ')).join(' | '));
if (oppRows.length !== 2) errors.push(`expected 2 opportunities on the contact, found ${oppRows.length}`);
if (has(oppRows.join(' '), 'N917JH') === false) errors.push('the sale opportunity (linked to N917JH) is missing');
await checkOverflow('contact with two opportunities');
await shot('10c2-purchase-opportunity');

// Scenario B, closing the loop: the aircraft page should show the sale
// opportunity is in motion, not just that one exists.
await page.goto(`${BASE}/search`, { waitUntil: 'networkidle' });
await page.fill('input[type=search]', 'n917jh');
await page.waitForSelector('.tile');
await page.waitForTimeout(400);
await page.locator('.tile').first().click();
await page.waitForSelector('h1.tail');
const aircraftAfterOpp = await page.locator('section[aria-label="At a glance"]').innerText();
log('aircraft glance after opportunity:', aircraftAfterOpp.replace(/\n/g, ' / '));
for (const expected of ['Sale + Insurance', 'Quoting']) {
  if (!has(aircraftAfterOpp, expected)) errors.push(`aircraft glance does not reflect the opportunity: missing "${expected}"`);
}

// ------------------------------------------------ 6d. what they want
await page.goto(`${BASE}/search`, { waitUntil: 'networkidle' });
await page.fill('input[type=search]', 'heine');
await page.waitForSelector('.tile');
await page.waitForTimeout(400);
await page.locator('.tile:has-text("Heine")').first().click();
await page.waitForSelector('h1');
await page.getByRole('button', { name: 'What they want', exact: true }).click();
await page.waitForSelector('.sheet');
await page.getByLabel('May sell an aircraft').selectOption('Actively');
await page.getByLabel('Aircraft they want').fill('Pilatus PC-12');
await page.getByLabel('Budget').fill('$4M');
await page.getByRole('button', { name: 'Save', exact: true }).click();
await page.waitForTimeout(400);

const contactText = await page.locator('main').innerText();
for (const expected of ['Pilatus PC-12', '$4M', 'Global Aerospace', 'N917JH']) {
  if (!has(contactText, expected)) errors.push(`contact page is missing "${expected}"`);
}
const contactGlance = await page.locator('section[aria-label="At a glance"]').innerText();
log('contact glance:', contactGlance.replace(/\n/g, ' / '));
for (const expected of ['Wants Pilatus PC-12', 'Selling: Actively', '$4M', '1 policy', 'N917JH']) {
  if (!has(contactGlance, expected)) errors.push(`contact glance is missing "${expected}"`);
}
await checkOverflow('contact detail');
await shot('10d-contact-intent');

// The whole point: three days later, one search answers everything.
await page.goto(`${BASE}/search`, { waitUntil: 'networkidle' });
await page.fill('input[type=search]', 'pilatus');
await page.waitForTimeout(400);
const wantHits = await page.locator('.tile').allInnerTexts();
log('search "pilatus" ->', wantHits.length, 'results');
if (!has(wantHits.join(' '), 'Heine')) errors.push('searching what someone wants does not find them');

await page.fill('input[type=search]', 'n917jh');
await page.waitForTimeout(400);
// Three days later, one search should answer the whole situation.
const recallHit = await page.locator('.tile').first().innerText();
log('search recall:', recallHit.replace(/\n/g, ' / '));
for (const expected of ['N917JH', 'Cirrus', 'John Heine', 'Renewal in 47 days']) {
  if (!has(recallHit, expected)) errors.push(`the search result does not say "${expected}"`);
}

await page.fill('input[type=search]', 'global aerospace');
await page.waitForTimeout(400);
const carrierHits = await page.locator('.tile').allInnerTexts();
log('search "global aerospace" ->', carrierHits.length, 'results');
if (!has(carrierHits.join(' '), 'N917JH')) errors.push('searching a carrier does not find the aircraft');
await shot('10e-search-carrier');

// ------------------------------------------------- 6f. a brand new client
// The call-comes-in scenario: a person, their aircraft and a follow-up,
// without ever having to go and find the record again.
await page.goto(`${BASE}/contacts?new=1`, { waitUntil: 'networkidle' });
await page.waitForSelector('.sheet');
await page.getByLabel('First name').fill('John');
await page.getByLabel('Last name').fill('Smith');
await page.getByLabel('Email').fill('john@example.com');
await page.getByRole('button', { name: 'Save', exact: true }).click();
await page.waitForSelector('h1:has-text("John Smith")');
if (!page.url().includes('/contacts/')) errors.push('creating a contact did not open the contact');

await page.getByRole('button', { name: 'Add aircraft' }).click();
await page.waitForSelector('.sheet');
const prefilled = await page.getByLabel('Owner').inputValue();
await page.getByLabel('Tail number').fill('n123ab');
await page.getByLabel('Year').fill('2018');
await page.getByLabel('Make').fill('Pilatus');
await page.getByLabel('Model').fill('PC-12');
await page.getByRole('button', { name: 'Save', exact: true }).click();
await page.waitForSelector('h1.tail:has-text("N123AB")');
const newAircraft = await page.locator('section[aria-label="At a glance"]').innerText();
log('new aircraft glance:', newAircraft.replace(/\n/g, ' / '));
if (!has(newAircraft, 'John Smith')) {
  errors.push(`aircraft added from a contact lost the owner (picker held "${prefilled}")`);
}

await page.getByRole('button', { name: 'Follow up' }).click();
await page.waitForSelector('.sheet');
await page.getByRole('button', { name: 'Tomorrow' }).click();
await page.getByRole('button', { name: 'Set follow-up' }).click();
await page.waitForTimeout(400);

await page.goto(`${BASE}/follow-ups`, { waitUntil: 'networkidle' });
await page.waitForSelector('.metric');
const tasks = await page.locator('main').innerText();
if (!has(tasks, 'N123AB')) errors.push('the new aircraft follow-up is not on the task list');
await checkOverflow('follow-ups with work');
await shot('10g-new-client');

// ------------------------------------------------------ 6e. home triage
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForSelector('.metric-grid');
const home = await page.locator('main').innerText();
log('home sections:', ['Today', 'Insurance', 'Active business'].filter((h) => has(home, h)).join(', '));
for (const expected of ['Today', 'Insurance', 'Renewal in 47 days', 'Active business', 'Send comparable sales']) {
  if (!has(home, expected)) errors.push(`home screen is missing "${expected}"`);
}
await checkOverflow('home with work on it');
await shot('10f-home-triage');

// ---------------------------------------------------- 7. persistence reload
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.reload({ waitUntil: 'networkidle' });
await page.waitForSelector('.metric-grid');
const homeText = await page.locator('main').innerText();
// 117 imported, plus N123AB added by hand in the new-client workflow above.
const aircraftCount = /(\d+)\s*\nAIRCRAFT/i.exec(homeText)?.[1];
log('after reload, home shows aircraft count:', aircraftCount);
if (aircraftCount !== '118') errors.push(`aircraft count read ${aircraftCount} after reload, expected 118`);
// Home only shows what needs attention, so persistence of a record added by
// hand is checked where the record actually lives.
await page.goto(`${BASE}/search`, { waitUntil: 'networkidle' });
await page.fill('input[type=search]', 'N123AB');
await page.waitForSelector('.tile');
await page.waitForTimeout(400);
await page.locator('.tile').first().click();
await page.waitForSelector('h1.tail');
const survived = await page.locator('main').innerText();
log('after reload, N123AB reads:', survived.split('\n').slice(0, 4).join(' / '));
for (const expected of ['N123AB', '2018 Pilatus PC-12', 'John Smith']) {
  if (!has(survived, expected)) errors.push(`"${expected}" did not survive the reload`);
}
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForSelector('.metric-grid');
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

// ------------------------------------------------- 10b. primary navigation
await page.goto(BASE, { waitUntil: 'networkidle' });
const tabs = await page.locator('.tabbar__item').evaluateAll((els) =>
  els.map((el) => ({ label: el.querySelector('span')?.textContent, aria: el.getAttribute('aria-label') })),
);
log('nav tabs:', tabs.map((t) => t.label).join(' | '));
const expectedTabs = ['Home', 'Aircraft', 'Contacts', 'Follow-up', 'Settings'];
if (tabs.map((t) => t.label).join('|') !== expectedTabs.join('|')) {
  errors.push(`tab bar reads "${tabs.map((t) => t.label).join(' | ')}", expected "${expectedTabs.join(' | ')}"`);
}
if (tabs[0]?.aria !== 'AEROBOOK Home') errors.push(`Home tab aria-label is "${tabs[0]?.aria}", expected "AEROBOOK Home"`);

await page.locator('nav.tabbar').getByRole('link', { name: 'Settings' }).click();
await page.waitForURL(/\/settings$/);
await page.waitForSelector('text=Data / Import');
log('settings reached via tab');

await page.getByRole('link', { name: 'Aviation & insurance calculators' }).click();
await page.waitForURL(/\/tools$/);
await page.waitForSelector('.filter-bar');
log('tools reached via settings link');

await page.getByRole('link', { name: 'AEROBOOK Home' }).click();
await page.waitForURL(`${BASE}/`);
await page.waitForSelector('.quick-actions');
log('home tab returns to dashboard from a nested screen');

await page.goto(`${BASE}/layover`, { waitUntil: 'networkidle' });
if (!(await page.getByText('Not found').isVisible())) errors.push('/layover no longer 404s — dead route left behind');

// tools: exercise a calculator
await page.goto(`${BASE}/tools`, { waitUntil: 'networkidle' });
await page.waitForSelector('.card');
const windResult = await page.locator('.card').nth(1).innerText();
log('wind tool:', windResult.replace(/\n/g, ' / '));
await page.getByRole('button', { name: 'Density altitude' }).click();
await page.waitForTimeout(200);
log('DA tool:', (await page.locator('.card').nth(1).innerText()).replace(/\n/g, ' / '));
await shot('23-tools-da');

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
// 115 from the CSV (two owners hold two aircraft each), plus John Smith.
if (lines.length - 1 !== 116) errors.push(`export had ${lines.length - 1} contact rows, expected 116`);
if (!has(csvOut, 'Pilatus PC-12')) errors.push('the contact export does not carry what they want');

const insDownload = page.waitForEvent('download');
await page.getByRole('button', { name: 'Export insurance' }).click();
const insFile = await (await insDownload).path();
const insCsv = readFileSync(insFile, 'utf8').trim().split('\r\n');
log('exported insurance CSV:', insCsv.length - 1, 'rows; header:', insCsv[0].slice(0, 60));
if (insCsv.length - 1 !== 1) errors.push(`insurance export had ${insCsv.length - 1} rows, expected 1`);
if (!has(insCsv[1], 'N917JH') || !has(insCsv[1], 'Global Aerospace')) {
  errors.push('insurance export does not carry the aircraft and carrier');
}

// ------------------------------------------------------------------ report
await browser.close();
log('\n=== console/page errors and layout problems ===');
if (errors.length === 0) log('none');
else for (const e of errors) log(' -', e);
process.exit(errors.length ? 1 : 0);
