/**
 * The complete archive: every field of every record makes it out, every
 * document file is in it byte for byte, and checking it afterwards catches a
 * missing file, a damaged one, or a link to a record that is not there.
 */
import { describe, expect, it } from 'vitest';
import { emptyDatabase, type Database, type FileRecord } from '../data/types';
import { fullContact } from '../test/fixtures';
import { buildArchive, checkLinks, sha256Hex, summarize, verifyArchive } from './archive';
import { activitiesCsv, contactsCsv, documentsCsv, followUpsCsv, type ExportedComment } from './export';
import { parseCsv } from './csv';
import { crc32, readZip, writeZip } from './zip';

const T = '2026-10-01T12:00:00.000Z';

function sampleDb(): Database {
  const db = emptyDatabase();
  db.contacts = [fullContact(1), fullContact(2)];
  db.aircraft = [{
    id: 'air_1', tailNumber: 'N123AB', tailKey: '123AB', year: '2021', make: 'Cirrus', model: 'SR22T', serial: '9001',
    baseAirport: 'KSBA', ownerships: [{ contactId: 'con_1' }, { contactId: 'con_2', endedAt: '2020-01-01' }],
    status: 'Owned', notes: '', targetPrice: '900000', custom: {}, createdAt: T, updatedAt: T,
  }];
  db.opportunities = [{
    id: 'opp_1', contactId: 'con_1', aircraftId: 'air_1', type: 'Insurance', status: 'Quoting', title: 'Renewal',
    openedAt: T, notes: '', createdAt: T, updatedAt: T,
  }];
  db.activities = [
    { id: 'act_1', contactId: 'con_1', aircraftId: 'air_1', opportunityId: 'opp_1', type: 'Note', date: T, subject: 'Called', notes: 'Wants a quote', createdAt: T },
    { id: 'act_2', contactId: 'con_2', aircraftId: null, opportunityId: null, type: 'Call', date: T, subject: 'Left message', notes: '', createdAt: T },
  ];
  db.followUps = [{
    id: 'fu_1', contactId: 'con_1', aircraftId: null, opportunityId: 'opp_1', dueDate: '2026-10-05', note: 'Send quote',
    kind: 'quote', assigneeId: 'u_bob', assignedBy: 'u_alice', completed: false, createdAt: T, updatedAt: T,
  }];
  db.files = [
    { id: 'fil_aaaa1', name: 'Binder.pdf', mimeType: 'application/pdf', size: 10, contactId: null, aircraftId: 'air_1', opportunityId: null, blobPath: 'files/fil_aaaa1/Binder.pdf', createdAt: T },
    { id: 'fil_bbbb2', name: 'Spec/sheet:1.pdf', mimeType: 'application/pdf', size: 3, contactId: 'con_1', aircraftId: null, opportunityId: 'opp_1', blobPath: 'files/fil_bbbb2/Spec_sheet_1.pdf', createdAt: T },
  ];
  return db;
}

const FILES: Record<string, Uint8Array> = {
  fil_aaaa1: new TextEncoder().encode('0123456789'),
  fil_bbbb2: new Uint8Array([0, 255, 7]),
};
const comments: ExportedComment[] = [
  { id: 3, aircraftId: 'air_1', authorId: 'u_alice', authorName: 'Alice', body: 'Hangar fee is due', createdAt: T, editedAt: null },
];
const readFile = async (f: FileRecord) => FILES[f.id];

describe('zip', () => {
  it('round-trips names and bytes, and detects damage', () => {
    const zip = writeZip([{ name: 'a.txt', data: new TextEncoder().encode('hello') }, { name: 'dir/ü.bin', data: new Uint8Array([1, 2, 3]) }]);
    const entries = readZip(zip);
    expect(entries.map((e) => e.name)).toEqual(['a.txt', 'dir/ü.bin']);
    expect(Array.from(entries[1].data)).toEqual([1, 2, 3]);
    expect(entries.every((e) => e.crcOk)).toBe(true);
    const damaged = zip.slice();
    damaged[30 + 'a.txt'.length] ^= 0xff; // first byte of "hello"
    expect(readZip(damaged)[0].crcOk).toBe(false);
  });

  it('computes the standard CRC-32', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });
});

describe('CSV exports', () => {
  const row = (csv: string, n = 0) => {
    const t = parseCsv(csv);
    return Object.fromEntries(t.headers.map((h, i) => [h, t.rows[n][i]]));
  };

  it('carry every contact field', () => {
    const c = fullContact(7);
    const r = row(contactsCsv({ contacts: [c], aircraft: [] }));
    const cells = Object.values(r);
    const strings: string[] = [];
    const walk = (v: unknown) => {
      if (typeof v === 'string') strings.push(v);
      else if (v && typeof v === 'object') Object.values(v).forEach(walk);
    };
    const { phone, zip, contactTypes, needsReview, custom, ...rest } = c;
    walk(rest);
    for (const s of strings) expect(cells.some((cell) => cell.includes(s)), s).toBe(true);
    expect(r.Phone).toMatch(/805.*555.*1234/);
    expect(r.ZIP).toBe(zip);
    expect(r['Contact types']).toBe(contactTypes.join('; '));
    expect(r['Needs review']).toBe(needsReview ? 'yes' : 'no');
    expect(JSON.parse(r['Custom fields'])).toEqual(custom);
    expect(r.ID).toBe(c.id);
    void phone;
  });

  it('carry notes and activities with what they are linked to', () => {
    const db = sampleDb();
    const r = row(activitiesCsv(db));
    expect(r).toMatchObject({
      Subject: 'Called', Notes: 'Wants a quote', Contact: 'First1 Last1', Aircraft: 'N123AB', Opportunity: 'Renewal',
      ID: 'act_1', 'Contact ID': 'con_1', 'Aircraft ID': 'air_1', 'Opportunity ID': 'opp_1',
    });
  });

  it('carry follow-ups with who they are for', () => {
    const r = row(followUpsCsv(sampleDb(), new Map([['u_bob', 'Bob'], ['u_alice', 'Alice']])));
    expect(r).toMatchObject({ What: 'Send quote', For: 'Bob', 'Given by': 'Alice', 'Opportunity ID': 'opp_1', ID: 'fu_1' });
  });

  it('say which documents are missing from an archive', () => {
    const t = parseCsv(documentsCsv(sampleDb(), new Map([['fil_aaaa1', { path: 'documents/fil_aaaa1/Binder.pdf', sha256: 'x' }], ['fil_bbbb2', null]])));
    const i = t.headers.indexOf('File in this archive');
    expect(t.rows.map((r) => r[i])).toEqual(['documents/fil_aaaa1/Binder.pdf', 'MISSING']);
  });
});

