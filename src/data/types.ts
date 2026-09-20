/** AEROBOOK data model. Plain JSON-serialisable records with stable string ids. */

export const CONTACT_STATUSES = ['Prospect', 'Lead', 'Active Client', 'Past Client', 'Other'] as const;
export type ContactStatus = (typeof CONTACT_STATUSES)[number];

export const CONTACT_TYPES = ['Aircraft Owner', 'Insurance', 'Brokerage', 'Referral', 'Vendor', 'Other'] as const;
export type ContactType = (typeof CONTACT_TYPES)[number];

export const AIRCRAFT_STATUSES = ['Owned', 'For Sale', 'Purchase Prospect', 'Sold', 'Unknown', 'Other'] as const;
export type AircraftStatus = (typeof AIRCRAFT_STATUSES)[number];

export const PROSPECT_STATUSES = ['New', 'Contacted', 'Follow-Up', 'Engaged', 'Quote', 'Client', 'Closed', 'Not Interested'] as const;
export type ProspectStatus = (typeof PROSPECT_STATUSES)[number];

export const OPPORTUNITY_TYPES = [
  'Insurance',
  'Aircraft Sale',
  'Aircraft Purchase',
  'Sale + Insurance',
  'Purchase + Insurance',
  'Other',
] as const;
export type OpportunityType = (typeof OPPORTUNITY_TYPES)[number];

/** The pipeline, in order. Won, Lost and Future are the ways out of it. */
export const OPPORTUNITY_STATUSES = [
  'Lead',
  'Contacted',
  'Interested',
  'Quoting',
  'Negotiating',
  'Won',
  'Lost',
  'Future',
] as const;
export type OpportunityStatus = (typeof OPPORTUNITY_STATUSES)[number];

/** Statuses that take an opportunity out of the working pipeline. */
export const CLOSED_OPPORTUNITY_STATUSES: OpportunityStatus[] = ['Won', 'Lost', 'Future'];

/** The stages an opportunity moves forward through, for the stage control. */
export const OPPORTUNITY_STAGES: OpportunityStatus[] = [
  'Lead',
  'Contacted',
  'Interested',
  'Quoting',
  'Negotiating',
];

export const ACTIVITY_TYPES = [
  'Email',
  'Call',
  'Text',
  'Meeting',
  'Note',
  'Quote',
  'Status Change',
  'Renewal',
  'Document',
  'Import',
  'Follow-Up',
  'Other',
] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number];

/**
 * How firmly someone wants something. A CRM that only records what a person
 * has cannot answer the question that actually matters, which is what they
 * want next.
 */
export const INTENT_LEVELS = ['Unknown', 'Not now', 'Maybe', 'Actively'] as const;
export type IntentLevel = (typeof INTENT_LEVELS)[number];

/** Where an insurance policy stands. Derived from dates unless set by hand. */
export const RENEWAL_STATUSES = [
  'Unknown',
  'Active',
  'Renewal upcoming',
  'Renewal in progress',
  'Quote received',
  'Bound',
  'Expired',
] as const;
export type RenewalStatus = (typeof RENEWAL_STATUSES)[number];

export const DOCUMENT_CATEGORIES = [
  'Insurance',
  'Aircraft',
  'Brokerage',
  'Contract',
  'Quote',
  'Registration',
  'Photos',
  'Other',
] as const;
export type DocumentCategory = (typeof DOCUMENT_CATEGORIES)[number];

export const FOLLOW_UP_PRIORITIES = ['Normal', 'High'] as const;
export type FollowUpPriority = (typeof FOLLOW_UP_PRIORITIES)[number];

export const NAME_CONFIDENCE = ['high', 'medium', 'low', 'organization'] as const;

export interface Contact {
  id: string;
  firstName: string;
  lastName: string;
  /** The owner string exactly as it arrived. Never overwritten by a parse. */
  rawName: string;
  middleName?: string;
  suffix?: string;
  /** "Trustee" and friends, stripped out of the name during parsing. */
  role?: string;
  company: string;
  email: string;
  phone: string;
  address: string;
  address2?: string;
  city: string;
  state: string;
  zip: string;
  country?: string;
  contactTypes: ContactType[];
  status: ContactStatus;
  prospectStatus: ProspectStatus;
  notes: string;
  /** Anything the importer could not map to a field, keyed by CSV header. */
  custom: Record<string, string>;
  /** What this person is actually in the market for. */
  intent?: ContactIntent;
  nameConfidence: (typeof NAME_CONFIDENCE)[number];
  needsReview: boolean;
  source?: string;
  createdAt: string;
  updatedAt: string;
  lastContactedAt?: string;
}

/**
 * What this person wants. Every field is optional and free-form on purpose —
 * a broker writes "something pressurised, under 2M, by next spring", not a
 * structured query.
 */
export interface ContactIntent {
  /** Might sell an aircraft they own. */
  selling: IntentLevel;
  sellingNotes?: string;
  /** Wants to buy. */
  buying: IntentLevel;
  wantedAircraft?: string;
  budget?: string;
  mission?: string;
  timeline?: string;
  /** Open to an insurance conversation. */
  insurance: IntentLevel;
  insuranceNotes?: string;
}

export function emptyIntent(): ContactIntent {
  return { selling: 'Unknown', buying: 'Unknown', insurance: 'Unknown' };
}

