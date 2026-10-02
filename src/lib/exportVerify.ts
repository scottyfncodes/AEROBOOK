/**
 * Checks a company data export (Settings → Data export) on its own, without
 * AEROBOOK, an account or a network: that the ZIP is whole, every file the
 * export always has is there, every file matches the SHA-256 in its manifest
 * and nothing is there that the manifest does not list, the records agree
 * between the JSON backup and the spreadsheets, every link between records
 * resolves, and every document's file is present, where it should be, with
 * the size its record says.
 *
 * Optionally also against what the source database held (`expected`): record
 * counts, and each document's id and size, read from production beforehand —
 * so the export is checked against production, not only against itself.
 *
 * Pure. Reports IDs, sizes, counts and digests; never record contents, names
 * or emails, so its output is safe to keep in a recovery record.
 */
import { EXPORT_FOLDER, safeFilename } from './companyExport';
import { parseCsv } from './csv';
import { MANIFEST_FORMAT, MANIFEST_NAME, sha256Hex, type ExportManifest } from './exportManifest';
import { crc32 } from './zip';

/** Every file a company export always has, documents aside. */
export const REQUIRED_FILES = [
  'README.txt', 'contacts.csv', 'aircraft.csv', 'aircraft-ownership.csv', 'opportunities.csv',
  'insurance-policies.csv', 'activities.csv', 'notes.csv', 'tasks.csv', 'documents.csv', 'aircraft-comments.csv',
  'users.csv', 'audit-log.csv', 'email-templates.csv', 'imports.csv', 'aerobook-backup.json',
] as const;

/** Each collection in the JSON backup, the spreadsheet that lists it, and that spreadsheet's ID column. */
const COLLECTIONS = [
  ['contacts', 'contacts.csv', 'Contact ID'],
  ['aircraft', 'aircraft.csv', 'Aircraft ID'],
  ['opportunities', 'opportunities.csv', 'Opportunity ID'],
  ['policies', 'insurance-policies.csv', 'Policy ID'],
  ['activities', 'activities.csv', 'Activity ID'],
  ['followUps', 'tasks.csv', 'Task ID'],
  ['files', 'documents.csv', 'Document ID'],
  ['templates', 'email-templates.csv', 'Template ID'],
  ['imports', 'imports.csv', 'Import ID'],
] as const;

/** Every link one record makes to another — the same list scripts/dr/verify.sql checks. */
const LINKS: [string, string, string][] = [
  ['activities', 'contactId', 'contacts'], ['activities', 'aircraftId', 'aircraft'],
  ['activities', 'opportunityId', 'opportunities'],
  ['followUps', 'contactId', 'contacts'], ['followUps', 'aircraftId', 'aircraft'],
  ['followUps', 'opportunityId', 'opportunities'], ['followUps', 'insurancePolicyId', 'policies'],
  ['opportunities', 'contactId', 'contacts'], ['opportunities', 'aircraftId', 'aircraft'],
  ['policies', 'contactId', 'contacts'], ['policies', 'aircraftId', 'aircraft'], ['policies', 'opportunityId', 'opportunities'],
  ['files', 'contactId', 'contacts'], ['files', 'aircraftId', 'aircraft'],
  ['files', 'opportunityId', 'opportunities'], ['files', 'insurancePolicyId', 'policies'],
];

export interface Expected {
  /** Live record counts per collection (contacts, aircraft, …), and optionally users and auditEntries (minimums). */
  counts?: Record<string, number>;
  /** Every document the source held, by id and size in bytes. */
  documents?: { id: string; size: number }[];
}

export interface VerifyOptions {
  expected?: Expected;
  /** Accept an export made before manifests existed: SHA-256s are computed and shown, but cannot be compared. */
  allowNoManifest?: boolean;
}

export interface DocumentCheck {
  id: string;
  path: string;
  bytes: number | null;
  sha256: string | null;
  status: 'ok' | string;
}

export interface ExportReport {
  ok: boolean;
  members: number;
  manifest: 'verified' | 'absent' | 'invalid';
  counts: Record<string, number>;
  links: { checked: number; broken: number };
  documents: DocumentCheck[];
  problems: string[];
}

interface Member {
  data: Uint8Array;
  crcOk: boolean;
}

