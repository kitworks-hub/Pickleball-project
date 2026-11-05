/* Shows push notifications from MPC, even when the site is closed. The server sends data-only messages (title and body inside),
   so nothing here needs Firebase's own library or any key. */
self.addEventListener('push', function (event) {
  var p = {};
  try { p = event.data ? event.data.json() : {}; } catch (e) { p = {}; }
  var d = p.data || {}, n = p.notification || {};
  var title = d.title || n.title || 'MPC';
  event.waitUntil(self.registration.showNotification(title, { body: d.body || n.body || '', icon: '/icon.jpg', badge: '/icon.jpg', tag: d.nid || undefined, data: d }));
});
self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
    for (var i = 0; i < list.length; i++) if ('focus' in list[i]) return list[i].focus();
    return self.clients.openWindow('/');
  }));
});
