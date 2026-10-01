/**
 * Test support: a clean database per test file, and signed-in requests.
 * Tests that need Postgres run only when TEST_DATABASE_URL is set.
 */
import { handle } from './app.js';
import { getAuth, migrate, resetAuth } from './auth.js';
import { getPool, resetPool } from './db.js';
import type { Role } from '../src/lib/roles.js';

export const TEST_DB = process.env.TEST_DATABASE_URL;
export const ORIGIN = 'http://localhost:4173';

export async function freshDatabase(): Promise<void> {
  process.env.DATABASE_URL = TEST_DB;
  process.env.BETTER_AUTH_SECRET = 'test-secret-that-is-long-enough-for-better-auth';
  process.env.APP_ORIGINS = ORIGIN;
  await resetPool();
  resetAuth();
  await getPool().query('drop schema public cascade; create schema public;');
  await migrate();
}

export async function createUser(name: string, email: string, role: Role = 'user', password = 'correct horse battery') {
  const { user } = await getAuth().api.createUser({ body: { name, email, password, role } });
  return user;
}

export async function signIn(email: string, password = 'correct horse battery'): Promise<string> {
  const response = await handle(new Request(`${ORIGIN}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify({ email, password }),
  }));
  if (!response.ok) throw new Error(`sign-in failed: ${response.status} ${await response.text()}`);
  const cookies = response.headers.getSetCookie().map((c) => c.split(';')[0]);
  return cookies.join('; ');
}

export function api(path: string, init: { method?: string; body?: unknown; cookie?: string; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { origin: ORIGIN, ...(init.headers ?? {}) };
  if (init.cookie) headers.cookie = init.cookie;
  if (init.body !== undefined) headers['content-type'] ??= 'application/json';
  return handle(new Request(`${ORIGIN}${path}`, {
    method: init.method ?? (init.body !== undefined ? 'POST' : 'GET'),
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  }));
}
