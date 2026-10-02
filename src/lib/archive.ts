/**
 * The complete archive: everything the business keeps in AEROBOOK, in one
 * ZIP file that opens without AEROBOOK.
 *
 *   README.txt              what is in it, in plain words
 *   manifest.json           counts, a fingerprint of every collection's IDs,
 *                           every document's SHA-256, and any problems found
 *   aerobook-data.json      the full export: every record and every link,
 *                           re-importable under Settings → Restore
 *   aircraft-comments.json  the discussion on each aircraft
 *   csv/…                   the same, as spreadsheets
 *   documents/<id>/<name>   the files themselves
 *
 * verifyArchive reads one back and checks it against its own manifest, so a
 * copy can be trusted (or not) long after it was made. Pure: the caller says
 * how to read each document's bytes.
 */
import type { Database, FileRecord } from '../data/types';
import {
  activitiesCsv, aircraftCsv, commentsCsv, contactsCsv, documentsCsv, followUpsCsv, fullJson, opportunitiesCsv,
  policiesCsv, type ArchivedFiles, type ExportedComment,
} from './export';
import { readZip, writeZip, type ZipEntry } from './zip';

export const ARCHIVE_FORMAT = 1;

/** The shared collections, in the order the manifest lists them. */
export const ARCHIVED_COLLECTIONS = [
  'contacts', 'aircraft', 'opportunities', 'policies', 'activities', 'followUps', 'templates', 'imports', 'files',
] as const;
type Archived = (typeof ARCHIVED_COLLECTIONS)[number];

export interface CollectionSummary {
  count: number;
  /**
   * SHA-256 of the record IDs, sorted by code point and joined with commas —
   * the same as the ids_sha256 column of scripts/recovery-fingerprint.sql, so
   * an archive can be checked against the database it came from.
   */
  idsSha256: string;
}

export interface ArchivedDocument {
  id: string;
  name: string;
  size: number;
  blobPath: string | null;
  /** Where the file is in the archive; null when it could not be read. */
  path: string | null;
  sha256: string | null;
  status: 'ok' | 'missing' | 'size-mismatch';
}

export interface BrokenLink {
  collection: string;
  id: string;
  field: string;
  target: string;
}

export interface Manifest {
  app: 'AEROBOOK';
  format: number;
  exportedAt: string;
  exportedBy?: string;
  collections: Record<Archived | 'aircraftComments', CollectionSummary>;
  documents: ArchivedDocument[];
  links: { total: number; broken: BrokenLink[] };
  /** Everything that keeps this archive from being complete. Empty when it is. */
  problems: string[];
}

// ------------------------------------------------------------------ hashing

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Code-point order, which is what Postgres's "C" collation sorts by. */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export async function summarize(ids: string[]): Promise<CollectionSummary> {
  return { count: ids.length, idsSha256: await sha256Hex([...ids].sort(byCodePoint).join(',')) };
}

// -------------------------------------------------------------------- links

/** Every link one record makes to another, by field — the same list the SQL fingerprint checks. */
const LINKS: [Archived, string, Archived][] = [
  ['activities', 'contactId', 'contacts'], ['activities', 'aircraftId', 'aircraft'],
  ['activities', 'opportunityId', 'opportunities'],
  ['followUps', 'contactId', 'contacts'], ['followUps', 'aircraftId', 'aircraft'],
  ['followUps', 'opportunityId', 'opportunities'], ['followUps', 'insurancePolicyId', 'policies'],
  ['files', 'contactId', 'contacts'], ['files', 'aircraftId', 'aircraft'],
  ['files', 'opportunityId', 'opportunities'], ['files', 'insurancePolicyId', 'policies'],
  ['policies', 'contactId', 'contacts'], ['policies', 'aircraftId', 'aircraft'],
  ['policies', 'opportunityId', 'opportunities'],
  ['opportunities', 'contactId', 'contacts'], ['opportunities', 'aircraftId', 'aircraft'],
];

/** Links that point at a record that is not there: orphans, in either direction. */
export function checkLinks(db: Pick<Database, Archived>): { total: number; broken: BrokenLink[] } {
  const exists = new Map<string, Set<string>>(
    ARCHIVED_COLLECTIONS.map((c) => [c, new Set((db[c] as { id: string }[]).map((r) => r.id))]),
  );
  let total = 0;
  const broken: BrokenLink[] = [];
  const check = (collection: string, id: string, field: string, target: Archived, value: unknown) => {
    if (typeof value !== 'string' || !value) return;
    total += 1;
    if (!exists.get(target)!.has(value)) broken.push({ collection, id, field, target: value });
  };
  for (const [collection, field, target] of LINKS) {
    for (const r of db[collection] as unknown as Record<string, unknown>[]) check(collection, r.id as string, field, target, r[field]);
  }
  for (const a of db.aircraft) {
    for (const o of a.ownerships ?? []) check('aircraft', a.id, 'ownerships.contactId', 'contacts', o.contactId);
  }
  return { total, broken };
}

