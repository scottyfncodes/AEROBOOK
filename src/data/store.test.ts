/**
 * Store + persistence. Runs against fake-indexeddb, which implements the same
 * API the browser does, so "survives a reload" here means the document really
 * was written to and read back from an IndexedDB object store.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import * as store from './store';
import { defaultTemplates } from '../lib/email';
import * as persistence from './db';
import { emptyDatabase, emptyIntent, hasIntent } from './types';
import { policiesFor, policyState } from '../lib/insurance';
import { bucketFollowUps, openFollowUps, openOpportunities, pipeline } from '../lib/selectors';
import { search } from '../lib/search';
import { addDays } from '../lib/dates';
import { contactsCsv, aircraftCsv, fullJson, parseFullJson } from '../lib/export';
import { parseCsv } from '../lib/csv';

beforeEach(async () => {
  // Let the previous test's writes land before wiping, so nothing arrives late.
  await store.flush();
  store.__setStateForTests(emptyDatabase());
  await persistence.clearAll();
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
    expect(store.getState().templates.length).toBe(defaultTemplates('').length);
    expect(store.getState().templates.every((t) => t.builtIn)).toBe(true);
  });

  it('edits a template and refuses to delete a built-in one', () => {
    const t = store.getState().templates[0];
    store.saveTemplate({ ...t, body: 'Custom body' });
    expect(store.getState().templates[0].body).toBe('Custom body');

    store.deleteTemplate(t.id);
    expect(store.getState().templates).toHaveLength(defaultTemplates('').length);

    const mine = store.createTemplate('Mine');
    expect(store.getState().templates).toHaveLength(defaultTemplates('').length + 1);
    store.deleteTemplate(mine.id);
    expect(store.getState().templates).toHaveLength(defaultTemplates('').length);
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
    expect(db.templates).toHaveLength(defaultTemplates('').length);
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
    expect(store.getState().templates).toHaveLength(defaultTemplates('').length);
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

  it('migrates an older backup on the way back in', () => {
    // A version 1 export: no policies section, and the old insurance blob.
    const v1Backup = JSON.stringify({
      version: 1,
      contacts: [{ id: 'c1', firstName: 'John', lastName: 'Smith' }],
      aircraft: [{ id: 'a1', tailNumber: 'N123AB', tailKey: '123AB' }],
      opportunities: [
        {
          id: 'o1', contactId: 'c1', aircraftId: 'a1', type: 'Both', status: 'Quote',
          title: 'Renewal', openedAt: '', notes: '', createdAt: '', updatedAt: '',
          insurance: { carrier: 'Global Aerospace', renewalDate: '2026-11-02' },
        },
      ],
    });

    const restored = parseFullJson(v1Backup);
    expect(restored.policies).toHaveLength(1);
    expect(restored.policies[0].carrier).toBe('Global Aerospace');
    expect(restored.opportunities[0].status).toBe('Quoting');

    store.replaceDatabase(restored);
    expect(store.getState().policies).toHaveLength(1);
    expect(store.getState().layoverSpots).toEqual([]);
  });

  it('rejects a file that is not an AEROBOOK export', () => {
    expect(() => parseFullJson('{"nope":1}')).toThrow(/AEROBOOK export/);
    expect(() => parseFullJson('not json')).toThrow();
  });
});

describe('insurance policies', () => {
  it('attaches a policy to an aircraft and its owner, and finds it from both', () => {
    const contact = store.createContact({ firstName: 'John', lastName: 'Smith' });
    const aircraft = store.createAircraft({ tailNumber: 'N123AB' });
    store.setAircraftOwner(aircraft.id, contact.id);

    const policy = store.createPolicy({
      aircraftId: aircraft.id,
      contactId: contact.id,
      carrier: 'Global Aerospace',
      expirationDate: addDays(47),
    });

    expect(policiesFor(store.getState(), { aircraftId: aircraft.id })).toEqual([policy]);
    expect(policiesFor(store.getState(), { contactId: contact.id })).toEqual([policy]);
    expect(policyState(policy).status).toBe('Renewal upcoming');
    expect(policyState(policy).countdown).toBe('Renewal in 47 days');
  });

  it('updates a policy without touching the rest of the document', () => {
    const aircraft = store.createAircraft({ tailNumber: 'N999ZZ' });
    const policy = store.createPolicy({ aircraftId: aircraft.id, carrier: 'Old Republic' });

    store.updatePolicy(policy.id, { premium: '$14,200', status: 'Quote received' });
    const saved = store.getState().policies.find((p) => p.id === policy.id)!;

    expect(saved.premium).toBe('$14,200');
    expect(saved.carrier).toBe('Old Republic');
    expect(saved.updatedAt >= policy.updatedAt).toBe(true);
    expect(store.getState().aircraft).toHaveLength(1);
  });

  it('removes a policy with its aircraft, because a renewal alone is unusable', () => {
    const aircraft = store.createAircraft({ tailNumber: 'N42X' });
    store.createPolicy({ aircraftId: aircraft.id, carrier: 'Starr' });

    store.deleteAircraft(aircraft.id);
    expect(store.getState().policies).toHaveLength(0);
  });

  it('keeps a policy when the deal it was worked under is deleted', () => {
    const opportunity = store.createOpportunity({ title: 'Renewal' });
    const policy = store.createPolicy({ opportunityId: opportunity.id, carrier: 'USAIG' });

    store.deleteOpportunity(opportunity.id);
    const saved = store.getState().policies.find((p) => p.id === policy.id)!;
    expect(saved).toBeDefined();
    expect(saved.opportunityId).toBeNull();
  });

  it('detaches, rather than deletes, a policy whose holder is removed', () => {
    const contact = store.createContact({ firstName: 'Jane' });
    const aircraft = store.createAircraft({ tailNumber: 'N7PC' });
    store.createPolicy({ aircraftId: aircraft.id, contactId: contact.id, carrier: 'Avemco' });

    store.deleteContact(contact.id);
    expect(store.getState().policies).toHaveLength(1);
    expect(store.getState().policies[0].contactId).toBeNull();
    expect(store.getState().policies[0].aircraftId).toBe(aircraft.id);
  });
});

describe('the pipeline', () => {
  it('records a stage change on the timeline', () => {
    const contact = store.createContact({ firstName: 'John' });
    const opportunity = store.createOpportunity({ contactId: contact.id, status: 'Lead', title: 'PC-12 sale' });

    store.setOpportunityStatus(opportunity.id, 'Quoting');

    expect(store.getState().opportunities[0].status).toBe('Quoting');
    const activity = store.getState().activities.find((a) => a.type === 'Status Change')!;
    expect(activity.subject).toBe('Lead → Quoting');
    expect(activity.opportunityId).toBe(opportunity.id);
    expect(activity.contactId).toBe(contact.id);
  });

  it('does not record a move to the stage it is already in', () => {
    const opportunity = store.createOpportunity({ status: 'Lead' });
    store.setOpportunityStatus(opportunity.id, 'Lead');
    expect(store.getState().activities).toHaveLength(0);
  });

  it('separates open deals from the ones that are done', () => {
    store.createOpportunity({ status: 'Negotiating', title: 'a' });
    store.createOpportunity({ status: 'Lead', title: 'b' });
    store.createOpportunity({ status: 'Won', title: 'c' });
    store.createOpportunity({ status: 'Future', title: 'd' });

    // Nearest a decision first.
    expect(openOpportunities(store.getState()).map((o) => o.title)).toEqual(['a', 'b']);
    expect(pipeline(store.getState()).open).toBe(2);
    expect(pipeline(store.getState()).won).toBe(1);
  });
});

describe('completing a follow-up', () => {
  it('records the outcome on the timeline of everything it was attached to', () => {
    const contact = store.createContact({ firstName: 'John' });
    const aircraft = store.createAircraft({ tailNumber: 'N123AB' });
    const followUp = store.createFollowUp({
      contactId: contact.id,
      aircraftId: aircraft.id,
      dueDate: addDays(0),
      note: 'Call about the renewal',
    });

    store.completeFollowUp(followUp.id, true, 'Left a voicemail. Call back after the 15th.');

    const saved = store.getState().followUps[0];
    expect(saved.completed).toBe(true);
    expect(saved.outcome).toBe('Left a voicemail. Call back after the 15th.');

    const activity = store.getState().activities.find((a) => a.type === 'Follow-Up')!;
    expect(activity.subject).toBe('Call about the renewal');
    expect(activity.notes).toContain('voicemail');
    expect(activity.contactId).toBe(contact.id);
    expect(activity.aircraftId).toBe(aircraft.id);
  });

  it('completes in one tap with nothing to say', () => {
    const followUp = store.createFollowUp({ dueDate: addDays(0), note: 'Check in' });
    store.completeFollowUp(followUp.id);
    expect(store.getState().followUps[0].completed).toBe(true);
    expect(store.getState().followUps[0].outcome).toBeUndefined();
  });

  it('reopening clears the completion without erasing the history', () => {
    const followUp = store.createFollowUp({ dueDate: addDays(0), note: 'Check in' });
    store.completeFollowUp(followUp.id, true, 'Spoke to him.');
    store.completeFollowUp(followUp.id, false);

    expect(store.getState().followUps[0].completed).toBe(false);
    expect(store.getState().followUps[0].completedAt).toBeUndefined();
    expect(store.getState().activities.filter((a) => a.type === 'Follow-Up')).toHaveLength(1);
  });

  it('sorts follow-ups into the buckets a working day is made of', () => {
    store.createFollowUp({ dueDate: addDays(-3), note: 'late' });
    store.createFollowUp({ dueDate: addDays(0), note: 'today' });
    store.createFollowUp({ dueDate: addDays(4), note: 'this week' });
    store.createFollowUp({ dueDate: addDays(7), note: 'edge of the week' });
    store.createFollowUp({ dueDate: addDays(30), note: 'later' });

    const buckets = bucketFollowUps(openFollowUps(store.getState()));
    expect(buckets.overdue.map((f) => f.note)).toEqual(['late']);
    expect(buckets.today.map((f) => f.note)).toEqual(['today']);
    expect(buckets.upcoming.map((f) => f.note)).toEqual(['this week', 'edge of the week']);
    expect(buckets.later.map((f) => f.note)).toEqual(['later']);
  });
});

describe('what a person wants', () => {
  it('stores intent and finds the contact by what they are looking for', () => {
    const contact = store.createContact({ firstName: 'John', lastName: 'Smith' });
    store.updateContact(contact.id, {
      intent: {
        selling: 'Actively',
        sellingNotes: 'PC-12, wants 4M',
        buying: 'Maybe',
        wantedAircraft: 'Pilatus PC-24',
        budget: '$9M',
        timeline: 'Next spring',
        insurance: 'Actively',
      },
    });

    const saved = store.getState().contacts[0];
    expect(saved.intent?.wantedAircraft).toBe('Pilatus PC-24');
    expect(hasIntent(saved.intent)).toBe(true);

    const results = search(store.getState(), 'PC-24');
    expect(results.some((r) => r.kind === 'contact' && r.id === contact.id)).toBe(true);
  });

  it('knows the difference between "nothing recorded" and "not interested"', () => {
    expect(hasIntent(undefined)).toBe(false);
    expect(hasIntent(emptyIntent())).toBe(false);
    expect(hasIntent({ ...emptyIntent(), selling: 'Not now' })).toBe(true);
  });
});
