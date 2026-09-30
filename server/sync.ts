/**
 * The two halves of keeping every device on the same data.
 *
 * Pull: "give me everything that changed after cursor N". Each write takes the
 * next number from one sequence, and writes are taken one at a time, so a
 * device that has seen N has seen everything up to N — nothing can commit
 * later with a smaller number and be skipped.
 *
 * Push: a list of records, each with the version the device last saw. A
 * record someone else changed in the meantime is not overwritten: the push
 * reports it as a conflict and hands back what is there now.
 */
import type { PoolClient } from 'pg';
import { ensureAppSchema, getPool } from './db.js';
import type { SessionUser } from './auth.js';

/** Collections everyone on the account shares. */
export const SHARED_COLLECTIONS = [
  'contacts', 'aircraft', 'opportunities', 'policies', 'activities',
  'followUps', 'templates', 'imports', 'files',
] as const;

/** Collections with one record per person, keyed by their user id. */
export const PERSONAL_COLLECTIONS = ['settings'] as const;

export type Collection = (typeof SHARED_COLLECTIONS)[number] | (typeof PERSONAL_COLLECTIONS)[number];

const ALL = new Set<string>([...SHARED_COLLECTIONS, ...PERSONAL_COLLECTIONS]);
const PERSONAL = new Set<string>(PERSONAL_COLLECTIONS);

export const MAX_CHANGES_PER_PUSH = 1000;

/**
 * How many records someone who is not an admin may delete in an hour. Every
 * everyday deletion fits comfortably — a contact with all their notes is a
 * few dozen — while erasing the account, or restoring a backup over it, stays
 * an admin's job whatever the browser is made to send.
 */
export const MEMBER_DELETE_LIMIT = 100;
export const MEMBER_DELETE_WINDOW = '1 hour';
export const DELETE_LIMIT_MESSAGE =
  'Deleting that many records at once needs an admin, so those were kept. Ask an admin if they really should go.';

const PULL_PAGE = 5000;
/** Any number will do, as long as every push takes the same one. */
const WRITE_LOCK = 4_217_001;

export interface RemoteRecord {
  collection: Collection;
  id: string;
  /** Null when the record was deleted. */
  data: Record<string, unknown> | null;
  version: number;
}

export interface Change {
  collection: Collection;
  id: string;
  data: Record<string, unknown> | null;
  /** The version this device last saw; 0 for a record it created. */
  baseVersion: number;
}

export class BadRequest extends Error {}

/**
 * `full` is a device loading everything from scratch: it has nothing to
 * delete, so deletions are left out. The cursor alone cannot say this — an
 * account with no data yet leaves a device's cursor at 0 for a while.
 */
export async function pull(user: SessionUser, since: number, full = false): Promise<{
  records: RemoteRecord[];
  cursor: number;
  more: boolean;
}> {
  // One statement, so the page and the cursor come from the same snapshot.
  // Rows this person may not see are dropped afterwards rather than in SQL:
  // they must still move the cursor past them.
  const { rows } = await getPool().query<{
    collection: Collection; id: string; data: Record<string, unknown> | null; version: number; seq: string;
  }>(
    'select collection, id, data, version, seq from app_record where seq > $1 order by seq limit $2',
    [since, PULL_PAGE + 1],
  );
  const more = rows.length > PULL_PAGE;
  const page = more ? rows.slice(0, PULL_PAGE) : rows;
  const cursor = page.length ? Number(page[page.length - 1].seq) : since;
  const records = page
    .filter((r) => !PERSONAL.has(r.collection) || r.id === user.id)
    .filter((r) => !full || r.data !== null)
    .map(({ collection, id, data, version }) => ({ collection, id, data, version }));
  return { records, cursor, more };
}

