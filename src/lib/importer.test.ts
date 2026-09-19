import { describe, expect, it } from 'vitest';
import { parseCsv } from './csv';
import { detectMappings } from './mapping';
import { applyImport, buildPreview, summarizePreview } from './importer';
import { emptyDatabase } from '../data/types';

const HEADER = 'Tail,Year,Make,Model,Owner,Registrant type,Street,Street 2,City,State,ZIP,Phone,Email';

function importText(text: string, db = emptyDatabase()) {
  const table = parseCsv(text);
  const mappings = detectMappings(table.headers);
  const preview = buildPreview(table.rows, mappings, db, { nameOrder: 'lastFirst' });
  return { table, mappings, preview, db };
}

function run(text: string, db = emptyDatabase()) {
  const { preview } = importText(text, db);
  const result = applyImport(preview, db, { filename: 'test.csv', nameOrder: 'lastFirst' });
  return { preview, result };
}

const TWO_ROWS =
  `${HEADER}\n` +
  'N917JH,2026,Cirrus Design Corp,SR22T,Heine John Charles,Individual,1308 Santa Teresita Dr,,Santa Barbara,CA,931051947,7818917648,JHEINE@ACENTECH.COM\n' +
  'N441FP,2026,Cirrus Design Corp,SR22T,Humphrey Marlon,Individual,4209 Woodbine Ln,,Birmingham,AL,35226,,HUMPHREYBF@YAHOO.COM\n';

describe('preview', () => {
  it('marks everything new against an empty database', () => {
    const { preview } = importText(TWO_ROWS);
    expect(preview).toHaveLength(2);
    expect(preview.every((r) => r.status === 'NEW')).toBe(true);
    expect(preview.every((r) => r.action === 'create')).toBe(true);
    expect(preview[0].tailDisplay).toBe('N917JH');
    expect(preview[0].ownerDisplay).toBe('John Heine');
    expect(preview[0].aircraftDisplay).toBe('2026 Cirrus Design Corp SR22T');
    expect(preview[0].location).toBe('Santa Barbara, CA');
  });

  it('flags a missing email', () => {
    const { preview } = importText(
      `${HEADER}\nN920AM,2017,Cirrus,SR22T,Anderson James S,Individual,35244 Oil City Rd,,Coalinga,CA,932109221,5592696295,\n`,
    );
    expect(preview[0].flags).toContain('MISSING EMAIL');
    expect(summarizePreview(preview).missingEmail).toBe(1);
  });

  it('flags a duplicate tail inside the same file', () => {
    const { preview } = importText(
      `${TWO_ROWS}N917JH,2026,Cirrus,SR22T,Heine John Charles,Individual,1308 Santa Teresita Dr,,Santa Barbara,CA,931051947,,\n`,
    );
    expect(preview[2].status).toBe('DUPLICATE');
    expect(preview[2].duplicateOfRow).toBe(0);
    expect(preview[2].selected).toBe(false);
  });

  it('spots two aircraft belonging to one owner', () => {
    const { preview } = importText(
      `${TWO_ROWS}N451RK,2015,Cirrus,SR22T,Heine John C,Individual,1308 Santa Teresita Dr,,Santa Barbara,CA,931051947,7818917648,JHEINE@ACENTECH.COM\n`,
    );
    expect(preview[2].status).not.toBe('DUPLICATE');
    expect(preview[2].sameOwnerAsRow).toBe(0);
  });

  it('flags an unparseable owner name for review', () => {
    const { preview } = importText(`${HEADER}\nN1,2000,Cirrus,SR22,Smith,Individual,1 Main,,Reno,NV,89501,,a@b.com\n`);
    expect(preview[0].flags).toContain('NAME UNCERTAIN');
    expect(preview[0].status).toBe('REVIEW');
  });

  it('keeps unmapped columns as custom data', () => {
    const { preview } = importText(
      'Tail,Owner,Engine Hours\nN917JH,Heine John,1430\n',
    );
    expect(preview[0].extracted.custom).toEqual({ 'Engine Hours': '1430' });
  });
});

