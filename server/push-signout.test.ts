/**
 * Turning notifications on and off on a device, and signing out: the app's
 * own push code (src/data/push.ts) against the real server and database,
 * with the browser's push APIs replaced by a stand-in.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, createUser, freshDatabase, ORIGIN, signIn, TEST_DB } from './testing.js';
import { handle } from './app.js';
import { getPool } from './db.js';
import { setPushSender } from './push.js';
import { disablePush, enablePush, forgetDevice, pushState } from '../src/data/push';

const KEYS = { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', auth: 'tBHItJI5svbpez7KI4CCXg' };

/** One browser: its push subscription (if any), and who is signed in on it. */
function fakeBrowser(endpoint: string) {
  let cookie = '';
  let current: { endpoint: string; unsubscribe: ReturnType<typeof vi.fn>; options: object; toJSON: () => object } | null = null;
  const pushManager = {
    getSubscription: vi.fn(async () => current),
    subscribe: vi.fn(async () => {
      current = {
        endpoint,
        options: {},
        unsubscribe: vi.fn(async () => { current = null; return true; }),
        toJSON: () => ({ endpoint, keys: KEYS }),
      };
      return current;
    }),
  };
  const registration = { pushManager };
  vi.stubGlobal('window', { PushManager: class {}, Notification: {}, matchMedia: () => ({ matches: false }) });
  vi.stubGlobal('navigator', {
    userAgent: 'Mozilla/5.0 (Macintosh) Chrome/140',
    maxTouchPoints: 0,
    serviceWorker: { getRegistration: vi.fn(async () => registration), register: vi.fn(async () => registration) },
  });
  vi.stubGlobal('Notification', { permission: 'granted', requestPermission: vi.fn(async () => 'granted') });
  vi.stubGlobal('fetch', (input: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    if (cookie) headers.set('cookie', cookie);
    headers.set('origin', ORIGIN);
    return handle(new Request(`${ORIGIN}${input}`, { ...init, headers }));
  });
  return {
    signInAs: (c: string) => { cookie = c; },
    subscription: () => current,
  };
}

describe.skipIf(!TEST_DB)('notifications on this device', () => {
  let bob: string;
  let bobId: string;
  let alice: string;
  let pushed: string[];
  const PHONE = 'https://fcm.googleapis.com/fcm/send/bob-phone';

  beforeEach(async () => {
    await freshDatabase();
    process.env.VAPID_PUBLIC_KEY = KEYS.p256dh;
    process.env.VAPID_PRIVATE_KEY = 'test-private-key';
    process.env.VAPID_SUBJECT = 'mailto:test@example.com';
    pushed = [];
    setPushSender(async (s) => { pushed.push(s.endpoint); return 'sent'; });
    await createUser('Alice', 'alice@example.com', 'admin');
    bobId = (await createUser('Bob', 'bob@example.com')).id;
    alice = await signIn('alice@example.com');
    bob = await signIn('bob@example.com');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setPushSender(null);
    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
    delete process.env.VAPID_SUBJECT;
  });

  const subscriptions = async () =>
    (await getPool().query('select user_id, endpoint from app_push_subscription order by id')).rows;
  const messageBob = async () => {
    const convo = await (await api('/api/chat/conversations', { cookie: alice, body: { kind: 'direct', userId: bobId } })).json();
    await api(`/api/chat/conversations/${convo.id}/messages`, { cookie: alice, body: { body: 'hello' } });
  };

  it('turns on for the signed-in person, and off again on this device only', async () => {
    const browser = fakeBrowser(PHONE);
    browser.signInAs(bob);
    expect(await pushState()).toBe('off');
    expect(await enablePush()).toBe('on');
    expect(await pushState()).toBe('on');
    expect(await subscriptions()).toEqual([{ user_id: bobId, endpoint: PHONE }]);
    await messageBob();
    expect(pushed).toEqual([PHONE]);

    await disablePush();
    expect(await subscriptions()).toEqual([]);
    expect(browser.subscription()).toBeNull();
  });

  it('forgets the device on sign-out, while the session still lets it, so the account it left is not notified there', async () => {
    const browser = fakeBrowser(PHONE);
    browser.signInAs(bob);
    await enablePush();
    const sub = browser.subscription()!;

    // What signOut() does, in its order: forget the device, then end the session.
    await forgetDevice();
    await api('/api/auth/sign-out', { cookie: bob, body: {} });

    expect(sub.unsubscribe).toHaveBeenCalledTimes(1);
    expect(await subscriptions()).toEqual([]);
    await messageBob();
    expect(pushed).toEqual([]);
  });

  it('keeps other devices on when one signs out', async () => {
    await api('/api/push/subscribe', { cookie: bob, body: { subscription: { endpoint: 'https://web.push.apple.com/bob-laptop', keys: KEYS } } });
    const browser = fakeBrowser(PHONE);
    browser.signInAs(bob);
    await enablePush();
    await forgetDevice();
    expect(await subscriptions()).toEqual([{ user_id: bobId, endpoint: 'https://web.push.apple.com/bob-laptop' }]);
    await messageBob();
    expect(pushed).toEqual(['https://web.push.apple.com/bob-laptop']);
  });

  it('cannot be removed once the session has ended, which is why sign-out forgets the device first', async () => {
    const browser = fakeBrowser(PHONE);
    browser.signInAs(bob);
    await enablePush();
    await api('/api/auth/sign-out', { cookie: bob, body: {} });
    expect((await api('/api/push/unsubscribe', { cookie: bob, body: { endpoint: PHONE } })).status).toBe(401);
    expect(await subscriptions()).toHaveLength(1);
  });

  it('never fails sign-out, even with the server unreachable', async () => {
    const browser = fakeBrowser(PHONE);
    browser.signInAs(bob);
    await enablePush();
    vi.stubGlobal('fetch', async () => { throw new TypeError('offline'); });
    await expect(forgetDevice()).resolves.toBeUndefined();
    // The browser side is still dropped, so nothing reaches this device.
    expect(browser.subscription()).toBeNull();
  });
});
