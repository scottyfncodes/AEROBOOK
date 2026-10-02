/**
 * A recovery drill, end to end: a team's data goes in through the app, the
 * database is copied (as a backup restored elsewhere would be), the app is
 * started on the copy, and everything is checked — sign-in and two-step
 * sign-in, roles, every record and link, every document file byte for byte,
 * the audit log, and the company data export, verified against its SHA-256
 * manifest and against what the database held (scripts/dr/verify.sql and
 * scripts/dr/export-expected.sql, the same queries run on production).
 *
 * Then what a database backup alone does NOT bring back: document files live
 * in separate storage, and existing authenticator codes need the same
 * BETTER_AUTH_SECRET. Losing that secret is recovered by resetting two-step
 * sign-in — by an admin in the app, or, with no admin able to sign in, by the
 * documented SQL — after which the person sets it up again and signs in with
 * password and a new code.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, createUser, freshDatabase, ORIGIN, signIn, TEST_DB } from './testing.js';
import { handle } from './app.js';
import { getPool, resetPool } from './db.js';
import { resetAuth } from './auth.js';
import * as store from '../src/data/store';
import * as persistence from '../src/data/db';
import { exportCompanyData } from '../src/data/companyExport';
import { verifyCompanyExport, type Expected } from '../src/lib/exportVerify';
import { emptyDatabase, type Database } from '../src/data/types';

const PASSWORD = 'correct horse battery';
const SECRET = 'test-secret-that-is-long-enough-for-better-auth';
const T = '2026-10-01T12:00:00.000Z';
const SHARED = ['contacts', 'aircraft', 'opportunities', 'policies', 'activities', 'followUps', 'templates', 'imports', 'files'] as const;

/** What an authenticator app shows for this secret now (RFC 6238). */
function totp(base32: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of base32.replace(/=+$/, '').toUpperCase()) bits += alphabet.indexOf(c).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 1000 / 30)));
  const mac = createHmac('sha1', key).update(counter).digest();
  const offset = mac[mac.length - 1] & 0xf;
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}
const cookiesOf = (r: Response) => r.headers.getSetCookie().map((c) => c.split(';')[0]).filter((c) => !/=$/.test(c));

/** A contact with every field the app has. */
function fullContact(i: number) {
  return {
    id: `con_${i}`, firstName: `First${i}`, lastName: `Last${i}`, rawName: `LAST${i} FIRST${i} TRUSTEE`,
    middleName: `Middle${i}`, suffix: 'Jr', role: 'Trustee', company: `Company ${i} LLC`, email: `p${i}@example.com`,
    phone: '8055551234', address: `${i} Hangar Way`, address2: 'Suite 2', city: 'Santa Barbara', state: 'CA', zip: '93117',
    country: 'USA', contactTypes: ['Aircraft Owner', 'Insurance'], status: 'Active Client', prospectStatus: 'Engaged',
    notes: `Notes about ${i}, with a comma and "quotes"\nand a second line`, custom: { 'Fleet size': `${i}` },
    intent: {
      selling: 'Maybe', sellingNotes: `Selling notes ${i}`, buying: 'Actively', wantedAircraft: 'SR22T G6',
      budget: 'Under 1.2M', mission: 'Family trips', timeline: 'Spring', insurance: 'Actively', insuranceNotes: `Ins ${i}`,
    },
    nameConfidence: 'medium', needsReview: true, source: 'FAA import', createdAt: T, updatedAt: T, lastContactedAt: T,
  };
}

function deviceFetch(cookie: string): typeof fetch {
  return (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set('cookie', cookie);
    headers.set('origin', ORIGIN);
    return handle(new Request(`${ORIGIN}${String(input)}`, { ...init, headers }));
  };
}

function databaseUrl(name: string): string {
  const url = new URL(TEST_DB!);
  url.pathname = `/${name}`;
  return url.toString();
}
const SOURCE = new URL(TEST_DB ?? 'postgres://x/aerobook_test').pathname.slice(1);
const RESTORED = `${SOURCE}_restored`;