export function validateChanges(user: SessionUser, body: unknown): Change[] {
  const changes = (body as { changes?: unknown })?.changes;
  if (!Array.isArray(changes)) throw new BadRequest('Expected { changes: [...] }');
  if (changes.length > MAX_CHANGES_PER_PUSH) throw new BadRequest(`At most ${MAX_CHANGES_PER_PUSH} changes per push`);
  return changes.map((c: unknown, i) => {
    const change = c as Partial<Change>;
    if (typeof change.collection !== 'string' || !ALL.has(change.collection)) {
      throw new BadRequest(`Change ${i}: unknown collection`);
    }
    if (typeof change.id !== 'string' || !change.id || change.id.length > 200) {
      throw new BadRequest(`Change ${i}: missing id`);
    }
    if (PERSONAL.has(change.collection) && change.id !== user.id) {
      throw new BadRequest(`Change ${i}: ${change.collection} can only be written for yourself`);
    }
    const data = change.data ?? null;
    if (data !== null && (typeof data !== 'object' || Array.isArray(data))) {
      throw new BadRequest(`Change ${i}: data must be an object or null`);
    }
    if (data !== null && !PERSONAL.has(change.collection) && data.id !== change.id) {
      throw new BadRequest(`Change ${i}: data.id does not match id`);
    }
    const baseVersion = Number(change.baseVersion ?? 0);
    if (!Number.isInteger(baseVersion) || baseVersion < 0) throw new BadRequest(`Change ${i}: bad baseVersion`);
    return { collection: change.collection as Collection, id: change.id, data, baseVersion };
  });
}

export interface PushResult {
  applied: { collection: Collection; id: string; version: number }[];
  conflicts: RemoteRecord[];
  /** Deletions the server would not make, with the records as they still are. */
  refused?: { message: string; records: RemoteRecord[] };
}

