/**
 * A recovery drill, end to end: a team's data goes in through the app, the
 * database is copied (as a backup restored elsewhere would be), the app is
 * pointed at the copy, and everything is checked — sign-in and two-step
 * sign-in, roles, every record and link, every document file byte for byte,
 * the audit log, and the complete archive, against the same fingerprint
 * scripts/recovery-fingerprint.sql takes of production.
 *
 * Also what a database backup alone does NOT bring back: document files live
 * in separate storage, and two-step sign-in needs the same BETTER_AUTH_SECRET.
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
import { buildArchive, verifyArchive, type Manifest } from '../src/lib/archive.js';
import { emptyDatabase, type Database, type FileRecord } from '../src/data/types.js';
import { fullContact } from '../src/test/fixtures.js';

const PASSWORD = 'correct horse battery';
const SECRET = 'test-secret-that-is-long-enough-for-better-auth';

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

const SHARED = ['contacts', 'aircraft', 'opportunities', 'policies', 'activities', 'followUps', 'templates', 'imports', 'files'] as const;
const T = '2026-10-01T12:00:00.000Z';

/** A connection string for another database on the same server. */
function databaseUrl(name: string): string {
  const url = new URL(TEST_DB!);
  url.pathname = `/${name}`;
  return url.toString();
}
const RESTORED = `${new URL(TEST_DB ?? 'postgres://x/aerobook_test').pathname.slice(1)}_restored`;

async function fingerprint(): Promise<Record<string, unknown>[]> {
  const sql = await readFile(new URL('../scripts/recovery-fingerprint.sql', import.meta.url), 'utf8');
  return (await getPool().query(sql)).rows;
}

