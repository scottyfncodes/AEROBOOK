/**
 * Notifications on this device: the service worker, the browser's
 * permission, and the push subscription the server sends to.
 *
 * iPhone and iPad only deliver web push to an app added to the Home Screen
 * (iOS 16.4 and later) and opened from there; in a Safari tab there is no
 * push at all. Permission can only be asked for from a tap, so enable() asks
 * before doing anything else.
 */
import * as api from './messaging';

export type PushState =
  /** This browser has no web push. */
  | 'unsupported'
  /** An iPhone or iPad in a Safari tab: add to the Home Screen first. */
  | 'install-first'
  /** The deployment has no push keys yet. */
  | 'server-off'
  /** Turned down in the browser; only the device's settings can undo that. */
  | 'denied'
  /** Could be turned on here. */
  | 'off'
  | 'on';

function isAppleMobile(): boolean {
  const ua = navigator.userAgent;
  // iPadOS reports itself as a Mac, but a Mac has no touch screen.
  return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

function isStandalone(): boolean {
  return window.matchMedia?.('(display-mode: standalone)').matches
    || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

function hasPush(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

/** Registered as the app opens. It caches nothing; see public/sw.js. */
export function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => undefined);
}

async function registration(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) return null;
  const existing = await navigator.serviceWorker.getRegistration('/');
  if (existing) return existing;
  try {
    return await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  } catch {
    return null;
  }
}

async function currentSubscription(): Promise<PushSubscription | null> {
  const reg = await registration();
  return (await reg?.pushManager.getSubscription()) ?? null;
}

export async function pushState(): Promise<PushState> {
  if (!hasPush()) return isAppleMobile() && !isStandalone() ? 'install-first' : 'unsupported';
  const config = await api.pushConfig().catch(() => null);
  if (!config?.enabled) return 'server-off';
  if (Notification.permission === 'denied') return 'denied';
  if (Notification.permission !== 'granted') return 'off';
  const subscription = await currentSubscription();
  if (!subscription) return 'off';
  const { thisDevice } = await api.pushStatus(subscription.endpoint);
  return thisDevice ? 'on' : 'off';
}

function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const padded = `${base64url}${'='.repeat((4 - (base64url.length % 4)) % 4)}`.replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

function sameKey(subscription: PushSubscription, publicKey: string): boolean {
  const current = subscription.options?.applicationServerKey;
  if (!current) return true;
  const a = new Uint8Array(current);
  const b = keyBytes(publicKey);
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** Call straight from a tap. Resolves to the state it ends in. */
export async function enablePush(): Promise<PushState> {
  if (!hasPush()) return isAppleMobile() && !isStandalone() ? 'install-first' : 'unsupported';
  // First, while the tap still counts: Safari will not ask otherwise.
  const permission = await Notification.requestPermission();
  if (permission === 'denied') return 'denied';
  if (permission !== 'granted') return 'off';
  const config = await api.pushConfig();
  if (!config.enabled || !config.publicKey) return 'server-off';
  const reg = await registration();
  if (!reg) return 'unsupported';
  let subscription = await reg.pushManager.getSubscription();
  if (subscription && !sameKey(subscription, config.publicKey)) {
    await subscription.unsubscribe().catch(() => undefined);
    subscription = null;
  }
  subscription ??= await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: keyBytes(config.publicKey),
  });
  await api.savePushSubscription(subscription.toJSON());
  return 'on';
}

/** Stops notifications on this device only. */
export async function disablePush(): Promise<void> {
  const subscription = await currentSubscription();
  if (!subscription) return;
  await api.removePushSubscription(subscription.endpoint).catch(() => undefined);
  await subscription.unsubscribe().catch(() => undefined);
}

/**
 * As the app opens: a device that already has permission is re-registered
 * for whoever is signed in now (a shared iPad, a key that was changed).
 */
export async function refreshPush(): Promise<void> {
  if (!hasPush() || Notification.permission !== 'granted') return;
  const subscription = await currentSubscription();
  if (!subscription) return;
  const config = await api.pushConfig();
  if (!config.enabled || !config.publicKey) return;
  if (!sameKey(subscription, config.publicKey)) {
    await enablePush();
    return;
  }
  await api.savePushSubscription(subscription.toJSON());
}

/** On sign-out: this device stops hearing about the account it is leaving. */
export async function forgetDevice(): Promise<void> {
  if (!hasPush()) return;
  await disablePush().catch(() => undefined);
}
