/**
 * The company data export, end to end: records saved by two people, a
 * document in storage, comments and the audit log, exported through the
 * same code an admin's browser runs, unzipped, and read back. Uses the
 * local-disk document store.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { api, createUser, freshDatabase, ORIGIN, signIn, TEST_DB } from './testing.js';
import { handle } from './app.js';
import { getPool } from './db.js';
import * as store from '../src/data/store';
import * as persistence from '../src/data/db';
import { CloudSync, type CloudUser } from '../src/data/cloud';
import { exportCompanyData } from '../src/data/companyExport';
import { parseCsv } from '../src/lib/csv';
import { unzip } from '../src/lib/zip';

function deviceFetch(cookie: string): typeof fetch {
  return (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set('cookie', cookie);
    headers.set('origin', ORIGIN);
    return handle(new Request(`${ORIGIN}${String(input)}`, { ...init, headers }));
  };
}

async function body<T = Record<string, any>>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

const T0 = '2026-09-01T09:00:00.000Z';
const contact = (id: string, over: Record<string, unknown>) => ({
  id, firstName: '', lastName: '', rawName: '', company: '', email: '', phone: '', address: '', city: '', state: '',
  zip: '', contactTypes: [], status: 'Prospect', prospectStatus: 'New', notes: '', custom: {}, nameConfidence: 'high',
  needsReview: false, createdAt: T0, updatedAt: T0, ...over,
});
const aircraft = (id: string, tailNumber: string, ownerships: unknown[]) => ({
  id, tailNumber, tailKey: tailNumber.replace(/^N/, ''), year: '2019', make: 'Cirrus', model: 'SR22T', ownerships,
  status: 'Owned', notes: '', custom: {}, createdAt: T0, updatedAt: T0,
});

describe.skipIf(!TEST_DB)('company data export', () => {
  let dir: string;
  let admin: CloudUser;
  let adminCookie: string;
  let bobCookie: string;
  let bobId: string;
  let cloud: CloudSync;

  const save = (cookie: string, collection: string, data: Record<string, unknown>) =>
    api('/api/sync', { cookie, body: { changes: [{ collection, id: data.id, data, baseVersion: 0 }] } });

  beforeEach(async () => {
    await freshDatabase();
    dir = await mkdtemp(join(tmpdir(), 'aerobook-export-'));
    process.env.FILES_DIR = dir;
    await store.unload();
    await persistence.clearAll();
    const a = await createUser('Scott Lawrence', 'scott@example.com', 'admin');
    bobId = (await createUser('Bob Teammate', 'bob@example.com')).id;
    admin = { id: a.id, name: a.name, email: a.email, role: 'admin' };
    adminCookie = await signIn('scott@example.com');
    bobCookie = await signIn('bob@example.com');
    cloud = new CloudSync(admin, deviceFetch(adminCookie));
  });

  afterEach(async () => {
    cloud.stop();
    await store.unload();
    delete process.env.FILES_DIR;
    await rm(dir, { recursive: true, force: true });
  });

  /** Two customers, their aircraft, a note, a call, a task, a policy, a deal, a comment and a document. */
  async function seed() {
    await save(adminCookie, 'contacts', contact('con_renee', {
      firstName: 'Renée', lastName: 'Ødegård', company: 'Société Générale Aviation, Inc.', email: 'renee@example.fr',
      phone: '+33 1 23 45 67 89', city: 'Zürich', notes: 'Prefers "early" calls,\nnever Fridays. 東京に来週',
      custom: { 'Fleet size': '3' }, intent: { selling: 'Maybe', buying: 'Actively', insurance: 'Unknown', budget: '$2M' },
    }));
    await save(adminCookie, 'contacts', contact('con_acme', { company: 'Acme Flight LLC', nameConfidence: 'organization', email: 'ops@acme.example' }));
    await save(adminCookie, 'aircraft', aircraft('air_1', 'N123AB', [{ contactId: 'con_renee' }]));
    await save(adminCookie, 'aircraft', aircraft('air_2', 'N456CD', [
      { contactId: 'con_renee', endedAt: '2026-06-30' }, { contactId: 'con_acme', startedAt: '2026-07-01' },
    ]));
    await save(bobCookie, 'activities', {
      id: 'act_note', contactId: 'con_renee', aircraftId: 'air_1', opportunityId: null, type: 'Note',
      date: '2026-09-02T15:30:00.000Z', subject: 'Hangar visit', notes: 'Wants =SUM(A1) quoted; ½ share? ✈️',
      createdAt: '2026-09-02T15:31:00.000Z',
    });
    await save(adminCookie, 'activities', {
      id: 'act_call', contactId: 'con_acme', aircraftId: 'air_2', opportunityId: 'opp_1', type: 'Call',
      date: '2026-09-03T10:00:00-07:00', subject: 'Renewal call', notes: 'Left a voicemail', createdAt: T0,
    });
    await save(adminCookie, 'opportunities', {
      id: 'opp_1', contactId: 'con_acme', aircraftId: 'air_2', type: 'Insurance', status: 'Quoting', title: 'N456CD renewal',
      openedAt: '2026-09-01', notes: 'Hull up 5%', createdAt: T0, updatedAt: T0,
    });
    await save(adminCookie, 'policies', {
      id: 'pol_1', aircraftId: 'air_2', contactId: 'con_acme', opportunityId: 'opp_1', carrier: 'Global Aerospace',
      policyNumber: 'GA-1', brokerAgent: '', expirationDate: '2026-11-15', premium: '$8,200', hullValue: '', liabilityLimit: '',
      deductible: '', status: 'Unknown', quotedPremium: '', renewalNotes: 'Shop it', notes: '', createdAt: T0, updatedAt: T0,
    });
    await save(adminCookie, 'followUps', {
      id: 'fup_quote', contactId: 'con_renee', aircraftId: 'air_1', opportunityId: null, dueDate: '2026-09-10', kind: 'quote',
      note: 'Hull and liability', priority: 'High', assigneeId: bobId, assignedBy: admin.id, completed: false,
      createdAt: T0, updatedAt: T0,
    });
    await api('/api/aircraft/air_1/comments', { cookie: bobCookie, body: { body: 'Annual due in März — check logs' } });

    await cloud.start();
    const file = await store.addFile(new File(['%PDF-1.4 binder for Renée'], 'Assurance — Ødegård.pdf', { type: 'application/pdf' }),
      { contactId: 'con_renee', aircraftId: 'air_1' }, 'Insurance');
    await store.flush();
    return file;
  }

  async function exportAs(cookie: string) {
    const result = await exportCompanyData(undefined, deviceFetch(cookie));
    const files = unzip(new Uint8Array(await result.blob.arrayBuffer()));
    const byName = new Map(files.map((f) => [f.path.replace(/^AEROBOOK-Company-Export\//, ''), f.data]));
    const textOf = (name: string) => new TextDecoder().decode(byName.get(name));
    const csv = (name: string) => {
      // UTF-8 with a byte-order mark, so Excel reads accents as they are. (TextDecoder drops it.)
      expect([...byName.get(name)!.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
      const { headers, rows } = parseCsv(textOf(name));
      return rows.map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ''])));
    };
    return { result, files, byName, textOf, csv };
  }

  it('gives an admin the whole company, with every relationship intact', async () => {
    const file = await seed();
    const { result, byName, csv, textOf } = await exportAs(adminCookie);

    expect([...byName.keys()].filter((n) => !n.startsWith('documents/')).sort()).toEqual([
      'README.txt', 'activities.csv', 'aerobook-backup.json', 'aircraft-comments.csv', 'aircraft-ownership.csv',
      'aircraft.csv', 'audit-log.csv', 'contacts.csv', 'documents.csv', 'email-templates.csv', 'imports.csv',
      'insurance-policies.csv', 'notes.csv', 'opportunities.csv', 'tasks.csv', 'users.csv',
    ]);

    // Customers and contacts, with special characters exactly as typed.
    const contacts = csv('contacts.csv');
    const renee = contacts.find((c) => c['Contact ID'] === 'con_renee')!;
    expect(renee).toMatchObject({
      'Display name': 'Renée Ødegård', Company: 'Société Générale Aviation, Inc.', City: 'Zürich',
      Notes: 'Prefers "early" calls,\nnever Fridays. 東京に来週', 'Current aircraft IDs': 'air_1', 'Current aircraft': 'N123AB',
      'Buying interest': 'Actively', Budget: '$2M', 'Other fields (JSON)': '{"Fleet size":"3"}', 'Recorded by': 'Scott Lawrence',
      'Person or organization': 'Person', Created: T0,
    });
    expect(contacts.find((c) => c['Contact ID'] === 'con_acme')).toMatchObject({
      'Display name': 'Acme Flight LLC', 'Person or organization': 'Organization', 'Current aircraft IDs': 'air_2',
    });

    // Aircraft keep their owners, current and past.
    expect(csv('aircraft.csv').map((a) => [a['Aircraft ID'], a['Current owner contact ID']]).sort())
      .toEqual([['air_1', 'con_renee'], ['air_2', 'con_acme']]);
    expect(csv('aircraft-ownership.csv').filter((o) => o['Aircraft ID'] === 'air_2').map((o) => [o['Owner contact ID'], o['Current owner'], o['Owned until']]))
      .toEqual([['con_renee', 'No', '2026-06-30'], ['con_acme', 'Yes', '']]);

    // Notes: who wrote them, when, and what they are about.
    const notes = csv('notes.csv');
    expect(notes.find((n) => n['Note ID'] === 'act_note')).toMatchObject({
      Kind: 'Timeline note', Content: 'Hangar visit\n\nWants =SUM(A1) quoted; ½ share? ✈️',
      Author: 'Bob Teammate', 'Author user ID': bobId, Created: '2026-09-02T15:31:00.000Z', 'Contact ID': 'con_renee',
      Contact: 'Renée Ødegård', Company: 'Société Générale Aviation, Inc.', 'Aircraft ID': 'air_1', 'Tail number': 'N123AB',
    });
    expect(notes.find((n) => n.Kind === 'Aircraft comment')).toMatchObject({
      Content: 'Annual due in März — check logs', Author: 'Bob Teammate', 'Aircraft ID': 'air_1', 'Contact ID': 'con_renee',
    });
    expect(notes.find((n) => n['Note ID'] === 'contact-notes-con_renee')).toMatchObject({ Kind: 'Contact notes field', 'Contact ID': 'con_renee' });
    expect(notes.find((n) => n['Note ID'] === 'opportunity-notes-opp_1')).toMatchObject({ Content: 'Hull up 5%', 'Contact ID': 'con_acme', 'Aircraft ID': 'air_2' });
    expect(notes.find((n) => n['Note ID'] === 'policy-renewal-notes-pol_1')).toMatchObject({ Content: 'Shop it', 'Policy ID': 'pol_1' });

    // The timeline, with times in one form: UTC, ISO 8601.
    expect(csv('activities.csv').find((a) => a['Activity ID'] === 'act_call')).toMatchObject({
      Type: 'Call', Date: '2026-09-03T17:00:00.000Z', 'Contact ID': 'con_acme', 'Opportunity ID': 'opp_1',
      Opportunity: 'N456CD renewal', 'Recorded by': 'Scott Lawrence',
    });

    // Tasks, with who has them and who gave them.
    expect(csv('tasks.csv')).toEqual([expect.objectContaining({
      'Task ID': 'fup_quote', 'What to do': 'Send quote', Note: 'Hull and liability', 'Due date': '2026-09-10',
      Priority: 'High', Status: 'Open', 'Assigned to user ID': bobId, 'Assigned to': 'Bob Teammate',
      'Assigned by user ID': admin.id, 'Assigned by': 'Scott Lawrence', 'Contact ID': 'con_renee', 'Tail number': 'N123AB',
    })]);
    expect(csv('opportunities.csv')[0]).toMatchObject({ 'Opportunity ID': 'opp_1', 'Contact ID': 'con_acme', 'Aircraft ID': 'air_2' });
    expect(csv('insurance-policies.csv')[0]).toMatchObject({ 'Policy ID': 'pol_1', Expiration: '2026-11-15', 'Opportunity ID': 'opp_1' });

    // The document itself, under its original name, and what it belongs to.
    expect(result.documentsMissing).toBe(0);
    const docs = csv('documents.csv');
    expect(docs).toEqual([expect.objectContaining({
      'Document ID': file.id, 'Original filename': 'Assurance — Ødegård.pdf', 'File type': 'application/pdf',
      'Contact ID': 'con_renee', 'Aircraft ID': 'air_1', Category: 'Insurance', 'Uploaded by': 'Scott Lawrence',
    })]);
    const path = docs[0]['File in this export'];
    expect(path).toBe(`documents/${file.id}/Assurance — Ødegård.pdf`);
    expect(new TextDecoder().decode(byName.get(path))).toBe('%PDF-1.4 binder for Renée');

    // People, and the audit trail — this export included.
    expect(csv('users.csv').map((u) => [u.Name, u.Role, u.Access])).toEqual([['Bob Teammate', 'User', 'Active'], ['Scott Lawrence', 'Admin', 'Active']]);
    const audit = csv('audit-log.csv');
    expect(audit.some((e) => e.Action === 'create' && e['Record ID'] === 'con_renee' && e.User === 'Scott Lawrence')).toBe(true);
    expect(audit.some((e) => e.Action === 'company-export' && e['User ID'] === admin.id)).toBe(true);

    // The JSON backup carries the same records, restorable.
    const backup = JSON.parse(textOf('aerobook-backup.json'));
    expect(backup.app).toBe('AEROBOOK');
    expect(backup.contacts.map((c: { id: string }) => c.id).sort()).toEqual(['con_acme', 'con_renee']);
    expect(textOf('README.txt')).toMatch(/Contact ID\s+contacts\.csv/);
  });

  it('records the export in the audit log, without the data', async () => {
    await seed();
    await exportAs(adminCookie);
    const { rows } = await getPool().query(
      `select user_id, user_name, collection, record_id, summary, before from app_audit where action = 'company-export'`,
    );
    expect(rows).toEqual([{
      user_id: admin.id, user_name: 'Scott Lawrence', collection: 'security', record_id: admin.id,
      summary: 'Exported all company data: records, documents, comments, users and the audit log', before: null,
    }]);
    // Kept out of the activity history everyone reads, like other security events.
    const history = await body(await api('/api/history', { cookie: bobCookie }));
    expect(history.entries.some((e: { summary: string }) => /Exported all company data/.test(e.summary))).toBe(false);
  });

  it('refuses someone who is not an admin, and records nothing', async () => {
    await seed();
    await expect(exportCompanyData(undefined, deviceFetch(bobCookie))).rejects.toThrow(/Only an admin/);
    expect((await api('/api/export/company', { cookie: bobCookie, body: {} })).status).toBe(403);
    expect((await api('/api/export/audit', { cookie: bobCookie })).status).toBe(403);
    expect((await api('/api/export/company', { body: {} })).status).toBe(401);
    expect((await api('/api/export/audit')).status).toBe(401);
    expect((await api('/api/export/company', { cookie: adminCookie, body: {}, headers: { origin: 'https://evil.example' } })).status).toBe(403);
    expect((await api('/api/export/company', { cookie: adminCookie })).status).toBe(405);
    const { rows } = await getPool().query(`select 1 from app_audit where action = 'company-export'`);
    expect(rows).toHaveLength(0);
  });

  it('carries no passwords, sessions, two-step secrets or server keys', async () => {
    await seed();
    process.env.VAPID_PRIVATE_KEY = 'vapid-private-key-must-not-leak';
    const { files } = await exportAs(adminCookie);
    delete process.env.VAPID_PRIVATE_KEY;
    const everything = files.map((f) => new TextDecoder().decode(f.data)).join('\n');
    const { rows: accounts } = await getPool().query<{ password: string }>('select password from account where password is not null');
    const { rows: sessions } = await getPool().query<{ token: string }>('select token from session');
    expect(accounts.length).toBeGreaterThan(0);
    for (const { password } of accounts) expect(everything).not.toContain(password);
    for (const { token } of sessions) expect(everything).not.toContain(token);
    for (const secret of [process.env.BETTER_AUTH_SECRET, process.env.DATABASE_URL, process.env.TEST_DATABASE_URL, 'vapid-private-key-must-not-leak']) {
      if (secret) expect(everything).not.toContain(secret);
    }
    expect(everything).not.toMatch(/correct horse battery/);
    expect(everything).not.toMatch(/\$argon2|\$scrypt|scrypt:/i);
  });

  it('exports an empty company cleanly', async () => {
    await cloud.start();
    const { csv, byName, textOf } = await exportAs(adminCookie);
    for (const name of ['contacts.csv', 'notes.csv', 'tasks.csv', 'activities.csv', 'documents.csv', 'aircraft-comments.csv']) {
      expect(csv(name)).toEqual([]);
      expect(textOf(name).split('\r\n')[0]).toMatch(/ID/); // the header row is still there
    }
    expect([...byName.keys()].some((n) => n.startsWith('documents/'))).toBe(false);
    expect(textOf('README.txt')).toMatch(/0 contacts/);
  });

  it('says which documents it could not include, and why', async () => {
    const file = await seed();
    await rm(join(dir, file.blobPath!), { force: true });
    const { result, csv, byName } = await exportAs(adminCookie);
    expect(result.documentsMissing).toBe(1);
    expect(csv('documents.csv')[0]).toMatchObject({
      'File in this export': '', 'Why the file is not included': 'The file is no longer in AEROBOOK’s document storage.',
    });
    expect([...byName.keys()].some((n) => n.startsWith('documents/'))).toBe(false);
  });

  it('hands over the audit log a page at a time, without what records held', async () => {
    await getPool().query(
      `insert into app_audit (user_id, user_name, action, collection, record_id, summary, before)
       select 'u', 'Someone', 'update', 'contacts', 'con_' || g, 'x', '{"secretish":"old"}'::jsonb from generate_series(1, 5002) g`,
    );
    const first = await body(await api('/api/export/audit?after=0', { cookie: adminCookie }));
    expect(first.entries).toHaveLength(5000);
    expect(first.more).toBe(true);
    expect(JSON.stringify(first)).not.toContain('secretish');
    const second = await body(await api(`/api/export/audit?after=${first.entries.at(-1).id}`, { cookie: adminCookie }));
    expect(second.entries).toHaveLength(2);
    expect(second.more).toBe(false);
    expect((await api('/api/export/audit?after=-1', { cookie: adminCookie })).status).toBe(400);
  });

  it('leaves out deleted comments and the old address of someone deleted', async () => {
    await seed();
    const posted = await body(await api('/api/aircraft/air_1/comments', { cookie: adminCookie, body: { body: 'typo, ignore' } }));
    await api(`/api/aircraft/air_1/comments/${posted.comment.id}/delete`, { cookie: adminCookie, body: {} });
    await api('/api/team/delete', { cookie: adminCookie, body: { userId: bobId } });
    const start = await body(await api('/api/export/company', { cookie: adminCookie, body: {} }));
    expect(start.comments.map((c: { body: string }) => c.body)).toEqual(['Annual due in März — check logs']);
    expect(start.people.find((p: { id: string }) => p.id === bobId)).toMatchObject({ access: 'deleted', email: '' });
  });
});
