/**
 * The service worker (public/sw.js), run against a stand-in for the browser's
 * service-worker globals: what a push shows, and where tapping it goes.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const source = readFileSync(join(__dirname, '../../public/sw.js'), 'utf8');

interface FakeWindow {
  url: string;
  focus: ReturnType<typeof vi.fn>;
  postMessage: ReturnType<typeof vi.fn>;
}

function load(windows: FakeWindow[] = []) {
  const handlers: Record<string, (event: unknown) => void> = {};
  const self = {
    location: { origin: 'https://aerobook.example' },
    registration: { showNotification: vi.fn(async () => undefined) },
    clients: {
      matchAll: vi.fn(async () => windows),
      openWindow: vi.fn(async () => undefined),
      claim: vi.fn(async () => undefined),
    },
    skipWaiting: vi.fn(),
    addEventListener: (type: string, fn: (event: unknown) => void) => {
      handlers[type] = fn;
    },
  };
  new Function('self', source)(self);
  const fire = async (type: string, event: Record<string, unknown>) => {
    let pending: Promise<unknown> = Promise.resolve();
    handlers[type]({ ...event, waitUntil: (p: Promise<unknown>) => { pending = p; } });
    await pending;
  };
  return { self, fire };
}

const pushEvent = (data: unknown) => ({ data: { json: () => data } });
const win = (url: string): FakeWindow => ({ url, focus: vi.fn(async () => undefined), postMessage: vi.fn() });

describe('the service worker', () => {
  it('shows the notification the server sent, one per conversation', async () => {
    const { self, fire } = load();
    await fire('push', pushEvent({ title: 'AEROBOOK', body: 'New message from Scott', url: '/chat/cv_1', tag: 'conv:cv_1' }));
    expect(self.registration.showNotification).toHaveBeenCalledWith('AEROBOOK', expect.objectContaining({
      body: 'New message from Scott', tag: 'conv:cv_1', renotify: true, data: { url: '/chat/cv_1' },
    }));
  });

  it('always shows something, even for a push it cannot read', async () => {
    const { self, fire } = load();
    await fire('push', { data: { json: () => { throw new Error('not json'); } } });
    expect(self.registration.showNotification).toHaveBeenCalledWith('AEROBOOK', expect.objectContaining({
      body: 'Something new in AEROBOOK', data: { url: '/' },
    }));
  });

  it('tells an open window to check for new messages', async () => {
    const open = win('https://aerobook.example/aircraft');
    const { fire } = load([open]);
    await fire('push', pushEvent({ body: 'x', url: '/chat/cv_1', tag: 'conv:cv_1' }));
    expect(open.postMessage).toHaveBeenCalledWith({ type: 'aerobook:push', tag: 'conv:cv_1' });
  });

  it('opens the app at the conversation when it is not running', async () => {
    const { self, fire } = load();
    const close = vi.fn();
    await fire('notificationclick', { notification: { close, data: { url: '/chat/cv_1' } } });
    expect(close).toHaveBeenCalled();
    expect(self.clients.openWindow).toHaveBeenCalledWith('/chat/cv_1');
  });

  it('brings an open window forward and takes it to the aircraft’s comments', async () => {
    const open = win('https://aerobook.example/');
    const { self, fire } = load([open]);
    await fire('notificationclick', { notification: { close: vi.fn(), data: { url: '/aircraft/air_1#comments' } } });
    expect(open.focus).toHaveBeenCalled();
    expect(open.postMessage).toHaveBeenCalledWith({ type: 'aerobook:open', url: '/aircraft/air_1#comments' });
    expect(self.clients.openWindow).not.toHaveBeenCalled();
  });

  it('never leaves the app, whatever the notification says', async () => {
    const { self, fire } = load();
    await fire('notificationclick', { notification: { close: vi.fn(), data: { url: 'https://evil.example/login' } } });
    expect(self.clients.openWindow).toHaveBeenCalledWith('/');
    await fire('push', pushEvent({ body: 'x', url: 'javascript:alert(1)' }));
    expect(self.registration.showNotification).toHaveBeenLastCalledWith('AEROBOOK', expect.objectContaining({ data: { url: '/' } }));
  });
});
