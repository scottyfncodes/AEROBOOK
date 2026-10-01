/**
 * Every /api request lands here: one function, so there is one cold start and
 * one place that decides who may do what.
 */
import { timingSafeEqual } from 'node:crypto';
import { getAuth, migrate, sessionUser, type SessionUser } from './auth.js';
import { ensureAppSchema, getPool } from './db.js';
import { resetTwoFactor, ResetRefused } from './security.js';
import { BadRequest, history, isEmpty, pull, push, validateChanges } from './sync.js';
import {
  blobUploadToken, isFilePath, MAX_FILE_BYTES, purgeTrash, putLocal, readStored, storageMode, uploadFlavor,
} from './files.js';
import { servedType } from '../src/lib/documents.js';
import { checkWrite, error, HttpError, json, readJson } from './http.js';
import { isMessagingPath, messaging } from './messaging.js';
import { pruneNotifications } from './notify.js';
import { deletedIds, deleteUser, isDeleted, setProfileColor } from './people.js';
import { companyAuditPage, startCompanyExport } from './export.js';
import { isAdmin, isDeveloper, PRIVILEGED_ROLES, toRole, type Role } from '../src/lib/roles.js';
import { buildDigests, EmailError, emailEnabled, isEmptyDigest, renderDigest, runDigest, sendEmail } from './digest.js';
import { emailConfig, sendCustomerEmail } from './customer-email.js';

/**
 * How many accounts exist. On a brand-new database the tables are not there
 * yet: the first visit creates them, so a fresh deployment needs nothing run
 * by hand.
 */
async function userCount(): Promise<number> {
  const count = async () => {
    const { rows } = await getPool().query<{ n: string }>('select count(*) as n from "user"');
    return Number(rows[0].n);
  };
  try {
    return await count();
  } catch (error) {
    if ((error as { code?: string }).code !== '42P01') throw error; // undefined_table
    await migrate();
    return count();
  }
}

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * The first account, a developer: the one who can then make admins. Only
 * possible while nobody has an account, and only with the SETUP_TOKEN set on
 * the deployment — so finding the URL first is not enough to claim it.
 */
async function setup(request: Request): Promise<Response> {
  if (request.method === 'GET') return json({ needsSetup: (await userCount()) === 0 });
  const refused = checkWrite(request);
  if (refused) return refused;
  const expected = process.env.SETUP_TOKEN;
  if (!expected) return error(404, 'Setup is not enabled on this deployment');
  if ((await userCount()) > 0) return error(409, 'Setup has already been done');
  const body = (await readJson(request)) as { token?: string; name?: string; email?: string; password?: string };
  if (!body.token || !sameSecret(body.token, expected)) return error(403, 'Setup token is not right');
  if (!body.name?.trim() || !body.email?.trim() || !body.password) return error(400, 'Name, email and password are required');
  if (body.password.length < 10) return error(400, 'Use at least 10 characters for the password');
  await getAuth().api.createUser({
    body: { name: body.name.trim(), email: body.email.trim().toLowerCase(), password: body.password, role: 'developer' },
  });
  return json({ ok: true });
}

/**
 * Everyone on the account, by name, for choosing who a follow-up is for.
 * Any signed-in person may see who their teammates are; managing them stays
 * admin-only (Better Auth's admin endpoints). People whose access is off are
 * included, marked, so their name still shows on work they were given.
 */
async function team(): Promise<Response> {
  await ensureAppSchema();
  const [{ rows }, deleted] = await Promise.all([
    getPool().query<{ id: string; name: string; banned: boolean | null; color: string | null }>(
      `select u.id, u.name, u.banned, c.color from "user" u
         left join app_profile_color c on c.user_id = u.id
        order by u.name`,
    ),
    deletedIds(),
  ]);
  return json({
    people: rows.map((r) => ({
      id: r.id,
      name: r.name,
      active: !r.banned,
      ...(r.color ? { color: r.color } : {}),
      ...(deleted.has(r.id) ? { deleted: true } : {}),
    })),
  });
}