/** True when the user has actually recorded something about what they want. */
export function hasIntent(intent: ContactIntent | undefined): boolean {
  if (!intent) return false;
  return (
    intent.selling !== 'Unknown' ||
    intent.buying !== 'Unknown' ||
    intent.insurance !== 'Unknown' ||
    Boolean(
      intent.sellingNotes ||
        intent.wantedAircraft ||
        intent.budget ||
        intent.mission ||
        intent.timeline ||
        intent.insuranceNotes,
    )
  );
}

export interface AircraftOwnership {
  contactId: string;
  /** ISO date the ownership record starts, when known. */
  startedAt?: string;
  /** Set when the aircraft changes hands; the row is kept for history. */
  endedAt?: string;
}

export interface Aircraft {
  id: string;
  /** Display form, e.g. "N917JH". */
  tailNumber: string;
  /** Match key: uppercase, punctuation-free, leading N removed. */
  tailKey: string;
  year: string;
  make: string;
  model: string;
  serial?: string;
  /** Where it lives. An identifier, not a city — "KSBA", "SZP". */
  baseAirport?: string;
  /** Current owner first, previous owners retained with an endedAt. */
  ownerships: AircraftOwnership[];
  status: AircraftStatus;
  notes: string;
  /** Brokerage-side detail. All optional — most aircraft have none of it. */
  askingPrice?: string;
  targetPrice?: string;
  listingStatus?: string;
  listingUrl?: string;
  custom: Record<string, string>;
  source?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Opportunity {
  id: string;
  contactId: string | null;
  aircraftId: string | null;
  type: OpportunityType;
  status: OpportunityStatus;
  title: string;
  openedAt: string;
  estimatedValue?: string;
  /** One line: the very next thing that has to happen. */
  nextAction?: string;
  notes: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * An insurance policy is a record in its own right, not a note on a deal.
 * It hangs off the aircraft it covers and the person who holds it, so the
 * renewal is visible from both without an opportunity having to exist.
 * Every field is optional — an owner rarely volunteers all of it at once.
 */
export interface InsurancePolicy {
  id: string;
  aircraftId: string | null;
  contactId: string | null;
  /** Set when the renewal is being worked as a deal. */
  opportunityId: string | null;
  carrier: string;
  policyNumber: string;
  /** The agent or broker of record, when it is not the user. */
  brokerAgent: string;
  effectiveDate?: string;
  expirationDate?: string;
  premium: string;
  hullValue: string;
  liabilityLimit: string;
  deductible: string;
  /** 'Unknown' lets the expiration date speak for itself. */
  status: RenewalStatus;
  lastQuoteDate?: string;
  quotedPremium: string;
  renewalNotes: string;
  notes: string;
  createdAt: string;
  updatedAt: string;
}

export interface Activity {
  id: string;
  contactId: string | null;
  aircraftId: string | null;
  opportunityId: string | null;
  type: ActivityType;
  date: string;
  subject: string;
  notes: string;
  createdAt: string;
}

export interface FollowUp {
  id: string;
  contactId: string | null;
  aircraftId: string | null;
  opportunityId: string | null;
  insurancePolicyId?: string | null;
  dueDate: string;
  note: string;
  priority?: FollowUpPriority;
  completed: boolean;
  /** What actually happened, recorded when the follow-up is completed. */
  outcome?: string;
  completedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface EmailTemplate {
  id: string;
  name: string;
  subject: string;
  body: string;
  /** Built-in templates can be edited but not deleted. */
  builtIn?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface FileRecord {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  contactId: string | null;
  aircraftId: string | null;
  opportunityId: string | null;
  insurancePolicyId?: string | null;
  category?: DocumentCategory;
  createdAt: string;
}

export interface ImportRecord {
  id: string;
  filename: string;
  date: string;
  recordsProcessed: number;
  contactsCreated: number;
  contactsMatched: number;
  contactsUpdated: number;
  aircraftCreated: number;
  aircraftUpdated: number;
  duplicatesSkipped: number;
  recordsNeedingReview: number;
  recordsMissingEmail: number;
  /** Ids created or touched, so the import can be inspected afterwards. */
  contactIds: string[];
  aircraftIds: string[];
  notes: string[];
}

/** A place the user has actually been, saved from the Layover screen. */
export interface LayoverSpot {
  id: string;
  place: string;
  name: string;
  category: string;
  notes: string;
  url?: string;
  rating?: number;
  createdAt: string;
  updatedAt: string;
}

export interface Settings {
  senderName: string;
  senderTitle: string;
  senderCompany: string;
  senderPhone: string;
  senderEmail: string;
  /** Default assumption for owner-name column order on import. */
  defaultNameOrder: 'lastFirst' | 'firstLast';
  theme: 'system' | 'dark' | 'light';
}

export interface Database {
  version: number;
  contacts: Contact[];
  aircraft: Aircraft[];
  opportunities: Opportunity[];
  policies: InsurancePolicy[];
  activities: Activity[];
  followUps: FollowUp[];
  templates: EmailTemplate[];
  files: FileRecord[];
  imports: ImportRecord[];
  layoverSpots: LayoverSpot[];
  settings: Settings;
}

export const DB_VERSION = 2;

export function emptyDatabase(): Database {
  return {
    version: DB_VERSION,
    contacts: [],
    aircraft: [],
    opportunities: [],
    policies: [],
    activities: [],
    followUps: [],
    templates: [],
    files: [],
    imports: [],
    layoverSpots: [],
    settings: {
      senderName: '',
      senderTitle: '',
      senderCompany: '',
      senderPhone: '',
      senderEmail: '',
      defaultNameOrder: 'lastFirst',
      theme: 'system',
    },
  };
}
