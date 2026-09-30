/**
 * Documents through the app's own sync engine: attached on one device,
 * opened on another, kept across sign-out, and moved up from a browser that
 * held them before cloud storage. Uses the local-disk store.
 */
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { api, createUser, freshDatabase, ORIGIN, signIn, TEST_DB } from './testing.js';
import { handle } from './app.js';
import * as store from '../src/data/store';
import * as persistence from '../src/data/db';
import { CloudSync, forgetCache, storageName, type CloudUser } from '../src/data/cloud';

function deviceFetch(cookie: string): typeof fetch {
  return (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set('cookie', cookie);
    headers.set('origin', ORIGIN);
    return handle(new Request(`${ORIGIN}${String(input)}`, { ...init, headers }));
  };
}

const pdf = (text: string, name = 'Binder.pdf') => new File([text], name, { type: 'application/pdf' });

describe.skipIf(!TEST_DB)('documents in the cloud', () => {
  let dir: string;
  let alice: CloudUser;
  let aliceCookie: string;
  let bobCookie: string;
  let cloud: CloudSync;

  beforeEach(async () => {
    await freshDatabase();
    dir = await mkdtemp(join(tmpdir(), 'aerobook-docs-'));
    process.env.FILES_DIR = dir;
    await store.unload();
    await persistence.clearAll();
    const a = await createUser('Alice', 'alice@example.com', 'admin');
    await createUser('Bob', 'bob@example.com');
    alice = { id: a.id, name: a.name, email: a.email, role: 'admin' };
    aliceCookie = await signIn('alice@example.com');
    bobCookie = await signIn('bob@example.com');
    cloud = new CloudSync(alice, deviceFetch(aliceCookie));
  });

  afterEach(async () => {
    cloud.stop();
    await store.unload();
    delete process.env.FILES_DIR;
    await rm(dir, { recursive: true, force: true });
  });

  it('shares a document with the team, and keeps it across sign-out', async () => {
    await cloud.start();
    const record = await store.addFile(pdf('the binder'), { aircraftId: 'air_1' }, 'Insurance');
    await store.flush();
    expect(record.blobPath).toMatch(/^files\/fil_[a-z0-9]+\/Binder\.pdf$/);
    expect(await persistence.getFileBlob(record.id)).toBeUndefined();

    // Bob, on another device, sees the record and can open the file.
    const pulled = await api('/api/sync?since=0&full=1', { cookie: bobCookie }).then((r) => r.json());
    const shared = pulled.records.find((r: { collection: string }) => r.collection === 'files');
    expect(shared.data.name).toBe('Binder.pdf');
    const opened = await api(`/api/files/content?path=${encodeURIComponent(shared.data.blobPath)}`, { cookie: bobCookie });
    expect(await opened.text()).toBe('the binder');

    // Alice signs out (her cached copy is forgotten) and back in.
    cloud.stop();
    await forgetCache(alice.id);
    await store.unload();
    cloud = new CloudSync(alice, deviceFetch(aliceCookie));
    await cloud.start();
    expect(store.getState().files.map((f) => f.name)).toEqual(['Binder.pdf']);
    expect(await (await store.getFile(record.id))?.text()).toBe('the binder');
  });

  it('refuses a kind of file AEROBOOK does not keep, before storing anything', async () => {
    await cloud.start();
    const page = new File(['<script>alert(1)</script>'], 'invoice.html', { type: 'text/html' });
    await expect(store.addFile(page, { aircraftId: 'air_1' })).rejects.toThrow(/not a kind of file AEROBOOK keeps/);
    expect(store.getState().files).toEqual([]);
    expect(await readdir(dir)).toEqual([]);
    // A photo whose type the browser left out is kept by its name.
    const photo = await store.addFile(new File(['jpeg bytes'], 'IMG_0001.HEIC'), { aircraftId: 'air_1' });
    expect(photo.mimeType).toBe('image/heic');
  });

  it('moves up a document that was only in this browser', async () => {
    // Attached before cloud storage: a row in the cache and the file in IndexedDB.
    await cloud.start();
    cloud.stop();
    await store.unload();
    delete process.env.FILES_DIR;
    const offline = new CloudSync(alice, deviceFetch(aliceCookie));
    await offline.start();
    const old = await store.addFile(pdf('old quote', 'Quote.pdf'), { contactId: 'con_1' });
    await store.flush();
    offline.stop();
    await store.unload();
    expect(old.blobPath).toBeUndefined();
    expect(await persistence.getFileBlob(old.id)).toBeTruthy();

    process.env.FILES_DIR = dir;
    const notices: string[] = [];
    const off = store.onNotice((m) => notices.push(m));
    cloud = new CloudSync(alice, deviceFetch(aliceCookie));
    await cloud.start();
    await cloud.moveBrowserFiles();
    await store.flush();
    off();

    const moved = store.getState().files.find((f) => f.id === old.id);
    expect(moved?.blobPath).toMatch(/^files\//);
    expect(await persistence.getFileBlob(old.id)).toBeUndefined();
    expect(notices.some((n) => /moved to cloud storage/.test(n))).toBe(true);
    const pulled = await api('/api/sync?since=0&full=1', { cookie: bobCookie }).then((r) => r.json());
    expect(pulled.records.some((r: { collection: string; id: string }) => r.collection === 'files' && r.id === old.id)).toBe(true);
  });

  it('stops sharing a removed document, keeping its file in the trash', async () => {
    await cloud.start();
    const record = await store.addFile(pdf('to go'), {});
    await store.flush();
    await store.removeFile(record.id);
    await store.flush();
    const path = `/api/files/content?path=${encodeURIComponent(record.blobPath!)}`;
    expect((await api(path, { cookie: bobCookie })).status).toBe(404);
    expect(await readdir(join(dir, 'files', record.id))).toEqual(['Binder.pdf']);
  });

  it('keeps a document on the device when there is no cloud storage', async () => {
    delete process.env.FILES_DIR;
    await cloud.start();
    const record = await store.addFile(pdf('local only'), {});
    await store.flush();
    expect(record.blobPath).toBeUndefined();
    expect(await (await store.getFile(record.id))?.text()).toBe('local only');
    const pulled = await api('/api/sync?since=0&full=1', { cookie: bobCookie }).then((r) => r.json());
    expect(pulled.records.some((r: { collection: string }) => r.collection === 'files')).toBe(false);
  });

  it('makes a file name safe to store', () => {
    expect(storageName('a/b\\c.pdf')).toBe('a_b_c.pdf');
    expect(storageName('..hidden')).toBe('hidden');
    expect(storageName('')).toBe('document');
  });
});
