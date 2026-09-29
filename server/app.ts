/**
 * Every /api request lands here: one function, so there is one cold start and
 * one place that decides who may do what.
 */
import { timingSafeEqual } from 'node:crypto';
import { getAuth, migrate, sessionUser, type SessionUser } from './auth.js';
import { getPool } from './db.js';
import { BadRequest, isEmpty, pull, push, validateChanges } from './sync.js';

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
    return error(404, 'Not found');
  } catch (e) {
    if (e instanceof BadRequest) return error(400, e.message);
    console.error(e);
    return error(500, 'Something went wrong on the server');
  }
}
