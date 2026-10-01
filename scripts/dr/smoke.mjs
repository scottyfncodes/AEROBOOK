/**
 * Disaster-recovery smoke test: start AEROBOOK against a RESTORED database
 * and read the business data back through the real API.
 *
 *   DATABASE_URL=...              the restored branch, never production
 *   DR_EXPECT_HOST=ep-....neon.tech   the restored branch's endpoint host
 *   DR_FORBID_HOST=ep-....neon.tech   production's endpoint host
 *   node scripts/dr/smoke.mjs [server entry]
 *
 * The server entry defaults to `npx tsx server/local.ts`; pass a bundled
 * server (see docs/disaster-recovery.md) to run it somewhere without the repo.
 *
 * It refuses to run unless DATABASE_URL's host is DR_EXPECT_HOST and is not
 * DR_FORBID_HOST. It writes to that database: one synthetic user
 * (dr-smoke-…@example.invalid), the session from signing in, and whatever
 * the server's start-up schema check adds. The user is removed at the end.
 * It sends no email and no push: the server is started with none of the
 * keys for either, and no Blob store.
 *
 * Prints counts only — never a record's contents, a name or an email.
 */
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { hashPassword } from 'better-auth/crypto';

const fail = (message) => {
  console.error(`DR smoke test: ${message}`);
  process.exit(1);
};

// --- Guard: only ever the restored database. ---------------------------------
const { DATABASE_URL, DR_EXPECT_HOST, DR_FORBID_HOST } = process.env;
if (!DATABASE_URL || !DR_EXPECT_HOST || !DR_FORBID_HOST) {
  fail('set DATABASE_URL, DR_EXPECT_HOST and DR_FORBID_HOST');
}
const host = new URL(DATABASE_URL).hostname;
if (host !== DR_EXPECT_HOST) fail(`DATABASE_URL points at ${host}, not ${DR_EXPECT_HOST}; refusing`);
if (host === DR_FORBID_HOST || host.replace('-pooler', '') === DR_FORBID_HOST.replace('-pooler', '')) {
  fail('DATABASE_URL is the production endpoint; refusing');
}
if (process.env.VERCEL_ENV === 'production') fail('VERCEL_ENV is production; refusing');

const PORT = Number(process.env.DR_PORT ?? 4319);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const started = Date.now();
const results = { host, checks: {}, counts: {}, timings: {} };
const check = (name, ok, detail) => {
  results.checks[name] = ok ? 'pass' : `FAIL${detail ? `: ${detail}` : ''}`;
};

// --- A synthetic user, on the restored database only. ------------------------
const db = new pg.Pool({ connectionString: DATABASE_URL, max: 2 });
const userId = `dr-smoke-${randomUUID()}`;
const email = `${userId}@example.invalid`;
const password = randomBytes(18).toString('base64url');
await db.query(
  `insert into "user" (id, name, email, "emailVerified", role, "createdAt", "updatedAt")
   values ($1, 'DR smoke test', $2, true, 'user', now(), now())`,
  [userId, email],
);
await db.query(
  `insert into account (id, "accountId", "providerId", "userId", password, "createdAt", "updatedAt")
   values ($1, $2, 'credential', $2, $3, now(), now())`,
  [randomUUID(), userId, await hashPassword(password)],
);

// --- Start AEROBOOK, with nothing that could reach the outside world. ---------
const env = { ...process.env };
for (const key of Object.keys(env)) {
  if (/^(RESEND_|VAPID_|BLOB_|CRON_SECRET|POSTGRES_|PG|NEON_|VERCEL)/.test(key)) delete env[key];
}
Object.assign(env, {
  PORT: String(PORT),
  BETTER_AUTH_SECRET: randomBytes(32).toString('base64'),
  APP_ORIGINS: ORIGIN,
  FILES_DIR: mkdtempSync(join(tmpdir(), 'dr-files-')),
});
delete env.SETUP_TOKEN;
const [cmd, ...args] = process.argv[2] ? ['node', process.argv[2]] : ['npx', 'tsx', 'server/local.ts'];
// Its own process group, so stopping it also stops what npx started.
const server = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
let serverLog = '';
server.stdout.on('data', (d) => (serverLog += d));
server.stderr.on('data', (d) => (serverLog += d));

async function cleanup() {
  try {
    process.kill(-server.pid);
  } catch {
    // Already gone.
  }
  await db.query('delete from session where "userId" = $1', [userId]).catch(() => {});
  await db.query('delete from account where "userId" = $1', [userId]).catch(() => {});
  await db.query('delete from "user" where id = $1', [userId]).catch(() => {});
  await db.end();
}

