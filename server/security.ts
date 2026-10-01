/**
 * Two-step sign-in for admins, and the record of what happened to it.
 *
 * Better Auth's two-factor plugin does the work: an authenticator-app code
 * (TOTP) after the password, with single-use backup codes, its secret and
 * codes stored encrypted with BETTER_AUTH_SECRET. What AEROBOOK adds here:
 *
 * - only an admin may turn it on (someone who had it on as an admin keeps it
 *   if they stop being one: nothing loosens by itself);
 * - "trust this device" is refused, so a correct password is never enough on
 *   its own once it is on;
 * - turning it on signs the admin out everywhere else, so a session made with
 *   the password alone does not outlive it;
 * - another admin can reset it for someone who lost their phone, which also
 *   signs that person out everywhere;
 * - every step is written to app_audit under the collection "security" —
 *   never a code, a secret or a backup code — and kept out of the activity
 *   history everyone reads.
 */
import type { PoolClient } from 'pg';
import { APIError, createAuthMiddleware, getSessionFromCtx } from 'better-auth/api';
import { ensureAppSchema, getPool } from './db.js';

export const SECURITY = 'security';

export type SecurityAction =
  | 'two-factor-setup-started'
  | 'two-factor-enabled'
  | 'two-factor-setup-failed'
  | 'two-factor-disabled'
  | 'two-factor-backup-codes-replaced'
  | 'two-factor-sign-in'
  | 'two-factor-sign-in-failed'
  | 'two-factor-backup-code-used'
  | 'two-factor-reset'
  | 'user-deleted';

const SUMMARY: Record<SecurityAction, string> = {
  'two-factor-setup-started': 'Started setting up two-step sign-in',
  'two-factor-enabled': 'Turned on two-step sign-in',
  'two-factor-setup-failed': 'Entered a wrong code while setting up two-step sign-in',
  'two-factor-disabled': 'Turned off two-step sign-in',
  'two-factor-backup-codes-replaced': 'Replaced their backup codes',
  'two-factor-sign-in': 'Signed in with an authenticator code',
  'two-factor-sign-in-failed': 'Entered a wrong two-step sign-in code',
  'two-factor-backup-code-used': 'Signed in with a backup code',
  'two-factor-reset': 'Reset two-step sign-in',
  'user-deleted': 'Deleted the account',
};

export interface SecurityEvent {
  action: SecurityAction;
  /** Whose account it is. */
  userId: string;
  /** Who did it, when that is someone else (an admin resetting it). */
  actor?: { id: string; name: string };
  /** The account owner's name, when they are the one acting. */
  userName?: string;
}

export async function recordSecurityEvent(event: SecurityEvent, client?: PoolClient): Promise<void> {
  await ensureAppSchema();
  const actorId = event.actor?.id ?? event.userId;
  const actorName = event.actor?.name ?? event.userName ?? null;
  await (client ?? getPool()).query(
    `insert into app_audit (user_id, user_name, action, collection, record_id, summary)
     values ($1, $2, $3, $4, $5, $6)`,
    [actorId, actorName, event.action, SECURITY, event.userId, SUMMARY[event.action]],
  );
}

// ------------------------------------------------------------ the plugin hooks

const VERIFY = new Set(['/two-factor/verify-totp', '/two-factor/verify-backup-code']);

/** Who a two-step request is about: the signed-in person, or the one half-way through signing in. */
type Subject = { id: string; name: string; signedIn: boolean; twoFactorEnabled: boolean } | null;
const subjects = new WeakMap<object, Subject>();

type HookContext = Parameters<Parameters<typeof createAuthMiddleware>[0]>[0];

async function subjectOf(ctx: HookContext): Promise<Subject> {
  const session = await getSessionFromCtx(ctx).catch(() => null);
  if (session) {
    const u = session.user as { id: string; name: string; twoFactorEnabled?: boolean | null };
    return { id: u.id, name: u.name, signedIn: true, twoFactorEnabled: Boolean(u.twoFactorEnabled) };
  }
  const cookie = ctx.context.createAuthCookie('two_factor');
  const identifier = await ctx.getSignedCookie(cookie.name, ctx.context.secret).catch(() => null);
  if (!identifier) return null;
  const pending = await ctx.context.internalAdapter.findVerificationValue(identifier).catch(() => null);
  if (!pending) return null;
  const user = await ctx.context.internalAdapter.findUserById(pending.value).catch(() => null);
  return user ? { id: user.id, name: user.name, signedIn: false, twoFactorEnabled: true } : null;
}

