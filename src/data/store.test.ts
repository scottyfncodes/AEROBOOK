/**
 * Store + persistence. Runs against fake-indexeddb, which implements the same
 * API the browser does, so "survives a reload" here means the document really
 * was written to and read back from an IndexedDB object store.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import * as store from './store';
import * as persistence from './db';
import { emptyDatabase } from './types';
import { addDays } from '../lib/dates';
import { contactsCsv, aircraftCsv, fullJson, parseFullJson } from '../lib/export';
import { parseCsv } from '../lib/csv';

beforeEach(async () => {
  await persistence.clearAll();
  store.__setStateForTests(emptyDatabase());
  await store.init();
});

describe('contacts', () => {
  it('creates, reads, updates and deletes', () => {
    const c = store.createContact({ firstName: 'John', lastName: 'Heine', email: 'JHEINE@Acentech.com' });
    expect(store.getState().contacts).toHaveLength(1);
    expect(c.email).toBe('jheine@acentech.com');
    expect(c.rawName).toBe('John Heine');

    store.updateContact(c.id, { status: 'Active Client', notes: 'Renewal in March' });
    const updated = store.getState().contacts[0];
    expect(updated.status).toBe('Active Client');
    expect(updated.notes).toBe('Renewal in March');
    expect(updated.updatedAt >= c.updatedAt).toBe(true);

    store.deleteContact(c.id);
    expect(store.getState().contacts).toHaveLength(0);
  });

  it('notifies subscribers', () => {
    let calls = 0;
    const unsubscribe = store.subscribe(() => calls++);
    store.createContact({ firstName: 'A' });
    expect(calls).toBe(1);
    unsubscribe();
    store.createContact({ firstName: 'B' });
    expect(calls).toBe(1);
  });
});

describe('aircraft and the owner relationship', () => {
  it('normalises the tail on create and on update', () => {
    const a = store.createAircraft({ tailNumber: 'n917jh', year: '2026', make: 'Cirrus', model: 'SR22T' });
    expect(a.tailNumber).toBe('N917JH');
    expect(a.tailKey).toBe('917JH');

    store.updateAircraft(a.id, { tailNumber: 'n441fp' });
    expect(store.getState().aircraft[0].tailNumber).toBe('N441FP');
    expect(store.getState().aircraft[0].tailKey).toBe('441FP');
  });

  it('finds an aircraft by any spelling of its tail', () => {
    store.createAircraft({ tailNumber: 'N917JH' });
    expect(store.findAircraftByTail('n917jh')).toBeDefined();
    expect(store.findAircraftByTail('917JH')).toBeDefined();
    expect(store.findAircraftByTail('N441FP')).toBeUndefined();
  });

  it('lets one person own several aircraft', () => {
    const owner = store.createContact({ firstName: 'John', lastName: 'Heine' });
    const a1 = store.createAircraft({ tailNumber: 'N917JH' });
    const a2 = store.createAircraft({ tailNumber: 'N451RK' });
    store.setAircraftOwner(a1.id, owner.id);
    store.setAircraftOwner(a2.id, owner.id);

    const owned = store.getState().aircraft.filter((a) => a.ownerships.some((o) => o.contactId === owner.id && !o.endedAt));
    expect(owned).toHaveLength(2);
  });

  it('keeps the previous owner in history when the aircraft changes hands', () => {
    const first = store.createContact({ firstName: 'John', lastName: 'Heine' });
    const second = store.createContact({ firstName: 'Marlon', lastName: 'Humphrey' });
    const a = store.createAircraft({ tailNumber: 'N917JH' });

    store.setAircraftOwner(a.id, first.id);
    store.setAircraftOwner(a.id, second.id);

    const ownerships = store.getState().aircraft[0].ownerships;
    expect(ownerships).toHaveLength(2);
    expect(ownerships.find((o) => !o.endedAt)!.contactId).toBe(second.id);
    expect(ownerships.find((o) => o.contactId === first.id)!.endedAt).toBeTruthy();
  });

  it('detaches an aircraft from a deleted contact without losing the aircraft', () => {
    const owner = store.createContact({ firstName: 'John' });
    const a = store.createAircraft({ tailNumber: 'N917JH' });
    store.setAircraftOwner(a.id, owner.id);
    store.deleteContact(owner.id);
    expect(store.getState().aircraft).toHaveLength(1);
    expect(store.getState().aircraft[0].ownerships).toEqual([]);
  });
});

describe('opportunities, activities and follow-ups', () => {
  it('supports several opportunities for one client', () => {
    const c = store.createContact({ firstName: 'John' });
    const a = store.createAircraft({ tailNumber: 'N917JH' });
    store.createOpportunity({ contactId: c.id, aircraftId: a.id, type: 'Insurance', title: 'Hull + liability' });
    store.createOpportunity({ contactId: c.id, type: 'Aircraft Purchase', title: 'Looking at a TBM' });
    expect(store.getState().opportunities.filter((o) => o.contactId === c.id)).toHaveLength(2);
  });

  it('records activities and stamps the last-contacted date', () => {
    const c = store.createContact({ firstName: 'John' });
    store.logActivity({ type: 'Email', subject: 'RE: N917JH', contactId: c.id, date: '2026-09-19' });
    expect(store.getState().activities).toHaveLength(1);
    expect(store.getState().contacts[0].lastContactedAt).toBe('2026-09-19');
  });

  it('does not stamp last-contacted for a note', () => {
    const c = store.createContact({ firstName: 'John' });
    store.logActivity({ type: 'Note', subject: 'Thinking about it', contactId: c.id });
    expect(store.getState().contacts[0].lastContactedAt).toBeUndefined();
  });

  it('completes and reschedules a follow-up', () => {
    const c = store.createContact({ firstName: 'John' });
    const f = store.createFollowUp({ contactId: c.id, dueDate: addDays(7), note: 'Follow up on SR22 quote' });
    store.completeFollowUp(f.id);
    expect(store.getState().followUps[0].completed).toBe(true);

    store.updateFollowUp(f.id, { dueDate: addDays(14), completed: false, completedAt: undefined });
    expect(store.getState().followUps[0].completed).toBe(false);
    expect(store.getState().followUps[0].dueDate).toBe(addDays(14));
  });
});

describe('templates', () => {
  it('seeds the built-in templates on first run', () => {
    expect(store.getState().templates.length).toBe(7);
    expect(store.getState().templates.every((t) => t.builtIn)).toBe(true);
  });

  it('edits a template and refuses to delete a built-in one', () => {
    const t = store.getState().templates[0];
    store.saveTemplate({ ...t, body: 'Custom body' });
    expect(store.getState().templates[0].body).toBe('Custom body');

    store.deleteTemplate(t.id);
    expect(store.getState().templates).toHaveLength(7);

    const mine = store.createTemplate('Mine');
    expect(store.getState().templates).toHaveLength(8);
    store.deleteTemplate(mine.id);
    expect(store.getState().templates).toHaveLength(7);
  });
});

describe('persistence', () => {
  it('survives a reload', async () => {
    const c = store.createContact({ firstName: 'John', lastName: 'Heine', email: 'j@h.com' });
    const a = store.createAircraft({ tailNumber: 'N917JH', year: '2026', make: 'Cirrus', model: 'SR22T' });
    store.setAircraftOwner(a.id, c.id);
    store.createFollowUp({ contactId: c.id, dueDate: addDays(7), note: 'Call back' });
    await store.flush();

    // Simulate closing and reopening the app.
    store.__setStateForTests(emptyDatabase());
    await store.init();

    const db = store.getState();
    expect(db.contacts).toHaveLength(1);
    expect(db.contacts[0].email).toBe('j@h.com');
    expect(db.aircraft[0].tailNumber).toBe('N917JH');
    expect(db.aircraft[0].ownerships[0].contactId).toBe(c.id);
    expect(db.followUps).toHaveLength(1);
    expect(db.templates).toHaveLength(7);
  });

  it('starts empty rather than failing when there is nothing stored', async () => {
    await persistence.clearAll();
    const db = await persistence.loadDatabase();
    expect(db.contacts).toEqual([]);
    expect(db.version).toBe(emptyDatabase().version);
  });

  it('fills in missing sections when loading an older document', () => {
    const migrated = persistence.migrate({ contacts: [{ id: 'c1' }] });
    expect(migrated.aircraft).toEqual([]);
    expect(migrated.settings.defaultNameOrder).toBe('lastFirst');
    expect(persistence.migrate(null).contacts).toEqual([]);
    expect(persistence.migrate('garbage').contacts).toEqual([]);
  });

  it('erases everything on request', async () => {
    store.createContact({ firstName: 'John' });
    await store.eraseEverything();
    expect(store.getState().contacts).toEqual([]);
    expect(store.getState().templates).toHaveLength(7);
  });
});

describe('export', () => {
  it('exports contacts as CSV that parses back', () => {
    const c = store.createContact({ firstName: 'John', lastName: 'Heine', email: 'j@h.com', city: 'Santa Barbara', state: 'CA', notes: 'Likes, commas' });
    const a = store.createAircraft({ tailNumber: 'N917JH', year: '2026', make: 'Cirrus', model: 'SR22T' });
    store.setAircraftOwner(a.id, c.id);

    const table = parseCsv(contactsCsv(store.getState()));
    expect(table.rows).toHaveLength(1);
    expect(table.headers).toContain('Email');
    const row = Object.fromEntries(table.headers.map((h, i) => [h, table.rows[0][i]]));
    expect(row['Last name']).toBe('Heine');
    expect(row['Notes']).toBe('Likes, commas');
    expect(row['Aircraft']).toBe('N917JH');
  });

  it('exports aircraft with their owner', () => {
    const c = store.createContact({ firstName: 'John', lastName: 'Heine', email: 'j@h.com' });
    const a = store.createAircraft({ tailNumber: 'N917JH', year: '2026', make: 'Cirrus', model: 'SR22T' });
    store.setAircraftOwner(a.id, c.id);

    const table = parseCsv(aircraftCsv(store.getState()));
    const row = Object.fromEntries(table.headers.map((h, i) => [h, table.rows[0][i]]));
    expect(row['Tail number']).toBe('N917JH');
    expect(row['Owner']).toBe('John Heine');
    expect(row['Owner email']).toBe('j@h.com');
  });

  it('round-trips the whole database as JSON', () => {
    store.createContact({ firstName: 'John', lastName: 'Heine' });
    store.createAircraft({ tailNumber: 'N917JH' });
    const json = fullJson(store.getState());
    const restored = parseFullJson(json);
    expect(restored.contacts).toHaveLength(1);
    expect(restored.aircraft).toHaveLength(1);

    store.replaceDatabase(restored);
    expect(store.getState().contacts).toHaveLength(1);
  });

  it('rejects a file that is not an AEROBOOK export', () => {
    expect(() => parseFullJson('{"nope":1}')).toThrow(/AEROBOOK export/);
    expect(() => parseFullJson('not json')).toThrow();
  });
});
