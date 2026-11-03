// Harness needs a live host. An offline shell falsely looks like a connected app,
// and separately cached scripts can combine incompatible versions after updates.
self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil((async () => {
  for (const name of await caches.keys())
    if (name.startsWith('orchestrator-shell-')) await caches.delete(name);
  await self.clients.claim();
})()));
// Deliberately no fetch interception: the browser receives the server's no-store
// responses and real network errors. Do not cache API data or a partial app shell.