/** Someone picks the color shown beside their name, or gives it up. */
async function profileColorRoute(request: Request): Promise<Response> {
  if (request.method !== 'POST') return error(405, 'Method not allowed');
  const refused = checkWrite(request);
  if (refused) return refused;
  const user = await sessionUser(request);
  if (!user) return error(401, 'Sign in first');
  return json(await setProfileColor(user, await readJson(request)));
}

/** An admin deletes someone for good, keeping their name on what they did. See people.ts. */
async function deleteUserRoute(request: Request): Promise<Response> {
  if (request.method !== 'POST') return error(405, 'Method not allowed');
  const refused = checkWrite(request);
  if (refused) return refused;
  const user = await sessionUser(request);
  if (!user) return error(401, 'Sign in first');
  if (!isAdmin(user)) return error(403, 'Only an admin can do that');
  return json(await deleteUser(user, await readJson(request)));
}

/**
 * Better Auth's admin routes would happily give a deleted account its access,
 * a password or a role back. A deleted account stays deleted.
 */
async function refuseDeletedTarget(request: Request, pathname: string): Promise<Response | null> {
  if (request.method !== 'POST' || !pathname.startsWith('/api/auth/admin/')) return null;
  const body = (await request.clone().json().catch(() => null)) as { userId?: unknown } | null;
  if (typeof body?.userId !== 'string' || !body.userId) return null;
  return (await isDeleted(body.userId)) ? error(409, 'That person was deleted') : null;
}

/** The roles a request asks for, however Better Auth would read them. */
function requestedRoles(value: unknown): string[] {
  const list = Array.isArray(value) ? value : value === undefined ? [] : [value];
  return list.flatMap((r) => (typeof r === 'string' ? r.split(',').map((x) => x.trim()) : [String(r)]));
}

/**
 * Admins manage accounts; only a developer decides who is an admin or a
 * developer. Better Auth lets anyone with its admin permissions set any role,
 * so before its admin routes run, someone who is not a developer is refused:
 *   - giving anyone the admin or developer role (set-role, create-user,
 *     update-user)
 *   - changing the role of someone who is an admin or a developer
 *   - anything at all done to a developer's account (password, sessions,
 *     access, impersonation, editing, removal)
 * Reading (list-users, get-user) is unaffected.
 */
async function refuseOutranked(request: Request, pathname: string): Promise<Response | null> {
  if (request.method !== 'POST' || !pathname.startsWith('/api/auth/admin/')) return null;
  const caller = await sessionUser(request);
  // Better Auth turns away anyone without a session or its admin permissions.
  if (!caller || !isAdmin(caller) || isDeveloper(caller)) return null;
  const body = (await request.clone().json().catch(() => undefined)) as
    | { userId?: unknown; role?: unknown; data?: { role?: unknown } | null } | undefined;
  if (!body || typeof body !== 'object') return error(400, 'Send the request as JSON');

  const action = pathname.slice('/api/auth/admin/'.length);
  const roleField = action === 'set-role' || action === 'create-user' ? body.role : undefined;
  const asked = [...requestedRoles(roleField), ...requestedRoles(body.data?.role)];
  const changesRole = asked.length > 0;
  if (asked.some((r) => (PRIVILEGED_ROLES as readonly string[]).includes(r))) {
    return error(403, 'Only a developer can make someone an admin or a developer');
  }

  if (typeof body.userId !== 'string' || !body.userId) return null;
  const { rows } = await getPool().query<{ role: string | null }>('select role from "user" where id = $1', [body.userId]);
  if (!rows[0]) return null;
  const target: Role = toRole(rows[0].role);
  if (target === 'developer') return error(403, 'Only a developer can manage a developer’s account');
  if (changesRole && target === 'admin') return error(403, 'Only a developer can change an admin’s role');
  return null;
}

/**
 * Documents. Every route needs a session; reading one also needs a document
 * record that points at it, so only files the app itself stored can be read.
 */
