/** Records for tests, with every field filled in. */
import type { Contact } from '../data/types';

const T = '2026-10-01T12:00:00.000Z';

/** A contact with every field the app has filled in. */
export function fullContact(i: number): Contact {
  return {
    id: `con_${i}`, firstName: `First${i}`, lastName: `Last${i}`, rawName: `LAST${i} FIRST${i} TRUSTEE`,
    middleName: `Middle${i}`, suffix: 'Jr', role: 'Trustee', company: `Company ${i} LLC`, email: `p${i}@example.com`,
    phone: '8055551234', address: `${i} Hangar Way`, address2: 'Suite 2', city: 'Santa Barbara', state: 'CA', zip: '93117',
    country: 'USA', contactTypes: ['Aircraft Owner', 'Insurance'], status: 'Active Client', prospectStatus: 'Engaged',
    notes: `Notes about ${i}, with a comma and "quotes"\nand a second line`, custom: { 'Fleet size': `${i}`, Referral: 'Show' },
    intent: {
      selling: 'Maybe', sellingNotes: `Selling notes ${i}`, buying: 'Actively', wantedAircraft: 'SR22T G6',
      budget: 'Under 1.2M', mission: 'Family trips', timeline: 'Spring', insurance: 'Actively', insuranceNotes: `Ins notes ${i}`,
    },
    nameConfidence: 'medium', needsReview: true, source: 'FAA import', createdAt: T, updatedAt: T, lastContactedAt: T,
  };
}
