/**
 * The export's SHA-256 manifest and the verifier: a real export passes, and
 * every kind of damage, loss, addition or disagreement is caught and named.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { buildCompanyExport, EXPORT_FOLDER, type CompanyExportInput, type DocumentContent } from './companyExport';
import { buildManifest, MANIFEST_NAME, sha256Hex, withManifest, type ExportManifest } from './exportManifest';
import { verifyCompanyExport } from './exportVerify';
import { fullJson } from './export';
import { zip, type ZipEntry } from './zip';
import { emptyDatabase, type Database } from '../data/types';

const T = '2026-09-01T09:00:00.000Z';
const P = `${EXPORT_FOLDER}/`;

const contact = (id: string) => ({
  id, firstName: id, lastName: '', rawName: id, company: '', email: '', phone: '', address: '', city: '', state: '',
  zip: '', contactTypes: [], status: 'Prospect' as const, prospectStatus: 'New' as const, notes: '', custom: {},
  nameConfidence: 'high' as const, needsReview: false, createdAt: T, updatedAt: T,
});

const PDF = new TextEncoder().encode('%PDF-1.4 binder bytes, unique-marker-0123456789');
const PHOTO = Uint8Array.from({ length: 300 }, (_, i) => (i * 7) % 256);

function records(): Database {
  const db = emptyDatabase();
  db.contacts = [contact('con_a'), contact('con_b')];
  db.aircraft = [{
    id: 'air_1', tailNumber: 'N1AB', tailKey: '1AB', year: '2020', make: 'Cirrus', model: 'SR22', status: 'Owned',
    ownerships: [{ contactId: 'con_a' }, { contactId: 'con_b', endedAt: '2019-01-01' }], notes: '', custom: {}, createdAt: T, updatedAt: T,
  }];
  db.activities = [{ id: 'act_1', contactId: 'con_a', aircraftId: 'air_1', opportunityId: null, type: 'Note', date: T, subject: 'Hi', notes: 'x', createdAt: T }];
  db.followUps = [{ id: 'fup_1', contactId: 'con_b', aircraftId: null, opportunityId: null, dueDate: '2026-09-09', note: 'Call', completed: false, createdAt: T, updatedAt: T }];
  db.files = [
    { id: 'fil_aaaa1', name: 'Binder: "2026".pdf', mimeType: 'application/pdf', size: PDF.length, contactId: 'con_a', aircraftId: 'air_1', opportunityId: null, blobPath: 'files/fil_aaaa1/x.pdf', createdAt: T },
    { id: 'fil_bbbb2', name: 'Photo.jpg', mimeType: 'image/jpeg', size: PHOTO.length, contactId: null, aircraftId: 'air_1', opportunityId: null, blobPath: 'files/fil_bbbb2/Photo.jpg', createdAt: T },
  ];
  return db;
}

async function entriesFor(db = records(), documents?: Map<string, DocumentContent>): Promise<ZipEntry[]> {
  const input: CompanyExportInput = {
    records: db,
    backupJson: fullJson(db),
    people: [{ id: 'usr_a', name: 'Scott', email: 's@example.com', role: 'admin', access: 'active', twoStepSignIn: true, createdAt: T }],
    comments: [{ id: 1, aircraftId: 'air_1', authorId: 'usr_a', authorName: 'Scott', body: 'Annual due', createdAt: T, editedAt: null }],
    audit: [{ id: 1, at: T, userId: 'usr_a', userName: 'Scott', action: 'create', collection: 'contacts', recordId: 'con_a', summary: '' }],
    documents: documents ?? new Map([['fil_aaaa1', { data: PDF }], ['fil_bbbb2', { data: PHOTO }]]),
    exportedAt: T,
    exportedBy: { id: 'usr_a', name: 'Scott' },
  };
  return withManifest(buildCompanyExport(input), T);
}

const pack = (entries: ZipEntry[]) => {
  const chunks = zip(entries, new Date(T));
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
};
const exportBytes = async () => pack(await entriesFor());
const without = (entries: ZipEntry[], path: string) => entries.filter((e) => e.path !== P + path);
const replaced = (entries: ZipEntry[], path: string, data: Uint8Array) => entries.map((e) => (e.path === P + path ? { ...e, data } : e));
const docPath = 'documents/fil_aaaa1/Binder_ _2026_.pdf';

describe('the export manifest', () => {
  it('lists the SHA-256 and size of every file in the package, in a fixed order', async () => {
    const entries = await entriesFor();
    expect(entries[0].path).toBe(`${P}README.txt`);
    expect(entries[1].path).toBe(P + MANIFEST_NAME);
    const manifest = JSON.parse(new TextDecoder().decode(entries[1].data)) as ExportManifest;
    expect(manifest).toMatchObject({ format: 'aerobook-company-export-manifest', version: 1, algorithm: 'SHA-256', exportedAt: T });
    const others = entries.filter((e) => e.path !== P + MANIFEST_NAME);
    expect(manifest.files.map((f) => f.path)).toEqual(others.map((e) => e.path.slice(P.length)).sort());
    const doc = manifest.files.find((f) => f.path === docPath)!;
    expect(doc).toEqual({ path: docPath, bytes: PDF.length, sha256: await sha256Hex(PDF) });
    // The same files give the same manifest, byte for byte, in whatever order they come.
    const again = await buildManifest([...others].reverse(), T);
    expect(new TextDecoder().decode(entries[1].data)).toBe(`${JSON.stringify(again, null, 2)}\n`);
  });

  it('holds paths, sizes and digests only', async () => {
    const manifest = await buildManifest(buildCompanyExport({
      records: records(), backupJson: '{}', people: [], comments: [], audit: [], documents: new Map(), exportedAt: T,
      exportedBy: { id: 'u', name: 'S' },
    }), T);
    for (const f of manifest.files) expect(Object.keys(f)).toEqual(['path', 'bytes', 'sha256']);
  });

  it('refuses a file outside the export folder, and a second manifest', async () => {
    await expect(buildManifest([{ path: 'elsewhere.txt', data: new Uint8Array() }], T)).rejects.toThrow(/outside/);
    await expect(withManifest(await entriesFor(), T)).rejects.toThrow(/already/);
  });
});

describe('verifying an export', () => {
  it('passes a complete, untouched export, document by document', async () => {
    const report = await verifyCompanyExport(await exportBytes(), {
      expected: { counts: { contacts: 2, aircraft: 1, files: 2, users: 1 }, documents: [{ id: 'fil_aaaa1', size: PDF.length }, { id: 'fil_bbbb2', size: PHOTO.length }] },
    });
    expect(report.problems).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.manifest).toBe('verified');
    expect(report.counts).toMatchObject({ contacts: 2, aircraft: 1, activities: 1, followUps: 1, files: 2, aircraftComments: 1, users: 1, auditEntries: 1 });
    expect(report.links).toEqual({ checked: 9, broken: 0 }); // 8 between records, 1 comment → aircraft
    expect(report.documents).toEqual([
      { id: 'fil_aaaa1', path: docPath, bytes: PDF.length, sha256: await sha256Hex(PDF), status: 'ok' },
      { id: 'fil_bbbb2', path: 'documents/fil_bbbb2/Photo.jpg', bytes: PHOTO.length, sha256: await sha256Hex(PHOTO), status: 'ok' },
    ]);
  });

  it('catches one changed byte in a document', async () => {
    const bytes = await exportBytes();
    const text = Array.from(bytes, (b) => String.fromCharCode(b)).join('');
    bytes[text.indexOf('unique-marker') + 3] ^= 0x01;
    const report = await verifyCompanyExport(bytes);
    expect(report.ok).toBe(false);
    expect(report.problems.join('\n')).toMatch(/CRC-32/);
    expect(report.problems.join('\n')).toMatch(/SHA-256 does not match/);
    expect(report.documents[0].status).toBe('damaged (CRC-32)');
  });

  it('catches a document changed and re-zipped, so only the manifest knows', async () => {
    const changed = PDF.slice();
    changed[0] = 0x25 ^ 0x01;
    const report = await verifyCompanyExport(pack(replaced(await entriesFor(), docPath, changed)));
    expect(report.ok).toBe(false);
    expect(report.manifest).toBe('invalid');
    expect(report.problems).toContain(`${docPath}: SHA-256 does not match manifest.json (the file was changed).`);
  });

  it('catches a document missing from the ZIP', async () => {
    const report = await verifyCompanyExport(pack(without(await entriesFor(), docPath)));
    expect(report.ok).toBe(false);
    expect(report.problems).toContain(`${docPath} is listed in manifest.json but missing from the export.`);
    expect(report.problems).toContain('Document fil_aaaa1: listed in documents.csv but missing from the ZIP.');
  });

  it('catches a file added after export', async () => {
    const entries = await entriesFor();
    entries.push({ path: `${P}documents/fil_zzzz9/extra.pdf`, data: new Uint8Array([1]) });
    const report = await verifyCompanyExport(pack(entries));
    expect(report.ok).toBe(false);
    expect(report.problems).toContain('documents/fil_zzzz9/extra.pdf is in the export but not in manifest.json (added after export).');
    expect(report.problems).toContain('documents/fil_zzzz9/extra.pdf is not the file of any document record.');
  });

  it('catches a file that appears twice', async () => {
    const entries = await entriesFor();
    // zip() refuses duplicates, so name a copy one letter differently and correct it in the bytes.
    const twin = `${P}${docPath}`.replace('Binder', 'Bindex');
    entries.push({ path: twin, data: PDF });
    const bytes = pack(entries);
    const from = new TextEncoder().encode(twin);
    const to = new TextEncoder().encode(`${P}${docPath}`);
    for (let i = 0; i + from.length <= bytes.length; i++) {
      if (from.every((b, j) => bytes[i + j] === b)) bytes.set(to, i);
    }
    const report = await verifyCompanyExport(bytes);
    expect(report.ok).toBe(false);
    expect(report.problems).toContain(`${P}${docPath}: appears more than once in the ZIP.`);
  });

  it('catches a missing required file, and a missing or edited manifest', async () => {
    const entries = await entriesFor();
    expect((await verifyCompanyExport(pack(without(entries, 'tasks.csv')))).problems).toContain('tasks.csv is missing.');

    const noManifest = pack(without(entries, MANIFEST_NAME));
    const strict = await verifyCompanyExport(noManifest);
    expect(strict.ok).toBe(false);
    expect(strict.manifest).toBe('absent');
    // An export made before manifests existed can still be checked for everything else.
    const lenient = await verifyCompanyExport(noManifest, { allowNoManifest: true });
    expect(lenient.ok).toBe(true);
    expect(lenient.documents.every((d) => d.sha256)).toBe(true);

    const manifest = JSON.parse(new TextDecoder().decode(entries[1].data)) as ExportManifest;
    manifest.files.find((f) => f.path === 'contacts.csv')!.sha256 = '0'.repeat(64);
    const edited = replaced(entries, MANIFEST_NAME, new TextEncoder().encode(JSON.stringify(manifest)));
    expect((await verifyCompanyExport(pack(edited))).problems).toContain('contacts.csv: SHA-256 does not match manifest.json (the file was changed).');
  });

  it('catches records that disagree, a broken link, and a document left out', async () => {
    const db = records();
    db.activities[0].contactId = 'con_gone';
    const broken = await verifyCompanyExport(pack(await entriesFor(db)));
    expect(broken.problems).toContain('activities act_1.contactId points at contacts con_gone, which is not in the export.');
    expect(broken.links.broken).toBe(1);

    const leftOut = await verifyCompanyExport(pack(await entriesFor(records(), new Map<string, DocumentContent>([
      ['fil_aaaa1', { data: PDF }], ['fil_bbbb2', { missing: 'The file is no longer in AEROBOOK’s document storage.' }],
    ]))));
    expect(leftOut.problems).toContain('Document fil_bbbb2: not in the export: The file is no longer in AEROBOOK’s document storage..');

    // The JSON backup and the spreadsheet disagree about which contacts exist.
    const entries = await entriesFor();
    const backup = JSON.parse(new TextDecoder().decode(entries.find((e) => e.path === `${P}aerobook-backup.json`)!.data));
    backup.contacts.pop();
    const json = new TextEncoder().encode(JSON.stringify(backup));
    const disagree = await verifyCompanyExport(pack(await withManifest(
      replaced(entries.filter((e) => e.path !== P + MANIFEST_NAME), 'aerobook-backup.json', json), T,
    )));
    expect(disagree.problems.join('\n')).toMatch(/contacts: aerobook-backup.json has 1, contacts.csv has 2/);
  });

  it('catches a document whose size disagrees with its record', async () => {
    const db = records();
    db.files[1].size = PHOTO.length + 1;
    const report = await verifyCompanyExport(pack(await entriesFor(db)));
    expect(report.problems).toContain(`Document fil_bbbb2: ${PHOTO.length} bytes; its record says ${PHOTO.length + 1}.`);
  });

  it('checks against what the source held', async () => {
    const report = await verifyCompanyExport(await exportBytes(), {
      expected: { counts: { contacts: 3 }, documents: [{ id: 'fil_aaaa1', size: PDF.length + 1 }, { id: 'fil_cccc3', size: 5 }] },
    });
    expect(report.ok).toBe(false);
    expect(report.problems).toEqual(expect.arrayContaining([
      'contacts: the export has 2; the source had 3.',
      `Source document fil_aaaa1: ${PDF.length} bytes in the export; the source had ${PDF.length + 1}.`,
      'Source document fil_cccc3 is not in the export.',
      'Document fil_bbbb2 is not one the source had.',
    ]));
  });

  it('says so when the file is not a ZIP at all, or is cut short', async () => {
    expect((await verifyCompanyExport(new TextEncoder().encode('not a zip'))).problems[0]).toMatch(/Not a ZIP/);
    const bytes = await exportBytes();
    expect((await verifyCompanyExport(bytes.subarray(0, bytes.length - 40))).ok).toBe(false);
  });
});

describe('npm run verify:export', () => {
  it('exits 0 on a good export and 1 on a damaged one', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aerobook-verify-'));
    try {
      const good = join(dir, 'good.zip');
      const bad = join(dir, 'bad.zip');
      const bytes = await exportBytes();
      await writeFile(good, bytes);
      const damaged = bytes.slice();
      const text = Array.from(damaged, (b) => String.fromCharCode(b)).join('');
      damaged[text.indexOf('unique-marker')] ^= 0x01;
      await writeFile(bad, damaged);
      const run = promisify(execFile);
      const ok = await run('npx', ['tsx', 'scripts/verify-export.ts', good]);
      expect(ok.stdout).toMatch(/Documents verified: 2\/2/);
      expect(ok.stdout).toMatch(/RESULT: PASS/);
      const failed = await run('npx', ['tsx', 'scripts/verify-export.ts', bad]).then(() => null, (e: { code: number; stdout: string }) => e);
      expect(failed?.code).toBe(1);
      expect(failed?.stdout).toMatch(/RESULT: FAIL/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
