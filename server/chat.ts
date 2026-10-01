/**
 * Chat: one-to-one conversations and named groups between people on the
 * account.
 *
 * Every read and write starts from membership(): a conversation someone is
 * not a current member of answers exactly as one that does not exist, so an
 * id guessed or copied from elsewhere tells them nothing. Nothing the browser
 * sends about who may see what is ever used — only the signed-in session.
 *
 * Messages cannot be edited or deleted: chat is a record of what was said.
 *
 * Group history is shared with whoever is currently in the group, on
 * purpose. Someone added to a group sees all of its messages, including those
 * sent before they joined; someone who leaves loses access to all of them,
 * and if added back sees the whole history again. It is the team's internal
 * chat, and the history is the context a newcomer needs. Visibility is never
 * worked out message by message from when someone joined — see
 * listMessages().
 */
import { randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { SessionUser } from './auth.js';
import { ensureAppSchema, getPool } from './db.js';
import { HttpError } from './http.js';
import { notify, type NotifyResult } from './notify.js';
import { isAdmin } from '../src/lib/roles.js';

export const MAX_MESSAGE_CHARS = 5000;
export const MAX_GROUP_NAME = 80;
export const MAX_GROUP_MEMBERS = 50;
export const MESSAGE_PAGE = 50;

const NOT_FOUND = 'No such conversation';

export interface Member {
  id: string;
  name: string;
  /** False when their access is off; they stay listed on what they wrote. */
  active: boolean;
}

export interface MessageOut {
  id: number;
  conversationId: string;
  senderId: string;
  senderName: string;
  body: string;
  clientId: string;
  createdAt: string;
}

export interface ConversationOut {
  id: string;
  kind: 'direct' | 'group';
  /** The group's name; for a direct conversation, the other person's. */
  title: string;
  name: string | null;
  createdBy: string;
  members: Member[];
  lastMessage: { id: number; senderId: string; senderName: string; preview: string; createdAt: string } | null;
  unread: number;
  lastReadMessageId: number;
}

function newConversationId(): string {
  return `cv_${randomBytes(12).toString('base64url')}`;
}

function cleanBody(value: unknown): string {
  if (typeof value !== 'string') throw new HttpError(400, 'Write a message first');
  // Trailing space and blank lines are dropped; the lines in between are kept.
  const body = value.replace(/\r\n?/g, '\n').replace(/^\s*\n|\s+$/g, '');
  if (!body.trim()) throw new HttpError(400, 'Write a message first');
  if (body.length > MAX_MESSAGE_CHARS) throw new HttpError(400, `Keep it under ${MAX_MESSAGE_CHARS} characters`);
  return body;
}

function cleanClientId(value: unknown): string {
  if (typeof value === 'string' && /^[A-Za-z0-9_-]{6,64}$/.test(value)) return value;
  if (value === undefined) return randomBytes(9).toString('base64url');
  throw new HttpError(400, 'Bad client id');
}

function cleanName(value: unknown): string {
  const name = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  if (!name) throw new HttpError(400, 'Give the group a name');
  if (name.length > MAX_GROUP_NAME) throw new HttpError(400, `Keep the name under ${MAX_GROUP_NAME} characters`);
  return name;
}

function idList(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string' || !v || v.length > 200)) {
    throw new HttpError(400, 'Choose people from the team');
  }
  return [...new Set(value as string[])];
}

/** People who exist and whose access is on. Anyone else in the list is refused by name-free error. */
async function activePeople(db: PoolClient | ReturnType<typeof getPool>, ids: string[]): Promise<Map<string, string>> {
  if (!ids.length) return new Map();
  const { rows } = await db.query<{ id: string; name: string }>(
    `select id, name from "user" where id = any($1::text[]) and not coalesce(banned, false)`,
    [ids],
  );
  if (rows.length !== ids.length) throw new HttpError(400, 'Someone chosen is not on the team, or their access is off');
  return new Map(rows.map((r) => [r.id, r.name]));
}

/**
 * The gate every conversation route goes through. Throws 404 unless the
 * signed-in person is a current member.
 */
