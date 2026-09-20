import { describe, expect, it } from 'vitest';
import { search, tokenize } from './search';
import { emptyDatabase, type Aircraft, type Contact, type Database, type Opportunity } from '../data/types';

function contact(patch: Partial<Contact>): Contact {
  return {
    id: 'c', firstName: '', lastName: '', rawName: '', company: '', email: '', phone: '',
    address: '', city: '', state: '', zip: '', contactTypes: [], status: 'Prospect',
    prospectStatus: 'New', notes: '', custom: {}, nameConfidence: 'high', needsReview: false,
    createdAt: '', updatedAt: '', ...patch,
  };
}

function aircraft(patch: Partial<Aircraft>): Aircraft {
  return {
    id: 'a', tailNumber: '', tailKey: '', year: '', make: '', model: '', ownerships: [],
    status: 'Unknown', notes: '', custom: {}, createdAt: '', updatedAt: '', ...patch,
  };
}

const db: Database = {
  ...emptyDatabase(),
  contacts: [
    contact({ id: 'c1', firstName: 'John', lastName: 'Heine', rawName: 'Heine John Charles', email: 'jheine@acentech.com', phone: '7818917648', city: 'Santa Barbara', state: 'CA', notes: 'Met at Oshkosh' }),
    contact({ id: 'c2', firstName: 'Marlon', lastName: 'Humphrey', city: 'Denver', state: 'CO', company: 'Woodbine Holdings' }),
  ],
  aircraft: [
    aircraft({ id: 'a1', tailNumber: 'N917JH', tailKey: '917JH', year: '2026', make: 'Cirrus', model: 'SR22T', ownerships: [{ contactId: 'c1' }] }),
    aircraft({ id: 'a2', tailNumber: 'N441FP', tailKey: '441FP', year: '2019', make: 'Cirrus', model: 'SR22', ownerships: [{ contactId: 'c2' }] }),
  ],
  opportunities: [
    { id: 'o1', contactId: 'c1', aircraftId: 'a1', type: 'Insurance', status: 'Quoting', title: 'Hull renewal', openedAt: '', notes: '', createdAt: '', updatedAt: '' } as Opportunity,
  ],
  policies: [
    {
      id: 'p1', aircraftId: 'a1', contactId: 'c1', opportunityId: 'o1',
      carrier: 'Global Aerospace', policyNumber: 'GA-4417', brokerAgent: '',
      premium: '', hullValue: '', liabilityLimit: '', deductible: '',
      status: 'Unknown', quotedPremium: '', renewalNotes: '', notes: '',
      createdAt: '', updatedAt: '',
    },
  ],
};

describe('search', () => {
  it('finds an aircraft and its owner by tail, in any case or format', () => {
    for (const q of ['N917JH', 'n917jh', '917jh', 'N-917-JH']) {
      const results = search(db, q);
      expect(results.some((r) => r.kind === 'aircraft' && r.id === 'a1')).toBe(true);
      expect(results.some((r) => r.kind === 'contact' && r.id === 'c1')).toBe(true);
    }
  });

  it('puts the aircraft first for a tail query', () => {
    expect(search(db, 'N917JH')[0].kind).toBe('aircraft');
  });

  it('finds a contact by last name', () => {
    expect(search(db, 'Heine').map((r) => r.id)).toContain('c1');
  });

  it('finds by company, city and state', () => {
    expect(search(db, 'Woodbine').map((r) => r.id)).toContain('c2');
    expect(search(db, 'Denver').map((r) => r.id)).toContain('c2');
    expect(search(db, 'Santa Barbara').map((r) => r.id)).toContain('c1');
  });

  it('finds by model, matching both SR22 aircraft for SR22', () => {
    expect(search(db, 'SR22').filter((r) => r.kind === 'aircraft')).toHaveLength(2);
    expect(search(db, 'SR22T').filter((r) => r.kind === 'aircraft')).toHaveLength(1);
  });

  it('finds by email, by phone and through formatting', () => {
    expect(search(db, 'jheine@acentech.com').map((r) => r.id)).toContain('c1');
    expect(search(db, 'acentech').map((r) => r.id)).toContain('c1');
    expect(search(db, '7818917648').map((r) => r.id)).toContain('c1');
    expect(search(db, '(781) 891-7648').map((r) => r.id)).toContain('c1');
  });

  it('finds notes and policy information', () => {
    expect(search(db, 'Oshkosh').map((r) => r.id)).toContain('c1');
    expect(search(db, 'Global Aerospace').map((r) => r.id)).toContain('o1');
    expect(search(db, 'GA-4417').map((r) => r.id)).toContain('o1');
  });

  it('narrows as tokens are added', () => {
    expect(search(db, 'cirrus').length).toBeGreaterThan(search(db, 'cirrus sr22t').length);
    expect(search(db, 'heine 917jh').some((r) => r.id === 'a1')).toBe(true);
  });

  it('returns nothing for an empty or unmatched query', () => {
    expect(search(db, '')).toEqual([]);
    expect(search(db, '   ')).toEqual([]);
    expect(search(db, 'zzzznothing')).toEqual([]);
  });

  it('copes with an empty database', () => {
    expect(search(emptyDatabase(), 'anything')).toEqual([]);
  });

  it('respects the result limit', () => {
    expect(search(db, 'cirrus', 1)).toHaveLength(1);
  });
});

describe('tokenize', () => {
  it('splits on whitespace and drops empties', () => {
    expect(tokenize('  heine   sr22t ')).toEqual(['heine', 'sr22t']);
    expect(tokenize('')).toEqual([]);
  });
});
