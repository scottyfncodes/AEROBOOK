/**
 * Owner-name parsing.
 *
 * FAA-derived owner lists store individuals last-name-first with no comma:
 *   "Humphrey Marlon"      -> Marlon Humphrey
 *   "Heine John Charles"   -> John Charles Heine
 *   "Poole James Gregory III"
 * Other sources hand you "John Heine" or "Heine, John". The parser takes an
 * explicit order hint so the importer can flip the whole file at once, and it
 * never discards the original string.
 */

export type NameOrder = 'lastFirst' | 'firstLast';
export type NameConfidence = 'high' | 'medium' | 'low' | 'organization';

export interface ParsedName {
  /** Exactly what arrived, trimmed of surrounding whitespace only. */
  raw: string;
  firstName: string;
  middleName: string;
  lastName: string;
  suffix: string;
  /** "Trustee", "Executor" — stripped from the name, kept for context. */
  role: string;
  /** "John Charles Heine III" — built from the parsed parts. */
  fullName: string;
  /** Set when the name is a company/trust rather than a person. */
  company: string;
  isOrganization: boolean;
  /** More than one person named in a single field. */
  isJoint: boolean;
  confidence: NameConfidence;
  needsReview: boolean;
}

const ORG_TOKENS = [
  'LLC', 'L.L.C', 'INC', 'CORP', 'CORPORATION', 'COMPANY', 'LTD', 'LP', 'LLP',
  'PLLC', 'TRUST', 'BANK', 'HOLDINGS', 'PARTNERS', 'PARTNERSHIP', 'AVIATION',
  'AIRWAYS', 'AIRLINES', 'AIRCRAFT', 'LEASING', 'ENTERPRISES', 'ASSOCIATES',
  'ASSOCIATION', 'GROUP', 'VENTURES', 'CAPITAL', 'FARMS', 'RANCH', 'CLUB',
  'FOUNDATION', 'MINISTRIES', 'CHURCH', 'UNIVERSITY', 'COLLEGE', 'HOSPITAL',
  'SERVICES', 'SOLUTIONS', 'MANAGEMENT', 'PROPERTIES', 'INVESTMENTS',
  'INDUSTRIES', 'SYSTEMS', 'TECHNOLOGIES', 'DESIGN',
];

/**
 * Words that describe how a person holds the aircraft rather than who they are.
 * "Goldberg William Trustee" is still William Goldberg.
 */
const ROLE_TOKENS = ['TRUSTEE', 'TRUSTEES', 'CO-TRUSTEE', 'ETAL', 'EXECUTOR', 'ESTATE'];

const SUFFIXES = ['JR', 'SR', 'II', 'III', 'IV', 'MD', 'DDS', 'PHD', 'ESQ', 'DVM'];

const JOINT_RE = /(\s&\s|\s\+\s|\sAND\s|\/)/i;

function clean(token: string): string {
  return token.replace(/[.,]+$/g, '');
}

