/**
 * What stops one account from wiping out the team's work: someone who is not
 * an admin cannot bulk-delete, whatever their browser is made to send; what a
 * change replaced is kept in the history; and a preview deployment serves no
 * data until it has been given data of its own.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { api, createUser, freshDatabase, ORIGIN, signIn, TEST_DB } from './testing.js';
import { handle } from './app.js';
import { getPool } from './db.js';
import { DELETE_LIMIT_MESSAGE, MEMBER_DELETE_LIMIT } from './sync.js';
import * as store from '../src/data/store';
import * as persistence from '../src/data/db';
import { CloudSync } from '../src/data/cloud';

const contact = (id: string) => ({ id, firstName: 'Pat', lastName: id });
const ids = (n: number, from = 0) => Array.from({ length: n }, (_, i) => `con_${String(from + i).padStart(4, '0')}`);

function deviceFetch(cookie: string): typeof fetch {
  return (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set('cookie', cookie);
    headers.set('origin', ORIGIN);
    return handle(new Request(`${ORIGIN}${String(input)}`, { ...init, headers }));
  };
}

describe.skipIf(!TEST_DB)('safeguards', () => {
  let alice: string;
  let bob: string;
  let bobId: string;

  const push = (cookie: string, changes: unknown[]) => api('/api/sync', { cookie, body: { changes } });
  const create = (cookie: string, list: string[]) =>
    push(cookie, list.map((id) => ({ collection: 'contacts', id, data: contact(id), baseVersion: 0 })));
  const remove = (cookie: string, list: string[], version = 1) =>
    push(cookie, list.map((id) => ({ collection: 'contacts', id, data: null, baseVersion: version })));
  const live = async () =>
    Number((await getPool().query(`select count(*) as n from app_record where collection = 'contacts' and data is not null`)).rows[0].n);

  beforeEach(async () => {
    await freshDatabase();
    await createUser('Alice', 'alice@example.com', 'admin');
    bobId = (await createUser('Bob', 'bob@example.com')).id;
    alice = await signIn('alice@example.com');
    bob = await signIn('bob@example.com');
  });

  describe('deleting', () => {
    it('lets anyone delete what everyday work deletes', async () => {
      await create(alice, ids(5));
      const r = await remove(bob, ids(3));
      const body = await r.json();
      expect(body.applied).toHaveLength(3);
      expect(body.refused).toBeUndefined();
      expect(await live()).toBe(2);
    });

    it('refuses a bulk erase from someone who is not an admin, and says so', async () => {
      await create(alice, ids(MEMBER_DELETE_LIMIT + 20));
      const r = await remove(bob, ids(MEMBER_DELETE_LIMIT + 20));
      expect(r.status).toBe(200);
      const body = await r.json();
      expect(body.applied).toHaveLength(0);
      expect(body.refused.message).toBe(DELETE_LIMIT_MESSAGE);
      expect(body.refused.records).toHaveLength(MEMBER_DELETE_LIMIT + 20);
      expect(body.refused.records[0]).toMatchObject({ collection: 'contacts', version: 1, data: { firstName: 'Pat' } });
      expect(await live()).toBe(MEMBER_DELETE_LIMIT + 20);
    });

    it('still makes the rest of a push whose deletions are refused', async () => {
      await create(alice, ids(MEMBER_DELETE_LIMIT + 1));
      const r = await push(bob, [
        ...ids(MEMBER_DELETE_LIMIT + 1).map((id) => ({ collection: 'contacts', id, data: null, baseVersion: 1 })),
        { collection: 'contacts', id: 'con_new', data: contact('con_new'), baseVersion: 0 },
      ]);
      const body = await r.json();
      expect(body.applied).toEqual([{ collection: 'contacts', id: 'con_new', version: 1 }]);
      expect(body.refused.records).toHaveLength(MEMBER_DELETE_LIMIT + 1);
    });

    it('counts deletions across pushes, so a bulk erase cannot be sent in small pieces', async () => {
      await create(alice, ids(MEMBER_DELETE_LIMIT + 50));
      const first = await (await remove(bob, ids(60))).json();
      expect(first.applied).toHaveLength(60);
      const second = await (await remove(bob, ids(60, 60))).json();
      expect(second.applied).toHaveLength(0);
      expect(second.refused.records).toHaveLength(60);
      // Small everyday deletions still fit under what is left.
      const third = await (await remove(bob, ids(40, 60))).json();
      expect(third.applied).toHaveLength(40);
      expect(await live()).toBe(MEMBER_DELETE_LIMIT + 50 - 100);
    });

    it('counts only the last hour', async () => {
      await create(alice, ids(MEMBER_DELETE_LIMIT + 50));
      await remove(bob, ids(100));
      await getPool().query(`update app_audit set at = now() - interval '2 hours' where user_id = $1`, [bobId]);
      const again = await (await remove(bob, ids(50, 100))).json();
      expect(again.applied).toHaveLength(50);
    });

    it('lets an admin erase everything', async () => {
      await create(alice, ids(MEMBER_DELETE_LIMIT + 20));
      const body = await (await remove(alice, ids(MEMBER_DELETE_LIMIT + 20))).json();
      expect(body.applied).toHaveLength(MEMBER_DELETE_LIMIT + 20);
      expect(await live()).toBe(0);
    });

    it('keeps in the history what each change replaced, so it can be put back', async () => {
      await create(alice, ['con_0001']);
      await push(bob, [{ collection: 'contacts', id: 'con_0001', data: { ...contact('con_0001'), notes: 'Edited' }, baseVersion: 1 }]);
      await remove(bob, ['con_0001'], 2);
      const { rows } = await getPool().query(
        `select action, before from app_audit where record_id = 'con_0001' order by id`,
      );
      expect(rows).toEqual([
        { action: 'create', before: null },
        { action: 'update', before: contact('con_0001') },
        { action: 'delete', before: { ...contact('con_0001'), notes: 'Edited' } },
      ]);
      // The history everyone can read stays the short summary.
      const history = await (await api('/api/history', { cookie: bob })).json();
      expect(history.entries[0]).not.toHaveProperty('before');
    });

    describe('alongside comments and chat groups', () => {
      /** Bob writes and deletes his own comments on an aircraft, n times. */
      const commentAndDelete = async (n: number) => {
        for (let i = 0; i < n; i++) {
          const r = await (await api('/api/aircraft/air_one/comments', { cookie: bob, body: { body: `note ${i}` } })).json();
          expect((await api(`/api/aircraft/air_one/comments/${r.comment.id}/delete`, { cookie: bob, body: {} })).status).toBe(200);
        }
      };
      /** Bob adds Carol to his group and takes her out again, n times; then leaves it himself. */
      const addAndRemove = async (n: number) => {
        const carolId = (await createUser('Carol', 'carol@example.com')).id;
        const group = await (await api('/api/chat/conversations', {
          cookie: bob, body: { kind: 'group', name: 'Deals', memberIds: [carolId] },
        })).json();
        for (let i = 0; i < n; i++) {
          expect((await api(`/api/chat/conversations/${group.id}/remove`, { cookie: bob, body: { userId: carolId } })).status).toBe(200);
          expect((await api(`/api/chat/conversations/${group.id}/members`, { cookie: bob, body: { userIds: [carolId] } })).status).toBe(200);
        }
        expect((await api(`/api/chat/conversations/${group.id}/leave`, { cookie: bob, body: {} })).status).toBe(200);
      };
      const deleteEvents = async (collection: string) => Number((await getPool().query(
        `select count(*) as n from app_audit where user_id = $1 and action = 'delete' and collection = $2`, [bobId, collection],
      )).rows[0].n);

      beforeEach(async () => {
        await push(alice, [{ collection: 'aircraft', id: 'air_one', data: { id: 'air_one', tailNumber: 'N123AB' }, baseVersion: 0 }]);
      });

      it('still counts every ordinary record deletion', async () => {
        await create(alice, ids(MEMBER_DELETE_LIMIT + 1));
        expect((await (await remove(bob, ids(MEMBER_DELETE_LIMIT))).json()).applied).toHaveLength(MEMBER_DELETE_LIMIT);
        expect(await deleteEvents('contacts')).toBe(MEMBER_DELETE_LIMIT);
        const next = await (await remove(bob, ids(1, MEMBER_DELETE_LIMIT))).json();
        expect(next.applied).toHaveLength(0);
        expect(next.refused.message).toBe(DELETE_LIMIT_MESSAGE);
      });

      it('does not use up the allowance on deleted comments', async () => {
        await commentAndDelete(MEMBER_DELETE_LIMIT + 5);
        expect(await deleteEvents('aircraftComments')).toBe(MEMBER_DELETE_LIMIT + 5);
        await create(alice, ids(MEMBER_DELETE_LIMIT));
        const body = await (await remove(bob, ids(MEMBER_DELETE_LIMIT))).json();
        expect(body.refused).toBeUndefined();
        expect(body.applied).toHaveLength(MEMBER_DELETE_LIMIT);
      });

      it('does not use up the allowance on leaving a group or removing someone from it', async () => {
        await addAndRemove(MEMBER_DELETE_LIMIT);
        expect(await deleteEvents('chat')).toBe(MEMBER_DELETE_LIMIT + 1);
        await create(alice, ids(MEMBER_DELETE_LIMIT));
        const body = await (await remove(bob, ids(MEMBER_DELETE_LIMIT))).json();
        expect(body.refused).toBeUndefined();
        expect(body.applied).toHaveLength(MEMBER_DELETE_LIMIT);
      });

      it('still stops a bulk erase sent in pieces between comment and group clean-up', async () => {
        await create(alice, ids(MEMBER_DELETE_LIMIT + 10));
        await commentAndDelete(20);
        expect((await (await remove(bob, ids(60))).json()).applied).toHaveLength(60);
        await addAndRemove(20);
        expect((await (await remove(bob, ids(40, 60))).json()).applied).toHaveLength(40);
        await commentAndDelete(5);
        const over = await (await remove(bob, ids(10, 100))).json();
        expect(over.applied).toHaveLength(0);
        expect(over.refused.records).toHaveLength(10);
        expect(await live()).toBe(10);
      });
    });

    it('gives a refused deletion back to the app, which shows the records again', async () => {
      await create(alice, ids(MEMBER_DELETE_LIMIT + 5));
      await store.unload();
      await persistence.clearAll();
      const cloud = new CloudSync({ id: bobId, name: 'Bob', email: 'bob@example.com', role: 'user' }, deviceFetch(bob));
      const notices: string[] = [];
      const off = store.onNotice((m) => notices.push(m));
      try {
        await cloud.start();
        expect(store.getState().contacts).toHaveLength(MEMBER_DELETE_LIMIT + 5);
        await store.eraseEverything();
        await store.flush();
        expect(store.getState().contacts).toHaveLength(MEMBER_DELETE_LIMIT + 5);
        expect(notices).toContain(DELETE_LIMIT_MESSAGE);
        // Nothing is left waiting to be sent again.
        await store.flush();
        expect(await live()).toBe(MEMBER_DELETE_LIMIT + 5);
      } finally {
        off();
        cloud.stop();
        await store.unload();
      }
    });
  });

  describe('signing in to an account whose access is off', () => {
    const attempt = (email: string, password: string) =>
      api('/api/auth/sign-in/email', { body: { email, password } });
    const reply = async (r: Response) => {
      const headers: Record<string, string> = {};
      r.headers.forEach((value, name) => { headers[name] = value; });
      return { status: r.status, headers, body: await r.text(), cookies: r.headers.getSetCookie() };
    };

    it('answers the right password exactly as it answers a wrong one', async () => {
      await getPool().query('update "user" set banned = true where id = $1', [bobId]);
      const sessions = async () =>
        (await getPool().query('select count(*)::int as n from session where "userId" = $1', [bobId])).rows[0].n;
      const before = await sessions();
      const wrong = await reply(await attempt('bob@example.com', 'not the password at all'));
      const right = await reply(await attempt('bob@example.com', 'correct horse battery'));
      expect(wrong.status).toBe(401);
      expect(right).toEqual(wrong);
      expect(right.cookies).toEqual([]);
      expect(right.body).not.toMatch(/ban/i);
      // And it lets nobody in.
      expect(await sessions()).toBe(before);
    });

    it('still signs in everyone else', async () => {
      expect((await attempt('bob@example.com', 'correct horse battery')).status).toBe(200);
    });
  });

  describe('preview deployments', () => {
    afterEach(() => {
      delete process.env.VERCEL_ENV;
      delete process.env.PREVIEW_DATA;
    });

    it('serve no data until they have data of their own', async () => {
      process.env.VERCEL_ENV = 'preview';
      for (const path of ['/api/sync', '/api/setup', '/api/team', '/api/auth/get-session']) {
        expect((await api(path, { cookie: alice })).status).toBe(503);
      }
      expect((await api('/api/auth/sign-in/email', { body: { email: 'alice@example.com', password: 'correct horse battery' } })).status).toBe(503);
    });

    it('work once the preview is marked as having separate data', async () => {
      process.env.VERCEL_ENV = 'preview';
      process.env.PREVIEW_DATA = 'separate';
      expect((await api('/api/sync', { cookie: alice })).status).toBe(200);
    });

    it('leave production alone', async () => {
      process.env.VERCEL_ENV = 'production';
      expect((await api('/api/sync', { cookie: alice })).status).toBe(200);
    });
  });
});
