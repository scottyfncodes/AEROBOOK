/**
 * The morning email: whose list gets what, that the cron route is locked,
 * that a day is sent once, and that nothing leaves without an API key.
 * Resend itself is replaced by a recording fetch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, createUser, freshDatabase, signIn, TEST_DB } from './testing.js';
import { buildDigests, dayIn, renderDigest, runDigest } from './digest.js';

// 9am on Sept 29 in Los Angeles; 4pm UTC.
const NOW = new Date('2026-09-29T16:00:00Z');

describe('dayIn', () => {
  it('uses the local day, not UTC', () => {
    // 8pm Sept 28 in Los Angeles is already Sept 29 in UTC.
    expect(dayIn(new Date('2026-09-29T03:00:00Z'), 'America/Los_Angeles')).toBe('2026-09-28');
    expect(dayIn(new Date('2026-09-29T03:00:00Z'), 'UTC')).toBe('2026-09-29');
  });
});

describe.skipIf(!TEST_DB)('daily digest', () => {
  let alice: { id: string };
  let bob: { id: string };
  let aliceCookie: string;
  let sent: { to: string[]; subject: string; html: string; text: string; from: string; key: string | null }[];

  const push = (cookie: string, changes: { collection: string; id: string; data: Record<string, unknown> }[]) =>
    api('/api/sync', { cookie, body: { changes: changes.map((c) => ({ ...c, baseVersion: 0 })) } });
  const followUp = (id: string, dueDate: string, extra: Record<string, unknown> = {}) => ({
    collection: 'followUps', id,
    data: {
      id, dueDate, note: `note ${id}`, completed: false, contactId: 'con_1', aircraftId: 'air_1', opportunityId: null,
      createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z', ...extra,
    },
  });

  beforeEach(async () => {
    await freshDatabase();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    process.env.DIGEST_TIME_ZONE = 'America/Los_Angeles';
    process.env.APP_URL = 'https://aerobook.example';
    process.env.RESEND_API_KEY = 're_test_key';
    process.env.CRON_SECRET = 'cron-secret-for-tests';
    sent = [];
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) !== 'https://api.resend.com/emails') return realFetch(input, init);
      const headers = new Headers(init?.headers);
      sent.push({ ...JSON.parse(String(init?.body)), key: headers.get('idempotency-key') });
      return new Response(JSON.stringify({ id: 'email_1' }), { status: 200 });
    });

    alice = await createUser('Alice Pilot', 'alice@example.com', 'admin');
    bob = await createUser('Bob', 'bob@example.com');
    aliceCookie = await signIn('alice@example.com');
    await push(aliceCookie, [
      { collection: 'contacts', id: 'con_1', data: { id: 'con_1', firstName: 'Marlon', lastName: 'Humphrey', company: '' } },
      { collection: 'aircraft', id: 'air_1', data: { id: 'air_1', tailNumber: '917jh' } },
      followUp('fu_over', '2026-09-27'),
      followUp('fu_today', '2026-09-29', { priority: 'High', assigneeId: alice.id }),
      followUp('fu_soon', '2026-10-03'),
      followUp('fu_later', '2026-10-20'),
      followUp('fu_done', '2026-09-29', { completed: true }),
      followUp('fu_bob', '2026-09-29', { assigneeId: bob.id, note: 'call <Bob>' }),
    ]);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    for (const k of ['DIGEST_TIME_ZONE', 'APP_URL', 'RESEND_API_KEY', 'CRON_SECRET', 'DIGEST_FROM']) delete process.env[k];
  });

  it("puts each person's own and unassigned follow-ups in the right buckets", async () => {
    const digests = await buildDigests(NOW);
    const a = digests.find((d) => d.userId === alice.id)!;
    expect(a.day).toBe('2026-09-29');
    expect(a.overdue.map((i) => i.id)).toEqual(['fu_over']);
    expect(a.today.map((i) => i.id)).toEqual(['fu_today']);
    expect(a.upcoming.map((i) => i.id)).toEqual(['fu_soon']);
    expect(a.today[0].about).toBe('Marlon Humphrey · N917JH');
    const b = digests.find((d) => d.userId === bob.id)!;
    expect(b.today.map((i) => i.id)).toEqual(['fu_bob']);
    expect(b.overdue.map((i) => i.id)).toEqual(['fu_over']);
  });

  it('writes an email that escapes what people typed and links to the app', async () => {
    const [, b] = await buildDigests(NOW);
    const email = renderDigest(b);
    expect(email.subject).toBe('AEROBOOK · 1 due today, 1 overdue, 1 this week — Sep 29');
    expect(email.html).toContain('call &lt;Bob&gt;');
    expect(email.html).not.toContain('call <Bob>');
    expect(email.html).toContain('https://aerobook.example/follow-ups');
    expect(email.text).toContain('Tuesday, Sep 29');
  });

  it('sends each person one email a day, from the digest address', async () => {
    expect(await runDigest(NOW)).toMatchObject({ day: '2026-09-29', enabled: true, sent: 2, failed: 0 });
    expect(sent.map((m) => m.to[0]).sort()).toEqual(['alice@example.com', 'bob@example.com']);
    expect(sent[0].from).toBe('AEROBOOK <digest@optibook.cloud>');
    expect(sent[0].key).toMatch(/^digest-.+-2026-09-29$/);
    // A second run the same day sends nothing more.
    expect(await runDigest(NOW)).toMatchObject({ sent: 0, skipped: 2 });
    expect(sent).toHaveLength(2);
    // The next morning is a new day.
    expect((await runDigest(new Date('2026-09-30T16:00:00Z'))).sent).toBe(2);
  });

  it('leaves out people who turned it off, whose access is off, or who have nothing due', async () => {
    const bobCookie = await signIn('bob@example.com');
    await push(bobCookie, [{ collection: 'settings', id: bob.id, data: { dailyDigest: false } }]);
    const carol = await createUser('Carol', 'carol@example.com');
    const { getPool } = await import('./db.js');
    await getPool().query('update "user" set banned = true where id = $1', [carol.id]);
    await createUser('Dan', 'dan@example.com');

    await runDigest(NOW);
    expect(sent.map((m) => m.to[0]).sort()).toEqual(['alice@example.com', 'dan@example.com']);

    // With the unassigned ones done, Dan has nothing, so gets nothing.
    sent = [];
    await getPool().query(
      `update app_record set data = jsonb_set(data, '{completed}', 'true')
        where collection = 'followUps' and data->>'assigneeId' is null`,
    );
    const next = await runDigest(new Date('2026-09-30T16:00:00Z'));
    expect(sent.map((m) => m.to[0])).toEqual(['alice@example.com']);
    expect(next).toMatchObject({ sent: 1, skipped: 1 });
  });

  it('sends nothing without an API key', async () => {
    delete process.env.RESEND_API_KEY;
    expect(await runDigest(NOW)).toMatchObject({ enabled: false, sent: 0 });
    expect(sent).toHaveLength(0);
  });

  it('tries again next run when the email service fails', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ message: 'domain not verified' }), { status: 403 }));
    expect(await runDigest(NOW)).toMatchObject({ sent: 0, failed: 2 });
    vi.stubGlobal('fetch', async (_: unknown, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)));
      return new Response('{}', { status: 200 });
    });
    expect((await runDigest(NOW)).sent).toBe(2);
  });

  it('runs from the cron route only with the secret', async () => {
    expect((await api('/api/digest/run')).status).toBe(401);
    expect((await api('/api/digest/run', { headers: { authorization: 'Bearer wrong' } })).status).toBe(401);
    expect((await api('/api/digest/run', { cookie: aliceCookie })).status).toBe(401);
    const ok = await api('/api/digest/run', { headers: { authorization: 'Bearer cron-secret-for-tests' } });
    expect(ok.status).toBe(200);
    expect((await ok.json()).sent).toBe(2);
    delete process.env.CRON_SECRET;
    expect((await api('/api/digest/run', { headers: { authorization: 'Bearer ' } })).status).toBe(503);
  });

  it('lets a signed-in person preview and send only their own', async () => {
    expect((await api('/api/digest/preview')).status).toBe(401);
    expect((await api('/api/digest/send', { body: {} })).status).toBe(401);
    const preview = await (await api('/api/digest/preview', { cookie: aliceCookie })).json();
    expect(preview).toMatchObject({ enabled: true, empty: false, to: 'alice@example.com' });
    expect(preview.subject).toContain('1 due today');

    const r = await api('/api/digest/send', { cookie: aliceCookie, body: { to: 'someone@else.com' } });
    expect(await r.json()).toEqual({ sentTo: 'alice@example.com' });
    expect(sent.map((m) => m.to)).toEqual([['alice@example.com']]);

    delete process.env.RESEND_API_KEY;
    const off = await api('/api/digest/send', { cookie: aliceCookie, body: {} });
    expect(off.status).toBe(503);
    expect((await off.json()).error).toMatch(/not set up/);
  });
});
