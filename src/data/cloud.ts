/**
 * Keeping this device and everyone else's on the same data.
 *
 * `base` is the database as the server last agreed it. Every save compares
 * the store's state with it and sends only what differs; every pull lays what
 * others changed over both. Pushes and pulls run one at a time, in order, so
 * neither ever works from a base the other is halfway through changing.
 *
 * Documents are records like any other, with the file itself in private
 * cloud storage (Vercel Blob), fetched through the API when opened. A document
 * attached before cloud storage, or while offline, stays in this browser until
 * it can be moved up — which happens on its own the next time the app opens.
 */
import { documentType } from '../lib/documents';
import { defaultTemplates } from '../lib/email';
import { nowIso } from '../lib/id';
import * as persistence from './db';
import * as store from './store';
import {
  applyRecords, diffDatabases, findRecord, recordKey, sameRecord,
  type RecordChange, type RemoteRecord,
} from './sync';
import { emptyDatabase, type Database, type FileRecord } from './types';

export interface CloudUser {
  id: string;
  name: string;
  email: string;
  role: 'admin' | 'user';
}

const PUSH_CHUNK = 500;
const POLL_MS = 30_000;
/** Browsers cap keepalive requests at 64 KB in flight. */
const KEEPALIVE_LIMIT = 60_000;

export class SessionExpired extends Error {
  constructor() {
    super('Your sign-in has expired. Sign in again to keep saving.');
  }
}

interface Cache {
  userId: string;
  base: Database;
  versions: [string, number][];
  cursor: number;
  /**
   * Changes on their way to the server, written before they are sent. If the
   * app is closed first, they are sent next time it opens, each against the
   * version it was made from.
   */
  pending?: { changes: RecordChange[]; versions: [string, number][] };
  /** Documents still only in this browser, not yet in cloud storage. */
  localFiles?: FileRecord[];
}

type StorageMode = 'blob' | 'local' | 'none';

/** Documents in a cache that never reached cloud storage, from either shape of cache. */
function browserOnlyFiles(cache: Cache | undefined): FileRecord[] {
  const all = [...(cache?.localFiles ?? []), ...(cache?.base.files ?? [])].filter((f) => !f.blobPath);
  return all.filter((f, i) => all.findIndex((g) => g.id === f.id) === i);
}

/** A file name that is safe as the last part of a storage path. */
export function storageName(name: string): string {
  const cleaned = name.replace(/[\/\\\u0000-\u001f]/g, '_').replace(/^\.+/, '').trim().slice(-150);
  return cleaned || 'document';
}

const cacheKey = (userId: string) => `cloud:${userId}`;

export class CloudSync implements store.Backend {
  private base: Database = emptyDatabase();
  private versions = new Map<string, number>();
  private cursor = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private storage: StorageMode = 'none';
  private uploadFlavor: 'token' | 'presigned' = 'token';
  private moving: Promise<number> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly onWake = () => {
    if (typeof document === 'undefined' || document.visibilityState === 'visible') void this.refresh();
  };
  onSessionExpired: (() => void) | null = null;

  readonly user: CloudUser;
  private readonly http: typeof fetch;

  constructor(user: CloudUser, http: typeof fetch = (...args) => fetch(...args)) {
    this.user = user;
    this.http = http;
  }

