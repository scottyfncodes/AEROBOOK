/**
 * Version 1 → 2. The user's data lives in their browser, so a migration that
 * silently drops a field is data loss they cannot undo. These tests describe
 * what version 1 documents contained and assert that every part of them ends
 * up somewhere.
 */
import { describe, expect, it } from 'vitest';
import { migrate } from './db';
import { DB_VERSION, emptyDatabase } from './types';

/** A version 1 document, exactly as the old app wrote it. */
const v1 = {
  version: 1,
  contacts: [{ id: 'c1', firstName: 'John', lastName: 'Smith' }],
  aircraft: [{ id: 'a1', tailNumber: 'N123AB', tailKey: '123AB' }],
  opportunities: [
    {
      id: 'o1',
      contactId: 'c1',
      aircraftId: 'a1',
      type: 'Both',
      status: 'Quote',
      title: 'N123AB — hull and liability',
      openedAt: '2026-01-04T00:00:00.000Z',
      followUpDate: '2026-03-01',
      notes: 'Wants a higher hull value.',
      insurance: {
        currentInsurer: 'Old Republic',
        policyNumber: 'OR-9912',
        renewalDate: '2026-04-15',
        policyStatus: 'In force',
        premium: '$14,200',
        hullValue: '$1,250,000',
        liabilityLimit: '$5M smooth',
        deductible: '$5,000',
        coverageNotes: 'Two named pilots.',
      },
      createdAt: '2026-01-04T00:00:00.000Z',
      updatedAt: '2026-01-04T00:00:00.000Z',
    },
    { id: 'o2', contactId: 'c1', aircraftId: null, type: 'Insurance', status: 'Open', title: '', openedAt: '', notes: '', createdAt: '', updatedAt: '' },
    { id: 'o3', contactId: null, aircraftId: null, type: 'Other', status: 'Closed', title: '', openedAt: '', notes: '', createdAt: '', updatedAt: '' },
  ],
  activities: [],
  followUps: [],
  templates: [],
  files: [{ id: 'f1', name: 'dec-page.pdf', mimeType: 'application/pdf', size: 1024, contactId: 'c1', aircraftId: null, opportunityId: null, createdAt: '' }],
  imports: [],
  layoverSpots: [],
  settings: { senderName: 'Scott' },
};

describe('migrate v1 → v2', () => {
  const db = migrate(structuredClone(v1));

  it('stamps the current version', () => {
    expect(db.version).toBe(DB_VERSION);
  });

  it('lifts the insurance blob into a policy of its own', () => {
    expect(db.policies).toHaveLength(1);
    const p = db.policies[0];
    expect(p.opportunityId).toBe('o1');
    expect(p.aircraftId).toBe('a1');
    expect(p.contactId).toBe('c1');
    expect(p.carrier).toBe('Old Republic');
    expect(p.policyNumber).toBe('OR-9912');
    expect(p.expirationDate).toBe('2026-04-15');
    expect(p.premium).toBe('$14,200');
    expect(p.hullValue).toBe('$1,250,000');
    expect(p.liabilityLimit).toBe('$5M smooth');
    expect(p.deductible).toBe('$5,000');
    expect(p.notes).toBe('Two named pilots.');
  });

  it('keeps the old free-text policy status rather than guessing an enum', () => {
    expect(db.policies[0].renewalNotes).toContain('In force');
    expect(db.policies[0].status).toBe('Unknown');
  });

  it('turns the orphan followUpDate into a follow-up that actually appears', () => {
    expect(db.followUps).toHaveLength(1);
    expect(db.followUps[0]).toMatchObject({
      opportunityId: 'o1',
      contactId: 'c1',
      aircraftId: 'a1',
      dueDate: '2026-03-01',
      completed: false,
    });
    expect(db.followUps[0].note).toContain('N123AB');
  });

  it('maps the old pipeline onto the new one', () => {
    const byId = new Map(db.opportunities.map((o) => [o.id, o]));
    expect(byId.get('o1')?.status).toBe('Quoting');
    expect(byId.get('o2')?.status).toBe('Lead');
    expect(byId.get('o3')?.status).toBe('Lost');
  });

  it('splits the ambiguous "Both" type into sale plus insurance', () => {
    expect(db.opportunities[0].type).toBe('Sale + Insurance');
  });

  it('drops the converted fields from the opportunity', () => {
    const o = db.opportunities[0] as unknown as Record<string, unknown>;
    expect(o.insurance).toBeUndefined();
    expect(o.followUpDate).toBeUndefined();
  });

  it('keeps everything else on the opportunity', () => {
    expect(db.opportunities[0].title).toBe('N123AB — hull and liability');
    expect(db.opportunities[0].notes).toBe('Wants a higher hull value.');
  });

  it('gives existing documents a category', () => {
    expect(db.files[0].category).toBe('Other');
    expect(db.files[0].name).toBe('dec-page.pdf');
  });

  it('keeps the user settings it already had', () => {
    expect(db.settings.senderName).toBe('Scott');
    expect(db.settings.theme).toBe(emptyDatabase().settings.theme);
  });

  it('is idempotent — migrating twice creates nothing new', () => {
    const twice = migrate(structuredClone(db));
    expect(twice.policies).toHaveLength(1);
    expect(twice.followUps).toHaveLength(1);
    expect(twice.opportunities.map((o) => o.status)).toEqual(['Quoting', 'Lead', 'Lost']);
  });

  it('creates no policy for an opportunity whose insurance blob was empty', () => {
    const empty = migrate({
      ...structuredClone(v1),
      opportunities: [{ ...structuredClone(v1.opportunities[0]), insurance: { carrier: '', premium: '   ' } }],
    });
    expect(empty.policies).toHaveLength(0);
  });

  it('survives a document that is not a document at all', () => {
    expect(migrate(null)).toEqual(emptyDatabase());
    expect(migrate('nonsense')).toEqual(emptyDatabase());
    expect(migrate(42)).toEqual(emptyDatabase());
  });

  it('fills in a section a v1 document never had', () => {
    const partial = migrate({ version: 1, contacts: [{ id: 'c9' }] });
    expect(partial.policies).toEqual([]);
    expect(partial.aircraft).toEqual([]);
    expect(partial.contacts).toHaveLength(1);
  });
});
