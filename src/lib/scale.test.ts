/**
 * The app has to stay quick at the size a working book actually reaches.
 * These are not micro-benchmarks — they build a realistic dataset and assert
 * that the operations the UI performs on every keystroke and every render
 * stay in the range where a phone feels instant.
 */
import { describe, expect, it } from 'vitest';
import { buildIndex, search, searchIndex } from './search';
import { bucketFollowUps, nextMove, openFollowUps, openOpportunities, pipeline } from './selectors';
import { renewalsNeedingAttention, renewalSummary } from './insurance';
import { buildPreview, applyImport } from './importer';
import { parseCsv } from './csv';
import { detectMappings } from './mapping';
import { emptyDatabase, type Database } from '../data/types';
import { addDays } from './dates';

const CONTACTS = 500;
const AIRCRAFT = 100;
const ACTIVITIES = 1200;
const FOLLOW_UPS = 400;

function bigDatabase(): Database {
  const db = emptyDatabase();
  for (let i = 0; i < CONTACTS; i += 1) {
    db.contacts.push({
      id: `con_${i}`,
      firstName: `First${i}`,
      lastName: `Last${i}`,
      rawName: `Last${i} First${i}`,
      company: i % 7 === 0 ? `Holdings ${i} LLC` : '',
      email: `owner${i}@example.com`,
      phone: `805555${String(1000 + i).slice(-4)}`,
      address: `${i} Runway Road`,
      city: i % 2 ? 'Santa Barbara' : 'Denver',
      state: i % 2 ? 'CA' : 'CO',
      zip: '93101',
      contactTypes: ['Aircraft Owner'],
      status: 'Prospect',
      prospectStatus: 'New',
      notes: `Met at the show in ${2018 + (i % 8)}.`,
      custom: {},
      nameConfidence: 'high',
      needsReview: false,
      createdAt: '',
      updatedAt: '',
    });
  }
  for (let i = 0; i < AIRCRAFT; i += 1) {
    const tail = `N${100 + i}AB`;
    db.aircraft.push({
      id: `acf_${i}`,
      tailNumber: tail,
      tailKey: `${100 + i}AB`,
      year: String(2005 + (i % 20)),
      make: i % 3 ? 'Cirrus' : 'Pilatus',
      model: i % 3 ? 'SR22T' : 'PC-12',
      serial: `SN-${i}`,
      ownerships: [{ contactId: `con_${i}` }],
      status: i % 11 === 0 ? 'For Sale' : 'Owned',
      notes: '',
      custom: {},
      createdAt: '',
      updatedAt: '',
    });
    db.policies.push({
      id: `pol_${i}`,
      aircraftId: `acf_${i}`,
      contactId: `con_${i}`,
      opportunityId: null,
      carrier: i % 2 ? 'Global Aerospace' : 'Old Republic',
      policyNumber: `GA-${i}`,
      brokerAgent: '',
      // A spread of renewals, some inside the window and some long gone.
      expirationDate: addDays((i % 40) * 12 - 120),
      premium: '',
      hullValue: '',
      liabilityLimit: '',
      deductible: '',
      status: 'Unknown',
      quotedPremium: '',
      renewalNotes: '',
      notes: '',
      createdAt: '',
      updatedAt: '',
    });
    db.opportunities.push({
      id: `opp_${i}`,
      contactId: `con_${i}`,
      aircraftId: `acf_${i}`,
      type: 'Insurance',
      status: (['Lead', 'Contacted', 'Quoting', 'Won', 'Lost'] as const)[i % 5],
      title: `${tail} renewal`,
      openedAt: '',
      nextAction: 'Send the comparison',
      notes: '',
      createdAt: '',
      updatedAt: String(i),
    });
  }
  for (let i = 0; i < ACTIVITIES; i += 1) {
    db.activities.push({
      id: `act_${i}`,
      contactId: `con_${i % CONTACTS}`,
      aircraftId: `acf_${i % AIRCRAFT}`,
      opportunityId: null,
      type: 'Call',
      date: addDays(-i),
      subject: `Call ${i}`,
      notes: '',
      createdAt: '',
      updatedAt: '',
    });
  }
  for (let i = 0; i < FOLLOW_UPS; i += 1) {
    db.followUps.push({
      id: `fup_${i}`,
      contactId: `con_${i % CONTACTS}`,
      aircraftId: `acf_${i % AIRCRAFT}`,
      opportunityId: null,
      dueDate: addDays((i % 60) - 10),
      note: `Follow up ${i}`,
      priority: i % 9 === 0 ? 'High' : 'Normal',
      completed: i % 4 === 0,
      createdAt: '',
      updatedAt: '',
    });
  }
  return db;
}

function ms(fn: () => unknown): number {
  const start = performance.now();
  fn();
  return performance.now() - start;
}

describe(`a working book: ${CONTACTS} contacts, ${AIRCRAFT} aircraft, ${ACTIVITIES} activities`, () => {
  const db = bigDatabase();

  it('builds the search index in a frame', () => {
    expect(ms(() => buildIndex(db))).toBeLessThan(250);
  });

  it('answers a query off a built index fast enough to type against', () => {
    const index = buildIndex(db);
    // The UI rebuilds nothing per keystroke; it queries the memoised index.
    expect(ms(() => searchIndex(index, 'n150ab'))).toBeLessThan(50);
    expect(ms(() => searchIndex(index, 'cirrus santa'))).toBeLessThan(50);
  });

  it('still finds the right records at this size', () => {
    const hits = search(db, 'n150ab');
    expect(hits[0].kind).toBe('aircraft');
    expect(hits[0].title).toBe('N150AB');
    expect(search(db, 'global aerospace').length).toBeGreaterThan(0);
  });

  it('renders the home screen selectors in a frame', () => {
    expect(
      ms(() => {
        bucketFollowUps(openFollowUps(db));
        renewalsNeedingAttention(db);
        renewalSummary(db);
        openOpportunities(db);
        pipeline(db);
      }),
    ).toBeLessThan(100);
  });

  it('answers "what is next" for one record without scanning everything twice', () => {
    expect(ms(() => nextMove(db, { aircraftId: 'acf_50' }))).toBeLessThan(25);
    expect(nextMove(db, { aircraftId: 'acf_50' })).not.toBeNull();
  });

  it('serialises the whole document quickly enough to save on every change', () => {
    expect(ms(() => JSON.stringify(db))).toBeLessThan(250);
  });
});

