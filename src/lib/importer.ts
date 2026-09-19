/**
 * Turns a mapped CSV into contacts and aircraft.
 *
 * Two phases, deliberately separated: `buildPreview` is pure and side-effect
 * free so the user can look at exactly what will happen, and `applyImport`
 * performs only what the preview promised.
 */
import type {
  Activity,
  Aircraft,
  Contact,
  Database,
  ImportRecord,
} from '../data/types';
import { newId, nowIso } from './id';
import { formatTail, normalizeTail } from './tail';
import { isValidEmail, normalizeEmail, normalizePhone } from './phone';
import { parseOwnerName, type NameOrder } from './names';
import { AircraftIndex, ContactIndex, diffFields, type FieldChange } from './matching';
import type { ColumnMapping, TargetField } from './mapping';

export type RowStatus = 'NEW' | 'EXISTING' | 'DUPLICATE' | 'REVIEW';
export type RowFlag = 'MISSING EMAIL' | 'MISSING OWNER' | 'MISSING TAIL' | 'INVALID EMAIL' | 'NAME UNCERTAIN';
export type RowAction = 'create' | 'update' | 'skip';

export interface ExtractedRow {
  values: Partial<Record<TargetField, string>>;
  custom: Record<string, string>;
}

export interface PreviewRow {
  index: number;
  raw: string[];
  extracted: ExtractedRow;
  ownerDisplay: string;
  aircraftDisplay: string;
  tailDisplay: string;
  email: string;
  phone: string;
  location: string;
  status: RowStatus;
  flags: RowFlag[];
  action: RowAction;
  selected: boolean;
  matchedContactId: string | null;
  matchedContactReason: string;
  matchedAircraftId: string | null;
  contactChanges: FieldChange[];
  aircraftChanges: FieldChange[];
  /** Index of the earlier row in this file that this one duplicates. */
  duplicateOfRow: number | null;
  /** An earlier row in this file names the same person (two aircraft, one owner). */
  sameOwnerAsRow: number | null;
}

export interface PreviewOptions {
  nameOrder: NameOrder;
}

const CONTACT_LABELS: Record<string, string> = {
  firstName: 'First name',
  lastName: 'Last name',
  company: 'Company',
  email: 'Email',
  phone: 'Phone',
  address: 'Address',
  address2: 'Address 2',
  city: 'City',
  state: 'State',
  zip: 'ZIP',
  country: 'Country',
};

const AIRCRAFT_LABELS: Record<string, string> = {
  tailNumber: 'Tail number',
  year: 'Year',
  make: 'Make',
  model: 'Model',
  serial: 'Serial',
  status: 'Status',
};

export function extractRow(row: string[], mappings: ColumnMapping[]): ExtractedRow {
  const values: Partial<Record<TargetField, string>> = {};
  const custom: Record<string, string> = {};
  for (const m of mappings) {
    const value = (row[m.index] ?? '').trim();
    if (m.field === 'ignore') continue;
    if (m.field === 'custom') {
      if (value) custom[m.header] = value;
      continue;
    }
    if (!value) continue;
    // If two columns map to the same field, keep the first non-empty one.
    if (!values[m.field]) values[m.field] = value;
  }
  return { values, custom };
}

function personFrom(extracted: ExtractedRow, order: NameOrder) {
  const { values } = extracted;
  const registrantType = (values.registrantType ?? '').toLowerCase();
  const explicitFirst = values.firstName ?? '';
  const explicitLast = values.lastName ?? '';
  const rawName = values.ownerName ?? [explicitFirst, explicitLast].filter(Boolean).join(' ');

  if (explicitFirst || explicitLast) {
    return {
      firstName: explicitFirst,
      lastName: explicitLast,
      middleName: '',
      suffix: '',
      role: '',
      company: values.company ?? '',
      rawName: rawName || [explicitFirst, explicitLast].filter(Boolean).join(' '),
      confidence: 'high' as const,
      needsReview: false,
    };
  }

  const parsed = parseOwnerName(rawName, order);
  // A registrant type that isn't a person overrides the name heuristics.
  const typeSaysOrg = registrantType !== '' && !/individual|co[- ]?owner|person/.test(registrantType);
  const isOrg = parsed.isOrganization || typeSaysOrg;

  return {
    firstName: isOrg ? '' : parsed.firstName,
    lastName: isOrg ? '' : parsed.lastName,
    middleName: isOrg ? '' : parsed.middleName,
    suffix: isOrg ? '' : parsed.suffix,
    role: parsed.role,
    company: values.company ?? (isOrg ? parsed.raw : ''),
    rawName: parsed.raw,
    confidence: isOrg ? ('organization' as const) : parsed.confidence,
    needsReview: isOrg ? false : parsed.needsReview,
  };
}

