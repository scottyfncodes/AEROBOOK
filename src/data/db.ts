/**
 * Persistence.
 *
 * The whole dataset is one JSON document in IndexedDB — a personal CRM is a
 * few thousand records, so keeping it in memory and writing the document on
 * change is both simpler and faster than a row-per-record schema. File blobs
 * live in their own store so the document stays small. localStorage is the
 * fallback when IndexedDB is unavailable (private browsing on older Safari).
 */
import { newId, nowIso } from '../lib/id';
import {
  DB_VERSION,
  emptyDatabase,
  type Database,
  type FollowUp,
  type InsurancePolicy,
  type Opportunity,
  type OpportunityStatus,
  type OpportunityType,
} from './types';

const IDB_NAME = 'aerobook';
const IDB_VERSION = 1;
const DOC_STORE = 'doc';
const FILE_STORE = 'files';
const DOC_KEY = 'database';
const LS_KEY = 'aerobook:database';

function hasIndexedDb(): boolean {
  try {
    return typeof indexedDB !== 'undefined' && indexedDB !== null;
  } catch {
    return false;
  }
}

let openPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (openPromise) return openPromise;
  openPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(IDB_NAME, IDB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(DOC_STORE)) db.createObjectStore(DOC_STORE);
      if (!db.objectStoreNames.contains(FILE_STORE)) db.createObjectStore(FILE_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'));
    request.onblocked = () => reject(new Error('IndexedDB is blocked by another tab'));
  });
  return openPromise;
}

function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(store, mode);
        const request = fn(transaction.objectStore(store));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
      }),
  );
}

/**
 * Version 1 kept insurance as an optional blob on an opportunity, and a
 * parallel `followUpDate` string that nothing ever acted on. Version 2 lifts
 * insurance into a record of its own and turns those dates into real
 * follow-ups. The old fields are read, converted and dropped — nothing is
 * thrown away without somewhere to put it.
 */
interface LegacyInsurance {
  currentInsurer?: string;
  carrier?: string;
  policyNumber?: string;
  renewalDate?: string;
  policyStatus?: string;
  premium?: string;
  deductible?: string;
  liabilityLimit?: string;
  hullValue?: string;
  coverageNotes?: string;
}

type LegacyOpportunity = Opportunity & { insurance?: LegacyInsurance; followUpDate?: string };

const TYPE_ALIASES: Record<string, OpportunityType> = {
  Both: 'Sale + Insurance',
  'Aircraft Purchase': 'Aircraft Purchase',
  'Aircraft Sale': 'Aircraft Sale',
  Insurance: 'Insurance',
  Other: 'Other',
};

/**
 * "Open" was the entry stage and "Quote" the quoting stage. "Closed" was only
 * ever used the way "Lost" is used now — every query grouped it with Won and
 * Lost as no longer in play.
 */
const STATUS_ALIASES: Record<string, OpportunityStatus> = {
  Open: 'Lead',
  Quote: 'Quoting',
  Closed: 'Lost',
};

function hasAnyValue(value: LegacyInsurance | undefined): boolean {
  return Boolean(value && Object.values(value).some((v) => typeof v === 'string' && v.trim() !== ''));
}

