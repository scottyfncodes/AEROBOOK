/**
 * The morning email: each person's follow-ups that are overdue, due today,
 * and coming up this week — the same "Mine" list the app shows (their own
 * plus anything nobody has taken yet).
 *
 * Sent through Resend once a day by Vercel Cron. With no RESEND_API_KEY on
 * the deployment nothing is sent; the digest can still be previewed. A row in
 * app_digest per person per day makes a repeated or overlapping run send
 * nothing twice.
 */
import { APP_SCHEMA, getPool } from './db.js';

/** The day starts at midnight here, not in UTC where the server runs. */
export const DEFAULT_TIME_ZONE = 'America/Los_Angeles';
export const DEFAULT_FROM = 'AEROBOOK <digest@optibook.cloud>';
export const UPCOMING_DAYS = 7;


export interface DigestItem {
  id: string;
  dueDate: string;
  note: string;
  priority?: string;
  /** "Marlon Humphrey · N917JH" — who and what it is about. */
  about: string;
}

export interface Digest {
  userId: string;
  name: string;
  email: string;
  day: string;
  overdue: DigestItem[];
  today: DigestItem[];
  upcoming: DigestItem[];
}

export interface RenderedDigest {
  subject: string;
  text: string;
  html: string;
}

export function timeZone(): string {
  return process.env.DIGEST_TIME_ZONE || DEFAULT_TIME_ZONE;
}

