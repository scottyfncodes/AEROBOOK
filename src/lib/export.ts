/**
 * Export helpers. Everything the user put in, they can take out.
 *
 * Every CSV ends with the record's ID and the IDs of what it is linked to, so
 * a spreadsheet can be joined back together exactly; the earlier columns are
 * kept in their old order for anyone who already reads them.
 */
import type { Aircraft, Contact, Database } from '../data/types';
import { taskLabel } from './tasks';
import { toCsv } from './csv';
import { displayName } from './names';
import { formatPhone, formatZip } from './phone';
import { policyState } from './insurance';
import { migrate } from '../data/db';

export function contactsCsv(db: Pick<Database, 'contacts' | 'aircraft'>): string {
  const headers = [
    'First name', 'Last name', 'Raw name', 'Company', 'Email', 'Phone', 'Address', 'Address 2',
    'City', 'State', 'ZIP', 'Status', 'Prospect status', 'Contact types', 'Aircraft',
    'Selling interest', 'Buying interest', 'Wants', 'Budget', 'Timeline', 'Insurance interest',
    'Notes', 'Last contacted', 'Created', 'Updated',
    'Middle name', 'Suffix', 'Name role', 'Country', 'Selling notes', 'Mission', 'Insurance notes', 'Source',
    'Name confidence', 'Needs review', 'Custom fields', 'ID',
  ];
  const rows = db.contacts.map((c) => {
    const tails = db.aircraft
      .filter((a) => a.ownerships.some((o) => o.contactId === c.id && !o.endedAt))
      .map((a) => a.tailNumber)
      .join(' ');
    return [
      c.firstName, c.lastName, c.rawName, c.company, c.email, formatPhone(c.phone), c.address, c.address2 ?? '',
      c.city, c.state, formatZip(c.zip), c.status, c.prospectStatus, c.contactTypes.join('; '), tails,
      c.intent?.selling ?? '', c.intent?.buying ?? '', c.intent?.wantedAircraft ?? '',
      c.intent?.budget ?? '', c.intent?.timeline ?? '', c.intent?.insurance ?? '',
      c.notes, c.lastContactedAt ?? '', c.createdAt, c.updatedAt,
      c.middleName ?? '', c.suffix ?? '', c.role ?? '', c.country ?? '', c.intent?.sellingNotes ?? '',
      c.intent?.mission ?? '', c.intent?.insuranceNotes ?? '', c.source ?? '', c.nameConfidence,
      c.needsReview ? 'yes' : 'no', customFields(c.custom), c.id,
    ];
  });
  return toCsv(headers, rows);
}

export function aircraftCsv(db: Pick<Database, 'contacts' | 'aircraft'>): string {
  const byId = new Map(db.contacts.map((c) => [c.id, c]));
  const headers = [
    'Tail number', 'Year', 'Make', 'Model', 'Serial', 'Base airport', 'Status', 'Owner',
    'Owner email', 'Owner phone', 'Asking price', 'Listing status', 'Listing URL', 'Notes',
    'Created', 'Updated', 'Target price', 'Previous owners', 'Source', 'Custom fields', 'ID', 'Owner ID',
    'Previous owner IDs',
  ];
  const rows = db.aircraft.map((a) => {
    const ownerId = a.ownerships.find((o) => !o.endedAt)?.contactId;
    const owner = ownerId ? byId.get(ownerId) : undefined;
    const previous = a.ownerships.filter((o) => o.endedAt);
    return [
      a.tailNumber, a.year, a.make, a.model, a.serial ?? '', a.baseAirport ?? '', a.status,
      owner ? displayName(owner) : '', owner?.email ?? '', owner ? formatPhone(owner.phone) : '',
      a.askingPrice ?? '', a.listingStatus ?? '', a.listingUrl ?? '', a.notes, a.createdAt, a.updatedAt,
      a.targetPrice ?? '',
      previous.map((o) => `${nameOf(byId, o.contactId)} (until ${o.endedAt})`).join('; '),
      a.source ?? '', customFields(a.custom), a.id, ownerId ?? '', previous.map((o) => o.contactId).join('; '),
    ];
  });
  return toCsv(headers, rows);
}

