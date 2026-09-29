/**
 * The app's sync engine against the real API and a real Postgres. One person
 * uses the app (the store); a second works through the API directly, as
 * another phone would.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { api, createUser, freshDatabase, ORIGIN, signIn, TEST_DB } from './testing.js';
import { handle } from './app.js';
import * as store from '../src/data/store';
import * as persistence from '../src/data/db';
import { CloudSync, localDataToUpload, SessionExpired, type CloudUser } from '../src/data/cloud';
import { emptyDatabase } from '../src/data/types';

function deviceFetch(cookie: string): typeof fetch {
  return (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set('cookie', cookie);
    headers.set('origin', ORIGIN);
    return handle(new Request(`${ORIGIN}${String(input)}`, { ...init, headers }));
  };
}

describe.skipIf(!TEST_DB)('cloud sync', () => {
  let alice: CloudUser;
  let aliceCookie: string;
  let bobCookie: string;
  let cloud: CloudSync;

  const bobPush = (changes: unknown[]) => api('/api/sync', { body: { changes }, cookie: bobCookie }).then((r) => r.json());
  const bobPull = () => api('/api/sync?since=0&full=1', { cookie: bobCookie }).then((r) => r.json());
  const bobSees = async (collection: string, id: string) =>
    (await bobPull()).records.find((r: { collection: string; id: string }) => r.collection === collection && r.id === id);

  beforeEach(async () => {
    await freshDatabase();
    await store.unload();
    await persistence.clearAll();
    const a = await createUser('Alice Pilot', 'alice@example.com', 'admin');
    await createUser('Bob', 'bob@example.com');
    alice = { id: a.id, name: a.name, email: a.email, role: 'admin' };
    aliceCookie = await signIn('alice@example.com');
    bobCookie = await signIn('bob@example.com');
    cloud = new CloudSync(alice, deviceFetch(aliceCookie));
  });

  afterEach(async () => {
    cloud.stop();
    await store.unload();
  });

  it('starts a new account with the templates and a signature from the account', async () => {
    await cloud.start();
    const db = store.getState();
    expect(db.templates.length).toBeGreaterThan(5);
    expect(db.settings.senderName).toBe('Alice Pilot');
    expect(await bobSees('templates', 'tpl_initial_outreach')).toBeTruthy();
  });

  it('sends what one person records to everyone else', async () => {
    await cloud.start();
    const c = store.createContact({ firstName: 'John', lastName: 'Heine' });
    const act = store.logActivity({ type: 'Call', subject: 'Talked about N917JH', contactId: c.id });
    await store.flush();
    expect((await bobSees('contacts', c.id)).data.firstName).toBe('John');
    expect((await bobSees('activities', act.id)).data.subject).toBe('Talked about N917JH');
  });

  it('shows what someone else changed', async () => {
    await cloud.start();
    const c = store.createContact({ firstName: 'John' });
    await store.flush();
    const remote = await bobSees('contacts', c.id);
    await bobPush([{ collection: 'contacts', id: c.id, data: { ...remote.data, notes: 'Wants a quote' }, baseVersion: remote.version }]);
    await bobPush([{ collection: 'aircraft', id: 'air_bob', data: { id: 'air_bob', tailNumber: 'N1BB', ownerships: [], custom: {} }, baseVersion: 0 }]);

    await cloud.refresh();
    expect(store.getState().contacts[0].notes).toBe('Wants a quote');
    expect(store.getState().aircraft.map((a) => a.tailNumber)).toEqual(['N1BB']);
  });

  it('removes what someone else deleted', async () => {
    await cloud.start();
    const c = store.createContact({ firstName: 'John' });
    await store.flush();
    await bobPush([{ collection: 'contacts', id: c.id, data: null, baseVersion: 1 }]);
    await cloud.refresh();
    expect(store.getState().contacts).toEqual([]);
  });

  it('shows the other person’s version when both edit the same record', async () => {
    await cloud.start();
    const c = store.createContact({ firstName: 'John' });
    await store.flush();
    const remote = await bobSees('contacts', c.id);
    await bobPush([{ collection: 'contacts', id: c.id, data: { ...remote.data, notes: 'Bob was here' }, baseVersion: 1 }]);

    const notices: string[] = [];
    const off = store.onNotice((m) => notices.push(m));
    store.updateContact(c.id, { notes: 'Alice was here' });
    await store.flush();
    off();

    expect(store.getState().contacts[0].notes).toBe('Bob was here');
    expect(notices[0]).toMatch(/someone else/i);
    // And the next edit goes through on top of Bob's.
    store.updateContact(c.id, { notes: 'Alice, after reading Bob' });
    await store.flush();
    expect((await bobSees('contacts', c.id)).data.notes).toBe('Alice, after reading Bob');
  });

  it('keeps an unsent local edit when a pull arrives for the same record', async () => {
    await cloud.start();
    const c = store.createContact({ firstName: 'John' });
    await store.flush();
    await bobPush([{ collection: 'contacts', id: c.id, data: { ...(await bobSees('contacts', c.id)).data, company: 'Acentech' }, baseVersion: 1 }]);
    // Hold the push back so the edit is still local when the pull lands.
    const edited = { ...store.getState().contacts[0], notes: 'typed just now' };
    store.applyRemote((db) => ({ ...db, contacts: [edited] }));
    await cloud.refresh();
    expect(store.getState().contacts[0].notes).toBe('typed just now');
  });

  it('uploads what this device held before accounts, once', async () => {
    const local = emptyDatabase();
    local.contacts = [{ ...store.createContact({ firstName: 'Legacy' }) }];
    store.load(emptyDatabase());
    await persistence.saveDatabase(local);

    await cloud.start();
    const found = await localDataToUpload();
    expect(found?.contacts).toHaveLength(1);
    await cloud.uploadLocalData(found!);
    expect((await bobSees('contacts', local.contacts[0].id)).data.firstName).toBe('Legacy');
    await expect(cloud.uploadLocalData(found!)).rejects.toThrow(/already has data/);
  });

  it('opens the copy on this device when offline', async () => {
    await cloud.start();
    store.createContact({ firstName: 'John' });
    await store.flush();
    cloud.stop();
    await store.unload();

    const offline = new CloudSync(alice, () => Promise.reject(new TypeError('Failed to fetch')));
    await offline.start();
    offline.stop();
    expect(store.getState().contacts.map((c) => c.firstName)).toEqual(['John']);
    expect(store.getSaveError()).toMatch(/offline/i);
  });

  it('sends next time what was still on its way when the app closed', async () => {
    await cloud.start();
    cloud.stop();
    // The connection drops as the edit goes out.
    const dropping = new CloudSync(alice, (input, init) =>
      init?.method === 'POST' ? Promise.reject(new TypeError('Failed to fetch')) : deviceFetch(aliceCookie)(input, init));
    await store.unload();
    await dropping.start();
    const c = store.createContact({ firstName: 'Unsent' });
    await store.flush().catch(() => undefined);
    dropping.stop();
    await store.unload();
    expect(await bobSees('contacts', c.id)).toBeUndefined();

    const reopened = new CloudSync(alice, deviceFetch(aliceCookie));
    await reopened.start();
    reopened.stop();
    expect(store.getState().contacts.map((x) => x.firstName)).toEqual(['Unsent']);
    expect((await bobSees('contacts', c.id)).data.firstName).toBe('Unsent');
  });

  it('says nothing when an interrupted send had landed after all', async () => {
    await cloud.start();
    cloud.stop();
    // The edit reaches the server, but the reply never comes back.
    const lossy = new CloudSync(alice, async (input, init) => {
      const response = await deviceFetch(aliceCookie)(input, init);
      if (init?.method === 'POST') throw new TypeError('Failed to fetch');
      return response;
    });
    await store.unload();
    await lossy.start();
    const c = store.createContact({ firstName: 'Landed' });
    await store.flush().catch(() => undefined);
    lossy.stop();
    await store.unload();

    const notices: string[] = [];
    const off = store.onNotice((m) => notices.push(m));
    const reopened = new CloudSync(alice, deviceFetch(aliceCookie));
    await reopened.start();
    reopened.stop();
    off();
    expect(notices).toEqual([]);
    expect(store.getState().contacts.map((x) => x.firstName)).toEqual(['Landed']);
    expect((await bobSees('contacts', c.id)).version).toBe(1);
  });

  it('asks to sign in again when the session has gone', async () => {
    const expired = new CloudSync(alice, () => Promise.resolve(new Response('{}', { status: 401 })));
    await expect(expired.start()).rejects.toBeInstanceOf(SessionExpired);
  });
});
