/**
 * The rules behind the live parts of chat and comments, kept pure so they
 * are tested without a browser: where the person is looking, how often to
 * ask the server, and which new events deserve a pop-up.
 */

/** A minute and a half without a tap, a key or a scroll counts as away from the screen. */
export const IDLE_MS = 90_000;

/** The thread on screen, in the server's terms: "conv:<id>", "aircraft:<id>", or just "app". */
export function viewFor(pathname: string): string {
  const chat = /^\/chat\/([^/]+)\/?$/.exec(pathname);
  if (chat) return `conv:${decodeURIComponent(chat[1])}`;
  const aircraft = /^\/aircraft\/([^/]+)\/?$/.exec(pathname);
  if (aircraft) return `aircraft:${decodeURIComponent(aircraft[1])}`;
  return 'app';
}

/**
 * How long until the next check, or null to stop until the app is back in
 * front. Quick in an open conversation, where a reply is expected; slower
 * elsewhere; slow when nobody has touched the screen for a while.
 */
export function pollDelay(input: { hidden: boolean; view: string; idleFor: number }): number | null {
  if (input.hidden) return null;
  if (input.idleFor > IDLE_MS) return 30_000;
  if (input.view.startsWith('conv:')) return 3_000;
  return 8_000;
}

export interface AlertEvent {
  id: number;
  thread: string;
  url: string;
  text: string;
}

/**
 * The events to pop up: each only once, and none for the thread already on
 * screen — that one simply shows the new message.
 */
export function alertsFor<T extends AlertEvent>(events: T[], view: string, shown: Set<number>): T[] {
  const out: T[] = [];
  for (const event of events) {
    if (shown.has(event.id)) continue;
    shown.add(event.id);
    if (event.thread === view) continue;
    out.push(event);
  }
  return out;
}

/** "12:40", "Yesterday 12:40", "Mon 12:40" or "3 Mar 12:40" — how chat shows when. */
export function chatTime(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((day(now) - day(d)) / 86_400_000);
  if (days === 0) return time;
  if (days === 1) return `Yesterday ${time}`;
  if (days > 1 && days < 7) return `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${time}`;
  const sameYear = d.getFullYear() === now.getFullYear();
  return `${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) })} ${time}`;
}
