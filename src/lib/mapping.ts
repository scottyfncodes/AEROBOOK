/**
 * Maps arbitrary CSV headers onto AEROBOOK fields.
 *
 * Detection is a scored match against synonym lists — exact header match beats
 * a word match, which beats a substring match — so a column called "N-Number"
 * and one called "Tail" both land on the tail field without hard-coding a
 * single vendor's export format. Anything unrecognised is kept as custom data;
 * nothing is thrown away silently.
 */

export type TargetField =
  | 'ignore'
  | 'custom'
  | 'tailNumber'
  | 'year'
  | 'make'
  | 'model'
  | 'aircraftSerial'
  | 'aircraftStatus'
  | 'aircraftNotes'
  | 'ownerName'
  | 'firstName'
  | 'lastName'
  | 'company'
  | 'email'
  | 'phone'
  | 'address'
  | 'address2'
  | 'city'
  | 'state'
  | 'zip'
  | 'country'
  | 'registrantType'
  | 'contactNotes';

export interface FieldDef {
  field: TargetField;
  label: string;
  group: 'Aircraft' | 'Contact' | 'Other';
  /** Header spellings seen in the wild, lowercase. */
  synonyms: string[];
}

export const FIELD_DEFS: FieldDef[] = [
  { field: 'tailNumber', label: 'Tail number', group: 'Aircraft', synonyms: ['tail', 'tail number', 'tailnumber', 'tail no', 'tail #', 'n number', 'n-number', 'nnumber', 'registration', 'reg', 'reg number', 'aircraft id', 'ident'] },
  { field: 'year', label: 'Year', group: 'Aircraft', synonyms: ['year', 'yr', 'year mfr', 'year manufactured', 'model year', 'mfr year'] },
  { field: 'make', label: 'Make', group: 'Aircraft', synonyms: ['make', 'manufacturer', 'mfr', 'mfr name', 'aircraft make', 'brand'] },
  { field: 'model', label: 'Model', group: 'Aircraft', synonyms: ['model', 'aircraft model', 'model name', 'type', 'aircraft type'] },
  { field: 'aircraftSerial', label: 'Serial number', group: 'Aircraft', synonyms: ['serial', 'serial number', 'serial no', 'sn', 's/n', 'msn'] },
  { field: 'aircraftStatus', label: 'Aircraft status', group: 'Aircraft', synonyms: ['aircraft status', 'status'] },
  { field: 'aircraftNotes', label: 'Aircraft notes', group: 'Aircraft', synonyms: ['aircraft notes', 'aircraft comments'] },

  { field: 'ownerName', label: 'Owner name (full)', group: 'Contact', synonyms: ['owner', 'owner name', 'registered owner', 'registrant', 'registrant name', 'name', 'full name', 'contact', 'contact name'] },
  { field: 'firstName', label: 'First name', group: 'Contact', synonyms: ['first', 'first name', 'firstname', 'given name', 'fname'] },
  { field: 'lastName', label: 'Last name', group: 'Contact', synonyms: ['last', 'last name', 'lastname', 'surname', 'family name', 'lname'] },
  { field: 'company', label: 'Company', group: 'Contact', synonyms: ['company', 'business', 'organization', 'organisation', 'business name', 'employer', 'dba'] },
  { field: 'email', label: 'Email', group: 'Contact', synonyms: ['email', 'e-mail', 'email address', 'mail', 'owner email', 'contact email'] },
  { field: 'phone', label: 'Phone', group: 'Contact', synonyms: ['phone', 'phone number', 'telephone', 'tel', 'mobile', 'cell', 'cell phone', 'primary phone', 'owner phone'] },
  { field: 'address', label: 'Address', group: 'Contact', synonyms: ['address', 'street', 'street address', 'address 1', 'address1', 'mailing address', 'addr'] },
  { field: 'address2', label: 'Address line 2', group: 'Contact', synonyms: ['street 2', 'address 2', 'address2', 'suite', 'unit', 'apt'] },
  { field: 'city', label: 'City', group: 'Contact', synonyms: ['city', 'town', 'locality'] },
  { field: 'state', label: 'State', group: 'Contact', synonyms: ['state', 'st', 'province', 'region'] },
  { field: 'zip', label: 'ZIP', group: 'Contact', synonyms: ['zip', 'zip code', 'zipcode', 'postal', 'postal code', 'post code'] },
  { field: 'country', label: 'Country', group: 'Contact', synonyms: ['country', 'nation'] },
  { field: 'contactNotes', label: 'Contact notes', group: 'Contact', synonyms: ['notes', 'note', 'comments', 'remarks'] },

  { field: 'registrantType', label: 'Registrant type', group: 'Other', synonyms: ['registrant type', 'registrant', 'owner type', 'type of registrant', 'reg type'] },
];

