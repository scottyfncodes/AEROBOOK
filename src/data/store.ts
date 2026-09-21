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
  type DocumentCategory,
  type FileRecord,
  type FollowUp,
  type ImportRecord,
  type InsurancePolicy,
  type Opportunity,
  type Settings,
} from './types';

type Listener = () => void;

let state: Database = emptyDatabase();
let loaded = false;
const listeners = new Set<Listener>();
let lastSaveError: string | null = null;

/**
 * Saving starts the moment something changes — a debounce here means a change
 * made just before the user navigates or closes the tab is never written. A
 * save already in flight is not cancelled; the store simply remembers that the
 * document moved on and writes again when the first write lands.
 */
let saveInFlight: Promise<void> | null = null;
let saveAgain = false;

function emit(): void {
  for (const l of listeners) l();
}

function runSave(): Promise<void> {
  return persistence
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
    })
    .then(() => {
      if (saveAgain) {
        saveAgain = false;
        return runSave();
      }
      saveInFlight = null;
      return undefined;
    });
}

function scheduleSave(): void {
  if (saveInFlight) {
    saveAgain = true;
    return;
  }
  saveInFlight = runSave();
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

/** Wait for any write already started to land. */
async function drain(): Promise<void> {
  while (saveInFlight) await saveInFlight;
}

/** Wait for every pending write to land. Used by tests and before an export. */
export async function flush(): Promise<void> {
  await drain();
  await persistence.saveDatabase(state);
}

export async function init(): Promise<void> {
  const db = await persistence.loadDatabase();
  if (db.templates.length === 0) db.templates = defaultTemplates(nowIso());
  state = db;
  loaded = true;
  emit();
  // loadDatabase() runs the version migration on whatever was on disk, but
  // does not itself write the result back. Until something else happens to
  // save, the stored document is still in its old shape — so a reload right
  // now would migrate the same old document again, generating a *new* id for
  // anything the migration derives (see db.ts). Saving once, right after
  // load, makes the migration durable immediately instead of leaving that
  // window open for however long it takes the user to make their first edit.
  scheduleSave();
  // Best-effort: ask the browser not to evict this origin's storage under
  // disk pressure. Does not block first paint either way.
  void persistence.requestPersistentStorage();
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
    policies: db.policies.map((p) => (p.contactId === id ? { ...p, contactId: null } : p)),
    activities: db.activities.filter((a) => a.contactId !== id || a.aircraftId || a.opportunityId),
    followUps: db.followUps.filter((f) => f.contactId !== id || f.aircraftId || f.opportunityId),
  }));
}

// ---------------------------------------------------------------- aircraft

export function createAircraft(input: Partial<Aircraft> & { tailNumber: string }): Aircraft {
  const now = nowIso();
  const aircraft: Aircraft = {
    id: newId('acf'),
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
    // Derived after the spread so the pair can never fall out of sync.
    tailNumber: formatTail(input.tailNumber),
    tailKey: normalizeTail(input.tailNumber),
  };
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
    // A policy without its aircraft is a renewal nobody can act on.
    policies: db.policies.filter((p) => p.aircraftId !== id),
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
    status: 'Lead',
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
    // The policy outlives the deal it was being worked under.
    policies: db.policies.map((p) => (p.opportunityId === id ? { ...p, opportunityId: null } : p)),
    activities: db.activities.map((a) => (a.opportunityId === id ? { ...a, opportunityId: null } : a)),
    followUps: db.followUps.filter((f) => f.opportunityId !== id || f.contactId || f.aircraftId),
  }));
}

/**
 * Moving an opportunity forward is the single most common edit in the app, so
 * it gets its own mutation — and it records itself on the timeline, because
 * "when did this become a quote?" is a question worth being able to answer.
 */
export function setOpportunityStatus(id: string, status: import('./types').OpportunityStatus): void {
  const current = state.opportunities.find((o) => o.id === id);
  if (!current || current.status === status) return;
  const from = current.status;
  updateOpportunity(id, { status });
  logActivity({
    contactId: current.contactId,
    aircraftId: current.aircraftId,
    opportunityId: id,
    type: 'Status Change',
    subject: `${from} → ${status}`,
    notes: current.title,
  });
}

// ------------------------------------------------------- insurance policies

