/**
 * What has to cross the wire, worked out by comparing two versions of the
 * database. Pure, so it can be tested without a server.
 *
 * The store never mutates a record in place — a changed record is a new
 * object, an untouched one keeps its identity — so most records are ruled out
 * by one reference comparison. The JSON comparison behind it only runs for
 * records rebuilt without changing, which an import does wholesale.
 */
import type { Database, Settings } from './types';

/** Shared by everyone on the account. Mirrors SHARED_COLLECTIONS on the server. */
export const SYNCED_COLLECTIONS = [
  'contacts', 'aircraft', 'opportunities', 'policies', 'activities',
  'followUps', 'templates', 'imports', 'files',
] as const;
export type SyncedCollection = (typeof SYNCED_COLLECTIONS)[number];

/** One per person; the record id is their user id. */
export const SETTINGS = 'settings';

export type Collection = SyncedCollection | typeof SETTINGS;

export interface RecordChange {
  collection: Collection;
  id: string;
  /** Null for a deletion. */
  data: Record<string, unknown> | null;
}

export interface RemoteRecord extends RecordChange {
  version: number;
}

export const recordKey = (collection: string, id: string) => `${collection}:${id}`;

type Row = { id: string };

/**
 * JSON with keys in a fixed order. Postgres stores records as jsonb, which
 * reorders keys, so a record that went to the server and back must still
 * compare equal to the one that was sent.
 */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return v;
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort()) sorted[k] = (v as Record<string, unknown>)[k];
    return sorted;
  });
}

function same(a: unknown, b: unknown): boolean {
  return a === b || canonical(a) === canonical(b);
}

/**
 * A document still only in this browser is not shared yet: nobody else could
 * open it. It is sent once its file is in cloud storage.
 */
function shared(collection: SyncedCollection, rows: Row[]): Row[] {
  return collection === 'files' ? rows.filter((r) => (r as { blobPath?: string }).blobPath) : rows;
}

export function diffDatabases(before: Database, after: Database, userId: string): RecordChange[] {
  const changes: RecordChange[] = [];
  for (const collection of SYNCED_COLLECTIONS) {
    const prev = new Map(shared(collection, before[collection] as Row[]).map((r) => [r.id, r]));
    const seen = new Set<string>();
    for (const row of shared(collection, after[collection] as Row[])) {
      seen.add(row.id);
      const old = prev.get(row.id);
      if (!old || !same(old, row)) {
        changes.push({ collection, id: row.id, data: row as unknown as Record<string, unknown> });
      }
    }
    for (const id of prev.keys()) {
      if (!seen.has(id)) changes.push({ collection, id, data: null });
    }
  }
  if (!same(before.settings, after.settings)) {
    changes.push({ collection: SETTINGS, id: userId, data: after.settings as unknown as Record<string, unknown> });
  }
  return changes;
}

/**
 * Lay records over a database. A record that already exists is replaced where
 * it sits, so lists keep their order; a new one is added to the end.
 */
export function applyRecords(db: Database, records: RecordChange[]): Database {
  if (records.length === 0) return db;
  const next: Database = { ...db };
  const byCollection = new Map<SyncedCollection, Map<string, RecordChange>>();
  for (const r of records) {
    if (r.collection === SETTINGS) {
      if (r.data) next.settings = { ...db.settings, ...(r.data as Partial<Settings>) };
      continue;
    }
    if (!(SYNCED_COLLECTIONS as readonly string[]).includes(r.collection)) continue;
    let m = byCollection.get(r.collection);
    if (!m) byCollection.set(r.collection, (m = new Map()));
    m.set(r.id, r);
  }
  for (const [collection, updates] of byCollection) {
    const out: Row[] = [];
    for (const row of db[collection] as Row[]) {
      const u = updates.get(row.id);
      if (!u) out.push(row);
      else {
        updates.delete(row.id);
        if (u.data) out.push(u.data as unknown as Row);
      }
    }
    for (const u of updates.values()) if (u.data) out.push(u.data as unknown as Row);
    (next as unknown as Record<string, Row[]>)[collection] = out;
  }
  return next;
}

/** The record as it stands in a database, for comparing against a base copy. */
export function findRecord(db: Database, collection: Collection, id: string): unknown {
  if (collection === SETTINGS) return db.settings;
  return (db[collection] as Row[]).find((r) => r.id === id);
}

export function sameRecord(a: unknown, b: unknown): boolean {
  return same(a, b);
}
