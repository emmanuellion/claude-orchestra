/* eslint-env serviceworker */

/**
 * The only part of Orchestra that runs when the tab is closed.
 *
 * Everything else in public/ assumes a live page. This file does not: it is
 * woken by the browser to show a push message and to route the tap that
 * follows. That is the whole reason it exists, and the reason it does nothing
 * else. There is no caching here and no offline shell, because a stale cached
 * copy of an app whose entire job is showing live agent state would be worse
 * than no app at all.
 *
 * Payloads arrive already decrypted by the browser; the push service that
 * carried them could not read them.
 */

const FALLBACK_TITLE = 'Claude Orchestra';
const ICON = '/favicon.svg';

/**
 * Reasons that justify overriding the browser's grouping and staying on screen.
 * A permission request blocks an agent until it is answered and then fails
 * closed, so it is the one thing worth interrupting for.
 */
const STICKY = new Set(['permission']);

self.addEventListener('install', () => {
  // Take over as soon as the new worker is ready. A user who just enabled push
  // should not have to close every tab before the first notification arrives.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

function parse(event) {
  if (!event.data) return null;
  try {
    return event.data.json();
  } catch (err) {
    // A payload we cannot read still has to become a notification: the Push API
    // requires one to be shown, and a silent drop looks to the browser like an
    // app abusing background wakeups.
    return { title: FALLBACK_TITLE, body: event.data.text ? event.data.text() : '' };
  }
}

self.addEventListener('push', (event) => {
  const data = parse(event) || {};
  const title = data.title || FALLBACK_TITLE;

  event.waitUntil(self.registration.showNotification(title, {
    body: data.body || '',
    icon: ICON,
    badge: ICON,
    // Same tag replaces rather than stacks, so an agent that asks twice does
    // not leave two notifications behind.
    tag: data.tag || data.reason || 'orchestra',
    renotify: !!data.tag,
    requireInteraction: !!data.requireInteraction || STICKY.has(data.reason),
    timestamp: data.ts || Date.now(),
    data: {
      url: data.url || '/',
      sessionId: data.sessionId || null,
      reason: data.reason || null,
    },
  }));
});

/**
 * Focus the tab that is already open rather than opening a fifth one, and tell
 * it where to go. Only if nothing is open do we launch a window.
 */
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/';
  const sessionId = event.notification.data && event.notification.data.sessionId;

  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      // Same origin is guaranteed by the scope, so any window will do.
      if ('focus' in client) {
        await client.focus();
        if (client.postMessage) {
          client.postMessage({ source: 'orchestra-push', url: target, sessionId });
        }
        return;
      }
    }
    if (self.clients.openWindow) await self.clients.openWindow(target);
  })());
});