async function files(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const mode = storageMode();

  if (url.pathname === '/api/files/config') {
    return json({ mode, maxBytes: MAX_FILE_BYTES, ...(mode === 'blob' ? { upload: uploadFlavor() } : {}) });
  }

  if (url.pathname === '/api/files/upload') {
    if (request.method !== 'POST') return error(405, 'Method not allowed');
    if (mode !== 'blob') return error(404, 'Uploads go through /api/files/local here');
    const refused = checkWrite(request);
    if (refused) return refused;
    try {
      return json(await blobUploadToken(request, (await readJson(request)) as never));
    } catch (e) {
      return error(400, (e as Error).message);
    }
  }

  if (url.pathname === '/api/files/local') {
    if (request.method !== 'PUT') return error(405, 'Method not allowed');
    if (mode !== 'local') return error(404, 'Not available');
    const origin = request.headers.get('origin');
    if (origin && origin !== url.origin) return error(403, 'Cross-origin request refused');
    const path = url.searchParams.get('path') ?? '';
    if (!isFilePath(path)) return error(400, 'Bad document path');
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.length > MAX_FILE_BYTES) return error(413, 'Document too large');
    await putLocal(path, bytes);
    return json({ pathname: path });
  }

  if (url.pathname === '/api/files/content') {
    if (request.method !== 'GET') return error(405, 'Method not allowed');
    const path = url.searchParams.get('path') ?? '';
    if (!isFilePath(path)) return error(400, 'Bad document path');
    const { rows } = await getPool().query<{ name: string | null; type: string | null }>(
      `select data->>'name' as name, data->>'mimeType' as type from app_record
        where collection = 'files' and data is not null and data->>'blobPath' = $1 limit 1`,
      [path],
    );
    if (!rows[0]) return error(404, 'No such document');
    const stored = await readStored(path);
    if (!stored) return error(404, 'The document is missing from storage');
    const name = (rows[0].name ?? 'document').replace(/["\\\r\n]/g, '');
    // A header carries only Latin-1, so a name like "Binder — Ødegård.pdf" or
    // "報告.pdf" goes in filename* (UTF-8, which browsers use), with a plain
    // ASCII stand-in for any that do not; written raw, it would fail the download.
    const ascii = name.replace(/[^\x20-\x7e]/g, '_');
    return new Response(stored.body as BodyInit, {
      headers: {
        // The type comes from the document record, which the browser wrote;
        // only a kind of file AEROBOOK keeps is served as itself.
        'content-type': servedType(rows[0].type),
        // Always a download, never rendered as a page on this site.
        'content-disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`,
        'x-content-type-options': 'nosniff',
        'cache-control': 'private, no-store',
      },
    });
  }
  return error(404, 'Not found');
}

/**
 * Scheduled jobs. Vercel Cron calls them with CRON_SECRET as a bearer token;
 * anyone else is turned away. Null means the caller may go ahead.
 */
function checkCron(request: Request, what: string): Response | null {
  if (request.method !== 'GET' && request.method !== 'POST') return error(405, 'Method not allowed');
  const secret = process.env.CRON_SECRET;
  if (!secret) return error(503, `${what} is not scheduled on this deployment`);
  const given = request.headers.get('authorization') ?? '';
  if (!sameSecret(given, `Bearer ${secret}`)) return error(401, 'Not allowed');
  return null;
}

/**
 * The daily email, sent by the scheduled run. A signed-in person can preview
 * their own digest, or have it sent to themselves now.
 */
async function digest(request: Request): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (pathname === '/api/digest/run') return checkCron(request, 'The daily email') ?? json(await runDigest());

  const user = await sessionUser(request);
  if (!user) return error(401, 'Sign in first');
  if (pathname === '/api/digest/preview') {
    if (request.method !== 'GET') return error(405, 'Method not allowed');
    const [mine] = await buildDigests(new Date(), { userId: user.id });
    if (!mine) return error(404, 'No digest for this account');
    return json({ enabled: emailEnabled(), empty: isEmptyDigest(mine), to: mine.email, ...renderDigest(mine) });
  }
  if (pathname === '/api/digest/send') {
    if (request.method !== 'POST') return error(405, 'Method not allowed');
    const refused = checkWrite(request);
    if (refused) return refused;
    const [mine] = await buildDigests(new Date(), { userId: user.id });
    if (!mine) return error(404, 'No digest for this account');
    try {
      // Only ever to the signed-in person's own address.
      await sendEmail(mine.email, renderDigest(mine));
    } catch (e) {
      if (e instanceof EmailError) return error(emailEnabled() ? 502 : 503, e.message);
      throw e;
    }
    return json({ sentTo: mine.email });
  }
  return error(404, 'Not found');
}