/** "YYYY-MM-DD" for the calendar day it is in `zone` at `now`. */
export function dayIn(now: Date, zone = timeZone()): string {
  // en-CA formats dates as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

function daysFrom(day: string, due: string): number {
  return Math.round((Date.parse(`${due}T00:00:00Z`) - Date.parse(`${day}T00:00:00Z`)) / 86_400_000);
}

/** The date part of a stored due date, which is "YYYY-MM-DD" or a full ISO string. */
function dueDay(value: unknown, zone: string): string | null {
  if (typeof value !== 'string' || !value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : dayIn(parsed, zone);
}

type Row = Record<string, unknown>;

function contactName(c: Row | undefined): string {
  if (!c) return '';
  const person = [c.firstName, c.lastName].filter((p) => typeof p === 'string' && p.trim()).join(' ');
  return person || String(c.company ?? '') || String(c.rawName ?? '');
}

function tail(a: Row | undefined): string {
  if (!a || typeof a.tailNumber !== 'string') return '';
  const t = a.tailNumber.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return t && !t.startsWith('N') && /^\d/.test(t) ? `N${t}` : t;
}

const byDue = (a: DigestItem, b: DigestItem) =>
  a.dueDate.localeCompare(b.dueDate) || Number(b.priority === 'High') - Number(a.priority === 'High');

/**
 * Everyone's digest for `day`, from the shared records. People whose access
 * is off, who turned the email off, or who have nothing coming up are left out.
 */
export async function buildDigests(
  now = new Date(),
  only?: { userId: string },
): Promise<Digest[]> {
  const zone = timeZone();
  const day = dayIn(now, zone);
  const pool = getPool();
  const { rows: people } = await pool.query<{ id: string; name: string; email: string }>(
    `select u.id, u.name, u.email from "user" u
      where not coalesce(u.banned, false)
        and ($1::text is null or u.id = $1)
        -- Someone asking for their own copy gets it even with the email off.
        and ($1::text is not null or not exists (
          select 1 from app_record s
           where s.collection = 'settings' and s.id = u.id and s.data->>'dailyDigest' = 'false'))
      order by u.name`,
    [only?.userId ?? null],
  );
  if (people.length === 0) return [];

  const { rows: open } = await pool.query<{ data: Row }>(
    `select data from app_record
      where collection = 'followUps' and data is not null
        and coalesce(data->>'completed', 'false') <> 'true'`,
  );
  const contactIds = new Set<string>();
  const aircraftIds = new Set<string>();
  for (const { data } of open) {
    if (typeof data.contactId === 'string') contactIds.add(data.contactId);
    if (typeof data.aircraftId === 'string') aircraftIds.add(data.aircraftId);
  }
  const { rows: related } = await pool.query<{ collection: string; id: string; data: Row }>(
    `select collection, id, data from app_record
      where data is not null and ((collection = 'contacts' and id = any($1)) or (collection = 'aircraft' and id = any($2)))`,
    [[...contactIds], [...aircraftIds]],
  );
  const contacts = new Map(related.filter((r) => r.collection === 'contacts').map((r) => [r.id, r.data]));
  const aircraft = new Map(related.filter((r) => r.collection === 'aircraft').map((r) => [r.id, r.data]));

  return people.map((person): Digest => {
    const digest: Digest = { userId: person.id, name: person.name, email: person.email, day, overdue: [], today: [], upcoming: [] };
    for (const { data } of open) {
      const assignee = data.assigneeId;
      if (assignee && assignee !== person.id) continue;
      const due = dueDay(data.dueDate, zone);
      if (!due) continue;
      const item: DigestItem = {
        id: String(data.id),
        dueDate: due,
        note: String(data.note ?? '').trim(),
        priority: typeof data.priority === 'string' ? data.priority : undefined,
        about: [
          contactName(contacts.get(String(data.contactId))),
          tail(aircraft.get(String(data.aircraftId))),
        ].filter(Boolean).join(' · '),
      };
      const days = daysFrom(day, due);
      if (days < 0) digest.overdue.push(item);
      else if (days === 0) digest.today.push(item);
      else if (days <= UPCOMING_DAYS) digest.upcoming.push(item);
    }
    digest.overdue.sort(byDue);
    digest.today.sort(byDue);
    digest.upcoming.sort(byDue);
    return digest;
  });
}

export function isEmptyDigest(d: Digest): boolean {
  return d.overdue.length + d.today.length + d.upcoming.length === 0;
}

// ---------------------------------------------------------------- render

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function shortDate(day: string): string {
  const [, m, d] = day.split('-').map(Number);
  return `${MONTHS[m - 1]} ${d}`;
}

function longDate(day: string): string {
  return `${WEEKDAYS[new Date(`${day}T12:00:00Z`).getUTCDay()]}, ${shortDate(day)}`;
}

function escape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export function subjectFor(d: Digest): string {
  const parts: string[] = [];
  if (d.today.length) parts.push(`${d.today.length} due today`);
  if (d.overdue.length) parts.push(`${d.overdue.length} overdue`);
  if (d.upcoming.length) parts.push(`${d.upcoming.length} this week`);
  return `AEROBOOK · ${parts.length ? parts.join(', ') : 'nothing due'} — ${shortDate(d.day)}`;
}

/** Where the app lives, for the button in the email. */
export function appUrl(): string {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, '');
  const host = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  return host ? `https://${host}` : 'http://localhost:4173';
}

export function renderDigest(d: Digest): RenderedDigest {
  const link = `${appUrl()}/follow-ups`;
  const sections: [string, DigestItem[], boolean][] = [
    ['Overdue', d.overdue, true],
    ['Due today', d.today, false],
    [`Coming up (next ${UPCOMING_DAYS} days)`, d.upcoming, true],
  ];
  const firstName = d.name.split(/\s+/)[0] || d.name;
  const intro = isEmptyDigest(d)
    ? 'Nothing is due on your list this week.'
    : `Here is your list for ${longDate(d.day)}.`;

  const line = (i: DigestItem, withDate: boolean) =>
    [withDate ? shortDate(i.dueDate) : '', i.priority === 'High' ? 'HIGH' : '', i.about, i.note || '(no note)']
      .filter(Boolean).join(' — ');

  const text = [
    `Good morning, ${firstName}.`,
    intro,
    ...sections.filter(([, items]) => items.length).map(([title, items, withDate]) =>
      `\n${title.toUpperCase()} (${items.length})\n${items.map((i) => `• ${line(i, withDate)}`).join('\n')}`),
    `\nOpen your follow-ups: ${link}`,
    '\nYou can turn this email off in AEROBOOK under Settings → Daily email.',
  ].join('\n');

  const itemHtml = (i: DigestItem, withDate: boolean) => `
      <tr><td style="padding:10px 0;border-top:1px solid #e5e7eb;font-size:15px;line-height:1.4;color:#111827">
        ${withDate ? `<span style="color:#6b7280">${escape(shortDate(i.dueDate))}</span> · ` : ''}${i.priority === 'High' ? '<strong style="color:#b91c1c">High</strong> · ' : ''}${i.about ? `<strong>${escape(i.about)}</strong>` : ''}
        <div style="color:#374151">${escape(i.note || '(no note)')}</div>
      </td></tr>`;
  const sectionHtml = sections
    .filter(([, items]) => items.length)
    .map(([title, items, withDate]) => `
      <h2 style="margin:24px 0 4px;font-size:13px;letter-spacing:.06em;text-transform:uppercase;color:${title === 'Overdue' ? '#b91c1c' : '#374151'}">${escape(title)} (${items.length})</h2>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${items.map((i) => itemHtml(i, withDate)).join('')}</table>`)
    .join('');

  const html = `<!doctype html>
<html><body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;padding:24px">
      <tr><td>
        <div style="font-size:12px;font-weight:700;letter-spacing:.12em;color:#6b7280">AEROBOOK</div>
        <h1 style="margin:8px 0 4px;font-size:20px;color:#111827">Good morning, ${escape(firstName)}.</h1>
        <p style="margin:0;color:#374151;font-size:15px">${escape(intro)}</p>
        ${sectionHtml}
        <p style="margin:28px 0 8px"><a href="${escape(link)}" style="display:inline-block;background:#111827;color:#ffffff;text-decoration:none;padding:12px 18px;border-radius:8px;font-weight:600">Open follow-ups</a></p>
        <p style="margin:16px 0 0;color:#9ca3af;font-size:12px">You can turn this email off in AEROBOOK under Settings → Daily email.</p>
      </td></tr>
    </table>
  </td></tr></table>
</body></html>`;

  return { subject: subjectFor(d), text, html };
}

// ------------------------------------------------------------------ send

export function emailEnabled(): boolean {
  return Boolean(process.env.RESEND_API_KEY);
}

export class EmailError extends Error {}

/** Resend's HTTP API. The idempotency key stops a retried request from sending twice. */
export async function sendEmail(to: string, email: RenderedDigest, idempotencyKey?: string): Promise<void> {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new EmailError('Email is not set up on this deployment yet');
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
      ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
    },
    body: JSON.stringify({
      from: process.env.DIGEST_FROM || DEFAULT_FROM,
      to: [to],
      subject: email.subject,
      html: email.html,
      text: email.text,
    }),
  });
  if (!response.ok) {
    const detail = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new EmailError(`The email service said ${response.status}${detail?.message ? `: ${detail.message}` : ''}`);
  }
}

