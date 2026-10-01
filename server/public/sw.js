// x056 service worker: receives Web Push and shows a notification even when the
// installed (home-screen) panel is closed. Clicking it focuses the panel and
// tells it which project to open.
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (event) { event.waitUntil(self.clients.claim()); });

// The payload is the gateway's notice (server/notices.ts): title, body, tag
// and link are decided there, so this only renders them. Tags are one per
// conversation (a newer notice replaces the older) or one per urgent item.
self.addEventListener('push', function (event) {
  var data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) {}
  var title = data.title || 'x056';
  event.waitUntil(self.registration.showNotification(title, {
    body: data.body || '',
    icon: '/icon-192.png?v=31f56a235316',
    badge: '/icon-192.png?v=31f56a235316',
    tag: data.tag || ('x056-' + (data.notificationId || data.sessionId || data.projectId || 'general')),
    renotify: false,
    data: { projectId: data.projectId || '', sessionId: data.sessionId || '', url: data.url || '' },
  }));
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  var pid = (event.notification.data && event.notification.data.projectId) || '';
  var sid = (event.notification.data && event.notification.data.sessionId) || '';
  var url = (event.notification.data && event.notification.data.url) || ('/?project=' + encodeURIComponent(pid) + '&session=' + encodeURIComponent(sid));
  if (!url.startsWith('/') || url.startsWith('//')) url = '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
      for (var i = 0; i < list.length; i++) {
        var c = list[i];
        if ('focus' in c) { try { c.postMessage({ type: 'x056-open', projectId: pid, sessionId: sid, url: url }); } catch (e) {} return c.focus(); }
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});