export async function membership(user: SessionUser, conversationId: string): Promise<{
  kind: 'direct' | 'group'; createdBy: string; lastRead: number;
}> {
  if (typeof conversationId !== 'string' || !conversationId || conversationId.length > 100) throw new HttpError(404, NOT_FOUND);
  await ensureAppSchema();
  const { rows } = await getPool().query<{ kind: 'direct' | 'group'; created_by: string; last_read_message_id: string }>(
    `select c.kind, c.created_by, m.last_read_message_id from app_conversation c
       join app_conversation_member m on m.conversation_id = c.id and m.user_id = $2 and m.left_at is null
      where c.id = $1`,
    [conversationId, user.id],
  );
  if (!rows[0]) throw new HttpError(404, NOT_FOUND);
  return { kind: rows[0].kind, createdBy: rows[0].created_by, lastRead: Number(rows[0].last_read_message_id) };
}

/** The signed-in person's conversations, most recent first. */
export async function listConversations(user: SessionUser, only?: string): Promise<ConversationOut[]> {
  await ensureAppSchema();
  const { rows } = await getPool().query<{
    id: string; kind: 'direct' | 'group'; name: string | null; created_by: string; created_at: Date;
    last_read_message_id: string;
    members: { id: string; name: string; active: boolean }[];
    last_id: string | null; last_sender: string | null; last_sender_name: string | null; last_body: string | null; last_at: Date | null;
    unread: number;
  }>(
    `select c.id, c.kind, c.name, c.created_by, c.created_at, me.last_read_message_id,
            (select json_agg(json_build_object('id', u.id, 'name', u.name, 'active', not coalesce(u.banned, false)) order by u.name)
               from app_conversation_member x join "user" u on u.id = x.user_id
              where x.conversation_id = c.id and x.left_at is null) as members,
            last.id as last_id, last.sender_id as last_sender, lu.name as last_sender_name,
            left(last.body, 140) as last_body, last.created_at as last_at,
            (select count(*)::int from app_message um
              where um.conversation_id = c.id and um.id > me.last_read_message_id and um.sender_id <> $1) as unread
       from app_conversation_member me
       join app_conversation c on c.id = me.conversation_id
       left join lateral (
         select id, sender_id, body, created_at from app_message
          where conversation_id = c.id order by id desc limit 1
       ) last on true
       left join "user" lu on lu.id = last.sender_id
      where me.user_id = $1 and me.left_at is null and ($2::text is null or c.id = $2)
      order by coalesce(last.created_at, c.created_at) desc`,
    [user.id, only ?? null],
  );
  return rows.map((r) => {
    const members = r.members ?? [];
    const others = members.filter((m) => m.id !== user.id);
    const title = r.kind === 'group'
      ? r.name ?? 'Group'
      : others[0]?.name ?? 'Conversation';
    return {
      id: r.id,
      kind: r.kind,
      title,
      name: r.name,
      createdBy: r.created_by,
      members,
      lastMessage: r.last_id
        ? {
          id: Number(r.last_id),
          senderId: r.last_sender!,
          senderName: r.last_sender_name ?? 'Someone',
          preview: (r.last_body ?? '').replace(/\s+/g, ' ').trim(),
          createdAt: r.last_at!.toISOString(),
        }
        : null,
      unread: r.unread,
      lastReadMessageId: Number(r.last_read_message_id),
    };
  });
}

export async function getConversation(user: SessionUser, conversationId: string): Promise<ConversationOut> {
  await membership(user, conversationId);
  const [conversation] = await listConversations(user, conversationId);
  if (!conversation) throw new HttpError(404, NOT_FOUND);
  return conversation;
}

/**
 * Starts a conversation. A direct one with someone you already have one with
 * is the same conversation, whoever started it and however many times.
 */