export interface RunResult {
  day: string;
  enabled: boolean;
  sent: number;
  /** Already sent today, or nothing on their list. */
  skipped: number;
  failed: number;
}

/** The daily run. Safe to call more than once a day. */
export async function runDigest(now = new Date()): Promise<RunResult> {
  const day = dayIn(now);
  const result: RunResult = { day, enabled: emailEnabled(), sent: 0, skipped: 0, failed: 0 };
  if (!result.enabled) return result;
  const pool = getPool();
  // A database set up before the daily email existed gets its table here.
  await pool.query(APP_SCHEMA);
  for (const digest of await buildDigests(now)) {
    if (isEmptyDigest(digest)) {
      result.skipped++;
      continue;
    }
    // Claim the day first, so two overlapping runs cannot both send.
    const claimed = await pool.query(
      'insert into app_digest (user_id, day) values ($1, $2) on conflict do nothing returning user_id',
      [digest.userId, day],
    );
    if (claimed.rowCount === 0) {
      result.skipped++;
      continue;
    }
    try {
      await sendEmail(digest.email, renderDigest(digest), `digest-${digest.userId}-${day}`);
      result.sent++;
    } catch (error) {
      // Let the next run try this person again.
      await pool.query('delete from app_digest where user_id = $1 and day = $2', [digest.userId, day]);
      console.error('Digest not sent', digest.userId, (error as Error).message);
      result.failed++;
    }
  }
  return result;
}