  /**
   * Load everything and take over saving. Without a connection, the copy
   * cached on this device from last time opens instead; with neither, this
   * throws.
   */
  async start(): Promise<void> {
    const cache = await persistence.loadCache<Cache>(cacheKey(this.user.id));
    const localFiles = cache?.userId === this.user.id ? browserOnlyFiles(cache) : [];
    let db: Database;
    let offline: string | null = null;
    try {
      const records: RemoteRecord[] = [];
      let more = true;
      this.cursor = 0;
      while (more) {
        const page = await this.pullPage(this.cursor, true);
        records.push(...page.records);
        this.cursor = page.cursor;
        more = page.more;
      }
      this.versions = new Map(records.map((r) => [recordKey(r.collection, r.id), r.version]));
      this.base = applyRecords(emptyDatabase(), records);
      db = this.withDefaults(this.base, records);
    } catch (error) {
      if (error instanceof SessionExpired || !cache || cache.userId !== this.user.id) throw error;
      this.base = { ...cache.base, files: cache.base.files.filter((f) => f.blobPath) };
      this.versions = new Map(cache.versions);
      this.cursor = cache.cursor;
      db = this.base;
      offline = 'You are offline, so this is the copy saved on this device.';
    }
    const unsent = cache?.userId === this.user.id ? cache.pending : undefined;
    if (unsent?.changes.length) {
      // Last time, the app closed with these still on the way. They go again,
      // marked with the versions they were made from: one that did land comes
      // back identical and is taken as done; one someone has since changed
      // loses to theirs, as any conflicting edit does.
      const from = new Map(unsent.versions);
      for (const c of unsent.changes) {
        const key = recordKey(c.collection, c.id);
        this.versions.set(key, from.get(key) ?? 0);
      }
      db = applyRecords(db, unsent.changes);
    }
    if (localFiles.length) {
      db = { ...db, files: [...db.files, ...localFiles.filter((f) => !db.files.some((g) => g.id === f.id))] };
    }
    store.load(db);
    await store.setBackend(this);
    store.setSaveError(offline);
    if (!offline) {
      const config = await this.request('/api/files/config')
        .then((r) => r.json() as Promise<{ mode: StorageMode; upload?: 'token' | 'presigned' }>)
        .catch(() => ({ mode: 'none' as const, upload: undefined }));
      this.storage = config.mode;
      this.uploadFlavor = config.upload ?? 'token';
      void this.moveBrowserFiles();
    }
    // Anything withDefaults added goes up now rather than on the next edit.
    if (db !== this.base) await this.save(db).catch((e: Error) => store.setSaveError(e.message));
    this.startPolling();
  }

  /**
   * A new account has nothing stored yet: the built-in templates (their ids
   * are fixed, so two people starting at once cannot duplicate them), and a
   * signature filled in from the account.
   */
  private withDefaults(base: Database, records: RemoteRecord[]): Database {
    let db = base;
    if (db.templates.length === 0) db = { ...db, templates: defaultTemplates(nowIso()) };
    if (!records.some((r) => r.collection === 'settings')) {
      db = {
        ...db,
        settings: {
          ...db.settings,
          senderName: db.settings.senderName || this.user.name,
          senderEmail: db.settings.senderEmail || this.user.email,
        },
      };
    }
    return db;
  }

  /** Whether the server has this record yet — a new one is only there once its save lands. */
  isStored(collection: string, id: string): boolean {
    return (this.versions.get(recordKey(collection, id)) ?? 0) > 0;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (typeof window !== 'undefined') {
      window.removeEventListener('beforeunload', this.onLeave);
      window.removeEventListener('focus', this.onWake);
      document.removeEventListener('visibilitychange', this.onWake);
    }
  }

  private startPolling(): void {
    this.stop();
    this.timer = setInterval(() => void this.refresh(), POLL_MS);
    if (typeof window !== 'undefined') {
      window.addEventListener('beforeunload', this.onLeave);
      window.addEventListener('focus', this.onWake);
      document.addEventListener('visibilitychange', this.onWake);
    }
  }

  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = this.queue.then(job, job);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /**
   * Store backend: send whatever differs from what the server has.
   *
   * The data is read when the push runs, not when it was asked for. A push
   * waits in line behind any pull already running; comparing the data as it
   * was before that pull with the server's state after it would send the
   * pull's own changes back as if they were this device's edits — bringing a
   * record someone else just deleted back to life, or undoing their edit.
   */
  save(_requested: Database): Promise<void> {
    return this.enqueue(() => this.push(store.getState()));
  }

  /** Fetch what others changed. Failures show as the offline banner, never throw. */
  refresh(): Promise<void> {
    return this.enqueue(async () => {
      try {
        await this.pullChanges();
        if (store.getSaveError()?.startsWith('You are offline')) store.setSaveError(null);
        store.retrySave();
      } catch (error) {
        if (error instanceof SessionExpired) this.expire();
        else if (!store.getSaveError()) store.setSaveError('You are offline. Changes will be sent when the connection is back.');
      }
    });
  }

  private expire(): void {
    this.stop();
    this.onSessionExpired?.();
  }

