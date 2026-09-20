/**
 * Global search.
 *
 * One index over everything, built from a handful of searchable strings per
 * record. Queries are tokenised and every token must match somewhere (AND), so
 * "heine sr22" narrows instead of widening. Tail numbers are matched on their
 * normalised form, which is why "n917jh", "917JH" and "N917JH" all land.
 */
import type { Aircraft, Contact, Database, InsurancePolicy, Opportunity } from '../data/types';
import { normalizeTail } from './tail';
import { normalizePhone } from './phone';
import { displayName } from './names';
import { policyState, sortByUrgency } from './insurance';

export type ResultKind = 'contact' | 'aircraft' | 'opportunity';

export interface SearchResult {
  kind: ResultKind;
  id: string;
  title: string;
  subtitle: string;
  detail: string;
  score: number;
}

interface IndexEntry {
  kind: ResultKind;
  id: string;
  title: string;
  subtitle: string;
  detail: string;
  /** Lowercase haystack of every searchable value. */
  haystack: string;
  /** Values a query should match from the start for a big score bump. */
  prefixes: string[];
}

function norm(v: unknown): string {
  return String(v ?? '').toLowerCase().trim();
}

/**
 * Policies are not a result kind of their own — nobody searches for a policy,
 * they search for the aircraft or the person it belongs to. The policy's text
 * is folded into both, so "Global Aerospace" lands on the aircraft it covers.
 */
type SearchableDb = Pick<Database, 'contacts' | 'aircraft' | 'opportunities'> &
  Partial<Pick<Database, 'policies'>>;

function policyText(policies: InsurancePolicy[]): string {
  return policies
    .map((p) => [p.carrier, p.policyNumber, p.brokerAgent, p.renewalNotes, p.notes].filter(Boolean).join(' '))
    .join(' ');
}

export function buildIndex(db: SearchableDb): IndexEntry[] {
  const entries: IndexEntry[] = [];
  const contactsById = new Map(db.contacts.map((c) => [c.id, c]));
  const policies = db.policies ?? [];

  for (const c of db.contacts) {
    const name = displayName(c);
    const location = [c.city, c.state].filter(Boolean).join(', ');
    const ownedAircraft = db.aircraft.filter((a) => a.ownerships.some((o) => o.contactId === c.id && !o.endedAt));
    const owned = ownedAircraft
      .map((a) => `${a.tailNumber} ${normalizeTail(a.tailNumber)} ${a.year} ${a.make} ${a.model}`)
      .join(' ');

    // A search for a person should answer "what do they fly?" without a tap.
    // Fall back to the pipeline status only when there is no aircraft to show.
    const tails = ownedAircraft.map((a) => a.tailNumber);
    const detail =
      tails.length > 0
        ? tails.length > 3
          ? `${tails.slice(0, 3).join(', ')} +${tails.length - 3} more`
          : tails.join(', ')
        : [c.status, c.prospectStatus].filter(Boolean).join(' · ');

    entries.push({
      kind: 'contact',
      id: c.id,
      title: name,
      subtitle: [c.company, location].filter(Boolean).join(' · '),
      detail,
      haystack: norm(
        [
          name, c.rawName, c.company, c.email, c.phone, normalizePhone(c.phone), c.address, c.city,
          c.state, c.zip, c.notes, c.status, c.prospectStatus, owned,
          // What they want is as searchable as what they have.
          c.intent?.wantedAircraft, c.intent?.budget, c.intent?.mission, c.intent?.timeline,
          c.intent?.sellingNotes, c.intent?.insuranceNotes,
          policyText(policies.filter((p) => p.contactId === c.id)),
        ].join(' '),
      ),
      prefixes: [norm(name), norm(c.lastName), norm(c.firstName), norm(c.company), norm(c.email)],
    });
  }

  for (const a of db.aircraft) {
    const ownerId = a.ownerships.find((o) => !o.endedAt)?.contactId;
    const owner = ownerId ? contactsById.get(ownerId) : undefined;
    const ownerName = owner ? displayName(owner) : '';

    // A result that says a renewal is due answers the question before the
    // user has to open the record.
    const urgent = policies
      .filter((p) => p.aircraftId === a.id)
      .sort(sortByUrgency)
      .map((p) => policyState(p))
      .find((state) => state.needsAttention);

    entries.push({
      kind: 'aircraft',
      id: a.id,
      title: a.tailNumber,
      subtitle: [a.year, a.make, a.model].filter(Boolean).join(' '),
      detail: [ownerName ? `Owner: ${ownerName}` : a.status, urgent?.countdown].filter(Boolean).join(' · '),
      haystack: norm(
        [
          a.tailNumber, normalizeTail(a.tailNumber), a.year, a.make, a.model, a.serial, a.status,
          a.notes, ownerName, owner?.city, owner?.state, a.listingStatus, a.baseAirport,
          policyText(policies.filter((p) => p.aircraftId === a.id)),
        ].join(' '),
      ),
      prefixes: [norm(a.tailNumber), normalizeTail(a.tailNumber).toLowerCase(), norm(a.model), norm(a.make)],
    });
  }

  for (const o of db.opportunities) {
    const contact = o.contactId ? contactsById.get(o.contactId) : undefined;
    const aircraft = o.aircraftId ? db.aircraft.find((a) => a.id === o.aircraftId) : undefined;
    entries.push({
      kind: 'opportunity',
      id: o.id,
      title: o.title || `${o.type} opportunity`,
      subtitle: [contact ? displayName(contact) : '', aircraft?.tailNumber].filter(Boolean).join(' · '),
      detail: `${o.type} · ${o.status}`,
      haystack: norm(
        [
          o.title, o.type, o.status, o.notes, o.nextAction, contact ? displayName(contact) : '',
          aircraft?.tailNumber, aircraft ? normalizeTail(aircraft.tailNumber) : '', o.estimatedValue,
          policyText(policies.filter((p) => p.opportunityId === o.id)),
        ].join(' '),
      ),
      prefixes: [norm(o.title), norm(o.type)],
    });
  }

  return entries;
}

