/**
 * Naming an admin without a developer: an admin designating another, the
 * one-time admin recovery code, and the audit record of every role change.
 * What must hold: nobody raises themselves without the password, a current
 * two-step code and the right authority; the developer role and developers'
 * accounts stay out of reach; existing admins keep their access; and no
 * password, code or recovery code is ever stored or recorded in the clear.
 */
import { createHmac } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { beforeEach, describe, expect, it } from 'vitest';
import { api, createUser, freshDatabase, signIn, TEST_DB } from './testing.js';
import { getPool } from './db.js';
import { hashRecoveryCode, STEP_UP_MAX_FAILURES } from './admin-roles.js';

const PASSWORD = 'correct horse battery';

/** What an authenticator app shows for this secret now (RFC 6238). */
function totp(base32: string, at = Date.now()): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of base32.replace(/=+$/, '').toUpperCase()) bits += alphabet.indexOf(c).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / 30)));
  const mac = createHmac('sha1', key).update(counter).digest();
  const offset = mac[mac.length - 1] & 0xf;
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}
const wrong = (code: string) => String((Number(code) + 500_000) % 1_000_000).padStart(6, '0');
const cookiesOf = (r: Response) => r.headers.getSetCookie().map((c) => c.split(';')[0]).filter((c) => !/=$/.test(c));

interface Person { id: string; email: string; cookie: string; secret?: string }

