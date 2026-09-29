/**
 * Sign-in. Accounts are invite-only: there is no sign-up form, an admin
 * creates each person from Settings, and the very first admin is created once
 * through /api/setup with a token only the deployer knows.
 */
import { betterAuth } from 'better-auth';
import { admin } from 'better-auth/plugins';
import { getMigrations } from 'better-auth/db/migration';
import { APP_SCHEMA, getPool } from './db.js';

/**
 * The addresses this deployment answers on: Vercel's own for production and
 * previews, plus APP_ORIGINS for a custom domain or local development.
 */
function appOrigins(): string[] {
  const hosts = [
    process.env.VERCEL_PROJECT_PRODUCTION_URL,
    process.env.VERCEL_BRANCH_URL,
    process.env.VERCEL_URL,
  ].filter(Boolean).map((h) => `https://${h}`);
  const extra = (process.env.APP_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return [...hosts, ...extra];
}

function options() {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret) throw new Error('BETTER_AUTH_SECRET is not set');
  return {
    secret,
    basePath: '/api/auth',
    // Server-side calls with no request behind them (first-time setup) use the first.
    baseURL: { allowedHosts: appOrigins().map((o) => new URL(o).host), fallback: appOrigins()[0] },
    database: getPool(),
    trustedOrigins: appOrigins(),
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      minPasswordLength: 10,
    },
    session: {
      // A phone app someone opens a few times a day should not ask for the
      // password every week; an admin can still end anyone's sessions.
      expiresIn: 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 24,
    },
    rateLimit: {
      enabled: true,
      // Serverless instances do not share memory, so the count lives in Postgres.
      storage: 'database' as const,
      customRules: {
        '/sign-in/email': { window: 60, max: 5 },
      },
    },
    advanced: {
      // Vercel sets these itself, so a client cannot forge its way around the limit.
      ipAddress: { ipAddressHeaders: ['x-real-ip', 'x-forwarded-for'] },
    },
    plugins: [admin({ defaultRole: 'user', adminRoles: ['admin'] })],
  };
}

export type Auth = ReturnType<typeof createAuth>;

function createAuth() {
  return betterAuth(options());
}

let auth: Auth | null = null;

export function getAuth(): Auth {
  auth ??= createAuth();
  return auth;
}

/** Test seam. */
export function resetAuth(): void {
  auth = null;
}

/** Create or bring up to date every table, Better Auth's and AEROBOOK's. */
export async function migrate(): Promise<void> {
  const { runMigrations } = await getMigrations(options());
  await runMigrations();
  await getPool().query(APP_SCHEMA);
}

/** Better Auth's and AEROBOOK's schema as SQL, for applying by hand. */
export async function schemaSql(): Promise<string> {
  const { compileMigrations } = await getMigrations(options());
  return `${await compileMigrations()}\n${APP_SCHEMA}`;
}

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  role: 'admin' | 'user';
}

export async function sessionUser(request: Request): Promise<SessionUser | null> {
  const session = await getAuth().api.getSession({ headers: request.headers });
  if (!session) return null;
  const u = session.user as { id: string; name: string; email: string; role?: string | null; banned?: boolean | null };
  if (u.banned) return null;
  return { id: u.id, name: u.name, email: u.email, role: u.role === 'admin' ? 'admin' : 'user' };
}
