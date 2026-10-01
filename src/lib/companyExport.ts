/**
 * The company data export: everything the company keeps in AEROBOOK, as files
 * any spreadsheet or program can read, so the data can leave with the
 * company. Pure — the records, people, comments, audit log and document
 * bytes come in; the files of the package come out. src/data/companyExport.ts
 * fetches the inputs and zips the result.
 *
 * Every record keeps its AEROBOOK id, and every file that refers to another
 * record carries that record's id beside its name, so the files join back
 * together outside AEROBOOK (contacts.csv "Contact ID" = activities.csv
 * "Contact ID", and so on).
 */
import type {
  Activity, Aircraft, Contact, Database, EmailTemplate, FileRecord, FollowUp, ImportRecord,
  InsurancePolicy, Opportunity,
} from '../data/types';
import { toCsv } from './csv';
import { displayName } from './names';
import { taskLabel } from './tasks';
import type { ZipEntry } from './zip';

export const EXPORT_FOLDER = 'AEROBOOK-Company-Export';

/** What the server adds to the records every device holds (see server/export.ts). */
export interface ExportPerson {
  id: string;
  name: string;
  email: string;
  role: 'admin' | 'user';
  access: 'active' | 'off' | 'deleted';
  twoStepSignIn: boolean;
  createdAt: string;
}

export interface ExportComment {
  id: number;
  aircraftId: string;
  authorId: string;
  authorName: string;
  body: string;
  createdAt: string;
  editedAt: string | null;
}

export interface ExportAuditEntry {
  id: number;
  at: string;
  userId: string | null;
  userName: string;
  action: string;
  collection: string;
  recordId: string;
  summary: string;
}

/** A document's bytes, or why they could not be fetched. */
export type DocumentContent = { data: Uint8Array } | { missing: string };

export type ExportRecords = Pick<
  Database,
  'contacts' | 'aircraft' | 'opportunities' | 'policies' | 'activities' | 'followUps' | 'templates' | 'files' | 'imports'
>;

export interface CompanyExportInput {
  records: ExportRecords;
  /** The full backup, restorable through Settings, as Settings' own "Export everything" writes it. */
  backupJson: string;
  people: ExportPerson[];
  comments: ExportComment[];
  audit: ExportAuditEntry[];
  documents: Map<string, DocumentContent>;
  exportedAt: string;
  exportedBy: { id: string; name: string };
}

// ----------------------------------------------------------------- values

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * One way of writing a time: UTC, ISO 8601, to the millisecond. A calendar
 * date (a due date, an expiration) stays a date. Anything else is left as it
 * was typed rather than guessed at.
 */
export function exportTime(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return '';
  if (DATE_ONLY.test(value)) return value;
  const t = Date.parse(value);
  return Number.isNaN(t) ? value : new Date(t).toISOString();
}

const text = (v: unknown) => (v === null || v === undefined ? '' : String(v));
const yesNo = (v: unknown) => (v ? 'Yes' : 'No');
const list = (v: unknown) => (Array.isArray(v) ? v.join('; ') : text(v));
const json = (v: unknown) => (v && typeof v === 'object' && Object.keys(v).length ? JSON.stringify(v) : '');

/** UTF-8 with a byte-order mark, so Excel reads accents and non-English text as they are. */
function csvFile(headers: string[], rows: unknown[][]): Uint8Array {
  return new TextEncoder().encode(`﻿${toCsv(headers, rows)}\r\n`);
}

/** A name safe to put in a ZIP path on any system, keeping as much of the original as it can. */
export function safeFilename(name: string): string {
  const cleaned = name
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, '_')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 180);
  return cleaned || 'document';
}

// ------------------------------------------------------------- who did it

interface Authorship {
  createdBy: string;
  createdById: string;
  changedBy: string;
  changedById: string;
}

/** Who recorded each record and who changed it last, from the audit log. */
function authorship(audit: ExportAuditEntry[]): Map<string, Authorship> {
  const by = new Map<string, Authorship>();
  for (const e of [...audit].sort((a, b) => a.id - b.id)) {
    if (e.action !== 'create' && e.action !== 'update') continue;
    const key = `${e.collection}:${e.recordId}`;
    const now = by.get(key);
    if (!now) {
      by.set(key, {
        createdBy: e.action === 'create' ? e.userName : '',
        createdById: e.action === 'create' ? text(e.userId) : '',
        changedBy: e.userName,
        changedById: text(e.userId),
      });
    } else {
      now.changedBy = e.userName;
      now.changedById = text(e.userId);
    }
  }
  return by;
}