/**
 * Emailing a customer from AEROBOOK, with documents from their profile
 * attached. Anyone who may open those documents may send them; what may go,
 * and to whom, is decided in customer-email.ts.
 */
async function customerEmail(request: Request, user: SessionUser): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (pathname === '/api/email/config') {
    if (request.method !== 'GET') return error(405, 'Method not allowed');
    return json(emailConfig());
  }
  if (pathname === '/api/email/send') {
    if (request.method !== 'POST') return error(405, 'Method not allowed');
    const refused = checkWrite(request);
    if (refused) return refused;
    return json(await sendCustomerEmail(user, await readJson(request)));
  }
  return error(404, 'Not found');
}

async function sync(request: Request, user: SessionUser): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === '/api/sync/status') return json({ empty: await isEmpty() });
  if (request.method === 'GET') {
    const since = Number(url.searchParams.get('since') ?? 0);
    if (!Number.isInteger(since) || since < 0) return error(400, 'Bad cursor');
    return json(await pull(user, since, url.searchParams.get('full') === '1'));
  }
  if (request.method === 'POST') {
    const refused = checkWrite(request);
    if (refused) return refused;
    const changes = validateChanges(user, await readJson(request));
    return json(await push(user, changes));
  }
  return error(405, 'Method not allowed');
}

/**
 * A preview deployment is built from any branch, so it must never reach the
 * business's real data. Vercel hands previews whatever variables are scoped
 * to them, which can be production's; a preview therefore serves nothing
 * until PREVIEW_DATA=separate is set for the Preview environment, after its
 * database, BETTER_AUTH_SECRET and document store have been pointed elsewhere.
 */
function previewRefused(): Response | null {
  if (process.env.VERCEL_ENV !== 'preview' || process.env.PREVIEW_DATA === 'separate') return null;
  return error(503, 'This preview deployment is not connected to any data. See "Preview deployments" in the README.');
}

/**
 * An admin turns off two-step sign-in for someone who lost their phone. See
 * resetTwoFactor in security.ts.
 */
async function resetTwoFactorRoute(request: Request): Promise<Response> {
  if (request.method !== 'POST') return error(405, 'Method not allowed');
  const refused = checkWrite(request);
  if (refused) return refused;
  const user = await sessionUser(request);
  if (!user) return error(401, 'Sign in first');
  if (!isAdmin(user)) return error(403, 'Only an admin can do that');
  const { userId } = (await readJson(request)) as { userId?: unknown };
  if (typeof userId !== 'string' || !userId) return error(400, 'Say whose two-step sign-in to reset');
  try {
    await resetTwoFactor(user, userId);
  } catch (e) {
    if (e instanceof ResetRefused) return error(e.status, e.message);
    throw e;
  }
  return json({ ok: true });
}

/**
 * Better Auth's routes. It checks the password before it notices an account
 * whose access was turned off, and says so in a reply of its own; that would
 * tell someone guessing a former colleague's password when they got it right.
 * The reply is made the same as for a wrong password.
 */
