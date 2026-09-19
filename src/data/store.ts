/**
 * The application store.
 *
 * One immutable Database object, a set of named mutations, and a subscription
 * for React. Every mutation produces a new object and schedules a debounced
 * write, so the UI stays synchronous while persistence stays off the critical
 * path.
 */
import { newId, nowIso } from '../lib/id';
import { defaultTemplates } from '../lib/email';
import { formatTail, normalizeTail } from '../lib/tail';
import { normalizeEmail } from '../lib/phone';
import { linkOwner } from '../lib/importer';
import * as persistence from './db';
import {
  emptyDatabase,
  type Activity,
  type ActivityType,
  type Aircraft,
  type Contact,
  type Database,
  type EmailTemplate,
  type FileRecord,
  type FollowUp,
  type ImportRecord,
  type LayoverSpot,
  type Opportunity,
  type Settings,
} from './types';

type Listener = () => void;

let state: Database = emptyDatabase();
let loaded = false;
const listeners = new Set<Listener>();
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let lastSaveError: string | null = null;

function emit(): void {
  for (const l of listeners) l();
}

function scheduleSave(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void persistence
      .saveDatabase(state)
      .then(() => {
        if (lastSaveError) {
          lastSaveError = null;
          emit();
        }
      })
      .catch((error: Error) => {
        lastSaveError = error.message;
        emit();
      });
  }, 200);
}

