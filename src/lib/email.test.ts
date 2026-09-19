import { describe, expect, it } from 'vitest';
import { buildMailto, buildVariables, defaultTemplates, missingVariables, renderEmail, renderTemplate, tidy } from './email';
import type { Aircraft, Contact, EmailTemplate } from '../data/types';

const contact: Contact = {
  id: 'c1', firstName: 'John', lastName: 'Heine', rawName: 'Heine John Charles', company: '',
  email: 'jheine@acentech.com', phone: '7818917648', address: '1308 Santa Teresita Dr',
  city: 'Santa Barbara', state: 'CA', zip: '931051947', contactTypes: [], status: 'Prospect',
  prospectStatus: 'New', notes: '', custom: {}, nameConfidence: 'high', needsReview: false,
  createdAt: '', updatedAt: '',
};

const aircraft: Aircraft = {
  id: 'a1', tailNumber: 'N917JH', tailKey: '917JH', year: '2026', make: 'Cirrus', model: 'SR22T',
  ownerships: [{ contactId: 'c1' }], status: 'Unknown', notes: '', custom: '' as never && {},
  createdAt: '', updatedAt: '',
} as Aircraft;

const tpl = (patch: Partial<EmailTemplate>): EmailTemplate => ({
  id: 't', name: 'T', subject: 'RE: {{tail}}', body: 'Hi {{firstName}},', createdAt: '', updatedAt: '', ...patch,
});

describe('buildVariables', () => {
  it('exposes the aircraft and contact fields', () => {
    const v = buildVariables({ contact, aircraft, settings: { senderName: 'Sam' } });
    expect(v.firstName).toBe('John');
    expect(v.fullName).toBe('John Heine');
    expect(v.tail).toBe('N917JH');
    expect(v.aircraft).toBe('2026 Cirrus SR22T');
    expect(v.city).toBe('Santa Barbara');
    expect(v.state).toBe('CA');
    expect(v.senderName).toBe('Sam');
  });

  it('falls back to the company for a greeting when there is no person', () => {
    const org = { ...contact, firstName: '', lastName: '', company: 'Blue Ridge Aviation LLC' };
    expect(buildVariables({ contact: org }).firstName).toBe('Blue Ridge Aviation LLC');
  });

  it('is all-empty with no records at all', () => {
    const v = buildVariables({});
    expect(v.tail).toBe('');
    expect(v.firstName).toBe('');
  });
});

describe('renderTemplate', () => {
  it('replaces variables', () => {
    expect(renderTemplate('Hi {{firstName}}, about {{tail}}.', { firstName: 'John', tail: 'N917JH' }))
      .toBe('Hi John, about N917JH.');
  });

  it('tolerates whitespace inside the braces', () => {
    expect(renderTemplate('{{ firstName }}', { firstName: 'John' })).toBe('John');
  });

  it('leaves no placeholder behind for a missing variable', () => {
    expect(renderTemplate('Hi {{firstName}}{{nope}}!', { firstName: 'John' })).toBe('Hi John!');
  });

  it('handles an empty template', () => {
    expect(renderTemplate('', {})).toBe('');
  });
});

describe('missingVariables', () => {
  it('lists variables with no value', () => {
    expect(missingVariables('{{tail}} {{year}}', { tail: 'N1', year: '' })).toEqual(['year']);
  });
});

describe('tidy', () => {
  it('closes the gaps an empty variable leaves', () => {
    expect(tidy('your  2026   aircraft , N1 .')).toBe('your 2026 aircraft, N1.');
    expect(tidy('a\n\n\n\nb')).toBe('a\n\nb');
  });
});

describe('renderEmail', () => {
  it('builds the subject from the tail', () => {
    const e = renderEmail(tpl({}), { contact, aircraft });
    expect(e.subject).toBe('RE: N917JH');
    expect(e.to).toBe('jheine@acentech.com');
    expect(e.body).toBe('Hi John,');
  });

  it('never leaves a bare "RE:" when there is no aircraft', () => {
    const e = renderEmail(tpl({ subject: 'RE: {{tail}}' }), { contact });
    expect(e.subject).toBe('Following up');
    expect(e.missing).toContain('tail');
  });

  it('reports the fields it could not fill', () => {
    const e = renderEmail(tpl({ body: 'Hi {{firstName}}, your {{model}} in {{city}}.' }), {
      contact: { ...contact, city: '' },
      aircraft,
    });
    expect(e.missing).toEqual(['city']);
  });

  it('addresses nobody rather than inventing a recipient', () => {
    expect(renderEmail(tpl({}), { aircraft }).to).toBe('');
  });
});

describe('buildMailto', () => {
  it('percent-encodes every component', () => {
    const mailto = buildMailto({ to: 'a b@example.com', subject: 'RE: N917JH', body: 'Hi John,\n\nR&D?', missing: [] });
    expect(mailto).toContain('mailto:a%20b%40example.com');
    expect(mailto).toContain('subject=RE%3A%20N917JH');
    expect(mailto).toContain('R%26D%3F');
    const url = new URL(mailto);
    expect(url.searchParams.get('body')).toBe('Hi John,\n\nR&D?');
  });

  it('omits the query string when there is nothing to put in it', () => {
    expect(buildMailto({ to: 'a@b.com', subject: '', body: '', missing: [] })).toBe('mailto:a%40b.com');
  });
});

describe('defaultTemplates', () => {
  const templates = defaultTemplates(new Date().toISOString());

  it('ships the six named templates plus Custom', () => {
    expect(templates.map((t) => t.name)).toEqual([
      'Initial Aircraft Outreach', 'Insurance Outreach', 'Brokerage Outreach',
      'Quote Follow-Up', 'Renewal Follow-Up', 'General Follow-Up', 'Custom',
    ]);
  });

  it('renders every one of them cleanly for a real record', () => {
    for (const t of templates) {
      const e = renderEmail(t, { contact, aircraft, settings: { senderName: 'Sam', senderTitle: 'Broker', senderCompany: 'Aero', senderPhone: '555' } });
      expect(e.body).not.toContain('{{');
      expect(e.subject).not.toContain('{{');
      expect(e.subject.length).toBeGreaterThan(0);
    }
  });
});