export function buildPreview(
  rows: string[][],
  mappings: ColumnMapping[],
  db: Pick<Database, 'contacts' | 'aircraft'>,
  options: PreviewOptions,
): PreviewRow[] {
  const contactIndex = new ContactIndex(db.contacts);
  const aircraftIndex = new AircraftIndex(db.aircraft);

  const seenTails = new Map<string, number>();
  const seenPeople = new Map<string, number>();
  // Rows that will create a contact are indexed as they are previewed, so a
  // file listing two aircraft for one owner shows the second row as a match
  // rather than promising a second contact.
  const pendingContacts = new ContactIndex([]);

  return rows.map((raw, index) => {
    const extracted = extractRow(raw, mappings);
    const v = extracted.values;
    const person = personFrom(extracted, options.nameOrder);

    const tailKey = normalizeTail(v.tailNumber);
    const tailDisplay = formatTail(v.tailNumber);
    const email = normalizeEmail(v.email);
    const phone = v.phone ?? '';

    const flags: RowFlag[] = [];
    if (!email) flags.push('MISSING EMAIL');
    else if (!isValidEmail(email)) flags.push('INVALID EMAIL');
    if (!person.rawName && !person.company) flags.push('MISSING OWNER');
    if (!tailKey) flags.push('MISSING TAIL');
    if (person.needsReview) flags.push('NAME UNCERTAIN');

    const aircraftMatch = aircraftIndex.find(v.tailNumber);
    const contactMatch = contactIndex.find({
      email,
      phone,
      firstName: person.firstName,
      lastName: person.lastName,
      company: person.company,
      address: v.address,
      zip: v.zip,
    });

    const aircraftChanges = aircraftMatch.aircraft
      ? diffFields(
          aircraftMatch.aircraft as unknown as Record<string, unknown>,
          { tailNumber: tailDisplay, year: v.year, make: v.make, model: v.model, serial: v.aircraftSerial },
          AIRCRAFT_LABELS,
        )
      : [];

    const contactChanges = contactMatch.contact
      ? diffFields(
          contactMatch.contact as unknown as Record<string, unknown>,
          {
            firstName: person.firstName,
            lastName: person.lastName,
            company: person.company,
            email,
            phone: normalizePhone(phone) ? phone : '',
            address: v.address,
            address2: v.address2,
            city: v.city,
            state: v.state,
            zip: v.zip,
            country: v.country,
          },
          CONTACT_LABELS,
        )
      : [];

    // Duplicate *within this file*: same aircraft, or the same person twice
    // when the row carries no aircraft at all.
    let duplicateOfRow: number | null = null;
    if (tailKey) {
      const prior = seenTails.get(tailKey);
      if (prior !== undefined) duplicateOfRow = prior;
      else seenTails.set(tailKey, index);
    } else {
      const personKey = email || `${person.firstName}|${person.lastName}|${v.zip ?? ''}`.toLowerCase();
      if (personKey && personKey !== '||') {
        const prior = seenPeople.get(personKey);
        if (prior !== undefined) duplicateOfRow = prior;
        else seenPeople.set(personKey, index);
      }
    }

    let sameOwnerAsRow: number | null = null;
    if (!contactMatch.contact) {
      const pending = pendingContacts.find({
        email,
        phone,
        firstName: person.firstName,
        lastName: person.lastName,
        company: person.company,
        address: v.address,
        zip: v.zip,
      });
      if (pending.contact) {
        sameOwnerAsRow = Number(pending.contact.id.slice(4));
      } else if (person.rawName || person.company || email || phone) {
        pendingContacts.add({
          id: `row:${index}`,
          firstName: person.firstName,
          lastName: person.lastName,
          company: person.company,
          email,
          phone,
          address: v.address ?? '',
          zip: v.zip ?? '',
        } as unknown as Contact);
      }
    }

    const matchedSomething = Boolean(aircraftMatch.aircraft || contactMatch.contact);
    const conflicting = [...aircraftChanges, ...contactChanges].some((c) => !c.isNewInformation);

    let status: RowStatus;
    if (duplicateOfRow !== null) status = 'DUPLICATE';
    else if (conflicting || person.needsReview) status = 'REVIEW';
    else if (matchedSomething) status = 'EXISTING';
    else status = 'NEW';

    let action: RowAction;
    if (status === 'DUPLICATE') action = 'skip';
    else if (conflicting) action = 'skip'; // an explicit decision is required
    else if (matchedSomething) action = aircraftChanges.length + contactChanges.length > 0 ? 'update' : 'skip';
    else action = 'create';

    const ownerDisplay =
      [person.firstName, person.lastName].filter(Boolean).join(' ') || person.company || person.rawName || '—';
    const aircraftDisplay = [v.year, v.make, v.model].filter(Boolean).join(' ') || '—';
    const location = [v.city, v.state].filter(Boolean).join(', ');

    return {
      index,
      raw,
      extracted,
      ownerDisplay,
      aircraftDisplay,
      tailDisplay,
      email,
      phone,
      location,
      status,
      flags,
      action,
      selected: status !== 'DUPLICATE',
      matchedContactId: contactMatch.contact?.id ?? null,
      matchedContactReason: contactMatch.reason,
      matchedAircraftId: aircraftMatch.aircraft?.id ?? null,
      contactChanges,
      aircraftChanges,
      duplicateOfRow,
      sameOwnerAsRow,
    };
  });
}

