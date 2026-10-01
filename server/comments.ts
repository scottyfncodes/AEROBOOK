/**
 * Comments on an aircraft: the discussion about one tail, kept on its record
 * rather than in chat.
 *
 * Who may see and write them follows the rest of AEROBOOK: everyone signed
 * in whose access is on sees and edits every aircraft, so everyone sees and
 * writes its comments. What the server does hold to, whatever the browser
 * sends:
 *
 *   - the aircraft must exist and not be deleted;
 *   - a comment is only ever read, edited or deleted through the aircraft it
 *     belongs to, so an id copied from another aircraft finds nothing;
 *   - only the author edits a comment; the author or an admin deletes it.
 *
 * Deleting only marks a comment, and editing keeps what it said before
 * (app_aircraft_comment_revision), so nothing is silently lost.
 */
import type { PoolClient } from 'pg';
import type { SessionUser } from './auth.js';
import { ensureAppSchema, getPool } from './db.js';
import { HttpError } from './http.js';
import { notify, type NotifyResult } from './notify.js';
import { isAdmin } from '../src/lib/roles.js';

export const MAX_COMMENT_CHARS = 5000;

const NO_AIRCRAFT = 'No such aircraft';
const NO_COMMENT = 'No such comment';

export interface CommentOut {
  id: number;
  aircraftId: string;
  authorId: string;
  authorName: string;
  /** Empty once deleted. */
  body: string;
  createdAt: string;
  editedAt: string | null;
  deleted: boolean;
}

export interface CommentThread {
  comments: CommentOut[];
  lastReadCommentId: number;
  watching: boolean;
}

/** The aircraft, if it exists and has not been deleted. Throws 404 otherwise. */
export async function aircraftTail(aircraftId: unknown): Promise<string> {
  if (typeof aircraftId !== 'string' || !aircraftId || aircraftId.length > 200) throw new HttpError(404, NO_AIRCRAFT);
  await ensureAppSchema();
  const { rows } = await getPool().query<{ tail: string | null }>(
    `select data->>'tailNumber' as tail from app_record
      where collection = 'aircraft' and id = $1 and data is not null`,
    [aircraftId],
  );
  if (!rows[0]) throw new HttpError(404, NO_AIRCRAFT);
  return rows[0].tail || 'an aircraft';
}

function cleanBody(value: unknown): string {
  if (typeof value !== 'string') throw new HttpError(400, 'Write a comment first');
  const body = value.replace(/\r\n?/g, '\n').replace(/^\s*\n|\s+$/g, '');
  if (!body.trim()) throw new HttpError(400, 'Write a comment first');
  if (body.length > MAX_COMMENT_CHARS) throw new HttpError(400, `Keep it under ${MAX_COMMENT_CHARS} characters`);
  return body;
}

