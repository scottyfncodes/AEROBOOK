import { describe, expect, it } from 'vitest';
import { CONFIDENT_AT, detectMappings, mappingIsUsable, mappingIssues } from './mapping';

const sampleHeaders = ['Tail', 'Year', 'Make', 'Model', 'Owner', 'Registrant type', 'Street', 'Street 2', 'City', 'State', 'ZIP', 'Phone', 'Email'];

function fieldFor(headers: string[], header: string) {
  const m = detectMappings(headers).find((x) => x.header === header);
  return m?.field;
}

describe('detectMappings on the supplied sample header row', () => {
  const mappings = detectMappings(sampleHeaders);

  it('maps every column of the sample file', () => {
    expect(mappings.map((m) => m.field)).toEqual([
      'tailNumber', 'year', 'make', 'model', 'ownerName', 'registrantType',
      'address', 'address2', 'city', 'state', 'zip', 'phone', 'email',
    ]);
  });

  it('is confident about all of them', () => {
    for (const m of mappings) expect(m.confidence).toBeGreaterThanOrEqual(CONFIDENT_AT);
  });

  it('is usable', () => {
    expect(mappingIsUsable(mappings)).toBe(true);
    expect(mappingIssues(mappings)).toEqual([]);
  });
});

describe('detectMappings with other spellings', () => {
  it.each([
    ['N-Number', 'tailNumber'],
    ['N Number', 'tailNumber'],
    ['Registration', 'tailNumber'],
    ['tail_number', 'tailNumber'],
    ['Aircraft Make', 'make'],
    ['Manufacturer', 'make'],
    ['Owner Email', 'email'],
    ['E-Mail Address', 'email'],
    ['Cell Phone', 'phone'],
    ['Mailing Address', 'address'],
    ['Postal Code', 'zip'],
    ['Business Name', 'company'],
    ['Surname', 'lastName'],
    ['Given Name', 'firstName'],
  ])('maps %s to %s', (header, expected) => {
    expect(fieldFor([header], header)).toBe(expected);
  });

  it('keeps an unrecognised column as custom data rather than dropping it', () => {
    const m = detectMappings(['Tail', 'Engine Hours', 'Avionics'])!;
    expect(m[1].field).toBe('custom');
    expect(m[2].field).toBe('custom');
  });

  it('gives a field to only one column', () => {
    const m = detectMappings(['Email', 'Owner Email']);
    expect(m[0].field).toBe('email');
    expect(m[1].field).toBe('custom');
  });

  it('handles an empty header list', () => {
    expect(detectMappings([])).toEqual([]);
    expect(mappingIsUsable([])).toBe(false);
  });
});

describe('mappingIssues', () => {
  it('warns when there is no tail column', () => {
    const issues = mappingIssues(detectMappings(['Owner', 'Email']));
    expect(issues.join(' ')).toMatch(/tail-number/i);
  });

  it('warns when there is no way to reach anyone', () => {
    const issues = mappingIssues(detectMappings(['Tail', 'Owner']));
    expect(issues.join(' ')).toMatch(/no email or phone/i);
  });
});