export async function push(user: SessionUser, changes: Change[]): Promise<PushResult> {
  await ensureAppSchema();
  const client = await getPool().connect();
  try {
    await client.query('begin');
    await client.query('select pg_advisory_xact_lock($1)', [WRITE_LOCK]);
    const applied: PushResult['applied'] = [];
    const conflicts: RemoteRecord[] = [];
    const refused: RemoteRecord[] = [];
    const refuseDeletes = user.role !== 'admin' && await overDeleteLimit(client, user, changes);

    for (const change of changes) {
      const { rows } = await client.query<{ data: Record<string, unknown> | null; version: number }>(
        'select data, version from app_record where collection = $1 and id = $2',
        [change.collection, change.id],
      );
      const current = rows[0];

      if (current && current.version !== change.baseVersion) {
        conflicts.push({ collection: change.collection, id: change.id, data: current.data, version: current.version });
        continue;
      }
      if (!current && change.data === null) continue; // deleting what was never stored
      if (refuseDeletes && change.data === null && current?.data) {
        refused.push({ collection: change.collection, id: change.id, data: current.data, version: current.version });
        continue;
      }

      const version = (current?.version ?? 0) + 1;
      await client.query(
        `insert into app_record (collection, id, data, version, updated_by)
         values ($1, $2, $3, $4, $5)
         on conflict (collection, id) do update
           set data = excluded.data, version = excluded.version, updated_by = excluded.updated_by,
               updated_at = now(), seq = nextval('app_record_seq')`,
        [change.collection, change.id, change.data, version, user.id],
      );
      applied.push({ collection: change.collection, id: change.id, version });

      // A stored document whose record went is not deleted here: it waits in
      // the trash, and the maintenance run removes it once it has been there
      // long enough and nothing points at it any more.
      const oldPath = change.collection === 'files' ? current?.data?.blobPath : undefined;
      if (typeof oldPath === 'string' && oldPath !== change.data?.blobPath) {
        await client.query(
          `insert into app_file_trash (path, deleted_by) values ($1, $2)
           on conflict (path) do update set deleted_at = now(), deleted_by = excluded.deleted_by`,
          [oldPath, user.id],
        );
      }

      if (!PERSONAL.has(change.collection)) {
        const action = change.data === null ? 'delete' : !current?.data ? 'create' : 'update';
        await client.query(
          `insert into app_audit (user_id, user_name, action, collection, record_id, summary, before)
           values ($1, $2, $3, $4, $5, $6, $7)`,
          [user.id, user.name, action, change.collection, change.id, describe(change.data ?? current?.data ?? null), current?.data ?? null],
        );
      }
    }

    await client.query('commit');
    // No cursor comes back: this device has not seen what others wrote before
    // it, and its next pull will return its own writes at versions it holds.
    return refused.length
      ? { applied, conflicts, refused: { message: DELETE_LIMIT_MESSAGE, records: refused } }
      : { applied, conflicts };
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Whether this push would take someone past their deletions for the hour.
 * If it would, none of its deletions are made — half a bulk erase is still an
 * erase — and everything else in it goes ahead.
 */
async function overDeleteLimit(client: PoolClient, user: SessionUser, changes: Change[]): Promise<boolean> {
  const deleting = changes.filter((c) => c.data === null && !PERSONAL.has(c.collection)).length;
  if (deleting === 0) return false;
  if (deleting > MEMBER_DELETE_LIMIT) return true;
  // Only deletions of shared records count — the same kind this push is
  // making. Other things share the audit table under their own collection
  // (comments, chat groups, security events) and have their own rules: a
  // deleted comment or someone leaving a group does not use up the allowance.
  const { rows } = await client.query<{ n: number }>(
    `select count(*)::int as n from app_audit
      where user_id = $1 and action = 'delete' and collection = any($3::text[])
        and at > now() - $2::interval`,
    [user.id, MEMBER_DELETE_WINDOW, [...SHARED_COLLECTIONS]],
  );
  return rows[0].n + deleting > MEMBER_DELETE_LIMIT;
}

export interface HistoryEntry {
  id: number;
  at: string;
  userId: string | null;
  userName: string;
  action: 'create' | 'update' | 'delete';
  collection: string;
  recordId: string;
  summary: string;
}

export const HISTORY_PAGE = 100;

/**
 * The activity history, newest first. It is read straight from what push()
 * recorded; nothing here writes. Sign-in security events share the table
 * (collection "security") and are left out: they are not changes to records;
 * so are changes to chat groups (collection "chat"), which are for admins.
 * `before` is the id of the last entry already shown — ids only ever grow, so
 * paging by them never skips or repeats one.
 */
export async function history(before?: number): Promise<{ entries: HistoryEntry[]; more: boolean }> {
  const { rows } = await getPool().query<{
    id: string; at: Date; user_id: string | null; user_name: string | null;
    action: HistoryEntry['action']; collection: string; record_id: string; summary: string;
  }>(
    `select id, at, user_id, user_name, action, collection, record_id, summary from app_audit
      where ($1::bigint is null or id < $1) and collection not in ('security', 'chat')
      order by id desc
      limit $2`,
    [before ?? null, HISTORY_PAGE + 1],
  );
  const more = rows.length > HISTORY_PAGE;
  return {
    entries: rows.slice(0, HISTORY_PAGE).map((r) => ({
      id: Number(r.id),
      at: r.at.toISOString(),
      userId: r.user_id,
      userName: r.user_name ?? 'Someone',
      action: r.action,
      collection: r.collection,
      recordId: r.record_id,
      summary: r.summary,
    })),
    more,
  };
}

/** A few words that say which record this was, for the activity history. */
export function describe(data: Record<string, unknown> | null): string {
  if (!data) return '';
  const s = (k: string) => (typeof data[k] === 'string' ? (data[k] as string).trim() : '');
  const person = [s('firstName'), s('lastName')].filter(Boolean).join(' ') || s('rawName') || s('company');
  const candidates = [s('tailNumber'), s('title'), s('subject'), s('note'), person, s('name'), s('filename'), s('carrier')];
  return (candidates.find(Boolean) ?? '').slice(0, 120);
}

/**
 * Whether anyone has put real work into the account yet. Templates and
 * settings do not count: every new account gets those on first sign-in.
 */
export async function isEmpty(): Promise<boolean> {
  const { rows } = await getPool().query(
    `select 1 from app_record where data is not null and collection = any($1::text[]) limit 1`,
    [['contacts', 'aircraft', 'opportunities', 'policies', 'activities', 'followUps']],
  );
  return rows.length === 0;
}
