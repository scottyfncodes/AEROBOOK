/**
 * The one notification layer, shared by chat and aircraft comments.
 *
 * Something happens (a message, a comment); notify() works out who should
 * hear about it, records one app_notification row for each of them — which
 * the in-app pop-up reads — and decides, person by person, whether their
 * devices should also get a push:
 *
 *   - not while they have AEROBOOK open and in use on any device (they see
 *     the pop-up instead);
 *   - not again for the same conversation or aircraft within two minutes of
 *     the last one, while they still have not opened it (the next one, when
 *     it comes, says how many are waiting);
 *   - never to someone whose access is off.
 *
 * None of this touches unread counts, which come from what each person has
 * read, so holding back a push never hides a message.
 *
 * Email would be one more way to deliver the same decision; see deliver().
 */
import { createHash } from 'node:crypto';
import { ensureAppSchema, getPool } from './db.js';
import { pushConfig, pushToUser, type PushPayload } from './push.js';

/** How long a device counts as "looking at the app" after it last said so. */
export const PRESENCE_SECONDS = 45;
/** How long after a push the same thread stays quiet while it is unread. */
export const GROUP_SECONDS = 120;

export interface Actor {
  id: string;
  name: string;
}

export type NotifyEvent =
  | { kind: 'message'; sourceId: number; conversationId: string; actor: Actor }
  | { kind: 'comment'; sourceId: number; aircraftId: string; tail: string; actor: Actor };

export type PushStatus = 'sent' | 'present' | 'grouped' | 'no-device' | 'off' | 'failed';

export interface NotifyResult {
  userId: string;
  status: PushStatus;
}

export function threadOf(event: NotifyEvent): string {
  return event.kind === 'message' ? `conv:${event.conversationId}` : `aircraft:${event.aircraftId}`;
}

/** Where a notification about this thread opens. */
export function linkFor(thread: string): string {
  if (thread.startsWith('conv:')) return `/chat/${encodeURIComponent(thread.slice(5))}`;
  if (thread.startsWith('aircraft:')) return `/aircraft/${encodeURIComponent(thread.slice(9))}#comments`;
  return '/';
}

/** The push service's collapse key: short, and safe to send. */
export function topicFor(thread: string): string {
  return createHash('sha256').update(thread).digest('base64url').slice(0, 32);
}

