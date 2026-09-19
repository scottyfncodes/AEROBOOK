/**
 * Duplicate detection.
 *
 * Re-importing last month's owner list must not double the database, so every
 * incoming row is matched against what is already there before anything is
 * written. Aircraft match on the normalised tail; people match on email, then
 * phone, then name + address.
 */
import type { Aircraft, Contact } from '../data/types';
import { normalizeTail } from './tail';
import { normalizeEmail, normalizePhone, zip5 } from './phone';

export type ContactMatchReason = 'email' | 'phone' | 'name+address' | 'name+zip' | 'none';
export type AircraftMatchReason = 'tail' | 'none';

export interface ContactMatch {
  contact: Contact | null;
  reason: ContactMatchReason;
}

export interface AircraftMatch {
  aircraft: Aircraft | null;
  reason: AircraftMatchReason;
}

function nameKey(first: string, last: string): string {
  return `${(first ?? '').trim().toLowerCase()}|${(last ?? '').trim().toLowerCase()}`;
}

function addressKey(address: string): string {
  return (address ?? '')
    .toLowerCase()
    .replace(/\b(street|st|avenue|ave|road|rd|drive|dr|lane|ln|court|ct|place|pl|boulevard|blvd|circle|cir|terrace|ter|way|highway|hwy|north|n|south|s|east|e|west|w)\b\.?/g, (m) => m[0])
    .replace(/[^a-z0-9]/g, '');
}

export interface ContactLike {
  email?: string;
  phone?: string;
  firstName?: string;
  lastName?: string;
  company?: string;
  address?: string;
  zip?: string;
}

/** Index built once per import run so matching stays O(1) per row. */
export class ContactIndex {
  private byEmail = new Map<string, Contact>();
  private byPhone = new Map<string, Contact>();
  private byNameAddress = new Map<string, Contact>();
  private byNameZip = new Map<string, Contact>();

  constructor(contacts: Contact[]) {
    for (const c of contacts) this.add(c);
  }

  add(c: Contact): void {
    const email = normalizeEmail(c.email);
    if (email && !this.byEmail.has(email)) this.byEmail.set(email, c);
    const phone = normalizePhone(c.phone);
    if (phone.length >= 10 && !this.byPhone.has(phone)) this.byPhone.set(phone, c);
    const name = nameKey(c.firstName, c.lastName);
    const addr = addressKey(c.address);
    if (name !== '|' && addr) {
      const key = `${name}|${addr}`;
      if (!this.byNameAddress.has(key)) this.byNameAddress.set(key, c);
    }
    const z = zip5(c.zip);
    if (name !== '|' && z) {
      const key = `${name}|${z}`;
      if (!this.byNameZip.has(key)) this.byNameZip.set(key, c);
    }
  }

  find(input: ContactLike): ContactMatch {
    const email = normalizeEmail(input.email);
    if (email) {
      const hit = this.byEmail.get(email);
      if (hit) return { contact: hit, reason: 'email' };
    }
    const phone = normalizePhone(input.phone);
    if (phone.length >= 10) {
      const hit = this.byPhone.get(phone);
      if (hit) return { contact: hit, reason: 'phone' };
    }
    const name = nameKey(input.firstName ?? '', input.lastName ?? '');
    if (name !== '|') {
      const addr = addressKey(input.address ?? '');
      if (addr) {
        const hit = this.byNameAddress.get(`${name}|${addr}`);
        if (hit) return { contact: hit, reason: 'name+address' };
      }
      const z = zip5(input.zip);
      if (z) {
        const hit = this.byNameZip.get(`${name}|${z}`);
        if (hit) return { contact: hit, reason: 'name+zip' };
      }
    }
    return { contact: null, reason: 'none' };
  }
}

export class AircraftIndex {
  private byTail = new Map<string, Aircraft>();

  constructor(aircraft: Aircraft[]) {
    for (const a of aircraft) this.add(a);
  }

  add(a: Aircraft): void {
    const key = a.tailKey || normalizeTail(a.tailNumber);
    if (key && !this.byTail.has(key)) this.byTail.set(key, a);
  }

  find(tail: string | null | undefined): AircraftMatch {
    const key = normalizeTail(tail);
    if (!key) return { aircraft: null, reason: 'none' };
    const hit = this.byTail.get(key);
    return hit ? { aircraft: hit, reason: 'tail' } : { aircraft: null, reason: 'none' };
  }
}

export interface FieldChange {
  field: string;
  label: string;
  existing: string;
  incoming: string;
  /** The existing record had nothing here, so filling it in is safe. */
  isNewInformation: boolean;
}

/**
 * Compare an existing record with incoming values. Only non-empty incoming
 * values that actually differ are reported, so "UPDATE" never means "blank
 * out everything the CSV didn't include".
 */
export function diffFields(
  existing: Record<string, unknown>,
  incoming: Record<string, string | undefined>,
  labels: Record<string, string>,
): FieldChange[] {
  const changes: FieldChange[] = [];
  for (const [field, rawIncoming] of Object.entries(incoming)) {
    const incomingValue = (rawIncoming ?? '').trim();
    if (!incomingValue) continue;
    const existingValue = String(existing[field] ?? '').trim();
    if (existingValue.toLowerCase() === incomingValue.toLowerCase()) continue;
    changes.push({
      field,
      label: labels[field] ?? field,
      existing: existingValue,
      incoming: incomingValue,
      isNewInformation: existingValue === '',
    });
  }
  return changes;
}
