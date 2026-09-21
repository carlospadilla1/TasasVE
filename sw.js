/* ============================================================
 * Tasas Venezuela · Service Worker
 * Estrategia:
 *  - Precache del App Shell (interfaz) para soporte offline.
 *  - Network-first para navegaciones: online = fresco; offline = shell cacheado.
 *  - API (api.cotizave.com): network-first con revalidación; el último
 *    buen JSON queda en cache para mostrar datos cuando no hay red.
 *  - Cache-first para iconos/manifest (assets estáticos).
 *  - Limpieza de caches antiguos al activar.
 * ============================================================ */

const VERSION = 'v1.3.2'; // splash de bienvenida 'despegue de cohete' (motor Motion precacheado)
const SHELL_CACHE = `tasasve-shell-${VERSION}`;
const DATA_CACHE = `tasasve-data-${VERSION}`;
const ASSET_CACHE = `tasasve-assets-${VERSION}`;

const SHELL_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icons/favicon.svg',
  './icons/icon.svg',
  './icons/icon-maskable.svg',
  // Motor Motion (anima el splash): precacheado para que la animación
  // de bienvenida también funcione en modo offline.
  'https://cdn.jsdelivr.net/npm/motion@11.13.5/dist/motion.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      // Cachear el shell asset por asset; si uno falla (p. ej. icono aún no generado),
      // no se aborta la instalación del SW: el resto queda disponible offline.
      const cache = await caches.open(SHELL_CACHE);
      await Promise.allSettled(
        SHELL_ASSETS.map((url) =>
          cache.add(new Request(url, { cache: 'reload' }))
        )
      );
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keep = [SHELL_CACHE, DATA_CACHE, ASSET_CACHE];
      const names = await caches.keys();
      await Promise.all(names.map((n) => (keep.includes(n) ? null : caches.delete(n))));
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // 1) Navegaciones: network-first con fallback al shell offline.
  if (req.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(req);
          const cache = await caches.open(SHELL_CACHE);
          cache.put('./index.html', fresh.clone());
          return fresh;
        } catch (err) {
          const cache = await caches.open(SHELL_CACHE);
          return (
            (await cache.match('./index.html')) ||
            (await cache.match('./')) ||
            new Response('<h1>Sin conexión</h1>', {
              headers: { 'Content-Type': 'text/html; charset=utf-8' },
              status: 503,
            })
          );
        }
      })()
    );
    return;
  }

  // 2) API de tasas: network-first, guardar el último buen JSON.
  if (url.origin === 'https://api.cotizave.com') {
    event.respondWith(
      (async () => {
        const cache = await caches.open(DATA_CACHE);
        try {
          const fresh = await fetch(req);
          if (fresh && fresh.ok) cache.put(req, fresh.clone());
          return fresh;
        } catch (err) {
          const cached = await cache.match(req);
          return (
            cached ||
            new Response(
              JSON.stringify({ offline: true, message: 'Sin conexión' }),
              { status: 503, headers: { 'Content-Type': 'application/json' } }
            )
          );
        }
      })()
    );
    return;
  }

  // 3) Proxy local de tasas (/api/rates): network-first con último JSON en caché.
  if (url.origin === self.location.origin && url.pathname.endsWith('/api/rates')) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(DATA_CACHE);
        try {
          const fresh = await fetch(req);
          if (fresh && fresh.ok) cache.put(req, fresh.clone());
          return fresh;
        } catch (err) {
          const cached = await cache.match(req);
          return cached || new Response(JSON.stringify({ offline: true }), {
            status: 503,
            headers: { 'Content-Type': 'application/json' },
          });
        }
      })()
    );
    return;
  }

  // 4) Mismo origen (estáticos): cache-first.
  if (url.origin === self.location.origin) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(ASSET_CACHE);
        const cached = (await cache.match(req)) || (await caches.match(req));
        if (cached) return cached;
        try {
          const fresh = await fetch(req);
          if (fresh && fresh.ok) cache.put(req, fresh.clone());
          return fresh;
        } catch (err) {
          return new Response('', { status: 504 });
        }
      })()
    );
  }
});

// Permitir que la página fuerce la activación del SW nuevo (botón "Actualizar" del banner).
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});