export const twoFactorBefore = createAuthMiddleware(async (ctx) => {
  const path = ctx.path;
  if (!path.startsWith('/two-factor/')) return;

  // Not used by AEROBOOK: showing the secret again after setup is one more
  // way for it to leak, and a new setup gives a new one.
  if (path === '/two-factor/get-totp-uri') throw APIError.fromStatus('NOT_FOUND');

  if (path === '/two-factor/enable') {
    const session = await getSessionFromCtx(ctx).catch(() => null);
    // Signed out: the plugin answers that itself.
    const role = (session?.user as { role?: string | null } | undefined)?.role;
    if (session && role !== 'admin') {
      throw APIError.fromStatus('FORBIDDEN', { message: 'Two-step sign-in is for admin accounts.' });
    }
    if ((ctx.body as { method?: string } | undefined)?.method === 'otp') {
      throw APIError.fromStatus('BAD_REQUEST', { message: 'Use an authenticator app.' });
    }
  }

  if (VERIFY.has(path)) {
    // "Trust this device" would let a password alone in for a month.
    if ((ctx.body as { trustDevice?: unknown } | undefined)?.trustDevice) {
      throw APIError.fromStatus('BAD_REQUEST', { message: 'Every sign-in needs the code.' });
    }
    subjects.set(ctx.request ?? ctx, await subjectOf(ctx));
  }
});

/**
 * What the endpoint came back with: its answer, a refusal, or nothing at all
 * (a request so malformed it never reached the endpoint, which is neither).
 */
function outcome(returned: unknown): 'ok' | 'refused' | 'none' {
  if (returned === undefined || returned === null) return 'none';
  if (returned instanceof APIError || returned instanceof Error) return 'refused';
  if (returned instanceof Response) return returned.ok ? 'ok' : 'refused';
  return typeof returned === 'object' ? 'ok' : 'none';
}

export const twoFactorAfter = createAuthMiddleware(async (ctx) => {
  const path = ctx.path;
  if (!path.startsWith('/two-factor/')) return;
  const result = outcome(ctx.context.returned);
  if (result === 'none') return;
  const ok = result === 'ok';

  if (path === '/two-factor/enable' || path === '/two-factor/disable' || path === '/two-factor/generate-backup-codes') {
    if (!ok) return;
    const session = await getSessionFromCtx(ctx).catch(() => null);
    const user = session?.user ?? ctx.context.newSession?.user;
    if (!user) return;
    const action: SecurityAction = path === '/two-factor/enable' ? 'two-factor-setup-started'
      : path === '/two-factor/disable' ? 'two-factor-disabled'
      : 'two-factor-backup-codes-replaced';
    await recordSecurityEvent({ action, userId: user.id, userName: user.name });
    return;
  }

  if (!VERIFY.has(path)) return;
  const subject = subjects.get(ctx.request ?? ctx);
  if (!subject) return;
  const backup = path === '/two-factor/verify-backup-code';

  if (subject.signedIn) {
    // A code entered while signed in is finishing setup.
    if (backup) return;
    if (!ok) {
      await recordSecurityEvent({ action: 'two-factor-setup-failed', userId: subject.id, userName: subject.name });
      return;
    }
    if (subject.twoFactorEnabled) return;
    await recordSecurityEvent({ action: 'two-factor-enabled', userId: subject.id, userName: subject.name });
    // Sessions made with the password alone end here; the one that just
    // entered the code carries on.
    const keep = ctx.context.newSession?.session.token;
    await getPool().query('delete from session where "userId" = $1 and token <> $2', [subject.id, keep ?? '']);
    return;
  }

  await recordSecurityEvent({
    action: ok ? (backup ? 'two-factor-backup-code-used' : 'two-factor-sign-in') : 'two-factor-sign-in-failed',
    userId: subject.id,
    userName: subject.name,
  });
});

// ---------------------------------------------------------------- admin reset

export class ResetRefused extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/**
 * An admin turns two-step sign-in off for someone who has lost their phone
 * and their backup codes. They are signed out everywhere, and set it up again
 * when they next sign in. Not for yourself: that is "Turn off", which asks
 * for your password.
 */
export async function resetTwoFactor(admin: { id: string; name: string }, userId: string): Promise<void> {
  if (userId === admin.id) throw new ResetRefused(400, 'Use "Turn off" under your own account instead.');
  await ensureAppSchema();
  const client = await getPool().connect();
  try {
    await client.query('begin');
    const { rows } = await client.query<{ on: boolean; set_up: boolean }>(
      `select coalesce("twoFactorEnabled", false) as on,
              exists (select 1 from "twoFactor" t where t."userId" = u.id) as set_up
         from "user" u where id = $1 for update`,
      [userId],
    );
    if (!rows[0]) throw new ResetRefused(404, 'No such person');
    if (!rows[0].on && !rows[0].set_up) throw new ResetRefused(400, 'They do not have two-step sign-in on');
    await client.query('delete from "twoFactor" where "userId" = $1', [userId]);
    await client.query('update "user" set "twoFactorEnabled" = false, "updatedAt" = now() where id = $1', [userId]);
    await client.query('delete from session where "userId" = $1', [userId]);
    // A sign-in half-way through, waiting for its code, ends too.
    await client.query(`delete from verification where identifier like '2fa-%' and value = $1`, [userId]);
    await recordSecurityEvent({ action: 'two-factor-reset', userId, actor: admin }, client);
    await client.query('commit');
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