export const FIELD_LABELS: Record<TargetField, string> = {
  ignore: 'Ignore this column',
  custom: 'Keep as custom data',
  ...Object.fromEntries(FIELD_DEFS.map((d) => [d.field, d.label])),
} as Record<TargetField, string>;

export interface ColumnMapping {
  header: string;
  index: number;
  field: TargetField;
  /** 0–1. Below CONFIDENT_AT the UI asks the user to confirm. */
  confidence: number;
  detected: TargetField;
}

export const CONFIDENT_AT = 0.7;

function normalizeHeader(h: string): string {
  return h.toLowerCase().replace(/[_\-.]+/g, ' ').replace(/[^a-z0-9 #/]/g, ' ').replace(/\s+/g, ' ').trim();
}

function scoreHeader(header: string, def: FieldDef): number {
  const h = normalizeHeader(header);
  if (!h) return 0;
  let best = 0;
  for (const syn of def.synonyms) {
    const s = normalizeHeader(syn);
    if (h === s) return 1;
    // Whole-word containment: "owner email address" contains "email".
    const words = h.split(' ');
    if (words.includes(s)) best = Math.max(best, 0.85);
    else if (s.includes(' ') && h.includes(s)) best = Math.max(best, 0.8);
    else if (h.startsWith(`${s} `) || h.endsWith(` ${s}`)) best = Math.max(best, 0.75);
    else if (s.length >= 4 && h.includes(s)) best = Math.max(best, 0.55);
  }
  return best;
}

/**
 * Detect a mapping for every column. Each field is claimed by at most one
 * column (the best-scoring one); later duplicates fall through to custom data.
 */
export function detectMappings(headers: string[]): ColumnMapping[] {
  const candidates: { index: number; field: TargetField; score: number }[] = [];
  headers.forEach((header, index) => {
    for (const def of FIELD_DEFS) {
      const score = scoreHeader(header, def);
      if (score > 0) candidates.push({ index, field: def.field, score });
    }
  });
  candidates.sort((a, b) => b.score - a.score || a.index - b.index);

  // A column's runner-up field is only accepted if it scores nearly as well as
  // its best. "Owner Email" losing `email` to a plainer column must not make it
  // an owner-name column; it becomes custom data instead.
  const bestByIndex = new Map<number, number>();
  for (const c of candidates) {
    bestByIndex.set(c.index, Math.max(bestByIndex.get(c.index) ?? 0, c.score));
  }

  const takenField = new Set<TargetField>();
  const takenIndex = new Map<number, { field: TargetField; score: number }>();
  for (const c of candidates) {
    if (takenField.has(c.field) || takenIndex.has(c.index)) continue;
    if (c.score < 0.9 * (bestByIndex.get(c.index) ?? c.score)) continue;
    takenField.add(c.field);
    takenIndex.set(c.index, { field: c.field, score: c.score });
  }

  return headers.map((header, index) => {
    const hit = takenIndex.get(index);
    const field: TargetField = hit ? hit.field : 'custom';
    return { header, index, field, detected: field, confidence: hit ? hit.score : 0 };
  });
}

/** A mapping is usable when we can identify either an aircraft or a person. */
export function mappingIsUsable(mappings: ColumnMapping[]): boolean {
  const fields = new Set(mappings.map((m) => m.field));
  const hasAircraft = fields.has('tailNumber');
  const hasPerson = fields.has('ownerName') || fields.has('lastName') || fields.has('email') || fields.has('company');
  return hasAircraft || hasPerson;
}

export function mappingIssues(mappings: ColumnMapping[]): string[] {
  const issues: string[] = [];
  const fields = new Set(mappings.map((m) => m.field));
  if (!fields.has('tailNumber')) issues.push('No tail-number column. Aircraft records will not be created.');
  if (!fields.has('ownerName') && !fields.has('lastName') && !fields.has('company')) {
    issues.push('No owner-name column. Contacts will be created from email only where available.');
  }
  if (!fields.has('email') && !fields.has('phone')) {
    issues.push('No email or phone column. Imported contacts will have no way to reach them.');
  }
  return issues;
}
