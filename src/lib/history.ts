/**
 * The activity history, in words. The server hands back what was recorded
 * (who, create/update/delete, which collection, a few words naming the
 * record); this turns it into lines a person reads: "Scott edited aircraft
 * N917JH". Pure, so the wording is tested without a screen.
 */
import type { Database } from '../data/types';
import { formatDate, todayKey, dateKey, addDays } from './dates';
import { formatTail } from './tail';

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

const NOUNS: Record<string, [one: string, many: string]> = {
  contacts: ['contact', 'contacts'],
  aircraft: ['aircraft', 'aircraft'],
  opportunities: ['opportunity', 'opportunities'],
  policies: ['insurance policy', 'insurance policies'],
  activities: ['timeline entry', 'timeline entries'],
  followUps: ['follow-up', 'follow-ups'],
  templates: ['email template', 'email templates'],
  imports: ['import', 'imports'],
  files: ['document', 'documents'],
  aircraftComments: ['a comment on', 'comments on'],
};

export function noun(collection: string, count = 1): string {
  const [one, many] = NOUNS[collection] ?? ['record', 'records'];
  return count === 1 ? one : many;
}

/** Timeline entries are added and removed; everything else created and deleted. */
export function verb(action: HistoryEntry['action'], collection: string): string {
  if (action === 'update') return 'edited';
  if (collection === 'activities' || collection === 'aircraftComments') return action === 'create' ? 'added' : 'removed';
  return action === 'create' ? 'created' : 'deleted';
}

/**
 * One line on the screen. Runs of the same person doing the same thing to the
 * same kind of record within a couple of minutes — an import creating a
 * hundred contacts — collapse into one line with a count.
 */
export interface HistoryLine {
  key: string;
  userId: string | null;
  userName: string;
  action: HistoryEntry['action'];
  collection: string;
  /** Newest first, as recorded. */
  entries: HistoryEntry[];
  /** When the newest of them happened. */
  at: string;
}

const RUN_GAP_MS = 2 * 60 * 1000;

export function groupHistory(entries: HistoryEntry[]): HistoryLine[] {
  const lines: HistoryLine[] = [];
  for (const e of entries) {
    const last = lines[lines.length - 1];
    const previous = last?.entries[last.entries.length - 1];
    if (
      last && previous &&
      last.userId === e.userId && last.userName === e.userName &&
      last.action === e.action && last.collection === e.collection &&
      new Date(previous.at).getTime() - new Date(e.at).getTime() <= RUN_GAP_MS &&
      dateKey(previous.at) === dateKey(e.at)
    ) {
      last.entries.push(e);
      continue;
    }
    lines.push({
      key: String(e.id), userId: e.userId, userName: e.userName, action: e.action,
      collection: e.collection, entries: [e], at: e.at,
    });
  }
  return lines;
}

/** Lines split into days, newest day first, for the headings on the screen. */
export function byDay(lines: HistoryLine[], now = new Date()): { label: string; lines: HistoryLine[] }[] {
  const days: { key: string; label: string; lines: HistoryLine[] }[] = [];
  for (const line of lines) {
    const key = dateKey(line.at);
    let day = days[days.length - 1];
    if (!day || day.key !== key) {
      day = { key, label: dayLabel(line.at, now), lines: [] };
      days.push(day);
    }
    day.lines.push(line);
  }
  return days.map(({ label, lines: l }) => ({ label, lines: l }));
}

export function dayLabel(at: string, now = new Date()): string {
  const key = dateKey(at);
  if (key === todayKey(now)) return 'Today';
  if (key === addDays(-1, now)) return 'Yesterday';
  return formatDate(at);
}

export function timeOf(at: string): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/**
 * Where a record lives in the app, and what it is about, when it is still
 * there. Deleted records, templates and imports have no page to go to.
 */
export function locate(
  db: Pick<Database, 'contacts' | 'aircraft' | 'opportunities' | 'policies' | 'activities' | 'followUps'>,
  collection: string,
  id: string,
): { to?: string; context?: string } {
  const aircraftPage = (aircraftId: string | null | undefined) => {
    const a = aircraftId ? db.aircraft.find((x) => x.id === aircraftId) : undefined;
    return a ? { to: `/aircraft/${a.id}`, context: formatTail(a.tailNumber) } : undefined;
  };
  const contactPage = (contactId: string | null | undefined) => {
    const c = contactId ? db.contacts.find((x) => x.id === contactId) : undefined;
    const name = c ? [c.firstName, c.lastName].filter(Boolean).join(' ') || c.company || c.rawName : '';
    return c ? { to: `/contacts/${c.id}`, context: name } : undefined;
  };
  const opportunityPage = (opportunityId: string | null | undefined) => {
    const o = opportunityId ? db.opportunities.find((x) => x.id === opportunityId) : undefined;
    return o ? { to: `/opportunities/${o.id}`, context: o.title || o.type } : undefined;
  };

  switch (collection) {
    case 'contacts': return { to: contactPage(id)?.to };
    case 'aircraft': return { to: aircraftPage(id)?.to };
    // Recorded against the aircraft, never the comment's words.
    case 'aircraftComments': {
      const to = aircraftPage(id)?.to;
      return to ? { to: `${to}#comments` } : {};
    }
    case 'opportunities': return { to: opportunityPage(id)?.to };
    case 'policies': {
      const p = db.policies.find((x) => x.id === id);
      return p ? aircraftPage(p.aircraftId) ?? contactPage(p.contactId) ?? {} : {};
    }
    case 'activities':
    case 'followUps': {
      const r = collection === 'activities'
        ? db.activities.find((x) => x.id === id)
        : db.followUps.find((x) => x.id === id);
      if (!r) return {};
      return opportunityPage(r.opportunityId) ?? aircraftPage(r.aircraftId) ?? contactPage(r.contactId) ?? {};
    }
    default: return {};
  }
}
