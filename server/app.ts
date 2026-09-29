/**
 * Every /api request lands here: one function, so there is one cold start and
 * one place that decides who may do what.
 */
import { timingSafeEqual } from 'node:crypto';
import { getAuth, migrate, sessionUser, type SessionUser } from './auth.js';
import { getPool } from './db.js';
import { BadRequest, history, isEmpty, pull, push, validateChanges } from './sync.js';
import {
  blobUploadToken, isFilePath, MAX_FILE_BYTES, putLocal, readStored, storageMode,
} from './files.js';

const MAX_BODY_BYTES = 4 * 1024 * 1024;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

const error = (status: number, message: string) => json({ error: message }, status);

/**
 * Writes must be same-origin JSON. A page on another site can make a
 * browser send cookies with a form post, but not with this content type
 * without asking first, and not with this site's Origin.
 */
function checkWrite(request: Request): Response | null {
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) return error(403, 'Cross-origin request refused');
  if (!(request.headers.get('content-type') ?? '').startsWith('application/json')) {
    return error(415, 'Expected application/json');
  }
  const length = Number(request.headers.get('content-length') ?? 0);
  if (length > MAX_BODY_BYTES) return error(413, 'Request too large');
  return null;
}

async function readJson(request: Request): Promise<unknown> {
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) throw new BadRequest('Request too large');
  try {
    return JSON.parse(text);
  } catch {
    throw new BadRequest('Invalid JSON');
  }
}

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
 * The first admin. Only possible while nobody has an account, and only with
 * the SETUP_TOKEN set on the deployment — so finding the URL first is not
 * enough to claim it.
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
    body: { name: body.name.trim(), email: body.email.trim().toLowerCase(), password: body.password, role: 'admin' },
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
  const { rows } = await getPool().query<{ id: string; name: string; banned: boolean | null }>(
    'select id, name, banned from "user" order by name',
  );
  return json({ people: rows.map((r) => ({ id: r.id, name: r.name, active: !r.banned })) });
}

/**
 * Documents. Every route needs a session; reading one also needs a document
 * record that points at it, so only files the app itself stored can be read.
 */
async function files(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const mode = storageMode();

  if (url.pathname === '/api/files/config') return json({ mode, maxBytes: MAX_FILE_BYTES });

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
    return new Response(stored.body as BodyInit, {
      headers: {
        'content-type': rows[0].type || 'application/octet-stream',
        // Always a download, never rendered as a page on this site.
        'content-disposition': `attachment; filename="${name}"; filename*=UTF-8''${encodeURIComponent(name)}`,
        'x-content-type-options': 'nosniff',
        'cache-control': 'private, no-store',
      },
    });
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

export async function handle(request: Request): Promise<Response> {
  const { pathname } = new URL(request.url);
  try {
    if (pathname.startsWith('/api/auth/')) return await getAuth().handler(request);
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
    if (pathname === '/api/team') {
      if (request.method !== 'GET') return error(405, 'Method not allowed');
      if (!(await sessionUser(request))) return error(401, 'Sign in first');
      return await team();
    }
    return error(404, 'Not found');
  } catch (e) {
    if (e instanceof BadRequest) return error(400, e.message);
    console.error(e);
    return error(500, 'Something went wrong on the server');
  }
}