export async function createConversation(user: SessionUser, body: unknown): Promise<ConversationOut> {
  const input = body as { kind?: unknown; userId?: unknown; name?: unknown; memberIds?: unknown };
  await ensureAppSchema();
  if (input?.kind === 'direct') {
    const other = input.userId;
    if (typeof other !== 'string' || !other) throw new HttpError(400, 'Choose who to message');
    if (other === user.id) throw new HttpError(400, 'Choose someone other than yourself');
    await activePeople(getPool(), [other]);
    const key = [user.id, other].sort().join(':');
    const client = await getPool().connect();
    try {
      await client.query('begin');
      const created = await client.query<{ id: string }>(
        `insert into app_conversation (id, kind, direct_key, created_by) values ($1, 'direct', $2, $3)
         on conflict (direct_key) do nothing returning id`,
        [newConversationId(), key, user.id],
      );
      const id = created.rows[0]?.id
        ?? (await client.query<{ id: string }>('select id from app_conversation where direct_key = $1', [key])).rows[0].id;
      // Both are members again, even if one had somehow left.
      await client.query(
        `insert into app_conversation_member (conversation_id, user_id) values ($1, $2), ($1, $3)
         on conflict (conversation_id, user_id) do update set left_at = null`,
        [id, user.id, other],
      );
      await client.query('commit');
      return getConversation(user, id);
    } catch (e) {
      await client.query('rollback').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  if (input?.kind === 'group') {
    const name = cleanName(input.name);
    const others = idList(input.memberIds).filter((id) => id !== user.id);
    if (!others.length) throw new HttpError(400, 'Add at least one other person');
    if (others.length + 1 > MAX_GROUP_MEMBERS) throw new HttpError(400, `A group can have up to ${MAX_GROUP_MEMBERS} people`);
    const client = await getPool().connect();
    try {
      await client.query('begin');
      await activePeople(client, others);
      const id = newConversationId();
      await client.query(
        `insert into app_conversation (id, kind, name, created_by) values ($1, 'group', $2, $3)`,
        [id, name, user.id],
      );
      await client.query(
        `insert into app_conversation_member (conversation_id, user_id) select $1, unnest($2::text[])`,
        [id, [user.id, ...others]],
      );
      await audit(client, user, 'create', id, `created a group with ${others.length + 1} people`);
      await client.query('commit');
      return getConversation(user, id);
    } catch (e) {
      await client.query('rollback').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }
  throw new HttpError(400, 'Say whether this is a direct conversation or a group');
}

/**
 * Group changes go in the administrative audit log — who changed which group
 * and how — but never its messages, and not its name: the log is not a
 * second copy of anyone's conversations. Left out of the team's activity
 * history (see history() in sync.ts).
 */
async function audit(client: PoolClient, user: SessionUser, action: 'create' | 'update' | 'delete', conversationId: string, summary: string) {
  await client.query(
    `insert into app_audit (user_id, user_name, action, collection, record_id, summary)
     values ($1, $2, $3, 'chat', $4, $5)`,
    [user.id, user.name, action, conversationId, summary],
  );
}

function toMessage(r: {
  id: string; conversation_id: string; sender_id: string; sender_name: string | null; body: string; client_id: string; created_at: Date;
}): MessageOut {
  return {
    id: Number(r.id),
    conversationId: r.conversation_id,
    senderId: r.sender_id,
    senderName: r.sender_name ?? 'Someone',
    body: r.body,
    clientId: r.client_id,
    createdAt: r.created_at.toISOString(),
  };
}

/**
 * A page of messages, oldest first. `before` pages back through history;
 * `after` fetches what arrived since the newest one on screen.
 *
 * Every message in the conversation, for any current member: joined_at is
 * deliberately not used here (see the note at the top of this file).
 */
export async function listMessages(user: SessionUser, conversationId: string, query: URLSearchParams): Promise<{
  messages: MessageOut[]; more: boolean;
}> {
  await membership(user, conversationId);
  const num = (key: string) => {
    const raw = query.get(key);
    if (raw === null) return null;
    const n = Number(raw);
    if (!Number.isSafeInteger(n) || n < 0) throw new HttpError(400, 'Bad cursor');
    return n;
  };
  const before = num('before');
  const after = num('after');
  const newestFirst = after === null;
  const { rows } = await getPool().query(
    `select m.id, m.conversation_id, m.sender_id, u.name as sender_name, m.body, m.client_id, m.created_at
       from app_message m left join "user" u on u.id = m.sender_id
      where m.conversation_id = $1
        and ($2::bigint is null or m.id < $2)
        and ($3::bigint is null or m.id > $3)
      order by m.id ${newestFirst ? 'desc' : 'asc'}
      limit $4`,
    [conversationId, before, after, MESSAGE_PAGE + 1],
  );
  const more = rows.length > MESSAGE_PAGE;
  const page = rows.slice(0, MESSAGE_PAGE).map(toMessage);
  return { messages: newestFirst ? page.reverse() : page, more };
}

export async function sendMessage(user: SessionUser, conversationId: string, body: unknown): Promise<{
  message: MessageOut; notified: NotifyResult[];
}> {
  const input = body as { body?: unknown; clientId?: unknown };
  const text = cleanBody(input?.body);
  const clientId = cleanClientId(input?.clientId);
  const { kind } = await membership(user, conversationId);
  if (kind === 'direct') {
    const { rows } = await getPool().query(
      `select 1 from app_conversation_member m join "user" u on u.id = m.user_id
        where m.conversation_id = $1 and m.user_id <> $2 and not coalesce(u.banned, false)`,
      [conversationId, user.id],
    );
    if (!rows.length) throw new HttpError(409, 'Their access to AEROBOOK is off, so they cannot read new messages');
  }

  const client = await getPool().connect();
  let row;
  let created = false;
  try {
    await client.query('begin');
    // One writer per conversation at a time, so ids are handed out in the
    // order messages are committed and "everything after id N" never skips one.
    await client.query('select pg_advisory_xact_lock(4217010, hashtext($1))', [conversationId]);
    const inserted = await client.query(
      `insert into app_message (conversation_id, sender_id, body, client_id) values ($1, $2, $3, $4)
       on conflict (conversation_id, sender_id, client_id) do nothing
       returning id, conversation_id, sender_id, $5::text as sender_name, body, client_id, created_at`,
      [conversationId, user.id, text, clientId, user.name],
    );
    if (inserted.rows[0]) {
      created = true;
      row = inserted.rows[0];
      await client.query('update app_conversation set last_message_at = $2 where id = $1', [conversationId, row.created_at]);
      // What you send, you have read.
      await client.query(
        `update app_conversation_member set last_read_message_id = greatest(last_read_message_id, $3)
          where conversation_id = $1 and user_id = $2`,
        [conversationId, user.id, row.id],
      );
    } else {
      row = (await client.query(
        `select m.id, m.conversation_id, m.sender_id, u.name as sender_name, m.body, m.client_id, m.created_at
           from app_message m left join "user" u on u.id = m.sender_id
          where m.conversation_id = $1 and m.sender_id = $2 and m.client_id = $3`,
        [conversationId, user.id, clientId],
      )).rows[0];
    }
    await client.query('commit');
  } catch (e) {
    await client.query('rollback').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }

  const message = toMessage(row);
  // A retried send was announced the first time.
  const notified = created
    ? await notify({ kind: 'message', sourceId: message.id, conversationId, actor: { id: user.id, name: user.name } })
    : [];
  return { message, notified };
}

/** Marks read up to a message. Never moves backwards, and never past what exists. */
export async function markRead(user: SessionUser, conversationId: string, body: unknown): Promise<{ lastReadMessageId: number }> {
  const raw = (body as { messageId?: unknown })?.messageId;
  const messageId = Number(raw);
  if (!Number.isSafeInteger(messageId) || messageId < 0) throw new HttpError(400, 'Bad message id');
  await membership(user, conversationId);
  const { rows } = await getPool().query<{ last_read_message_id: string }>(
    `update app_conversation_member
        set last_read_message_id = greatest(last_read_message_id,
          least($3, (select coalesce(max(id), 0) from app_message where conversation_id = $1)))
      where conversation_id = $1 and user_id = $2
      returning last_read_message_id`,
    [conversationId, user.id, messageId],
  );
  return { lastReadMessageId: Number(rows[0].last_read_message_id) };
}

async function requireGroup(user: SessionUser, conversationId: string) {
  const member = await membership(user, conversationId);
  if (member.kind !== 'group') throw new HttpError(400, 'Only a group can be changed');
  return member;
}

export async function renameGroup(user: SessionUser, conversationId: string, body: unknown): Promise<ConversationOut> {
  await requireGroup(user, conversationId);
  const name = cleanName((body as { name?: unknown })?.name);
  const client = await getPool().connect();
  try {
    await client.query('begin');
    await client.query('update app_conversation set name = $2 where id = $1', [conversationId, name]);
    await audit(client, user, 'update', conversationId, 'renamed the group');
    await client.query('commit');
  } catch (e) {
    await client.query('rollback').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
  return getConversation(user, conversationId);
}

/**
 * Any member may add people. They can read the group's whole history,
 * earlier messages included; someone added back after leaving can read all
 * of it again. Either way they start with nothing unread: their read marker
 * begins at the group's latest message.
 */
export async function addMembers(user: SessionUser, conversationId: string, body: unknown): Promise<ConversationOut> {
  await requireGroup(user, conversationId);
  const ids = idList((body as { userIds?: unknown })?.userIds).filter((id) => id !== user.id);
  if (!ids.length) throw new HttpError(400, 'Choose someone to add');
  const client = await getPool().connect();
  try {
    await client.query('begin');
    await activePeople(client, ids);
    const { rows } = await client.query<{ n: number }>(
      `select count(*)::int as n from app_conversation_member
        where conversation_id = $1 and left_at is null and not (user_id = any($2::text[]))`,
      [conversationId, ids],
    );
    if (rows[0].n + ids.length > MAX_GROUP_MEMBERS) throw new HttpError(400, `A group can have up to ${MAX_GROUP_MEMBERS} people`);
    const latest = await client.query<{ n: string }>(
      'select coalesce(max(id), 0) as n from app_message where conversation_id = $1',
      [conversationId],
    );
    const added = await client.query(
      `insert into app_conversation_member (conversation_id, user_id, last_read_message_id)
       select $1, unnest($2::text[]), $3
       on conflict (conversation_id, user_id) do update
         set left_at = null, joined_at = now(), last_read_message_id = greatest(app_conversation_member.last_read_message_id, excluded.last_read_message_id)
         where app_conversation_member.left_at is not null`,
      [conversationId, ids, Number(latest.rows[0].n)],
    );
    if (added.rowCount) await audit(client, user, 'update', conversationId, `added ${added.rowCount} ${added.rowCount === 1 ? 'person' : 'people'}`);
    await client.query('commit');
  } catch (e) {
    await client.query('rollback').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
  return getConversation(user, conversationId);
}

/**
 * Leaving (yourself) or removing someone (whoever made the group, or an
 * admin). Either way they lose access; what they wrote stays in the group.
 */
export async function removeMember(user: SessionUser, conversationId: string, body: unknown): Promise<{ ok: true }> {
  const group = await requireGroup(user, conversationId);
  const target = (body as { userId?: unknown })?.userId ?? user.id;
  if (typeof target !== 'string' || !target) throw new HttpError(400, 'Say who');
  if (target !== user.id && group.createdBy !== user.id && !isAdmin(user)) {
    throw new HttpError(403, 'Only whoever made the group, or an admin, can remove someone');
  }
  const client = await getPool().connect();
  try {
    await client.query('begin');
    const { rowCount } = await client.query(
      `update app_conversation_member set left_at = now()
        where conversation_id = $1 and user_id = $2 and left_at is null`,
      [conversationId, target],
    );
    if (!rowCount) throw new HttpError(404, 'They are not in this group');
    await audit(client, user, 'delete', conversationId, target === user.id ? 'left the group' : 'removed someone from the group');
    await client.query('commit');
  } catch (e) {
    await client.query('rollback').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
  return { ok: true };
}
