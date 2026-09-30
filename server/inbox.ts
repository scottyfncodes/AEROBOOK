/**
 * What the app asks every few seconds while it is open: unread counts for
 * the badges, the newest message id in each conversation (so an open one
 * knows to fetch), and notifications since the last ask (for the pop-up).
 * The same call tells the server this device is in use, and where, so no
 * push is sent about something the person is already looking at.
 *
 * Polling, rather than a socket, because the API is a Vercel Function: it
 * cannot hold a connection open, and at a few people a few small queries
 * every few seconds cost nothing worth a realtime service.
 */
import type { SessionUser } from './auth.js';
import { ensureAppSchema, getPool } from './db.js';
import { HttpError } from './http.js';
import { describePush, linkFor, recordPresence } from './notify.js';

export interface InboxEvent {
  id: number;
  kind: 'message' | 'comment';
  thread: string;
  url: string;
  text: string;
  actorId: string | null;
  createdAt: string;
}

export interface Inbox {
  conversations: { id: string; latestMessageId: number; unread: number }[];
  chatUnread: number;
  aircraftUnread: Record<string, number>;
  events: InboxEvent[];
  /** Pass back as `since`; notifications up to here have been handed over. */
  cursor: number;
}

const EVENT_PAGE = 20;

export async function inbox(user: SessionUser, body: unknown): Promise<Inbox> {
  const input = (body ?? {}) as { deviceId?: unknown; view?: unknown; since?: unknown };
  const since = input.since === null || input.since === undefined ? null : Number(input.since);
  if (since !== null && (!Number.isSafeInteger(since) || since < 0)) throw new HttpError(400, 'Bad cursor');
  await ensureAppSchema();
  await recordPresence(user.id, input.deviceId, input.view ?? null);

  const [conversations, aircraft, latest] = await Promise.all([
    getPool().query<{ id: string; latest: string | null; unread: number }>(
      `select m.conversation_id as id,
              (select max(id) from app_message x where x.conversation_id = m.conversation_id) as latest,
              (select count(*)::int from app_message x
                where x.conversation_id = m.conversation_id and x.id > m.last_read_message_id and x.sender_id <> $1) as unread
         from app_conversation_member m
        where m.user_id = $1 and m.left_at is null`,
      [user.id],
    ),
    getPool().query<{ aircraft_id: string; n: number }>(
      `select c.aircraft_id, count(*)::int as n from app_aircraft_comment c
         join app_record a on a.collection = 'aircraft' and a.id = c.aircraft_id and a.data is not null
         left join app_aircraft_comment_read r on r.user_id = $1 and r.aircraft_id = c.aircraft_id
        where c.deleted_at is null and c.author_id <> $1 and c.id > coalesce(r.last_read_comment_id, 0)
        group by c.aircraft_id`,
      [user.id],
    ),
    getPool().query<{ n: string | null }>('select max(id) as n from app_notification where user_id = $1', [user.id]),
  ]);

  const cursor = Number(latest.rows[0]?.n ?? 0);
  // A device that has only just opened is told where things stand, not
  // shown a pop-up for everything that happened while it was closed.
  const events = since === null ? [] : await eventsSince(user, since);

  return {
    conversations: conversations.rows.map((r) => ({ id: r.id, latestMessageId: Number(r.latest ?? 0), unread: r.unread })),
    chatUnread: conversations.rows.reduce((n, r) => n + r.unread, 0),
    aircraftUnread: Object.fromEntries(aircraft.rows.map((r) => [r.aircraft_id, r.n])),
    events,
    cursor: Math.max(cursor, since ?? 0),
  };
}

/** Notifications after a cursor, for threads the person can still open. */
async function eventsSince(user: SessionUser, since: number): Promise<InboxEvent[]> {
  const { rows } = await getPool().query<{
    id: string; kind: 'message' | 'comment'; thread: string; actor_id: string | null; actor_name: string | null;
    created_at: Date; conv_kind: string | null; conv_name: string | null; tail: string | null;
  }>(
    `select n.id, n.kind, n.thread, n.actor_id, u.name as actor_name, n.created_at,
            c.kind as conv_kind, c.name as conv_name, a.data->>'tailNumber' as tail
       from app_notification n
       left join "user" u on u.id = n.actor_id
       left join app_conversation c on n.kind = 'message' and c.id = substr(n.thread, 6)
       left join app_conversation_member m on m.conversation_id = c.id and m.user_id = n.user_id
       left join app_record a on n.kind = 'comment' and a.collection = 'aircraft' and a.id = substr(n.thread, 10)
      where n.user_id = $1 and n.id > $2
        and ((n.kind = 'message' and m.left_at is null and m.user_id is not null)
          or (n.kind = 'comment' and a.data is not null))
      order by n.id
      limit $3`,
    [user.id, since, EVENT_PAGE],
  );
  return rows.map((r) => ({
    id: Number(r.id),
    kind: r.kind,
    thread: r.thread,
    url: linkFor(r.thread),
    text: describePush({
      kind: r.kind,
      actorName: r.actor_name ?? 'Someone',
      unread: 1,
      groupName: r.conv_kind === 'group' ? r.conv_name || 'a group' : null,
      tail: r.tail ?? undefined,
    }).body,
    actorId: r.actor_id,
    createdAt: r.created_at.toISOString(),
  }));
}
