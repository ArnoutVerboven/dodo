/* dodo service worker: shows web push notifications sent through Firebase Cloud Messaging.
 * The server sends data-only messages ({ title, body, url, tag, kind }); every push shows a
 * notification, because iOS drops push for a worker that stays silent. */

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { data: { body: event.data ? event.data.text() : '' } };
  }
  const d = payload.data || payload.notification || payload;
  const needsYou = d.kind === 'approval' || d.kind === 'choice' || d.kind === 'text';
  event.waitUntil(
    self.registration.showNotification(d.title || 'dodo', {
      body: d.body || '',
      icon: '/icon.svg',
      badge: '/icon.svg',
      tag: d.tag || undefined,
      renotify: !!d.tag,
      requireInteraction: needsYou,
      data: { url: d.url || '/' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || '/', self.location.origin);
  // Only open pages of this app, whatever the payload says.
  const url = target.origin === self.location.origin ? target.href : self.location.origin;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const w of windows) {
        if (new URL(w.url).origin === self.location.origin && 'focus' in w) {
          await w.focus();
          if ('navigate' in w) await w.navigate(url).catch(() => {});
          return;
        }
      }
      await self.clients.openWindow(url);
    })(),
  );
});