async function authRoute(request: Request, pathname: string): Promise<Response> {
  const deleted = await refuseDeletedTarget(request, pathname);
  if (deleted) return deleted;
  const outranked = await refuseOutranked(request, pathname);
  if (outranked) return outranked;
  const response = await getAuth().handler(request);
  const signIn = pathname === '/api/auth/sign-in/email';
  // Access turned off between the password and the two-step code.
  const secondStep = pathname === '/api/auth/two-factor/verify-totp' || pathname === '/api/auth/two-factor/verify-backup-code';
  if ((!signIn && !secondStep) || response.status !== 403) return response;
  const body = (await response.clone().json().catch(() => null)) as { code?: string } | null;
  if (body?.code !== 'BANNED_USER') return response;
  // Exactly what Better Auth sends for a wrong password or code, headers included.
  const same = signIn
    ? { message: 'Invalid email or password', code: 'INVALID_EMAIL_OR_PASSWORD' }
    : { message: 'Invalid code', code: 'INVALID_CODE' };
  return new Response(JSON.stringify(same), { status: 401, headers: { 'content-type': 'application/json' } });
}

export async function handle(request: Request): Promise<Response> {
  const { pathname } = new URL(request.url);
  const refused = previewRefused();
  if (refused) return refused;
  try {
    if (pathname.startsWith('/api/auth/')) return await authRoute(request, pathname);
    if (pathname === '/api/setup') return await setup(request);
    if (pathname === '/api/sync' || pathname === '/api/sync/status') {
      const user = await sessionUser(request);
      if (!user) return error(401, 'Sign in first');
      return await sync(request, user);
    }
    if (pathname === '/api/history') {
      // Read-only: there is no way to change what was recorded.
      if (request.method !== 'GET') return error(405, 'Method not allowed');
      if (!(await sessionUser(request))) return error(401, 'Sign in first');
      const raw = new URL(request.url).searchParams.get('before');
      const before = raw === null ? undefined : Number(raw);
      if (before !== undefined && (!Number.isInteger(before) || before < 1)) return error(400, 'Bad cursor');
      return json(await history(before));
    }
    if (pathname.startsWith('/api/files/')) {
      if (!(await sessionUser(request))) return error(401, 'Sign in first');
      return await files(request);
    }
    if (pathname.startsWith('/api/digest/')) return await digest(request);
    if (pathname.startsWith('/api/email/')) {
      const user = await sessionUser(request);
      if (!user) return error(401, 'Sign in first');
      return await customerEmail(request, user);
    }
    if (pathname === '/api/maintenance/run') {
      // Clears out the files of documents deleted long enough ago, and old notifications.
      const refused = checkCron(request, 'Maintenance');
      if (refused) return refused;
      const purged = await purgeTrash();
      await pruneNotifications();
      return json(purged);
    }
    if (pathname === '/api/team') {
      if (request.method !== 'GET') return error(405, 'Method not allowed');
      if (!(await sessionUser(request))) return error(401, 'Sign in first');
      return await team();
    }
    if (pathname === '/api/team/reset-two-factor') return await resetTwoFactorRoute(request);
    if (pathname === '/api/team/delete') return await deleteUserRoute(request);
    if (pathname === '/api/team/color') return await profileColorRoute(request);
    if (pathname === '/api/export/company') {
      // A POST, not a link: it is recorded, and it cannot be set off from another site.
      if (request.method !== 'POST') return error(405, 'Method not allowed');
      const refused = checkWrite(request);
      if (refused) return refused;
      const user = await sessionUser(request);
      if (!user) return error(401, 'Sign in first');
      return json(await startCompanyExport(user));
    }
    if (pathname === '/api/export/audit') {
      if (request.method !== 'GET') return error(405, 'Method not allowed');
      const user = await sessionUser(request);
      if (!user) return error(401, 'Sign in first');
      const after = Number(new URL(request.url).searchParams.get('after') ?? 0);
      if (!Number.isInteger(after) || after < 0) return error(400, 'Bad cursor');
      return json(await companyAuditPage(user, after));
    }
    if (isMessagingPath(pathname)) {
      const user = await sessionUser(request);
      if (!user) return error(401, 'Sign in first');
      return await messaging(request, user);
    }
    return error(404, 'Not found');
  } catch (e) {
    if (e instanceof BadRequest) return error(400, e.message);
    if (e instanceof HttpError) return error(e.status, e.message);
    console.error(e);
    return error(500, 'Something went wrong on the server');
  }
}
