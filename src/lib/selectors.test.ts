import { describe, expect, it } from 'vitest';
import { documentsFor, followUpsInView, isMine } from './selectors';
import { emptyDatabase, type Aircraft, type Contact, type Database, type FileRecord, type FollowUp, type Opportunity } from '../data/types';

const t = '2026-09-21T00:00:00.000Z';

function contact(id: string, firstName: string, lastName: string): Contact {
  return {
    id, firstName, lastName, rawName: `${firstName} ${lastName}`, company: '', email: '', phone: '', address: '',
    city: '', state: '', zip: '', contactTypes: [], status: 'Lead', prospectStatus: 'New', notes: '', custom: {},
    nameConfidence: 'high', needsReview: false, createdAt: t, updatedAt: t,
  };
}

function file(id: string, name: string, links: Partial<FileRecord>, createdAt = t): FileRecord {
  return {
    id, name, mimeType: 'application/pdf', size: name.length * 1000, contactId: null, aircraftId: null,
    opportunityId: null, insurancePolicyId: null, category: 'Insurance', createdAt, ...links,
  };
}

/**
 * Shaped after a live account: documents were attached to the deal, not the
 * person, and the same binder was uploaded to both the aircraft and the deal
 * so it would show in both places.
 */
function book(): Database {
  const plane: Aircraft = {
    id: 'a1', tailNumber: 'N8154N', tailKey: '8154N', year: '1968', make: 'Piper', model: 'Cherokee 140B',
    ownerships: [{ contactId: 'c2' }], status: 'Owned', notes: '', custom: {}, createdAt: t, updatedAt: t,
  };
  const deal = (id: string, contactId: string, aircraftId: string | null, title: string): Opportunity => ({
    id, contactId, aircraftId, type: 'Insurance', status: 'Quoting', title, openedAt: t, notes: '', createdAt: t, updatedAt: t,
  });
  return {
    ...emptyDatabase(),
    contacts: [contact('c1', 'Pat', 'Quinn'), contact('c2', 'Lee', 'Rowe'), contact('c3', 'Sam', 'Other')],
    aircraft: [plane],
    opportunities: [deal('o1', 'c1', null, 'Pat Quinn quote'), deal('o2', 'c2', 'a1', 'Lee Rowe N8154N')],
    files: [
      file('f1', 'Quote.pdf', { opportunityId: 'o1' }),
      file('f2', 'Pilot history.pdf', { opportunityId: 'o1' }),
      file('f3', 'Binder.pdf', { aircraftId: 'a1' }),
      file('f4', 'Binder.pdf', { opportunityId: 'o2' }, '2026-09-22T00:00:00.000Z'),
      file('f5', 'Unrelated.pdf', { contactId: 'c3' }),
    ],
  };
}

describe('documentsFor', () => {
  it("shows a deal's documents on the person it is for", () => {
    const docs = documentsFor(book(), { contactId: 'c1' });
    expect(docs.map((d) => d.file.id).sort()).toEqual(['f1', 'f2']);
    expect(docs.every((d) => d.via === 'Pat Quinn quote')).toBe(true);
  });

  it("shows the aircraft's documents on the deal, and the same file once", () => {
    const docs = documentsFor(book(), { opportunityId: 'o2' });
    expect(docs).toEqual([{ file: expect.objectContaining({ id: 'f4' }), via: undefined }]);
  });

  it('labels a document attached elsewhere by where it lives', () => {
    const db = book();
    db.files = db.files.filter((f) => f.id !== 'f4');
    expect(documentsFor(db, { opportunityId: 'o2' })).toEqual([
      { file: expect.objectContaining({ id: 'f3' }), via: 'N8154N' },
    ]);
  });

  it("does not pull in another person's documents", () => {
    expect(documentsFor(book(), { contactId: 'c2' }).map((d) => d.file.name)).toEqual(['Binder.pdf']);
    expect(documentsFor(book(), { contactId: 'c3' }).map((d) => d.file.id)).toEqual(['f5']);
  });
});

describe('whose follow-ups', () => {
  const now = new Date(2026, 8, 29, 12);
  const fu = (id: string, dueDate: string, assigneeId?: string | null, completed = false): FollowUp => ({
    id, contactId: null, aircraftId: null, opportunityId: null, dueDate, note: id, assigneeId, completed,
    createdAt: t, updatedAt: t,
  });
  const db = {
    followUps: [
      fu('mine-late', '2026-09-20', 'me'),
      fu('mine-soon', '2026-10-02', 'me'),
      fu('theirs-late', '2026-09-21', 'them'),
      fu('theirs-soon', '2026-10-03', 'them'),
      fu('nobodys', '2026-10-01', null),
      fu('from-before-accounts', '2026-10-01'),
      fu('mine-done', '2026-09-01', 'me', true),
    ],
  };
  const ids = (list: FollowUp[]) => list.map((f) => f.id);

  it('counts unassigned work as everyone\'s until someone takes it', () => {
    expect(isMine({ assigneeId: 'me' }, 'me')).toBe(true);
    expect(isMine({ assigneeId: 'them' }, 'me')).toBe(false);
    expect(isMine({ assigneeId: null }, 'me')).toBe(true);
    expect(isMine({}, 'me')).toBe(true);
  });

  it('Mine shows my open follow-ups and the unassigned ones', () => {
    expect(ids(followUpsInView(db, 'mine', 'me', now))).toEqual(['mine-late', 'mine-soon', 'nobodys', 'from-before-accounts']);
  });

  it('All shows every open follow-up', () => {
    expect(followUpsInView(db, 'all', 'me', now)).toHaveLength(6);
  });

  it('Overdue shows the whole team\'s overdue work', () => {
    expect(ids(followUpsInView(db, 'overdue', 'me', now))).toEqual(['mine-late', 'theirs-late']);
  });
});
