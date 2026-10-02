/**
 * Who may make someone an admin, so that AEROBOOK never depends on one person.
 *
 * Developers still give and take every role through Better Auth's admin
 * routes (see refuseOutranked in app.ts). On top of that, two ways for the
 * business itself to name a new admin when no developer is there:
 *
 *   1. An admin designates another admin, or takes the admin role away
 *      (POST /api/team/admin-role).
 *   2. Someone on the team redeems the admin recovery code, a one-time
 *      credential an admin made in advance and the business keeps offline
 *      (POST /api/team/recovery-code/redeem). It is for when there is no
 *      admin left to do 1.
 *
 * Neither is a back door. Both need someone signed in with their own account,
 * with two-step sign-in on, who enters their password and a current code from
 * their authenticator app for this one action — so a session left open on a
 * desk, or one an admin is impersonating, cannot do it. Neither can ever give
 * the developer role or touch a developer's account. The recovery code is
 * stored only as a hash, works once, and making a new one cancels the old.
 * Every grant, removal, failed attempt and recovery code change is written to
 * app_audit under the collection "security", never with a password, a code or
 * the recovery code itself.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { PoolClient } from 'pg';
import { symmetricDecrypt, verifyPassword } from 'better-auth/crypto';
import { createOTP } from '@better-auth/utils/otp';
import { getAuth, type SessionUser } from './auth.js';
import { ensureAppSchema, getPool } from './db.js';
import { HttpError } from './http.js';
import { recordSecurityEvent } from './security.js';
import { WRITE_LOCK } from './sync.js';
import { isAdmin, toRole, type Role } from '../src/lib/roles.js';

/** Wrong passwords or codes before confirming is refused for a while, per person. */
export const STEP_UP_MAX_FAILURES = 5;
export const STEP_UP_WINDOW = '15 minutes';
/** Wrong recovery codes from everyone together before redeeming is refused for a while. */
export const RECOVERY_MAX_FAILURES = 20;
export const RECOVERY_WINDOW = '1 hour';

const WRONG = 'That password or code is not right.';

/** The signed-in person, with what this action needs to know about their session. */
export interface Actor extends SessionUser {
  impersonated: boolean;
}

export async function actorOf(request: Request): Promise<Actor | null> {
  const found = await getAuth().api.getSession({ headers: request.headers });
  if (!found) return null;
  const u = found.user as { id: string; name: string; email: string; role?: string | null; banned?: boolean | null };
  if (u.banned) return null;
  const impersonatedBy = (found.session as { impersonatedBy?: string | null }).impersonatedBy;
  return { id: u.id, name: u.name, email: u.email, role: toRole(u.role), impersonated: Boolean(impersonatedBy) };
}

export interface StepUp {
  password?: unknown;
  code?: unknown;
}

/**
 * Proves it is really the account's owner, now: their password and a current
 * code from their authenticator app. A failure is recorded (outside any
 * transaction, so it stays) and counts towards a short lock.
 */
export async function confirmIdentity(actor: Actor, proof: StepUp): Promise<void> {
  if (actor.impersonated) throw new HttpError(403, 'Not while signed in as someone else.');
  await ensureAppSchema();
  const pool = getPool();
  const { rows: recent } = await pool.query<{ n: number }>(
    `select count(*)::int as n from app_audit
      where collection = 'security' and user_id = $1 and action in ('step-up-failed', 'admin-recovery-failed')
        and at > now() - $2::interval`,
    [actor.id, STEP_UP_WINDOW],
  );
  if (recent[0].n >= STEP_UP_MAX_FAILURES) throw new HttpError(429, 'Too many wrong attempts. Wait 15 minutes and try again.');

  const { rows } = await pool.query<{ enabled: boolean | null; secret: string | null; verified: boolean | null; hash: string | null }>(
    `select u."twoFactorEnabled" as enabled, t.secret, t.verified, a.password as hash
       from "user" u
       left join "twoFactor" t on t."userId" = u.id
       left join account a on a."userId" = u.id and a."providerId" = 'credential'
      where u.id = $1`,
    [actor.id],
  );
  const row = rows[0];
  if (!row?.enabled || !row.secret || row.verified === false) {
    throw new HttpError(403, 'Turn on two-step sign-in under Settings → Account first.');
  }
  const password = typeof proof.password === 'string' ? proof.password : '';
  const code = typeof proof.code === 'string' ? proof.code.replace(/\s/g, '') : '';
  let ok = false;
  if (password && /^\d{6}$/.test(code) && row.hash) {
    const passwordOk = await verifyPassword({ hash: row.hash, password }).catch(() => false);
    const { secretConfig } = await getAuth().$context;
    const secret = await symmetricDecrypt({ key: secretConfig, data: row.secret }).catch(() => '');
    // Checked whether or not the password was right, so the two take as long either way.
    const codeOk = secret ? await createOTP(secret, { digits: 6, period: 30 }).verify(code) : false;
    ok = passwordOk && codeOk;
  }
  if (!ok) {
    await recordSecurityEvent({ action: 'step-up-failed', userId: actor.id, userName: actor.name });
    throw new HttpError(403, WRONG);
  }
}