/** Fill in anything a newer version of the app added, and convert what moved. */
export function migrate(raw: unknown): Database {
  const base = emptyDatabase();
  if (!raw || typeof raw !== 'object') return base;
  const input = raw as Partial<Database>;
  const now = nowIso();

  const policies: InsurancePolicy[] = [...(input.policies ?? [])].map((p) => ({
    ...p,
    aircraftId: p.aircraftId ?? null,
    contactId: p.contactId ?? null,
    opportunityId: p.opportunityId ?? null,
  }));
  const followUps: FollowUp[] = [...(input.followUps ?? [])];

  const opportunities = (input.opportunities ?? []).map((raw_o) => {
    const legacy = raw_o as LegacyOpportunity;
    const { insurance, followUpDate, ...rest } = legacy;

    if (hasAnyValue(insurance) && !policies.some((p) => p.opportunityId === legacy.id)) {
      policies.push({
        id: newId('pol'),
        aircraftId: legacy.aircraftId,
        contactId: legacy.contactId,
        opportunityId: legacy.id,
        carrier: insurance?.carrier || insurance?.currentInsurer || '',
        policyNumber: insurance?.policyNumber ?? '',
        brokerAgent: '',
        expirationDate: insurance?.renewalDate,
        premium: insurance?.premium ?? '',
        hullValue: insurance?.hullValue ?? '',
        liabilityLimit: insurance?.liabilityLimit ?? '',
        deductible: insurance?.deductible ?? '',
        status: 'Unknown',
        quotedPremium: '',
        renewalNotes: insurance?.policyStatus ? `Policy status: ${insurance.policyStatus}` : '',
        notes: insurance?.coverageNotes ?? '',
        createdAt: legacy.createdAt ?? now,
        updatedAt: legacy.updatedAt ?? now,
      });
    }

    // A follow-up date that only ever sat on the record becomes a real task.
    if (followUpDate && !followUps.some((f) => f.opportunityId === legacy.id && f.dueDate === followUpDate)) {
      followUps.push({
        id: newId('fup'),
        contactId: legacy.contactId,
        aircraftId: legacy.aircraftId,
        opportunityId: legacy.id,
        dueDate: followUpDate,
        note: legacy.title || `Follow up on this ${String(legacy.type).toLowerCase()}`,
        completed: false,
        createdAt: legacy.createdAt ?? now,
        updatedAt: now,
      });
    }

    return {
      ...rest,
      type: TYPE_ALIASES[String(legacy.type)] ?? (legacy.type as OpportunityType) ?? 'Other',
      status: STATUS_ALIASES[String(legacy.status)] ?? (legacy.status as OpportunityStatus) ?? 'Lead',
    } satisfies Opportunity;
  });

  return {
    ...base,
    ...input,
    version: DB_VERSION,
    contacts: input.contacts ?? [],
    aircraft: (input.aircraft ?? []).map((a) => ({ ...a, ownerships: a.ownerships ?? [], custom: a.custom ?? {} })),
    opportunities,
    policies,
    activities: input.activities ?? [],
    followUps,
    templates: input.templates ?? [],
    files: (input.files ?? []).map((f) => ({ ...f, category: f.category ?? 'Other' })),
    imports: input.imports ?? [],
    settings: { ...base.settings, ...(input.settings ?? {}) },
  };
}

export async function loadDatabase(): Promise<Database> {
  if (hasIndexedDb()) {
    try {
      const doc = await tx<unknown>(DOC_STORE, 'readonly', (s) => s.get(DOC_KEY));
      if (doc) return migrate(doc);
    } catch {
      // Fall through to localStorage.
    }
  }
  try {
    const raw = globalThis.localStorage?.getItem(LS_KEY);
    if (raw) return migrate(JSON.parse(raw));
  } catch {
    /* ignore */
  }
  return emptyDatabase();
}

export async function saveDatabase(db: Database): Promise<void> {
  if (hasIndexedDb()) {
    try {
      await tx(DOC_STORE, 'readwrite', (s) => s.put(db, DOC_KEY));
      return;
    } catch {
      // Fall through to localStorage.
    }
  }
  try {
    globalThis.localStorage?.setItem(LS_KEY, JSON.stringify(db));
  } catch (error) {
    throw new Error(`Could not save data: ${(error as Error).message}`);
  }
}

export async function putFileBlob(id: string, blob: Blob): Promise<void> {
  if (!hasIndexedDb()) throw new Error('File storage needs IndexedDB, which is not available in this browser.');
  await tx(FILE_STORE, 'readwrite', (s) => s.put(blob, id));
}

export async function getFileBlob(id: string): Promise<Blob | undefined> {
  if (!hasIndexedDb()) return undefined;
  return tx<Blob | undefined>(FILE_STORE, 'readonly', (s) => s.get(id));
}

export async function deleteFileBlob(id: string): Promise<void> {
  if (!hasIndexedDb()) return;
  await tx(FILE_STORE, 'readwrite', (s) => s.delete(id));
}

export async function clearAll(): Promise<void> {
  if (hasIndexedDb()) {
    try {
      await tx(DOC_STORE, 'readwrite', (s) => s.clear());
      await tx(FILE_STORE, 'readwrite', (s) => s.clear());
    } catch {
      /* ignore */
    }
  }
  try {
    globalThis.localStorage?.removeItem(LS_KEY);
  } catch {
    /* ignore */
  }
}

/** Test seam: forget the cached connection between test cases. */
export function resetConnection(): void {
  openPromise = null;
}