describe('apply', () => {
  it('creates linked contacts and aircraft', () => {
    const { result } = run(TWO_ROWS);
    expect(result.record.contactsCreated).toBe(2);
    expect(result.record.aircraftCreated).toBe(2);
    expect(result.contacts).toHaveLength(2);
    expect(result.aircraft).toHaveLength(2);

    const n917 = result.aircraft.find((a) => a.tailNumber === 'N917JH')!;
    const owner = result.contacts.find((c) => c.id === n917.ownerships[0].contactId)!;
    expect(owner.firstName).toBe('John');
    expect(owner.lastName).toBe('Heine');
    expect(owner.rawName).toBe('Heine John Charles');
    expect(owner.email).toBe('jheine@acentech.com');
    expect(n917.tailKey).toBe('917JH');
  });

  it('logs an import activity against each record', () => {
    const { result } = run(TWO_ROWS);
    expect(result.activities).toHaveLength(2);
    expect(result.activities[0].type).toBe('Import');
  });

  it('gives one owner both aircraft instead of duplicating the contact', () => {
    const { result } = run(
      `${TWO_ROWS}N451RK,2015,Cirrus,SR22T,Heine John C,Individual,1308 Santa Teresita Dr,,Santa Barbara,CA,931051947,7818917648,JHEINE@ACENTECH.COM\n`,
    );
    expect(result.record.contactsCreated).toBe(2);
    expect(result.record.aircraftCreated).toBe(3);
    const heine = result.contacts.find((c) => c.email === 'jheine@acentech.com')!;
    const owned = result.aircraft.filter((a) => a.ownerships.some((o) => o.contactId === heine.id));
    expect(owned.map((a) => a.tailNumber).sort()).toEqual(['N451RK', 'N917JH']);
  });

  it('re-importing the same file creates nothing', () => {
    const first = run(TWO_ROWS);
    const db = { ...emptyDatabase(), contacts: first.result.contacts, aircraft: first.result.aircraft };
    const second = run(TWO_ROWS, db);

    expect(second.preview.every((r) => r.status === 'EXISTING')).toBe(true);
    expect(second.preview.every((r) => r.action === 'skip')).toBe(true);
    expect(second.result.contacts).toHaveLength(2);
    expect(second.result.aircraft).toHaveLength(2);
    expect(second.result.record.contactsCreated).toBe(0);
    expect(second.result.record.aircraftCreated).toBe(0);
    expect(second.result.activities).toHaveLength(0);
  });

  it('fills in information that was missing, without overwriting what is there', () => {
    const first = run(
      `${HEADER}\nN917JH,2026,Cirrus,SR22T,Heine John Charles,Individual,1308 Santa Teresita Dr,,Santa Barbara,CA,931051947,,\n`,
    );
    const db = { ...emptyDatabase(), contacts: first.result.contacts, aircraft: first.result.aircraft };
    const { preview, result } = run(
      `${HEADER}\nN917JH,2026,Cirrus,SR22T,Heine John Charles,Individual,1308 Santa Teresita Dr,,Santa Barbara,CA,931051947,7818917648,JHEINE@ACENTECH.COM\n`,
      db,
    );
    expect(preview[0].status).toBe('EXISTING');
    expect(preview[0].action).toBe('update');
    expect(preview[0].contactChanges.every((c) => c.isNewInformation)).toBe(true);
    expect(result.contacts).toHaveLength(1);
    expect(result.contacts[0].email).toBe('jheine@acentech.com');
    expect(result.contacts[0].phone).toBe('7818917648');
  });

  it('asks before overwriting a conflicting value', () => {
    const first = run(TWO_ROWS);
    const db = { ...emptyDatabase(), contacts: first.result.contacts, aircraft: first.result.aircraft };
    const { preview } = importText(
      `${HEADER}\nN917JH,2026,Cirrus Design Corp,SR22T,Heine John Charles,Individual,99 New Street,,Santa Barbara,CA,931051947,7818917648,JHEINE@ACENTECH.COM\n`,
      db,
    );
    expect(preview[0].status).toBe('REVIEW');
    expect(preview[0].action).toBe('skip');
    const conflict = preview[0].contactChanges.find((c) => c.field === 'address')!;
    expect(conflict.existing).toBe('1308 Santa Teresita Dr');
    expect(conflict.incoming).toBe('99 New Street');
  });

  it('honours a row the user deselected', () => {
    const { preview } = importText(TWO_ROWS);
    preview[1].selected = false;
    const result = applyImport(preview, emptyDatabase(), { filename: 't.csv', nameOrder: 'lastFirst' });
    expect(result.contacts).toHaveLength(1);
    expect(result.aircraft).toHaveLength(1);
  });

  it('records the aircraft even when the owner cannot be identified', () => {
    const { result } = run(`${HEADER}\nN917JH,2026,Cirrus,SR22T,,,,,,,,,\n`);
    expect(result.aircraft).toHaveLength(1);
    expect(result.contacts).toHaveLength(0);
    expect(result.aircraft[0].ownerships).toEqual([]);
  });

  it('records the contact even when there is no tail number', () => {
    const { result } = run(`${HEADER}\n,,,,Heine John Charles,Individual,1308 Santa Teresita Dr,,Santa Barbara,CA,93105,,a@b.com\n`);
    expect(result.contacts).toHaveLength(1);
    expect(result.aircraft).toHaveLength(0);
  });

  it('treats a company registrant as a company', () => {
    const { result } = run(`${HEADER}\nN1RB,2020,Cirrus,SR22T,Blue Ridge Aviation LLC,Corporation,1 Ramp Rd,,Asheville,NC,28801,,ops@example.com\n`);
    expect(result.contacts[0].company).toBe('Blue Ridge Aviation LLC');
    expect(result.contacts[0].firstName).toBe('');
    expect(result.contacts[0].nameConfidence).toBe('organization');
  });

  it('survives a malformed file without throwing', () => {
    expect(() => run('not,a,real,header\n\n,,,\n')).not.toThrow();
    expect(() => run('')).not.toThrow();
  });
});