describe.skipIf(!TEST_DB)('recovering from a backup', () => {
  let files: string; // document storage, as it was
  let alice: string;
  let aliceSecret: string;
  const ids = { devId: '', aliceId: '', bobId: '' };
  const originals = new Map<string, Buffer>();
  const pushed: Record<string, Record<string, unknown>[]> = {};
  let before: Record<string, unknown>[];
  /** Sessions made against the restored database; sign-in is rate-limited. */
  let restoredAlice: string;
  let restoredBob: string;
  let restored: Record<string, unknown>[];

  beforeAll(async () => {
    await freshDatabase();
    files = await mkdtemp(join(tmpdir(), 'aerobook-recovery-'));
    process.env.FILES_DIR = files;
    ids.devId = (await createUser('Dana', 'dana@example.com', 'developer')).id;
    ids.aliceId = (await createUser('Alice', 'alice@example.com', 'admin')).id;
    ids.bobId = (await createUser('Bob', 'bob@example.com')).id;
    alice = await signIn('alice@example.com');

    // Alice signs in with two-step sign-in.
    const started = await api('/api/auth/two-factor/enable', { cookie: alice, body: { password: PASSWORD } });
    aliceSecret = new URL((await started.json()).totpURI).searchParams.get('secret')!;
    alice = cookiesOf(await api('/api/auth/two-factor/verify-totp', { cookie: alice, body: { code: totp(aliceSecret) } })).join('; ');

    // A team's worth of data.
    pushed.contacts = Array.from({ length: 40 }, (_, i) => ({ ...fullContact(i) }));
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
      id: `fu_${i}`, contactId: `con_${i}`, aircraftId: null, opportunityId: null, insurancePolicyId: `pol_${i % 6}`,
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
        method: 'PUT', headers: { cookie: alice, origin: ORIGIN }, body: bytes,
      }));
      expect(put.status).toBe(200);
      pushed.files.push({
        id, name, mimeType: 'application/pdf', size: bytes.length, contactId: i < 2 ? `con_${i}` : null,
        aircraftId: i >= 2 ? `air_${i}` : null, opportunityId: i === 4 ? 'opp_4' : null, blobPath: path, createdAt: T,
      });
    }
    const changes = Object.entries(pushed).flatMap(([collection, records]) =>
      records.map((data) => ({ collection, id: data.id, data, baseVersion: 0 })));
    const saved = await api('/api/sync', { cookie: alice, body: { changes } });
    expect((await saved.json()).applied).toHaveLength(changes.length);
    // One deletion, so the backup has history in it too.
    await api('/api/sync', { cookie: alice, body: { changes: [{ collection: 'activities', id: 'act_59', data: null, baseVersion: 1 }] } });
    pushed.activities = pushed.activities.filter((a) => a.id !== 'act_59');
    // Comments, one of them deleted.
    for (const body of ['Hangar fee is due', 'Annual in March', 'Wrong aircraft']) {
      await api('/api/aircraft/air_1/comments', { cookie: alice, body: { body } });
    }
    const { comments } = await (await api('/api/aircraft/air_1/comments', { cookie: alice })).json();
    await api(`/api/aircraft/air_1/comments/${comments[2].id}/delete`, { cookie: alice, body: {} });

    before = await fingerprint();

    // The backup: a copy of the whole database, made by Postgres itself, then
    // restored as a separate database the app has never seen.
    await resetPool();
    const admin = new pg.Client({ connectionString: databaseUrl('postgres') });
    await admin.connect();
    await admin.query(`drop database if exists ${RESTORED}`);
    await admin.query(`create database ${RESTORED} template ${new URL(TEST_DB!).pathname.slice(1)}`);
    await admin.end();
    process.env.DATABASE_URL = databaseUrl(RESTORED);
    resetAuth();
    // Taken before anyone signs in: signing in writes to the audit log.
    restored = await fingerprint();
    restoredAlice = await signInAlice();
    restoredBob = await signIn('bob@example.com');
  }, 120_000);

  afterAll(async () => {
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

  /** The restored app, signed in as Alice with her password and authenticator code. */
  async function signInAlice(): Promise<string> {
    const first = await api('/api/auth/sign-in/email', { body: { email: 'alice@example.com', password: PASSWORD } });
    expect((await first.json()).twoFactorRedirect).toBe(true);
    const done = await api('/api/auth/two-factor/verify-totp', { cookie: cookiesOf(first).join('; '), body: { code: totp(aliceSecret) } });
    expect(done.status).toBe(200);
    return cookiesOf(done).join('; ');
  }

  async function pullAll(cookie: string): Promise<Database> {
    const db = emptyDatabase();
    let cursor = 0;
    for (;;) {
      const page = await (await api(`/api/sync?since=${cursor}&full=1`, { cookie })).json();
      for (const r of page.records) if (r.data && (SHARED as readonly string[]).includes(r.collection)) (db[r.collection as (typeof SHARED)[number]] as unknown[]).push(r.data);
      cursor = page.cursor;
      if (!page.more) return db;
    }
  }

  it('restores the database exactly: the same fingerprint, check for check', async () => {
    expect(await getPool().query('select current_database() as d').then((r) => r.rows[0].d)).toBe(RESTORED);
    const after = restored;
    expect(after).toEqual(before);
    const n = (name: string) => Number(after.find((r) => r.check_name === name)?.n);
    expect(n('record:contacts')).toBe(40);
    expect(n('record:activities')).toBe(59);
    expect(n('record:files')).toBe(5);
    expect(n('comments')).toBe(3);
    // Every link resolves.
    for (const r of after.filter((x) => String(x.check_name).startsWith('links:'))) expect(Number(r.extra), String(r.check_name)).toBe(0);
  });

  it('signs people in, with two-step sign-in and their roles, as before', async () => {
    const cookie = restoredAlice;
    const session = await (await api('/api/auth/get-session', { cookie })).json();
    expect(session.user).toMatchObject({ email: 'alice@example.com', role: 'admin', twoFactorEnabled: true });
    expect((await (await api('/api/auth/get-session', { cookie: restoredBob })).json()).user.role).toBe('user');
    const roles = (await getPool().query('select email, role from "user" order by email')).rows;
    expect(roles).toEqual([
      { email: 'alice@example.com', role: 'admin' }, { email: 'bob@example.com', role: 'user' }, { email: 'dana@example.com', role: 'developer' },
    ]);
  });

  it('gives back every record and link through the app, field for field', async () => {
    const db = await pullAll(restoredAlice);
    for (const [collection, records] of Object.entries(pushed)) {
      const got = new Map((db[collection as (typeof SHARED)[number]] as { id: string }[]).map((r) => [r.id, r]));
      expect(got.size, collection).toBe(records.length);
      for (const r of records) expect(got.get(r.id as string), `${collection} ${r.id}`).toEqual(r);
    }
  });

  it('keeps the audit log and each record’s earlier versions', async () => {
    const { rows } = await getPool().query(
      `select action, before is not null as kept from app_audit where collection = 'activities' and record_id = 'act_59' order by id`,
    );
    expect(rows).toEqual([{ action: 'create', kept: false }, { action: 'delete', kept: true }]);
    const security = await getPool().query(`select count(*)::int as n from app_audit where collection = 'security'`);
    expect(security.rows[0].n).toBeGreaterThan(0);
  });

  it('serves every document file, byte for byte, once document storage is restored too', async () => {
    const cookie = restoredAlice;
    for (const f of pushed.files) {
      const r = await api(`/api/files/content?path=${encodeURIComponent(f.blobPath as string)}`, { cookie });
      expect(r.status, f.id as string).toBe(200);
      expect(Buffer.from(await r.arrayBuffer()).equals(originals.get(f.id as string)!)).toBe(true);
    }
  });

  it('exports a complete archive that matches the database fingerprint', async () => {
    const cookie = restoredAlice;
    const db = await pullAll(cookie);
    const { comments } = await (await api('/api/export/comments', { cookie })).json();
    expect(comments).toHaveLength(2); // the deleted one stays out, as in the app
    const { zip, manifest } = await buildArchive({
      db, comments, readFile: async (f: FileRecord) => {
        const r = await api(`/api/files/content?path=${encodeURIComponent(f.blobPath ?? '')}`, { cookie });
        return r.ok ? new Uint8Array(await r.arrayBuffer()) : undefined;
      },
    });
    expect(manifest.problems).toEqual([]);
    const report = await verifyArchive(zip);
    expect(report.ok).toBe(true);
    expect(report.documents).toEqual({ expected: 5, present: 5, missing: [], corrupted: [] });

    const fp = await fingerprint();
    const sha = (name: string) => fp.find((r) => r.check_name === name)?.live_ids_sha256;
    for (const c of SHARED) {
      if (!pushed[c]) continue;
      expect(manifest.collections[c as keyof Manifest['collections']].idsSha256, c).toBe(sha(`record:${c}`));
    }
    expect(manifest.collections.aircraftComments.idsSha256).toBe(sha('comments:exportable'));
  });

  it('keeps the export to admins', async () => {
    expect((await api('/api/export/comments', { cookie: restoredBob })).status).toBe(403);
    expect((await api('/api/export/comments')).status).toBe(401);
  });

  it('does not bring documents back from the database alone', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'aerobook-empty-'));
    process.env.FILES_DIR = empty;
    try {
      const cookie = restoredAlice;
      const f = pushed.files[0];
      expect((await api(`/api/files/content?path=${encodeURIComponent(f.blobPath as string)}`, { cookie })).status).toBe(404);
      const { manifest, zip } = await buildArchive({
        db: await pullAll(cookie), comments: [], readFile: async () => undefined,
      });
      expect(manifest.documents.filter((d) => d.status === 'missing')).toHaveLength(5);
      expect((await verifyArchive(zip)).documents.missing).toHaveLength(5);
      // Restoring the storage copy brings them back.
      await cp(files, empty, { recursive: true });
      expect((await api(`/api/files/content?path=${encodeURIComponent(f.blobPath as string)}`, { cookie })).status).toBe(200);
    } finally {
      process.env.FILES_DIR = files;
      await rm(empty, { recursive: true, force: true });
    }
  });

  it('needs the same BETTER_AUTH_SECRET for two-step sign-in, though passwords work without it', async () => {
    process.env.BETTER_AUTH_SECRET = 'a-different-secret-that-is-also-long-enough';
    resetAuth();
    try {
      await getPool().query('delete from "rateLimit"');
      expect(await signIn('bob@example.com')).toContain('session_token');
      const first = await api('/api/auth/sign-in/email', { body: { email: 'alice@example.com', password: PASSWORD } });
      const r = await api('/api/auth/two-factor/verify-totp', { cookie: cookiesOf(first).join('; '), body: { code: totp(aliceSecret) } });
      expect(r.ok).toBe(false);
    } finally {
      process.env.BETTER_AUTH_SECRET = SECRET;
      resetAuth();
    }
  });
});
