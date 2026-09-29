import { describe, expect, it } from 'vitest';
import { documentsFor } from './selectors';
import { emptyDatabase, type Aircraft, type Contact, type Database, type FileRecord, type Opportunity } from '../data/types';

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
