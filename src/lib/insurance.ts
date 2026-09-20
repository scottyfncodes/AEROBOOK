/**
 * Insurance renewal logic.
 *
 * A policy's state is mostly a fact about a date, so it is derived rather
 * than typed in: a policy that expired last week is expired whatever the
 * user last selected. The states the user genuinely owns — a renewal being
 * worked, a quote received, coverage bound — are respected while they are
 * still plausible, because AEROBOOK cannot know those from a date.
 *
 * The countdown exists to be read at a glance, so it says "Renewal in 43
 * days", not "2026-11-02".
 */
import type { Aircraft, Contact, Database, InsurancePolicy, RenewalStatus } from '../data/types';
import { daysBetween, formatDate } from './dates';

/** How far ahead a renewal starts asking for attention. */
export const RENEWAL_WINDOW_DAYS = 60;

/** Statuses the user is actively driving, which a date must not overwrite. */
const WORKED_STATUSES: RenewalStatus[] = ['Renewal in progress', 'Quote received', 'Bound'];

export type RenewalTone = 'danger' | 'warn' | 'accent' | 'success' | 'info' | undefined;

export interface PolicyState {
  /** What to show. Derived from the expiration date unless the user owns it. */
  status: RenewalStatus;
  /** Days until expiration; negative once past. Null with no expiration date. */
  days: number | null;
  /** "Renewal in 43 days", "Expired 12 days ago", or '' with no date. */
  countdown: string;
  tone: RenewalTone;
  /** True when this policy belongs in front of the user today. */
  needsAttention: boolean;
}

/**
 * Plain English, and only ever as precise as the data. Deliberately calm:
 * a renewal six weeks out is information, not an emergency.
 */
export function renewalCountdown(expirationDate: string | undefined, now: Date = new Date()): string {
  if (!expirationDate) return '';
  const days = daysBetween(expirationDate, now);
  if (days === 0) return 'Renewal today';
  if (days === 1) return 'Renewal tomorrow';
  if (days === -1) return 'Expired yesterday';
  if (days < 0) return `Expired ${Math.abs(days)} days ago`;
  // Inside the attention window the day count is what matters; beyond it a
  // date reads better than "Renewal in 214 days". One threshold, not two.
  if (days <= RENEWAL_WINDOW_DAYS) return `Renewal in ${days} days`;
  return `Renewal ${formatDate(expirationDate)}`;
}

export function policyState(policy: InsurancePolicy, now: Date = new Date()): PolicyState {
  const days = policy.expirationDate ? daysBetween(policy.expirationDate, now) : null;
  const countdown = renewalCountdown(policy.expirationDate, now);
  const worked = WORKED_STATUSES.includes(policy.status);

  // Expired is a fact, and it outranks everything the user selected except
  // "Bound", which means the replacement cover is already in place.
  if (days !== null && days < 0 && policy.status !== 'Bound') {
    return { status: 'Expired', days, countdown, tone: 'danger', needsAttention: true };
  }

  if (worked) {
    const tone: RenewalTone = policy.status === 'Bound' ? 'success' : 'accent';
    return {
      status: policy.status,
      days,
      countdown,
      tone,
      needsAttention: policy.status !== 'Bound',
    };
  }

  if (days === null) {
    const status = policy.status === 'Unknown' ? 'Unknown' : policy.status;
    return { status, days, countdown, tone: status === 'Unknown' ? undefined : 'info', needsAttention: false };
  }

  if (days <= RENEWAL_WINDOW_DAYS) {
    return { status: 'Renewal upcoming', days, countdown, tone: 'warn', needsAttention: true };
  }

  return { status: 'Active', days, countdown, tone: 'success', needsAttention: false };
}

export function policiesFor(
  db: Pick<Database, 'policies'>,
  match: { aircraftId?: string; contactId?: string; opportunityId?: string },
): InsurancePolicy[] {
  return db.policies
    .filter(
      (p) =>
        (match.aircraftId !== undefined && p.aircraftId === match.aircraftId) ||
        (match.contactId !== undefined && p.contactId === match.contactId) ||
        (match.opportunityId !== undefined && p.opportunityId === match.opportunityId),
    )
    .sort(sortByUrgency);
}

/** Soonest expiration first; policies with no date sit at the back. */
export function sortByUrgency(a: InsurancePolicy, b: InsurancePolicy): number {
  const ax = a.expirationDate ?? '9999-12-31';
  const bx = b.expirationDate ?? '9999-12-31';
  return ax.localeCompare(bx);
}

export interface RenewalItem {
  policy: InsurancePolicy;
  state: PolicyState;
  aircraft?: Aircraft;
  contact?: Contact;
}

/** Everything that wants attention today, most urgent first. */
export function renewalsNeedingAttention(
  db: Pick<Database, 'policies' | 'aircraft' | 'contacts'>,
  now: Date = new Date(),
): RenewalItem[] {
  return db.policies
    .map((policy) => ({
      policy,
      state: policyState(policy, now),
      aircraft: policy.aircraftId ? db.aircraft.find((a) => a.id === policy.aircraftId) : undefined,
      contact: policy.contactId ? db.contacts.find((c) => c.id === policy.contactId) : undefined,
    }))
    .filter((item) => item.state.needsAttention)
    .sort((a, b) => sortByUrgency(a.policy, b.policy));
}

export interface RenewalSummary {
  expired: number;
  upcoming: number;
  inProgress: number;
  total: number;
}

export function renewalSummary(db: Pick<Database, 'policies'>, now: Date = new Date()): RenewalSummary {
  const summary: RenewalSummary = { expired: 0, upcoming: 0, inProgress: 0, total: db.policies.length };
  for (const policy of db.policies) {
    const { status } = policyState(policy, now);
    if (status === 'Expired') summary.expired += 1;
    else if (status === 'Renewal upcoming') summary.upcoming += 1;
    else if (status === 'Renewal in progress' || status === 'Quote received') summary.inProgress += 1;
  }
  return summary;
}

/** A one-line label for a policy, for lists and search results. */
export function policyLabel(policy: InsurancePolicy): string {
  return policy.carrier || policy.policyNumber || 'Insurance policy';
}

/**
 * The single line a detail screen shows when it has room for one: carrier,
 * hull value and where the renewal stands.
 */
export function policySummary(policy: InsurancePolicy, now: Date = new Date()): string {
  const state = policyState(policy, now);
  return [policyLabel(policy), policy.hullValue ? `Hull ${policy.hullValue}` : '', state.countdown]
    .filter(Boolean)
    .join(' · ');
}