  private async request(path: string, init?: RequestInit): Promise<Response> {
    let response: Response;
    try {
      response = await this.http(path, { credentials: 'same-origin', ...init });
    } catch {
      throw new Error('Could not reach AEROBOOK. Check the connection; changes will be sent when it is back.');
    }
    if (response.status === 401) throw new SessionExpired();
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      throw new Error(body?.error ?? `The server said ${response.status}.`);
    }
    return response;
  }

  private async pullPage(since: number, full = false): Promise<{ records: RemoteRecord[]; cursor: number; more: boolean }> {
    return (await this.request(`/api/sync?since=${since}${full ? '&full=1' : ''}`)).json();
  }

  private async pullChanges(): Promise<void> {
    let more = true;
    let changed = false;
    while (more) {
      const page = await this.pullPage(this.cursor);
      // Our own writes come back too, at versions we already hold.
      const fresh = page.records.filter((r) => (this.versions.get(recordKey(r.collection, r.id)) ?? 0) < r.version);
      if (fresh.length) {
        changed = true;
        const before = this.base;
        const current = store.getState();
        // A record this device has changed and not yet sent keeps the local
        // edit; it goes up next, on top of the version that just arrived.
        const untouched = fresh.filter((r) =>
          sameRecord(findRecord(current, r.collection, r.id), findRecord(before, r.collection, r.id)));
        this.base = applyRecords(before, fresh);
        for (const r of fresh) this.versions.set(recordKey(r.collection, r.id), r.version);
        store.applyRemote((s) => applyRecords(s, untouched));
      }
      this.cursor = page.cursor;
      more = page.more;
    }
    if (changed) await this.saveCache(store.getState());
  }

  private async push(db: Database): Promise<void> {
    const changes = diffDatabases(this.base, db, this.user.id);
    // Nothing for the server — but a document added or removed still needs
    // remembering on this device.
    if (changes.length === 0) return this.saveCache(db);
    await this.saveCache(db, changes);
    this.setSaving(true);
    try {
      for (let i = 0; i < changes.length; i += PUSH_CHUNK) {
        await this.pushChunk(changes.slice(i, i + PUSH_CHUNK));
      }
    } finally {
      this.setSaving(false);
    }
    await this.saveCache(db);
  }

  private pushing = false;
  private readonly onLeave = (event: BeforeUnloadEvent) => {
    // Most browsers then ask "Leave site? Changes may not be saved".
    if (this.pushing) event.preventDefault();
  };

  /** Mark the page while changes are on their way, and ask before leaving it. */
  private setSaving(saving: boolean): void {
    this.pushing = saving;
    if (typeof document === 'undefined') return;
    if (saving) document.documentElement.dataset.sync = 'saving';
    else delete document.documentElement.dataset.sync;
  }

  private async pushChunk(changes: RecordChange[]): Promise<void> {
    const body = JSON.stringify({
      changes: changes.map((c) => ({ ...c, baseVersion: this.versions.get(recordKey(c.collection, c.id)) ?? 0 })),
    });
    let response: Response;
    try {
      response = await this.request('/api/sync', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        // An edit made just before the app is closed or reloaded still
        // arrives. Browsers only allow this for small requests, which is what
        // an everyday edit is; an import is sent while the app stays open.
        keepalive: body.length < KEEPALIVE_LIMIT,
      });
    } catch (error) {
      if (error instanceof SessionExpired) this.expire();
      throw error;
    }
    const result = (await response.json()) as {
      applied: { collection: string; id: string; version: number }[];
      conflicts: RemoteRecord[];
      refused?: { message: string; records: RemoteRecord[] };
    };
    const sent = new Map(changes.map((c) => [recordKey(c.collection, c.id), c]));
    const landed: RecordChange[] = [];
    for (const a of result.applied) {
      const key = recordKey(a.collection, a.id);
      this.versions.set(key, a.version);
      const change = sent.get(key);
      if (change) landed.push(change);
    }
    this.base = applyRecords(this.base, landed);

    for (const c of result.conflicts) this.versions.set(recordKey(c.collection, c.id), c.version);
    // A "conflict" that already holds exactly what was sent is this device's
    // own earlier send that landed after all. Nothing to tell anyone.
    const lost = result.conflicts.filter((c) => !sameRecord(c.data, sent.get(recordKey(c.collection, c.id))?.data ?? null));
    this.base = applyRecords(this.base, result.conflicts);
    if (lost.length) {
      // Someone else changed these first. Theirs stands; this device shows it.
      store.applyRemote((s) => applyRecords(s, lost));
      store.notify(
        lost.length === 1
          ? 'Someone else changed that at the same time, so their version is showing.'
          : `${lost.length} records were changed by someone else at the same time; their versions are showing.`,
      );
    }

    // Deletions the server would not make: the records come back as they are
    // there, so this device stops trying and shows them again.
    const refused = result.refused?.records ?? [];
    if (refused.length) {
      for (const r of refused) this.versions.set(recordKey(r.collection, r.id), r.version);
      this.base = applyRecords(this.base, refused);
      store.applyRemote((s) => applyRecords(s, refused));
      store.notify(result.refused!.message);
    }
  }

  private async saveCache(db: Database, pending?: RecordChange[]): Promise<void> {
    const cache: Cache = {
      userId: this.user.id,
      base: this.base,
      localFiles: db.files.filter((f) => !f.blobPath),
      versions: [...this.versions],
      cursor: this.cursor,
      pending: pending?.length ? { changes: pending, versions: [...this.versions] } : undefined,
    };
    await persistence.saveCache(cacheKey(this.user.id), cache).catch(() => undefined);
  }

  // ------------------------------------------------------------ documents

  /**
   * Store backend: put a document in cloud storage. Null keeps it in this
   * browser instead — when there is no cloud storage, or the upload failed
   * (no signal, say); it is moved up later rather than lost.
   */
  async storeFile(id: string, file: File): Promise<string | null> {
    const path = `files/${id}/${storageName(file.name)}`;
    try {
      if (this.storage === 'blob') {
        const client = await import('@vercel/blob/client');
        const send = this.uploadFlavor === 'presigned' ? client.uploadPresigned : client.upload;
        const result = await send(path, file, {
          access: 'private',
          handleUploadUrl: '/api/files/upload',
          contentType: documentType(file.name, file.type) ?? undefined,
          multipart: file.size > 8 * 1024 * 1024,
        });
        return result.pathname;
      }
      if (this.storage === 'local') {
        const r = await this.request(`/api/files/local?path=${encodeURIComponent(path)}`, { method: 'PUT', body: file });
        return ((await r.json()) as { pathname: string }).pathname;
      }
    } catch (error) {
      if (error instanceof SessionExpired) this.expire();
      store.notify(`${file.name} is saved on this device for now; it will be shared when it can be uploaded.`);
    }
    return null;
  }

  /** Store backend: fetch a document from cloud storage. */
  async loadFile(record: FileRecord): Promise<Blob | undefined> {
    if (!record.blobPath) return undefined;
    try {
      const r = await this.request(`/api/files/content?path=${encodeURIComponent(record.blobPath)}`);
      return await r.blob();
    } catch (error) {
      if (error instanceof SessionExpired) this.expire();
      throw error;
    }
  }

  /**
   * Move documents that are only in this browser up to cloud storage, so the
   * team can open them and they survive signing out. Runs on its own after
   * the app opens; anything that fails simply waits for next time.
   */
  moveBrowserFiles(): Promise<number> {
    if (this.storage === 'none') return Promise.resolve(0);
    // One move at a time; asking again while one runs waits for that one.
    this.moving ??= this.moveNow().finally(() => { this.moving = null; });
    return this.moving;
  }

  private async moveNow(): Promise<number> {
    let moved = 0;
    // A kind of file cloud storage would refuse stays on this device rather
    // than being tried again every time the app opens.
    for (const f of store.getState().files.filter((x) => !x.blobPath && documentType(x.name, x.mimeType))) {
      const blob = await persistence.getFileBlob(f.id);
      if (!blob) continue;
      const path = await this.storeFile(f.id, new File([blob], f.name, { type: f.mimeType }));
      if (!path) break;
      store.markFileStored(f.id, path);
      await persistence.deleteFileBlob(f.id).catch(() => undefined);
      moved += 1;
    }
    if (moved) store.notify(moved === 1 ? '1 document moved to cloud storage.' : `${moved} documents moved to cloud storage.`);
    return moved;
  }

  /** Whether the account has any shared data yet. */
  async isAccountEmpty(): Promise<boolean> {
    return ((await (await this.request('/api/sync/status')).json()) as { empty: boolean }).empty;
  }

  /**
   * Put the data this device kept before accounts existed into the account.
   * Only while the account is empty — two devices uploading would otherwise
   * put every contact in twice.
   */
  async uploadLocalData(local: Database): Promise<void> {
    if (!(await this.isAccountEmpty())) throw new Error('The account already has data, so nothing was uploaded.');
    store.replaceDatabase({ ...local, files: [...store.getState().files, ...local.files] });
    await store.flush();
    await this.moveBrowserFiles();
    await store.flush();
  }
}

/** What this device stored before accounts existed, if anything worth uploading. */
export async function localDataToUpload(): Promise<Database | null> {
  const db = await persistence.loadDatabase();
  const count = db.contacts.length + db.aircraft.length + db.opportunities.length + db.policies.length
    + db.activities.length + db.followUps.length;
  return count > 0 ? db : null;
}

/** Forget this person's cached copy, as on sign-out on a shared device. */
export function forgetCache(userId: string): Promise<void> {
  return persistence.deleteCache(cacheKey(userId)).catch(() => undefined);
}