try {
  const deadline = Date.now() + 60_000;
  while (!serverLog.includes('AEROBOOK on')) {
    if (server.exitCode !== null) throw new Error(`server exited: ${serverLog.slice(-500)}`);
    if (Date.now() > deadline) throw new Error('server did not start within 60s');
    await new Promise((r) => setTimeout(r, 250));
  }
  results.timings.serverStartMs = Date.now() - started;
  check('app starts', true);

  const call = (path, init = {}) => fetch(`${ORIGIN}${path}`, {
    ...init,
    headers: { origin: ORIGIN, 'content-type': 'application/json', ...init.headers },
  });

  // Authentication: a wrong password is refused, the right one signs in.
  const wrong = await call('/api/auth/sign-in/email', {
    method: 'POST', body: JSON.stringify({ email, password: `${password}x` }),
  });
  check('wrong password refused', wrong.status === 401, `status ${wrong.status}`);
  const signIn = await call('/api/auth/sign-in/email', {
    method: 'POST', body: JSON.stringify({ email, password }),
  });
  const cookie = (signIn.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  check('sign in', signIn.ok && cookie.length > 0, `status ${signIn.status}`);
  const authed = (path) => call(path, { headers: { cookie } });
  check('unauthenticated read refused', (await call('/api/sync?since=0&full=1')).status === 401);

  // Every shared record, through the same endpoint the app loads from.
  const records = [];
  let since = 0;
  for (;;) {
    const res = await authed(`/api/sync?since=${since}&full=1`);
    if (!res.ok) throw new Error(`/api/sync answered ${res.status}`);
    const page = await res.json();
    records.push(...page.records);
    since = page.cursor;
    if (!page.more) break;
  }
  const byCollection = {};
  const ids = {};
  for (const r of records) {
    byCollection[r.collection] = (byCollection[r.collection] ?? 0) + 1;
    (ids[r.collection] ??= new Set()).add(r.id);
  }
  results.counts.records = byCollection;
  for (const name of ['contacts', 'aircraft', 'activities']) {
    check(`${name} retrieved`, (byCollection[name] ?? 0) > 0);
  }

  // Relationships, as the app sees them.
  const refs = {
    activities: ['contactId:contacts', 'aircraftId:aircraft', 'opportunityId:opportunities'],
    followUps: ['contactId:contacts', 'aircraftId:aircraft', 'opportunityId:opportunities', 'insurancePolicyId:policies'],
    opportunities: ['contactId:contacts', 'aircraftId:aircraft'],
    policies: ['contactId:contacts', 'aircraftId:aircraft', 'opportunityId:opportunities'],
    files: ['contactId:contacts', 'aircraftId:aircraft', 'opportunityId:opportunities', 'insurancePolicyId:policies'],
  };
  let links = 0;
  let dangling = 0;
  for (const r of records) {
    const pairs = (refs[r.collection] ?? []).map((p) => p.split(':'));
    for (const [field, target] of pairs) {
      const ref = r.data?.[field];
      if (!ref) continue;
      links += 1;
      if (!ids[target]?.has(ref)) dangling += 1;
    }
    if (r.collection === 'aircraft') {
      for (const o of r.data?.ownerships ?? []) {
        links += 1;
        if (!ids.contacts?.has(o.contactId)) dangling += 1;
      }
    }
  }
  results.counts.links = links;
  results.counts.danglingLinks = dangling;
  check('relationships intact', dangling === 0, `${dangling} of ${links} links point nowhere`);
  results.counts.documentsWithFile = records.filter((r) => r.collection === 'files' && r.data?.blobPath).length;

  // Activity history, the team list, and the user's own settings.
  const history = await authed('/api/history');
  const historyBody = history.ok ? await history.json() : null;
  results.counts.historyFirstPage = historyBody?.entries?.length ?? 0;
  check('activity history', history.ok && results.counts.historyFirstPage > 0, `status ${history.status}`);
  const team = await authed('/api/team');
  const teamBody = team.ok ? await team.json() : null;
  const people = teamBody?.people ?? [];
  results.counts.team = people.length;
  check('team list', team.ok && people.length > 0, `status ${team.status}`);
  check('sync status', (await authed('/api/sync/status')).ok);
} catch (e) {
  check('run', false, e instanceof Error ? e.message : String(e));
} finally {
  await cleanup();
}

results.timings.totalMs = Date.now() - started;
const failed = Object.values(results.checks).some((v) => v !== 'pass');
console.log(JSON.stringify(results, null, 2));
console.log(failed ? 'DR smoke test: FAILED' : 'DR smoke test: all checks passed');
process.exit(failed ? 1 : 0);