export interface ApplyResult {
  contacts: Contact[];
  aircraft: Aircraft[];
  activities: Activity[];
  record: ImportRecord;
}

/**
 * Applies the preview to copies of the current records. Returns new arrays —
 * the caller commits them, so a failure part-way through changes nothing.
 */
export function applyImport(
  previewRows: PreviewRow[],
  db: Pick<Database, 'contacts' | 'aircraft'>,
  options: { filename: string; nameOrder: NameOrder; source?: string },
): ApplyResult {
  const contacts = db.contacts.map((c) => ({ ...c }));
  const aircraft = db.aircraft.map((a) => ({ ...a, ownerships: a.ownerships.map((o) => ({ ...o })) }));
  const activities: Activity[] = [];

  const contactIndex = new ContactIndex(contacts);
  const aircraftIndex = new AircraftIndex(aircraft);
  const contactById = new Map(contacts.map((c) => [c.id, c]));
  const aircraftById = new Map(aircraft.map((a) => [a.id, a]));

  const now = nowIso();
  const importId = newId('imp');
  const source = options.source ?? options.filename;

  const record: ImportRecord = {
    id: importId,
    filename: options.filename,
    date: now,
    recordsProcessed: 0,
    contactsCreated: 0,
    contactsMatched: 0,
    contactsUpdated: 0,
    aircraftCreated: 0,
    aircraftUpdated: 0,
    duplicatesSkipped: 0,
    recordsNeedingReview: 0,
    recordsMissingEmail: 0,
    contactIds: [],
    aircraftIds: [],
    notes: [],
  };

  const touchedContacts = new Set<string>();
  const touchedAircraft = new Set<string>();

  for (const row of previewRows) {
    if (row.flags.includes('MISSING EMAIL')) record.recordsMissingEmail++;
    if (row.status === 'REVIEW') record.recordsNeedingReview++;
    if (!row.selected || row.action === 'skip') {
      if (row.status === 'DUPLICATE') record.duplicatesSkipped++;
      continue;
    }

    record.recordsProcessed++;
    const v = row.extracted.values;
    const person = personFrom(row.extracted, options.nameOrder);
    const email = normalizeEmail(v.email);

    // --- Contact -------------------------------------------------------
    let contact: Contact | null = null;
    const hasPerson = Boolean(person.rawName || person.company || email || v.phone);
    if (hasPerson) {
      const match = contactIndex.find({
        email,
        phone: v.phone,
        firstName: person.firstName,
        lastName: person.lastName,
        company: person.company,
        address: v.address,
        zip: v.zip,
      });
      if (match.contact) {
        contact = contactById.get(match.contact.id) ?? match.contact;
        record.contactsMatched++;
        const before = JSON.stringify(contact);
        fillContact(contact, person, v, row.extracted.custom, source);
        contact.updatedAt = now;
        if (JSON.stringify(contact) !== before) record.contactsUpdated++;
      } else {
        contact = {
          id: newId('con'),
          firstName: person.firstName,
          lastName: person.lastName,
          rawName: person.rawName,
          middleName: person.middleName,
          suffix: person.suffix,
          role: person.role,
          company: person.company,
          email,
          phone: v.phone ?? '',
          address: v.address ?? '',
          address2: v.address2 ?? '',
          city: v.city ?? '',
          state: v.state ?? '',
          zip: v.zip ?? '',
          country: v.country ?? '',
          contactTypes: ['Aircraft Owner'],
          status: 'Prospect',
          prospectStatus: 'New',
          notes: v.contactNotes ?? '',
          custom: { ...row.extracted.custom },
          nameConfidence: person.confidence,
          needsReview: person.needsReview,
          source,
          createdAt: now,
          updatedAt: now,
        };
        contacts.push(contact);
        contactById.set(contact.id, contact);
        contactIndex.add(contact);
        record.contactsCreated++;
      }
      touchedContacts.add(contact.id);
    }

    // --- Aircraft ------------------------------------------------------
    const tailKey = normalizeTail(v.tailNumber);
    if (tailKey) {
      const match = aircraftIndex.find(v.tailNumber);
      if (match.aircraft) {
        const existing = aircraftById.get(match.aircraft.id) ?? match.aircraft;
        const before = JSON.stringify(existing);
        if (!existing.year && v.year) existing.year = v.year;
        if (!existing.make && v.make) existing.make = v.make;
        if (!existing.model && v.model) existing.model = v.model;
        if (!existing.serial && v.aircraftSerial) existing.serial = v.aircraftSerial;
        if (row.action === 'update') {
          if (v.year) existing.year = v.year;
          if (v.make) existing.make = v.make;
          if (v.model) existing.model = v.model;
          if (v.aircraftSerial) existing.serial = v.aircraftSerial;
        }
        for (const [k, val] of Object.entries(row.extracted.custom)) {
          if (!existing.custom[k]) existing.custom[k] = val;
        }
        if (contact) linkOwner(existing, contact.id, now);
        existing.updatedAt = now;
        if (JSON.stringify(existing) !== before) record.aircraftUpdated++;
        touchedAircraft.add(existing.id);
      } else {
        const created: Aircraft = {
          id: newId('acf'),
          tailNumber: formatTail(v.tailNumber),
          tailKey,
          year: v.year ?? '',
          make: v.make ?? '',
          model: v.model ?? '',
          serial: v.aircraftSerial ?? '',
          ownerships: contact ? [{ contactId: contact.id, startedAt: now }] : [],
          status: 'Unknown',
          notes: v.aircraftNotes ?? '',
          custom: { ...row.extracted.custom },
          source,
          createdAt: now,
          updatedAt: now,
        };
        aircraft.push(created);
        aircraftById.set(created.id, created);
        aircraftIndex.add(created);
        record.aircraftCreated++;
        touchedAircraft.add(created.id);
      }
    }

    const aircraftId = tailKey ? (aircraftIndex.find(v.tailNumber).aircraft?.id ?? null) : null;
    activities.push({
      id: newId('act'),
      contactId: contact?.id ?? null,
      aircraftId,
      opportunityId: null,
      type: 'Import',
      date: now,
      subject: `Imported from ${options.filename}`,
      notes: '',
      createdAt: now,
    });
  }

  record.contactIds = [...touchedContacts];
  record.aircraftIds = [...touchedAircraft];
  return { contacts, aircraft, activities, record };
}

