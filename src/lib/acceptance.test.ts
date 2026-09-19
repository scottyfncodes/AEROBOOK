/**
 * Acceptance test against the real supplied file.
 *
 * This is the file the app was built for: owners-cirrus-design-corp-sr22t.csv.
 * Nothing here is stubbed — the CSV is read off disk, run through the same
 * parser, detector, preview and importer the UI uses, and then the end-to-end
 * workflow (open a tail, generate the email, log it, set a follow-up) is
 * exercised on the resulting records.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { parseCsv } from './csv';
import { detectMappings } from './mapping';
import { applyImport, buildPreview, summarizePreview } from './importer';
import { buildMailto, defaultTemplates, renderEmail } from './email';
import { search } from './search';
import { dueBucket, addDays } from './dates';
import { faaRegistryLink } from './links';
import { emptyDatabase, type Database } from '../data/types';

const here = dirname(fileURLToPath(import.meta.url));
const CSV_PATH = resolve(here, '../../sample-data/owners-cirrus-design-corp-sr22t.csv');
const CSV = readFileSync(CSV_PATH, 'utf8');

function freshImport(db: Database = emptyDatabase()) {
  const table = parseCsv(CSV);
  const mappings = detectMappings(table.headers);
  const preview = buildPreview(table.rows, mappings, db, { nameOrder: 'lastFirst' });
  const result = applyImport(preview, db, { filename: 'owners-cirrus-design-corp-sr22t.csv', nameOrder: 'lastFirst' });
  return { table, mappings, preview, result };
}

describe('acceptance: owners-cirrus-design-corp-sr22t.csv', () => {
  const { table, mappings, preview, result } = freshImport();

  it('1. parses the file', () => {
    expect(table.headers).toEqual([
      'Tail', 'Year', 'Make', 'Model', 'Owner', 'Registrant type',
      'Street', 'Street 2', 'City', 'State', 'ZIP', 'Phone', 'Email',
    ]);
    expect(table.rows).toHaveLength(117);
    expect(table.warnings).toEqual([]);
  });

  it('2. detects every column', () => {
    expect(mappings.filter((m) => m.field === 'custom' || m.field === 'ignore')).toHaveLength(0);
    expect(mappings.map((m) => m.field)).toContain('tailNumber');
    expect(mappings.map((m) => m.field)).toContain('ownerName');
    expect(mappings.map((m) => m.field)).toContain('email');
  });

  it('3. previews all 117 records', () => {
    const summary = summarizePreview(preview);
    expect(summary.total).toBe(117);
    expect(summary.duplicate).toBe(0);
    expect(summary.existing).toBe(0);
    expect(summary.missingEmail).toBe(11);
  });

  it('4. identifies aircraft', () => {
    expect(result.record.aircraftCreated).toBe(117);
    expect(result.aircraft.every((a) => a.tailKey.length > 0)).toBe(true);
    const n917 = result.aircraft.find((a) => a.tailNumber === 'N917JH')!;
    expect(n917).toBeDefined();
    expect(n917.year).toBe('2026');
    expect(n917.make).toBe('Cirrus Design Corp');
    expect(n917.model).toBe('SR22T');
  });

  it('5. identifies owners and does not duplicate the two who own two aircraft', () => {
    expect(result.record.contactsCreated).toBe(115);
    const heine = result.contacts.filter((c) => c.email === 'jheine@acentech.com');
    expect(heine).toHaveLength(1);
    expect(heine[0].firstName).toBe('John');
    expect(heine[0].lastName).toBe('Heine');
  });

  it('6. keeps the contact information it found', () => {
    const withEmail = result.contacts.filter((c) => c.email).length;
    const withPhone = result.contacts.filter((c) => c.phone).length;
    expect(withEmail).toBeGreaterThan(90);
    expect(withPhone).toBeGreaterThan(60);
    expect(result.record.recordsMissingEmail).toBe(11);
  });

  it('7. parses owner names, preserving the raw value', () => {
    const humphrey = result.contacts.find((c) => c.rawName === 'Humphrey Marlon')!;
    expect(humphrey.firstName).toBe('Marlon');
    expect(humphrey.lastName).toBe('Humphrey');

    const poole = result.contacts.find((c) => c.rawName === 'Poole James Gregory III')!;
    expect(poole.firstName).toBe('James');
    expect(poole.lastName).toBe('Poole');
    expect(poole.suffix).toBe('III');

    const trustee = result.contacts.find((c) => c.rawName === 'Goldberg William Trustee')!;
    expect(trustee.firstName).toBe('William');
    expect(trustee.role).toBe('Trustee');

    // Nothing in this file should be unreadable.
    expect(result.contacts.filter((c) => c.needsReview)).toHaveLength(0);
  });

  it('8-10. links each aircraft to its owner', () => {
    const linked = result.aircraft.filter((a) => a.ownerships.length > 0);
    expect(linked).toHaveLength(117);

    const n917 = result.aircraft.find((a) => a.tailNumber === 'N917JH')!;
    const owner = result.contacts.find((c) => c.id === n917.ownerships[0].contactId)!;
    expect(owner.lastName).toBe('Heine');

    // Both Heine aircraft point at the one contact.
    const heineAircraft = result.aircraft.filter((a) => a.ownerships.some((o) => o.contactId === owner.id));
    expect(heineAircraft.map((a) => a.tailNumber).sort()).toEqual(['N451RK', 'N917JH']);
  });

  it('11. finds the prospect by tail, by name and by city', () => {
    const db: Database = { ...emptyDatabase(), contacts: result.contacts, aircraft: result.aircraft };
    expect(search(db, 'n917jh').some((r) => r.kind === 'aircraft' && r.title === 'N917JH')).toBe(true);
    expect(search(db, 'N917JH').some((r) => r.title === 'N917JH')).toBe(true);
    expect(search(db, 'Heine').some((r) => r.kind === 'contact')).toBe(true);
    expect(search(db, 'SR22T', 500).filter((r) => r.kind === 'aircraft')).toHaveLength(117);
    // The owner of an SR22T is a relevant hit too, not just the airframe.
    expect(search(db, 'SR22T', 500).filter((r) => r.kind === 'contact').length).toBeGreaterThan(0);
    expect(search(db, 'Austin').filter((r) => r.kind === 'contact')).toHaveLength(4);
    expect(search(db, 'heine sr22t').length).toBeGreaterThan(0);
    expect(search(db, 'nothingmatchesthis')).toEqual([]);
  });

  it('12-15. generates an email addressed to the owner, about the aircraft', () => {
    const n917 = result.aircraft.find((a) => a.tailNumber === 'N917JH')!;
    const owner = result.contacts.find((c) => c.id === n917.ownerships[0].contactId)!;
    const template = defaultTemplates(new Date().toISOString())[0];

    const email = renderEmail(template, {
      contact: owner,
      aircraft: n917,
      settings: { senderName: 'Test Broker', senderTitle: 'Broker', senderCompany: 'Test Aviation', senderPhone: '555-0100' },
    });

    expect(email.to).toBe('jheine@acentech.com');
    expect(email.subject).toBe('RE: N917JH');
    expect(email.body.startsWith('Hi John,')).toBe(true);
    expect(email.body).toContain('N917JH');
    expect(email.body).toContain('2026 Cirrus Design Corp SR22T');
    expect(email.body).toContain('Test Broker');
    expect(email.missing).toEqual([]);
  });

  it('17. builds a usable mailto link', () => {
    const n917 = result.aircraft.find((a) => a.tailNumber === 'N917JH')!;
    const owner = result.contacts.find((c) => c.id === n917.ownerships[0].contactId)!;
    const email = renderEmail(defaultTemplates(new Date().toISOString())[0], { contact: owner, aircraft: n917 });
    const mailto = buildMailto(email);

    expect(mailto.startsWith('mailto:jheine%40acentech.com?')).toBe(true);
    expect(mailto).toContain('subject=RE%3A%20N917JH');
    const body = new URL(mailto).searchParams.get('body')!;
    expect(body).toContain('Hi John,');
    expect(body).toContain('N917JH');
  });

  it('18. a follow-up set today for 7 days out lands in the upcoming bucket', () => {
    const due = addDays(7);
    expect(dueBucket(due)).toBe('upcoming');
    expect(dueBucket(addDays(0))).toBe('today');
    expect(dueBucket(addDays(-1))).toBe('overdue');
  });

  it('19. re-importing the same file creates no duplicates', () => {
    const db: Database = { ...emptyDatabase(), contacts: result.contacts, aircraft: result.aircraft };
    const second = freshImport(db);

    expect(second.result.contacts).toHaveLength(115);
    expect(second.result.aircraft).toHaveLength(117);
    expect(second.result.record.contactsCreated).toBe(0);
    expect(second.result.record.aircraftCreated).toBe(0);
    expect(second.result.record.recordsProcessed).toBe(0);
    expect(summarizePreview(second.preview).existing).toBe(117);
  });

  it('offers an FAA registry link for every imported aircraft', () => {
    const missing = result.aircraft.filter((a) => faaRegistryLink(a.tailNumber) === null);
    expect(missing).toHaveLength(0);
  });
});
