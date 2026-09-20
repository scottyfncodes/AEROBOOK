/**
 * Renewal logic. The dates are all relative to a fixed "now" so the suite
 * does not change meaning as the calendar moves.
 */
import { describe, expect, it } from 'vitest';
import {
  RENEWAL_WINDOW_DAYS, policiesFor, policyLabel, policyState, policySummary, renewalCountdown,
  renewalSummary, renewalsNeedingAttention, sortByUrgency,
} from './insurance';
import {
  emptyDatabase, type Aircraft, type Contact, type Database, type InsurancePolicy, type RenewalStatus,
} from '../data/types';

const NOW = new Date(2026, 8, 20); // 20 September 2026, local.

function iso(offsetDays: number): string {
  const d = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() + offsetDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function policy(patch: Partial<InsurancePolicy> = {}): InsurancePolicy {
  return {
    id: 'p1',
    aircraftId: null,
    contactId: null,
    opportunityId: null,
    carrier: '',
    policyNumber: '',
    brokerAgent: '',
    premium: '',
    hullValue: '',
    liabilityLimit: '',
    deductible: '',
    status: 'Unknown',
    quotedPremium: '',
    renewalNotes: '',
    notes: '',
    createdAt: '',
    updatedAt: '',
    ...patch,
  };
}

describe('renewalCountdown', () => {
  it('counts the days down in plain English', () => {
    expect(renewalCountdown(iso(43), NOW)).toBe('Renewal in 43 days');
    expect(renewalCountdown(iso(1), NOW)).toBe('Renewal tomorrow');
    expect(renewalCountdown(iso(0), NOW)).toBe('Renewal today');
  });

  it('counts the days up once the policy has lapsed', () => {
    expect(renewalCountdown(iso(-1), NOW)).toBe('Expired yesterday');
    expect(renewalCountdown(iso(-12), NOW)).toBe('Expired 12 days ago');
  });

  it('counts down for anything inside the attention window', () => {
    expect(renewalCountdown(iso(RENEWAL_WINDOW_DAYS), NOW)).toBe(`Renewal in ${RENEWAL_WINDOW_DAYS} days`);
    expect(renewalCountdown(iso(47), NOW)).toBe('Renewal in 47 days');
  });

  it('switches to a date once the countdown stops being useful', () => {
    expect(renewalCountdown(iso(RENEWAL_WINDOW_DAYS + 1), NOW)).toMatch(/^Renewal /);
    expect(renewalCountdown(iso(200), NOW)).not.toMatch(/days/);
  });

  it('says nothing at all with no expiration date', () => {
    expect(renewalCountdown(undefined, NOW)).toBe('');
    expect(renewalCountdown('', NOW)).toBe('');
  });
});

describe('policyState', () => {
  it('is active well before the window', () => {
    const state = policyState(policy({ expirationDate: iso(180) }), NOW);
    expect(state.status).toBe('Active');
    expect(state.needsAttention).toBe(false);
    expect(state.days).toBe(180);
  });

  it('asks for attention inside the renewal window', () => {
    const state = policyState(policy({ expirationDate: iso(RENEWAL_WINDOW_DAYS) }), NOW);
    expect(state.status).toBe('Renewal upcoming');
    expect(state.needsAttention).toBe(true);
  });

  it('treats the day after the window as still active', () => {
    expect(policyState(policy({ expirationDate: iso(RENEWAL_WINDOW_DAYS + 1) }), NOW).status).toBe('Active');
  });

  it('is expired on the day after expiration, not on the day itself', () => {
    expect(policyState(policy({ expirationDate: iso(0) }), NOW).status).toBe('Renewal upcoming');
    expect(policyState(policy({ expirationDate: iso(-1) }), NOW).status).toBe('Expired');
  });

  it('lets the expiration date overrule a stale hand-set status', () => {
    const state = policyState(policy({ expirationDate: iso(-5), status: 'Active' }), NOW);
    expect(state.status).toBe('Expired');
    expect(state.needsAttention).toBe(true);
  });

  it('keeps a status only the user can know', () => {
    for (const status of ['Renewal in progress', 'Quote received'] as RenewalStatus[]) {
      const state = policyState(policy({ expirationDate: iso(5), status }), NOW);
      expect(state.status).toBe(status);
      expect(state.needsAttention).toBe(true);
    }
  });

  it('treats bound cover as settled even past the old expiration', () => {
    const state = policyState(policy({ expirationDate: iso(-3), status: 'Bound' }), NOW);
    expect(state.status).toBe('Bound');
    expect(state.needsAttention).toBe(false);
  });

  it('stays quiet when there is no date and nothing was selected', () => {
    const state = policyState(policy(), NOW);
    expect(state.status).toBe('Unknown');
    expect(state.days).toBeNull();
    expect(state.countdown).toBe('');
    expect(state.needsAttention).toBe(false);
  });

  it('never claims a renewal it cannot date', () => {
    expect(policyState(policy({ status: 'Active' }), NOW).countdown).toBe('');
  });
});

describe('selecting policies', () => {
  const db: Database = {
    ...emptyDatabase(),
    // Only the fields the renewal selectors read; the rest is not in play here.
    contacts: [{ id: 'c1', firstName: 'John', lastName: 'Smith' } as Contact],
    aircraft: [{ id: 'a1', tailNumber: 'N123AB' } as Aircraft],
    policies: [
      policy({ id: 'far', aircraftId: 'a1', expirationDate: iso(300) }),
      policy({ id: 'near', aircraftId: 'a1', contactId: 'c1', expirationDate: iso(20) }),
      policy({ id: 'undated', contactId: 'c1' }),
      policy({ id: 'lapsed', aircraftId: 'a1', expirationDate: iso(-40) }),
    ],
  };

  it('orders by urgency, with undated policies last', () => {
    const ordered = [...db.policies].sort(sortByUrgency).map((p) => p.id);
    expect(ordered).toEqual(['lapsed', 'near', 'far', 'undated']);
  });

  it('finds every policy on an aircraft, soonest first', () => {
    expect(policiesFor(db, { aircraftId: 'a1' }).map((p) => p.id)).toEqual(['lapsed', 'near', 'far']);
  });

  it('finds a policy held by a person even with no aircraft', () => {
    expect(policiesFor(db, { contactId: 'c1' }).map((p) => p.id)).toEqual(['near', 'undated']);
  });

  it('returns only what needs attention, most urgent first', () => {
    const items = renewalsNeedingAttention(db, NOW);
    expect(items.map((i) => i.policy.id)).toEqual(['lapsed', 'near']);
    expect(items[0].aircraft?.tailNumber).toBe('N123AB');
  });

  it('summarises the book', () => {
    expect(renewalSummary(db, NOW)).toEqual({ expired: 1, upcoming: 1, inProgress: 0, total: 4 });
  });
});

describe('labels', () => {
  it('names a policy by its carrier, then its number, then generically', () => {
    expect(policyLabel(policy({ carrier: 'Global Aerospace' }))).toBe('Global Aerospace');
    expect(policyLabel(policy({ policyNumber: 'GA-4417' }))).toBe('GA-4417');
    expect(policyLabel(policy())).toBe('Insurance policy');
  });

  it('summarises a policy in one line, skipping what it does not know', () => {
    expect(policySummary(policy({ carrier: 'Old Republic', expirationDate: iso(10) }), NOW))
      .toBe('Old Republic · Renewal in 10 days');
    expect(policySummary(policy({ carrier: 'Old Republic', hullValue: '$1.2M', expirationDate: iso(10) }), NOW))
      .toBe('Old Republic · Hull $1.2M · Renewal in 10 days');
  });
});