function tidy(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * The words on the lock screen. Who, and about what — never what was said:
 * messages and comments carry client, insurance and money details that do
 * not belong on a lock screen.
 */
export function describePush(input: {
  kind: 'message' | 'comment';
  actorName: string;
  unread: number;
  groupName?: string | null;
  tail?: string;
}): { title: string; body: string } {
  const who = tidy(input.actorName, 40) || 'someone';
  const many = input.unread > 1;
  if (input.kind === 'comment') {
    const tail = tidy(input.tail ?? '', 20) || 'an aircraft';
    return {
      title: 'AEROBOOK',
      body: many ? `${input.unread} new comments on ${tail} · latest from ${who}` : `New comment on ${tail} from ${who}`,
    };
  }
  const where = input.groupName ? ` in ${tidy(input.groupName, 40)}` : '';
  return {
    title: 'AEROBOOK',
    body: many ? `${input.unread} new messages${where} · latest from ${who}` : `New message${where} from ${who}`,
  };
}

/** The people who should hear about this: never the author, never anyone whose access is off. */
export async function recipients(event: NotifyEvent): Promise<string[]> {
  const { rows } = event.kind === 'message'
    ? await getPool().query<{ user_id: string }>(
      `select m.user_id from app_conversation_member m join "user" u on u.id = m.user_id
        where m.conversation_id = $1 and m.left_at is null and m.user_id <> $2 and not coalesce(u.banned, false)
        order by m.user_id`,
      [event.conversationId, event.actor.id],
    )
    : await getPool().query<{ user_id: string }>(
      `select w.user_id from app_aircraft_watch w join "user" u on u.id = w.user_id
        where w.aircraft_id = $1 and w.watching and w.user_id <> $2 and not coalesce(u.banned, false)
        order by w.user_id`,
      [event.aircraftId, event.actor.id],
    );
  return rows.map((r) => r.user_id);
}

/** How many of this thread's messages or comments someone has not read, not counting their own. */
export async function unreadIn(userId: string, thread: string): Promise<number> {
  if (thread.startsWith('conv:')) {
    const { rows } = await getPool().query<{ n: number }>(
      `select count(*)::int as n from app_message msg
         join app_conversation_member m on m.conversation_id = msg.conversation_id and m.user_id = $1
        where msg.conversation_id = $2 and msg.id > m.last_read_message_id and msg.sender_id <> $1`,
      [userId, thread.slice(5)],
    );
    return rows[0]?.n ?? 0;
  }
  const { rows } = await getPool().query<{ n: number }>(
    `select count(*)::int as n from app_aircraft_comment c
       left join app_aircraft_comment_read r on r.user_id = $1 and r.aircraft_id = c.aircraft_id
      where c.aircraft_id = $2 and c.deleted_at is null and c.author_id <> $1
        and c.id > coalesce(r.last_read_comment_id, 0)`,
    [userId, thread.slice(9)],
  );
  return rows[0]?.n ?? 0;
}

async function lastRead(userId: string, thread: string): Promise<number> {
  const { rows } = thread.startsWith('conv:')
    ? await getPool().query<{ n: string }>(
      'select last_read_message_id as n from app_conversation_member where user_id = $1 and conversation_id = $2',
      [userId, thread.slice(5)],
    )
    : await getPool().query<{ n: string }>(
      'select last_read_comment_id as n from app_aircraft_comment_read where user_id = $1 and aircraft_id = $2',
      [userId, thread.slice(9)],
    );
  return Number(rows[0]?.n ?? 0);
}

/**
 * Records the notification for one person and decides whether to push it.
 * One person and thread at a time (the advisory lock), so two messages
 * arriving together cannot both decide they are the first.
 */
async function decide(userId: string, event: NotifyEvent, thread: string): Promise<{ id: number; status: PushStatus | 'push' } | null> {
  const read = await lastRead(userId, thread);
  const client = await getPool().connect();
  try {
    await client.query('begin');
    await client.query('select pg_advisory_xact_lock(hashtext($1), hashtext($2))', [userId, thread]);
    const inserted = await client.query<{ id: string }>(
      `insert into app_notification (user_id, kind, thread, source_id, actor_id)
       values ($1, $2, $3, $4, $5)
       on conflict (user_id, kind, source_id) do nothing
       returning id`,
      [userId, event.kind, thread, event.sourceId, event.actor.id],
    );
    if (!inserted.rows[0]) {
      await client.query('rollback');
      return null; // already announced
    }
    const id = Number(inserted.rows[0].id);

    let status: PushStatus | 'push' = 'push';
    const present = await client.query(
      `select 1 from app_presence where user_id = $1 and seen_at > now() - make_interval(secs => $2) limit 1`,
      [userId, PRESENCE_SECONDS],
    );
    if (present.rows.length) status = 'present';
    else if (!pushConfig()) status = 'off';
    else {
      const devices = await client.query('select 1 from app_push_subscription where user_id = $1 limit 1', [userId]);
      if (!devices.rows.length) status = 'no-device';
      else {
        const recent = await client.query(
          `select 1 from app_notification
            where user_id = $1 and thread = $2 and id <> $3 and push_status = 'sent'
              and source_id > $4 and created_at > now() - make_interval(secs => $5)
            limit 1`,
          [userId, thread, id, read, GROUP_SECONDS],
        );
        if (recent.rows.length) status = 'grouped';
      }
    }
    // 'sent' is claimed before sending, so a message right behind this one
    // sees it and waits its turn rather than sending a second alert.
    await client.query('update app_notification set push_status = $2 where id = $1', [id, status === 'push' ? 'sent' : status]);
    await client.query('commit');
    return { id, status };
  } catch (e) {
    await client.query('rollback').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

async function payloadFor(userId: string, event: NotifyEvent, thread: string): Promise<PushPayload> {
  const unread = await unreadIn(userId, thread);
  let groupName: string | null = null;
  if (event.kind === 'message') {
    const { rows } = await getPool().query<{ kind: string; name: string | null }>(
      'select kind, name from app_conversation where id = $1',
      [event.conversationId],
    );
    if (rows[0]?.kind === 'group') groupName = rows[0].name || 'a group';
  }
  const words = describePush({
    kind: event.kind,
    actorName: event.actor.name,
    unread: Math.max(unread, 1),
    groupName,
    tail: event.kind === 'comment' ? event.tail : undefined,
  });
  return { ...words, url: linkFor(thread), tag: thread };
}

/** Sends to someone's devices; the one place a new way of delivering would go. */
async function deliver(userId: string, event: NotifyEvent, thread: string, notificationId: number): Promise<PushStatus> {
  const { sent } = await pushToUser(userId, await payloadFor(userId, event, thread), topicFor(thread));
  if (sent > 0) return 'sent';
  await getPool().query(`update app_notification set push_status = 'failed' where id = $1`, [notificationId]);
  return 'failed';
}

/**
 * Called after the message or comment is saved. A failure here is logged,
 * never passed on: the message is already delivered and counted as unread.
 */
export async function notify(event: NotifyEvent): Promise<NotifyResult[]> {
  const thread = threadOf(event);
  try {
    const people = await recipients(event);
    return (await Promise.all(people.map(async (userId): Promise<NotifyResult | null> => {
      const decision = await decide(userId, event, thread);
      if (!decision) return null;
      const status = decision.status === 'push' ? await deliver(userId, event, thread, decision.id) : decision.status;
      return { userId, status };
    }))).filter((r): r is NotifyResult => r !== null);
  } catch (e) {
    console.error('notify failed', e);
    return [];
  }
}

// ------------------------------------------------------------- presence

const DEVICE = /^[A-Za-z0-9_-]{8,64}$/;

export function isView(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 220
    && (value === 'app' || /^conv:\S+$/.test(value) || /^aircraft:\S+$/.test(value));
}

/**
 * A device saying it has the app open and in use (view is where), or that
 * it no longer does (view null). Written at most every ten seconds per
 * device unless the place changes.
 */
export async function recordPresence(userId: string, deviceId: unknown, view: unknown): Promise<void> {
  if (typeof deviceId !== 'string' || !DEVICE.test(deviceId)) return;
  if (view === null) {
    await getPool().query('delete from app_presence where user_id = $1 and device_id = $2', [userId, deviceId]);
    return;
  }
  if (!isView(view)) return;
  await getPool().query(
    `insert into app_presence (user_id, device_id, view) values ($1, $2, $3)
     on conflict (user_id, device_id) do update set view = excluded.view, seen_at = now()
       where app_presence.view is distinct from excluded.view or app_presence.seen_at < now() - interval '10 seconds'`,
    [userId, deviceId, view],
  );
}

/** For the maintenance run: old notifications and devices long gone quiet. */
export async function pruneNotifications(): Promise<{ notifications: number; presence: number }> {
  await ensureAppSchema();
  const n = await getPool().query(`delete from app_notification where created_at < now() - interval '60 days'`);
  const p = await getPool().query(`delete from app_presence where seen_at < now() - interval '1 day'`);
  return { notifications: n.rowCount ?? 0, presence: p.rowCount ?? 0 };
}
