/**
 * Deleting someone from the team, for good, while keeping what they did.
 *
 * Turning access off (Better Auth's ban) is the everyday, reversible way to
 * stop someone signing in. Deleting goes further and cannot be undone: the
 * account is emptied, but its "user" row stays as a shell, because every
 * message, comment, group and audit entry they made points at it. So:
 *
 *   gone   — password, sessions, two-step sign-in, email address (free to
 *            reuse), push subscriptions, presence, notifications, watched
 *            aircraft, read markers, personal settings, group memberships;
 *            follow-ups assigned to them become unassigned
 *   kept   — their messages, comments, timeline notes, documents, records
 *            and audit history, shown under "Name (deleted)"
 *
 * Only an admin may do it, never to themselves, and never to the last admin
 * with access. It is written to the admin audit log (collection "security").
 */
import type { SessionUser } from './auth.js';
import { ensureAppSchema, getPool } from './db.js';
import { HttpError } from './http.js';
import { recordSecurityEvent } from './security.js';
import { describe, WRITE_LOCK } from './sync.js';

/** The address a deleted account is left with: unique, and never deliverable. */
export function deletedEmail(userId: string): string {
  return `deleted-${userId.toLowerCase().replace(/[^a-z0-9]/g, '')}@deleted.invalid`;
}

export async function isDeleted(userId: string): Promise<boolean> {
  await ensureAppSchema();
  const { rows } = await getPool().query('select 1 from app_deleted_user where user_id = $1', [userId]);
  return rows.length > 0;
}

export async function deletedIds(): Promise<Set<string>> {
  await ensureAppSchema();
  const { rows } = await getPool().query<{ user_id: string }>('select user_id from app_deleted_user');
  return new Set(rows.map((r) => r.user_id));
}

export async function deleteUser(admin: SessionUser, body: unknown): Promise<{ ok: true }> {
  if (admin.role !== 'admin') throw new HttpError(403, 'Only an admin can delete someone');
  const userId = (body as { userId?: unknown })?.userId;
  if (typeof userId !== 'string' || !userId) throw new HttpError(400, 'Say who to delete');
  if (userId === admin.id) throw new HttpError(400, 'You cannot delete yourself. Another admin can.');
  await ensureAppSchema();

  const client = await getPool().connect();
  try {
    await client.query('begin');
    // The same lock as every save, so no save lands half-way through this.
    await client.query('select pg_advisory_xact_lock($1)', [WRITE_LOCK]);

    const { rows } = await client.query<{ name: string; role: string | null; deleted: boolean }>(
      `select u.name, u.role, exists (select 1 from app_deleted_user d where d.user_id = u.id) as deleted
         from "user" u where u.id = $1 for update`,
      [userId],
    );
    const target = rows[0];
    if (!target || target.deleted) throw new HttpError(404, 'No such person');

    if (target.role === 'admin') {
      const others = await client.query<{ n: number }>(
        `select count(*)::int as n from "user" u
          where u.role = 'admin' and u.id <> $1 and not coalesce(u.banned, false)
            and not exists (select 1 from app_deleted_user d where d.user_id = u.id)`,
        [userId],
      );
      if (others.rows[0].n === 0) throw new HttpError(409, 'They are the last admin with access. Make someone else an admin first.');
    }

    // The account: no way back in, and the address free for someone new.
    await client.query(
      `update "user" set name = $2, email = $3, role = 'user', image = null, banned = true,
              "banReason" = 'deleted', "banExpires" = null, "twoFactorEnabled" = false, "updatedAt" = now()
        where id = $1`,
      [userId, `${target.name} (deleted)`, deletedEmail(userId)],
    );
    await client.query('delete from session where "userId" = $1', [userId]);
    await client.query('delete from account where "userId" = $1', [userId]);
    await client.query('delete from "twoFactor" where "userId" = $1', [userId]);
    await client.query(`delete from verification where value = $1`, [userId]);

    // What was only theirs.
    await client.query('delete from app_push_subscription where user_id = $1', [userId]);
    await client.query('delete from app_presence where user_id = $1', [userId]);
    await client.query('delete from app_notification where user_id = $1', [userId]);
    await client.query('delete from app_aircraft_watch where user_id = $1', [userId]);
    await client.query('delete from app_aircraft_comment_read where user_id = $1', [userId]);
    // Out of every group; a direct conversation stays, readable by the other person.
    await client.query(
      `update app_conversation_member m set left_at = now()
         from app_conversation c
        where c.id = m.conversation_id and c.kind = 'group' and m.user_id = $1 and m.left_at is null`,
      [userId],
    );
    // Their personal settings record, removed the way a sync removes a record.
    await client.query(
      `update app_record set data = null, version = version + 1, seq = nextval('app_record_seq'),
              updated_at = now(), updated_by = $2
        where collection = 'settings' and id = $1 and data is not null`,
      [userId, admin.id],
    );

    // Follow-ups that were theirs go back to nobody — everyone's list — so
    // none is left with an owner who will never see it.
    const followUps = await client.query<{ id: string; data: Record<string, unknown> }>(
      `select id, data from app_record
        where collection = 'followUps' and data is not null and data->>'assigneeId' = $1`,
      [userId],
    );
    for (const f of followUps.rows) {
      await client.query(
        `update app_record set data = jsonb_set(data, '{assigneeId}', 'null'::jsonb), version = version + 1,
                seq = nextval('app_record_seq'), updated_at = now(), updated_by = $2
          where collection = 'followUps' and id = $1`,
        [f.id, admin.id],
      );
      await client.query(
        `insert into app_audit (user_id, user_name, action, collection, record_id, summary, before)
         values ($1, $2, 'update', 'followUps', $3, $4, $5)`,
        [admin.id, admin.name, f.id, describe(f.data), f.data],
      );
    }

    await client.query(
      'insert into app_deleted_user (user_id, name, deleted_by) values ($1, $2, $3)',
      [userId, target.name, admin.id],
    );
    await recordSecurityEvent({ action: 'user-deleted', userId, actor: { id: admin.id, name: admin.name } }, client);
    await client.query('commit');
    return { ok: true };
  } catch (e) {
    await client.query('rollback').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}