/** Fill blanks on an existing contact; only overwrite when told to. */
function fillContact(
  contact: Contact,
  person: ReturnType<typeof personFrom>,
  v: Partial<Record<TargetField, string>>,
  custom: Record<string, string>,
  source: string,
): void {
  const fill = (key: keyof Contact, value: string | undefined) => {
    if (!value) return;
    if (!contact[key]) (contact as unknown as Record<string, unknown>)[key] = value;
  };
  fill('firstName', person.firstName);
  fill('lastName', person.lastName);
  fill('rawName', person.rawName);
  fill('company', person.company);
  fill('email', normalizeEmail(v.email));
  fill('phone', v.phone);
  fill('address', v.address);
  fill('address2', v.address2);
  fill('city', v.city);
  fill('state', v.state);
  fill('zip', v.zip);
  fill('country', v.country);
  fill('source', source);
  for (const [k, val] of Object.entries(custom)) {
    if (!contact.custom[k]) contact.custom[k] = val;
  }
}

/** Record a current owner without erasing whoever held the aircraft before. */
export function linkOwner(aircraft: Aircraft, contactId: string, at: string): void {
  const current = aircraft.ownerships.find((o) => !o.endedAt);
  if (current?.contactId === contactId) return;
  if (aircraft.ownerships.some((o) => o.contactId === contactId && !o.endedAt)) return;
  if (current) current.endedAt = at;
  aircraft.ownerships.unshift({ contactId, startedAt: at });
}

export function summarizePreview(rows: PreviewRow[]) {
  return {
    total: rows.length,
    selected: rows.filter((r) => r.selected && r.action !== 'skip').length,
    neu: rows.filter((r) => r.status === 'NEW').length,
    existing: rows.filter((r) => r.status === 'EXISTING').length,
    duplicate: rows.filter((r) => r.status === 'DUPLICATE').length,
    review: rows.filter((r) => r.status === 'REVIEW').length,
    missingEmail: rows.filter((r) => r.flags.includes('MISSING EMAIL')).length,
  };
}