/** Title Case, but leave things that are already mixed-case or Mc/Mac alone. */
export function titleCase(value: string): string {
  if (!value) return '';
  return value
    .split(/(\s|-|')/)
    .map((part) => {
      if (!/[a-z]/i.test(part)) return part;
      const upper = part.toUpperCase();
      if (SUFFIXES.includes(clean(upper)) && upper.length <= 3) return upper;
      return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
    })
    .join('');
}

export function looksLikeOrganization(raw: string): boolean {
  const tokens = raw
    .toUpperCase()
    .split(/[\s,.]+/)
    .filter(Boolean)
    .map(clean);
  if (tokens.some((t) => ORG_TOKENS.includes(t))) return true;
  // "SMITH & JONES HOLDINGS" style ampersand without person-ish structure.
  return /\b(LLC|INC|CORP|TRUST)\b/i.test(raw);
}

function emptyResult(raw: string): ParsedName {
  return {
    raw,
    firstName: '',
    middleName: '',
    lastName: '',
    suffix: '',
    role: '',
    fullName: raw,
    company: '',
    isOrganization: false,
    isJoint: false,
    confidence: 'low',
    needsReview: true,
  };
}

export function parseOwnerName(input: string | null | undefined, order: NameOrder = 'lastFirst'): ParsedName {
  const raw = (input ?? '').trim().replace(/\s+/g, ' ');
  if (!raw) return { ...emptyResult(''), fullName: '' };

  if (looksLikeOrganization(raw)) {
    return {
      raw,
      firstName: '',
      middleName: '',
      lastName: '',
      suffix: '',
      role: '',
      fullName: raw,
      company: raw,
      isOrganization: true,
      isJoint: false,
      confidence: 'organization',
      needsReview: false,
    };
  }

  const isJoint = JOINT_RE.test(raw);
  // Parse only the first named person; the raw value keeps the rest.
  const primary = isJoint ? raw.split(JOINT_RE)[0].trim() : raw;

  const hasComma = primary.includes(',');
  let tokens = primary.split(/[\s,]+/).map(clean).filter(Boolean);
  if (tokens.length === 0) return emptyResult(raw);

  // Strip role words ("Trustee") before anything else so they can't be mistaken
  // for a given name or a surname.
  const roleParts: string[] = [];
  tokens = tokens.filter((t, i) => {
    if (i > 0 && ROLE_TOKENS.includes(t.toUpperCase())) {
      roleParts.push(titleCase(t));
      return false;
    }
    return true;
  });
  const role = roleParts.join(' ');
  if (tokens.length === 0) return emptyResult(raw);

  // Pull any suffix out of the token list before deciding on name order.
  let suffix = '';
  const suffixIdx = tokens.findIndex((t, i) => i > 0 && SUFFIXES.includes(t.toUpperCase()));
  if (suffixIdx !== -1) {
    suffix = tokens[suffixIdx].toUpperCase();
    tokens = tokens.filter((_, i) => i !== suffixIdx);
  }

  let firstName = '';
  let middleName = '';
  let lastName = '';
  let confidence: NameConfidence;

  if (tokens.length === 1) {
    lastName = tokens[0];
    confidence = 'low';
  } else if (hasComma) {
    // "Heine, John Charles" — unambiguous.
    const [last, ...rest] = primary.split(',');
    const restTokens = rest.join(' ').split(/\s+/).map(clean).filter((t) => t && !SUFFIXES.includes(t.toUpperCase()));
    lastName = last.trim();
    firstName = restTokens[0] ?? '';
    middleName = restTokens.slice(1).join(' ');
    confidence = 'high';
  } else if (order === 'lastFirst') {
    lastName = tokens[0];
    firstName = tokens[1] ?? '';
    middleName = tokens.slice(2).join(' ');
    confidence = tokens.length <= 3 ? 'high' : 'medium';
  } else {
    firstName = tokens[0];
    lastName = tokens[tokens.length - 1];
    middleName = tokens.slice(1, -1).join(' ');
    confidence = tokens.length <= 3 ? 'high' : 'medium';
  }

  // Anything with digits or stray symbols is not a name we trust.
  if (/[0-9@#*]/.test(primary)) confidence = 'low';
  if (isJoint && confidence === 'high') confidence = 'medium';

  firstName = titleCase(firstName);
  middleName = titleCase(middleName);
  lastName = titleCase(lastName);

  const fullName = [firstName, middleName, lastName, suffix].filter(Boolean).join(' ') || raw;

  return {
    raw,
    firstName,
    middleName,
    lastName,
    suffix,
    role,
    fullName,
    company: '',
    isOrganization: false,
    isJoint,
    confidence,
    needsReview: confidence === 'low',
  };
}

/** What you'd actually type after "Hi". Falls back rather than greeting nobody. */
export function greetingName(parsed: Pick<ParsedName, 'firstName' | 'company' | 'raw' | 'lastName'>): string {
  if (parsed.firstName) return parsed.firstName;
  if (parsed.company) return parsed.company;
  if (parsed.lastName) return parsed.lastName;
  return parsed.raw;
}

export function displayName(c: {
  firstName?: string | null;
  lastName?: string | null;
  company?: string | null;
  rawName?: string | null;
}): string {
  const person = [c.firstName, c.lastName].filter(Boolean).join(' ').trim();
  if (person) return person;
  if (c.company) return c.company;
  return (c.rawName ?? '').trim() || 'Unnamed contact';
}
