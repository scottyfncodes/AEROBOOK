import { describe, expect, it } from 'vitest';
import { applyRecords, diffDatabases } from './sync';
import { emptyDatabase, type Contact } from './types';

const contact = (id: string, firstName: string) => ({ id, firstName }) as unknown as Contact;

describe('working out what to send', () => {
  it('sends nothing when nothing changed', () => {
    const db = { ...emptyDatabase(), contacts: [contact('c1', 'John')] };
    expect(diffDatabases(db, db, 'u1')).toEqual([]);
  });

  it('does not send a record rebuilt without changing', () => {
    const before = { ...emptyDatabase(), contacts: [contact('c1', 'John')] };
    const after = { ...before, contacts: [contact('c1', 'John')] };
    expect(diffDatabases(before, after, 'u1')).toEqual([]);
  });

  it('treats a record back from the server with its keys reordered as unchanged', () => {
    const before = { ...emptyDatabase(), contacts: [{ lastName: 'Heine', id: 'c1', firstName: 'John' } as unknown as Contact] };
    const after = { ...before, contacts: [{ id: 'c1', firstName: 'John', lastName: 'Heine', notes: undefined } as unknown as Contact] };
    expect(diffDatabases(before, after, 'u1')).toEqual([]);
  });

  it('sends additions, edits and deletions', () => {
    const before = { ...emptyDatabase(), contacts: [contact('c1', 'John'), contact('c2', 'Jane')] };
    const after = { ...before, contacts: [contact('c1', 'Johnny'), contact('c3', 'Ann')] };
    expect(diffDatabases(before, after, 'u1')).toEqual([
      { collection: 'contacts', id: 'c1', data: contact('c1', 'Johnny') },
      { collection: 'contacts', id: 'c3', data: contact('c3', 'Ann') },
      { collection: 'contacts', id: 'c2', data: null },
    ]);
  });

  it('sends settings as the signed-in person’s own', () => {
    const before = emptyDatabase();
    const after = { ...before, settings: { ...before.settings, senderName: 'Scott' } };
    expect(diffDatabases(before, after, 'u1')).toEqual([{ collection: 'settings', id: 'u1', data: after.settings }]);
  });

  it('never sends documents, which stay on the device', () => {
    const before = emptyDatabase();
    const after = { ...before, files: [{ id: 'f1' } as never] };
    expect(diffDatabases(before, after, 'u1')).toEqual([]);
  });
});

describe('laying records over the database', () => {
  it('replaces in place, adds to the end and removes deletions', () => {
    const db = { ...emptyDatabase(), contacts: [contact('c1', 'John'), contact('c2', 'Jane')] };
    const next = applyRecords(db, [
      { collection: 'contacts', id: 'c3', data: contact('c3', 'Ann') as never },
      { collection: 'contacts', id: 'c1', data: contact('c1', 'Johnny') as never },
      { collection: 'contacts', id: 'c2', data: null },
    ]);
    expect(next.contacts).toEqual([contact('c1', 'Johnny'), contact('c3', 'Ann')]);
    expect(db.contacts).toHaveLength(2);
  });

  it('leaves untouched collections as the same objects', () => {
    const db = emptyDatabase();
    const next = applyRecords(db, [{ collection: 'contacts', id: 'c1', data: contact('c1', 'John') as never }]);
    expect(next.aircraft).toBe(db.aircraft);
  });

  it('ignores collections it does not know', () => {
    const db = emptyDatabase();
    expect(applyRecords(db, [{ collection: 'nope' as never, id: 'x', data: { id: 'x' } }])).toEqual(db);
  });
});