export function opportunitiesCsv(db: Pick<Database, 'contacts' | 'aircraft' | 'opportunities'>): string {
  const contacts = new Map(db.contacts.map((c) => [c.id, c]));
  const aircraft = new Map(db.aircraft.map((a) => [a.id, a]));
  const headers = [
    'Title', 'Type', 'Status', 'Contact', 'Aircraft', 'Opened', 'Estimated value', 'Next action', 'Notes',
    'Created', 'Updated', 'ID', 'Contact ID', 'Aircraft ID',
  ];
  const rows = db.opportunities.map((o) => [
    o.title, o.type, o.status,
    o.contactId ? displayName(contacts.get(o.contactId) ?? {}) : '',
    o.aircraftId ? (aircraft.get(o.aircraftId)?.tailNumber ?? '') : '',
    o.openedAt, o.estimatedValue ?? '', o.nextAction ?? '', o.notes,
    o.createdAt, o.updatedAt, o.id, o.contactId ?? '', o.aircraftId ?? '',
  ]);
  return toCsv(headers, rows);
}

export function policiesCsv(db: Pick<Database, 'contacts' | 'aircraft' | 'policies'>): string {
  const contacts = new Map(db.contacts.map((c) => [c.id, c]));
  const aircraft = new Map(db.aircraft.map((a) => [a.id, a]));
  const headers = [
    'Aircraft', 'Insured', 'Carrier', 'Policy number', 'Broker/agent', 'Effective', 'Expiration',
    'Renewal status', 'Days to renewal', 'Premium', 'Hull value', 'Liability limit', 'Deductible',
    'Last quote', 'Quoted premium', 'Renewal notes', 'Notes',
    'Status as set', 'Created', 'Updated', 'ID', 'Aircraft ID', 'Contact ID', 'Opportunity ID',
  ];
  const rows = db.policies.map((p) => {
    const state = policyState(p);
    return [
      p.aircraftId ? (aircraft.get(p.aircraftId)?.tailNumber ?? '') : '',
      p.contactId ? displayName(contacts.get(p.contactId) ?? {}) : '',
      p.carrier, p.policyNumber, p.brokerAgent, p.effectiveDate ?? '', p.expirationDate ?? '',
      state.status, state.days === null ? '' : String(state.days),
      p.premium, p.hullValue, p.liabilityLimit, p.deductible,
      p.lastQuoteDate ?? '', p.quotedPremium, p.renewalNotes, p.notes,
      p.status, p.createdAt, p.updatedAt, p.id, p.aircraftId ?? '', p.contactId ?? '', p.opportunityId ?? '',
    ];
  });
  return toCsv(headers, rows);
}

function customFields(custom: Record<string, string> | undefined): string {
  return custom && Object.keys(custom).length ? JSON.stringify(custom) : '';
}

function nameOf(contacts: Map<string, Contact>, id: string | null | undefined): string {
  const c = id ? contacts.get(id) : undefined;
  return c ? displayName(c) : '';
}

type Linked = Pick<Database, 'contacts' | 'aircraft' | 'opportunities'>;

function linkNames(db: Linked) {
  const contacts = new Map(db.contacts.map((c) => [c.id, c]));
  const aircraft = new Map(db.aircraft.map((a) => [a.id, a]));
  const opportunities = new Map(db.opportunities.map((o) => [o.id, o]));
  return {
    contact: (id: string | null | undefined) => nameOf(contacts, id),
    aircraft: (id: string | null | undefined) => (id ? aircraft.get(id)?.tailNumber ?? '' : ''),
    opportunity: (id: string | null | undefined) => (id ? opportunities.get(id)?.title ?? '' : ''),
  };
}

/** The timeline: every call, email, meeting and note, with what it is about. */
export function activitiesCsv(db: Linked & Pick<Database, 'activities'>): string {
  const n = linkNames(db);
  const headers = [
    'Date', 'Type', 'Subject', 'Notes', 'Contact', 'Aircraft', 'Opportunity', 'Created', 'Updated',
    'ID', 'Contact ID', 'Aircraft ID', 'Opportunity ID',
  ];
  const rows = db.activities.map((a) => [
    a.date, a.type, a.subject, a.notes, n.contact(a.contactId), n.aircraft(a.aircraftId), n.opportunity(a.opportunityId),
    a.createdAt, a.updatedAt ?? '', a.id, a.contactId ?? '', a.aircraftId ?? '', a.opportunityId ?? '',
  ]);
  return toCsv(headers, rows);
}

