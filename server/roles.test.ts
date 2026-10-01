/**
 * Developers, admins and users: admins manage accounts, and only a developer
 * decides who is an admin or a developer, or touches a developer's account.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { api, createUser, freshDatabase, ORIGIN, signIn, TEST_DB } from './testing.js';
import { handle } from './app.js';
import { getPool } from './db.js';

describe.skipIf(!TEST_DB)('roles', () => {
  let dev: string;
  let admin: string;
  let devId: string;
  let adminId: string;
  let otherAdminId: string;
  let userId: string;

  beforeEach(async () => {
    await freshDatabase();
    devId = (await createUser('Dana', 'dana@example.com', 'developer')).id;
    adminId = (await createUser('Alice', 'alice@example.com', 'admin')).id;
    otherAdminId = (await createUser('Abe', 'abe@example.com', 'admin')).id;
    userId = (await createUser('Bob', 'bob@example.com')).id;
    dev = await signIn('dana@example.com');
    admin = await signIn('alice@example.com');
  });

  const roleOf = async (id: string) => (await getPool().query('select role from "user" where id = $1', [id])).rows[0].role;
  const setRole = (cookie: string, id: string, role: unknown) => api('/api/auth/admin/set-role', { cookie, body: { userId: id, role } });
  const create = (cookie: string, extra: Record<string, unknown>) => api('/api/auth/admin/create-user', {
    cookie, body: { name: 'Eve', email: 'eve@example.com', password: 'correct horse battery', ...extra },
  });

  it('a session says developer', async () => {
    const session = await (await api('/api/auth/get-session', { cookie: dev })).json();
    expect(session.user.role).toBe('developer');
  });

  describe('a developer', () => {
    it('makes and unmakes admins and developers', async () => {
      expect((await setRole(dev, userId, 'admin')).ok).toBe(true);
      expect(await roleOf(userId)).toBe('admin');
      expect((await setRole(dev, userId, 'developer')).ok).toBe(true);
      expect(await roleOf(userId)).toBe('developer');
      expect((await setRole(dev, adminId, 'user')).ok).toBe(true);
      expect(await roleOf(adminId)).toBe('user');
    });

    it('adds someone as an admin', async () => {
      expect((await create(dev, { role: 'admin' })).ok).toBe(true);
      expect((await getPool().query(`select role from "user" where email = 'eve@example.com'`)).rows[0].role).toBe('admin');
    });

    it('can do everything an admin can', async () => {
      expect((await api('/api/auth/admin/list-users?limit=10', { cookie: dev })).ok).toBe(true);
      expect((await api('/api/auth/admin/ban-user', { cookie: dev, body: { userId: adminId } })).ok).toBe(true);
      expect((await api('/api/team/delete', { cookie: dev, body: { userId } })).ok).toBe(true);
    });

    it('cannot give a role that does not exist', async () => {
      expect((await setRole(dev, userId, 'superuser')).ok).toBe(false);
      expect(await roleOf(userId)).toBe('user');
    });
  });

  describe('an admin', () => {
    it('still adds users and manages their accounts', async () => {
      expect((await create(admin, {})).ok).toBe(true);
      expect((await create(admin, { email: 'fay@example.com', role: 'user' })).ok).toBe(true);
      expect((await api('/api/auth/admin/ban-user', { cookie: admin, body: { userId } })).ok).toBe(true);
      expect((await api('/api/auth/admin/set-user-password', {
        cookie: admin, body: { userId, newPassword: 'a brand new password' },
      })).ok).toBe(true);
    });

    it('cannot make anyone an admin or a developer, however it is asked', async () => {
      for (const role of ['admin', 'developer', ['user', 'admin'], 'user,developer']) {
        expect((await setRole(admin, userId, role)).status, JSON.stringify(role)).toBe(403);
      }
      expect((await api('/api/auth/admin/update-user', { cookie: admin, body: { userId, data: { role: 'admin' } } })).status).toBe(403);
      expect((await create(admin, { role: 'admin' })).status).toBe(403);
      expect((await create(admin, { data: { role: 'developer' } })).status).toBe(403);
      expect(await roleOf(userId)).toBe('user');
      expect((await getPool().query(`select 1 from "user" where email = 'eve@example.com'`)).rows).toHaveLength(0);
    });

    it('cannot take away another admin’s role', async () => {
      expect((await setRole(admin, otherAdminId, 'user')).status).toBe(403);
      expect((await api('/api/auth/admin/update-user', { cookie: admin, body: { userId: otherAdminId, data: { role: 'user' } } })).status).toBe(403);
      expect(await roleOf(otherAdminId)).toBe('admin');
    });

    it('cannot touch a developer’s account', async () => {
      for (const [path, extra] of [
        ['set-role', { role: 'user' }],
        ['ban-user', {}],
        ['set-user-password', { newPassword: 'a brand new password' }],
        ['revoke-user-sessions', {}],
        ['update-user', { data: { name: 'Mallory' } }],
        ['impersonate-user', {}],
        ['remove-user', {}],
      ] as const) {
        const r = await api(`/api/auth/admin/${path}`, { cookie: admin, body: { userId: devId, ...extra } });
        expect(r.status, path).toBe(403);
      }
      expect((await api('/api/team/delete', { cookie: admin, body: { userId: devId } })).status).toBe(403);
      expect((await api('/api/team/reset-two-factor', { cookie: admin, body: { userId: devId } })).status).toBe(403);
      const { rows } = await getPool().query('select name, role, banned from "user" where id = $1', [devId]);
      expect(rows[0]).toEqual({ name: 'Dana', role: 'developer', banned: false });
      // Dana is still signed in.
      expect((await api('/api/sync', { cookie: dev })).ok).toBe(true);
    });

    it('must send JSON to the account controls', async () => {
      const r = await handle(new Request(`${ORIGIN}/api/auth/admin/set-role`, {
        method: 'POST',
        headers: { origin: ORIGIN, cookie: admin, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ userId, role: 'admin' }).toString(),
      }));
      expect(r.ok).toBe(false);
      expect(await roleOf(userId)).toBe('user');
    });
  });

  it('a user cannot do any of it', async () => {
    const bob = await signIn('bob@example.com');
    expect((await setRole(bob, userId, 'developer')).status).toBe(403);
    expect(await roleOf(userId)).toBe('user');
  });
});
