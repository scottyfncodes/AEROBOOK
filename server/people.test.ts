/**
 * Deleting someone from the team: they are gone for good — no way back in,
 * nothing left that was only theirs — while their name stays on what they did.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { api, createUser, freshDatabase, signIn, TEST_DB } from './testing.js';
import { getPool } from './db.js';
import { setPushSender } from './push.js';

async function body<T = Record<string, any>>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

const KEYS = { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', auth: 'tBHItJI5svbpez7KI4CCXg' };

describe.skipIf(!TEST_DB)('deleting someone', () => {
  let alice: string;
  let bob: string;
  let carol: string;
  let aliceId: string;
  let bobId: string;
  let carolId: string;
  let pushed: string[];

  beforeEach(async () => {
    await freshDatabase();
    process.env.VAPID_PUBLIC_KEY = 'test-public-key';
    process.env.VAPID_PRIVATE_KEY = 'test-private-key';
    process.env.VAPID_SUBJECT = 'mailto:test@example.com';
    pushed = [];
    setPushSender(async (s) => { pushed.push(s.endpoint); return 'sent'; });
    aliceId = (await createUser('Alice', 'alice@example.com', 'admin')).id;
    bobId = (await createUser('Bob', 'bob@example.com')).id;
    carolId = (await createUser('Carol', 'carol@example.com')).id;
    alice = await signIn('alice@example.com');
    bob = await signIn('bob@example.com');
    carol = await signIn('carol@example.com');
  });

  afterEach(() => {
    setPushSender(null);
    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
    delete process.env.VAPID_SUBJECT;
  });

  const remove = (cookie: string, userId: string, headers?: Record<string, string>) =>
    api('/api/team/delete', { cookie, body: { userId }, headers });
  const sync = (cookie: string, changes: unknown[]) => api('/api/sync', { cookie, body: { changes } });

  it('signs them out everywhere and stops them ever signing in again', async () => {
    expect((await remove(alice, bobId)).status).toBe(200);
    expect((await api('/api/sync', { cookie: bob })).status).toBe(401);
    await expect(signIn('bob@example.com')).rejects.toThrow(/sign-in failed/);
    const { rows } = await getPool().query('select count(*)::int as n from account where "userId" = $1', [bobId]);
    expect(rows[0].n).toBe(0);
  });

  it('frees their email address for someone new', async () => {
    await remove(alice, bobId);
    const newBob = await createUser('Robert', 'bob@example.com');
    expect(newBob.id).not.toBe(bobId);
    await expect(signIn('bob@example.com')).resolves.toContain('=');
  });

  it('keeps their messages and comments, under their name marked deleted', async () => {
    await sync(alice, [{ collection: 'aircraft', id: 'air_1', data: { id: 'air_1', tailNumber: 'N123AB' }, baseVersion: 0 }]);
    const direct = await body(await api('/api/chat/conversations', { cookie: bob, body: { kind: 'direct', userId: aliceId } }));
    await api(`/api/chat/conversations/${direct.id}/messages`, { cookie: bob, body: { body: 'from bob' } });
    const group = await body(await api('/api/chat/conversations', { cookie: alice, body: { kind: 'group', name: 'Team', memberIds: [bobId, carolId] } }));
    await api(`/api/chat/conversations/${group.id}/messages`, { cookie: bob, body: { body: 'bob in the group' } });
    await api('/api/aircraft/air_1/comments', { cookie: bob, body: { body: 'bob commented' } });

    await remove(alice, bobId);

    const dm = await body(await api(`/api/chat/conversations/${direct.id}/messages`, { cookie: alice }));
    expect(dm.messages.map((m: { body: string; senderName: string }) => [m.body, m.senderName])).toEqual([['from bob', 'Bob (deleted)']]);
    const conv = await body(await api(`/api/chat/conversations/${direct.id}`, { cookie: alice }));
    expect(conv.title).toBe('Bob (deleted)');
    const inGroup = await body(await api(`/api/chat/conversations/${group.id}/messages`, { cookie: carol }));
    expect(inGroup.messages[0]).toMatchObject({ body: 'bob in the group', senderName: 'Bob (deleted)' });
    const groupInfo = await body(await api(`/api/chat/conversations/${group.id}`, { cookie: carol }));
    expect(groupInfo.members.map((m: { name: string }) => m.name)).toEqual(['Alice', 'Carol']);
    const thread = await body(await api('/api/aircraft/air_1/comments', { cookie: carol }));
    expect(thread.comments[0]).toMatchObject({ body: 'bob commented', authorName: 'Bob (deleted)' });
  });

  it('removes what was only theirs: devices, watches, read markers, notifications, settings', async () => {
    await sync(alice, [{ collection: 'aircraft', id: 'air_1', data: { id: 'air_1', tailNumber: 'N123AB' }, baseVersion: 0 }]);
    await sync(bob, [{ collection: 'settings', id: bobId, data: { theme: 'dark' }, baseVersion: 0 }]);
    await api('/api/push/subscribe', { cookie: bob, body: { subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/bob', keys: KEYS } } });
    await api('/api/aircraft/air_1/watch', { cookie: bob, body: { watching: true } });
    await api('/api/aircraft/air_1/comments', { cookie: alice, body: { body: 'hello' } });
    await api('/api/inbox', { cookie: bob, body: { deviceId: 'bob-phone-1', view: 'app' } });

    await remove(alice, bobId);

    for (const table of ['app_push_subscription', 'app_aircraft_watch', 'app_aircraft_comment_read', 'app_notification', 'app_presence']) {
      const { rows } = await getPool().query(`select count(*)::int as n from ${table} where user_id = $1`, [bobId]);
      expect(rows[0].n, table).toBe(0);
    }
    const { rows } = await getPool().query(`select data from app_record where collection = 'settings' and id = $1`, [bobId]);
    expect(rows[0].data).toBeNull();
  });

  it('is never notified again, and cannot be messaged', async () => {
    const group = await body(await api('/api/chat/conversations', { cookie: alice, body: { kind: 'group', name: 'Team', memberIds: [bobId, carolId] } }));
    const direct = await body(await api('/api/chat/conversations', { cookie: alice, body: { kind: 'direct', userId: bobId } }));
    await remove(alice, bobId);
    await api(`/api/chat/conversations/${group.id}/messages`, { cookie: alice, body: { body: 'still here?' } });
    const { rows } = await getPool().query('select count(*)::int as n from app_notification where user_id = $1', [bobId]);
    expect(rows[0].n).toBe(0);
    expect((await api(`/api/chat/conversations/${direct.id}/messages`, { cookie: alice, body: { body: 'hello?' } })).status).toBe(409);
    expect((await api('/api/chat/conversations', { cookie: alice, body: { kind: 'direct', userId: bobId } })).status).toBe(400);
    expect((await api('/api/chat/conversations', { cookie: alice, body: { kind: 'group', name: 'x', memberIds: [bobId] } })).status).toBe(400);
  });

  it('hands their follow-ups back to everyone, as a change every device picks up', async () => {
    const fu = { id: 'fup_1', dueDate: '2026-10-10', note: 'Call back', assigneeId: bobId, completed: false };
    await sync(alice, [{ collection: 'followUps', id: 'fup_1', data: fu, baseVersion: 0 }]);
    const before = await getPool().query(`select version, seq from app_record where id = 'fup_1'`);
    await remove(alice, bobId);
    const after = await getPool().query(`select data, version, seq from app_record where id = 'fup_1'`);
    expect(after.rows[0].data.assigneeId).toBeNull();
    expect(after.rows[0].data.note).toBe('Call back');
    expect(after.rows[0].version).toBe(before.rows[0].version + 1);
    expect(Number(after.rows[0].seq)).toBeGreaterThan(Number(before.rows[0].seq));
    const pulled = await body(await api(`/api/sync?since=${before.rows[0].seq}`, { cookie: carol }));
    expect(pulled.records.find((r: { id: string }) => r.id === 'fup_1').data.assigneeId).toBeNull();
  });

  it('keeps the activity history, and records the deletion for admins only', async () => {
    await sync(bob, [{ collection: 'contacts', id: 'con_1', data: { id: 'con_1', firstName: 'Ann' }, baseVersion: 0 }]);
    await remove(alice, bobId);
    const { entries } = await body(await api('/api/history', { cookie: carol }));
    expect(entries.some((e: { userName: string; recordId: string }) => e.userName === 'Bob' && e.recordId === 'con_1')).toBe(true);
    expect(entries.some((e: { collection: string }) => e.collection === 'security')).toBe(false);
    const { rows } = await getPool().query(`select user_id, action, record_id from app_audit where collection = 'security'`);
    expect(rows).toEqual([{ user_id: aliceId, action: 'user-deleted', record_id: bobId }]);
    // The contact Bob made is still there.
    const pulled = await body(await api('/api/sync?full=1', { cookie: carol }));
    expect(pulled.records.some((r: { id: string }) => r.id === 'con_1')).toBe(true);
  });

  it('marks them deleted in the team list, so pickers leave them out but their name still shows', async () => {
    await remove(alice, bobId);
    const { people } = await body(await api('/api/team', { cookie: carol }));
    expect(people.find((p: { id: string }) => p.id === bobId)).toEqual({ id: bobId, name: 'Bob (deleted)', active: false, deleted: true });
    expect(people.find((p: { id: string }) => p.id === carolId)).toEqual({ id: carolId, name: 'Carol', active: true });
  });

  it('cannot be undone through the admin account controls', async () => {
    await remove(alice, bobId);
    for (const [path, extra] of [
      ['unban-user', {}],
      ['set-user-password', { newPassword: 'a brand new password' }],
      ['set-role', { role: 'admin' }],
    ] as const) {
      const r = await api(`/api/auth/admin/${path}`, { cookie: alice, body: { userId: bobId, ...extra } });
      expect(r.status, path).toBe(409);
    }
    const { rows } = await getPool().query('select banned, role from "user" where id = $1', [bobId]);
    expect(rows[0]).toEqual({ banned: true, role: 'user' });
    // Everyone else is still managed as before.
    expect((await api('/api/auth/admin/ban-user', { cookie: alice, body: { userId: carolId } })).ok).toBe(true);
  });

  describe('who may delete whom', () => {
    it('only an admin', async () => {
      expect((await remove(bob, carolId)).status).toBe(403);
      expect((await remove('', carolId)).status).toBe(401);
      const { rows } = await getPool().query('select count(*)::int as n from app_deleted_user');
      expect(rows[0].n).toBe(0);
    });

    it('never yourself', async () => {
      expect((await remove(alice, aliceId)).status).toBe(400);
    });

    it('another admin, leaving the one who deleted them as an admin', async () => {
      const daveId = (await createUser('Dave', 'dave@example.com', 'admin')).id;
      expect((await remove(alice, daveId)).status).toBe(200);
      const { rows } = await getPool().query(
        `select count(*)::int as n from "user" where role = 'admin' and not coalesce(banned, false)`,
      );
      expect(rows[0].n).toBe(1);
      // A deleted admin is no admin at all.
      expect((await getPool().query('select role from "user" where id = $1', [daveId])).rows[0].role).toBe('user');
    });

    it('not by an admin whose access is off', async () => {
      await getPool().query(`update "user" set role = 'admin' where id = $1`, [carolId]);
      const carolAdmin = await signIn('carol@example.com');
      await getPool().query('update "user" set banned = true where id = $1', [carolId]);
      expect((await remove(carolAdmin, aliceId)).status).toBe(401);
      expect((await getPool().query('select count(*)::int as n from app_deleted_user')).rows[0].n).toBe(0);
    });

    it('refuses an unknown person, someone already deleted, and another site', async () => {
      expect((await remove(alice, 'nobody')).status).toBe(404);
      expect((await remove(alice, bobId)).status).toBe(200);
      expect((await remove(alice, bobId)).status).toBe(404);
      expect((await remove(alice, carolId, { origin: 'https://evil.example' })).status).toBe(403);
      expect((await api('/api/team/delete', { cookie: alice })).status).toBe(405);
    });
  });
});