export function followUpsCsv(db: Linked & Pick<Database, 'followUps'>, people: Map<string, string> = new Map()): string {
  const n = linkNames(db);
  const headers = [
    'Due', 'What', 'Note', 'Priority', 'Done', 'Completed', 'Outcome', 'For', 'Given by', 'Contact', 'Aircraft',
    'Opportunity', 'Created', 'Updated', 'ID', 'For (user ID)', 'Given by (user ID)', 'Contact ID', 'Aircraft ID',
    'Opportunity ID', 'Insurance policy ID',
  ];
  const rows = db.followUps.map((f) => [
    f.dueDate, taskLabel(f.kind), f.note, f.priority ?? 'Normal', f.completed ? 'yes' : 'no', f.completedAt ?? '',
    f.outcome ?? '', f.assigneeId ? people.get(f.assigneeId) ?? '' : 'Everyone', f.assignedBy ? people.get(f.assignedBy) ?? '' : '',
    n.contact(f.contactId), n.aircraft(f.aircraftId), n.opportunity(f.opportunityId), f.createdAt, f.updatedAt,
    f.id, f.assigneeId ?? '', f.assignedBy ?? '', f.contactId ?? '', f.aircraftId ?? '', f.opportunityId ?? '',
    f.insurancePolicyId ?? '',
  ]);
  return toCsv(headers, rows);
}

/** Where each document's file is in an archive, and its SHA-256, when the file came with it. */
export type ArchivedFiles = Map<string, { path: string; sha256: string } | null>;

export function documentsCsv(db: Linked & Pick<Database, 'files'>, archived: ArchivedFiles = new Map()): string {
  const n = linkNames(db);
  const headers = [
    'Name', 'Category', 'Type', 'Size (bytes)', 'Contact', 'Aircraft', 'Opportunity', 'Added', 'File in this archive',
    'SHA-256', 'Stored at', 'ID', 'Contact ID', 'Aircraft ID', 'Opportunity ID', 'Insurance policy ID',
  ];
  const rows = db.files.map((f) => {
    const a = archived.get(f.id);
    return [
      f.name, f.category ?? '', f.mimeType, f.size, n.contact(f.contactId), n.aircraft(f.aircraftId),
      n.opportunity(f.opportunityId), f.createdAt, a ? a.path : archived.has(f.id) ? 'MISSING' : '', a?.sha256 ?? '',
      f.blobPath ?? 'this browser only', f.id, f.contactId ?? '', f.aircraftId ?? '', f.opportunityId ?? '',
      f.insurancePolicyId ?? '',
    ];
  });
  return toCsv(headers, rows);
}

/** An aircraft's discussion, as GET /api/export/comments gives it. */
export interface ExportedComment {
  id: number;
  aircraftId: string;
  authorId: string;
  authorName: string;
  body: string;
  createdAt: string;
  editedAt: string | null;
}

export function commentsCsv(db: Pick<Database, 'aircraft'>, comments: ExportedComment[]): string {
  const tails = new Map(db.aircraft.map((a) => [a.id, a.tailNumber]));
  const headers = ['Aircraft', 'Written by', 'Written', 'Edited', 'Comment', 'ID', 'Aircraft ID', 'Author (user ID)'];
  const rows = comments.map((c) => [
    tails.get(c.aircraftId) ?? '', c.authorName, c.createdAt, c.editedAt ?? '', c.body, c.id, c.aircraftId, c.authorId,
  ]);
  return toCsv(headers, rows);
}

/**
 * The complete dataset, re-importable. Attached document *rows* are included;
 * the file contents themselves are not — JSON cannot carry them. The complete
 * archive (lib/archive.ts) carries both.
 */
export function fullJson(db: Database): string {
  return JSON.stringify({ ...db, exportedAt: new Date().toISOString(), app: 'AEROBOOK' }, null, 2);
}

/**
 * A backup can be older than the app restoring it, so it goes through the
 * same migration a stored document does. Restoring a version 1 export
 * without it would hand the UI a database with no `policies` at all.
 */
export function parseFullJson(text: string): Database {
  const parsed = JSON.parse(text) as Database;
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.contacts)) {
    throw new Error('This file does not look like an AEROBOOK export.');
  }
  return migrate(parsed);
}

export function downloadText(filename: string, mime: string, text: string): void {
  downloadBlob(filename, new Blob([text], { type: `${mime};charset=utf-8` }));
}

export function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function exportFilename(kind: string, ext: string): string {
  const d = new Date();
  const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return `aerobook-${kind}-${stamp}.${ext}`;
}

export type { Contact, Aircraft };
