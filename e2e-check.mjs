import { chromium } from 'playwright';
import { mkdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';

/**
 * Drives the built app in Chromium at iPhone dimensions and walks the journeys
 * the app exists for: set up the first admin account, import the supplied CSV, find the aircraft by a
 * lowercase tail, generate the email, record it, set a follow-up, add an
 * insurance policy and check the renewal countdown, open a brokerage
 * opportunity and move it through the pipeline, record what the owner wants,
 * reload, re-import, and export; then add a teammate who signs in on a second
 * device and shares the same data; the two message each other, in a group,
 * and on an aircraft's comments, and see it arrive without reloading; and
 * last, the admin turns on two-step
 * sign-in and signs in with a code. Fails on any console error, any horizontal
 * overflow or any link without a destination.
 *
 * Needs the full stack against an empty database, started with SETUP_TOKEN:
 *
 *   npm run build
 *   DATABASE_URL=... BETTER_AUTH_SECRET=... SETUP_TOKEN=e2e-setup-token npm run serve &
 *   node e2e-check.mjs
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:4173';
const SHOTS = process.env.SHOTS_DIR ?? resolve(here, '.e2e-shots');
const CSV = resolve(here, 'sample-data/owners-cirrus-design-corp-sr22t.csv');
const CHROME = process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
// The server must start with an empty database and this SETUP_TOKEN.
const SETUP_TOKEN = process.env.SETUP_TOKEN ?? 'e2e-setup-token';
const ADMIN = { name: 'Scott Test', email: 'scott@example.com', password: 'e2e admin password' };
const TEAMMATE = { name: 'John Teammate', email: 'john@example.com', password: 'e2e teammate password' };

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

// A wrong two-step code is refused with a 401 on purpose; the browser logs that.
let adminExpectingRejection = false;
page.on('console', (m) => {
  if (m.type() !== 'error') return;
  if (adminExpectingRejection && /401/.test(m.text())) return;
  errors.push(`console: ${m.text()}`);
});
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
// A large sync (an import) still in flight when the test navigates away is
// cut off by the browser; the app resends it on the next load, and the
// counts checked after each reload prove it arrived. Anything else failing
// is an error.
let abortedSyncs = 0;
page.on('requestfailed', (r) => {
  if (!r.url().startsWith(BASE)) return;
  if (r.url().endsWith('/api/sync') && r.failure()?.errorText === 'net::ERR_ABORTED') {
    abortedSyncs++;
    return;
  }
  // The inbox check and "I've left" note are sent every few seconds and as
  // the page goes; a navigation cuts some off, and the next one catches up.
  if (/\/api\/(inbox|presence)$/.test(r.url()) && r.failure()?.errorText === 'net::ERR_ABORTED') return;
  // So is an aircraft page's comments refresh (a read, on a timer): going
  // straight to another page can cut it off. Writes are never let through.
  if (r.method() === 'GET' && /\/api\/aircraft\/[^/]+\/comments$/.test(r.url()) && r.failure()?.errorText === 'net::ERR_ABORTED') return;
  errors.push(`requestfailed: ${r.method()} ${r.url()} ${r.failure()?.errorText}`);
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
]) {
  const res = await page.request.get(BASE + asset);
  if (!res.ok()) errors.push(`asset ${asset} returned ${res.status()}`);
}

// ------------------------------------------------------- 0b. first admin
// Nothing opens without an account; the very first one needs the setup token.
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForSelector('text=Set up AEROBOOK');
if (await page.locator('.tabbar').count()) errors.push('the tab bar shows before anyone has signed in');
await shot('00-setup');
await page.getByLabel('Setup token').fill(SETUP_TOKEN);
await page.getByLabel('Your name').fill(ADMIN.name);
await page.getByLabel('Email').fill(ADMIN.email);
await page.getByLabel('Password', { exact: true }).fill(ADMIN.password);
await page.getByLabel('Password again').fill(ADMIN.password);
await page.getByRole('button', { name: 'Create the admin account' }).click();
await page.waitForSelector('.quick-actions');
log('first admin created and signed in');

// ---------------------------------------------------------------- 1. empty
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForSelector('.quick-actions');
log('home loaded:', await page.title());
if (!(await page.getByText('Nothing in the book yet').isVisible())) errors.push('empty state missing on home');
await checkOverflow('home empty');
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
// The sheet's box: the aircraft page has a comment box of its own.
await page.waitForSelector('.sheet textarea');
await page.fill('.sheet textarea', 'Hi John,\n\nEdited by the acceptance test.');
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

// a recorded entry can be corrected in place
await page.locator('button[aria-label^="Edit \\"RE: N917JH"]').first().click();
await page.waitForSelector('.sheet textarea');
await page.fill('.sheet textarea', 'Corrected by the acceptance test.');
await page.getByRole('button', { name: 'Save' }).click();
await page.waitForTimeout(300);
const editedTimeline = (await page.locator('.timeline__item').allInnerTexts()).join(' ');
if (!has(editedTimeline, 'Corrected by the acceptance test.')) errors.push('edited timeline entry did not save');
if (!has(editedTimeline, 'edited')) errors.push('edited timeline entry is not marked as edited');
log('timeline entry edited');
await shot('08b-timeline-edited');

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
const renewalNote = await page.locator('.sheet').getByLabel('Note', { exact: true }).inputValue();
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
  ['/templates', '19-templates'],
  ['/settings', '20-settings'],
  ['/import/history', '21-import-history'],
  ['/history', '21b-activity-history'],
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
  els.map((el) => ({ label: el.querySelector(':scope > span:last-child')?.textContent, aria: el.getAttribute('aria-label') })),
);
log('nav tabs:', tabs.map((t) => t.label).join(' | '));
const expectedTabs = ['Home', 'Aircraft', 'Contacts', 'Follow-up', 'Chat', 'Settings'];
if (tabs.map((t) => t.label).join('|') !== expectedTabs.join('|')) {
  errors.push(`tab bar reads "${tabs.map((t) => t.label).join(' | ')}", expected "${expectedTabs.join(' | ')}"`);
}
if (tabs[0]?.aria !== 'AEROBOOK Home') errors.push(`Home tab aria-label is "${tabs[0]?.aria}", expected "AEROBOOK Home"`);

await page.locator('nav.tabbar').getByRole('link', { name: 'Settings' }).click();
await page.waitForURL(/\/settings$/);
await page.waitForSelector('text=Data / Import');
log('settings reached via tab');

await page.getByRole('link', { name: /Email templates/ }).click();
await page.waitForURL(/\/templates$/);
log('templates reached via settings link');

await page.getByRole('link', { name: 'AEROBOOK Home' }).click();
await page.waitForURL(`${BASE}/`);
await page.waitForSelector('.quick-actions');
log('home tab returns to dashboard from a nested screen');

await page.goto(`${BASE}/layover`, { waitUntil: 'networkidle' });
if (!(await page.getByText('Not found').isVisible())) errors.push('/layover no longer 404s — dead route left behind');

await page.goto(`${BASE}/tools`, { waitUntil: 'networkidle' });
if (!(await page.getByText('Not found').isVisible())) errors.push('/tools still opens — the calculators were removed');

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

// ----------------------------------------------------- 13. a second person
// The admin adds a teammate, who signs in on another device and sees the
// same book; what the teammate records reaches the admin.
await page.goto(`${BASE}/settings`, { waitUntil: 'networkidle' });
await page.getByRole('button', { name: 'Add person' }).click();
await page.waitForSelector('.sheet');
const addSheet = page.locator('.sheet');
await addSheet.getByLabel('Name', { exact: true }).fill(TEAMMATE.name);
await addSheet.getByLabel('Email').fill(TEAMMATE.email);
await addSheet.getByLabel('First password').fill(TEAMMATE.password);
await addSheet.getByRole('button', { name: 'Add', exact: true }).click();
await page.waitForSelector(`text=${TEAMMATE.email}`);
await shot('13-team');

const other = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const phone = await other.newPage();
let expectingRejection = false;
let expectingNoEmail = false;
phone.on('console', (m) => {
  if (m.type() !== 'error') return;
  // The wrong password below is refused on purpose, and the browser logs it.
  if (expectingRejection && m.text().includes('401')) return;
  // So is the daily email while no email service is set up.
  if (expectingNoEmail && m.text().includes('503')) return;
  errors.push(`teammate console: ${m.text()}`);
});
phone.on('pageerror', (e) => errors.push(`teammate pageerror: ${e.message}`));
// A request the browser cancelled because the test moved on is not a failure.
phone.on('requestfailed', (r) => {
  if (r.failure()?.errorText === 'net::ERR_ABORTED') return;
  if (r.url().startsWith(BASE)) errors.push(`teammate requestfailed: ${r.method()} ${r.url()} ${r.failure()?.errorText}`);
});
await phone.goto(BASE, { waitUntil: 'networkidle' });
await phone.getByRole('button', { name: 'Sign in', exact: true }).waitFor();
await phone.getByLabel('Email').fill(TEAMMATE.email);
await phone.getByLabel('Password').fill('not the password');
expectingRejection = true;
await phone.getByRole('button', { name: 'Sign in' }).click();
await phone.waitForSelector('text=do not match an account');
expectingRejection = false;
await phone.getByLabel('Password').fill(TEAMMATE.password);
await phone.getByRole('button', { name: 'Sign in' }).click();
await phone.waitForSelector('.quick-actions');
await phone.goto(`${BASE}/search`, { waitUntil: 'networkidle' });
await phone.fill('input[type=search]', 'n917jh');
await phone.waitForSelector('.tile');
await phone.waitForTimeout(400);
await phone.locator('.tile').first().click();
await phone.waitForSelector('text=Corrected by the acceptance test.');
log('teammate sees the admin’s aircraft and its edited timeline');
if (await phone.getByRole('button', { name: 'Restore from a full export' }).count()) errors.push('restore shown to a non-admin');

await phone.getByRole('button', { name: 'Add note' }).click();
await phone.waitForSelector('.sheet');
await phone.getByLabel('Subject').fill('Teammate called the owner');
await phone.getByRole('button', { name: 'Record' }).click();
await phone.waitForTimeout(800);
const tailUrl = phone.url();
await shot('13b-teammate');
await phone.goto(`${BASE}/settings`, { waitUntil: 'networkidle' });
if (await phone.getByRole('button', { name: 'Add person' }).count()) errors.push('team management shown to a non-admin');
if (await phone.getByRole('button', { name: /Erase all/ }).count()) errors.push('erase shown to a non-admin');

await page.goto(tailUrl, { waitUntil: 'networkidle' });
await page.waitForSelector('text=Teammate called the owner', { timeout: 5000 })
  .then(() => log('admin sees what the teammate recorded'))
  .catch(() => errors.push('the teammate’s note did not reach the admin'));

// ---------------------------------------------------- 13a. activity history
// The teammate's note is in the history under the teammate's name, and the
// import shows as one line rather than a hundred.
await page.goto(`${BASE}/history`, { waitUntil: 'networkidle' });
await page.waitForSelector('.history__item', { timeout: 10000 });
// Page back to the import, which is older than the first page.
while (await page.getByRole('button', { name: 'Show older' }).count()) {
  // Each page waits for itself, so the loop never reads the list mid-load.
  const shown = await page.locator('.history__item').count();
  await page.getByRole('button', { name: 'Show older' }).click();
  await page.waitForFunction((n) => document.querySelectorAll('.history__item').length > n, shown);
}
const historyText = (await page.locator('main').innerText()).replace(/\s+/g, ' ');
if (!has(historyText, `${TEAMMATE.name} added timeline entry “Teammate called the owner”`)) {
  errors.push('the activity history does not show the teammate adding their note');
}
if (!/Scott Test created \d{3} contacts/.test(historyText)) errors.push('the import is not one grouped line in the history');
const firstLine = await page.locator('.history__item').first().innerText();
if (!has(firstLine, TEAMMATE.name)) errors.push(`newest history line is not the teammate's note: ${firstLine}`);
if (await page.locator('main').getByRole('button', { name: /delete|remove|edit/i }).count()) {
  errors.push('the activity history offers a way to change it');
}
log('activity history:', firstLine.replace(/\n/g, ' / '));
await shot('13a-history');
await page.goto(tailUrl, { waitUntil: 'networkidle' });

// ---------------------------------------------- 13b. whose follow-up it is
// The admin assigns the teammate a task to send a quote: it is on the
// teammate's list, saying what to do and who from, not on the admin's.
// Setting a follow-up has no way to give it to someone else.
const TASK = 'Call the owner back about the quote';
// The admin picks a color first: it marks the tasks they give.
await page.goto(`${BASE}/settings`, { waitUntil: 'networkidle' });
await page.getByRole('radio', { name: 'Teal' }).click();
await page.waitForSelector('.swatch.is-active', { timeout: 5000 })
  .catch(() => errors.push('picking a color did not stick'));
await shot('20b-settings-color');
await page.goto(tailUrl, { waitUntil: 'networkidle' });
await page.getByRole('button', { name: 'Follow up' }).click();
await page.waitForSelector('.sheet');
if (await page.locator('.sheet').getByLabel('Assign to').count()) errors.push('the follow-up sheet still offers to assign');
await page.getByRole('button', { name: 'Cancel' }).click();
await page.getByRole('button', { name: 'Assign', exact: true }).click();
await page.waitForSelector('.sheet');
await page.locator('.sheet').getByRole('button', { name: 'Send quote' }).click();
await page.locator('.sheet textarea').fill(TASK);
await page.locator('.sheet').getByLabel('Assign to', { exact: true }).selectOption({ label: TEAMMATE.name });
await shot('13a2-assign-sheet');
await page.locator('.sheet').getByRole('button', { name: 'Assign', exact: true }).click();
await page.waitForTimeout(800);

await phone.goto(`${BASE}/follow-ups`, { waitUntil: 'networkidle' });
await phone.waitForSelector(`text=Send quote — ${TASK}`, { timeout: 5000 })
  .then(() => log('the teammate has the task given to them, saying what to do'))
  .catch(() => errors.push('a follow-up given to the teammate is not on their list'));

await page.goto(`${BASE}/follow-ups`, { waitUntil: 'networkidle' });
await page.waitForSelector('[role=tablist]');
if (await page.getByText(TASK).count()) errors.push('a follow-up given to the teammate is on the admin’s own list');
await page.getByRole('tab', { name: /^All/ }).click();
const allCard = page.locator('.card', { hasText: TASK });
await allCard.first().waitFor({ timeout: 5000 }).catch(() => undefined);
if (!(await allCard.count())) errors.push('the teammate’s follow-up is missing from All');
else if (!has(await allCard.innerText(), TEAMMATE.name)) errors.push('the follow-up in All does not say who it is for');
await shot('13c-follow-ups-all');

if (!has(await phone.locator('.card', { hasText: TASK }).innerText(), `From ${ADMIN.name}`)) {
  errors.push('the teammate’s task does not say who gave it');
}
if (!(await phone.locator('.card', { hasText: TASK }).locator('.color-dot').count())) {
  errors.push('the task does not carry the color of who gave it');
}
await phone.locator('.card', { hasText: TASK }).scrollIntoViewIfNeeded();
await shot('13b2-teammate-task-from');
await phone.goto(`${BASE}/settings`, { waitUntil: 'networkidle' });
const tealForTeammate = phone.getByRole('radio', { name: `Teal, taken by ${ADMIN.name}` });
if (!(await tealForTeammate.count()) || !(await tealForTeammate.isDisabled())) {
  errors.push('a color someone else has can still be picked');
} else log('a color is first come, first served');
await phone.goto(`${BASE}/follow-ups`, { waitUntil: 'networkidle' });
await phone.locator('.card', { hasText: TASK }).getByRole('button', { name: 'Edit' }).click();
await phone.waitForSelector('.sheet');
await phone.locator('.sheet').getByLabel('Assign to', { exact: true }).selectOption({ label: ADMIN.name });
await phone.getByRole('button', { name: 'Save' }).click();
await phone.waitForTimeout(800);
if (await phone.getByText(TASK).count()) errors.push('a follow-up handed back still shows on the teammate’s list');

await page.goto(`${BASE}/follow-ups`, { waitUntil: 'networkidle' });
await page.waitForSelector(`text=${TASK}`, { timeout: 5000 })
  .then(() => log('the teammate handed the follow-up back to the admin'))
  .catch(() => errors.push('a follow-up handed back did not reach the admin’s list'));

// ------------------------------------------------ 13c. a shared document
// The admin attaches a PDF; the teammate, on their own device, sees it and
// downloads the same bytes. It is still there after they sign out and in.
const DOC = { name: 'e2e-binder.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 e2e binder') };
await page.goto(tailUrl, { waitUntil: 'networkidle' });
await page.locator('input[type=file]').setInputFiles(DOC);
await page.waitForSelector(`text=${DOC.name}`, { timeout: 10000 });
await page.waitForTimeout(800);

const openDoc = async (who) => {
  await who.goto(tailUrl, { waitUntil: 'networkidle' });
  const found = await who.waitForSelector(`text=${DOC.name}`, { timeout: 10000 }).then(() => true, () => false);
  if (!found) return null;
  const download = who.waitForEvent('download');
  await who.getByRole('button', { name: new RegExp(DOC.name.replace('.', '\\.')) }).first().click();
  return readFileSync(await (await download).path(), 'utf8');
};
const teammateCopy = await openDoc(phone);
if (teammateCopy === null) errors.push('the teammate does not see the document the admin attached');
else if (teammateCopy !== DOC.buffer.toString()) errors.push('the teammate downloaded different bytes');
else log('the teammate opened the document the admin attached');

await phone.goto(`${BASE}/settings`, { waitUntil: 'networkidle' });
await phone.getByRole('button', { name: 'Sign out' }).click();
await phone.getByRole('button', { name: 'Sign in', exact: true }).waitFor();
await phone.getByLabel('Email').fill(TEAMMATE.email);
await phone.getByLabel('Password').fill(TEAMMATE.password);
await phone.getByRole('button', { name: 'Sign in' }).click();
// Signing in again returns to the page they left, not necessarily Home.
await phone.waitForSelector('nav.tabbar');
if ((await openDoc(phone)) !== DOC.buffer.toString()) errors.push('the document was gone after signing out and back in');
else log('the document is still there after signing out and back in');
// The admin renames it; the teammate downloads it under the new name, same bytes.
await page.goto(tailUrl, { waitUntil: 'networkidle' });
await page.getByRole('button', { name: `Rename ${DOC.name}` }).first().click();
await page.locator('.sheet').getByLabel('File name').fill('N917JH insurance binder');
await page.locator('.sheet').getByRole('button', { name: 'Save' }).click();
await page.waitForSelector('text=N917JH insurance binder.pdf', { timeout: 5000 })
  .catch(() => errors.push('a renamed document does not show its new name'));
await page.waitForTimeout(800);
await phone.goto(tailUrl, { waitUntil: 'networkidle' });
const renamed = await phone.waitForSelector('text=N917JH insurance binder.pdf', { timeout: 10000 }).then(() => true, () => false);
if (!renamed) errors.push('the teammate does not see the new name');
else {
  const download = phone.waitForEvent('download');
  await phone.getByRole('button', { name: /N917JH insurance binder\.pdf/ }).first().click();
  const got = await download;
  if (got.suggestedFilename() !== 'N917JH insurance binder.pdf') errors.push(`the renamed document downloads as "${got.suggestedFilename()}"`);
  else if (readFileSync(await got.path(), 'utf8') !== DOC.buffer.toString()) errors.push('the renamed document lost its contents');
  else log('a renamed document downloads under its new name, same contents');
}

// ---------------------------------------- 13c2. the company data export
// The admin exports everything; the ZIP opens in the standard unzip tool and
// holds the records, the notes and the document itself. The teammate, not an
// admin, is not offered it.
await page.goto(`${BASE}/settings`, { waitUntil: 'networkidle' });
await page.getByRole('button', { name: 'Export Company Data' }).click();
await page.waitForSelector('text=Export all company data?');
const exported = page.waitForEvent('download', { timeout: 60000 });
await page.locator('.sheet').getByRole('button', { name: 'Export', exact: true }).click();
const zipFile = await exported;
const zipPath = resolve(SHOTS, 'company-export.zip');
await zipFile.saveAs(zipPath);
try {
  const listing = execFileSync('unzip', ['-l', zipPath]).toString();
  for (const name of ['README.txt', 'contacts.csv', 'notes.csv', 'tasks.csv', 'activities.csv', 'documents.csv', 'audit-log.csv', 'documents/']) {
    if (!listing.includes(`AEROBOOK-Company-Export/${name}`)) errors.push(`the company export has no ${name}`);
  }
  if (!listing.includes('N917JH insurance binder.pdf')) errors.push('the company export is missing the attached document');
  execFileSync('unzip', ['-tq', zipPath]);
  const contactsCsv = execFileSync('unzip', ['-p', zipPath, 'AEROBOOK-Company-Export/contacts.csv']).toString();
  if (!contactsCsv.includes('Contact ID')) errors.push('the exported contacts.csv has no Contact ID column');
  log(`company export: ${zipFile.suggestedFilename()}, ${listing.trim().split('\n').at(-1).trim()}`);
} catch (e) {
  errors.push(`the company export is not a readable ZIP: ${e.message}`);
}
await phone.goto(`${BASE}/settings`, { waitUntil: 'networkidle' });
if (await phone.getByRole('button', { name: 'Export Company Data' }).count()) errors.push('a non-admin is offered the company export');
if (await phone.getByRole('button', { name: /Export contacts/ }).count()) errors.push('a non-admin is offered bulk exports');
const leaked = await (await browser.newContext()).request.get(`${BASE}/api/files/content?path=files/fil_abcd/x.pdf`);
if (leaked.status() !== 401) errors.push(`a signed-out request for a document got ${leaked.status()}`);

// ------------------------------------------------ 13d. chat and comments
// The admin messages the teammate. The teammate, elsewhere in the app, gets
// a pop-up and a badge without reloading, opens the conversation from it and
// replies; the reply reaches the admin's open conversation on its own. Then
// a group, and a discussion on the aircraft itself.
await page.goto(`${BASE}/chat`, { waitUntil: 'networkidle' });
await page.waitForSelector('text=No conversations yet');
await checkOverflow('chat, empty');
await shot('16-chat-empty');
await page.getByRole('button', { name: 'New conversation' }).first().click();
await page.waitForSelector('.sheet');
await page.locator('.sheet').getByRole('button', { name: TEAMMATE.name }).click();
await page.waitForURL(/\/chat\/cv_/);
const conversationUrl = page.url();
if (await page.locator('nav.tabbar').isVisible()) errors.push('the tab bar covers the message box in a conversation');

await phone.goto(`${BASE}/aircraft`, { waitUntil: 'networkidle' });
const HELLO = 'Insurance documents updated.\nThe binder is on the aircraft.';
await page.getByLabel('Message').fill(HELLO);
await page.getByRole('button', { name: 'Send' }).click();
await page.waitForSelector('.bubble--mine:has-text("Insurance documents updated.")');
if (await page.locator('.bubble--pending').count()) await page.waitForSelector('.bubble--pending', { state: 'detached', timeout: 5000 });

const popup = await phone.waitForSelector('.alert', { timeout: 15000 }).then(() => true, () => false);
if (!popup) errors.push('the teammate got no in-app pop-up for a new message');
else {
  const popupText = await phone.locator('.alert').first().innerText();
  if (!has(popupText, `New message from ${ADMIN.name}`)) errors.push(`the pop-up reads "${popupText}"`);
  if (has(popupText, 'binder')) errors.push('the pop-up shows the message itself');
  const badge = await phone.locator('.tabbar__badge').innerText().catch(() => '');
  if (badge !== '1') errors.push(`the Chat tab badge reads "${badge}", not 1`);
  await checkOverflow('pop-up');
  await phone.screenshot({ path: `${SHOTS}/16b-chat-popup.png` });
  await phone.locator('.alert__open').first().click();
  await phone.waitForURL(conversationUrl);
  log('the teammate saw a pop-up and a badge, and opened the conversation from it');
}
if (phone.url() !== conversationUrl) await phone.goto(conversationUrl, { waitUntil: 'networkidle' });
await phone.waitForSelector('.bubble:has-text("The binder is on the aircraft.")');
const bubble = await phone.locator('.bubble').first().innerText();
if (!bubble.includes('\n')) errors.push('the message lost its line break');
await phone.waitForSelector('.tabbar__badge', { state: 'detached', timeout: 10000 })
  .catch(() => errors.push('the Chat badge stayed after the message was read'));
if (await phone.locator('.alert').count()) errors.push('a pop-up showed for the conversation already on screen');

await phone.getByLabel('Message').fill('Thanks — client requested revised coverage.');
await phone.getByRole('button', { name: 'Send' }).click();
await page.waitForSelector('.bubble:not(.bubble--mine):has-text("client requested revised coverage")', { timeout: 15000 })
  .then(() => log('the reply reached the admin’s open conversation without a reload'))
  .catch(() => errors.push('the reply did not reach the admin’s open conversation'));
if (await page.locator('.alert').count()) errors.push('the admin got a pop-up for the conversation they were looking at');

// A long message wraps rather than widening the page.
await page.getByLabel('Message').fill(`${'N917JH-'.repeat(40)}\n${'a very long line of words '.repeat(30)}`);
await page.getByRole('button', { name: 'Send' }).click();
await page.waitForTimeout(800);
await checkOverflow('conversation with a long message');
await shot('16c-conversation');
await phone.screenshot({ path: `${SHOTS}/16d-conversation-teammate.png` });

// A group.
await page.goto(`${BASE}/chat`, { waitUntil: 'networkidle' });
await page.getByRole('button', { name: 'New conversation' }).first().click();
await page.locator('.sheet').getByRole('tab', { name: 'Group' }).click();
await page.locator('.sheet').getByLabel('Group name').fill('E2E sales team');
await page.locator('.sheet').getByRole('checkbox', { name: TEAMMATE.name }).check();
await page.locator('.sheet').getByRole('button', { name: 'Create group' }).click();
await page.waitForURL(/\/chat\/cv_/);
await page.getByLabel('Message').fill('Morning, team');
await page.getByRole('button', { name: 'Send' }).click();
await page.waitForSelector('.bubble--mine:has-text("Morning, team")');
await phone.goto(`${BASE}/chat`, { waitUntil: 'networkidle' });
await phone.waitForSelector('.convo:has-text("E2E sales team")', { timeout: 10000 })
  .then(() => log('the teammate sees the group'))
  .catch(() => errors.push('the teammate does not see the group'));
const groupRow = await phone.locator('.convo:has-text("E2E sales team")').innerText().catch(() => '');
if (!has(groupRow, 'Morning, team')) errors.push(`the group row reads "${groupRow}"`);
await checkOverflow('chat list');
await phone.screenshot({ path: `${SHOTS}/16e-chat-list.png` });

// Comments on the aircraft: kept on its page, marked new for whoever has not seen them.
await page.goto(tailUrl, { waitUntil: 'networkidle' });
await page.waitForSelector('#comments');
await page.locator('#comments').scrollIntoViewIfNeeded();
await page.waitForSelector('text=No comments yet');
await page.getByLabel('Comment on this aircraft').fill('Client requested revised coverage.\nAdded the new PDF to Documents.');
await page.locator('#comments').getByRole('button', { name: 'Send' }).click();
await page.waitForSelector('.comment:has-text("Added the new PDF")');
if (!(await page.locator('#comments').getByRole('button', { name: 'Watching' }).count())) errors.push('commenting did not start watching the aircraft');
await page.locator('#comments').screenshot({ path: `${SHOTS}/17-comments.png` });

await phone.goto(`${BASE}/aircraft`, { waitUntil: 'networkidle' });
const tailId = decodeURIComponent(new URL(tailUrl).pathname.split('/').pop());
const dotted = await phone.waitForSelector(`a[href="/aircraft/${tailId}"] .unread-dot`, { timeout: 15000 }).then(() => true, () => false);
if (!dotted) errors.push('the aircraft list does not mark the aircraft with a new comment');
else log('the aircraft list marks the aircraft with a new comment');
await phone.goto(`${tailUrl}#comments`, { waitUntil: 'networkidle' });
await phone.waitForSelector('.comment:has-text("Added the new PDF")');
const newChip = await phone.locator('#comments .chip').innerText().catch(() => '');
if (!has(newChip, '1 new')) errors.push(`the comments header reads "${newChip}", not "1 new"`);
const inView = await phone.locator('#comments').evaluate((el) => el.getBoundingClientRect().top < window.innerHeight);
if (!inView) errors.push('opening an aircraft at #comments did not scroll to the comments');
// The admin, watching the aircraft, is somewhere else in the app when the teammate replies.
await page.goto(`${BASE}/contacts`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
await phone.getByLabel('Comment on this aircraft').fill('Revised quote is in.');
await phone.locator('#comments').getByRole('button', { name: 'Send' }).click();
await phone.waitForSelector('.comment:has-text("Revised quote is in.")');
await checkOverflow('aircraft comments');
await phone.screenshot({ path: `${SHOTS}/17b-comments-teammate.png`, fullPage: false });

const commentPopup = await page.waitForSelector('.alert:has-text("New comment on")', { timeout: 15000 }).then(() => true, () => false);
if (!commentPopup) errors.push('the admin got no pop-up for a comment on an aircraft they watch');
else log('the admin got a pop-up for the teammate’s comment');

// Notifications: without push keys on the server, the app says so.
await phone.goto(`${BASE}/settings`, { waitUntil: 'networkidle' });
await phone.waitForSelector('#notifications');
const notifText = await phone.locator('#notifications').innerText();
if (!has(notifText, 'need push keys') && !has(notifText, 'Turn on notifications')) {
  errors.push(`the notification settings read "${notifText}"`);
}
await phone.locator('#notifications').screenshot({ path: `${SHOTS}/18-notification-settings.png` });

// Daily email: the choice is kept, and without an API key nothing is sent.
await phone.goto(`${BASE}/settings`, { waitUntil: 'networkidle' });
const digestBox = phone.getByRole('checkbox', { name: /Email me each morning/ });
if (!(await digestBox.isChecked())) errors.push('the daily email was not on by default');
await digestBox.uncheck();
await phone.waitForTimeout(1500);
await phone.reload({ waitUntil: 'networkidle' });
if (await phone.getByRole('checkbox', { name: /Email me each morning/ }).isChecked()) errors.push('turning the daily email off did not stick');
else log('the daily email can be turned off, and stays off');
await phone.getByRole('checkbox', { name: /Email me each morning/ }).check();
expectingNoEmail = true;
await phone.getByRole('button', { name: /Send me today/ }).click();
await phone.waitForSelector('text=not set up', { timeout: 5000 }).catch(() => errors.push('no message when email is not set up'));
expectingNoEmail = false;
await phone.locator('section', { hasText: 'Daily email' }).first().screenshot({ path: `${SHOTS}/settings-daily-email.png` });

await phone.getByRole('button', { name: 'Sign out' }).click();
await phone.getByRole('button', { name: 'Sign in', exact: true }).waitFor();
await phone.goto(`${BASE}/aircraft`, { waitUntil: 'networkidle' });
if (!(await phone.getByRole('button', { name: 'Sign in' }).isVisible())) errors.push('data still showing after sign-out');
await phone.goto(`${BASE}/history`, { waitUntil: 'networkidle' });
if (!(await phone.getByRole('button', { name: 'Sign in' }).isVisible())) errors.push('history showing after sign-out');
const signedOutHistory = await phone.request.get(`${BASE}/api/history`);
if (signedOutHistory.status() !== 401) errors.push(`history API answered ${signedOutHistory.status()} when signed out`);
await other.close();

// ------------------------------------------------- 13e. deleting someone
// The admin deletes the teammate for good: they leave the team list, and
// what they wrote stays, under their name marked deleted.
await page.goto(`${BASE}/settings`, { waitUntil: 'networkidle' });
await page.getByRole('button', { name: `Manage ${TEAMMATE.name}` }).click();
await page.getByRole('button', { name: `Delete ${TEAMMATE.name}…` }).click();
const deleteButton = page.getByRole('button', { name: 'Delete for good' });
if (!(await deleteButton.isDisabled())) errors.push('deleting did not wait for the name to be typed');
await page.getByLabel(`Type “${TEAMMATE.name}” to confirm`).fill(TEAMMATE.name);
await checkOverflow('delete person');
await shot('19-delete-person');
await deleteButton.click();
await page.waitForSelector(`text=${TEAMMATE.name} was deleted`, { timeout: 10000 })
  .then(() => log('the admin deleted the teammate'))
  .catch(() => errors.push('deleting the teammate did not confirm'));
await page.waitForTimeout(500);
if (await page.getByRole('button', { name: `Manage ${TEAMMATE.name}` }).count()) errors.push('the deleted teammate is still in the team list');
await page.goto(conversationUrl, { waitUntil: 'networkidle' });
await page.waitForSelector(`.appbar__title:has-text("${TEAMMATE.name} (deleted)")`, { timeout: 10000 })
  .then(() => log('their conversation stays, under their name marked deleted'))
  .catch(() => errors.push('the conversation with the deleted teammate lost their name'));
const deletedSignIn = await (await browser.newContext()).request.post(`${BASE}/api/auth/sign-in/email`, {
  data: { email: TEAMMATE.email, password: TEAMMATE.password }, headers: { origin: BASE },
});
if (deletedSignIn.ok()) errors.push('a deleted teammate could still sign in');

// ------------------------------------------------------ two-step sign-in
// The admin turns on two-step sign-in with an authenticator app (this test
// plays the app, from the key shown for typing in), then signs out and back
// in: the password alone is not enough, a wrong code is refused, the right
// one opens the book.
function authenticatorCode(key) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const bits = [...key.replace(/\s/g, '')].map((c) => alphabet.indexOf(c).toString(2).padStart(5, '0')).join('');
  const secret = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const mac = createHmac('sha1', secret).update(counter).digest();
  const at = mac[mac.length - 1] & 0xf;
  return String((mac.readUInt32BE(at) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}
await page.goto(`${BASE}/settings`, { waitUntil: 'networkidle' });
await page.getByRole('button', { name: 'Turn on two-step sign-in' }).click();
await page.locator('.sheet').getByLabel('Password').fill(ADMIN.password);
await page.getByRole('button', { name: 'Next' }).click();
await page.waitForSelector('img[alt="QR code for your authenticator app"]');
const key = await page.locator('.sheet code.mono').innerText();
const backupCount = await page.locator('.sheet .mono > div').count();
if (backupCount !== 10) errors.push(`setup showed ${backupCount} backup codes, not 10`);
await checkOverflow('two-step setup');
await shot('14-two-step-setup');
await page.getByLabel('Code from the app').fill(authenticatorCode(key));
await page.locator('.sheet').getByRole('button', { name: 'Turn on' }).click();
await page.waitForSelector('text=Two-step sign-in is on');
if (!has(await page.locator('main').innerText(), 'Two-step sign-in')) errors.push('the two-step card is missing after turning it on');
log('two-step sign-in turned on with a code from the app');

await page.getByRole('button', { name: 'Sign out' }).click();
await page.waitForSelector('.signin form');
await page.getByLabel('Email').fill(ADMIN.email);
await page.getByLabel('Password').fill(ADMIN.password);
await page.getByRole('button', { name: 'Sign in' }).click();
await page.waitForSelector('text=Code from the app');
if (await page.locator('.tabbar').count()) errors.push('the book opened on the password alone');
const early = await page.request.get(`${BASE}/api/sync?since=0`);
if (early.status() !== 401) errors.push(`the data API answered ${early.status()} between the password and the code`);
const code = authenticatorCode(key);
adminExpectingRejection = true;
await page.getByLabel('Code from the app').fill(String((Number(code) + 500000) % 1000000).padStart(6, '0'));
await page.getByRole('button', { name: 'Sign in' }).click();
await page.waitForSelector('text=That code is not right');
adminExpectingRejection = false;
await checkOverflow('two-step code');
await shot('15-two-step-code');
await page.getByLabel('Code from the app').fill(authenticatorCode(key));
await page.getByRole('button', { name: 'Sign in' }).click();
await page.waitForSelector('.tabbar');
log('signing in asked for the code, refused a wrong one, and took the right one');

// ------------------------------------------------------------------ report
log('syncs cut off by navigation, resent on the next load:', abortedSyncs);
await browser.close();
log('\n=== console/page errors and layout problems ===');
if (errors.length === 0) log('none');
else for (const e of errors) log(' -', e);
process.exit(errors.length ? 1 : 0);