describe('the complete archive', () => {
  it('holds every record, every comment and every document, checkably', async () => {
    const db = sampleDb();
    const { zip, manifest } = await buildArchive({ db, comments, readFile, exportedBy: 'Alice', now: new Date(T) });
    expect(manifest.problems).toEqual([]);
    expect(manifest.collections.contacts).toEqual(await summarize(['con_2', 'con_1']));
    expect(manifest.collections.aircraftComments.count).toBe(1);
    expect(manifest.links).toEqual({ total: 13, broken: [] });

    const entries = new Map(readZip(zip).map((e) => [e.name, e.data]));
    for (const name of ['README.txt', 'manifest.json', 'aerobook-data.json', 'aircraft-comments.json', 'csv/contacts.csv',
      'csv/activities-and-notes.csv', 'csv/follow-ups.csv', 'csv/documents.csv', 'csv/aircraft-comments.csv']) {
      expect(entries.has(name), name).toBe(true);
    }
    // Every document, byte for byte, under a safe name.
    expect(Array.from(entries.get('documents/fil_aaaa1/Binder.pdf')!)).toEqual(Array.from(FILES.fil_aaaa1));
    expect(Array.from(entries.get('documents/fil_bbbb2/Spec_sheet_1.pdf')!)).toEqual(Array.from(FILES.fil_bbbb2));
    expect(manifest.documents.map((d) => d.sha256)).toEqual([await sha256Hex(FILES.fil_aaaa1), await sha256Hex(FILES.fil_bbbb2)]);
    // The data file is the full export, which Restore reads.
    const data = JSON.parse(new TextDecoder().decode(entries.get('aerobook-data.json')));
    expect(data.contacts).toEqual(db.contacts);
    expect(data.activities).toEqual(db.activities);

    const report = await verifyArchive(zip);
    expect(report).toMatchObject({ ok: true, problems: [], documents: { expected: 2, present: 2, missing: [], corrupted: [] } });
    expect(report.counts).toMatchObject({ contacts: 2, aircraft: 1, activities: 2, followUps: 1, files: 2, aircraftComments: 1 });
  });

  it('says so when a document file cannot be read', async () => {
    const { zip, manifest } = await buildArchive({ db: sampleDb(), comments, readFile: async (f) => (f.id === 'fil_aaaa1' ? FILES.fil_aaaa1 : undefined) });
    expect(manifest.problems).toHaveLength(1);
    expect(manifest.documents.find((d) => d.id === 'fil_bbbb2')!.status).toBe('missing');
    const report = await verifyArchive(zip);
    expect(report.ok).toBe(false);
    expect(report.documents.missing).toEqual(['fil_bbbb2']);
  });

  it('says so when a file in it has been damaged since', async () => {
    const { zip } = await buildArchive({ db: sampleDb(), comments, readFile });
    const bytes = zip.slice();
    // The document's own bytes, "0123456789", stored as they are.
    const text = Array.from(bytes, (b) => String.fromCharCode(b)).join('');
    bytes[text.lastIndexOf('0123456789')] = 0x58;
    const report = await verifyArchive(bytes);
    expect(report.ok).toBe(false);
    expect(report.documents.corrupted).toEqual(['fil_aaaa1']);
  });

  it('says so when a record went missing from it, or a link points nowhere', async () => {
    const db = sampleDb();
    db.contacts = db.contacts.filter((c) => c.id !== 'con_2');
    const links = checkLinks(db);
    expect(links.broken).toEqual([
      { collection: 'activities', id: 'act_2', field: 'contactId', target: 'con_2' },
      { collection: 'aircraft', id: 'air_1', field: 'ownerships.contactId', target: 'con_2' },
    ]);
    const { zip, manifest } = await buildArchive({ db, comments, readFile });
    expect(manifest.problems.join(' ')).toMatch(/2 link/);
    expect((await verifyArchive(zip)).links.broken).toBe(2);
  });

  it('refuses a manifest that does not match its data', async () => {
    const { zip } = await buildArchive({ db: sampleDb(), comments, readFile });
    const entries = readZip(zip).map((e) => {
      if (e.name !== 'aerobook-data.json') return { name: e.name, data: e.data };
      const data = JSON.parse(new TextDecoder().decode(e.data));
      data.contacts.pop();
      return { name: e.name, data: new TextEncoder().encode(JSON.stringify(data)) };
    });
    const report = await verifyArchive(writeZip(entries));
    expect(report.ok).toBe(false);
    expect(report.problems.join(' ')).toMatch(/contacts/);
  });
});
