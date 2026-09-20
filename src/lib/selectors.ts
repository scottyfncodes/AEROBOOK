/** Derived views over the database. Pure, so they are easy to test and cheap. */
import type { Activity, Aircraft, Contact, Database, FollowUp, Opportunity } from '../data/types';
import { CLOSED_OPPORTUNITY_STATUSES } from '../data/types';
import { daysBetween, dueBucket } from './dates';
import { displayName } from './names';

export function ownerOf(db: Pick<Database, 'contacts'>, aircraft: Aircraft | undefined): Contact | undefined {
  if (!aircraft) return undefined;
  const id = aircraft.ownerships.find((o) => !o.endedAt)?.contactId;
  return id ? db.contacts.find((c) => c.id === id) : undefined;
}

export function previousOwners(db: Pick<Database, 'contacts'>, aircraft: Aircraft): { contact: Contact; endedAt?: string }[] {
  const out: { contact: Contact; endedAt?: string }[] = [];
  for (const o of aircraft.ownerships) {
    if (!o.endedAt) continue;
    const contact = db.contacts.find((c) => c.id === o.contactId);
    if (contact) out.push({ contact, endedAt: o.endedAt });
  }
  return out;
}

export function aircraftOf(db: Pick<Database, 'aircraft'>, contactId: string): Aircraft[] {
  return db.aircraft.filter((a) => a.ownerships.some((o) => o.contactId === contactId && !o.endedAt));
}

export function openFollowUps(db: Pick<Database, 'followUps'>): FollowUp[] {
  return db.followUps.filter((f) => !f.completed);
}

export interface FollowUpBuckets {
  overdue: FollowUp[];
  today: FollowUp[];
  /** Due inside the next week. */
  upcoming: FollowUp[];
  /** Everything beyond that, so the week's work is not buried under it. */
  later: FollowUp[];
}

/** How far ahead "upcoming" reaches before a follow-up becomes "later". */
export const UPCOMING_DAYS = 7;

export function bucketFollowUps(followUps: FollowUp[], now = new Date()): FollowUpBuckets {
  const buckets: FollowUpBuckets = { overdue: [], today: [], upcoming: [], later: [] };
  for (const f of followUps) {
    const bucket = dueBucket(f.dueDate, now);
    if (bucket === 'overdue') buckets.overdue.push(f);
    else if (bucket === 'today') buckets.today.push(f);
    else if (bucket === 'upcoming') {
      if (daysBetween(f.dueDate, now) <= UPCOMING_DAYS) buckets.upcoming.push(f);
      else buckets.later.push(f);
    }
  }
  // High priority first inside a day, then by date.
  const byDate = (a: FollowUp, b: FollowUp) =>
    a.dueDate.localeCompare(b.dueDate) ||
    Number(b.priority === 'High') - Number(a.priority === 'High');
  for (const key of ['overdue', 'today', 'upcoming', 'later'] as const) buckets[key].sort(byDate);
  return buckets;
}

/** Everything that needs a decision today: overdue plus due today. */
export function dueNow(db: Pick<Database, 'followUps'>, now = new Date()): FollowUp[] {
  const buckets = bucketFollowUps(openFollowUps(db), now);
  return [...buckets.overdue, ...buckets.today];
}

export function followUpSubject(db: Database, f: FollowUp): string {
  const contact = f.contactId ? db.contacts.find((c) => c.id === f.contactId) : undefined;
  const aircraft = f.aircraftId ? db.aircraft.find((a) => a.id === f.aircraftId) : undefined;
  const parts = [contact ? displayName(contact) : '', aircraft?.tailNumber].filter(Boolean);
  return parts.join(' / ') || 'General';
}

export function timelineFor(
  db: Pick<Database, 'activities' | 'followUps'>,
  match: { contactId?: string; aircraftId?: string; opportunityId?: string },
): { activities: Activity[]; followUps: FollowUp[] } {
  const hit = (r: { contactId: string | null; aircraftId: string | null; opportunityId: string | null }) =>
    (match.contactId !== undefined && r.contactId === match.contactId) ||
    (match.aircraftId !== undefined && r.aircraftId === match.aircraftId) ||
    (match.opportunityId !== undefined && r.opportunityId === match.opportunityId);

  return {
    activities: db.activities.filter(hit).sort((a, b) => b.date.localeCompare(a.date)),
    followUps: db.followUps.filter(hit).sort((a, b) => a.dueDate.localeCompare(b.dueDate)),
  };
}