export function tokenize(query: string): string[] {
  return query.toLowerCase().split(/\s+/).map((t) => t.trim()).filter(Boolean);
}

/** A tail-shaped query also matches on its normalised form. */
function expand(token: string): string[] {
  const out = [token];
  const tail = normalizeTail(token).toLowerCase();
  if (tail && tail !== token) out.push(tail);
  const digits = token.replace(/\D/g, '');
  if (digits.length >= 7) out.push(digits);
  return out;
}

export function searchIndex(entries: IndexEntry[], query: string, limit = 50): SearchResult[] {
  const tokens = tokenize(query);
  if (tokens.length === 0) return [];

  const results: SearchResult[] = [];
  for (const entry of entries) {
    let score = 0;
    let matchedAll = true;
    for (const token of tokens) {
      const variants = expand(token);
      const hit = variants.some((v) => entry.haystack.includes(v));
      if (!hit) {
        matchedAll = false;
        break;
      }
      if (variants.some((v) => entry.prefixes.some((p) => p === v))) score += 12;
      else if (variants.some((v) => entry.prefixes.some((p) => p.startsWith(v)))) score += 6;
      else if (variants.some((v) => new RegExp(`\\b${escapeRe(v)}`).test(entry.haystack))) score += 3;
      else score += 1;
    }
    if (!matchedAll) continue;
    // A short query should surface aircraft before the long tail of notes.
    if (entry.kind === 'aircraft') score += 1;
    results.push({ kind: entry.kind, id: entry.id, title: entry.title, subtitle: entry.subtitle, detail: entry.detail, score });
  }

  results.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
  return results.slice(0, limit);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function search(db: SearchableDb, query: string, limit?: number): SearchResult[] {
  return searchIndex(buildIndex(db), query, limit);
}

export type { Contact, Aircraft, Opportunity };
