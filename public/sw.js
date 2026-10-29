/* 收盘手记 service worker：只缓存离线外壳与静态资源，绝不缓存登录后的页面 HTML 或 /api 数据。 */
const VERSION = 'afterclose-v3'
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
    caches.open(ASSET_CACHE)
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

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  let target = '/tasks'
  try {
    const url = new URL(event.notification.data?.url || '/tasks', self.location.origin)
    if (url.origin === self.location.origin) target = `${url.pathname}${url.search}`
  } catch {
    /* 非站内链接回落到任务中心 */
  }
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    for (const client of windows) {
      if ('focus' in client) {
        await client.focus()
        if ('navigate' in client) await client.navigate(target)
        return
      }
    }
    await self.clients.openWindow(target)
  })())
})

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') {
    self.skipWaiting()
    return
  }
  if (event.data && event.data.type === 'CLEAR_CACHES') {
    event.waitUntil(
      caches.keys().then((keys) => Promise.all(keys.map((key) => caches.delete(key)))),
    )
  }
})

function isStaticAsset(request, url) {
  if (url.pathname.startsWith('/_next/static/')) return true
  return ['style', 'script', 'image', 'font'].includes(request.destination)
}

async function putAsset(request, response) {
  if (!response.ok) return
  const cache = await caches.open(ASSET_CACHE)
  await cache.put(request, response)
}

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return
  if (url.pathname.startsWith('/api/')) return
  if (url.pathname.startsWith('/_next/data/')) return

  if (request.mode === 'navigate') {
    // 页面含私有数据，只走网络；失败时给公开离线页，绝不回放缓存 HTML。
    event.respondWith((async () => {
      try {
        return await fetch(request)
      } catch {
        return (await caches.match(OFFLINE_URL)) || Response.error()
      }
    })())
    return
  }

  if (!isStaticAsset(request, url)) return

  // 带内容 hash 的构建产物可长期缓存；其余静态资源用 stale-while-revalidate。
  if (url.pathname.startsWith('/_next/static/')) {
    event.respondWith((async () => {
      const cached = await caches.match(request)
      if (cached) return cached
      try {
        const response = await fetch(request)
        if (response.ok) await putAsset(request, response.clone())
        return response
      } catch {
        return Response.error()
      }
    })())
    return
  }

  event.respondWith((async () => {
    const cached = await caches.match(request)
    const network = fetch(request)
      .then(async (response) => {
        if (response.ok) await putAsset(request, response.clone())
        return response
      })
    if (cached) {
      event.waitUntil(network.catch(() => {}))
      return cached
    }
    try {
      return await network
    } catch {
      return Response.error()
    }
  })())
})
