import { describe, expect, it } from 'vitest';
import { greetingName, looksLikeOrganization, parseOwnerName } from './names';

describe('parseOwnerName — FAA last-name-first order', () => {
  it('parses the two-token case from the sample file', () => {
    const p = parseOwnerName('Humphrey Marlon');
    expect(p.firstName).toBe('Marlon');
    expect(p.lastName).toBe('Humphrey');
    expect(p.fullName).toBe('Marlon Humphrey');
    expect(p.confidence).toBe('high');
    expect(p.needsReview).toBe(false);
  });

  it('parses last, first, middle', () => {
    const p = parseOwnerName('Heine John Charles');
    expect(p.firstName).toBe('John');
    expect(p.middleName).toBe('Charles');
    expect(p.lastName).toBe('Heine');
    expect(p.fullName).toBe('John Charles Heine');
  });

  it('keeps the raw value untouched', () => {
    expect(parseOwnerName('Heine John Charles').raw).toBe('Heine John Charles');
    expect(parseOwnerName('  HEINE   JOHN  ').raw).toBe('HEINE JOHN');
  });

  it('pulls out a generational suffix', () => {
    const p = parseOwnerName('Poole James Gregory III');
    expect(p.firstName).toBe('James');
    expect(p.middleName).toBe('Gregory');
    expect(p.lastName).toBe('Poole');
    expect(p.suffix).toBe('III');
    expect(p.fullName).toBe('James Gregory Poole III');
  });

  it('handles Jr', () => {
    const p = parseOwnerName('Kimbrell Todd Jr');
    expect(p.firstName).toBe('Todd');
    expect(p.lastName).toBe('Kimbrell');
    expect(p.suffix).toBe('JR');
  });

  it('treats a trustee as a person, not a company', () => {
    const p = parseOwnerName('Goldberg William Trustee');
    expect(p.isOrganization).toBe(false);
    expect(p.firstName).toBe('William');
    expect(p.lastName).toBe('Goldberg');
    expect(p.role).toBe('Trustee');
  });

  it('keeps a middle initial', () => {
    const p = parseOwnerName('Heine John C');
    expect(p.firstName).toBe('John');
    expect(p.middleName).toBe('C');
    expect(p.lastName).toBe('Heine');
  });
});

describe('parseOwnerName — other shapes', () => {
  it('honours a comma regardless of the order hint', () => {
    const p = parseOwnerName('Heine, John Charles', 'firstLast');
    expect(p.firstName).toBe('John');
    expect(p.lastName).toBe('Heine');
    expect(p.confidence).toBe('high');
  });

  it('parses conventional order when told to', () => {
    const p = parseOwnerName('John Heine', 'firstLast');
    expect(p.firstName).toBe('John');
    expect(p.lastName).toBe('Heine');
  });

  it('flags a single token for review', () => {
    const p = parseOwnerName('Heine');
    expect(p.lastName).toBe('Heine');
    expect(p.confidence).toBe('low');
    expect(p.needsReview).toBe(true);
  });

  it('flags an empty name', () => {
    const p = parseOwnerName('');
    expect(p.needsReview).toBe(true);
    expect(p.fullName).toBe('');
  });

  it('detects joint ownership and keeps the whole raw string', () => {
    const p = parseOwnerName('Smith John A & Smith Mary B');
    expect(p.isJoint).toBe(true);
    expect(p.firstName).toBe('John');
    expect(p.lastName).toBe('Smith');
    expect(p.raw).toBe('Smith John A & Smith Mary B');
    expect(p.confidence).toBe('medium');
  });

  it('does not treat digits as a name', () => {
    expect(parseOwnerName('Owner 12345').confidence).toBe('low');
  });
});

describe('organizations', () => {
  it.each([
    'Cirrus Design Corp',
    'BLUE RIDGE AVIATION LLC',
    'Wells Fargo Bank Northwest',
    'Skyward Holdings Inc',
  ])('recognises %s', (name) => {
    expect(looksLikeOrganization(name)).toBe(true);
    const p = parseOwnerName(name);
    expect(p.isOrganization).toBe(true);
    expect(p.company).toBe(name);
    expect(p.confidence).toBe('organization');
    expect(p.needsReview).toBe(false);
  });

  it('does not mistake a person for a company', () => {
    expect(looksLikeOrganization('Heine John Charles')).toBe(false);
    expect(looksLikeOrganization('Humphrey Marlon')).toBe(false);
  });
});

describe('greetingName', () => {
  it('prefers the first name', () => {
    expect(greetingName(parseOwnerName('Heine John Charles'))).toBe('John');
  });

  it('falls back to the company, then the last name, then the raw value', () => {
    expect(greetingName(parseOwnerName('Cirrus Design Corp'))).toBe('Cirrus Design Corp');
    expect(greetingName(parseOwnerName('Heine'))).toBe('Heine');
    expect(greetingName({ firstName: '', company: '', lastName: '', raw: 'unparseable' })).toBe('unparseable');
  });
});
