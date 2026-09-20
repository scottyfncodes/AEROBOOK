/**
 * Email generation.
 *
 * Templates are data, not code — the user edits them in Settings. Rendering is
 * a plain {{variable}} substitution with a documented variable list and a
 * gentle fallback: a missing tail must not leave "RE: {{tail}}" in the subject
 * line of a real email.
 */
import type { Aircraft, Contact, EmailTemplate, InsurancePolicy, Opportunity, Settings } from '../data/types';
import { greetingName } from './names';
import { formatTail } from './tail';
import { formatDate } from './dates';

export interface TemplateVariable {
  key: string;
  label: string;
  example: string;
}

export const TEMPLATE_VARIABLES: TemplateVariable[] = [
  { key: 'firstName', label: 'Owner first name', example: 'John' },
  { key: 'fullName', label: 'Owner full name', example: 'John Charles Heine' },
  { key: 'lastName', label: 'Owner last name', example: 'Heine' },
  { key: 'company', label: 'Company', example: 'Heine Holdings' },
  { key: 'tail', label: 'Tail number', example: 'N917JH' },
  { key: 'year', label: 'Aircraft year', example: '2026' },
  { key: 'make', label: 'Aircraft make', example: 'Cirrus' },
  { key: 'model', label: 'Aircraft model', example: 'SR22T' },
  { key: 'aircraft', label: 'Year make model', example: '2026 Cirrus SR22T' },
  { key: 'city', label: 'Owner city', example: 'Santa Barbara' },
  { key: 'state', label: 'Owner state', example: 'CA' },
  { key: 'base', label: 'Base airport', example: 'KSBA' },
  { key: 'opportunity', label: 'Opportunity title', example: 'N917JH — hull and liability' },
  { key: 'carrier', label: 'Insurance carrier', example: 'Global Aerospace' },
  { key: 'renewalDate', label: 'Insurance renewal date', example: 'Nov 2' },
  { key: 'followUpDate', label: 'Next follow-up date', example: 'Sep 30' },
  { key: 'senderName', label: 'Your name', example: '' },
  { key: 'senderTitle', label: 'Your title', example: '' },
  { key: 'senderCompany', label: 'Your company', example: '' },
  { key: 'senderPhone', label: 'Your phone', example: '' },
  { key: 'senderEmail', label: 'Your email', example: '' },
];

export interface EmailContext {
  contact?: Contact | null;
  aircraft?: Aircraft | null;
  opportunity?: Opportunity | null;
  policy?: InsurancePolicy | null;
  /** The date of the follow-up this message is answering, when there is one. */
  followUpDate?: string | null;
  settings?: Partial<Settings> | null;
}

export function buildVariables(ctx: EmailContext): Record<string, string> {
  const c = ctx.contact ?? null;
  const a = ctx.aircraft ?? null;
  const s = ctx.settings ?? {};

  const first = c
    ? greetingName({ firstName: c.firstName, company: c.company, raw: c.rawName, lastName: c.lastName })
    : '';
  const full = c ? [c.firstName, c.lastName].filter(Boolean).join(' ') || c.company || c.rawName : '';
  const make = a?.make ?? '';
  const model = a?.model ?? '';
  const year = a?.year ?? '';

  return {
    firstName: first,
    fullName: full,
    lastName: c?.lastName ?? '',
    company: c?.company ?? '',
    tail: a ? formatTail(a.tailNumber) : '',
    year,
    make,
    model,
    aircraft: [year, make, model].filter(Boolean).join(' '),
    city: c?.city ?? '',
    state: c?.state ?? '',
    base: a?.baseAirport ?? '',
    opportunity: ctx.opportunity?.title ?? '',
    carrier: ctx.policy?.carrier ?? '',
    renewalDate: ctx.policy?.expirationDate ? formatDate(ctx.policy.expirationDate) : '',
    followUpDate: ctx.followUpDate ? formatDate(ctx.followUpDate) : '',
    senderName: s.senderName ?? '',
    senderTitle: s.senderTitle ?? '',
    senderCompany: s.senderCompany ?? '',
    senderPhone: s.senderPhone ?? '',
    senderEmail: s.senderEmail ?? '',
  };
}

const VAR_RE = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

