/** AEROBOOK data model. Plain JSON-serialisable records with stable string ids. */

export const CONTACT_STATUSES = ['Prospect', 'Lead', 'Active Client', 'Past Client', 'Other'] as const;
export type ContactStatus = (typeof CONTACT_STATUSES)[number];

export const CONTACT_TYPES = ['Aircraft Owner', 'Insurance', 'Brokerage', 'Referral', 'Vendor', 'Other'] as const;
export type ContactType = (typeof CONTACT_TYPES)[number];

export const AIRCRAFT_STATUSES = ['Owned', 'For Sale', 'Purchase Prospect', 'Sold', 'Unknown', 'Other'] as const;
export type AircraftStatus = (typeof AIRCRAFT_STATUSES)[number];

export const PROSPECT_STATUSES = ['New', 'Contacted', 'Follow-Up', 'Engaged', 'Quote', 'Client', 'Closed', 'Not Interested'] as const;
export type ProspectStatus = (typeof PROSPECT_STATUSES)[number];

export const OPPORTUNITY_TYPES = ['Insurance', 'Aircraft Purchase', 'Aircraft Sale', 'Both', 'Other'] as const;
export type OpportunityType = (typeof OPPORTUNITY_TYPES)[number];

export const OPPORTUNITY_STATUSES = ['Open', 'Contacted', 'Quote', 'Negotiating', 'Won', 'Lost', 'Closed'] as const;
export type OpportunityStatus = (typeof OPPORTUNITY_STATUSES)[number];

export const ACTIVITY_TYPES = ['Email', 'Call', 'Text', 'Meeting', 'Note', 'Quote', 'Import', 'Follow-Up', 'Other'] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number];

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
  nameConfidence: (typeof NAME_CONFIDENCE)[number];
  needsReview: boolean;
  source?: string;
  createdAt: string;
  updatedAt: string;
  lastContactedAt?: string;
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
  followUpDate?: string;
  estimatedValue?: string;
  notes: string;
  /** Insurance detail — every field optional by design. */
  insurance?: {
    currentInsurer?: string;
    carrier?: string;
    policyNumber?: string;
    renewalDate?: string;
    policyStatus?: string;
    premium?: string;
    deductible?: string;
    liabilityLimit?: string;
    hullValue?: string;
    coverageNotes?: string;
  };
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
  dueDate: string;
  note: string;
  completed: boolean;
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
  activities: Activity[];
  followUps: FollowUp[];
  templates: EmailTemplate[];
  files: FileRecord[];
  imports: ImportRecord[];
  layoverSpots: LayoverSpot[];
  settings: Settings;
}

export const DB_VERSION = 1;

export function emptyDatabase(): Database {
  return {
    version: DB_VERSION,
    contacts: [],
    aircraft: [],
    opportunities: [],
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