// -------------------------------------------------------------------- build

export interface ArchiveInput {
  db: Database;
  comments: ExportedComment[];
  /** Everyone on the team, for the names on follow-ups. */
  people?: { id: string; name: string }[];
  /** The document's bytes, or undefined when they cannot be had. */
  readFile: (file: FileRecord) => Promise<Uint8Array | undefined>;
  exportedBy?: string;
  now?: Date;
  onProgress?: (done: number, total: number) => void;
}

/** A name that is safe as a path inside a ZIP on any operating system. */
function safeName(name: string): string {
  const cleaned = name.replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, '_').replace(/^\.+/, '_').trim();
  return cleaned.slice(0, 150) || 'document';
}

export async function buildArchive(input: ArchiveInput): Promise<{ zip: Uint8Array; manifest: Manifest }> {
  const { db, comments } = input;
  const now = input.now ?? new Date();
  const encoder = new TextEncoder();
  const entries: ZipEntry[] = [];
  const documents: ArchivedDocument[] = [];
  const archived: ArchivedFiles = new Map();
  const problems: string[] = [];

  let done = 0;
  for (const f of db.files) {
    input.onProgress?.(done, db.files.length);
    let bytes: Uint8Array | undefined;
    try {
      bytes = await input.readFile(f);
    } catch {
      bytes = undefined;
    }
    if (!bytes) {
      documents.push({ id: f.id, name: f.name, size: f.size, blobPath: f.blobPath ?? null, path: null, sha256: null, status: 'missing' });
      archived.set(f.id, null);
      problems.push(`Document "${f.name}" (${f.id}) could not be read, so its file is not in this archive.`);
    } else {
      const path = `documents/${f.id}/${safeName(f.name)}`;
      const sha256 = await sha256Hex(bytes);
      const status = bytes.length === f.size ? 'ok' : 'size-mismatch';
      if (status !== 'ok') problems.push(`Document "${f.name}" (${f.id}) is ${bytes.length} bytes; its record says ${f.size}.`);
      entries.push({ name: path, data: bytes });
      documents.push({ id: f.id, name: f.name, size: f.size, blobPath: f.blobPath ?? null, path, sha256, status });
      archived.set(f.id, { path, sha256 });
    }
    done += 1;
  }
  input.onProgress?.(done, db.files.length);

  const links = checkLinks(db);
  if (links.broken.length) problems.push(`${links.broken.length} link(s) point at a record that is not there (see links.broken).`);

  const collections = {} as Manifest['collections'];
  for (const c of ARCHIVED_COLLECTIONS) collections[c] = await summarize((db[c] as { id: string }[]).map((r) => r.id));
  collections.aircraftComments = {
    count: comments.length,
    // Comment IDs are numbers: sorted as numbers, like the database sorts them.
    idsSha256: await sha256Hex([...comments].map((c) => c.id).sort((a, b) => a - b).join(',')),
  };

  const manifest: Manifest = {
    app: 'AEROBOOK',
    format: ARCHIVE_FORMAT,
    exportedAt: now.toISOString(),
    ...(input.exportedBy ? { exportedBy: input.exportedBy } : {}),
    collections,
    documents,
    links,
    problems,
  };

  const people = new Map((input.people ?? []).map((p) => [p.id, p.name]));
  const text = (name: string, value: string) => entries.unshift({ name, data: encoder.encode(value) });
  // unshift: the small files come first, before the documents.
  text('csv/aircraft-comments.csv', commentsCsv(db, comments));
  text('csv/documents.csv', documentsCsv(db, archived));
  text('csv/follow-ups.csv', followUpsCsv(db, people));
  text('csv/activities-and-notes.csv', activitiesCsv(db));
  text('csv/insurance.csv', policiesCsv(db));
  text('csv/opportunities.csv', opportunitiesCsv(db));
  text('csv/aircraft.csv', aircraftCsv(db));
  text('csv/contacts.csv', contactsCsv(db));
  text('aircraft-comments.json', JSON.stringify(comments, null, 2));
  text('aerobook-data.json', fullJson(db));
  text('manifest.json', JSON.stringify(manifest, null, 2));
  text('README.txt', readme(manifest));

  return { zip: writeZip(entries, now), manifest };
}

