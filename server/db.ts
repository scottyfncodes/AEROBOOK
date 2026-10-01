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
  schemaReady = null;
  await current?.end();
}

/**
 * APP_SCHEMA is only ever additive, so running it against a database made by
 * an earlier version brings it up to date. Once per instance, before the first
 * write; the lock keeps two instances starting together from colliding.
 */
let schemaReady: Promise<void> | null = null;

export function ensureAppSchema(): Promise<void> {
  schemaReady ??= getPool()
    .query(`select pg_advisory_xact_lock(4217002);\n${APP_SCHEMA}`)
    .then(() => undefined, (error) => {
      schemaReady = null;
      throw error;
    });
  return schemaReady;
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
-- What a record held before a change or deletion, so it can be put back.
alter table app_audit add column if not exists before jsonb;
create index if not exists app_audit_user_at_idx on app_audit (user_id, at);

-- Stored documents whose record went. The file is kept a while, so a
-- document deleted by mistake (or on purpose) can be restored, and removed
-- by the maintenance run only when no document record points at it.
create table if not exists app_file_trash (
  path text primary key,
  deleted_at timestamptz not null default now(),
  deleted_by text
);

-- Who has had today's email, so a repeated cron run sends nothing twice.
create table if not exists app_digest (
  user_id text not null,
  day date not null,
  sent_at timestamptz not null default now(),
  primary key (user_id, day)
);

-- Chat. Kept out of app_record on purpose: app_record goes to every device,
-- and a conversation belongs only to its members. A direct conversation's
-- direct_key is its two people's ids, sorted, so there is only ever one.
create table if not exists app_conversation (
  id text primary key,
  kind text not null check (kind in ('direct', 'group')),
  name text,
  direct_key text unique,
  created_by text not null references "user" ("id"),
  created_at timestamptz not null default now(),
  last_message_at timestamptz,
  check ((kind = 'direct') = (direct_key is not null))
);

-- left_at is set when someone leaves or is removed: they lose access, and
-- what they wrote stays. last_read_message_id is how far they have read.
create table if not exists app_conversation_member (
  conversation_id text not null references app_conversation (id),
  user_id text not null references "user" ("id"),
  joined_at timestamptz not null default now(),
  left_at timestamptz,
  last_read_message_id bigint not null default 0,
  primary key (conversation_id, user_id)
);
create index if not exists app_conversation_member_user_idx on app_conversation_member (user_id);

-- client_id makes a send that is retried (a dropped connection) land once.
create table if not exists app_message (
  id bigserial primary key,
  conversation_id text not null references app_conversation (id),
  sender_id text not null references "user" ("id"),
  body text not null check (char_length(body) between 1 and 5000),
  client_id text not null,
  created_at timestamptz not null default now(),
  unique (conversation_id, sender_id, client_id)
);
create index if not exists app_message_conversation_idx on app_message (conversation_id, id);

-- Comments on an aircraft. The aircraft is a row in app_record, which is
-- never removed (a deleted aircraft keeps its row with data null), so the
-- key always points at a real aircraft. Deleting a comment only marks it;
-- the words stay, for an admin with database access to put back.
create table if not exists app_aircraft_comment (
  id bigserial primary key,
  aircraft_collection text not null default 'aircraft' check (aircraft_collection = 'aircraft'),
  aircraft_id text not null,
  author_id text not null references "user" ("id"),
  body text not null check (char_length(body) between 1 and 5000),
  client_id text not null,
  created_at timestamptz not null default now(),
  edited_at timestamptz,
  deleted_at timestamptz,
  deleted_by text references "user" ("id"),
  foreign key (aircraft_collection, aircraft_id) references app_record (collection, id),
  unique (aircraft_id, author_id, client_id)
);
create index if not exists app_aircraft_comment_aircraft_idx on app_aircraft_comment (aircraft_id, id);

-- What a comment said before each edit.
create table if not exists app_aircraft_comment_revision (
  id bigserial primary key,
  comment_id bigint not null references app_aircraft_comment (id),
  body text not null,
  edited_by text not null references "user" ("id"),
  replaced_at timestamptz not null default now()
);
create index if not exists app_aircraft_comment_revision_comment_idx on app_aircraft_comment_revision (comment_id);

-- How far each person has read an aircraft's comments.
create table if not exists app_aircraft_comment_read (
  user_id text not null references "user" ("id"),
  aircraft_id text not null,
  last_read_comment_id bigint not null default 0,
  primary key (user_id, aircraft_id)
);

-- Who hears about new comments on an aircraft. Commenting starts watching,
-- unless the person has already said otherwise.
create table if not exists app_aircraft_watch (
  user_id text not null references "user" ("id"),
  aircraft_id text not null,
  watching boolean not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, aircraft_id)
);
create index if not exists app_aircraft_watch_aircraft_idx on app_aircraft_watch (aircraft_id) where watching;

-- Browsers that asked for notifications. An endpoint is one browser on one
-- device, so it belongs to whoever last signed in there.
create table if not exists app_push_subscription (
  id bigserial primary key,
  user_id text not null references "user" ("id") on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  user_agent text,
  created_at timestamptz not null default now(),
  last_success_at timestamptz
);
create index if not exists app_push_subscription_user_idx on app_push_subscription (user_id);

-- Which devices have AEROBOOK open and in use right now, and where. Nobody
-- is sent a notification about something while they are looking at the app.
create table if not exists app_presence (
  user_id text not null references "user" ("id") on delete cascade,
  device_id text not null,
  view text not null,
  seen_at timestamptz not null default now(),
  primary key (user_id, device_id)
);

-- Every notification anyone was due, chat and comments alike: the in-app
-- pop-up reads it, and push_status says what was sent to their devices. One
-- row per person per message or comment, so nothing is announced twice.
create table if not exists app_notification (
  id bigserial primary key,
  user_id text not null references "user" ("id") on delete cascade,
  kind text not null check (kind in ('message', 'comment')),
  thread text not null,
  source_id bigint not null,
  actor_id text,
  created_at timestamptz not null default now(),
  push_status text not null default 'pending',
  unique (user_id, kind, source_id)
);
create index if not exists app_notification_thread_idx on app_notification (user_id, thread, id desc);

-- People an admin deleted. Their "user" row stays as an empty, permanently
-- disabled shell — no sign-in, no email, no sessions — so their name stays
-- on what they wrote; this records who it was and who deleted them.
create table if not exists app_deleted_user (
  user_id text primary key references "user" ("id"),
  name text not null,
  deleted_at timestamptz not null default now(),
  deleted_by text not null
);
`;