export function createPolicy(input: Partial<InsurancePolicy>): InsurancePolicy {
  const now = nowIso();
  const policy: InsurancePolicy = {
    id: newId('pol'),
    aircraftId: null,
    contactId: null,
    opportunityId: null,
    carrier: '',
    policyNumber: '',
    brokerAgent: '',
    premium: '',
    hullValue: '',
    liabilityLimit: '',
    deductible: '',
    status: 'Unknown',
    quotedPremium: '',
    renewalNotes: '',
    notes: '',
    createdAt: now,
    updatedAt: now,
    ...input,
  };
  set((db) => ({ ...db, policies: [...db.policies, policy] }));
  return policy;
}

export function updatePolicy(id: string, patch: Partial<InsurancePolicy>): void {
  set((db) => ({
    ...db,
    policies: db.policies.map((p) => (p.id === id ? { ...p, ...patch, updatedAt: nowIso() } : p)),
  }));
}

export function deletePolicy(id: string): void {
  set((db) => ({
    ...db,
    policies: db.policies.filter((p) => p.id !== id),
    followUps: db.followUps.map((f) =>
      f.insurancePolicyId === id ? { ...f, insurancePolicyId: null } : f,
    ),
    files: db.files.map((f) => (f.insurancePolicyId === id ? { ...f, insurancePolicyId: null } : f)),
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
    updatedAt: now,
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

/**
 * Edits a timeline entry in place — same id, same links, same createdAt.
 * Only what the user can actually change through the sheet moves.
 */
export function updateActivity(
  id: string,
  patch: { type?: ActivityType; subject?: string; notes?: string; date?: string },
): void {
  set((db) => ({
    ...db,
    activities: db.activities.map((a) => (a.id === id ? { ...a, ...patch, updatedAt: nowIso() } : a)),
  }));
}

export function deleteActivity(id: string): void {
  set((db) => ({ ...db, activities: db.activities.filter((a) => a.id !== id) }));
}

// --------------------------------------------------------------- follow-ups

export function createFollowUp(input: {
  dueDate: string;
  note: string;
  priority?: import('./types').FollowUpPriority;
  contactId?: string | null;
  aircraftId?: string | null;
  opportunityId?: string | null;
  insurancePolicyId?: string | null;
}): FollowUp {
  const now = nowIso();
  const followUp: FollowUp = {
    id: newId('fup'),
    contactId: input.contactId ?? null,
    aircraftId: input.aircraftId ?? null,
    opportunityId: input.opportunityId ?? null,
    insurancePolicyId: input.insurancePolicyId ?? null,
    dueDate: input.dueDate,
    note: input.note,
    priority: input.priority ?? 'Normal',
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

/**
 * Completing a follow-up is the moment the user knows what happened, so it is
 * also the cheapest moment to capture it. The outcome, when given, lands on
 * the timeline of every record the follow-up was attached to.
 */
export function completeFollowUp(id: string, completed = true, outcome?: string): void {
  const followUp = state.followUps.find((f) => f.id === id);
  updateFollowUp(id, {
    completed,
    completedAt: completed ? nowIso() : undefined,
    outcome: completed ? outcome?.trim() || followUp?.outcome : undefined,
  });
  if (completed && followUp) {
    logActivity({
      contactId: followUp.contactId,
      aircraftId: followUp.aircraftId,
      opportunityId: followUp.opportunityId,
      type: 'Follow-Up',
      subject: followUp.note || 'Follow-up completed',
      notes: outcome?.trim() ?? '',
    });
  }
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
  links: {
    contactId?: string | null;
    aircraftId?: string | null;
    opportunityId?: string | null;
    insurancePolicyId?: string | null;
  },
  category: DocumentCategory = 'Other',
): Promise<FileRecord> {
  const record: FileRecord = {
    id: newId('fil'),
    name: file.name,
    mimeType: file.type || 'application/octet-stream',
    size: file.size,
    contactId: links.contactId ?? null,
    aircraftId: links.aircraftId ?? null,
    opportunityId: links.opportunityId ?? null,
    insurancePolicyId: links.insurancePolicyId ?? null,
    category,
    createdAt: nowIso(),
  };
  // The blob is written first: a row pointing at a file that was never stored
  // would be a lie the user could not see.
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

// ----------------------------------------------------------------- settings

export function updateSettings(patch: Partial<Settings>): void {
  set((db) => ({ ...db, settings: { ...db.settings, ...patch } }));
}

// ------------------------------------------------------------ whole-dataset

export function replaceDatabase(db: Database): void {
  set(() => ({ ...db, version: emptyDatabase().version }));
}

export async function eraseEverything(): Promise<void> {
  // Let any write already in flight finish, so it cannot land after the wipe.
  await drain();
  await persistence.clearAll();
  state = { ...emptyDatabase(), templates: defaultTemplates(nowIso()) };
  emit();
  scheduleSave();
}
