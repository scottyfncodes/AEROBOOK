/**
 * The last way to name an admin: for whoever holds the database, when there
 * is no admin or developer left in AEROBOOK and no admin recovery code. See
 * docs/DISASTER_RECOVERY.md. Everything it does is written to the audit log.
 *
 *   DATABASE_URL=... npm run admin:recover -- list
 *   DATABASE_URL=... npm run admin:recover -- grant someone@example.com
 *   DATABASE_URL=... npm run admin:recover -- revoke someone@example.com
 *
 * It only moves people between "user" and "admin": it never makes or changes
 * a developer, never touches a password, a session or two-step sign-in, and
 * refuses accounts whose access is off or that were deleted. It prints names,
 * emails and roles, never anything secret.
 */
import { getPool, resetPool, ensureAppSchema } from '../server/db.js';
import { toRole } from '../src/lib/roles.js';

const [command, email] = process.argv.slice(2);
const pool = getPool();

async function list(): Promise<void> {
  const { rows } = await pool.query<{ name: string; email: string; role: string | null; banned: boolean | null; tf: boolean | null }>(
    `select name, email, role, banned, "twoFactorEnabled" as tf from "user" u
      where not exists (select 1 from app_deleted_user d where d.user_id = u.id) order by name`,
  );
  for (const r of rows) {
    console.log(`${toRole(r.role).padEnd(9)} ${r.banned ? 'no access ' : 'access    '} ${r.tf ? '2-step on ' : '2-step off'}  ${r.name} <${r.email}>`);
  }
}

async function change(admin: boolean): Promise<void> {
  if (!email) throw new Error('Say whose role to change: an email address.');
  const client = await pool.connect();
  try {
    await client.query('begin');
    const { rows } = await client.query<{ id: string; name: string; role: string | null; banned: boolean | null; deleted: boolean }>(
      `select id, name, role, banned, exists (select 1 from app_deleted_user d where d.user_id = u.id) as deleted
         from "user" u where lower(email) = lower($1) for update`,
      [email.trim()],
    );
    const target = rows[0];
    if (!target || target.deleted) throw new Error(`Nobody on AEROBOOK has the email ${email}.`);
    const was = toRole(target.role);
    if (was === 'developer') throw new Error('That is a developer. This script never changes a developer.');
    if (target.banned) throw new Error('Their access is off. Turn it back on first (or choose someone else).');
    const role = admin ? 'admin' : 'user';
    if (was === role) throw new Error(`They are already ${admin ? 'an admin' : 'a user'}.`);
    await client.query('update "user" set role = $2, "updatedAt" = now() where id = $1', [target.id, role]);
    await client.query(
      `insert into app_audit (user_id, user_name, action, collection, record_id, summary, before)
       values (null, 'Database (admin-recover script)', $1, 'security', $2, $3, $4)`,
      [admin ? 'admin-granted' : 'admin-revoked', target.id, `Role changed from ${was} to ${role}`, { role: was }],
    );
    await client.query('commit');
    console.log(`${target.name} is now ${admin ? 'an admin' : 'a user'}. Recorded in the audit log.`);
  } catch (e) {
    await client.query('rollback').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

try {
  await ensureAppSchema();
  if (command === 'list') await list();
  else if (command === 'grant') await change(true);
  else if (command === 'revoke') await change(false);
  else {
    console.log('Usage: npm run admin:recover -- list | grant <email> | revoke <email>');
    process.exitCode = 2;
  }
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
} finally {
  await resetPool();
}
