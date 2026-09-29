/**
 * The Postgres connection, and the tables AEROBOOK owns.
 *
 * Records are stored one row per record, as the JSON the app already works
 * with. Querying inside them is rare and Postgres can do it when needed; what
 * a row per record buys is that two people editing different things never
 * overwrite each other. `version` catches two people editing the same thing,
 * and `seq` is the cursor a device uses to ask "what changed since I last
 * looked".
 */
import pg from 'pg';

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (pool) return pool;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is not set');
  pool = new pg.Pool({
    connectionString,
    // A function instance serves one request at a time more often than not;
    // a small pool that lets idle connections go keeps Neon free to sleep.
    max: 5,
    idleTimeoutMillis: 10_000,
  });
  return pool;
}

/** Test seam: point at a different database. */
export async function resetPool(): Promise<void> {
  const current = pool;
  pool = null;
  await current?.end();
}

export const APP_SCHEMA = `
create sequence if not exists app_record_seq;

create table if not exists app_record (
  collection text not null,
  id text not null,
  data jsonb,
  version integer not null default 1,
  seq bigint not null default nextval('app_record_seq'),
  updated_at timestamptz not null default now(),
  updated_by text,
  primary key (collection, id)
);
create index if not exists app_record_seq_idx on app_record (seq);

create table if not exists app_audit (
  id bigserial primary key,
  at timestamptz not null default now(),
  user_id text,
  user_name text,
  action text not null,
  collection text not null,
  record_id text not null,
  summary text not null default ''
);
create index if not exists app_audit_at_idx on app_audit (at desc);
`;
