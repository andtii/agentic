/*
 * Agentic's service worker (#244): Web Push only — no caching, no offline.
 *
 * Pushes carry no content (the platform sends contentless Web Push, see
 * architecture §9), so a push means "your inbox changed": show one
 * notification (a new one replaces the last, same tag) and, on click, focus
 * an open Agentic tab or open the home page, where the inbox is.
 */
self.addEventListener('install', () => {
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
    event.waitUntil(
        self.registration.showNotification('Agentic', {
            body: 'Something needs you — open to see your inbox.',
            tag: 'agentic-inbox',
            renotify: true,
            icon: '/favicon.svg',
            data: { url: '/' }
        })
    );
});

self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const url = new URL((event.notification.data && event.notification.data.url) || '/', self.location.origin).href;
    event.waitUntil(
        (async () => {
            const open = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
            for (const client of open) {
                if (new URL(client.url).origin === self.location.origin && 'focus' in client) {
                    await client.focus();
                    return;
                }
            }
            await self.clients.openWindow(url);
        })()
    );
});
