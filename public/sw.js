/*
 * AEROBOOK's service worker. It does one job: notifications.
 *
 * It caches nothing and answers no page requests, so the app always loads
 * exactly as it would without it; the device's own copy of the data is kept
 * by the app itself (IndexedDB), as before.
 *
 * push              show the notification the server sent (who and where,
 *                   never what was said), and tell any open window to check
 *                   for new messages now
 * notificationclick bring AEROBOOK forward on the conversation or aircraft,
 *                   opening it if it is not running
 */

/** Only ever a page of this app: a notification cannot send someone elsewhere. */
function safeUrl(url) {
  try {
    const u = new URL(url || '/', self.location.origin);
    return u.origin === self.location.origin ? u.pathname + u.search + u.hash : '/';
  } catch {
    return '/';
  }
}

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  const tag = typeof data.tag === 'string' && data.tag ? data.tag : undefined;
  // Every push shows a notification: Safari withdraws permission from a
  // site that receives pushes and shows nothing.
  const shown = self.registration.showNotification(typeof data.title === 'string' && data.title ? data.title : 'AEROBOOK', {
    body: typeof data.body === 'string' && data.body ? data.body : 'Something new in AEROBOOK',
    tag,
    // A newer one for the same conversation replaces the older, and still alerts.
    renotify: Boolean(tag),
    icon: '/brand/icon-192.png',
    data: { url: safeUrl(data.url) },
  });
  const nudge = self.clients
    .matchAll({ type: 'window', includeUncontrolled: true })
    .then((windows) => windows.forEach((w) => w.postMessage({ type: 'aerobook:push', tag })));
  event.waitUntil(Promise.all([shown, nudge]));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = safeUrl(event.notification.data && event.notification.data.url);
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const open = windows.find((w) => {
      try {
        return new URL(w.url).origin === self.location.origin;
      } catch {
        return false;
      }
    });
    if (open) {
      try {
        await open.focus();
        open.postMessage({ type: 'aerobook:open', url });
        return;
      } catch {
        // Could not bring it forward; open a fresh window instead.
      }
    }
    await self.clients.openWindow(url);
  })());
});