/** Reads the ZIP's directory without trusting it: damage, duplicates and compression are all reported, not thrown. */
function readMembers(bytes: Uint8Array, problems: string[]): Map<string, Member> {
  const members = new Map<string, Member>();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) {
    problems.push('Not a ZIP file: it has no end-of-archive record (cut short, or not an export at all).');
    return members;
  }
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const decoder = new TextDecoder();
  for (let i = 0; i < count; i++) {
    if (at + 46 > bytes.length || view.getUint32(at, true) !== 0x02014b50) {
      problems.push('The ZIP directory is damaged.');
      break;
    }
    const method = view.getUint16(at + 10, true);
    const crc = view.getUint32(at + 16, true);
    const size = view.getUint32(at + 20, true);
    const nameLength = view.getUint16(at + 28, true);
    const next = at + 46 + nameLength + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    at = next;
    if (local + 30 > bytes.length || view.getUint32(local, true) !== 0x04034b50) {
      problems.push(`${name}: its data is missing from the ZIP.`);
      continue;
    }
    if (method !== 0) {
      problems.push(`${name}: compressed (method ${method}); an export stores files as they are.`);
      continue;
    }
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const data = bytes.subarray(start, start + size);
    if (data.length !== size) problems.push(`${name}: cut short.`);
    const crcOk = data.length === size && crc32(data) === crc;
    if (!crcOk) problems.push(`${name}: damaged (its ZIP CRC-32 does not match its bytes).`);
    if (members.has(name)) problems.push(`${name}: appears more than once in the ZIP.`);
    members.set(name, { data, crcOk });
  }
  return members;
}

function rowsOf(text: string): Record<string, string>[] {
  const { headers, rows } = parseCsv(text, ',');
  return rows.map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ''])));
}