describe.skipIf(!TEST_DB)('admin contingency', () => {
  let dev: Person;
  let alice: Person; // admin
  let bob: Person; // user
  let carol: Person; // user

  /** Turns on two-step sign-in the way Settings does. */
  async function enroll(p: Person): Promise<void> {
    const started = await api('/api/auth/two-factor/enable', { cookie: p.cookie, body: { password: PASSWORD } });
    expect(started.status).toBe(200);
    const secret = new URL((await started.json()).totpURI).searchParams.get('secret')!;
    const done = await api('/api/auth/two-factor/verify-totp', { cookie: p.cookie, body: { code: totp(secret) } });
    expect(done.status).toBe(200);
    p.secret = secret;
    p.cookie = cookiesOf(done).join('; ');
  }

  const proof = (p: Person) => ({ password: PASSWORD, code: totp(p.secret!) });
  const setAdmin = (by: Person, target: Person, admin: boolean, extra: Record<string, unknown> = proof(by)) =>
    api('/api/team/admin-role', { cookie: by.cookie, body: { userId: target.id, admin, ...extra } });
  const roleOf = async (p: Person) => (await getPool().query('select role from "user" where id = $1', [p.id])).rows[0].role;
  const security = async () => (await getPool().query(
    `select user_id, user_name, action, record_id, summary, before from app_audit where collection = 'security' order by id`,
  )).rows;

  async function person(name: string, email: string, role?: 'developer' | 'admin'): Promise<Person> {
    const { id } = await createUser(name, email, role);
    return { id, email, cookie: await signIn(email) };
  }

  beforeEach(async () => {
    await freshDatabase();
    dev = await person('Dana', 'dana@example.com', 'developer');
    alice = await person('Alice', 'alice@example.com', 'admin');
    bob = await person('Bob', 'bob@example.com');
    carol = await person('Carol', 'carol@example.com');
  });

  describe('an admin designating an admin', () => {
    beforeEach(async () => {
      await enroll(alice);
      await enroll(bob);
    });

    it('makes someone an admin with their password and a current code, and records it', async () => {
      const r = await setAdmin(alice, bob, true);
      expect(r.status).toBe(200);
      expect(await roleOf(bob)).toBe('admin');
      const entry = (await security()).find((e) => e.action === 'admin-granted');
      expect(entry).toMatchObject({
        user_id: alice.id, user_name: 'Alice', record_id: bob.id, summary: 'Role changed from user to admin', before: { role: 'user' },
      });
      // Bob, now an admin, can manage accounts straight away.
      expect((await api('/api/auth/admin/list-users?limit=10', { cookie: bob.cookie })).ok).toBe(true);
    });

    it('takes the admin role away again, keeping their access', async () => {
      await setAdmin(alice, bob, true);
      const r = await setAdmin(alice, bob, false);
      expect(r.status).toBe(200);
      expect(await roleOf(bob)).toBe('user');
      expect((await api('/api/auth/admin/list-users?limit=10', { cookie: bob.cookie })).status).toBe(403);
      expect((await api('/api/sync', { cookie: bob.cookie })).ok).toBe(true);
      expect((await security()).find((e) => e.action === 'admin-revoked')).toMatchObject({
        user_id: alice.id, record_id: bob.id, summary: 'Role changed from admin to user',
      });
    });

    it('refuses without the password, without a current code, or with old ones', async () => {
      const code = totp(alice.secret!);
      for (const extra of [
        { password: PASSWORD },
        { code },
        { password: 'not the password', code },
        { password: PASSWORD, code: wrong(code) },
        { password: PASSWORD, code: totp(alice.secret!, Date.now() - 10 * 60_000) },
      ]) {
        expect((await setAdmin(alice, bob, true, extra)).status, JSON.stringify(Object.keys(extra))).toBe(403);
      }
      expect(await roleOf(bob)).toBe('user');
      expect((await security()).filter((e) => e.action === 'step-up-failed')).toHaveLength(5);
    });

    it('locks after too many wrong attempts, even with the right ones', async () => {
      for (let i = 0; i < STEP_UP_MAX_FAILURES; i++) {
        await setAdmin(alice, bob, true, { password: 'nope nope nope', code: '000000' });
      }
      expect((await setAdmin(alice, bob, true)).status).toBe(429);
      expect(await roleOf(bob)).toBe('user');
    });

    it('needs the admin to have two-step sign-in on', async () => {
      const abe = await person('Abe', 'abe@example.com', 'admin');
      const r = await api('/api/team/admin-role', { cookie: abe.cookie, body: { userId: bob.id, admin: true, password: PASSWORD, code: '123456' } });
      expect(r.status).toBe(403);
      expect((await r.json()).error).toMatch(/two-step/i);
      expect(await roleOf(bob)).toBe('user');
    });

    it('only makes admins of people who sign in with two-step sign-in', async () => {
      const r = await setAdmin(alice, carol, true);
      expect(r.status).toBe(409);
      expect(await roleOf(carol)).toBe('user');
    });

    it('never makes anyone a developer, and never touches a developer', async () => {
      const asDev = await api('/api/team/admin-role', { cookie: alice.cookie, body: { userId: bob.id, admin: 'developer', ...proof(alice) } });
      expect(asDev.status).toBe(400);
      expect((await setAdmin(alice, dev, false)).status).toBe(403);
      expect((await setAdmin(alice, dev, true)).status).toBe(403);
      expect(await roleOf(dev)).toBe('developer');
      expect(await roleOf(bob)).toBe('user');
    });

    it('does not let an admin change their own role', async () => {
      expect((await setAdmin(alice, alice, false)).status).toBe(400);
      expect(await roleOf(alice)).toBe('admin');
    });

    it('does not let someone who is not an admin designate anyone, themselves included', async () => {
      expect((await setAdmin(bob, bob, true)).status).toBe(403);
      await enroll(carol);
      expect((await setAdmin(bob, carol, true)).status).toBe(403);
      expect(await roleOf(bob)).toBe('user');
      expect(await roleOf(carol)).toBe('user');
      // Nor through Better Auth's own admin routes.
      expect((await api('/api/auth/admin/set-role', { cookie: bob.cookie, body: { userId: bob.id, role: 'admin' } })).status).toBe(403);
      expect(await roleOf(bob)).toBe('user');
    });

    it('still refuses an admin through Better Auth’s routes, which have no two-step check', async () => {
      const r = await api('/api/auth/admin/set-role', { cookie: alice.cookie, body: { userId: bob.id, role: 'admin' } });
      expect(r.status).toBe(403);
      expect(await roleOf(bob)).toBe('user');
    });

    it('does not let an admin designate from an impersonated session', async () => {
      const r = await api('/api/auth/admin/impersonate-user', { cookie: alice.cookie, body: { userId: carol.id } });
      if (!r.ok) return; // Impersonation is refused outright: nothing more to check.
      const asCarol = cookiesOf(r).join('; ');
      const tried = await api('/api/team/recovery-code/redeem', { cookie: asCarol, body: { recoveryCode: 'X', ...proof(alice) } });
      expect([401, 403]).toContain(tried.status);
      expect(await roleOf(carol)).toBe('user');
    });

    it('refuses deleted people, people whose access is off, and people who do not exist', async () => {
      await api('/api/auth/admin/ban-user', { cookie: alice.cookie, body: { userId: bob.id } });
      expect((await setAdmin(alice, bob, true)).status).toBe(409);
      expect((await api('/api/team/admin-role', { cookie: alice.cookie, body: { userId: 'nobody', admin: true, ...proof(alice) } })).status).toBe(404);
      expect(await roleOf(bob)).toBe('user');
    });

    it('wants a same-origin JSON request and a session', async () => {
      expect((await api('/api/team/admin-role', { body: { userId: bob.id, admin: true, ...proof(alice) } })).status).toBe(401);
      expect((await api('/api/team/admin-role', { cookie: alice.cookie, headers: { origin: 'https://evil.example' }, body: { userId: bob.id, admin: true, ...proof(alice) } })).status).toBe(403);
      expect((await api('/api/team/admin-role', { cookie: alice.cookie })).status).toBe(405);
      expect(await roleOf(bob)).toBe('user');
    });

    it('leaves every other admin as they were', async () => {
      const abe = await person('Abe', 'abe@example.com', 'admin');
      await setAdmin(alice, bob, true);
      expect(await roleOf(abe)).toBe('admin');
      expect(await roleOf(alice)).toBe('admin');
      expect(await roleOf(dev)).toBe('developer');
      expect((await api('/api/sync', { cookie: abe.cookie })).ok).toBe(true);
    });

    it('never writes the password or the code to the audit log', async () => {
      const p = proof(alice);
      await setAdmin(alice, bob, true, p);
      await setAdmin(alice, carol, true, { password: PASSWORD, code: wrong(p.code) });
      const text = JSON.stringify(await getPool().query('select * from app_audit').then((r) => r.rows));
      expect(text).not.toContain(PASSWORD);
      expect(text).not.toContain(p.code);
    });
  });

  describe('the admin recovery code', () => {
    let code: string;
    beforeEach(async () => {
      await enroll(alice);
      await enroll(carol);
      const made = await api('/api/team/recovery-code', { cookie: alice.cookie, body: proof(alice) });
      expect(made.status).toBe(200);
      code = (await made.json()).recoveryCode;
    });
    const redeem = (p: Person, recoveryCode = code, extra: Record<string, unknown> = proof(p)) =>
      api('/api/team/recovery-code/redeem', { cookie: p.cookie, body: { recoveryCode, ...extra } });

    it('is stored only as a hash, and shown only once', async () => {
      expect(code).toMatch(/^[A-Z2-7]{4}(-[A-Z2-7]{4}){7}$/);
      const { rows } = await getPool().query('select * from app_admin_recovery');
      expect(rows).toHaveLength(1);
      expect(rows[0].code_hash).toBe(hashRecoveryCode(code));
      expect(JSON.stringify(rows)).not.toContain(code);
      const status = await (await api('/api/team/recovery-code', { cookie: alice.cookie })).json();
      expect(status).toMatchObject({ exists: true, createdBy: 'Alice' });
      expect(JSON.stringify(status)).not.toContain(code.slice(0, 9));
      const text = JSON.stringify((await getPool().query('select * from app_audit')).rows);
      expect(text).not.toContain(code);
    });

    it('lets someone on the team become an admin once, with their own password and code', async () => {
      const r = await redeem(carol, code.toLowerCase().replace(/-/g, ' '));
      expect(r.status).toBe(200);
      expect(await roleOf(carol)).toBe('admin');
      expect((await getPool().query('select 1 from app_admin_recovery')).rows).toHaveLength(0);
      expect((await security()).find((e) => e.action === 'admin-recovered')).toMatchObject({
        user_id: carol.id, record_id: carol.id, before: { role: 'user' },
      });
      // Used up: a second person cannot use it.
      await enroll(bob);
      expect((await redeem(bob)).status).toBe(403);
      expect(await roleOf(bob)).toBe('user');
      // Existing admins are untouched.
      expect(await roleOf(alice)).toBe('admin');
      expect(await roleOf(dev)).toBe('developer');
    });

    it('is refused without two-step sign-in, without the password, or with a current code missing', async () => {
      expect((await redeem(bob, code, { password: PASSWORD, code: '123456' })).status).toBe(403);
      expect((await redeem(carol, code, { password: 'wrong wrong wrong' , code: totp(carol.secret!) })).status).toBe(403);
      expect((await redeem(carol, code, { password: PASSWORD })).status).toBe(403);
      expect(await roleOf(bob)).toBe('user');
      expect(await roleOf(carol)).toBe('user');
      // The code was not used up by any of that.
      expect((await getPool().query('select 1 from app_admin_recovery')).rows).toHaveLength(1);
    });

    it('is refused for a wrong code, and recorded', async () => {
      const r = await redeem(carol, 'AAAA-BBBB-CCCC-DDDD-EEEE-FFFF-GGGG-HHHH');
      expect(r.status).toBe(403);
      expect(await roleOf(carol)).toBe('user');
      expect((await security()).some((e) => e.action === 'admin-recovery-failed' && e.user_id === carol.id)).toBe(true);
    });

    it('stops working when an admin makes a new one or cancels it', async () => {
      const next = (await (await api('/api/team/recovery-code', { cookie: alice.cookie, body: proof(alice) })).json()).recoveryCode;
      expect(next).not.toBe(code);
      expect((await redeem(carol)).status).toBe(403);
      expect((await api('/api/team/recovery-code/revoke', { cookie: alice.cookie, body: proof(alice) })).status).toBe(200);
      expect((await redeem(carol, next)).status).toBe(403);
      expect(await roleOf(carol)).toBe('user');
      const actions = (await security()).map((e) => e.action);
      expect(actions).toContain('admin-recovery-code-created');
      expect(actions).toContain('admin-recovery-code-revoked');
    });

    it('can only be made or seen by an admin who confirms it is them', async () => {
      expect((await api('/api/team/recovery-code', { cookie: carol.cookie, body: proof(carol) })).status).toBe(403);
      expect((await api('/api/team/recovery-code', { cookie: carol.cookie })).status).toBe(403);
      expect((await api('/api/team/recovery-code', { cookie: alice.cookie, body: { password: PASSWORD } })).status).toBe(403);
      expect((await api('/api/team/recovery-code', { body: proof(alice) })).status).toBe(401);
    });

    it('is not for someone who is already an admin', async () => {
      expect((await redeem(alice)).status).toBe(409);
      expect((await getPool().query('select 1 from app_admin_recovery')).rows).toHaveLength(1);
    });

    it('is not for an account whose access is off', async () => {
      await api('/api/auth/admin/ban-user', { cookie: alice.cookie, body: { userId: carol.id } });
      expect((await redeem(carol)).status).toBe(401);
      expect(await roleOf(carol)).toBe('user');
    });
  });

  describe('every role change is recorded', () => {
    it('including a developer’s, through Better Auth', async () => {
      await api('/api/auth/admin/set-role', { cookie: dev.cookie, body: { userId: bob.id, role: 'admin' } });
      await api('/api/auth/admin/set-role', { cookie: dev.cookie, body: { userId: bob.id, role: 'user' } });
      await api('/api/auth/admin/create-user', {
        cookie: dev.cookie, body: { name: 'Eve', email: 'eve@example.com', password: PASSWORD, role: 'admin' },
      });
      const changes = (await security()).filter((e) => e.action === 'role-changed');
      expect(changes.map((e) => e.summary)).toEqual([
        'Role changed from user to admin', 'Role changed from admin to user', 'Added as admin',
      ]);
      expect(changes.every((e) => e.user_id === dev.id)).toBe(true);
    });

    it('but not a refused attempt, or a change that changes nothing', async () => {
      await api('/api/auth/admin/set-role', { cookie: alice.cookie, body: { userId: bob.id, role: 'admin' } });
      await api('/api/auth/admin/set-role', { cookie: dev.cookie, body: { userId: bob.id, role: 'user' } });
      expect((await security()).filter((e) => e.action === 'role-changed')).toHaveLength(0);
    });

    it('stays out of the activity history everyone reads', async () => {
      await enroll(alice);
      await enroll(bob);
      await setAdmin(alice, bob, true);
      const history = await (await api('/api/history', { cookie: carol.cookie })).json();
      expect(history.entries).toHaveLength(0);
    });
  });

  describe('a recovery code and the admin who made it', () => {
    // Bob plays the admin who makes the code and is later removed.
    let code: string;
    beforeEach(async () => {
      await enroll(alice);
      await enroll(bob);
      await enroll(carol);
      expect((await setAdmin(alice, bob, true)).status).toBe(200);
      const made = await api('/api/team/recovery-code', { cookie: bob.cookie, body: proof(bob) });
      expect(made.status).toBe(200);
      code = (await made.json()).recoveryCode;
    });
    const redeem = (p: Person, recoveryCode = code) =>
      api('/api/team/recovery-code/redeem', { cookie: p.cookie, body: { recoveryCode, ...proof(p) } });
    const codeRows = async () => (await getPool().query('select created_by from app_admin_recovery')).rows;
    const cancellations = async () => (await security()).filter((e) => e.action === 'admin-recovery-code-revoked');

    it('stops working when its maker is removed, so the removed admin cannot restore themselves', async () => {
      // 1–2. Bob made the code; Alice removes Bob's admin role.
      expect((await setAdmin(alice, bob, false)).status).toBe(200);
      // 8. The removal cancelled the code, and says so in the audit log.
      expect(await codeRows()).toEqual([]);
      expect(await cancellations()).toEqual([expect.objectContaining({
        user_id: alice.id, record_id: bob.id, summary: 'Cancelled the admin recovery code: whoever made it is no longer an admin',
      })]);
      // 3–5. Bob tries his own code: refused, and he stays a user.
      const tried = await redeem(bob);
      expect(tried.status).toBe(403);
      expect(await roleOf(bob)).toBe('user');
      // 6. The attempt is recorded.
      expect((await security()).filter((e) => e.action === 'admin-recovery-failed').map((e) => e.user_id)).toEqual([bob.id]);
      // 7. Never again, by him or anyone, even after he is made an admin again and removed again.
      expect((await redeem(bob)).status).toBe(403);
      expect((await redeem(carol)).status).toBe(403);
      expect((await setAdmin(alice, bob, true)).status).toBe(200);
      expect(await (await api('/api/team/recovery-code', { cookie: bob.cookie })).json()).toEqual({ exists: false });
      expect((await setAdmin(alice, bob, false)).status).toBe(200);
      expect((await redeem(bob)).status).toBe(403);
      expect(await roleOf(bob)).toBe('user');
      expect(await roleOf(carol)).toBe('user');
    });

    it('is refused to its own maker on the server, even if the code was somehow left in place', async () => {
      // Bob's role taken away outside every path that cancels the code.
      await getPool().query(`update "user" set role = 'user' where id = $1`, [bob.id]);
      expect(await codeRows()).toHaveLength(1);
      const tried = await redeem(bob);
      expect(tried.status).toBe(403);
      expect((await tried.json()).error).toMatch(/made yourself/);
      expect(await roleOf(bob)).toBe('user');
      expect(await codeRows()).toEqual([]);
      expect((await security()).find((e) => e.action === 'admin-recovery-failed')).toMatchObject({
        user_id: bob.id, summary: 'Tried to use the admin recovery code they made themselves; refused',
      });
      expect((await redeem(bob)).status).toBe(403);
      expect(await roleOf(bob)).toBe('user');
    });

    it('is refused to anyone once its maker is no longer an admin, however that happened', async () => {
      await getPool().query(`update "user" set role = 'user' where id = $1`, [bob.id]);
      const tried = await redeem(carol);
      expect(tried.status).toBe(403);
      expect(await roleOf(carol)).toBe('user');
      expect(await codeRows()).toEqual([]);
      expect((await security()).find((e) => e.action === 'admin-recovery-failed')).toMatchObject({
        user_id: carol.id, summary: 'Tried an admin recovery code whose maker is no longer an admin; refused',
      });
    });

    it.each([
      ['a developer changes their role (Better Auth set-role)', () => api('/api/auth/admin/set-role', { cookie: dev.cookie, body: { userId: bob.id, role: 'user' } })],
      ['an admin turns their access off (Better Auth ban-user)', () => api('/api/auth/admin/ban-user', { cookie: alice.cookie, body: { userId: bob.id } })],
      ['an admin deletes them (Settings → Team → Delete)', () => api('/api/team/delete', { cookie: alice.cookie, body: { userId: bob.id } })],
      ['a developer removes them (Better Auth remove-user)', () => api('/api/auth/admin/remove-user', { cookie: dev.cookie, body: { userId: bob.id } })],
    ])('is cancelled when %s', async (_, end) => {
      const r = await end();
      expect(r.status).toBe(200);
      expect(await codeRows()).toEqual([]);
      expect(await cancellations()).toHaveLength(1);
      expect((await redeem(carol)).status).toBe(403);
      expect(await roleOf(carol)).toBe('user');
    });

    it('is cancelled when the database script takes their admin role away', async () => {
      await promisify(execFile)('npx', ['tsx', 'scripts/admin-recover.ts', 'revoke', 'bob@example.com'], {
        env: { ...process.env, DATABASE_URL: TEST_DB },
      });
      expect(await roleOf(bob)).toBe('user');
      expect(await codeRows()).toEqual([]);
      expect(await cancellations()).toEqual([expect.objectContaining({ user_id: null, record_id: bob.id })]);
    }, 60_000);

    it('keeps working when some other admin is removed', async () => {
      await setAdmin(alice, carol, true);
      expect((await setAdmin(alice, carol, false)).status).toBe(200);
      expect(await codeRows()).toEqual([{ created_by: bob.id }]);
      expect(await cancellations()).toEqual([]);
      expect((await redeem(carol)).status).toBe(200);
      expect(await roleOf(carol)).toBe('admin');
    });
  });

  describe('at the same moment', () => {
    beforeEach(async () => {
      await enroll(alice);
      await enroll(bob);
      expect((await setAdmin(alice, bob, true)).status).toBe(200);
      // Without the developer, so nobody else is left to keep the account manageable.
      await getPool().query(`update "user" set role = 'user' where id = $1`, [dev.id]);
    });
    const managers = async () => (await getPool().query<{ id: string }>(
      `select id from "user" where role in ('admin', 'developer') and not coalesce(banned, false) order by id`,
    )).rows.map((r) => r.id);

    it.each([1, 2, 3])('two admins removing each other leave exactly one admin (round %i)', async () => {
      // Both requests start as admins, pass their password and code, then contend for the decision.
      const [byAlice, byBob] = await Promise.all([setAdmin(alice, bob, false), setAdmin(bob, alice, false)]);
      const statuses = [byAlice.status, byBob.status].sort();
      expect(statuses).toEqual([200, 403]);
      const winner = byAlice.status === 200 ? alice : bob;
      const loser = winner === alice ? bob : alice;
      // The loser was an admin when their request arrived, and is refused because they no longer are.
      expect((await (winner === alice ? byBob : byAlice).json()).error).toBe('Only an admin can do that');
      expect(await managers()).toEqual([winner.id]);
      expect(await roleOf(loser)).toBe('user');
      const revoked = (await security()).filter((e) => e.action === 'admin-revoked');
      expect(revoked).toEqual([expect.objectContaining({ user_id: winner.id, record_id: loser.id, summary: 'Role changed from admin to user' })]);
    });

    it('two people redeeming one code: exactly one becomes an admin', async () => {
      // Better Auth limits how often two-step sign-in can be set up; this test sets it up for more people at once.
      await getPool().query('delete from "rateLimit"');
      await enroll(carol);
      const erin = await person('Erin', 'erin@example.com');
      await enroll(erin);
      const code = (await (await api('/api/team/recovery-code', { cookie: alice.cookie, body: proof(alice) })).json()).recoveryCode;
      const results = await Promise.all([carol, erin].map((p) =>
        api('/api/team/recovery-code/redeem', { cookie: p.cookie, body: { recoveryCode: code, ...proof(p) } })));
      expect(results.map((r) => r.status).sort()).toEqual([200, 403]);
      expect([await roleOf(carol), await roleOf(erin)].sort()).toEqual(['admin', 'user']);
      expect((await security()).filter((e) => e.action === 'admin-recovered')).toHaveLength(1);
    });
  });
});