// ------------------------------------------------- deciding under the lock

/**
 * A person who may manage accounts right now: the admin or developer role
 * (Better Auth may keep several, comma-separated), access on, not deleted.
 */
const ACTIVE_ADMIN = `string_to_array(replace(coalesce(u.role, ''), ' ', ''), ',') && array['admin', 'developer']
  and not coalesce(u.banned, false)
  and not exists (select 1 from app_deleted_user d where d.user_id = u.id)`;

/**
 * Starts the final decision. Every change here takes the same lock as every
 * save and as deleting someone (deleteUser), so two of them never interleave,
 * and then reads the actor again: the check made when the request arrived,
 * before the slow password check, is not the one that counts. Someone whose
 * role, access or account changed in the meantime is refused.
 */
async function lockAndRecheck(client: PoolClient, actor: Actor, want: 'admin' | 'not-admin'): Promise<{ role: Role }> {
  await client.query('select pg_advisory_xact_lock($1)', [WRITE_LOCK]);
  const { rows } = await client.query<{ role: string | null; active: boolean }>(
    `select u.role, not coalesce(u.banned, false) and not exists (select 1 from app_deleted_user d where d.user_id = u.id) as active
       from "user" u where u.id = $1 for update`,
    [actor.id],
  );
  const me = rows[0];
  if (!me || !me.active) throw new HttpError(401, 'Sign in first');
  const role = toRole(me.role);
  if (want === 'admin' && !isAdmin({ role })) throw new HttpError(403, 'Only an admin can do that');
  if (want === 'not-admin' && isAdmin({ role })) throw new HttpError(409, 'You are already an admin');
  return { role };
}

type Queryable = Pick<PoolClient, 'query'>;

/**
 * A recovery code stops working the moment whoever made it is no longer an
 * active admin or developer — their role taken away, their access turned
 * off, or their account deleted — so a removed admin can never use a code
 * they made (or passed on) to undo their removal. Called by every path that
 * can do that; redeemRecoveryCode checks it again before using a code.
 * Deleted, not set aside: restoring the person later does not revive it.
 * Returns whether a code was cancelled; the cancellation is in the audit log.
 */
export async function cancelCodeOfFormerAdmin(db: Queryable, by: { id: string; name: string } | null): Promise<boolean> {
  const { rows } = await db.query<{ created_by: string | null }>(
    `delete from app_admin_recovery r
      where r.id = 1 and not exists (select 1 from "user" u where u.id = r.created_by and ${ACTIVE_ADMIN})
      returning r.created_by`,
  );
  if (!rows[0]) return false;
  await db.query(
    `insert into app_audit (user_id, user_name, action, collection, record_id, summary)
     values ($1, $2, 'admin-recovery-code-revoked', 'security', $3, $4)`,
    [by?.id ?? null, by?.name ?? 'AEROBOOK', rows[0].created_by ?? '',
      'Cancelled the admin recovery code: whoever made it is no longer an admin'],
  );
  return true;
}

// ----------------------------------------------------------- admin designation

/**
 * An admin makes someone an admin, or takes it away. Only between "user" and
 * "admin": the developer role is never given here, and a developer is never
 * changed here. Never yourself. The person made an admin must already sign in
 * with two-step sign-in, so no admin account rests on a password alone.
 */
