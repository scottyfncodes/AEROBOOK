/**
 * Emailing a customer from their profile, with documents already stored on
 * it attached.
 *
 * The browser sends only ids: the customer, the documents, and the words.
 * Everything else is decided here, from what is stored:
 *   - the address is the one on the customer's record, never one the browser
 *     names, so a customer's documents only ever go to that customer;
 *   - every document must be one shown on that customer's profile (theirs,
 *     or on their aircraft, deals or policies, as documentsFor() in
 *     src/lib/selectors.ts decides), so an id from another customer's
 *     profile is refused;
 *   - the file is read from private storage on the server and sent as the
 *     attachment itself. Nothing is made public, and no storage link or
 *     credential reaches the browser or the email.
 *
 * The same people who may open a document may send one: anyone signed in
 * whose access is on (handle() checks before calling in). What was sent, to
 * whom and with which documents is recorded as an Email activity on the
 * customer — written like any other change, so it is in the activity history
 * with who sent it. The message and the files themselves are never logged.
 */
import { createHash } from 'node:crypto';
import type { SessionUser } from './auth.js';
import { getPool } from './db.js';
import { EmailError, emailEnabled, sendEmail, type EmailAttachment } from './digest.js';
import { isFilePath, MAX_FILE_BYTES, readStored } from './files.js';
import { HttpError } from './http.js';
import { push } from './sync.js';
import { ALLOWED_DOCUMENT_TYPES } from '../src/lib/documents.js';
import { isValidEmail, normalizeEmail } from '../src/lib/phone.js';

/** The most documents one email carries. */
export const MAX_ATTACHMENTS = 10;
/**
 * All the documents on one email together. Resend takes up to 40 MB per
 * email once attachments are base64-encoded (a third larger); this leaves
 * room for the message.
 */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const MAX_SUBJECT_LENGTH = 300;
export const MAX_BODY_LENGTH = 50_000;

const ID_RE = /^[A-Za-z0-9_-]{1,200}$/;
const SEND_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

export function emailConfig() {
  return { enabled: emailEnabled(), maxFiles: MAX_ATTACHMENTS, maxBytes: MAX_ATTACHMENT_BYTES, maxFileBytes: MAX_FILE_BYTES };
}

type Data = Record<string, unknown>;

interface SendRequest {
  contactId: string;
  fileIds: string[];
  subject: string;
  body: string;
  sendId: string;
  aircraftId: string | null;
  opportunityId: string | null;
}

function parse(raw: unknown): SendRequest {
  const b = (raw ?? {}) as Record<string, unknown>;
  const id = (v: unknown) => (typeof v === 'string' && ID_RE.test(v) ? v : null);
  const contactId = id(b.contactId);
  if (!contactId) throw new HttpError(400, 'Say which customer the email is for');
  if (!Array.isArray(b.fileIds)) throw new HttpError(400, 'Say which documents to attach');
  const fileIds = b.fileIds.map(id);
  if (fileIds.some((f) => f === null)) throw new HttpError(400, 'Say which documents to attach');
  if (new Set(fileIds).size !== fileIds.length) throw new HttpError(400, 'A document is attached twice');
  if (fileIds.length > MAX_ATTACHMENTS) {
    throw new HttpError(413, `Attach at most ${MAX_ATTACHMENTS} documents to one email`);
  }
  // A subject is one line: a line break in it could start a new mail header.
  const subject = (typeof b.subject === 'string' ? b.subject : '').replace(/[\r\n\t]+/g, ' ').trim();
  if (!subject) throw new HttpError(400, 'Add a subject');
  if (subject.length > MAX_SUBJECT_LENGTH) throw new HttpError(400, 'The subject is too long');
  const body = typeof b.body === 'string' ? b.body.replace(/\r\n?/g, '\n') : '';
  if (!body.trim()) throw new HttpError(400, 'Add a message');
  if (body.length > MAX_BODY_LENGTH) throw new HttpError(400, 'The message is too long');
  if (typeof b.sendId !== 'string' || !SEND_ID_RE.test(b.sendId)) throw new HttpError(400, 'Missing send id');
  return {
    contactId, fileIds: fileIds as string[], subject, body, sendId: b.sendId,
    aircraftId: id(b.aircraftId), opportunityId: id(b.opportunityId),
  };
}

