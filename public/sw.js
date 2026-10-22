/* 收盘手记 service worker：只缓存页面外壳与静态资源，绝不缓存 /api 数据。 */
const VERSION = 'afterclose-v1'
const PAGE_CACHE = `${VERSION}-pages`
const ASSET_CACHE = `${VERSION}-assets`
const OFFLINE_URL = '/offline.html'
const PRECACHE = [
  OFFLINE_URL,
  '/manifest.webmanifest',
  '/cockpit-192.png',
  '/cockpit-512.png',
]

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(PAGE_CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((key) => !key.startsWith(VERSION)).map((key) => caches.delete(key)),
      ))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting()
})

function isStaticAsset(request, url) {
  if (url.pathname.startsWith('/_next/static/')) return true
  return ['style', 'script', 'image', 'font'].includes(request.destination)
}

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return
  if (url.pathname.startsWith('/api/')) return
  if (url.pathname.startsWith('/_next/data/')) return

  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const response = await fetch(request)
        if (response.ok && !response.redirected) {
          const copy = response.clone()
          caches.open(PAGE_CACHE).then((cache) => cache.put(request, copy)).catch(() => {})
        }
        return response
      } catch {
        const cached = await caches.match(request)
        if (cached) return cached
        const today = await caches.match('/today')
        if (today) return today
        return (await caches.match(OFFLINE_URL)) || Response.error()
      }
    })())
    return
  }

  if (isStaticAsset(request, url)) {
    event.respondWith((async () => {
      const cached = await caches.match(request)
      if (cached) return cached
      try {
        const response = await fetch(request)
        if (response.ok) {
          const copy = response.clone()
          caches.open(ASSET_CACHE).then((cache) => cache.put(request, copy)).catch(() => {})
        }
        return response
      } catch {
        return Response.error()
      }
    })())
  }
})