describe('a large import', () => {
  /**
   * 1,000 rows of the shape the FAA lists arrive in — last name first, and
   * every owner genuinely distinct, so nothing here is deduplicated for the
   * right reason and mistaken for the wrong one.
   */
  const SURNAMES = [
    'SMITH', 'HEINE', 'HUMPHREY', 'OKONKWO', 'RIVERA', 'NGUYEN', 'MACLEOD', 'DAHLBERG',
    'FERRARO', 'OKAMOTO', 'BRENNAN', 'SOKOLOV', 'AHMADI', 'LINDQVIST', 'CASTELLANOS',
    'WHITFIELD', 'OYELARAN', 'PETTERSEN', 'KOWALCZYK', 'ABERNATHY',
    'VANDERBERG', 'MCALLISTER', 'THORNBURY', 'ESPOSITO', 'HALVORSEN',
    'BAUMGARTNER', 'DELACROIX', 'FITZGERALD', 'GUTIERREZ', 'HOLLAND',
    'IVERSON', 'JOHANSSON', 'KILPATRICK', 'LARRABEE', 'MONTGOMERY',
    'NAKASHIMA', 'ODONNELL', 'PRESCOTT', 'QUINTANILLA', 'REDMAYNE',
  ];
  const FIRST_NAMES = [
    'JOHN', 'MARLON', 'ADAOBI', 'PRIYA', 'SVEN', 'CARMEN', 'HIROSHI', 'ELEANOR', 'TOMAS',
    'NADIA', 'GRACE', 'OMAR', 'INGRID', 'DESMOND', 'ROSALIND', 'YUSUF', 'BRIDGET', 'LARS',
    'CONSTANCE', 'RAFAEL', 'MERCEDES', 'AUGUSTINE', 'WINIFRED', 'THEODORE', 'JOSEPHINE',
  ];

  const csv = [
    'N-NUMBER,YEAR MFR,MFR,MODEL,SERIAL NUMBER,NAME,STREET,CITY,STATE,ZIP CODE,EMAIL',
    ...Array.from({ length: 1000 }, (_, i) => {
      const name = `${SURNAMES[i % SURNAMES.length]} ${FIRST_NAMES[Math.floor(i / SURNAMES.length)]}`;
      return [
        `N${2000 + i}XY`, String(2000 + (i % 25)), 'CIRRUS DESIGN CORP', 'SR22T', `SN${i}`,
        name, `${i} Ramp Rd`, 'Santa Barbara', 'CA', '93101', `owner${i}@example.com`,
      ].join(',');
    }),
  ].join('\n');

  const parsed = parseCsv(csv);
  const mappings = detectMappings(parsed.headers);

  it('parses a thousand rows quickly', () => {
    expect(parsed.rows).toHaveLength(1000);
    expect(ms(() => parseCsv(csv))).toBeLessThan(400);
  });

  it('previews a thousand rows quickly', () => {
    const db = emptyDatabase();
    let preview!: ReturnType<typeof buildPreview>;
    expect(ms(() => { preview = buildPreview(parsed.rows, mappings, db, { nameOrder: 'lastFirst' }); })).toBeLessThan(1500);
    expect(preview).toHaveLength(1000);
    // Against an empty database nothing can already exist or collide.
    expect(preview.some((r) => r.status === 'EXISTING' || r.status === 'DUPLICATE')).toBe(false);
    expect(preview.every((r) => r.status === 'NEW')).toBe(true);
  });

  it('applies a thousand rows and links every aircraft to its owner', () => {
    const db = emptyDatabase();
    const preview = buildPreview(parsed.rows, mappings, db, { nameOrder: 'lastFirst' });
    let result!: ReturnType<typeof applyImport>;
    expect(ms(() => { result = applyImport(preview, db, { filename: 'big.csv', nameOrder: 'lastFirst' }); })).toBeLessThan(2000);

    expect(result.aircraft).toHaveLength(1000);
    expect(result.contacts).toHaveLength(1000);
    expect(result.aircraft.every((a) => a.ownerships.length === 1)).toBe(true);
  });

  it('re-importing the same thousand rows creates nothing', () => {
    const db = emptyDatabase();
    const first = applyImport(buildPreview(parsed.rows, mappings, db, { nameOrder: 'lastFirst' }), db, { filename: 'big.csv', nameOrder: 'lastFirst' });
    const after: Database = { ...db, contacts: first.contacts, aircraft: first.aircraft };

    const second = buildPreview(parsed.rows, mappings, after, { nameOrder: 'lastFirst' });
    expect(second.every((r) => r.status !== 'NEW')).toBe(true);

    const applied = applyImport(second, after, { filename: 'big.csv', nameOrder: 'lastFirst' });
    expect(applied.aircraft).toHaveLength(1000);
    expect(applied.contacts).toHaveLength(1000);
    expect(applied.record.contactsCreated).toBe(0);
    expect(applied.record.aircraftCreated).toBe(0);
  });
});
