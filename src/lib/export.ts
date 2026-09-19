/** Export helpers. Everything the user put in, they can take out. */
import type { Aircraft, Contact, Database } from '../data/types';
import { toCsv } from './csv';
import { displayName } from './names';
import { formatPhone, formatZip } from './phone';

export function contactsCsv(db: Pick<Database, 'contacts' | 'aircraft'>): string {
  const headers = [
    'First name', 'Last name', 'Raw name', 'Company', 'Email', 'Phone', 'Address', 'Address 2',
    'City', 'State', 'ZIP', 'Status', 'Prospect status', 'Contact types', 'Aircraft', 'Notes',
    'Last contacted', 'Created', 'Updated',
  ];
  const rows = db.contacts.map((c) => {
    const tails = db.aircraft
      .filter((a) => a.ownerships.some((o) => o.contactId === c.id && !o.endedAt))
      .map((a) => a.tailNumber)
      .join(' ');
    return [
      c.firstName, c.lastName, c.rawName, c.company, c.email, formatPhone(c.phone), c.address, c.address2 ?? '',
      c.city, c.state, formatZip(c.zip), c.status, c.prospectStatus, c.contactTypes.join('; '), tails, c.notes,
      c.lastContactedAt ?? '', c.createdAt, c.updatedAt,
    ];
  });
  return toCsv(headers, rows);
}

export function aircraftCsv(db: Pick<Database, 'contacts' | 'aircraft'>): string {
  const byId = new Map(db.contacts.map((c) => [c.id, c]));
  const headers = [
    'Tail number', 'Year', 'Make', 'Model', 'Serial', 'Status', 'Owner', 'Owner email', 'Owner phone',
    'Asking price', 'Listing status', 'Listing URL', 'Notes', 'Created', 'Updated',
  ];
  const rows = db.aircraft.map((a) => {
    const ownerId = a.ownerships.find((o) => !o.endedAt)?.contactId;
    const owner = ownerId ? byId.get(ownerId) : undefined;
    return [
      a.tailNumber, a.year, a.make, a.model, a.serial ?? '', a.status,
      owner ? displayName(owner) : '', owner?.email ?? '', owner ? formatPhone(owner.phone) : '',
      a.askingPrice ?? '', a.listingStatus ?? '', a.listingUrl ?? '', a.notes, a.createdAt, a.updatedAt,
    ];
  });
  return toCsv(headers, rows);
}

export function opportunitiesCsv(db: Pick<Database, 'contacts' | 'aircraft' | 'opportunities'>): string {
  const contacts = new Map(db.contacts.map((c) => [c.id, c]));
  const aircraft = new Map(db.aircraft.map((a) => [a.id, a]));
  const headers = [
    'Title', 'Type', 'Status', 'Contact', 'Aircraft', 'Opened', 'Follow-up', 'Estimated value',
    'Carrier', 'Renewal date', 'Premium', 'Notes',
  ];
  const rows = db.opportunities.map((o) => [
    o.title, o.type, o.status,
    o.contactId ? displayName(contacts.get(o.contactId) ?? {}) : '',
    o.aircraftId ? (aircraft.get(o.aircraftId)?.tailNumber ?? '') : '',
    o.openedAt, o.followUpDate ?? '', o.estimatedValue ?? '',
    o.insurance?.carrier ?? '', o.insurance?.renewalDate ?? '', o.insurance?.premium ?? '', o.notes,
  ]);
  return toCsv(headers, rows);
}

/** The complete dataset, re-importable. File blobs are not included. */
export function fullJson(db: Database): string {
  return JSON.stringify({ ...db, exportedAt: new Date().toISOString(), app: 'AEROBOOK' }, null, 2);
}

export function parseFullJson(text: string): Database {
  const parsed = JSON.parse(text) as Database;
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.contacts)) {
    throw new Error('This file does not look like an AEROBOOK export.');
  }
  return parsed;
}

export function downloadText(filename: string, mime: string, text: string): void {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function exportFilename(kind: string, ext: string): string {
  const d = new Date();
  const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return `aerobook-${kind}-${stamp}.${ext}`;
}

export type { Contact, Aircraft };