function set(updater: (db: Database) => Database): void {
  state = updater(state);
  emit();
  scheduleSave();
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getState(): Database {
  return state;
}

export function isLoaded(): boolean {
  return loaded;
}

export function getSaveError(): string | null {
  return lastSaveError;
}

/** Flush any pending write. Used by tests and before an export. */
export async function flush(): Promise<void> {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  await persistence.saveDatabase(state);
}

export async function init(): Promise<void> {
  const db = await persistence.loadDatabase();
  if (db.templates.length === 0) db.templates = defaultTemplates(nowIso());
  state = db;
  loaded = true;
  emit();
}

/** Test seam. */
export function __setStateForTests(db: Database): void {
  state = db;
  loaded = true;
  emit();
}

// ---------------------------------------------------------------- contacts

export function createContact(input: Partial<Contact>): Contact {
  const now = nowIso();
  const contact: Contact = {
    id: newId('con'),
    firstName: '',
    lastName: '',
    rawName: '',
    company: '',
    email: '',
    phone: '',
    address: '',
    city: '',
    state: '',
    zip: '',
    contactTypes: [],
    status: 'Prospect',
    prospectStatus: 'New',
    notes: '',
    custom: {},
    nameConfidence: 'high',
    needsReview: false,
    createdAt: now,
    updatedAt: now,
    ...input,
  };
  contact.email = normalizeEmail(contact.email);
  if (!contact.rawName) contact.rawName = [contact.firstName, contact.lastName].filter(Boolean).join(' ');
  set((db) => ({ ...db, contacts: [...db.contacts, contact] }));
  return contact;
}

export function updateContact(id: string, patch: Partial<Contact>): void {
  set((db) => ({
    ...db,
    contacts: db.contacts.map((c) =>
      c.id === id ? { ...c, ...patch, email: normalizeEmail(patch.email ?? c.email), updatedAt: nowIso() } : c,
    ),
  }));
}

/** Removes the contact and detaches it from aircraft, opportunities and tasks. */
export function deleteContact(id: string): void {
  set((db) => ({
    ...db,
    contacts: db.contacts.filter((c) => c.id !== id),
    aircraft: db.aircraft.map((a) =>
      a.ownerships.some((o) => o.contactId === id)
        ? { ...a, ownerships: a.ownerships.filter((o) => o.contactId !== id) }
        : a,
    ),
    opportunities: db.opportunities.map((o) => (o.contactId === id ? { ...o, contactId: null } : o)),
    activities: db.activities.filter((a) => a.contactId !== id || a.aircraftId || a.opportunityId),
    followUps: db.followUps.filter((f) => f.contactId !== id || f.aircraftId || f.opportunityId),
  }));
}

// ---------------------------------------------------------------- aircraft

export function createAircraft(input: Partial<Aircraft> & { tailNumber: string }): Aircraft {
  const now = nowIso();
  const aircraft: Aircraft = {
    id: newId('acf'),
    tailNumber: formatTail(input.tailNumber),
    tailKey: normalizeTail(input.tailNumber),
    year: '',
    make: '',
    model: '',
    ownerships: [],
    status: 'Unknown',
    notes: '',
    custom: {},
    createdAt: now,
    updatedAt: now,
    ...input,
    // Recomputed after the spread so a caller cannot desynchronise them.
  };
  aircraft.tailNumber = formatTail(input.tailNumber);
  aircraft.tailKey = normalizeTail(input.tailNumber);
  set((db) => ({ ...db, aircraft: [...db.aircraft, aircraft] }));
  return aircraft;
}

export function updateAircraft(id: string, patch: Partial<Aircraft>): void {
  set((db) => ({
    ...db,
    aircraft: db.aircraft.map((a) => {
      if (a.id !== id) return a;
      const next = { ...a, ...patch, updatedAt: nowIso() };
      if (patch.tailNumber !== undefined) {
        next.tailNumber = formatTail(patch.tailNumber);
        next.tailKey = normalizeTail(patch.tailNumber);
      }
      return next;
    }),
  }));
}

export function deleteAircraft(id: string): void {
  set((db) => ({
    ...db,
    aircraft: db.aircraft.filter((a) => a.id !== id),
    opportunities: db.opportunities.map((o) => (o.aircraftId === id ? { ...o, aircraftId: null } : o)),
    activities: db.activities.filter((a) => a.aircraftId !== id || a.contactId || a.opportunityId),
    followUps: db.followUps.filter((f) => f.aircraftId !== id || f.contactId || f.opportunityId),
  }));
}

/** Make `contactId` the current owner, retiring the previous owner's record. */
export function setAircraftOwner(aircraftId: string, contactId: string | null): void {
  const now = nowIso();
  set((db) => ({
    ...db,
    aircraft: db.aircraft.map((a) => {
      if (a.id !== aircraftId) return a;
      const ownerships = a.ownerships.map((o) => ({ ...o }));
      if (contactId === null) {
        for (const o of ownerships) if (!o.endedAt) o.endedAt = now;
        return { ...a, ownerships, updatedAt: now };
      }
      const copy = { ...a, ownerships };
      linkOwner(copy, contactId, now);
      copy.updatedAt = now;
      return copy;
    }),
  }));
}

export function findAircraftByTail(tail: string): Aircraft | undefined {
  const key = normalizeTail(tail);
  if (!key) return undefined;
  return state.aircraft.find((a) => (a.tailKey || normalizeTail(a.tailNumber)) === key);
}

// ----------------------------------------------------------- opportunities

export function createOpportunity(input: Partial<Opportunity>): Opportunity {
  const now = nowIso();
  const opportunity: Opportunity = {
    id: newId('opp'),
    contactId: null,
    aircraftId: null,
    type: 'Insurance',
    status: 'Open',
    title: '',
    openedAt: now,
    notes: '',
    createdAt: now,
    updatedAt: now,
    ...input,
  };
  set((db) => ({ ...db, opportunities: [...db.opportunities, opportunity] }));
  return opportunity;
}

export function updateOpportunity(id: string, patch: Partial<Opportunity>): void {
  set((db) => ({
    ...db,
    opportunities: db.opportunities.map((o) => (o.id === id ? { ...o, ...patch, updatedAt: nowIso() } : o)),
  }));
}

export function deleteOpportunity(id: string): void {
  set((db) => ({
    ...db,
    opportunities: db.opportunities.filter((o) => o.id !== id),
    activities: db.activities.map((a) => (a.opportunityId === id ? { ...a, opportunityId: null } : a)),
    followUps: db.followUps.filter((f) => f.opportunityId !== id || f.contactId || f.aircraftId),
  }));
}

// --------------------------------------------------------------- activities

export function logActivity(input: {
  type: ActivityType;
  subject: string;
  notes?: string;
  date?: string;
  contactId?: string | null;
  aircraftId?: string | null;
  opportunityId?: string | null;
}): Activity {
  const now = nowIso();
  const activity: Activity = {
    id: newId('act'),
    contactId: input.contactId ?? null,
    aircraftId: input.aircraftId ?? null,
    opportunityId: input.opportunityId ?? null,
    type: input.type,
    date: input.date ?? now,
    subject: input.subject,
    notes: input.notes ?? '',
    createdAt: now,
  };
  set((db) => ({
    ...db,
    activities: [...db.activities, activity],
    contacts:
      activity.contactId && ['Email', 'Call', 'Text', 'Meeting'].includes(activity.type)
        ? db.contacts.map((c) => (c.id === activity.contactId ? { ...c, lastContactedAt: activity.date } : c))
        : db.contacts,
  }));
  return activity;
}

export function deleteActivity(id: string): void {
  set((db) => ({ ...db, activities: db.activities.filter((a) => a.id !== id) }));
}

// --------------------------------------------------------------- follow-ups

export function createFollowUp(input: {
  dueDate: string;
  note: string;
  contactId?: string | null;
  aircraftId?: string | null;
  opportunityId?: string | null;
}): FollowUp {
  const now = nowIso();
  const followUp: FollowUp = {
    id: newId('fup'),
    contactId: input.contactId ?? null,
    aircraftId: input.aircraftId ?? null,
    opportunityId: input.opportunityId ?? null,
    dueDate: input.dueDate,
    note: input.note,
    completed: false,
    createdAt: now,
    updatedAt: now,
  };
  set((db) => ({ ...db, followUps: [...db.followUps, followUp] }));
  return followUp;
}

export function updateFollowUp(id: string, patch: Partial<FollowUp>): void {
  set((db) => ({
    ...db,
    followUps: db.followUps.map((f) => (f.id === id ? { ...f, ...patch, updatedAt: nowIso() } : f)),
  }));
}

export function completeFollowUp(id: string, completed = true): void {
  updateFollowUp(id, { completed, completedAt: completed ? nowIso() : undefined });
}

export function deleteFollowUp(id: string): void {
  set((db) => ({ ...db, followUps: db.followUps.filter((f) => f.id !== id) }));
}

// ---------------------------------------------------------------- templates

export function saveTemplate(template: EmailTemplate): void {
  set((db) => {
    const exists = db.templates.some((t) => t.id === template.id);
    const next = { ...template, updatedAt: nowIso() };
    return {
      ...db,
      templates: exists ? db.templates.map((t) => (t.id === template.id ? next : t)) : [...db.templates, next],
    };
  });
}

export function createTemplate(name: string): EmailTemplate {
  const now = nowIso();
  const template: EmailTemplate = {
    id: newId('tpl'),
    name,
    subject: 'RE: {{tail}}',
    body: 'Hi {{firstName}},\n\n\n\nBest regards,\n{{senderName}}',
    createdAt: now,
    updatedAt: now,
  };
  set((db) => ({ ...db, templates: [...db.templates, template] }));
  return template;
}

export function deleteTemplate(id: string): void {
  set((db) => ({ ...db, templates: db.templates.filter((t) => t.id !== id || t.builtIn) }));
}

export function resetTemplates(): void {
  set((db) => ({ ...db, templates: defaultTemplates(nowIso()) }));
}

// -------------------------------------------------------------------- files

export async function addFile(
  file: File,
  links: { contactId?: string | null; aircraftId?: string | null; opportunityId?: string | null },
): Promise<FileRecord> {
  const record: FileRecord = {
    id: newId('fil'),
    name: file.name,
    mimeType: file.type || 'application/octet-stream',
    size: file.size,
    contactId: links.contactId ?? null,
    aircraftId: links.aircraftId ?? null,
    opportunityId: links.opportunityId ?? null,
    createdAt: nowIso(),
  };
  await persistence.putFileBlob(record.id, file);
  set((db) => ({ ...db, files: [...db.files, record] }));
  return record;
}

export async function removeFile(id: string): Promise<void> {
  await persistence.deleteFileBlob(id);
  set((db) => ({ ...db, files: db.files.filter((f) => f.id !== id) }));
}

export function getFile(id: string): Promise<Blob | undefined> {
  return persistence.getFileBlob(id);
}

// ------------------------------------------------------------------ imports

export function commitImport(result: {
  contacts: Contact[];
  aircraft: Aircraft[];
  activities: Activity[];
  record: ImportRecord;
}): void {
  set((db) => ({
    ...db,
    contacts: result.contacts,
    aircraft: result.aircraft,
    activities: [...db.activities, ...result.activities],
    imports: [result.record, ...db.imports],
  }));
}

export function deleteImportRecord(id: string): void {
  set((db) => ({ ...db, imports: db.imports.filter((i) => i.id !== id) }));
}

// ------------------------------------------------------------ layover spots

export function saveLayoverSpot(input: Partial<LayoverSpot> & { place: string; name: string }): LayoverSpot {
  const now = nowIso();
  const spot: LayoverSpot = {
    id: input.id ?? newId('spt'),
    place: input.place,
    name: input.name,
    category: input.category ?? 'Restaurant',
    notes: input.notes ?? '',
    url: input.url,
    rating: input.rating,
    createdAt: input.createdAt ?? now,
    updatedAt: now,
  };
  set((db) => ({
    ...db,
    layoverSpots: db.layoverSpots.some((s) => s.id === spot.id)
      ? db.layoverSpots.map((s) => (s.id === spot.id ? spot : s))
      : [spot, ...db.layoverSpots],
  }));
  return spot;
}

export function deleteLayoverSpot(id: string): void {
  set((db) => ({ ...db, layoverSpots: db.layoverSpots.filter((s) => s.id !== id) }));
}

// ----------------------------------------------------------------- settings

export function updateSettings(patch: Partial<Settings>): void {
  set((db) => ({ ...db, settings: { ...db.settings, ...patch } }));
}

// ------------------------------------------------------------ whole-dataset

export function replaceDatabase(db: Database): void {
  set(() => ({ ...db, version: emptyDatabase().version }));
}

export async function eraseEverything(): Promise<void> {
  await persistence.clearAll();
  state = { ...emptyDatabase(), templates: defaultTemplates(nowIso()) };
  emit();
  scheduleSave();
}
