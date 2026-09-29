/**
 * The API against a real Postgres: who can get in, and that two people's
 * writes land without one silently erasing the other's.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { api, createUser, freshDatabase, signIn, TEST_DB } from './testing.js';
import { getPool } from './db.js';

const contact = (id: string, firstName: string) => ({ id, firstName, lastName: 'Heine' });

describe.skipIf(!TEST_DB)('the API', () => {
  let alice: string;
  let bob: string;
  let bobId: string;

  beforeEach(async () => {
    await freshDatabase();
    await createUser('Alice', 'alice@example.com', 'admin');
    bobId = (await createUser('Bob', 'bob@example.com')).id;
    alice = await signIn('alice@example.com');
    bob = await signIn('bob@example.com');
  });

  describe('getting in', () => {
    it('refuses data without a session', async () => {
      expect((await api('/api/sync')).status).toBe(401);
      expect((await api('/api/sync', { body: { changes: [] } })).status).toBe(401);
    });

    it('has no way to sign up', async () => {
      const r = await api('/api/auth/sign-up/email', {
        body: { email: 'mallory@example.com', password: 'correct horse battery', name: 'Mallory' },
      });
      expect(r.ok).toBe(false);
      const { rows } = await getPool().query('select count(*)::int as n from "user"');
      expect(rows[0].n).toBe(2);
    });

    it('refuses a wrong password', async () => {
      await expect(signIn('alice@example.com', 'not the password')).rejects.toThrow(/sign-in failed/);
    });

    it('slows down someone guessing passwords', async () => {
      const attempt = () => api('/api/auth/sign-in/email', {
        body: { email: 'alice@example.com', password: 'guess guess guess' },
        headers: { 'x-forwarded-for': '203.0.113.9' },
      });
      const statuses: number[] = [];
      for (let i = 0; i < 7; i++) statuses.push((await attempt()).status);
      expect(statuses).toContain(429);
    });

    it('lets only an admin create accounts', async () => {
      const body = { email: 'carol@example.com', password: 'correct horse battery', name: 'Carol', role: 'user' };
      expect((await api('/api/auth/admin/create-user', { body, cookie: bob })).ok).toBe(false);
      expect((await api('/api/auth/admin/create-user', { body, cookie: alice })).ok).toBe(true);
      await expect(signIn('carol@example.com')).resolves.toContain('=');
    });

    it('refuses a write from another site', async () => {
      const r = await api('/api/sync', {
        body: { changes: [] }, cookie: alice, headers: { origin: 'https://evil.example' },
      });
      expect(r.status).toBe(403);
    });

    it('refuses a write that is not JSON', async () => {
      const r = await api('/api/sync', {
        body: { changes: [] }, cookie: alice, headers: { 'content-type': 'text/plain' },
      });
      expect(r.status).toBe(415);
    });
  });

  describe('first-time setup', () => {
    it('is closed once anyone has an account', async () => {
      process.env.SETUP_TOKEN = 'setup-token-for-tests';
      expect(await (await api('/api/setup')).json()).toEqual({ needsSetup: false });
      const r = await api('/api/setup', {
        body: { token: 'setup-token-for-tests', name: 'M', email: 'm@example.com', password: 'correct horse battery' },
      });
      expect(r.status).toBe(409);
    });

    it('creates the first admin only with the token', async () => {
      process.env.SETUP_TOKEN = 'setup-token-for-tests';
      await getPool().query('delete from "session"; delete from "account"; delete from "user";');
      const body = { name: 'Scott', email: 'Scott@Example.com', password: 'correct horse battery' };
      expect((await api('/api/setup', { body: { ...body, token: 'guess' } })).status).toBe(403);
      expect((await api('/api/setup', { body: { ...body, token: 'setup-token-for-tests' } })).ok).toBe(true);
      const cookie = await signIn('scott@example.com');
      const session = await (await api('/api/auth/get-session', { cookie })).json();
      expect(session.user.role).toBe('admin');
    });

    it('creates the tables on a brand-new database', async () => {
      await getPool().query('drop schema public cascade; create schema public;');
      expect(await (await api('/api/setup')).json()).toEqual({ needsSetup: true });
      const { rows } = await getPool().query(`select to_regclass('app_record') as t`);
      expect(rows[0].t).toBe('app_record');
    });

    it('is off when no token is configured', async () => {
      delete process.env.SETUP_TOKEN;
      await getPool().query('delete from "session"; delete from "account"; delete from "user";');
      const r = await api('/api/setup', {
        body: { token: '', name: 'M', email: 'm@example.com', password: 'correct horse battery' },
      });
      expect(r.status).toBe(404);
    });
  });

  describe('sharing data', () => {
    const pushAs = (cookie: string, changes: unknown[]) => api('/api/sync', { body: { changes }, cookie }).then((r) => r.json());
    const pullAs = (cookie: string, since = 0) =>
      api(`/api/sync?since=${since}${since === 0 ? '&full=1' : ''}`, { cookie }).then((r) => r.json());

    it('shows one person the records another created', async () => {
      const pushed = await pushAs(alice, [{ collection: 'contacts', id: 'con_1', data: contact('con_1', 'John'), baseVersion: 0 }]);
      expect(pushed.applied).toEqual([{ collection: 'contacts', id: 'con_1', version: 1 }]);
      const pulled = await pullAs(bob);
      expect(pulled.records).toEqual([{ collection: 'contacts', id: 'con_1', data: contact('con_1', 'John'), version: 1 }]);
    });

    it('returns only what changed since the cursor, including deletions', async () => {
      await pushAs(alice, [
        { collection: 'contacts', id: 'con_1', data: contact('con_1', 'John'), baseVersion: 0 },
        { collection: 'contacts', id: 'con_2', data: contact('con_2', 'Jane'), baseVersion: 0 },
      ]);
      const first = await pullAs(bob);
      expect(first.records).toHaveLength(2);

      await pushAs(alice, [{ collection: 'contacts', id: 'con_2', data: null, baseVersion: 1 }]);
      const next = await pullAs(bob, first.cursor);
      expect(next.records).toEqual([{ collection: 'contacts', id: 'con_2', data: null, version: 2 }]);

      // Someone starting fresh never hears about the deleted record at all.
      const fresh = await pullAs(bob);
      expect(fresh.records.map((r: { id: string }) => r.id)).toEqual(['con_1']);
    });

    it('does not let a stale edit overwrite a newer one', async () => {
      await pushAs(alice, [{ collection: 'contacts', id: 'con_1', data: contact('con_1', 'John'), baseVersion: 0 }]);
      await pushAs(alice, [{ collection: 'contacts', id: 'con_1', data: contact('con_1', 'Johnny'), baseVersion: 1 }]);
      const stale = await pushAs(bob, [{ collection: 'contacts', id: 'con_1', data: contact('con_1', 'Jon'), baseVersion: 1 }]);
      expect(stale.applied).toEqual([]);
      expect(stale.conflicts).toEqual([{ collection: 'contacts', id: 'con_1', data: contact('con_1', 'Johnny'), version: 2 }]);
    });

    it('keeps each person’s settings to themselves', async () => {
      const settings = { senderName: 'Alice' };
      const aliceId = (await (await api('/api/auth/get-session', { cookie: alice })).json()).user.id;
      await pushAs(alice, [{ collection: 'settings', id: aliceId, data: settings, baseVersion: 0 }]);
      expect((await pullAs(alice)).records).toHaveLength(1);
      expect((await pullAs(bob)).records).toHaveLength(0);

      const r = await api('/api/sync', {
        body: { changes: [{ collection: 'settings', id: aliceId, data: { senderName: 'Bob' }, baseVersion: 1 }] },
        cookie: bob,
      });
      expect(r.status).toBe(400);
      expect(bobId).toBeTruthy();
    });

    it('lists the team for anyone signed in, names only', async () => {
      expect((await api('/api/team')).status).toBe(401);
      await getPool().query(`update "user" set banned = true where email = 'bob@example.com'`);
      const { people } = await (await api('/api/team', { cookie: alice })).json();
      expect(people).toEqual([
        { id: expect.any(String), name: 'Alice', active: true },
        { id: bobId, name: 'Bob', active: false },
      ]);
      expect(JSON.stringify(people)).not.toContain('@');
    });

    it('rejects unknown collections and mismatched ids', async () => {
      const bad = [
        { collection: 'user', id: 'x', data: { id: 'x' }, baseVersion: 0 },
        { collection: 'contacts', id: 'con_1', data: contact('con_2', 'John'), baseVersion: 0 },
        { collection: 'contacts', id: 'con_1', data: [1, 2], baseVersion: 0 },
      ];
      for (const change of bad) {
        expect((await api('/api/sync', { body: { changes: [change] }, cookie: alice })).status).toBe(400);
      }
    });

    it('records who did what', async () => {
      await pushAs(alice, [{ collection: 'aircraft', id: 'air_1', data: { id: 'air_1', tailNumber: 'N917JH' }, baseVersion: 0 }]);
      await pushAs(bob, [{ collection: 'aircraft', id: 'air_1', data: { id: 'air_1', tailNumber: 'N917JH', notes: 'x' }, baseVersion: 1 }]);
      await pushAs(bob, [{ collection: 'aircraft', id: 'air_1', data: null, baseVersion: 2 }]);
      const { rows } = await getPool().query('select user_name, action, summary from app_audit order by id');
      expect(rows).toEqual([
        { user_name: 'Alice', action: 'create', summary: 'N917JH' },
        { user_name: 'Bob', action: 'update', summary: 'N917JH' },
        { user_name: 'Bob', action: 'delete', summary: 'N917JH' },
      ]);
    });

    describe('the activity history', () => {
      const historyAs = (cookie?: string, query = '') => api(`/api/history${query}`, { cookie });

      it('is only for people who are signed in', async () => {
        expect((await historyAs()).status).toBe(401);
        expect((await historyAs(undefined, '?before=5')).status).toBe(401);
      });

      it('cannot be written to or deleted', async () => {
        for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
          const r = await api('/api/history', { method, cookie: alice, body: method === 'DELETE' ? undefined : {} });
          expect(r.status).toBe(405);
        }
      });

      it('says who did what to which record, newest first', async () => {
        await pushAs(alice, [{ collection: 'aircraft', id: 'air_1', data: { id: 'air_1', tailNumber: 'N917JH' }, baseVersion: 0 }]);
        await pushAs(bob, [{ collection: 'aircraft', id: 'air_1', data: { id: 'air_1', tailNumber: 'N917JH', notes: 'x' }, baseVersion: 1 }]);
        await pushAs(bob, [{ collection: 'followUps', id: 'fup_1', data: { id: 'fup_1', note: 'Call client' }, baseVersion: 0 }]);
        await pushAs(bob, [{ collection: 'followUps', id: 'fup_1', data: null, baseVersion: 1 }]);

        const { entries, more } = await (await historyAs(bob)).json();
        expect(more).toBe(false);
        expect(entries.map((e: { userName: string; action: string; collection: string; recordId: string; summary: string }) =>
          [e.userName, e.action, e.collection, e.recordId, e.summary])).toEqual([
          ['Bob', 'delete', 'followUps', 'fup_1', 'Call client'],
          ['Bob', 'create', 'followUps', 'fup_1', 'Call client'],
          ['Bob', 'update', 'aircraft', 'air_1', 'N917JH'],
          ['Alice', 'create', 'aircraft', 'air_1', 'N917JH'],
        ]);
        expect(entries[0].userId).toBe(bobId);
        expect(new Date(entries[0].at).getTime()).toBeGreaterThanOrEqual(new Date(entries[3].at).getTime());
        // Everyone on the team reads the same history.
        expect((await (await historyAs(alice)).json()).entries).toEqual(entries);
      });

      it('never lists personal settings', async () => {
        const aliceId = (await (await api('/api/auth/get-session', { cookie: alice })).json()).user.id;
        await pushAs(alice, [{ collection: 'settings', id: aliceId, data: { senderName: 'A' }, baseVersion: 0 }]);
        expect((await (await historyAs(alice)).json()).entries).toEqual([]);
      });

      it('pages back through older entries without gaps or repeats', async () => {
        const changes = Array.from({ length: 130 }, (_, i) => ({
          collection: 'contacts', id: `con_${i}`, data: { id: `con_${i}`, firstName: `P${i}` }, baseVersion: 0,
        }));
        await pushAs(alice, changes);
        const first = await (await historyAs(alice)).json();
        expect(first.entries).toHaveLength(100);
        expect(first.more).toBe(true);
        const second = await (await historyAs(alice, `?before=${first.entries.at(-1).id}`)).json();
        expect(second.entries).toHaveLength(30);
        expect(second.more).toBe(false);
        const ids = [...first.entries, ...second.entries].map((e: { recordId: string }) => e.recordId);
        expect(new Set(ids).size).toBe(130);
        expect(ids[0]).toBe('con_129');
        expect(ids.at(-1)).toBe('con_0');
      });

      it('refuses a nonsense cursor', async () => {
        expect((await historyAs(alice, '?before=abc')).status).toBe(400);
        expect((await historyAs(alice, '?before=0')).status).toBe(400);
      });
    });

    it('reports whether the shared data is empty', async () => {
      const status = () => api('/api/sync/status', { cookie: alice }).then((r) => r.json());
      expect(await status()).toEqual({ empty: true });
      await pushAs(alice, [{ collection: 'templates', id: 'tpl_x', data: { id: 'tpl_x', name: 'T' }, baseVersion: 0 }]);
      expect(await status()).toEqual({ empty: true });
      await pushAs(alice, [{ collection: 'contacts', id: 'con_1', data: contact('con_1', 'John'), baseVersion: 0 }]);
      expect(await status()).toEqual({ empty: false });
    });
  });
});
