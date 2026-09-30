/**
 * Web push: the notification that reaches a phone or computer when AEROBOOK
 * is not open. Sent with the standard Web Push protocol and VAPID keys, to
 * whichever push service the browser uses (Apple's, Google's, Mozilla's,
 * Microsoft's) — no service of our own in between.
 *
 * Without VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT on the
 * deployment, push is off: nothing is sent and the app says so. Everything
 * else — chat, comments, the in-app pop-ups — works the same.
 */
import { parse as parseUrl } from 'node:url';
import webpush from 'web-push';
import { ensureAppSchema, getPool } from './db.js';
import { HttpError } from './http.js';

export interface PushConfig {
  publicKey: string;
  privateKey: string;
  subject: string;
}

export function pushConfig(): PushConfig | null {
  const publicKey = process.env.VAPID_PUBLIC_KEY?.trim();
  const privateKey = process.env.VAPID_PRIVATE_KEY?.trim();
  const subject = process.env.VAPID_SUBJECT?.trim();
  if (!publicKey || !privateKey || !subject) return null;
  return { publicKey, privateKey, subject };
}

/** What a notification says. Never the words of the message or comment. */
export interface PushPayload {
  title: string;
  body: string;
  /** Where tapping it opens, a path inside the app. */
  url: string;
  /** One per conversation or aircraft: a newer notification replaces the older. */
  tag: string;
}

export interface StoredSubscription {
  id: number;
  endpoint: string;
  p256dh: string;
  auth: string;
}

/** 'gone' means the browser dropped the subscription and it should be forgotten. */
export type PushOutcome = 'sent' | 'gone' | 'failed';

export type PushSender = (subscription: StoredSubscription, payload: PushPayload, topic: string) => Promise<PushOutcome>;

const webPushSender: PushSender = async (subscription, payload, topic) => {
  const config = pushConfig();
  if (!config) return 'failed';
  // Checked again here, at the point of sending: a stored endpoint that does
  // not pass today's rules is forgotten rather than connected to.
  if (!isPushEndpoint(subscription.endpoint)) return 'gone';
  try {
    await webpush.sendNotification(
      { endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } },
      JSON.stringify(payload),
      {
        vapidDetails: config,
        // A day: a phone that was off overnight still hears about it.
        TTL: 60 * 60 * 24,
        urgency: 'high',
        // The push service keeps only the newest undelivered one per topic.
        topic,
        timeout: 8000,
      },
    );
    return 'sent';
  } catch (e) {
    const status = (e as { statusCode?: number }).statusCode;
    if (status === 404 || status === 410) return 'gone';
    console.error('push failed', status ?? (e as Error).message);
    return 'failed';
  }
};

let sender: PushSender = webPushSender;

/** Test seam: capture pushes instead of sending them. Null restores the real one. */
export function setPushSender(next: PushSender | null): void {
  sender = next ?? webPushSender;
}

/**
 * Where a subscription may point. The server sends to the endpoint it is
 * given, so it must be a real push service — not an address inside some
 * network the server can reach and the browser cannot.
 *
 * web-push reads the endpoint with Node's legacy url.parse(), which does not
 * split a URL the way the WHATWG URL parser does: in
 * "https://169.254.169.254;.fcm.googleapis.com/" one sees a Google host and
 * the other connects to 169.254.169.254. So an endpoint is accepted only when
 *
 *   1. it is written in a plain form with nothing either parser could read
 *      two ways — https://, a host of lowercase letters, digits, dots and
 *      hyphens, then a path starting with "/" — no user, port, fragment,
 *      backslash, space, percent-escape in the host or non-ASCII anywhere;
 *   2. that host is exactly one of the push services below; and
 *   3. url.parse() (what web-push connects to) and new URL() both come out
 *      with that same host, no port and no credentials.
 *
 * The same check runs again just before each send, so a subscription stored
 * under older rules can never be used to reach anywhere else.
 */
const PUSH_HOSTS = new Set([
  'fcm.googleapis.com',
  'android.googleapis.com',
  'updates.push.services.mozilla.com',
  'push.services.mozilla.com',
  'web.push.apple.com',
  'push.apple.com',
]);
/** Windows hands out one host per region: exactly one label in front of notify.windows.com. */
const WNS_HOST = /^[a-z0-9]+(?:-[a-z0-9]+)*\.notify\.windows\.com$/;

/**
 * RFC 3986 path and query characters, minus anything a parser reads specially
 * or rewrites: no backslash, quote, "#", space, or "%" without two hex digits.
 */