// ------------------------------------------------------------------ build

export function buildCompanyExport(input: CompanyExportInput): ZipEntry[] {
  const { records, people, comments, audit, documents } = input;
  const contacts = new Map(records.contacts.map((c) => [c.id, c]));
  const aircraft = new Map(records.aircraft.map((a) => [a.id, a]));
  const opportunities = new Map(records.opportunities.map((o) => [o.id, o]));
  const names = new Map(people.map((p) => [p.id, p.name]));
  const who = authorship(audit);
  const by = (collection: string, id: string) =>
    who.get(`${collection}:${id}`) ?? { createdBy: '', createdById: '', changedBy: '', changedById: '' };

  const contactName = (id: string | null | undefined) => (id && contacts.has(id) ? displayName(contacts.get(id)!) : '');
  const company = (id: string | null | undefined) => (id ? text(contacts.get(id)?.company) : '');
  const tail = (id: string | null | undefined) => (id ? text(aircraft.get(id)?.tailNumber) : '');
  const opportunity = (id: string | null | undefined) => (id ? text(opportunities.get(id)?.title) : '');
  const person = (id: string | null | undefined) => (id ? names.get(id) ?? '' : '');
  const currentOwner = (a: Aircraft) => (a.ownerships ?? []).find((o) => !o.endedAt)?.contactId ?? '';

  const files: { path: string; data: Uint8Array }[] = [];
  const add = (name: string, data: Uint8Array) => files.push({ path: `${EXPORT_FOLDER}/${name}`, data });

  // contacts.csv
  add('contacts.csv', csvFile(
    [
      'Contact ID', 'Display name', 'First name', 'Middle name', 'Last name', 'Suffix', 'Role', 'Name as received',
      'Company', 'Person or organization', 'Email', 'Phone', 'Address', 'Address 2', 'City', 'State', 'ZIP', 'Country',
      'Contact types', 'Status', 'Prospect status', 'Current aircraft IDs', 'Current aircraft',
      'Selling interest', 'Selling notes', 'Buying interest', 'Wanted aircraft', 'Budget', 'Mission', 'Timeline',
      'Insurance interest', 'Insurance notes', 'Notes', 'Needs review', 'Source', 'Other fields (JSON)',
      'Last contacted', 'Created', 'Last modified', 'Recorded by', 'Last changed by',
    ],
    records.contacts.map((c: Contact) => {
      const owned = records.aircraft.filter((a) => currentOwner(a) === c.id);
      const i = c.intent;
      const w = by('contacts', c.id);
      return [
        c.id, displayName(c), c.firstName, c.middleName, c.lastName, c.suffix, c.role, c.rawName,
        c.company, c.nameConfidence === 'organization' ? 'Organization' : 'Person', c.email, c.phone, c.address,
        c.address2, c.city, c.state, c.zip, c.country, list(c.contactTypes), c.status, c.prospectStatus,
        owned.map((a) => a.id).join('; '), owned.map((a) => a.tailNumber).join('; '),
        i?.selling, i?.sellingNotes, i?.buying, i?.wantedAircraft, i?.budget, i?.mission, i?.timeline,
        i?.insurance, i?.insuranceNotes, c.notes, yesNo(c.needsReview), c.source, json(c.custom),
        exportTime(c.lastContactedAt), exportTime(c.createdAt), exportTime(c.updatedAt), w.createdBy, w.changedBy,
      ];
    }),
  ));

  // aircraft.csv and its ownership history
  add('aircraft.csv', csvFile(
    [
      'Aircraft ID', 'Tail number', 'Year', 'Make', 'Model', 'Serial', 'Base airport', 'Status',
      'Current owner contact ID', 'Current owner', 'Asking price', 'Target price', 'Listing status', 'Listing URL',
      'Notes', 'Other fields (JSON)', 'Source', 'Created', 'Last modified', 'Recorded by', 'Last changed by',
    ],
    records.aircraft.map((a: Aircraft) => {
      const owner = currentOwner(a);
      const w = by('aircraft', a.id);
      return [
        a.id, a.tailNumber, a.year, a.make, a.model, a.serial, a.baseAirport, a.status, owner, contactName(owner),
        a.askingPrice, a.targetPrice, a.listingStatus, a.listingUrl, a.notes, json(a.custom), a.source,
        exportTime(a.createdAt), exportTime(a.updatedAt), w.createdBy, w.changedBy,
      ];
    }),
  ));
  add('aircraft-ownership.csv', csvFile(
    ['Aircraft ID', 'Tail number', 'Owner contact ID', 'Owner', 'Current owner', 'Owned from', 'Owned until'],
    records.aircraft.flatMap((a) => (a.ownerships ?? []).map((o) => [
      a.id, a.tailNumber, o.contactId, contactName(o.contactId), yesNo(!o.endedAt), exportTime(o.startedAt), exportTime(o.endedAt),
    ])),
  ));

  add('opportunities.csv', csvFile(
    [
      'Opportunity ID', 'Title', 'Type', 'Status', 'Contact ID', 'Contact', 'Company', 'Aircraft ID', 'Tail number',
      'Opened', 'Estimated value', 'Next action', 'Notes', 'Created', 'Last modified', 'Recorded by', 'Last changed by',
    ],
    records.opportunities.map((o: Opportunity) => {
      const w = by('opportunities', o.id);
      return [
        o.id, o.title, o.type, o.status, o.contactId, contactName(o.contactId), company(o.contactId), o.aircraftId,
        tail(o.aircraftId), exportTime(o.openedAt), o.estimatedValue, o.nextAction, o.notes,
        exportTime(o.createdAt), exportTime(o.updatedAt), w.createdBy, w.changedBy,
      ];
    }),
  ));

  add('insurance-policies.csv', csvFile(
    [
      'Policy ID', 'Aircraft ID', 'Tail number', 'Insured contact ID', 'Insured', 'Opportunity ID', 'Carrier',
      'Policy number', 'Broker/agent', 'Effective', 'Expiration', 'Renewal status', 'Premium', 'Hull value',
      'Liability limit', 'Deductible', 'Last quote', 'Quoted premium', 'Renewal notes', 'Notes', 'Created',
      'Last modified', 'Recorded by', 'Last changed by',
    ],
    records.policies.map((p: InsurancePolicy) => {
      const w = by('policies', p.id);
      return [
        p.id, p.aircraftId, tail(p.aircraftId), p.contactId, contactName(p.contactId), p.opportunityId, p.carrier,
        p.policyNumber, p.brokerAgent, exportTime(p.effectiveDate), exportTime(p.expirationDate), p.status, p.premium,
        p.hullValue, p.liabilityLimit, p.deductible, exportTime(p.lastQuoteDate), p.quotedPremium, p.renewalNotes,
        p.notes, exportTime(p.createdAt), exportTime(p.updatedAt), w.createdBy, w.changedBy,
      ];
    }),
  ));

  // The timeline: every call, email, meeting, note and status change.
  add('activities.csv', csvFile(
    [
      'Activity ID', 'Type', 'Date', 'Subject', 'Notes', 'Contact ID', 'Contact', 'Company', 'Aircraft ID',
      'Tail number', 'Opportunity ID', 'Opportunity', 'Recorded at', 'Recorded by', 'Recorded by user ID',
      'Last modified', 'Last changed by',
    ],
    records.activities.map((a: Activity) => {
      const w = by('activities', a.id);
      return [
        a.id, a.type, exportTime(a.date), a.subject, a.notes, a.contactId, contactName(a.contactId), company(a.contactId),
        a.aircraftId, tail(a.aircraftId), a.opportunityId, opportunity(a.opportunityId), exportTime(a.createdAt),
        w.createdBy, w.createdById, exportTime(a.updatedAt), w.changedBy,
      ];
    }),
  ));

  // notes.csv: every place a note is written, in one list, each tied to its records.
  const noteHeaders = [
    'Note ID', 'Kind', 'Content', 'Author', 'Author user ID', 'Created', 'Last modified', 'Last changed by',
    'Contact ID', 'Contact', 'Company', 'Aircraft ID', 'Tail number', 'Opportunity ID', 'Policy ID',
  ];
  const notes: unknown[][] = [];
  for (const a of records.activities) {
    if (a.type !== 'Note' || !text(a.notes || a.subject).trim()) continue;
    const w = by('activities', a.id);
    notes.push([
      a.id, 'Timeline note', [a.subject, a.notes].filter((s) => text(s).trim()).join('\n\n'), w.createdBy, w.createdById,
      exportTime(a.createdAt), exportTime(a.updatedAt ?? a.createdAt), w.changedBy, a.contactId, contactName(a.contactId),
      company(a.contactId), a.aircraftId, tail(a.aircraftId), a.opportunityId, '',
    ]);
  }
  for (const c of comments) {
    const owner = aircraft.get(c.aircraftId) ? currentOwner(aircraft.get(c.aircraftId)!) : '';
    notes.push([
      `comment-${c.id}`, 'Aircraft comment', c.body, c.authorName, c.authorId, exportTime(c.createdAt),
      exportTime(c.editedAt ?? c.createdAt), c.editedAt ? c.authorName : '', owner, contactName(owner), company(owner),
      c.aircraftId, tail(c.aircraftId), '', '',
    ]);
  }
  // A record's own Notes field: it has no author of its own, only whoever last changed the record.
  const fieldNote = (
    kind: string, content: unknown, record: { collection: string; id: string; createdAt: string; updatedAt: string },
    links: { contactId?: string | null; aircraftId?: string | null; opportunityId?: string | null; policyId?: string },
  ) => {
    if (!text(content).trim()) return;
    const w = by(record.collection, record.id);
    const id = `${kind.toLowerCase().replace(/ field$/, '').replace(/\s+/g, '-')}-${record.id}`;
    const created = record.createdAt;
    const modified = record.updatedAt;
    notes.push([
      id, kind, content, '', '', exportTime(created), exportTime(modified), w.changedBy, links.contactId ?? '',
      contactName(links.contactId), company(links.contactId), links.aircraftId ?? '', tail(links.aircraftId),
      links.opportunityId ?? '', links.policyId ?? '',
    ]);
  };
  for (const c of records.contacts) {
    fieldNote('Contact notes field', c.notes, { collection: 'contacts', ...c }, { contactId: c.id });
  }
  for (const a of records.aircraft) {
    fieldNote('Aircraft notes field', a.notes, { collection: 'aircraft', ...a }, { aircraftId: a.id, contactId: currentOwner(a) || null });
  }
  for (const o of records.opportunities) {
    fieldNote('Opportunity notes field', o.notes, { collection: 'opportunities', ...o },
      { opportunityId: o.id, contactId: o.contactId, aircraftId: o.aircraftId });
  }
  for (const p of records.policies) {
    const links = { policyId: p.id, contactId: p.contactId, aircraftId: p.aircraftId, opportunityId: p.opportunityId };
    fieldNote('Policy notes field', p.notes, { collection: 'policies', ...p }, links);
    fieldNote('Policy renewal notes field', p.renewalNotes, { collection: 'policies', ...p }, links);
  }
  add('notes.csv', csvFile(noteHeaders, notes));

  // Follow-ups and assigned tasks.
  add('tasks.csv', csvFile(
    [
      'Task ID', 'What to do', 'Note', 'Due date', 'Priority', 'Status', 'Assigned to user ID', 'Assigned to',
      'Assigned by user ID', 'Assigned by', 'Contact ID', 'Contact', 'Company', 'Aircraft ID', 'Tail number',
      'Opportunity ID', 'Opportunity', 'Policy ID', 'Outcome', 'Completed at', 'Created', 'Last modified',
      'Recorded by', 'Last changed by',
    ],
    records.followUps.map((f: FollowUp) => {
      const w = by('followUps', f.id);
      return [
        f.id, taskLabel(f.kind), f.note, exportTime(f.dueDate), f.priority ?? 'Normal', f.completed ? 'Completed' : 'Open',
        f.assigneeId ?? '', f.assigneeId ? person(f.assigneeId) : 'Unassigned', f.assignedBy ?? '', person(f.assignedBy),
        f.contactId, contactName(f.contactId), company(f.contactId), f.aircraftId, tail(f.aircraftId), f.opportunityId,
        opportunity(f.opportunityId), f.insurancePolicyId, f.outcome, exportTime(f.completedAt), exportTime(f.createdAt),
        exportTime(f.updatedAt), w.createdBy, w.changedBy,
      ];
    }),
  ));

  // Documents: the files themselves, each in a folder named by its id so two
  // files with the same name never collide, and the original name is kept.
  const documentRows = records.files.map((f: FileRecord) => {
    const content = documents.get(f.id);
    const path = content && 'data' in content ? `documents/${safeFilename(f.id)}/${safeFilename(f.name)}` : '';
    if (path && content && 'data' in content) add(path, content.data);
    const w = by('files', f.id);
    return [
      f.id, f.name, path, path ? '' : content && 'missing' in content ? content.missing : 'Not fetched', f.mimeType, f.size,
      f.category ?? 'Other', f.contactId, contactName(f.contactId), f.aircraftId, tail(f.aircraftId), f.opportunityId,
      f.insurancePolicyId, exportTime(f.createdAt), w.createdBy,
    ];
  });
  add('documents.csv', csvFile(
    [
      'Document ID', 'Original filename', 'File in this export', 'Why the file is not included', 'File type',
      'Size (bytes)', 'Category', 'Contact ID', 'Contact', 'Aircraft ID', 'Tail number', 'Opportunity ID', 'Policy ID',
      'Uploaded at', 'Uploaded by',
    ],
    documentRows,
  ));

  add('aircraft-comments.csv', csvFile(
    ['Comment ID', 'Aircraft ID', 'Tail number', 'Author user ID', 'Author', 'Comment', 'Posted at', 'Edited at'],
    comments.map((c) => [c.id, c.aircraftId, tail(c.aircraftId), c.authorId, c.authorName, c.body, exportTime(c.createdAt), exportTime(c.editedAt)]),
  ));

  add('users.csv', csvFile(
    ['User ID', 'Name', 'Email', 'Role', 'Access', 'Two-step sign-in', 'Created'],
    people.map((p) => [p.id, p.name, p.email, p.role === 'admin' ? 'Admin' : 'User',
      p.access === 'active' ? 'Active' : p.access === 'off' ? 'Access off' : 'Deleted', yesNo(p.twoStepSignIn), exportTime(p.createdAt)]),
  ));

  add('audit-log.csv', csvFile(
    ['Entry ID', 'When', 'User ID', 'User', 'Action', 'Record type', 'Record ID', 'Summary'],
    [...audit].sort((a, b) => a.id - b.id).map((e) => [e.id, exportTime(e.at), e.userId, e.userName, e.action, e.collection, e.recordId, e.summary]),
  ));

  add('email-templates.csv', csvFile(
    ['Template ID', 'Name', 'Subject', 'Body', 'Built in', 'Created', 'Last modified'],
    records.templates.map((t: EmailTemplate) => [t.id, t.name, t.subject, t.body, yesNo(t.builtIn), exportTime(t.createdAt), exportTime(t.updatedAt)]),
  ));

  add('imports.csv', csvFile(
    [
      'Import ID', 'File', 'Date', 'Rows processed', 'Contacts created', 'Contacts matched', 'Contacts updated',
      'Aircraft created', 'Aircraft updated', 'Duplicates skipped', 'Needing review', 'Missing email', 'Notes',
    ],
    records.imports.map((i: ImportRecord) => [
      i.id, i.filename, exportTime(i.date), i.recordsProcessed, i.contactsCreated, i.contactsMatched, i.contactsUpdated,
      i.aircraftCreated, i.aircraftUpdated, i.duplicatesSkipped, i.recordsNeedingReview, i.recordsMissingEmail,
      list(i.notes),
    ]),
  ));

  add('aerobook-backup.json', new TextEncoder().encode(input.backupJson));

  const included = records.files.filter((f) => documents.get(f.id) && 'data' in documents.get(f.id)!).length;
  add('README.txt', new TextEncoder().encode(readme(input, {
    contacts: records.contacts.length,
    aircraft: records.aircraft.length,
    opportunities: records.opportunities.length,
    policies: records.policies.length,
    activities: records.activities.length,
    notes: notes.length,
    tasks: records.followUps.length,
    documents: records.files.length,
    documentsIncluded: included,
    comments: comments.length,
    users: people.length,
    audit: audit.length,
  })));

  // README first: it is what someone opening the archive should read.
  return [files[files.length - 1], ...files.slice(0, -1)].map((f) => ({ ...f, modified: new Date(input.exportedAt) }));
}