function cleanClientId(value: unknown): string {
  if (typeof value === 'string' && /^[A-Za-z0-9_-]{6,64}$/.test(value)) return value;
  if (value === undefined) return `srv${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  throw new HttpError(400, 'Bad client id');
}

function commentId(value: string): number {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) throw new HttpError(404, NO_COMMENT);
  return id;
}

type Row = {
  id: string; aircraft_id: string; author_id: string; author_name: string | null; body: string;
  created_at: Date; edited_at: Date | null; deleted_at: Date | null;
};

const SELECT = `select c.id, c.aircraft_id, c.author_id, u.name as author_name, c.body, c.created_at, c.edited_at, c.deleted_at
  from app_aircraft_comment c left join "user" u on u.id = c.author_id`;

function toComment(r: Row): CommentOut {
  const deleted = r.deleted_at !== null;
  return {
    id: Number(r.id),
    aircraftId: r.aircraft_id,
    authorId: r.author_id,
    authorName: r.author_name ?? 'Someone',
    body: deleted ? '' : r.body,
    createdAt: r.created_at.toISOString(),
    editedAt: r.edited_at?.toISOString() ?? null,
    deleted,
  };
}

/** Every comment on the aircraft, oldest first. */
export async function listComments(user: SessionUser, aircraftId: string): Promise<CommentThread> {
  await aircraftTail(aircraftId);
  const [{ rows }, read, watch] = await Promise.all([
    getPool().query<Row>(`${SELECT} where c.aircraft_id = $1 order by c.id`, [aircraftId]),
    getPool().query<{ n: string }>(
      'select last_read_comment_id as n from app_aircraft_comment_read where user_id = $1 and aircraft_id = $2',
      [user.id, aircraftId],
    ),
    getPool().query<{ watching: boolean }>(
      'select watching from app_aircraft_watch where user_id = $1 and aircraft_id = $2',
      [user.id, aircraftId],
    ),
  ]);
  return {
    comments: rows.map(toComment),
    lastReadCommentId: Number(read.rows[0]?.n ?? 0),
    watching: watch.rows[0]?.watching ?? false,
  };
}

/** Comment changes go in the team's activity history: who, and on which tail — never the words. */
async function audit(client: PoolClient, user: SessionUser, action: 'create' | 'update' | 'delete', aircraftId: string, tail: string) {
  await client.query(
    `insert into app_audit (user_id, user_name, action, collection, record_id, summary)
     values ($1, $2, $3, 'aircraftComments', $4, $5)`,
    [user.id, user.name, action, aircraftId, tail.slice(0, 120)],
  );
}

export async function addComment(user: SessionUser, aircraftId: string, body: unknown): Promise<{
  comment: CommentOut; notified: NotifyResult[];
}> {
  const input = body as { body?: unknown; clientId?: unknown };
  const text = cleanBody(input?.body);
  const clientId = cleanClientId(input?.clientId);
  const tail = await aircraftTail(aircraftId);

  const client = await getPool().connect();
  let row: Row;
  let created = false;
  try {
    await client.query('begin');
    // One writer per aircraft, so ids are committed in order (see chat.ts).
    await client.query('select pg_advisory_xact_lock(4217011, hashtext($1))', [aircraftId]);
    const inserted = await client.query<Row>(
      `insert into app_aircraft_comment (aircraft_id, author_id, body, client_id) values ($1, $2, $3, $4)
       on conflict (aircraft_id, author_id, client_id) do nothing
       returning id, aircraft_id, author_id, $5::text as author_name, body, created_at, edited_at, deleted_at`,
      [aircraftId, user.id, text, clientId, user.name],
    );
    if (inserted.rows[0]) {
      created = true;
      row = inserted.rows[0];
      // Commenting is joining the discussion, unless they have said they would rather not.
      await client.query(
        `insert into app_aircraft_watch (user_id, aircraft_id, watching) values ($1, $2, true)
         on conflict (user_id, aircraft_id) do nothing`,
        [user.id, aircraftId],
      );
      await client.query(
        `insert into app_aircraft_comment_read (user_id, aircraft_id, last_read_comment_id) values ($1, $2, $3)
         on conflict (user_id, aircraft_id) do update
           set last_read_comment_id = greatest(app_aircraft_comment_read.last_read_comment_id, excluded.last_read_comment_id)`,
        [user.id, aircraftId, row.id],
      );
      await audit(client, user, 'create', aircraftId, tail);
    } else {
      row = (await client.query<Row>(
        `${SELECT} where c.aircraft_id = $1 and c.author_id = $2 and c.client_id = $3`,
        [aircraftId, user.id, clientId],
      )).rows[0];
    }
    await client.query('commit');
  } catch (e) {
    await client.query('rollback').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }

  const comment = toComment(row);
  const notified = created
    ? await notify({ kind: 'comment', sourceId: comment.id, aircraftId, tail, actor: { id: user.id, name: user.name } })
    : [];
  return { comment, notified };
}

/** The comment, found only through the aircraft in the address. */
async function findOnAircraft(client: PoolClient, aircraftId: string, id: number): Promise<Row> {
  const { rows } = await client.query<Row>(`${SELECT} where c.id = $1 and c.aircraft_id = $2 for update of c`, [id, aircraftId]);
  if (!rows[0]) throw new HttpError(404, NO_COMMENT);
  return rows[0];
}

export async function editComment(user: SessionUser, aircraftId: string, rawId: string, body: unknown): Promise<CommentOut> {
  const id = commentId(rawId);
  const text = cleanBody((body as { body?: unknown })?.body);
  const tail = await aircraftTail(aircraftId);
  const client = await getPool().connect();
  try {
    await client.query('begin');
    const current = await findOnAircraft(client, aircraftId, id);
    if (current.deleted_at) throw new HttpError(409, 'That comment was deleted');
    if (current.author_id !== user.id) throw new HttpError(403, 'Only whoever wrote a comment can edit it');
    if (current.body === text) {
      await client.query('commit');
      return toComment(current);
    }
    await client.query(
      'insert into app_aircraft_comment_revision (comment_id, body, edited_by) values ($1, $2, $3)',
      [id, current.body, user.id],
    );
    const { rows } = await client.query<Row>(
      `update app_aircraft_comment c set body = $2, edited_at = now() from (select $3::text as author_name) n
        where c.id = $1
        returning c.id, c.aircraft_id, c.author_id, n.author_name, c.body, c.created_at, c.edited_at, c.deleted_at`,
      [id, text, current.author_name],
    );
    await audit(client, user, 'update', aircraftId, tail);
    await client.query('commit');
    return toComment(rows[0]);
  } catch (e) {
    await client.query('rollback').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

export async function deleteComment(user: SessionUser, aircraftId: string, rawId: string): Promise<CommentOut> {
  const id = commentId(rawId);
  const tail = await aircraftTail(aircraftId);
  const client = await getPool().connect();
  try {
    await client.query('begin');
    const current = await findOnAircraft(client, aircraftId, id);
    if (current.author_id !== user.id && !isAdmin(user)) {
      throw new HttpError(403, 'Only whoever wrote a comment, or an admin, can delete it');
    }
    if (current.deleted_at) {
      await client.query('commit');
      return toComment(current);
    }
    const { rows } = await client.query<Row>(
      `update app_aircraft_comment c set deleted_at = now(), deleted_by = $2 from (select $3::text as author_name) n
        where c.id = $1
        returning c.id, c.aircraft_id, c.author_id, n.author_name, c.body, c.created_at, c.edited_at, c.deleted_at`,
      [id, user.id, current.author_name],
    );
    await audit(client, user, 'delete', aircraftId, tail);
    await client.query('commit');
    return toComment(rows[0]);
  } catch (e) {
    await client.query('rollback').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

/** Marks the aircraft's comments read up to one. Never backwards, never past what exists there. */
export async function markCommentsRead(user: SessionUser, aircraftId: string, body: unknown): Promise<{ lastReadCommentId: number }> {
  const upTo = Number((body as { commentId?: unknown })?.commentId);
  if (!Number.isSafeInteger(upTo) || upTo < 0) throw new HttpError(400, 'Bad comment id');
  await aircraftTail(aircraftId);
  const { rows } = await getPool().query<{ n: string }>(
    `insert into app_aircraft_comment_read (user_id, aircraft_id, last_read_comment_id)
     values ($1, $2, least($3, (select coalesce(max(id), 0) from app_aircraft_comment where aircraft_id = $2)))
     on conflict (user_id, aircraft_id) do update
       set last_read_comment_id = greatest(app_aircraft_comment_read.last_read_comment_id, excluded.last_read_comment_id)
     returning last_read_comment_id as n`,
    [user.id, aircraftId, upTo],
  );
  return { lastReadCommentId: Number(rows[0].n) };
}

export async function setWatching(user: SessionUser, aircraftId: string, body: unknown): Promise<{ watching: boolean }> {
  const watching = (body as { watching?: unknown })?.watching;
  if (typeof watching !== 'boolean') throw new HttpError(400, 'Say whether to watch');
  await aircraftTail(aircraftId);
  await getPool().query(
    `insert into app_aircraft_watch (user_id, aircraft_id, watching) values ($1, $2, $3)
     on conflict (user_id, aircraft_id) do update set watching = excluded.watching, updated_at = now()`,
    [user.id, aircraftId, watching],
  );
  return { watching };
}