function readme(m: Manifest): string {
  const c = m.collections;
  const ok = m.documents.filter((d) => d.status === 'ok').length;
  return [
    'AEROBOOK complete archive',
    `Made ${m.exportedAt}${m.exportedBy ? ` by ${m.exportedBy}` : ''}.`,
    '',
    `Contacts: ${c.contacts.count}`,
    `Aircraft: ${c.aircraft.count}`,
    `Opportunities: ${c.opportunities.count}`,
    `Insurance policies: ${c.policies.count}`,
    `Activities and notes: ${c.activities.count}`,
    `Follow-ups: ${c.followUps.count}`,
    `Aircraft comments: ${c.aircraftComments.count}`,
    `Documents: ${m.documents.length} (${ok} files included)`,
    '',
    m.problems.length ? `NOT COMPLETE:\n${m.problems.map((p) => `- ${p}`).join('\n')}` : 'Complete: every document file is included and every link resolves.',
    '',
    'aerobook-data.json is the full export, and can be restored into AEROBOOK under Settings.',
    'csv/ holds the same records as spreadsheets; each row ends with its ID and the IDs it links to.',
    'documents/<document id>/ holds each file, under its own name. csv/documents.csv says which record each belongs to.',
    'manifest.json lists every file with its SHA-256, so the copy can be checked: npm run verify:archive -- <this file>.',
    '',
    'This file holds customer information. Keep it only where the Customer Information Storage Policy allows.',
    '',
  ].join('\n');
}

// ------------------------------------------------------------------- verify

export interface ArchiveReport {
  ok: boolean;
  exportedAt?: string;
  counts: Record<string, number>;
  documents: { expected: number; present: number; missing: string[]; corrupted: string[] };
  links: { total: number; broken: number };
  problems: string[];
}

/** Reads an archive back and checks every part of it against its own manifest. */
export async function verifyArchive(bytes: Uint8Array): Promise<ArchiveReport> {
  const problems: string[] = [];
  const entries = readZip(bytes);
  const byName = new Map(entries.map((e) => [e.name, e]));
  for (const e of entries) if (!e.crcOk) problems.push(`${e.name} is damaged (its checksum does not match).`);
  const json = <T>(name: string): T => {
    const e = byName.get(name);
    if (!e) throw new Error(`${name} is missing from the archive`);
    return JSON.parse(new TextDecoder().decode(e.data)) as T;
  };
  const manifest = json<Manifest>('manifest.json');
  const db = json<Database>('aerobook-data.json');
  const comments = json<ExportedComment[]>('aircraft-comments.json');

  const counts: Record<string, number> = {};
  for (const c of ARCHIVED_COLLECTIONS) {
    const records = (db[c] ?? []) as { id: string }[];
    const summary = await summarize(records.map((r) => r.id));
    counts[c] = summary.count;
    const expected = manifest.collections[c];
    if (!expected || expected.count !== summary.count || expected.idsSha256 !== summary.idsSha256) {
      problems.push(`${c}: the data holds ${summary.count} records; the manifest says ${expected?.count ?? 'none'}, or different ones.`);
    }
  }
  counts.aircraftComments = comments.length;
  if (manifest.collections.aircraftComments?.count !== comments.length) problems.push('Aircraft comments do not match the manifest.');

  const missing: string[] = [];
  const corrupted: string[] = [];
  const listed = new Map(manifest.documents.map((d) => [d.id, d]));
  for (const f of db.files ?? []) {
    const d = listed.get(f.id);
    const entry = d?.path ? byName.get(d.path) : undefined;
    if (!d || !entry) {
      missing.push(f.id);
      continue;
    }
    if (!entry.crcOk || entry.data.length !== f.size || (await sha256Hex(entry.data)) !== d.sha256) corrupted.push(f.id);
  }
  if (missing.length) problems.push(`${missing.length} document file(s) are not in the archive.`);
  if (corrupted.length) problems.push(`${corrupted.length} document file(s) do not match their record or their SHA-256.`);

  const links = checkLinks(db);
  if (links.broken.length) problems.push(`${links.broken.length} link(s) point at a record that is not there.`);

  return {
    ok: problems.length === 0,
    exportedAt: manifest.exportedAt,
    counts,
    documents: { expected: (db.files ?? []).length, present: (db.files ?? []).length - missing.length, missing, corrupted },
    links: { total: links.total, broken: links.broken.length },
    problems,
  };
}