/** scripts/dr/verify.sql, as section.name → value, without the two rows that always differ (time, WAL position). */
async function verifySql(): Promise<Record<string, string>> {
  const sql = await readFile(new URL('../scripts/dr/verify.sql', import.meta.url), 'utf8');
  const { rows } = await getPool().query<{ section: string; name: string; value: string }>(sql);
  return Object.fromEntries(rows.filter((r) => r.section !== 'database' || r.name === 'tables_public').map((r) => [`${r.section}.${r.name}`, r.value]));
}

async function expectedFromDatabase(): Promise<Expected> {
  const sql = await readFile(new URL('../scripts/dr/export-expected.sql', import.meta.url), 'utf8');
  return (await getPool().query<{ expected: Expected }>(sql)).rows[0].expected;
}

/** Only the business data: records, documents, links. Sign-in and audit rows change when people sign in. */
const businessData = (v: Record<string, string>) =>
  Object.fromEntries(Object.entries(v).filter(([k]) => /^(records|documents|links)\./.test(k)));

describe.skipIf(!TEST_DB)('recovering from a backup', () => {
  let files: string;
  let aliceSecret: string;
  const ids = { devId: '', aliceId: '', bobId: '' };
  const originals = new Map<string, Buffer>();
  const pushed: Record<string, Record<string, unknown>[]> = {};
  let before: Record<string, string>;
  let restored: Record<string, string>;
  let alice: string; // signed in on the restored copy, with password and code
  let bob: string;

  async function signInAlice(secret = aliceSecret): Promise<string> {
    const first = await api('/api/auth/sign-in/email', { body: { email: 'alice@example.com', password: PASSWORD } });
    expect((await first.json()).twoFactorRedirect).toBe(true);
    const done = await api('/api/auth/two-factor/verify-totp', { cookie: cookiesOf(first).join('; '), body: { code: totp(secret) } });
    expect(done.status).toBe(200);
    return cookiesOf(done).join('; ');
  }

  async function pullAll(cookie: string): Promise<Database> {
    const db = emptyDatabase();
    let cursor = 0;
    for (;;) {
      const page = await (await api(`/api/sync?since=${cursor}&full=1`, { cookie })).json();
      for (const r of page.records) {
        if (r.data && (SHARED as readonly string[]).includes(r.collection)) (db[r.collection as (typeof SHARED)[number]] as unknown[]).push(r.data);
      }
      cursor = page.cursor;
      if (!page.more) return db;
    }
  }

  function expectEverythingThere(db: Database) {
    for (const [collection, records] of Object.entries(pushed)) {
      const got = new Map((db[collection as (typeof SHARED)[number]] as { id: string }[]).map((r) => [r.id, r]));
      expect(got.size, collection).toBe(records.length);
      for (const r of records) expect(got.get(r.id as string), `${collection} ${r.id}`).toEqual(r);
    }
  }

  beforeAll(async () => {
    await freshDatabase();
    files = await mkdtemp(join(tmpdir(), 'aerobook-recovery-'));
    process.env.FILES_DIR = files;
    ids.devId = (await createUser('Dana', 'dana@example.com', 'developer')).id;
    ids.aliceId = (await createUser('Alice', 'alice@example.com', 'admin')).id;
    ids.bobId = (await createUser('Bob', 'bob@example.com')).id;
    let cookie = await signIn('alice@example.com');

    // Alice uses two-step sign-in.
    const started = await api('/api/auth/two-factor/enable', { cookie, body: { password: PASSWORD } });
    aliceSecret = new URL((await started.json()).totpURI).searchParams.get('secret')!;
    cookie = cookiesOf(await api('/api/auth/two-factor/verify-totp', { cookie, body: { code: totp(aliceSecret) } })).join('; ');

    // A team's worth of data.
    pushed.contacts = Array.from({ length: 40 }, (_, i) => fullContact(i));
    pushed.aircraft = Array.from({ length: 20 }, (_, i) => ({
      id: `air_${i}`, tailNumber: `N${100 + i}AB`, tailKey: `${100 + i}AB`, year: '2020', make: 'Cirrus', model: 'SR22T',
      ownerships: [{ contactId: `con_${i}` }, ...(i % 3 === 0 ? [{ contactId: `con_${i + 20}`, endedAt: '2019-05-01' }] : [])],
      status: 'Owned', notes: `Aircraft ${i}`, custom: {}, createdAt: T, updatedAt: T,
    }));
    pushed.opportunities = Array.from({ length: 6 }, (_, i) => ({
      id: `opp_${i}`, contactId: `con_${i}`, aircraftId: `air_${i}`, type: 'Insurance', status: 'Quoting', title: `Renewal ${i}`,
      openedAt: T, notes: '', createdAt: T, updatedAt: T,
    }));
    pushed.policies = Array.from({ length: 6 }, (_, i) => ({
      id: `pol_${i}`, aircraftId: `air_${i}`, contactId: `con_${i}`, opportunityId: i < 3 ? `opp_${i}` : null, carrier: 'Carrier',
      policyNumber: `P-${i}`, brokerAgent: '', premium: '4,000', hullValue: '900,000', liabilityLimit: '1M', deductible: '',
      status: 'Unknown', quotedPremium: '', renewalNotes: '', notes: '', expirationDate: '2027-01-01', createdAt: T, updatedAt: T,
    }));
    pushed.activities = Array.from({ length: 60 }, (_, i) => ({
      id: `act_${i}`, contactId: `con_${i % 40}`, aircraftId: i % 2 ? `air_${i % 20}` : null, opportunityId: i % 10 === 0 ? `opp_${i % 6}` : null,
      type: i % 4 ? 'Note' : 'Call', date: T, subject: `Note ${i}`, notes: `What was said, ${i}`, createdAt: T,
    }));
    pushed.followUps = Array.from({ length: 8 }, (_, i) => ({
      id: `fup_${i}`, contactId: `con_${i}`, aircraftId: null, opportunityId: null, insurancePolicyId: `pol_${i % 6}`,
      dueDate: '2026-10-10', note: `Call back ${i}`, assigneeId: ids.bobId, assignedBy: ids.aliceId, completed: false, createdAt: T, updatedAt: T,
    }));
    pushed.files = [];
    for (let i = 0; i < 5; i++) {
      const id = `fil_doc${i}x`;
      const name = `Document ${i}.pdf`;
      const path = `files/${id}/${name}`;
      const bytes = randomBytes(1000 + i * 777);
      originals.set(id, bytes);
      const put = await handle(new Request(`${ORIGIN}/api/files/local?path=${encodeURIComponent(path)}`, {
        method: 'PUT', headers: { cookie, origin: ORIGIN }, body: bytes,
      }));
      expect(put.status).toBe(200);
      pushed.files.push({
        id, name, mimeType: 'application/pdf', size: bytes.length, contactId: i < 2 ? `con_${i}` : null,
        aircraftId: i >= 2 ? `air_${i}` : null, opportunityId: i === 4 ? 'opp_4' : null, blobPath: path, createdAt: T,
      });
    }
    const changes = Object.entries(pushed).flatMap(([collection, records]) =>
      records.map((data) => ({ collection, id: data.id, data, baseVersion: 0 })));
    expect((await (await api('/api/sync', { cookie, body: { changes } })).json()).applied).toHaveLength(changes.length);
    // One deletion, so the backup has history in it too.
    await api('/api/sync', { cookie, body: { changes: [{ collection: 'activities', id: 'act_59', data: null, baseVersion: 1 }] } });
    pushed.activities = pushed.activities.filter((a) => a.id !== 'act_59');
    // Comments, one of them deleted.
    for (const body of ['Hangar fee is due', 'Annual in March', 'Wrong aircraft']) {
      await api('/api/aircraft/air_1/comments', { cookie, body: { body } });
    }
    const { comments } = await (await api('/api/aircraft/air_1/comments', { cookie })).json();
    await api(`/api/aircraft/air_1/comments/${comments[2].id}/delete`, { cookie, body: {} });

    before = await verifySql();

    // The backup: a copy of the whole database made by Postgres itself, restored
    // as a database the app has never seen. The app is then started on it.
    await resetPool();
    const admin = new pg.Client({ connectionString: databaseUrl('postgres') });
    await admin.connect();
    await admin.query(`drop database if exists ${RESTORED}`);
    await admin.query(`create database ${RESTORED} template ${SOURCE}`);
    await admin.end();
    process.env.DATABASE_URL = databaseUrl(RESTORED);
    resetAuth();
    // Taken before anyone signs in: signing in writes to the audit log.
    restored = await verifySql();
    alice = await signInAlice();
    bob = await signIn('bob@example.com');
    await store.unload();
    await persistence.clearAll();
  }, 120_000);

  afterAll(async () => {
    await store.unload();
    await resetPool();
    process.env.DATABASE_URL = TEST_DB;
    process.env.BETTER_AUTH_SECRET = SECRET;
    resetAuth();
    delete process.env.FILES_DIR;
    const admin = new pg.Client({ connectionString: databaseUrl('postgres') });
    await admin.connect();
    await admin.query(`drop database if exists ${RESTORED}`);
    await admin.end();
    await rm(files, { recursive: true, force: true });
  });

  it('restores the database exactly: scripts/dr/verify.sql matches, row for row', async () => {
    expect(await getPool().query('select current_database() as d').then((r) => r.rows[0].d)).toBe(RESTORED);
    expect(restored).toEqual(before);
    expect(restored['records.contacts.live']).toBe('40');
    expect(restored['records.activities.live']).toBe('59');
    expect(restored['records.activities.deleted']).toBe('1');
    expect(restored['documents.with_blob_path']).toBe('5');
    expect(restored['team.aircraft_comments']).toBe('3');
    for (const [k, v] of Object.entries(restored)) if (k.endsWith('.dangling')) expect(v, k).toBe('0');
  });

  it('starts the app on it, and signs people in with two-step sign-in and their roles', async () => {
    const session = await (await api('/api/auth/get-session', { cookie: alice })).json();
    expect(session.user).toMatchObject({ email: 'alice@example.com', role: 'admin', twoFactorEnabled: true });
    expect((await (await api('/api/auth/get-session', { cookie: bob })).json()).user.role).toBe('user');
    const roles = (await getPool().query('select email, role from "user" order by email')).rows;
    expect(roles).toEqual([
      { email: 'alice@example.com', role: 'admin' }, { email: 'bob@example.com', role: 'user' }, { email: 'dana@example.com', role: 'developer' },
    ]);
  });

  it('gives back every contact, aircraft, opportunity, policy, activity, follow-up and document record, field for field', async () => {
    expectEverythingThere(await pullAll(alice));
  });

  it('keeps the audit log and each record’s earlier versions', async () => {
    const { rows } = await getPool().query(
      `select action, before is not null as kept from app_audit where collection = 'activities' and record_id = 'act_59' order by id`,
    );
    expect(rows).toEqual([{ action: 'create', kept: false }, { action: 'delete', kept: true }]);
    expect(restored['audit.rows']).toBe(before['audit.rows']);
    expect(restored['audit.md5']).toBe(before['audit.md5']);
  });

  it('serves every document file, byte for byte, once document storage is restored too', async () => {
    for (const f of pushed.files) {
      const r = await api(`/api/files/content?path=${encodeURIComponent(f.blobPath as string)}`, { cookie: alice });
      expect(r.status, f.id as string).toBe(200);
      expect(Buffer.from(await r.arrayBuffer()).equals(originals.get(f.id as string)!)).toBe(true);
    }
  });

  it('exports the company’s data, and the export verifies against its manifest and the database', async () => {
    const expected = await expectedFromDatabase();
    expect(expected.counts).toMatchObject({ contacts: 40, activities: 59, files: 5, policies: 6 });
    const result = await exportCompanyData(undefined, deviceFetch(alice));
    expect(result).toMatchObject({ documents: 5, documentsMissing: 0 });
    const report = await verifyCompanyExport(new Uint8Array(await result.blob.arrayBuffer()), { expected });
    expect(report.problems).toEqual([]);
    expect(report.manifest).toBe('verified');
    expect(report.counts).toMatchObject({ contacts: 40, aircraft: 20, opportunities: 6, policies: 6, activities: 59, followUps: 8, files: 5 });
    expect(report.counts.aircraftComments).toBe(2); // the deleted one stays out, as in the app
    expect(report.links.broken).toBe(0);
    // Every document, byte for byte: the export's SHA-256 is the original's.
    const { createHash } = await import('node:crypto');
    for (const d of report.documents) {
      expect(d.status).toBe('ok');
      expect(d.sha256).toBe(createHash('sha256').update(originals.get(d.id)!).digest('hex'));
    }
  });

  it('keeps the export to admins', async () => {
    expect((await api('/api/export/company', { cookie: bob, body: {} })).status).toBe(403);
    expect((await api('/api/export/company', { body: {} })).status).toBe(401);
  });

  it('does not bring documents back from the database alone', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'aerobook-empty-'));
    process.env.FILES_DIR = empty;
    try {
      const f = pushed.files[0];
      expect((await api(`/api/files/content?path=${encodeURIComponent(f.blobPath as string)}`, { cookie: alice })).status).toBe(404);
      const result = await exportCompanyData(undefined, deviceFetch(alice));
      expect(result).toMatchObject({ documents: 5, documentsMissing: 5 });
      const report = await verifyCompanyExport(new Uint8Array(await result.blob.arrayBuffer()), { expected: await expectedFromDatabase() });
      expect(report.ok).toBe(false);
      expect(report.documents.filter((d) => d.status.startsWith('not in the export'))).toHaveLength(5);
      // Restoring the storage copy brings them back.
      await cp(files, empty, { recursive: true });
      expect((await api(`/api/files/content?path=${encodeURIComponent(f.blobPath as string)}`, { cookie: alice })).status).toBe(200);
    } finally {
      process.env.FILES_DIR = files;
      await rm(empty, { recursive: true, force: true });
    }
  });

  describe('when BETTER_AUTH_SECRET is lost', () => {
    const NEW_SECRET = 'a-replacement-secret-that-is-also-long-enough';
    const audit = async () => (await getPool().query(
      `select user_id, user_name, action, record_id from app_audit where collection = 'security' and action = 'two-factor-reset' order by id`,
    )).rows;

    /** Sets up two-step sign-in again, the way Settings does, under whatever secret is in use. */
    async function enrollAgain(cookie: string): Promise<{ secret: string; cookie: string }> {
      const started = await api('/api/auth/two-factor/enable', { cookie, body: { password: PASSWORD } });
      expect(started.status).toBe(200);
      const secret = new URL((await started.json()).totpURI).searchParams.get('secret')!;
      const done = await api('/api/auth/two-factor/verify-totp', { cookie, body: { code: totp(secret) } });
      expect(done.status).toBe(200);
      return { secret, cookie: cookiesOf(done).join('; ') };
    }

    it('is recovered by an admin resetting two-step sign-in; the person sets it up again and signs in', async () => {
      // 1–2. The restored database, and the app started with a replacement secret.
      process.env.BETTER_AUTH_SECRET = NEW_SECRET;
      resetAuth();
      await getPool().query('delete from "rateLimit"');

      // Every session made under the old secret has ended.
      expect((await (await api('/api/auth/get-session', { cookie: alice })).json())?.user ?? null).toBeNull();

      // 3. The password is still right, but the authenticator code no longer works.
      const first = await api('/api/auth/sign-in/email', { body: { email: 'alice@example.com', password: PASSWORD } });
      expect((await first.json()).twoFactorRedirect).toBe(true);
      const old = await api('/api/auth/two-factor/verify-totp', { cookie: cookiesOf(first).join('; '), body: { code: totp(aliceSecret) } });
      expect(old.ok).toBe(false);

      // 4–5. The reset, by someone allowed to do it, and recorded. Not by a user; not by the person themselves.
      const bobNow = await signIn('bob@example.com');
      expect((await api('/api/team/reset-two-factor', { cookie: bobNow, body: { userId: ids.aliceId } })).status).toBe(403);
      expect((await api('/api/team/reset-two-factor', { body: { userId: ids.aliceId } })).status).toBe(401);
      expect(await audit()).toEqual([]);
      const dana = await signIn('dana@example.com'); // an admin without two-step sign-in: the password is enough
      expect((await api('/api/team/reset-two-factor', { cookie: dana, body: { userId: ids.aliceId } })).status).toBe(200);
      expect(await audit()).toEqual([{ user_id: ids.devId, user_name: 'Dana', action: 'two-factor-reset', record_id: ids.aliceId }]);

      // 6. Alice signs in with her password alone, and sets up a new authenticator.
      const passwordOnly = await api('/api/auth/sign-in/email', { body: { email: 'alice@example.com', password: PASSWORD } });
      expect(passwordOnly.status).toBe(200);
      expect((await passwordOnly.json()).twoFactorRedirect).toBeUndefined();
      const fresh = await enrollAgain(cookiesOf(passwordOnly).join('; '));
      expect(fresh.secret).not.toBe(aliceSecret);

      // 7. Password and the new code: signed in, as an admin.
      await getPool().query('delete from "rateLimit"');
      const cookie = await signInAlice(fresh.secret);
      expect((await (await api('/api/auth/get-session', { cookie })).json()).user).toMatchObject({ role: 'admin', twoFactorEnabled: true });

      // 8. The business data is untouched.
      expectEverythingThere(await pullAll(cookie));
      expect(businessData(await verifySql())).toEqual(businessData(before));
      aliceSecret = fresh.secret;
      alice = cookie;
    });

    it('is recovered with the documented SQL when no admin can sign in to reset it', async () => {
      // Lost again, and this time nobody is left to reset it in the app.
      process.env.BETTER_AUTH_SECRET = `${NEW_SECRET}-second`;
      resetAuth();
      await getPool().query('delete from "rateLimit"');
      const first = await api('/api/auth/sign-in/email', { body: { email: 'alice@example.com', password: PASSWORD } });
      const old = await api('/api/auth/two-factor/verify-totp', { cookie: cookiesOf(first).join('; '), body: { code: totp(aliceSecret) } });
      expect(old.ok).toBe(false);

      // README → "If the only admin loses their phone": run by whoever holds the database.
      const client = await getPool().connect();
      try {
        await client.query('begin');
        await client.query('delete from "twoFactor" where "userId" = $1', [ids.aliceId]);
        await client.query('update "user" set "twoFactorEnabled" = false where id = $1', [ids.aliceId]);
        await client.query('delete from session where "userId" = $1', [ids.aliceId]);
        await client.query(`delete from verification where identifier like '2fa-%' and value = $1`, [ids.aliceId]);
        await client.query(
          `insert into app_audit (user_id, user_name, action, collection, record_id, summary)
           values (null, 'Database', 'two-factor-reset', 'security', $1, 'Reset two-step sign-in')`,
          [ids.aliceId],
        );
        await client.query('commit');
      } finally {
        client.release();
      }
      expect((await audit()).at(-1)).toEqual({ user_id: null, user_name: 'Database', action: 'two-factor-reset', record_id: ids.aliceId });

      const passwordOnly = await api('/api/auth/sign-in/email', { body: { email: 'alice@example.com', password: PASSWORD } });
      expect(passwordOnly.status).toBe(200);
      const fresh = await enrollAgain(cookiesOf(passwordOnly).join('; '));
      await getPool().query('delete from "rateLimit"');
      const cookie = await signInAlice(fresh.secret);
      expect((await (await api('/api/auth/get-session', { cookie })).json()).user.role).toBe('admin');
      expectEverythingThere(await pullAll(cookie));
      expect(businessData(await verifySql())).toEqual(businessData(before));
    });
  });
});