export function isOpen(o: Opportunity): boolean {
  return !CLOSED_OPPORTUNITY_STATUSES.includes(o.status);
}

/** Every deal still in motion, the one nearest a decision first. */
export function openOpportunities(db: Pick<Database, 'opportunities'>): Opportunity[] {
  const order = ['Negotiating', 'Quoting', 'Interested', 'Contacted', 'Lead'];
  return db.opportunities
    .filter(isOpen)
    .sort(
      (a, b) =>
        order.indexOf(a.status) - order.indexOf(b.status) || b.updatedAt.localeCompare(a.updatedAt),
    );
}

export interface Pipeline {
  open: number;
  won: number;
  /** Aircraft the user has marked as being for sale or being hunted. */
  forSale: number;
  wanted: number;
}

/**
 * The home screen's summary. Per-stage counts live on the pipeline screen,
 * where they double as its filter, rather than being computed twice.
 */
export function pipeline(db: Pick<Database, 'opportunities' | 'aircraft'>): Pipeline {
  return {
    open: db.opportunities.filter(isOpen).length,
    won: db.opportunities.filter((o) => o.status === 'Won').length,
    forSale: db.aircraft.filter((a) => a.status === 'For Sale').length,
    wanted: db.aircraft.filter((a) => a.status === 'Purchase Prospect').length,
  };
}

/** The most recent thing that happened anywhere, newest first. */
export function recentActivity(db: Pick<Database, 'activities'>, limit = 6): Activity[] {
  return [...db.activities].sort((a, b) => b.date.localeCompare(a.date)).slice(0, limit);
}

export function recentlyUpdated<T extends { updatedAt: string }>(items: T[], limit = 5): T[] {
  return [...items].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, limit);
}

export function recentlyContacted(db: Pick<Database, 'contacts'>, limit = 5): Contact[] {
  return db.contacts
    .filter((c) => c.lastContactedAt)
    .sort((a, b) => (b.lastContactedAt ?? '').localeCompare(a.lastContactedAt ?? ''))
    .slice(0, limit);
}

export function opportunitiesFor(
  db: Pick<Database, 'opportunities'>,
  match: { contactId?: string; aircraftId?: string; opportunityId?: string },
): Opportunity[] {
  return db.opportunities.filter(
    (o) =>
      (match.contactId !== undefined && o.contactId === match.contactId) ||
      (match.aircraftId !== undefined && o.aircraftId === match.aircraftId) ||
      (match.opportunityId !== undefined && o.id === match.opportunityId),
  );
}

export function nextFollowUpFor(
  db: Pick<Database, 'followUps'>,
  match: { contactId?: string; aircraftId?: string; opportunityId?: string },
): FollowUp | undefined {
  return db.followUps
    .filter(
      (f) =>
        !f.completed &&
        ((match.contactId !== undefined && f.contactId === match.contactId) ||
          (match.aircraftId !== undefined && f.aircraftId === match.aircraftId) ||
          (match.opportunityId !== undefined && f.opportunityId === match.opportunityId)),
    )
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate))[0];
}

/**
 * "What happens next with this aircraft?" — the next follow-up if there is
 * one, otherwise the next action written on an open opportunity. Returns null
 * when the honest answer is that nothing is scheduled.
 */
export interface NextMove {
  text: string;
  dueDate?: string;
  followUp?: FollowUp;
  opportunity?: Opportunity;
}

export function nextMove(
  db: Pick<Database, 'followUps' | 'opportunities'>,
  match: { contactId?: string; aircraftId?: string; opportunityId?: string },
): NextMove | null {
  const followUp = nextFollowUpFor(db, match);
  if (followUp) {
    return { text: followUp.note || 'Follow up', dueDate: followUp.dueDate, followUp };
  }
  const opportunity = opportunitiesFor(db, match).filter(isOpen).find((o) => o.nextAction?.trim());
  if (opportunity?.nextAction) return { text: opportunity.nextAction, opportunity };
  return null;
}
