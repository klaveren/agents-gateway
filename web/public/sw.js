/**
 * 📱 O SERVICE WORKER do gateway: só o aviso de mensagem nova (Web Push). Não guarda nada em cache nem intercepta
 * requisições — a tela é sempre a da build em uso.
 */
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))

self.addEventListener('push', (event) => {
  let notice = {}
  try {
    notice = event.data ? event.data.json() : {}
  } catch {
    notice = { body: event.data ? event.data.text() : '' }
  }
  const url = typeof notice.url === 'string' && notice.url.startsWith('/') ? notice.url : '/messages'
  event.waitUntil(
    self.registration.showNotification(notice.title || 'Agents Gateway', {
      body: notice.body || '',
      tag: notice.tag || undefined,
      renotify: !!notice.tag,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      data: { url },
    }),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = new URL((event.notification.data && event.notification.data.url) || '/messages', self.location.origin).href
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      const open = windows.find((client) => new URL(client.url).origin === self.location.origin)
      if (open) return open.focus().then((client) => (client && 'navigate' in client ? client.navigate(url) : undefined))
      return self.clients.openWindow(url)
    }),
  )
})