export async function verifyCompanyExport(bytes: Uint8Array, options: VerifyOptions = {}): Promise<ExportReport> {
  const problems: string[] = [];
  const members = readMembers(bytes, problems);
  const prefix = `${EXPORT_FOLDER}/`;
  const files = new Map<string, Member>();
  for (const [name, m] of members) {
    if (name.startsWith(prefix)) files.set(name.slice(prefix.length), m);
    else problems.push(`${name}: outside the ${EXPORT_FOLDER} folder.`);
  }
  for (const name of REQUIRED_FILES) if (!files.has(name)) problems.push(`${name} is missing.`);
  const text = (name: string) => new TextDecoder().decode(files.get(name)?.data ?? new Uint8Array());

  // ---- the manifest: every file's SHA-256, and nothing unlisted
  let manifestState: ExportReport['manifest'] = 'absent';
  const digests = new Map<string, string>();
  if (files.has(MANIFEST_NAME)) {
    manifestState = 'verified';
    let manifest: ExportManifest | null = null;
    try {
      manifest = JSON.parse(text(MANIFEST_NAME)) as ExportManifest;
    } catch {
      problems.push(`${MANIFEST_NAME} is not valid JSON.`);
    }
    if (manifest && (manifest.format !== MANIFEST_FORMAT || manifest.algorithm !== 'SHA-256' || !Array.isArray(manifest.files))) {
      problems.push(`${MANIFEST_NAME} is not an AEROBOOK export manifest.`);
      manifest = null;
    }
    if (!manifest) manifestState = 'invalid';
    const listed = new Set<string>();
    for (const f of manifest?.files ?? []) {
      if (listed.has(f.path)) problems.push(`${MANIFEST_NAME} lists ${f.path} twice.`);
      listed.add(f.path);
      const m = files.get(f.path);
      if (!m) {
        problems.push(`${f.path} is listed in ${MANIFEST_NAME} but missing from the export.`);
        manifestState = 'invalid';
        continue;
      }
      const actual = await sha256Hex(m.data);
      digests.set(f.path, actual);
      if (m.data.length !== f.bytes) problems.push(`${f.path}: ${m.data.length} bytes; ${MANIFEST_NAME} says ${f.bytes}.`);
      if (actual !== f.sha256) {
        problems.push(`${f.path}: SHA-256 does not match ${MANIFEST_NAME} (the file was changed).`);
        manifestState = 'invalid';
      }
    }
    if (manifest) {
      for (const name of files.keys()) {
        if (name !== MANIFEST_NAME && !listed.has(name)) {
          problems.push(`${name} is in the export but not in ${MANIFEST_NAME} (added after export).`);
          manifestState = 'invalid';
        }
      }
    }
  } else if (!options.allowNoManifest) {
    problems.push(`${MANIFEST_NAME} is missing, so the files cannot be checked against their SHA-256.`);
  }

  // ---- records: the JSON backup and the spreadsheets agree
  let backup: Record<string, Record<string, unknown>[]> = {};
  try {
    backup = JSON.parse(text('aerobook-backup.json') || '{}');
  } catch {
    problems.push('aerobook-backup.json is not valid JSON.');
  }
  const counts: Record<string, number> = {};
  const ids = new Map<string, Set<string>>();
  for (const [collection, csvName, idColumn] of COLLECTIONS) {
    const fromJson = (Array.isArray(backup[collection]) ? backup[collection] : []).map((r) => String(r.id));
    const fromCsv = files.has(csvName) ? rowsOf(text(csvName)).map((r) => r[idColumn]) : [];
    counts[collection] = fromJson.length;
    ids.set(collection, new Set(fromJson));
    const a = [...fromJson].sort().join('\n');
    const b = [...fromCsv].sort().join('\n');
    if (a !== b) problems.push(`${collection}: aerobook-backup.json has ${fromJson.length}, ${csvName} has ${fromCsv.length}, or different IDs.`);
  }
  const csvCount = (name: string) => (files.has(name) ? rowsOf(text(name)).length : 0);
  counts.aircraftComments = csvCount('aircraft-comments.csv');
  counts.users = csvCount('users.csv');
  counts.auditEntries = csvCount('audit-log.csv');
  counts.notes = csvCount('notes.csv');
  counts.ownerships = csvCount('aircraft-ownership.csv');

  // ---- links
  let checked = 0;
  let broken = 0;
  const link = (what: string, target: string, value: unknown) => {
    if (typeof value !== 'string' || !value) return;
    checked += 1;
    if (!ids.get(target)?.has(value)) {
      broken += 1;
      problems.push(`${what} points at ${target} ${value}, which is not in the export.`);
    }
  };
  for (const [collection, field, target] of LINKS) {
    for (const r of backup[collection] ?? []) link(`${collection} ${String(r.id)}.${field}`, target, r[field]);
  }
  for (const a of backup.aircraft ?? []) {
    for (const o of (a.ownerships as { contactId?: string }[] | undefined) ?? []) {
      link(`aircraft ${String(a.id)} owner`, 'contacts', o.contactId);
    }
  }
  if (files.has('aircraft-comments.csv')) {
    for (const c of rowsOf(text('aircraft-comments.csv'))) link(`comment ${c['Comment ID']}`, 'aircraft', c['Aircraft ID']);
  }

  // ---- documents: the files themselves
  const documentRows = new Map((files.has('documents.csv') ? rowsOf(text('documents.csv')) : []).map((r) => [r['Document ID'], r]));
  const referenced = new Set<string>();
  const documents: DocumentCheck[] = [];
  for (const f of backup.files ?? []) {
    const id = String(f.id);
    const name = String(f.name ?? '');
    const size = Number(f.size);
    const row = documentRows.get(id);
    const path = row?.['File in this export'] ?? '';
    const member = path ? files.get(path) : undefined;
    const check: DocumentCheck = { id, path, bytes: member?.data.length ?? null, sha256: null, status: 'ok' };
    if (path) referenced.add(path);
    if (!row) check.status = 'no row in documents.csv';
    else if (!path) check.status = `not in the export: ${row['Why the file is not included'] || 'no reason given'}`;
    else if (path !== `documents/${safeFilename(id)}/${safeFilename(name)}`) check.status = 'its path does not match its ID and filename';
    else if (!member) check.status = 'listed in documents.csv but missing from the ZIP';
    else {
      check.sha256 = digests.get(path) ?? (await sha256Hex(member.data));
      if (!member.crcOk) check.status = 'damaged (CRC-32)';
      else if (member.data.length !== size) check.status = `${member.data.length} bytes; its record says ${size}`;
      else if (Number(row['Size (bytes)']) !== size) check.status = `documents.csv says ${row['Size (bytes)']} bytes; its record says ${size}`;
    }
    if (check.status !== 'ok') problems.push(`Document ${id}: ${check.status}.`);
    documents.push(check);
  }
  for (const id of documentRows.keys()) {
    if (!ids.get('files')?.has(id)) problems.push(`documents.csv lists ${id}, which aerobook-backup.json does not have.`);
  }
  for (const name of files.keys()) {
    if (name.startsWith('documents/') && !referenced.has(name)) problems.push(`${name} is not the file of any document record.`);
  }

  // ---- against the source
  const expected = options.expected;
  for (const [key, want] of Object.entries(expected?.counts ?? {})) {
    const got = counts[key];
    // Users and audit entries only grow (an export adds an audit entry), so those are minimums.
    const minimum = key === 'users' || key === 'auditEntries';
    if (got === undefined || (minimum ? got < want : got !== want)) {
      problems.push(`${key}: the export has ${got ?? 'none'}; the source had ${minimum ? 'at least ' : ''}${want}.`);
    }
  }
  if (expected?.documents) {
    const got = new Map(documents.map((d) => [d.id, d]));
    for (const e of expected.documents) {
      const d = got.get(e.id);
      if (!d) problems.push(`Source document ${e.id} is not in the export.`);
      else if (d.bytes !== e.size) problems.push(`Source document ${e.id}: ${d.bytes ?? 'no'} bytes in the export; the source had ${e.size}.`);
    }
    const known = new Set(expected.documents.map((e) => e.id));
    for (const d of documents) if (!known.has(d.id)) problems.push(`Document ${d.id} is not one the source had.`);
  }

  return {
    ok: problems.length === 0,
    members: members.size,
    manifest: manifestState,
    counts,
    links: { checked, broken },
    documents,
    problems,
  };
}
