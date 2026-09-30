import { describe, expect, it } from 'vitest';
import { byDay, groupHistory, locate, noun, verb, type HistoryEntry } from './history';
import { emptyDatabase } from '../data/types';

let nextId = 1000;
const entry = (over: Partial<HistoryEntry>): HistoryEntry => ({
  id: nextId--, at: '2026-09-29T17:00:00.000Z', userId: 'u1', userName: 'Scott', action: 'create',
  collection: 'contacts', recordId: 'con_1', summary: 'Acme Aviation', ...over,
});

describe('saying what happened', () => {
  it('uses the words a person would', () => {
    expect(`${verb('create', 'contacts')} ${noun('contacts')}`).toBe('created contact');
    expect(`${verb('update', 'aircraft')} ${noun('aircraft')}`).toBe('edited aircraft');
    expect(`${verb('delete', 'followUps')} ${noun('followUps')}`).toBe('deleted follow-up');
    expect(`${verb('create', 'activities')} ${noun('activities')}`).toBe('added timeline entry');
    expect(`${verb('delete', 'activities')} ${noun('activities')}`).toBe('removed timeline entry');
    expect(noun('contacts', 115)).toBe('contacts');
    expect(noun('somethingNew')).toBe('record');
  });
});

describe('grouping a burst of the same thing', () => {
  it('collapses an import into one line, and keeps separate things separate', () => {
    const at = (s: number) => new Date(Date.UTC(2026, 8, 29, 17, 0, s)).toISOString();
    const lines = groupHistory([
      entry({ at: at(50), action: 'update', collection: 'aircraft', summary: 'N917JH' }),
      entry({ at: at(40), recordId: 'con_3', summary: 'C' }),
      entry({ at: at(39), recordId: 'con_2', summary: 'B' }),
      entry({ at: at(38), recordId: 'con_1', summary: 'A' }),
      entry({ at: at(37), userId: 'u2', userName: 'Ellen', recordId: 'con_0', summary: 'Z' }),
    ]);
    expect(lines.map((l) => [l.userName, l.action, l.collection, l.entries.length])).toEqual([
      ['Scott', 'update', 'aircraft', 1],
      ['Scott', 'create', 'contacts', 3],
      ['Ellen', 'create', 'contacts', 1],
    ]);
    expect(lines[1].entries.map((e) => e.summary)).toEqual(['C', 'B', 'A']);
    expect(lines[1].at).toBe(at(40));
  });

  it('does not join the same action done far apart in time', () => {
    const lines = groupHistory([
      entry({ at: '2026-09-29T17:10:00.000Z', recordId: 'con_2' }),
      entry({ at: '2026-09-29T17:00:00.000Z', recordId: 'con_1' }),
    ]);
    expect(lines).toHaveLength(2);
  });

  it('heads each day, newest first', () => {
    const now = new Date(2026, 8, 29, 18);
    const days = byDay(groupHistory([
      entry({ at: new Date(2026, 8, 29, 9).toISOString() }),
      entry({ at: new Date(2026, 8, 28, 9).toISOString(), action: 'update' }),
      entry({ at: new Date(2026, 8, 20, 9).toISOString(), action: 'delete' }),
    ]), now);
    expect(days.map((d) => d.label)).toEqual(['Today', 'Yesterday', 'Sep 20']);
  });
});

describe('finding the record an entry is about', () => {
  const db = {
    ...emptyDatabase(),
    contacts: [{ id: 'con_1', firstName: 'John', lastName: 'Heine' } as never],
    aircraft: [{ id: 'air_1', tailNumber: 'n917jh' } as never],
    activities: [{ id: 'act_1', aircraftId: 'air_1', contactId: 'con_1', opportunityId: null } as never],
    followUps: [{ id: 'fup_1', aircraftId: null, contactId: 'con_1', opportunityId: null } as never],
  };

  it('links a record that still exists', () => {
    expect(locate(db, 'contacts', 'con_1')).toEqual({ to: '/contacts/con_1' });
    expect(locate(db, 'aircraft', 'air_1')).toEqual({ to: '/aircraft/air_1' });
  });

  it('takes a comment entry to the aircraft’s comments', () => {
    expect(locate(db, 'aircraftComments', 'air_1')).toEqual({ to: '/aircraft/air_1#comments' });
    expect(locate(db, 'aircraftComments', 'air_gone')).toEqual({});
    expect(`${verb('create', 'aircraftComments')} ${noun('aircraftComments')}`).toBe('added a comment on');
    expect(`${verb('update', 'aircraftComments')} ${noun('aircraftComments')}`).toBe('edited a comment on');
    expect(`${verb('delete', 'aircraftComments')} ${noun('aircraftComments', 3)}`).toBe('removed comments on');
  });

  it('says what a timeline entry or follow-up was on', () => {
    expect(locate(db, 'activities', 'act_1')).toEqual({ to: '/aircraft/air_1', context: 'N917JH' });
    expect(locate(db, 'followUps', 'fup_1')).toEqual({ to: '/contacts/con_1', context: 'John Heine' });
  });

  it('has nowhere to go for a deleted record, a template or an import', () => {
    expect(locate(db, 'contacts', 'con_gone')).toEqual({ to: undefined });
    expect(locate(db, 'activities', 'act_gone')).toEqual({});
    expect(locate(db, 'templates', 'tpl_1')).toEqual({});
  });
});