export async function setAdminRole(actor: Actor, body: unknown): Promise<{ role: Role }> {
  if (!isAdmin(actor)) throw new HttpError(403, 'Only an admin can do that');
  const { userId, admin, password, code } = (body ?? {}) as { userId?: unknown; admin?: unknown } & StepUp;
  if (typeof userId !== 'string' || !userId) throw new HttpError(400, 'Say whose role to change');
  if (typeof admin !== 'boolean') throw new HttpError(400, 'Say whether they should be an admin');
  if (userId === actor.id) throw new HttpError(400, 'Another admin has to change your own role.');
  await confirmIdentity(actor, { password, code });

  const client = await getPool().connect();
  try {
    await client.query('begin');
    await lockAndRecheck(client, actor, 'admin');
    const { rows } = await client.query<{ role: string | null; banned: boolean | null; two_factor: boolean | null; deleted: boolean }>(
      `select u.role, u.banned, u."twoFactorEnabled" as two_factor,
              exists (select 1 from app_deleted_user d where d.user_id = u.id) as deleted
         from "user" u where u.id = $1 for update`,
      [userId],
    );
    const target = rows[0];
    if (!target || target.deleted) throw new HttpError(404, 'No such person');
    const was = toRole(target.role);
    if (was === 'developer') throw new HttpError(403, 'Only a developer can manage a developer’s account');

    if (admin) {
      if (was === 'admin') throw new HttpError(409, 'They are already an admin');
      if (target.banned) throw new HttpError(409, 'Give them their access back first');
      if (!target.two_factor) throw new HttpError(409, 'They need to turn on two-step sign-in first, under Settings → Account.');
    } else {
      if (was !== 'admin') throw new HttpError(409, 'They are not an admin');
      // Never the last one: someone else who can manage accounts must remain.
      const others = await client.query<{ n: number }>(
        `select count(*)::int as n from "user" u where u.id <> $1 and ${ACTIVE_ADMIN}`,
        [userId],
      );
      if (others.rows[0].n === 0) throw new HttpError(409, 'They are the last admin with access. Make someone else an admin first.');
    }

    const role: Role = admin ? 'admin' : 'user';
    await client.query('update "user" set role = $2, "updatedAt" = now() where id = $1', [userId, role]);
    await recordSecurityEvent({
      action: admin ? 'admin-granted' : 'admin-revoked',
      userId,
      actor,
      summary: `Role changed from ${was} to ${role}`,
      before: { role: was },
    }, client);
    if (!admin) await cancelCodeOfFormerAdmin(client, actor);
    await client.query('commit');
    return { role };
  } catch (e) {
    await client.query('rollback').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

// ------------------------------------------------------------- recovery code

/** 160 random bits, in groups of four letters and digits: AB2C-D3EF-… */
function newCode(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const bytes = randomBytes(20);
  let bits = '';
  for (const b of bytes) bits += b.toString(2).padStart(8, '0');
  const chars = bits.match(/.{5}/g)!.map((b) => alphabet[parseInt(b, 2)]).join('');
  return chars.match(/.{4}/g)!.join('-');
}

/**
 * How a recovery code is stored and compared. It is 160 random bits, so a
 * plain SHA-256 is enough: there is nothing to guess, and a slow hash would
 * add nothing. Spaces, dashes and case are forgiven when typing it.
 */
export function hashRecoveryCode(code: string): string {
  return createHash('sha256').update(code.toUpperCase().replace(/[^A-Z2-7]/g, '')).digest('hex');
}

export interface RecoveryStatus {
  exists: boolean;
  createdAt?: string;
  createdBy?: string;
}

export async function recoveryStatus(actor: Actor): Promise<RecoveryStatus> {
  if (!isAdmin(actor)) throw new HttpError(403, 'Only an admin can do that');
  await ensureAppSchema();
  const { rows } = await getPool().query<{ created_at: Date; created_by_name: string | null }>(
    'select created_at, created_by_name from app_admin_recovery where id = 1',
  );
  if (!rows[0]) return { exists: false };
  return { exists: true, createdAt: rows[0].created_at.toISOString(), createdBy: rows[0].created_by_name ?? undefined };
}

/**
 * A new recovery code, shown this once. It replaces any earlier one, which
 * stops working at the same moment.
 */
export async function createRecoveryCode(actor: Actor, body: unknown): Promise<{ recoveryCode: string }> {
  if (!isAdmin(actor)) throw new HttpError(403, 'Only an admin can do that');
  await confirmIdentity(actor, (body ?? {}) as StepUp);
  const recoveryCode = newCode();
  const client = await getPool().connect();
  try {
    await client.query('begin');
    await lockAndRecheck(client, actor, 'admin');
    await client.query(
      `insert into app_admin_recovery (id, code_hash, created_at, created_by, created_by_name)
       values (1, $1, now(), $2, $3)
       on conflict (id) do update set code_hash = excluded.code_hash, created_at = now(),
         created_by = excluded.created_by, created_by_name = excluded.created_by_name`,
      [hashRecoveryCode(recoveryCode), actor.id, actor.name],
    );
    await recordSecurityEvent({ action: 'admin-recovery-code-created', userId: actor.id, userName: actor.name }, client);
    await client.query('commit');
  } catch (e) {
    await client.query('rollback').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
  return { recoveryCode };
}

export async function revokeRecoveryCode(actor: Actor, body: unknown): Promise<{ ok: true }> {
  if (!isAdmin(actor)) throw new HttpError(403, 'Only an admin can do that');
  await confirmIdentity(actor, (body ?? {}) as StepUp);
  const client = await getPool().connect();
  try {
    await client.query('begin');
    await lockAndRecheck(client, actor, 'admin');
    const { rowCount } = await client.query('delete from app_admin_recovery where id = 1');
    if (!rowCount) throw new HttpError(404, 'There is no recovery code to cancel');
    await recordSecurityEvent({ action: 'admin-recovery-code-revoked', userId: actor.id, userName: actor.name }, client);
    await client.query('commit');
  } catch (e) {
    await client.query('rollback').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
  return { ok: true };
}

/**
 * Someone on the team becomes an admin with the recovery code. They must
 * already have an account with access, and two-step sign-in on, and confirm
 * it is them. The code is used up in the same transaction that makes them
 * an admin, so it can never be used twice. Never by whoever made it, and
 * never once its maker is no longer an admin (see cancelCodeOfFormerAdmin):
 * the code is for when admins are missing, not for undoing a removal.
 */
export async function redeemRecoveryCode(actor: Actor, body: unknown): Promise<{ role: Role }> {
  const { recoveryCode, password, code } = (body ?? {}) as { recoveryCode?: unknown } & StepUp;
  if (isAdmin(actor)) throw new HttpError(409, 'You are already an admin');
  if (typeof recoveryCode !== 'string' || !recoveryCode.trim()) throw new HttpError(400, 'Enter the recovery code');
  await ensureAppSchema();
  const { rows: recent } = await getPool().query<{ n: number }>(
    `select count(*)::int as n from app_audit
      where collection = 'security' and action = 'admin-recovery-failed' and at > now() - $1::interval`,
    [RECOVERY_WINDOW],
  );
  if (recent[0].n >= RECOVERY_MAX_FAILURES) throw new HttpError(429, 'Too many wrong recovery codes. Try again in an hour.');
  await confirmIdentity(actor, { password, code });

  const given = Buffer.from(hashRecoveryCode(recoveryCode), 'hex');
  const wrong = new HttpError(403, 'That recovery code is not right, or it has been used or replaced.');
  const client = await getPool().connect();
  /** A refusal that is recorded: what the transaction did so far (a cancelled code) is kept. */
  let refusal: { error: HttpError; summary?: string } | null = null;
  try {
    await client.query('begin');
    await lockAndRecheck(client, actor, 'not-admin');
    const { rows } = await client.query<{ code_hash: string; created_by: string | null }>(
      'select code_hash, created_by from app_admin_recovery where id = 1 for update',
    );
    const stored = rows[0] ? Buffer.from(rows[0].code_hash, 'hex') : null;
    if (!stored || stored.length !== given.length || !timingSafeEqual(stored, given)) {
      refusal = { error: wrong };
    } else if (rows[0].created_by === actor.id) {
      // Whoever made the code was an admin then and is not now: someone removed them.
      await cancelCodeOfFormerAdmin(client, actor);
      refusal = {
        error: new HttpError(403, 'You cannot use an admin recovery code you made yourself. Another admin has to restore your role.'),
        summary: 'Tried to use the admin recovery code they made themselves; refused',
      };
    } else if (await cancelCodeOfFormerAdmin(client, actor)) {
      refusal = { error: wrong, summary: 'Tried an admin recovery code whose maker is no longer an admin; refused' };
    }
    if (refusal) {
      await recordSecurityEvent({ action: 'admin-recovery-failed', userId: actor.id, userName: actor.name, summary: refusal.summary }, client);
      await client.query('commit');
      throw refusal.error;
    }
    await client.query('delete from app_admin_recovery where id = 1');
    const { rows: me } = await client.query<{ role: string | null }>('select role from "user" where id = $1', [actor.id]);
    const was = toRole(me[0]?.role);
    await client.query('update "user" set role = $2, "updatedAt" = now() where id = $1', [actor.id, 'admin']);
    await recordSecurityEvent({
      action: 'admin-recovered',
      userId: actor.id,
      userName: actor.name,
      summary: `Became an admin with the admin recovery code (was ${was}); the code is used up`,
      before: { role: was },
    }, client);
    await client.query('commit');
    return { role: 'admin' };
  } catch (e) {
    if (!refusal) await client.query('rollback').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

// -------------------------------------------- role changes through Better Auth

/** The Better Auth admin routes that can change someone's role, or remove someone who had one. */
const ROLE_ROUTES = new Set(['set-role', 'update-user', 'create-user', 'remove-user']);
/** The Better Auth admin routes that can end someone's being an active admin. */
const ENDS_ADMIN = new Set(['set-role', 'update-user', 'remove-user', 'ban-user']);

/**
 * Runs one of Better Auth's admin routes and, when it changed anyone's role,
 * writes that to the audit log: who, whose, from what to what. Developers
 * give roles this way, so without this their changes would leave no record.
 * After any route that can end someone's being an admin (a role change,
 * turning access off, removal), a recovery code its maker can no longer
 * stand behind is cancelled.
 */
export async function auditRoleChanges(request: Request, pathname: string, run: () => Promise<Response>): Promise<Response> {
  const action = pathname.slice('/api/auth/admin/'.length);
  if (request.method !== 'POST' || !pathname.startsWith('/api/auth/admin/')) return run();
  if (!ROLE_ROUTES.has(action)) {
    const response = await run();
    if (response.ok && ENDS_ADMIN.has(action)) await cancelCodeOfFormerAdmin(getPool(), await actorOf(request).catch(() => null));
    return response;
  }
  const body = (await request.clone().json().catch(() => null)) as { userId?: unknown } | null;
  const targetId = typeof body?.userId === 'string' ? body.userId : null;
  const roleOf = async (id: string) => {
    const { rows } = await getPool().query<{ role: string | null }>('select role from "user" where id = $1', [id]);
    return rows[0] ? toRole(rows[0].role) : null;
  };
  const before = targetId ? await roleOf(targetId) : null;
  const response = await run();
  if (!response.ok) return response;
  const actor = await actorOf(request).catch(() => null);
  if (ENDS_ADMIN.has(action)) await cancelCodeOfFormerAdmin(getPool(), actor);
  if (!actor) return response;

  if (action === 'create-user') {
    const created = (await response.clone().json().catch(() => null)) as { user?: { id?: string; role?: string | null } } | null;
    const id = created?.user?.id;
    const role = toRole(created?.user?.role);
    if (id && role !== 'user') {
      await recordSecurityEvent({ action: 'role-changed', userId: id, actor, summary: `Added as ${role}` });
    }
    return response;
  }
  if (!targetId || !before) return response;
  if (action === 'remove-user') {
    if (before !== 'user') {
      await recordSecurityEvent({ action: 'role-changed', userId: targetId, actor, summary: `Removed, with the ${before} role`, before: { role: before } });
    }
    return response;
  }
  const after = await roleOf(targetId);
  if (after && after !== before) {
    await recordSecurityEvent({
      action: 'role-changed', userId: targetId, actor, summary: `Role changed from ${before} to ${after}`, before: { role: before },
    });
  }
  return response;
}