/** Substitute {{vars}}. Unknown or empty variables resolve to an empty string. */
export function renderTemplate(template: string, vars: Record<string, string>): string {
  if (!template) return '';
  return template.replace(VAR_RE, (_match, key: string) => vars[key] ?? '');
}

/** Collapse the holes an empty variable leaves behind. */
export function tidy(text: string): string {
  return text
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ +([,.!?])/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .trim();
}

export function missingVariables(template: string, vars: Record<string, string>): string[] {
  const missing = new Set<string>();
  let m: RegExpExecArray | null;
  const re = new RegExp(VAR_RE.source, 'g');
  while ((m = re.exec(template)) !== null) {
    if (!vars[m[1]]) missing.add(m[1]);
  }
  return [...missing];
}

export interface RenderedEmail {
  to: string;
  subject: string;
  body: string;
  missing: string[];
}

/**
 * A subject that rendered down to nothing meaningful — "" or a dangling
 * "RE:" because the aircraft had no tail — is replaced rather than sent.
 */
function subjectIsEmpty(subject: string): boolean {
  const letters = subject.replace(/[^a-z0-9]/gi, '');
  return letters === '' || /^(re|fw|fwd)$/i.test(letters);
}

export function renderEmail(template: EmailTemplate, ctx: EmailContext): RenderedEmail {
  const vars = buildVariables(ctx);
  const tail = vars.tail;
  let subject = tidy(renderTemplate(template.subject, vars));
  if (subjectIsEmpty(subject)) subject = tail ? `RE: ${tail}` : 'Following up';
  const body = tidy(renderTemplate(template.body, vars));
  return {
    to: ctx.contact?.email ?? '',
    subject,
    body,
    missing: [...new Set([...missingVariables(template.subject, vars), ...missingVariables(template.body, vars)])],
  };
}

/** RFC 6068 mailto. Every component is percent-encoded. */
export function buildMailto(email: RenderedEmail): string {
  const params: string[] = [];
  if (email.subject) params.push(`subject=${encodeURIComponent(email.subject)}`);
  if (email.body) params.push(`body=${encodeURIComponent(email.body)}`);
  const to = encodeURIComponent(email.to ?? '');
  return `mailto:${to}${params.length ? `?${params.join('&')}` : ''}`;
}

