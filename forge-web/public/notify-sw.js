/*
 * Web Push for the optional notification service (services/forge-notify).
 *
 * Registered only when a build names a service (NEXT_PUBLIC_NOTIFY_URL) and the user turns push
 * on in Settings → Notifications. It shows what the service sent ({title, body, url, tag}) and
 * opens the link on click. It caches nothing and intercepts no requests.
 */

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))

function text(v, max) {
  return typeof v === 'string' ? v.slice(0, max) : ''
}

function safeUrl(v) {
  try {
    const u = new URL(v, self.registration.scope)
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : self.registration.scope
  } catch {
    return self.registration.scope
  }
}

self.addEventListener('push', (event) => {
  let data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch {
    data = {}
  }
  const title = text(data.title, 120) || 'Dash Forge'
  event.waitUntil(
    self.registration.showNotification(title, {
      body: text(data.body, 300),
      tag: text(data.tag, 64) || undefined,
      data: { url: safeUrl(data.url) },
    }),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = (event.notification.data && event.notification.data.url) || self.registration.scope
  event.waitUntil(self.clients.openWindow(url))
})
