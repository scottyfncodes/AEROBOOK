/**
 * Two-step sign-in for admins: setting it up, signing in with it, losing the
 * phone, and everything that must stay as it was — ordinary users, accounts
 * whose access is off, the activity history, and secrets that must never be
 * shown or logged.
 */
import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, createUser, freshDatabase, ORIGIN, signIn, TEST_DB } from './testing.js';
import { getPool } from './db.js';

/** An authenticator app, per RFC 6238: what a phone would show for this secret now. */
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

/** A code the app would not show now. */
const wrong = (code: string) => String((Number(code) + 500_000) % 1_000_000).padStart(6, '0');

const PASSWORD = 'correct horse battery';
const cookiesOf = (r: Response) => r.headers.getSetCookie().map((c) => c.split(';')[0]).filter((c) => !/=$/.test(c));
const join = (...parts: string[][]) => parts.flat().join('; ');

describe.skipIf(!TEST_DB)('two-step sign-in', () => {
  let alice: string; // admin
  let aliceId: string;
  let bob: string; // not an admin
  let bobId: string;
  let carolId: string; // a second admin

  beforeEach(async () => {
    await freshDatabase();
    aliceId = (await createUser('Alice', 'alice@example.com', 'admin')).id;
    bobId = (await createUser('Bob', 'bob@example.com')).id;
    carolId = (await createUser('Carol', 'carol@example.com', 'admin')).id;
    alice = await signIn('alice@example.com');
    bob = await signIn('bob@example.com');
  });

  const attempt = (email: string, password = PASSWORD) => api('/api/auth/sign-in/email', { body: { email, password } });
  const whoIs = async (cookie: string) => (await (await api('/api/auth/get-session', { cookie })).json())?.user ?? null;
  const audit = async () =>
    (await getPool().query(`select user_id, user_name, action, record_id, summary from app_audit where collection = 'security' order by id`)).rows;
  const sessionsOf = async (id: string) =>
    (await getPool().query<{ n: number }>('select count(*)::int as n from session where "userId" = $1', [id])).rows[0].n;

  /** Set up two-step sign-in the way the Settings screen does; returns the secret and backup codes. */
  async function enroll(cookie: string): Promise<{ secret: string; backupCodes: string[]; cookie: string }> {
    const started = await api('/api/auth/two-factor/enable', { cookie, body: { password: PASSWORD } });
    expect(started.status).toBe(200);
    const { totpURI, backupCodes } = await started.json();
    const secret = new URL(totpURI).searchParams.get('secret')!;
    const done = await api('/api/auth/two-factor/verify-totp', { cookie, body: { code: totp(secret) } });
    expect(done.status).toBe(200);
    // Finishing setup swaps the session for a new one.
    return { secret, backupCodes, cookie: join(cookiesOf(done)) };
  }

  /** The password step; returns the challenge cookie when a code is wanted. */
  async function passwordStep(email: string, password = PASSWORD) {
    const r = await attempt(email, password);
    return { status: r.status, body: await r.json(), challenge: join(cookiesOf(r)) };
  }

  describe('without it', () => {
    it('lets an admin sign in with the password, as before', async () => {
      const r = await attempt('alice@example.com');
      expect(r.status).toBe(200);
      expect(cookiesOf(r).some((c) => c.startsWith('better-auth.session_token='))).toBe(true);
      expect((await r.json()).twoFactorRedirect).toBeUndefined();
    });

    it('leaves ordinary users exactly as they were, and cannot be turned on for them', async () => {
      expect((await attempt('bob@example.com')).status).toBe(200);
      const r = await api('/api/auth/two-factor/enable', { cookie: bob, body: { password: PASSWORD } });
      expect(r.status).toBe(403);
      expect(await getPool().query('select 1 from "twoFactor"')).toMatchObject({ rowCount: 0 });
      expect((await whoIs(bob)).twoFactorEnabled).toBe(false);
    });
  });

  describe('setting it up', () => {
    it('needs the password', async () => {
      const r = await api('/api/auth/two-factor/enable', { cookie: alice, body: { password: 'not the password!' } });
      expect(r.status).toBe(400);
      expect(await getPool().query('select 1 from "twoFactor"')).toMatchObject({ rowCount: 0 });
    });

    it('only counts once a code from the app has been entered', async () => {
      const started = await api('/api/auth/two-factor/enable', { cookie: alice, body: { password: PASSWORD } });
      const { totpURI, backupCodes } = await started.json();
      expect(totpURI).toMatch(/^otpauth:\/\/totp\/AEROBOOK:alice%40example\.com\?secret=[A-Z2-7]+/);
      expect(backupCodes).toHaveLength(10);
      const secret = new URL(totpURI).searchParams.get('secret')!;

      // Not on yet: the password alone still signs in.
      expect((await whoIs(alice)).twoFactorEnabled).toBe(false);
      expect((await passwordStep('alice@example.com')).body.twoFactorRedirect).toBeUndefined();

      const bad = await api('/api/auth/two-factor/verify-totp', { cookie: alice, body: { code: wrong(totp(secret)) } });
      expect(bad.status).toBe(401);
      expect((await whoIs(alice)).twoFactorEnabled).toBe(false);

      const good = await api('/api/auth/two-factor/verify-totp', { cookie: alice, body: { code: totp(secret) } });
      expect(good.status).toBe(200);
      expect((await whoIs(join(cookiesOf(good)))).twoFactorEnabled).toBe(true);
      expect((await audit()).map((e) => e.action)).toEqual([
        'two-factor-setup-started', 'two-factor-setup-failed', 'two-factor-enabled',
      ]);
    });

    it('signs the admin out everywhere else, so a password-only session does not outlive it', async () => {
      const otherDevice = await signIn('alice@example.com');
      expect(await whoIs(otherDevice)).not.toBeNull();
      const { cookie } = await enroll(alice);
      expect(await whoIs(otherDevice)).toBeNull();
      expect(await whoIs(alice)).toBeNull();
      expect((await whoIs(cookie)).id).toBe(aliceId);
      expect(await sessionsOf(aliceId)).toBe(1);
      // Nobody else is signed out.
      expect(await whoIs(bob)).not.toBeNull();
    });

    it('cannot be started again over a working setup', async () => {
      const { cookie } = await enroll(alice);
      const again = await api('/api/auth/two-factor/enable', { cookie, body: { password: PASSWORD } });
      expect(again.status).toBe(400);
    });
  });

  describe('signing in with it', () => {
    let secret: string;
    let backupCodes: string[];
    beforeEach(async () => {
      ({ secret, backupCodes } = await enroll(alice));
    });

    it('gives nothing for the password alone', async () => {
      const step = await passwordStep('alice@example.com');
      expect(step.status).toBe(200);
      expect(step.body).toEqual({ twoFactorRedirect: true, twoFactorMethods: ['totp'] });
      expect(step.challenge).not.toContain('session_token');
      expect(await whoIs(step.challenge)).toBeNull();
      expect((await api('/api/sync?since=0', { cookie: step.challenge })).status).toBe(401);
      expect((await api('/api/team', { cookie: step.challenge })).status).toBe(401);
      expect((await api('/api/auth/admin/list-users', { cookie: step.challenge })).status).toBe(401);
    });

    it('signs in with the code from the app', async () => {
      const { challenge } = await passwordStep('alice@example.com');
      const r = await api('/api/auth/two-factor/verify-totp', { cookie: challenge, body: { code: totp(secret) } });
      expect(r.status).toBe(200);
      expect((await whoIs(join(cookiesOf(r)))).id).toBe(aliceId);
      expect((await audit()).at(-1)).toMatchObject({ action: 'two-factor-sign-in', user_id: aliceId, record_id: aliceId });
    });

    it('refuses a wrong code, and a missing one, and records the wrong one', async () => {
      const { challenge } = await passwordStep('alice@example.com');
      const bad = await api('/api/auth/two-factor/verify-totp', { cookie: challenge, body: { code: wrong(totp(secret)) } });
      expect(bad.status).toBe(401);
      expect(cookiesOf(bad).some((c) => c.includes('session_token'))).toBe(false);
      expect((await api('/api/auth/two-factor/verify-totp', { cookie: challenge, body: {} })).status).toBe(400);
      expect((await audit()).at(-1)).toMatchObject({ action: 'two-factor-sign-in-failed', record_id: aliceId });
      // A code without the password step first gets nowhere.
      await getPool().query('delete from "rateLimit"');
      expect((await api('/api/auth/two-factor/verify-totp', { body: { code: totp(secret) } })).status).toBe(401);
    });

    it('slows down guessing: a few tries in a few seconds, then wait', async () => {
      await getPool().query('delete from "rateLimit"');
      const { challenge } = await passwordStep('alice@example.com');
      const statuses: number[] = [];
      for (let i = 0; i < 4; i++) {
        statuses.push((await api('/api/auth/two-factor/verify-totp', { cookie: challenge, body: { code: wrong(totp(secret)) } })).status);
      }
      expect(statuses.at(-1)).toBe(429);
    });

    it('stops after five wrong codes for one sign-in', async () => {
      const { challenge } = await passwordStep('alice@example.com');
      for (let i = 0; i < 5; i++) {
        await api('/api/auth/two-factor/verify-totp', { cookie: challenge, body: { code: wrong(totp(secret)) } });
      }
      const late = await api('/api/auth/two-factor/verify-totp', { cookie: challenge, body: { code: totp(secret) } });
      expect(late.ok).toBe(false);
      expect(await sessionsOf(aliceId)).toBe(1); // only the one from setting it up
    });

    it('refuses "trust this device", so the code is asked for every time', async () => {
      const { challenge } = await passwordStep('alice@example.com');
      const r = await api('/api/auth/two-factor/verify-totp', { cookie: challenge, body: { code: totp(secret), trustDevice: true } });
      expect(r.status).toBe(400);
      expect(cookiesOf(r).some((c) => c.includes('trust_device') || c.includes('session_token'))).toBe(false);
    });

    it('takes a backup code once, and records it', async () => {
      const first = await passwordStep('alice@example.com');
      const r = await api('/api/auth/two-factor/verify-backup-code', { cookie: first.challenge, body: { code: backupCodes[0] } });
      expect(r.status).toBe(200);
      expect((await whoIs(join(cookiesOf(r)))).id).toBe(aliceId);
      expect((await audit()).at(-1)).toMatchObject({ action: 'two-factor-backup-code-used', record_id: aliceId });

      const second = await passwordStep('alice@example.com');
      const again = await api('/api/auth/two-factor/verify-backup-code', { cookie: second.challenge, body: { code: backupCodes[0] } });
      expect(again.status).toBe(401);
    });

    it('never shows the secret again', async () => {
      const { cookie } = await (async () => {
        const { challenge } = await passwordStep('alice@example.com');
        const r = await api('/api/auth/two-factor/verify-totp', { cookie: challenge, body: { code: totp(secret) } });
        return { cookie: join(cookiesOf(r)) };
      })();
      const r = await api('/api/auth/two-factor/get-totp-uri', { cookie, body: { password: PASSWORD } });
      expect(r.status).toBe(404);
      expect(await r.text()).not.toContain(secret);
    });

    it('answers a wrong password for such an admin as for anyone else, so it does not show who has it on', async () => {
      const forAdmin = await attempt('alice@example.com', 'not the password!');
      const forUser = await attempt('bob@example.com', 'not the password!');
      const forNobody = await attempt('nobody@example.com', 'not the password!');
      const bodies = await Promise.all([forAdmin, forUser, forNobody].map(async (r) => [r.status, await r.text()]));
      expect(bodies[0]).toEqual(bodies[1]);
      expect(bodies[0]).toEqual(bodies[2]);
    });

    it('keeps an admin whose access is off out, at either step, saying nothing more than for a wrong password', async () => {
      // Turned off before signing in: the right password is answered like a wrong one.
      await getPool().query('update "user" set banned = true where id = $1', [aliceId]);
      const right = await attempt('alice@example.com');
      const wrongOne = await attempt('alice@example.com', 'not the password!');
      expect([right.status, await right.text()]).toEqual([wrongOne.status, await wrongOne.text()]);

      // Turned off between the password and the code.
      await getPool().query('update "user" set banned = false where id = $1', [aliceId]);
      const { challenge } = await passwordStep('alice@example.com');
      await getPool().query('update "user" set banned = true where id = $1', [aliceId]);
      const before = await sessionsOf(aliceId);
      const late = await api('/api/auth/two-factor/verify-totp', { cookie: challenge, body: { code: totp(secret) } });
      expect(late.status).toBe(401);
      expect(await late.json()).toEqual({ message: 'Invalid code', code: 'INVALID_CODE' });
      expect(await sessionsOf(aliceId)).toBe(before);
    });
  });

  describe('turning it off, and new backup codes', () => {
    it('needs the password, and records both', async () => {
      const { cookie } = await enroll(alice);
      expect((await api('/api/auth/two-factor/generate-backup-codes', { cookie, body: { password: 'not the password!' } })).ok).toBe(false);
      const codes = await api('/api/auth/two-factor/generate-backup-codes', { cookie, body: { password: PASSWORD } });
      expect((await codes.json()).backupCodes).toHaveLength(10);
      expect((await api('/api/auth/two-factor/disable', { cookie, body: { password: 'not the password!' } })).ok).toBe(false);
      const off = await api('/api/auth/two-factor/disable', { cookie, body: { password: PASSWORD } });
      expect(off.status).toBe(200);
      expect((await passwordStep('alice@example.com')).body.twoFactorRedirect).toBeUndefined();
      expect((await audit()).map((e) => e.action).slice(-2)).toEqual(['two-factor-backup-codes-replaced', 'two-factor-disabled']);
    });
  });

  describe('an admin resetting it for someone who lost their phone', () => {
    let carol: string;
    beforeEach(async () => {
      carol = (await enroll(await signIn('carol@example.com'))).cookie;
    });
    const reset = (cookie: string, userId: string, headers?: Record<string, string>) =>
      api('/api/team/reset-two-factor', { cookie, body: { userId }, headers });

    it('turns it off, signs them out everywhere, and records who did it', async () => {
      const r = await reset(alice, carolId);
      expect(r.status).toBe(200);
      expect(await whoIs(carol)).toBeNull();
      expect(await sessionsOf(carolId)).toBe(0);
      expect(await getPool().query('select 1 from "twoFactor" where "userId" = $1', [carolId])).toMatchObject({ rowCount: 0 });
      // Carol signs in with her password and sets it up again.
      expect((await passwordStep('carol@example.com')).body.twoFactorRedirect).toBeUndefined();
      expect((await audit()).at(-1)).toMatchObject({
        action: 'two-factor-reset', user_id: aliceId, user_name: 'Alice', record_id: carolId,
      });
    });

    it('ends a sign-in that was waiting for its code', async () => {
      const { challenge } = await passwordStep('carol@example.com');
      await reset(alice, carolId);
      const r = await api('/api/auth/two-factor/verify-totp', { cookie: challenge, body: { code: '000000' } });
      expect(r.status).toBe(401);
      expect(await sessionsOf(carolId)).toBe(0);
    });

    it('is for admins only, not for yourself, and not from another site', async () => {
      expect((await reset(bob, carolId)).status).toBe(403);
      expect((await reset('', carolId)).status).toBe(401);
      expect((await reset(alice, aliceId)).status).toBe(400);
      expect((await reset(alice, 'no-such-user')).status).toBe(404);
      // Someone without it is not signed out or recorded as reset.
      expect((await reset(alice, bobId)).status).toBe(400);
      expect(await whoIs(bob)).not.toBeNull();
      expect((await reset(alice, carolId, { origin: 'https://evil.example' })).status).toBe(403);
      expect(await getPool().query('select 1 from "twoFactor" where "userId" = $1', [carolId])).toMatchObject({ rowCount: 1 });
      expect((await audit()).filter((e) => e.action === 'two-factor-reset')).toEqual([]);
    });
  });

  describe('what stays secret', () => {
    let logged: string;
    const spies: ReturnType<typeof vi.spyOn>[] = [];
    beforeEach(() => {
      logged = '';
      for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
        spies.push(vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { logged += `${args.map(String).join(' ')}\n`; }));
      }
    });
    afterEach(() => {
      spies.splice(0).forEach((s) => s.mockRestore());
    });

    it('keeps the secret and backup codes out of the database in the clear, the history, the team list and the logs', async () => {
      const { secret, backupCodes, cookie } = await enroll(alice);
      const { challenge } = await passwordStep('alice@example.com');
      await api('/api/auth/two-factor/verify-totp', { cookie: challenge, body: { code: wrong(totp(secret)) } });

      const stored = (await getPool().query('select secret, "backupCodes" from "twoFactor"')).rows[0];
      // The phone is given the secret in base32; underneath it is a plain string.
      const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
      const bits = [...secret.replace(/=+$/, '')].map((c) => alphabet.indexOf(c).toString(2).padStart(5, '0')).join('');
      const rawSecret = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2))).toString('utf8');
      expect(rawSecret).toHaveLength(32);
      expect(JSON.stringify(stored)).not.toContain(rawSecret);
      expect(JSON.stringify(stored)).not.toContain(secret);
      for (const code of backupCodes) expect(JSON.stringify(stored)).not.toContain(code);

      const everything = [
        JSON.stringify(await audit()),
        await (await api('/api/auth/get-session', { cookie })).text(),
        await (await api('/api/auth/admin/list-users', { cookie })).text(),
        await (await api('/api/history', { cookie })).text(),
        logged,
      ].join('\n');
      expect(everything).not.toContain(secret);
      for (const code of backupCodes) expect(everything).not.toContain(code);
    });
  });

  describe('everything else', () => {
    it('keeps security events out of the activity history everyone reads', async () => {
      await enroll(alice);
      expect((await audit()).length).toBeGreaterThan(0);
      const { entries } = await (await api('/api/history', { cookie: bob })).json();
      expect(entries).toEqual([]);
    });

    it('does not let one admin step into another admin\'s account, which would skip their code', async () => {
      await enroll(await signIn('carol@example.com'));
      const r = await api('/api/auth/admin/impersonate-user', { cookie: alice, body: { userId: carolId } });
      expect(r.status).toBe(403);
      expect(cookiesOf(r).some((c) => c.includes('session_token'))).toBe(false);
    });

    it('still keeps account management to admins', async () => {
      expect((await api('/api/auth/admin/list-users', { cookie: bob })).status).toBe(403);
      expect((await api('/api/auth/admin/set-role', { cookie: bob, body: { userId: bobId, role: 'admin' } })).status).toBe(403);
      expect((await api('/api/auth/two-factor/enable', { body: { password: PASSWORD } })).status).toBe(401);
    });

    it('turns away setup from another site', async () => {
      const r = await api('/api/auth/two-factor/enable', { cookie: alice, body: { password: PASSWORD }, headers: { origin: 'https://evil.example' } });
      expect(r.status).toBe(403);
      expect(await getPool().query('select 1 from "twoFactor"')).toMatchObject({ rowCount: 0 });
      expect(ORIGIN).not.toBe('https://evil.example');
    });
  });
});
