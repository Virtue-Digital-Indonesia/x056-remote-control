// x056 service worker: receives Web Push and shows a notification even when the
// installed (home-screen) panel is closed. Clicking it focuses the panel and
// tells it which project to open.
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (event) { event.waitUntil(self.clients.claim()); });

self.addEventListener('push', function (event) {
  var data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) {}
  var title = data.title || 'x056';
  event.waitUntil(self.registration.showNotification(title, {
    body: data.body || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: 'x056-' + (data.projectId || 'general'),
    renotify: true,
    data: { projectId: data.projectId || '' },
  }));
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  var pid = (event.notification.data && event.notification.data.projectId) || '';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
      for (var i = 0; i < list.length; i++) {
        var c = list[i];
        if ('focus' in c) { try { c.postMessage({ type: 'x056-open', projectId: pid }); } catch (e) {} return c.focus(); }
      }
      if (self.clients.openWindow) return self.clients.openWindow('/?project=' + encodeURIComponent(pid));
    })
  );
});
