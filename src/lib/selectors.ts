/** Derived views over the database. Pure, so they are easy to test and cheap. */
import type { Activity, Aircraft, Contact, Database, FollowUp, Opportunity } from '../data/types';
import { dueBucket } from './dates';
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
  upcoming: FollowUp[];
}

export function bucketFollowUps(followUps: FollowUp[], now = new Date()): FollowUpBuckets {
  const buckets: FollowUpBuckets = { overdue: [], today: [], upcoming: [] };
  for (const f of followUps) {
    const bucket = dueBucket(f.dueDate, now);
    if (bucket === 'overdue') buckets.overdue.push(f);
    else if (bucket === 'today') buckets.today.push(f);
    else if (bucket === 'upcoming') buckets.upcoming.push(f);
  }
  const byDate = (a: FollowUp, b: FollowUp) => a.dueDate.localeCompare(b.dueDate);
  buckets.overdue.sort(byDate);
  buckets.today.sort(byDate);
  buckets.upcoming.sort(byDate);
  return buckets;
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

export interface Pipeline {
  newProspects: number;
  active: number;
  quotes: number;
  clients: number;
  aircraftOpportunities: number;
}

export function pipeline(db: Pick<Database, 'contacts' | 'opportunities'>): Pipeline {
  const counts = (statuses: string[]) => db.contacts.filter((c) => statuses.includes(c.prospectStatus)).length;
  return {
    newProspects: counts(['New']),
    active: counts(['Contacted', 'Follow-Up', 'Engaged']),
    quotes: counts(['Quote']),
    clients: counts(['Client']),
    aircraftOpportunities: db.opportunities.filter(
      (o) => ['Aircraft Purchase', 'Aircraft Sale', 'Both'].includes(o.type) && !['Won', 'Lost', 'Closed'].includes(o.status),
    ).length,
  };
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
  match: { contactId?: string; aircraftId?: string },
): Opportunity[] {
  return db.opportunities.filter(
    (o) =>
      (match.contactId !== undefined && o.contactId === match.contactId) ||
      (match.aircraftId !== undefined && o.aircraftId === match.aircraftId),
  );
}

export function nextFollowUpFor(db: Pick<Database, 'followUps'>, match: { contactId?: string; aircraftId?: string }): FollowUp | undefined {
  return db.followUps
    .filter(
      (f) =>
        !f.completed &&
        ((match.contactId !== undefined && f.contactId === match.contactId) ||
          (match.aircraftId !== undefined && f.aircraftId === match.aircraftId)),
    )
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate))[0];
}