function readme(input: CompanyExportInput, n: Record<string, number>): string {
  const missing = n.documents - n.documentsIncluded;
  return `AEROBOOK company data export
============================

Exported ${input.exportedAt} (UTC) by ${input.exportedBy.name}.

This folder is the company's complete AEROBOOK data, in plain files that
open without AEROBOOK: CSV for spreadsheets (Excel, Numbers, Google Sheets)
and JSON for software. Every CSV is UTF-8 with a header row.

What is here
------------
contacts.csv              ${n.contacts} contacts (customers): people and organizations, with their company,
                          contact details, status, what they are in the market for, and notes.
aircraft.csv              ${n.aircraft} aircraft, each with its current owner.
aircraft-ownership.csv    Every owner each aircraft has had, current and past.
opportunities.csv         ${n.opportunities} deals: sales, purchases and insurance.
insurance-policies.csv    ${n.policies} insurance policies.
activities.csv            ${n.activities} timeline entries: calls, emails, meetings, notes, quotes, status changes.
notes.csv                 ${n.notes} notes, gathered from everywhere a note is written: timeline notes, aircraft
                          comments, and the Notes fields of contacts, aircraft, opportunities and policies.
                          (Timeline notes are also in activities.csv; notes.csv puts every note in one list.)
tasks.csv                 ${n.tasks} follow-ups and assigned tasks, open and completed, with who they are
                          assigned to and who assigned them.
documents.csv             ${n.documents} uploaded documents: original filename, type, size, what each is attached to.
documents/                The documents themselves (${n.documentsIncluded} of ${n.documents}), one folder per document ID,
                          under their original filenames.${missing ? `\n                          ${missing} could not be included; documents.csv says why for each.` : ''}
aircraft-comments.csv     ${n.comments} team comments on aircraft.
users.csv                 ${n.users} people with an AEROBOOK account: name, email, role, access.
audit-log.csv             ${n.audit} audit entries: who created, changed or deleted which record and when, plus
                          sign-in security events and data exports.
email-templates.csv       The email templates.
imports.csv               The history of CSV imports.
aerobook-backup.json      Every record above in one JSON file, with every link between them. An AEROBOOK
                          admin can restore it under Settings -> Restore from a full export.

How the files fit together
--------------------------
Every record has an ID: contacts start "con_", aircraft "acf_", opportunities "opp_",
policies "pol_", activities "act_", tasks "fup_", documents "fil_". Wherever a
file refers to another record it gives that record's ID beside its name, so the files
can be joined in a spreadsheet or database:

  Contact ID      contacts.csv  <-  aircraft.csv (current owner), aircraft-ownership.csv,
                                    opportunities.csv, insurance-policies.csv, activities.csv,
                                    notes.csv, tasks.csv, documents.csv
  Aircraft ID     aircraft.csv  <-  the same files, and aircraft-comments.csv
  Opportunity ID  opportunities.csv  <-  insurance-policies.csv, activities.csv, notes.csv,
                                         tasks.csv, documents.csv
  Policy ID       insurance-policies.csv  <-  notes.csv, tasks.csv, documents.csv
  User ID         users.csv  <-  tasks.csv (assigned to / by), notes.csv (author),
                                 aircraft-comments.csv, audit-log.csv

"Recorded by" and "Last changed by" come from the audit log. Records created before
AEROBOOK kept one, or by a CSV import, may show these blank.

Dates and times
---------------
Times are UTC in ISO 8601: 2026-10-01T14:05:00.000Z. Calendar dates (due dates,
policy dates) are YYYY-MM-DD.

Worth knowing
-------------
- A cell that starts with = + - or @ and is not a number is written with a leading
  apostrophe, so a spreadsheet shows it rather than running it as a formula.
- "Other fields (JSON)" holds columns from imported spreadsheets that had no field of
  their own in AEROBOOK, as JSON.
- Not included: passwords, sign-in sessions, two-step sign-in secrets, and any server
  keys or settings. Deleted records, deleted comments and earlier versions of edited
  comments are not included. Team chat messages are not included.
`;
}
