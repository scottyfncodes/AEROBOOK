/**
 * Emailing a customer with documents from their profile attached: who may,
 * which documents may go and to whom, that the file itself reaches the email
 * service, what is recorded, and that a failure says so plainly and sends
 * nothing. Resend is replaced by a recording fetch; documents are kept in the
 * local-disk store.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, createUser, freshDatabase, signIn, TEST_DB } from './testing.js';
import { getPool } from './db.js';
import { MAX_FILE_BYTES, putLocal } from './files.js';
import { MAX_ATTACHMENTS } from './customer-email.js';
import { documentsFor } from '../src/lib/selectors.js';
import type { Database } from '../src/data/types.js';

const PDF = new TextEncoder().encode('%PDF-1.4 insurance binder');
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5]);
const T = '2026-09-01T00:00:00.000Z';

interface Sent {
  from: string;
  to: string[];
  subject: string;
  text: string;
  html?: string;
  reply_to?: string;
  attachments?: { filename: string; content: string; content_type: string }[];
  key: string | null;
}

const file = (id: string, links: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  id, name: `${id}.pdf`, mimeType: 'application/pdf', size: PDF.length, contactId: null, aircraftId: null,
  opportunityId: null, insurancePolicyId: null, blobPath: `files/${id}/${id}.pdf`, createdAt: T, ...links, ...extra,
});

/** Customer A with documents on them, their aircraft, deal and policy; customer B with one of their own. */
const FIXTURE = {
  contacts: [
    { id: 'con_a', firstName: 'Ann', lastName: 'Archer', email: 'ann@customer-a.com' },
    { id: 'con_b', firstName: 'Ben', lastName: 'Baker', email: 'ben@customer-b.com' },
    { id: 'con_none', firstName: 'No', lastName: 'Email', email: '' },
  ],
  aircraft: [
    { id: 'air_a', tailNumber: 'N1A', ownerships: [{ contactId: 'con_a', startedAt: T }] },
    // Ann sold this one; its documents are no longer on her profile.
    { id: 'air_sold', tailNumber: 'N2A', ownerships: [{ contactId: 'con_a', startedAt: T, endedAt: T }, { contactId: 'con_b', startedAt: T }] },
  ],
  opportunities: [{ id: 'opp_a', title: 'Hull quote', contactId: 'con_a', aircraftId: null }],
  policies: [{ id: 'pol_a', carrier: 'Global', contactId: null, aircraftId: 'air_a', opportunityId: null }],
  files: [
    file('fil_ann1', { contactId: 'con_a' }),
    file('fil_ann2', { aircraftId: 'air_a' }, { name: 'Photo.jpg', mimeType: 'image/jpeg', size: JPEG.length, blobPath: 'files/fil_ann2/Photo.jpg' }),
    file('fil_ann3', { insurancePolicyId: 'pol_a' }),
    file('fil_ann4', { opportunityId: 'opp_a' }),
    file('fil_ben1', { contactId: 'con_b' }),
    file('fil_sold', { aircraftId: 'air_sold' }),
    file('fil_none', { contactId: 'con_none' }),
    // Added offline and never moved up to cloud storage.
    file('fil_device', { contactId: 'con_a' }, { blobPath: undefined }),
    // A record claiming a kind of file AEROBOOK does not keep.
    file('fil_html', { contactId: 'con_a' }, { name: 'page.html', mimeType: 'text/html', blobPath: 'files/fil_html/page.html' }),
    // Recorded, but its file is not in storage.
    file('fil_gone', { contactId: 'con_a' }),
  ],
};