export function defaultTemplates(now: string): EmailTemplate[] {
  const sig = '{{senderName}}\n{{senderTitle}}\n{{senderCompany}}\n{{senderPhone}}';
  const defs: Array<Pick<EmailTemplate, 'id' | 'name' | 'subject' | 'body'>> = [
    {
      id: 'tpl_initial_outreach',
      name: 'Initial Aircraft Outreach',
      subject: 'RE: {{tail}}',
      body:
        'Hi {{firstName}},\n\n' +
        'I came across your {{aircraft}}, {{tail}}, and wanted to introduce myself. ' +
        'I work with owners on both sides of the aircraft business — brokerage and insurance — ' +
        'and I keep a close eye on the {{model}} market.\n\n' +
        'If it would be useful, I am happy to send you where comparable aircraft are trading right now. ' +
        'No obligation either way.\n\n' +
        'Are you open to a short call?\n\n' +
        'Best regards,\n' +
        sig,
    },
    {
      id: 'tpl_insurance_outreach',
      name: 'Insurance Outreach',
      subject: 'RE: {{tail}} — insurance review',
      body:
        'Hi {{firstName}},\n\n' +
        'I place aircraft insurance and wanted to offer you a second look at the coverage on {{tail}}, ' +
        'your {{aircraft}}.\n\n' +
        'Owners are seeing real movement in hull rates and liability limits right now, and a quick review ' +
        'usually takes me about ten minutes of your time. If you can share your current renewal date and ' +
        'declared hull value, I can tell you quickly whether it is worth quoting.\n\n' +
        'Happy to help either way.\n\n' +
        'Best regards,\n' +
        sig,
    },
    {
      id: 'tpl_brokerage_outreach',
      name: 'Brokerage Outreach',
      subject: 'RE: {{tail}}',
      body:
        'Hi {{firstName}},\n\n' +
        'I have buyers actively looking for a {{make}} {{model}}. If you have ever thought about what ' +
        '{{tail}} would bring in today’s market, I would be glad to put together a valuation for you.\n\n' +
        'It costs you nothing and there is no obligation to list.\n\n' +
        'Would that be helpful?\n\n' +
        'Best regards,\n' +
        sig,
    },
    {
      id: 'tpl_quote_followup',
      name: 'Quote Follow-Up',
      subject: 'RE: {{tail}} — quote follow-up',
      body:
        'Hi {{firstName}},\n\n' +
        'Following up on the quote I sent for {{tail}}. Happy to walk through the numbers, adjust the ' +
        'limits, or look at a different deductible if that helps.\n\n' +
        'What questions can I answer?\n\n' +
        'Best regards,\n' +
        sig,
    },
    {
      id: 'tpl_renewal_followup',
      name: 'Renewal Follow-Up',
      subject: 'RE: {{tail}} — upcoming renewal',
      body:
        'Hi {{firstName}},\n\n' +
        'Your policy on {{tail}} is coming up for renewal. If anything has changed this year — hours ' +
        'flown, ratings, avionics, hangar, declared value — it is worth a quick conversation before the ' +
        'renewal is quoted.\n\n' +
        'Would you like me to shop it?\n\n' +
        'Best regards,\n' +
        sig,
    },
    {
      id: 'tpl_general_followup',
      name: 'General Follow-Up',
      subject: 'RE: {{tail}}',
      body:
        'Hi {{firstName}},\n\n' +
        'Circling back on {{tail}}. Let me know if the timing is better now, or if you would rather I ' +
        'check back later in the year.\n\n' +
        'Best regards,\n' +
        sig,
    },
    {
      id: 'tpl_no_response',
      name: 'No Response Follow-Up',
      subject: 'RE: {{tail}}',
      body:
        'Hi {{firstName}},\n\n' +
        'I have written once or twice about {{tail}} and have not heard back, which usually just means ' +
        'the timing is wrong. I will stop here rather than fill your inbox.\n\n' +
        'If anything changes — a renewal, a sale, a purchase — I am a phone call away.\n\n' +
        'Best regards,\n' +
        sig,
    },
    {
      id: 'tpl_purchase_inquiry',
      name: 'Aircraft Purchase Inquiry',
      subject: 'Looking for a {{make}} {{model}}',
      body:
        'Hi {{firstName}},\n\n' +
        'I have a client looking for a {{make}} {{model}} and I am reaching out to owners directly ' +
        'rather than waiting for one to come to market.\n\n' +
        'If you would consider an offer on {{tail}}, I can tell you what the aircraft is worth today ' +
        'and what my client is prepared to do. If not, no harm in asking.\n\n' +
        'Best regards,\n' +
        sig,
    },
    {
      id: 'tpl_new_client',
      name: 'New Client Introduction',
      subject: 'Good to be working together',
      body:
        'Hi {{firstName}},\n\n' +
        'Thanks for your time today. To put it in writing: I will handle {{opportunity}} and come back ' +
        'to you with the detail.\n\n' +
        'My direct line is {{senderPhone}} — use it for anything, not just the business at hand.\n\n' +
        'Best regards,\n' +
        sig,
    },
    {
      id: 'tpl_post_meeting',
      name: 'Post-Meeting Follow-Up',
      subject: 'RE: {{tail}} — following up on our conversation',
      body:
        'Hi {{firstName}},\n\n' +
        'Good to talk today. What I took away:\n\n' +
        '  · \n' +
        '  · \n\n' +
        'I will come back to you by {{followUpDate}}. If I have any of that wrong, tell me and I will ' +
        'correct it before I go any further.\n\n' +
        'Best regards,\n' +
        sig,
    },
    {
      id: 'tpl_document_request',
      name: 'Document Request',
      subject: 'RE: {{tail}} — a couple of documents',
      body:
        'Hi {{firstName}},\n\n' +
        'To move {{tail}} along I need a few things when you have a moment:\n\n' +
        '  · Current declarations page\n' +
        '  · Pilot hours and ratings\n' +
        '  · Anything recent on avionics or engine work\n\n' +
        'A photo of each is fine — they do not need to be tidy.\n\n' +
        'Best regards,\n' +
        sig,
    },
    {
      id: 'tpl_custom',
      name: 'Custom',
      subject: 'RE: {{tail}}',
      body: 'Hi {{firstName}},\n\n\n\nBest regards,\n' + sig,
    },
  ];
  return defs.map((d) => ({ ...d, builtIn: true, createdAt: now, updatedAt: now }));
}