async function records(collection: string, where: string, params: unknown[]): Promise<Data[]> {
  const { rows } = await getPool().query<{ data: Data }>(
    `select data from app_record where collection = $1 and data is not null and (${where})`,
    [collection, ...params],
  );
  return rows.map((r) => r.data);
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/**
 * What is on a customer's profile, read from what is stored: their own
 * records, the aircraft they own now, their deals, and the policies on any of
 * those. The same rule as documentsFor({ contactId }) in src/lib/selectors.ts,
 * which decides what the profile shows; the tests hold the two together.
 */
export async function profileScope(contactId: string) {
  const aircraft = (await records(
    'aircraft',
    `data->'ownerships' @> jsonb_build_array(jsonb_build_object('contactId', $2::text))`,
    [contactId],
  )).filter((a) => Array.isArray(a.ownerships)
    && (a.ownerships as Data[]).some((o) => o?.contactId === contactId && !o.endedAt));
  const aircraftIds = aircraft.map((a) => String(a.id));
  const opportunityIds = (await records('opportunities', `data->>'contactId' = $2`, [contactId])).map((o) => String(o.id));
  const policyIds = (await records(
    'policies',
    `data->>'contactId' = $2 or data->>'aircraftId' = any($3::text[]) or data->>'opportunityId' = any($4::text[])`,
    [contactId, aircraftIds, opportunityIds],
  )).map((p) => String(p.id));
  return {
    aircraftIds: new Set(aircraftIds),
    opportunityIds: new Set(opportunityIds),
    policyIds: new Set(policyIds),
    has(file: Data): boolean {
      const contact = str(file.contactId);
      const plane = str(file.aircraftId);
      const deal = str(file.opportunityId);
      const policy = str(file.insurancePolicyId);
      return contact === contactId
        || (plane !== null && this.aircraftIds.has(plane))
        || (deal !== null && this.opportunityIds.has(deal))
        || (policy !== null && this.policyIds.has(policy));
    },
  };
}

/** The whole file, or null once it is past `limit` bytes; the rest is never read. */
async function readCapped(body: ReadableStream<Uint8Array> | Uint8Array, limit: number): Promise<Uint8Array | null> {
  if (body instanceof Uint8Array) return body.length > limit ? null : body;
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > limit) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** A name for the From line: the sender's own, with nothing that could break the header. */
function fromLine(senderName: string): string | undefined {
  const configured = process.env.EMAIL_FROM || process.env.DIGEST_FROM;
  if (!configured) return undefined;
  const address = /<([^<>\s]+@[^<>\s]+)>/.exec(configured)?.[1] ?? configured.trim();
  const name = senderName.replace(/["\\<>\r\n,;:]/g, '').trim();
  return name ? `"${name} via AEROBOOK" <${address}>` : configured;
}

export interface SendResult {
  sentTo: string;
  attachments: { fileId: string; name: string; size: number }[];
  /** The Email activity recorded on the customer, or null when it could not be written. */
  activityId: string | null;
}

export async function sendCustomerEmail(user: SessionUser, raw: unknown): Promise<SendResult> {
  const req = parse(raw);

  const [contact] = await records('contacts', 'id = $2', [req.contactId]);
  if (!contact) throw new HttpError(404, 'That customer is no longer in AEROBOOK');
  const to = normalizeEmail(str(contact.email));
  if (!isValidEmail(to)) {
    throw new HttpError(422, 'This customer has no working email address on their profile. Add one, then try again.');
  }

  const scope = await profileScope(req.contactId);
  const files = await records('files', 'id = any($2::text[])', [req.fileIds]);
  const byId = new Map(files.map((f) => [String(f.id), f]));

  // Checked in full before anything is read or sent: one document that may
  // not go stops the whole email.
  const chosen = req.fileIds.map((fileId) => {
    const file = byId.get(fileId);
    // Not stored, deleted, or on someone else's profile: all look the same.
    if (!file || !scope.has(file)) {
      throw new HttpError(404, 'One of the documents is not on this customer’s profile any more. Close the email and try again.');
    }
    const name = (str(file.name) ?? 'document').replace(/[\u0000-\u001f\u007f/\\"]/g, ' ').trim() || 'document';
    const path = str(file.blobPath);
    if (!path || !isFilePath(path)) {
      throw new HttpError(409, `“${name}” is still only on the device it was added from, so it cannot be sent yet.`);
    }
    const type = (str(file.mimeType) ?? '').split(';')[0].trim().toLowerCase();
    if (!ALLOWED_DOCUMENT_TYPES.includes(type)) {
      throw new HttpError(415, `“${name}” is not a kind of file AEROBOOK sends.`);
    }
    const recorded = typeof file.size === 'number' ? file.size : 0;
    if (recorded > MAX_FILE_BYTES) throw new HttpError(413, `“${name}” is too large to email.`);
    return { fileId, name, type, path, recorded };
  });
  if (chosen.reduce((sum, f) => sum + f.recorded, 0) > MAX_ATTACHMENT_BYTES) {
    throw new HttpError(413, `Those documents come to more than ${formatBytes(MAX_ATTACHMENT_BYTES)}, too much for one email. Send fewer at a time.`);
  }

  if (!emailEnabled()) throw new HttpError(503, 'Sending email is not set up on this deployment yet.');

  // The recorded size came from a browser; the bytes are what count.
  const attachments: EmailAttachment[] = [];
  let total = 0;
  for (const f of chosen) {
    const stored = await readStored(f.path);
    if (!stored) throw new HttpError(404, `“${f.name}” could not be found in storage, so nothing was sent.`);
    const content = await readCapped(stored.body, Math.min(MAX_FILE_BYTES, MAX_ATTACHMENT_BYTES - total));
    if (!content) {
      throw new HttpError(413, `Those documents come to more than ${formatBytes(MAX_ATTACHMENT_BYTES)}, too much for one email. Send fewer at a time.`);
    }
    total += content.length;
    attachments.push({ filename: f.name, contentType: f.type, content });
  }

  const replyTo = isValidEmail(user.email) ? user.email : undefined;
  try {
    await sendEmail(
      to,
      { subject: req.subject, text: req.body },
      // A retried request (a dropped connection, a double tap) sends once.
      `customer-email/${user.id}/${req.sendId}`,
      { from: fromLine(user.name), replyTo, attachments },
    );
  } catch (e) {
    if (!(e instanceof EmailError)) throw e;
    // Who and how it failed, never what was in it.
    console.error(`customer email not sent: ${e.kind}${e.status ? ` (${e.status})` : ''}`);
    if (e.kind === 'disabled') throw new HttpError(503, 'Sending email is not set up on this deployment yet.');
    if (e.kind === 'too-large') {
      throw new HttpError(413, 'The email service would not take attachments that large. Send fewer documents at a time.');
    }
    throw new HttpError(502, 'The email could not be sent just now. Nothing was sent; try again in a minute.');
  }

  const sent = chosen.map((f, i) => ({ fileId: f.fileId, name: f.name, size: attachments[i].content.length }));
  return { sentTo: to, attachments: sent, activityId: await recordSent(user, req, contact, to, sent, scope) };
}

/**
 * The Email activity on the customer, through the same write as any other
 * change so it is versioned, synced and in the activity history. The email
 * has gone by now, so a failure here is reported rather than thrown.
 */
async function recordSent(
  user: SessionUser,
  req: SendRequest,
  contact: Data,
  to: string,
  sent: SendResult['attachments'],
  scope: Awaited<ReturnType<typeof profileScope>>,
): Promise<string | null> {
  // The same send always makes the same record: a retry cannot record twice.
  const id = `act_em${createHash('sha256').update(`${user.id}\u0000${req.sendId}`).digest('hex').slice(0, 24)}`;
  const now = new Date().toISOString();
  const header = [
    `Sent from AEROBOOK by ${user.name} to ${to}.`,
    ...(sent.length ? [`Attached: ${sent.map((f) => `${f.name} (${formatBytes(f.size)})`).join(', ')}`] : []),
  ];
  const data = {
    id,
    contactId: String(contact.id),
    aircraftId: req.aircraftId && scope.aircraftIds.has(req.aircraftId) ? req.aircraftId : null,
    opportunityId: req.opportunityId && scope.opportunityIds.has(req.opportunityId) ? req.opportunityId : null,
    type: 'Email',
    date: now,
    subject: req.subject,
    notes: `${header.join('\n')}\n\n${req.body}`,
    attachments: sent.map(({ fileId, name }) => ({ fileId, name })),
    createdAt: now,
  };
  try {
    const result = await push(user, [{ collection: 'activities', id, data, baseVersion: 0 }]);
    // A conflict is this same send, recorded by an earlier try.
    return result.applied.length || result.conflicts.length ? id : null;
  } catch (e) {
    console.error('customer email sent but not recorded:', (e as Error).message);
    return null;
  }
}
