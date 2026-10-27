/* AntifieldComplexx Service Worker（无构建步骤，纯静态）。
 * 安全边界：
 * - 只缓存静态壳资源（离线页、图标、manifest）与构建后的 /assets/* 哈希资源；
 * - 绝不缓存 /api/*（含文件内容）、/healthz 与公开分享页 /s/*；
 * - 导航请求网络优先，离线时回退 offline.html。
 * 版本：注册 URL 带 ?v=<构建入口 hash>，缓存名随之变化；新 SW 立即接管并清理旧静态缓存。 */
/* eslint-disable no-undef */

const REGISTRATION_URL = new URL(self.location.href)
const BUILD_VERSION = REGISTRATION_URL.searchParams.get('v') || 'v1'
const CACHE_PREFIX = 'antifieldcloud-static-'
const CACHE_NAME = `${CACHE_PREFIX}${BUILD_VERSION}`
const OFFLINE_URL = '/offline.html'
const PRECACHE_URLS = [
  OFFLINE_URL,
  '/manifest.webmanifest',
  '/favicon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-512.png',
  '/icons/apple-touch-icon.png',
]
const NEVER_CACHE_PREFIXES = ['/api/', '/healthz', '/s/']
const STATIC_PREFIXES = ['/assets/', '/icons/']

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  )
})

function isNeverCached(pathname) {
  return NEVER_CACHE_PREFIXES.some((prefix) => pathname.startsWith(prefix))
}

function isStaticAsset(pathname) {
  if (pathname === '/favicon.svg') return true
  return STATIC_PREFIXES.some((prefix) => pathname.startsWith(prefix))
}

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return

  let url
  try {
    url = new URL(request.url)
  } catch {
    return
  }
  if (url.origin !== self.location.origin) return
  // 会话/文件内容/公开分享数据一律走网络，绝不进缓存
  if (isNeverCached(url.pathname)) return

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() =>
        caches.match(OFFLINE_URL).then(
          (cached) =>
            cached ||
            new Response('当前离线，且离线页面尚未缓存。', {
              status: 503,
              headers: { 'Content-Type': 'text/plain; charset=utf-8' },
            }),
        ),
      ),
    )
    return
  }

  if (!isStaticAsset(url.pathname)) return

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached
      return fetch(request).then((response) => {
        if (response.ok) {
          const copy = response.clone()
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy))
        }
        return response
      })
    }),
  )
})
