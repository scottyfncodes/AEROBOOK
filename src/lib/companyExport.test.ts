import { buildCompanyExport, exportTime, safeFilename, type CompanyExportInput } from './companyExport';
import { parseCsv } from './csv';
import { emptyDatabase } from '../data/types';

const T = '2026-09-01T09:00:00.000Z';

function input(over: Partial<CompanyExportInput> = {}): CompanyExportInput {
  return {
    records: emptyDatabase(),
    backupJson: '{}',
    people: [],
    comments: [],
    audit: [],
    documents: new Map(),
    exportedAt: T,
    exportedBy: { id: 'usr_a', name: 'Scott' },
    ...over,
  };
}

function read(entries: ReturnType<typeof buildCompanyExport>, name: string) {
  const entry = entries.find((e) => e.path === `AEROBOOK-Company-Export/${name}`);
  if (!entry) throw new Error(`${name} missing`);
  const { headers, rows } = parseCsv(new TextDecoder().decode(entry.data));
  return rows.map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ''])));
}

const contact = (id: string, name: string, company = '') => ({
  id, firstName: name, lastName: '', rawName: name, company, email: '', phone: '', address: '',
  city: '', state: '', zip: '', contactTypes: [], status: 'Prospect' as const, prospectStatus: 'New' as const, notes: '',
  custom: {}, nameConfidence: 'high' as const, needsReview: false, createdAt: T, updatedAt: T,
});
const file = (id: string, name: string, contactId: string) => ({
  id, name, mimeType: 'application/pdf', size: 3, contactId, aircraftId: null, opportunityId: null, blobPath: `files/${id}/${name}`, createdAt: T,
});

describe('company export package', () => {
  it('writes times one way, UTC ISO 8601, and leaves calendar dates as dates', () => {
    expect(exportTime('2026-09-03T10:00:00-07:00')).toBe('2026-09-03T17:00:00.000Z');
    expect(exportTime('2026-09-03')).toBe('2026-09-03');
    expect(exportTime('')).toBe('');
    expect(exportTime(undefined)).toBe('');
    expect(exportTime('next spring')).toBe('next spring');
  });

  it('keeps each customer’s notes, tasks and documents with that customer', () => {
    const db = emptyDatabase();
    db.contacts = [contact('con_a', 'Ana', 'Alpha Air'), contact('con_b', 'Ben', 'Beta Jets')];
    db.activities = ['con_a', 'con_b', 'con_a'].map((c, i) => ({
      id: `act_${i}`, contactId: c, aircraftId: null, opportunityId: null, type: 'Note' as const, date: T,
      subject: `Note ${i}`, notes: `about ${c}`, createdAt: T,
    }));
    db.followUps = [{ id: 'fup_b', contactId: 'con_b', aircraftId: null, opportunityId: null, dueDate: '2026-10-01', note: 'Call Ben', completed: false, createdAt: T, updatedAt: T }];
    db.files = [file('fil_a1', 'Binder.pdf', 'con_a'), file('fil_b1', 'Binder.pdf', 'con_b')];
    const entries = buildCompanyExport(input({
      records: db,
      documents: new Map([['fil_a1', { data: new Uint8Array([1]) }], ['fil_b1', { data: new Uint8Array([2]) }]]),
    }));
    const notes = read(entries, 'notes.csv').filter((n) => n.Kind === 'Timeline note');
    expect(notes.map((n) => [n.Content.split('\n\n')[1], n['Contact ID'], n.Company])).toEqual([
      ['about con_a', 'con_a', 'Alpha Air'], ['about con_b', 'con_b', 'Beta Jets'], ['about con_a', 'con_a', 'Alpha Air'],
    ]);
    expect(read(entries, 'tasks.csv')[0]).toMatchObject({ 'Contact ID': 'con_b', Contact: 'Ben', 'Assigned to': 'Unassigned' });
    // Two documents with the same name do not overwrite each other.
    const docs = read(entries, 'documents.csv');
    expect(docs.map((d) => [d['Contact ID'], d['File in this export']])).toEqual([
      ['con_a', 'documents/fil_a1/Binder.pdf'], ['con_b', 'documents/fil_b1/Binder.pdf'],
    ]);
    expect(entries.filter((e) => e.path.includes('/documents/')).map((e) => e.data[0])).toEqual([1, 2]);
  });

  it('keeps text a spreadsheet would run as a formula from running, and everything else exactly', () => {
    const db = emptyDatabase();
    db.contacts = [{ ...contact('con_x', '=HYPERLINK("http://evil")', 'Ünïcødé, "Quoted" Co.'), notes: 'line 1\nline 2 — 東京 ✈️' }];
    const row = read(buildCompanyExport(input({ records: db })), 'contacts.csv')[0];
    expect(row['First name']).toBe('\'=HYPERLINK("http://evil")');
    expect(row.Company).toBe('Ünïcødé, "Quoted" Co.');
    expect(row.Notes).toBe('line 1\nline 2 — 東京 ✈️');
  });

  it('names who recorded and last changed a record, from the audit log', () => {
    const db = emptyDatabase();
    db.contacts = [contact('con_a', 'Ana')];
    const entries = buildCompanyExport(input({
      records: db,
      audit: [
        { id: 2, at: T, userId: 'usr_b', userName: 'Bob', action: 'update', collection: 'contacts', recordId: 'con_a', summary: '' },
        { id: 1, at: T, userId: 'usr_a', userName: 'Ana Admin', action: 'create', collection: 'contacts', recordId: 'con_a', summary: '' },
      ],
    }));
    expect(read(entries, 'contacts.csv')[0]).toMatchObject({ 'Recorded by': 'Ana Admin', 'Last changed by': 'Bob' });
    expect(read(entries, 'audit-log.csv').map((e) => e['Entry ID'])).toEqual(['1', '2']);
  });

  it('puts the README first and says what is in the package', () => {
    const entries = buildCompanyExport(input());
    expect(entries[0].path).toBe('AEROBOOK-Company-Export/README.txt');
    const readme = new TextDecoder().decode(entries[0].data);
    expect(readme).toMatch(/Exported 2026-09-01T09:00:00.000Z \(UTC\) by Scott/);
    expect(readme).toMatch(/Not included: passwords/);
  });

  it('makes a filename safe for any system without losing what it can keep', () => {
    expect(safeFilename('Assurance — Ødegård.pdf')).toBe('Assurance — Ødegård.pdf');
    expect(safeFilename('../../etc/passwd')).toBe('_.._etc_passwd');
    expect(safeFilename('a:b*c?.pdf')).toBe('a_b_c_.pdf');
    expect(safeFilename('   ')).toBe('document');
  });
});