const PLAIN_ENDPOINT = /^https:\/\/([a-z0-9.-]+)(\/(?:[A-Za-z0-9\-._~!$&()*+,;=:@/]|%[0-9A-Fa-f]{2})*)(\?(?:[A-Za-z0-9\-._~!$&()*+,;=:@/?]|%[0-9A-Fa-f]{2})*)?$/;

export function isPushHost(host: string): boolean {
  return PUSH_HOSTS.has(host) || WNS_HOST.test(host);
}

export function isPushEndpoint(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 1000) return false;
  const plain = PLAIN_ENDPOINT.exec(value);
  if (!plain) return false;
  const host = plain[1];
  if (!isPushHost(host)) return false;

  // What web-push will actually connect to.
  const legacy = parseUrl(value);
  if (legacy.protocol !== 'https:' || legacy.hostname !== host || legacy.host !== host
    || legacy.port || legacy.auth || legacy.hash) return false;
  if (legacy.path !== plain[2] + (plain[3] ?? '')) return false;

  // And what everything else (the browser, fetch) would read.
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === 'https:' && url.hostname === host && url.host === host
    && !url.port && !url.username && !url.password && !url.hash;
}

const KEY = /^[A-Za-z0-9_-]+={0,2}$/;

export async function subscribe(
  userId: string,
  body: unknown,
  userAgent: string | null,
): Promise<{ ok: true }> {
  const sub = (body as { subscription?: { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } } })?.subscription;
  const endpoint = sub?.endpoint;
  const p256dh = sub?.keys?.p256dh;
  const auth = sub?.keys?.auth;
  if (!isPushEndpoint(endpoint)) throw new HttpError(400, 'That is not a push service this app sends to');
  if (typeof p256dh !== 'string' || !KEY.test(p256dh) || p256dh.length > 200) throw new HttpError(400, 'Bad subscription key');
  if (typeof auth !== 'string' || !KEY.test(auth) || auth.length > 100) throw new HttpError(400, 'Bad subscription key');
  await ensureAppSchema();
  // The same browser signing in as someone else now notifies them, not the
  // person before: a device only ever hears about its current account.
  await getPool().query(
    `insert into app_push_subscription (user_id, endpoint, p256dh, auth, user_agent)
     values ($1, $2, $3, $4, $5)
     on conflict (endpoint) do update
       set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth,
           user_agent = excluded.user_agent, created_at = now()`,
    [userId, endpoint, p256dh, auth, userAgent?.slice(0, 300) ?? null],
  );
  return { ok: true };
}

/** Only ever the signed-in person's own subscription. */
export async function unsubscribe(userId: string, body: unknown): Promise<{ removed: boolean }> {
  const endpoint = (body as { endpoint?: unknown })?.endpoint;
  if (typeof endpoint !== 'string' || !endpoint) throw new HttpError(400, 'Say which subscription');
  await ensureAppSchema();
  const { rowCount } = await getPool().query(
    'delete from app_push_subscription where endpoint = $1 and user_id = $2',
    [endpoint, userId],
  );
  return { removed: (rowCount ?? 0) > 0 };
}

/** How many devices someone has notifications on, and whether this one is among them. */
export async function subscriptionStatus(userId: string, endpoint: string | null): Promise<{
  devices: number;
  thisDevice: boolean;
}> {
  await ensureAppSchema();
  const { rows } = await getPool().query<{ endpoint: string }>(
    'select endpoint from app_push_subscription where user_id = $1',
    [userId],
  );
  return { devices: rows.length, thisDevice: Boolean(endpoint && rows.some((r) => r.endpoint === endpoint)) };
}

/**
 * Sends one notification to every device someone has. A device whose push
 * service says the subscription is gone is forgotten; any other failure is
 * left for next time. Returns how many devices it reached.
 */
export async function pushToUser(userId: string, payload: PushPayload, topic: string): Promise<{ sent: number; devices: number }> {
  if (!pushConfig()) return { sent: 0, devices: 0 };
  const { rows } = await getPool().query<StoredSubscription & { id: string }>(
    'select id, endpoint, p256dh, auth from app_push_subscription where user_id = $1',
    [userId],
  );
  const outcomes = await Promise.all(rows.map(async (row) => {
    const subscription = { ...row, id: Number(row.id) };
    const outcome = await sender(subscription, payload, topic).catch((): PushOutcome => 'failed');
    if (outcome === 'gone') {
      await getPool().query('delete from app_push_subscription where id = $1', [subscription.id]);
    } else if (outcome === 'sent') {
      await getPool().query('update app_push_subscription set last_success_at = now() where id = $1', [subscription.id]);
    }
    return outcome;
  }));
  return { sent: outcomes.filter((o) => o === 'sent').length, devices: rows.length };
}
