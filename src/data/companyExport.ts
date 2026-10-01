/**
 * Puts the company data export together in an admin's browser and hands it
 * over as one ZIP file. See lib/companyExport.ts for what is in it.
 *
 * Everything is fetched fresh from the server rather than taken from this
 * device's copy: the records through the same sync every device uses, the
 * documents through the same signed-in file route, and the people, comments
 * and audit log from the admin-only export routes. Doing it here, rather
 * than in one server response, means no response has to carry every
 * document at once.
 */
import { applyRecords, type RemoteRecord } from './sync';
import * as persistence from './db';
import * as store from './store';
import { emptyDatabase, type Database } from './types';
import {
  buildCompanyExport, type DocumentContent, type ExportAuditEntry, type ExportComment, type ExportPerson,
} from '../lib/companyExport';
import { exportFilename, fullJson } from '../lib/export';
import { zip } from '../lib/zip';

export type ExportStep = 'starting' | 'records' | 'audit' | 'documents' | 'packing';

export interface CompanyExportResult {
  blob: Blob;
  filename: string;
  documents: number;
  documentsMissing: number;
}

type Fetch = typeof fetch;

async function call<T>(http: Fetch, path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await http(path, { credentials: 'same-origin', ...init });
  } catch {
    throw new Error('Could not reach AEROBOOK. Check the connection and try again.');
  }
  if (response.status === 401) throw new Error('Your session has ended. Sign in again, then export.');
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `The server said ${response.status}.`);
  }
  return (await response.json()) as T;
}

/** Every record, as the server holds it now. */
async function allRecords(http: Fetch): Promise<Database> {
  const records: RemoteRecord[] = [];
  let cursor = 0;
  let more = true;
  while (more) {
    const page = await call<{ records: RemoteRecord[]; cursor: number; more: boolean }>(http, `/api/sync?since=${cursor}&full=1`);
    records.push(...page.records);
    cursor = page.cursor;
    more = page.more;
  }
  return applyRecords(emptyDatabase(), records);
}

async function allAudit(http: Fetch): Promise<ExportAuditEntry[]> {
  const entries: ExportAuditEntry[] = [];
  let after = 0;
  for (;;) {
    const page = await call<{ entries: ExportAuditEntry[]; more: boolean }>(http, `/api/export/audit?after=${after}`);
    entries.push(...page.entries);
    if (!page.more || page.entries.length === 0) return entries;
    after = page.entries[page.entries.length - 1].id;
  }
}

async function documentContent(http: Fetch, file: Database['files'][number]): Promise<DocumentContent> {
  try {
    if (file.blobPath) {
      const response = await http(`/api/files/content?path=${encodeURIComponent(file.blobPath)}`, { credentials: 'same-origin' });
      if (response.status === 404) return { missing: 'The file is no longer in AEROBOOK’s document storage.' };
      if (!response.ok) return { missing: `Could not be downloaded (the server said ${response.status}).` };
      return { data: new Uint8Array(await response.arrayBuffer()) };
    }
    // Attached before cloud storage and never moved up: only that browser has it.
    const local = await persistence.getFileBlob(file.id).catch(() => undefined);
    if (local) return { data: new Uint8Array(await local.arrayBuffer()) };
    return { missing: 'Stored only in the browser it was attached from, never uploaded to AEROBOOK’s cloud storage.' };
  } catch {
    return { missing: 'Could not be downloaded: the connection failed.' };
  }
}

export async function exportCompanyData(
  onStep: (step: ExportStep, detail?: string) => void = () => undefined,
  http: Fetch = fetch,
): Promise<CompanyExportResult> {
  // Anything still on its way from this device goes up first, so it is in.
  await store.flush().catch(() => undefined);

  onStep('starting');
  const start = await call<{
    exportedAt: string;
    exportedBy: { id: string; name: string };
    people: ExportPerson[];
    comments: ExportComment[];
  }>(http, '/api/export/company', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });

  onStep('records');
  const records = await allRecords(http);
  onStep('audit');
  const audit = await allAudit(http);

  const documents = new Map<string, DocumentContent>();
  let done = 0;
  for (const file of records.files) {
    onStep('documents', `${++done} of ${records.files.length}`);
    documents.set(file.id, await documentContent(http, file));
  }

  onStep('packing');
  const entries = buildCompanyExport({
    records,
    // Restorable as it is; it carries this admin's own settings, as "Export everything" always has.
    backupJson: fullJson(records),
    people: start.people,
    comments: start.comments,
    audit,
    documents,
    exportedAt: start.exportedAt,
    exportedBy: start.exportedBy,
  });
  const missing = [...documents.values()].filter((d) => 'missing' in d).length;
  return {
    blob: new Blob(zip(entries) as BlobPart[], { type: 'application/zip' }),
    filename: exportFilename('company-export', 'zip'),
    documents: records.files.length,
    documentsMissing: missing,
  };
}

export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