describe.skipIf(!TEST_DB)('emailing a customer with documents attached', () => {
  let dir: string;
  let alice: string;
  let aliceId: string;
  let sent: Sent[];
  let reply: () => Response;
  let seq = 0;

  const send = (body: Record<string, unknown>, cookie = alice) =>
    api('/api/email/send', {
      cookie,
      body: { contactId: 'con_a', subject: 'Your binder', body: 'Hi Ann,\n\nAttached.\n\nAlice', sendId: `send_${++seq}_abcdef`, ...body },
    });
  const activities = async () =>
    (await getPool().query<{ data: Record<string, unknown> }>(
      `select data from app_record where collection = 'activities' and data is not null order by seq`,
    )).rows.map((r) => r.data);
  const decode = (b64: string) => new Uint8Array(Buffer.from(b64, 'base64'));

  beforeEach(async () => {
    await freshDatabase();
    dir = await mkdtemp(join(tmpdir(), 'aerobook-email-'));
    process.env.FILES_DIR = dir;
    process.env.RESEND_API_KEY = 're_test_key';
    sent = [];
    reply = () => new Response(JSON.stringify({ id: 'email_1' }), { status: 200 });
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) !== 'https://api.resend.com/emails') return realFetch(input, init);
      sent.push({ ...JSON.parse(String(init?.body)), key: new Headers(init?.headers).get('idempotency-key') });
      return reply();
    });

    aliceId = (await createUser('Alice Agent', 'alice@broker.com')).id;
    await createUser('Bob', 'bob@broker.com');
    alice = await signIn('alice@broker.com');
    const changes = Object.entries(FIXTURE).flatMap(([collection, list]) =>
      list.map((data) => ({ collection, id: data.id, data, baseVersion: 0 })));
    expect((await api('/api/sync', { cookie: alice, body: { changes } })).status).toBe(200);
    for (const f of FIXTURE.files) {
      if (!f.blobPath || f.id === 'fil_gone') continue;
      await putLocal(f.blobPath, f.id === 'fil_ann2' ? JPEG : PDF);
    }
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    for (const k of ['FILES_DIR', 'RESEND_API_KEY', 'EMAIL_FROM', 'DIGEST_FROM']) delete process.env[k];
    await rm(dir, { recursive: true, force: true });
  });

  describe('who may send', () => {
    it('is closed to anyone signed out', async () => {
      expect((await api('/api/email/config')).status).toBe(401);
      expect((await send({ fileIds: ['fil_ann1'] }, '')).status).toBe(401);
      expect(sent).toEqual([]);
    });

    it('is closed to someone whose access was turned off after signing in', async () => {
      const bob = await signIn('bob@broker.com');
      await getPool().query(`update "user" set banned = true where email = 'bob@broker.com'`);
      expect((await send({ fileIds: ['fil_ann1'] }, bob)).status).toBe(401);
      expect(sent).toEqual([]);
    });

    it('refuses a request from another site, or not a POST', async () => {
      const foreign = await api('/api/email/send', {
        cookie: alice, headers: { origin: 'https://evil.example' },
        body: { contactId: 'con_a', fileIds: ['fil_ann1'], subject: 's', body: 'b', sendId: 'send_foreign_1' },
      });
      expect(foreign.status).toBe(403);
      const get = await api('/api/email/send', { cookie: alice });
      expect(get.status).toBe(405);
      expect(sent).toEqual([]);
    });

    it('lets anyone on the team send, as with opening a document', async () => {
      const bob = await signIn('bob@broker.com');
      expect((await send({ fileIds: ['fil_ann1'] }, bob)).status).toBe(200);
      expect(sent).toHaveLength(1);
    });

    it('says whether sending is set up, and its limits', async () => {
      expect(await (await api('/api/email/config', { cookie: alice })).json())
        .toEqual({ enabled: true, maxFiles: MAX_ATTACHMENTS, maxBytes: 25 * 1024 * 1024, maxFileBytes: MAX_FILE_BYTES });
      delete process.env.RESEND_API_KEY;
      expect((await (await api('/api/email/config', { cookie: alice })).json()).enabled).toBe(false);
    });
  });

  describe('sending', () => {
    it('sends the stored file itself as an attachment, to the address on the profile', async () => {
      const r = await send({ fileIds: ['fil_ann1'] });
      expect(r.status).toBe(200);
      const result = await r.json();
      expect(result.sentTo).toBe('ann@customer-a.com');
      expect(result.attachments).toEqual([{ fileId: 'fil_ann1', name: 'fil_ann1.pdf', size: PDF.length }]);

      expect(sent).toHaveLength(1);
      const [mail] = sent;
      expect(mail.to).toEqual(['ann@customer-a.com']);
      expect(mail.subject).toBe('Your binder');
      expect(mail.text).toBe('Hi Ann,\n\nAttached.\n\nAlice');
      expect(mail.reply_to).toBe('alice@broker.com');
      expect(mail.key).toMatch(new RegExp(`^customer-email/${aliceId}/send_`));
      expect(mail.attachments).toHaveLength(1);
      expect(mail.attachments![0].filename).toBe('fil_ann1.pdf');
      expect(mail.attachments![0].content_type).toBe('application/pdf');
      expect(decode(mail.attachments![0].content)).toEqual(PDF);
      // Never a link to the file, and nothing about where it is stored.
      expect(JSON.stringify(mail)).not.toMatch(/files\/fil_|blob|https?:\/\//i);
    });

    it('attaches several documents, from the customer and their aircraft, deal and policy', async () => {
      const r = await send({ fileIds: ['fil_ann1', 'fil_ann2', 'fil_ann3', 'fil_ann4'] });
      expect(r.status).toBe(200);
      const attachments = sent[0].attachments!;
      expect(attachments.map((a) => a.filename)).toEqual(['fil_ann1.pdf', 'Photo.jpg', 'fil_ann3.pdf', 'fil_ann4.pdf']);
      expect(attachments[1].content_type).toBe('image/jpeg');
      expect(decode(attachments[1].content)).toEqual(JPEG);
    });

    it('sends from EMAIL_FROM in the sender’s name', async () => {
      process.env.EMAIL_FROM = 'AEROBOOK <mail@broker.com>';
      await send({ fileIds: ['fil_ann1'] });
      expect(sent[0].from).toBe('"Alice Agent via AEROBOOK" <mail@broker.com>');
    });

    it('keeps the subject to one line', async () => {
      await send({ fileIds: ['fil_ann1'], subject: 'Binder\r\nBcc: someone@evil.example' });
      expect(sent[0].subject).toBe('Binder Bcc: someone@evil.example');
    });

    it('refuses an email with no subject or message, too many documents, or one twice', async () => {
      expect((await send({ fileIds: ['fil_ann1'], subject: '  ' })).status).toBe(400);
      expect((await send({ fileIds: ['fil_ann1'], body: '' })).status).toBe(400);
      expect((await send({ fileIds: ['fil_ann1', 'fil_ann1'] })).status).toBe(400);
      const many = Array.from({ length: MAX_ATTACHMENTS + 1 }, (_, i) => `fil_x${i}`);
      expect((await send({ fileIds: many })).status).toBe(413);
      expect((await send({ fileIds: 'fil_ann1' })).status).toBe(400);
      expect((await send({ fileIds: ['fil_ann1'], sendId: 'x' })).status).toBe(400);
      expect(sent).toEqual([]);
    });
  });

  describe('only this customer’s documents, only to this customer', () => {
    it('refuses a document on another customer’s profile, and sends nothing', async () => {
      const r = await send({ fileIds: ['fil_ben1'] });
      expect(r.status).toBe(404);
      expect((await r.json()).error).toMatch(/not on this customer’s profile/);
      expect(sent).toEqual([]);
      expect(await activities()).toEqual([]);
    });

    it('refuses the whole email when one document among several is another customer’s', async () => {
      expect((await send({ fileIds: ['fil_ann1', 'fil_ben1', 'fil_ann2'] })).status).toBe(404);
      expect(sent).toEqual([]);
    });

    it('refuses the documents of an aircraft the customer no longer owns', async () => {
      expect((await send({ fileIds: ['fil_sold'] })).status).toBe(404);
      // The new owner may have them.
      expect((await send({ contactId: 'con_b', fileIds: ['fil_sold'] })).status).toBe(200);
      expect(sent.map((m) => m.to)).toEqual([['ben@customer-b.com']]);
    });

    it('ignores an address the browser names: it goes to the one on the profile', async () => {
      const r = await send({ fileIds: ['fil_ann1'], to: 'thief@evil.example', cc: 'thief@evil.example', bcc: 'x@evil.example' });
      expect(r.status).toBe(200);
      expect(sent[0].to).toEqual(['ann@customer-a.com']);
      expect(JSON.stringify(sent[0])).not.toContain('evil.example');
    });

    it('rejects a made-up, malformed or swapped id', async () => {
      expect((await send({ fileIds: ['fil_nope'] })).status).toBe(404);
      expect((await send({ fileIds: ["fil_ann1' or '1'='1"] })).status).toBe(400);
      expect((await send({ fileIds: [{ id: 'fil_ann1' }] })).status).toBe(400);
      expect((await send({ contactId: 'con_nope', fileIds: ['fil_ann1'] })).status).toBe(404);
      expect((await send({ contactId: '../con_a', fileIds: ['fil_ann1'] })).status).toBe(400);
      // Customer B's id with customer A's document.
      expect((await send({ contactId: 'con_b', fileIds: ['fil_ann1'] })).status).toBe(404);
      expect(sent).toEqual([]);
    });

    it('refuses a customer with no working email address', async () => {
      const r = await send({ contactId: 'con_none', fileIds: ['fil_none'] });
      expect(r.status).toBe(422);
      expect((await r.json()).error).toMatch(/no working email address/);
      expect(sent).toEqual([]);
    });

    it('accepts exactly the documents the customer’s profile shows', async () => {
      const db = { ...FIXTURE, files: FIXTURE.files } as unknown as Database;
      const shown = new Set(documentsFor(db, { contactId: 'con_a' }).map((d) => d.file.id));
      for (const f of FIXTURE.files) {
        const status = (await send({ fileIds: [f.id] })).status;
        // 404 is "not on this profile"; anything else got past that check.
        expect({ id: f.id, onProfile: status !== 404 || f.id === 'fil_gone' }).toEqual({ id: f.id, onProfile: shown.has(f.id) });
      }
    });
  });

  describe('documents that cannot go', () => {
    it('refuses a deleted document', async () => {
      const r = await api('/api/sync', { cookie: alice, body: { changes: [{ collection: 'files', id: 'fil_ann1', data: null, baseVersion: 1 }] } });
      expect((await r.json()).applied).toHaveLength(1);
      expect((await send({ fileIds: ['fil_ann1'] })).status).toBe(404);
      expect(sent).toEqual([]);
    });

    it('says when a document is missing from storage, and sends nothing', async () => {
      const r = await send({ fileIds: ['fil_ann1', 'fil_gone'] });
      expect(r.status).toBe(404);
      expect((await r.json()).error).toBe('“fil_gone.pdf” could not be found in storage, so nothing was sent.');
      expect(sent).toEqual([]);
    });

    it('says when a document is still only on the device it was added from', async () => {
      const r = await send({ fileIds: ['fil_device'] });
      expect(r.status).toBe(409);
      expect((await r.json()).error).toMatch(/only on the device/);
    });

    it('refuses a kind of file AEROBOOK does not keep', async () => {
      expect((await send({ fileIds: ['fil_html'] })).status).toBe(415);
      expect(sent).toEqual([]);
    });

    it('refuses documents that together are too large to email', async () => {
      const big = Math.floor(MAX_FILE_BYTES * 0.6);
      await api('/api/sync', {
        cookie: alice,
        body: {
          changes: [
            { collection: 'files', id: 'fil_ann1', data: { ...FIXTURE.files[0], size: big }, baseVersion: 1 },
            { collection: 'files', id: 'fil_ann3', data: { ...FIXTURE.files[2], size: big }, baseVersion: 1 },
          ],
        },
      });
      const r = await send({ fileIds: ['fil_ann1', 'fil_ann3'] });
      expect(r.status).toBe(413);
      expect((await r.json()).error).toMatch(/too much for one email/);
      expect(sent).toEqual([]);
    });

    it('goes by the bytes stored, not the size the record claims', async () => {
      await putLocal('files/fil_ann1/fil_ann1.pdf', new Uint8Array(MAX_FILE_BYTES + 1));
      const r = await send({ fileIds: ['fil_ann1'] });
      expect(r.status).toBe(413);
      expect(sent).toEqual([]);
    });
  });

  describe('when the email service fails', () => {
    it('explains a size refusal without passing on the service’s words', async () => {
      reply = () => new Response(JSON.stringify({ message: 'Attachments exceed 40MB internal-id-123' }), { status: 413 });
      const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const r = await send({ fileIds: ['fil_ann1'] });
      expect(r.status).toBe(413);
      const { error } = await r.json();
      expect(error).toMatch(/would not take attachments that large/);
      expect(error).not.toContain('internal-id');
      expect(await activities()).toEqual([]);
      // What was logged says how it failed, never what was in the email.
      const logged = spy.mock.calls.flat().join(' ');
      expect(logged).not.toContain('PDF-1.4');
      expect(logged).not.toContain('Hi Ann');
      spy.mockRestore();
    });

    it('says plainly that nothing was sent when the service refuses or is down', async () => {
      reply = () => new Response(JSON.stringify({ message: 'The domain is not verified' }), { status: 403 });
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const r = await send({ fileIds: ['fil_ann1'] });
      expect(r.status).toBe(502);
      expect((await r.json()).error).toBe('The email could not be sent just now. Nothing was sent; try again in a minute.');
      expect(await activities()).toEqual([]);
    });

    it('says when sending is not set up, without reading anything', async () => {
      delete process.env.RESEND_API_KEY;
      const r = await send({ fileIds: ['fil_ann1'] });
      expect(r.status).toBe(503);
      expect(sent).toEqual([]);
    });
  });

  describe('what is recorded', () => {
    it('records an Email activity on the customer, with the documents and who sent it', async () => {
      await send({ fileIds: ['fil_ann1', 'fil_ann2'], aircraftId: 'air_a', opportunityId: 'opp_b_is_not_hers' });
      const [activity] = await activities();
      expect(activity).toMatchObject({
        contactId: 'con_a',
        aircraftId: 'air_a',
        // Not one of hers, so not linked.
        opportunityId: null,
        type: 'Email',
        subject: 'Your binder',
        attachments: [{ fileId: 'fil_ann1', name: 'fil_ann1.pdf' }, { fileId: 'fil_ann2', name: 'Photo.jpg' }],
      });
      expect(activity.notes).toBe(
        `Sent from AEROBOOK by Alice Agent to ann@customer-a.com.\nAttached: fil_ann1.pdf (${PDF.length} B), Photo.jpg (${JPEG.length} B)\n\nHi Ann,\n\nAttached.\n\nAlice`,
      );
      const { rows } = await getPool().query(
        `select user_id, user_name, action, summary from app_audit where collection = 'activities'`,
      );
      expect(rows).toEqual([{ user_id: aliceId, user_name: 'Alice Agent', action: 'create', summary: 'Your binder' }]);
    });

    it('reaches everyone’s app through the usual sync', async () => {
      const bob = await signIn('bob@broker.com');
      await send({ fileIds: ['fil_ann1'] });
      const pulled = await (await api('/api/sync?since=0', { cookie: bob })).json();
      expect(pulled.records.filter((r: { collection: string }) => r.collection === 'activities')).toHaveLength(1);
    });

    it('sends and records a retried request once', async () => {
      const body = { fileIds: ['fil_ann1'], sendId: 'send_retry_123456' };
      expect((await send(body)).status).toBe(200);
      expect((await send(body)).status).toBe(200);
      // Resend sends a repeated idempotency key once.
      expect(sent.map((m) => m.key)).toEqual([`customer-email/${aliceId}/send_retry_123456`, `customer-email/${aliceId}/send_retry_123456`]);
      expect(await activities()).toHaveLength(1);
    });
  });

  describe('what was there before', () => {
    it('still serves a document for download as it did', async () => {
      await send({ fileIds: ['fil_ann1'] });
      const r = await api(`/api/files/content?path=${encodeURIComponent('files/fil_ann1/fil_ann1.pdf')}`, { cookie: alice });
      expect(r.status).toBe(200);
      expect(new Uint8Array(await r.arrayBuffer())).toEqual(PDF);
      expect(r.headers.get('content-disposition')).toMatch(/^attachment;/);
    });

    it('sends the daily email exactly as before: no attachments, no reply-to', async () => {
      const r = await api('/api/digest/send', { cookie: alice, body: {} });
      expect(r.status).toBe(200);
      expect(sent).toHaveLength(1);
      const { key, ...payload } = sent[0];
      expect(key).toBeNull();
      expect(Object.keys(payload)).toEqual(['from', 'to', 'subject', 'html', 'text']);
      expect(payload.to).toEqual(['alice@broker.com']);
    });
  });
});
