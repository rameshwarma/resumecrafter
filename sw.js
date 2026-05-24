// ResumeCraft Pro v8 — Service Worker
// Caching strategy: Cache-first for static assets, Network-first for API calls

const CACHE_NAME    = 'rcp-v8-static-v1';
const DATA_CACHE    = 'rcp-v8-data-v1';
const APP_VERSION   = '8.0.0';

// Assets to cache on install (app shell)
const STATIC_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  'https://d3js.org/d3.v7.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js',
  'https://fonts.googleapis.com/css2?family=DM+Sans:opsz,wght@9..40,300;9..40,400;9..40,500;9..40,600;9..40,700&family=Cormorant+Garamond:wght@400;500;600;700&family=Merriweather:wght@300;400;700&family=Lato:wght@300;400;700&family=Raleway:wght@300;400;500;600;700&family=Playfair+Display:wght@400;600;700&display=swap'
];

// API patterns that should always go to network
const NETWORK_ONLY = [
  'api.anthropic.com',
  'generativelanguage.googleapis.com',
  'api.groq.com',
  'text.pollinations.ai',
  'api.apify.com',
  'gmail.googleapis.com',
  'accounts.google.com'
];

// ═══════════════════════════════════════════════════════
// INSTALL — cache static assets
// ═══════════════════════════════════════════════════════
self.addEventListener('install', event => {
  console.log(`[SW] Installing ResumeCraft Pro v${APP_VERSION}`);
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        // Cache what we can, ignore failures for individual assets
        return Promise.allSettled(
          STATIC_ASSETS.map(url =>
            cache.add(url).catch(e => console.warn(`[SW] Failed to cache: ${url}`, e.message))
          )
        );
      })
      .then(() => {
        console.log('[SW] Static assets cached');
        return self.skipWaiting();
      })
  );
});

// ═══════════════════════════════════════════════════════
// ACTIVATE — clean old caches
// ═══════════════════════════════════════════════════════
self.addEventListener('activate', event => {
  console.log('[SW] Activating new service worker');
  event.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(
        keys
          .filter(key => key !== CACHE_NAME && key !== DATA_CACHE)
          .map(key => {
            console.log('[SW] Deleting old cache:', key);
            return caches.delete(key);
          })
      );
    }).then(() => self.clients.claim())
  );
});

// ═══════════════════════════════════════════════════════
// FETCH — routing strategy
// ═══════════════════════════════════════════════════════
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // 1. Network-only for all AI/API calls
  if (NETWORK_ONLY.some(domain => url.hostname.includes(domain))) {
    event.respondWith(networkOnly(event.request));
    return;
  }

  // 2. Cache-first for Google Fonts CSS/files
  if (url.hostname.includes('fonts.googleapis.com') || url.hostname.includes('fonts.gstatic.com')) {
    event.respondWith(cacheFirst(event.request, CACHE_NAME));
    return;
  }

  // 3. Cache-first for CDN libraries (d3, jspdf, etc.)
  if (url.hostname.includes('cdnjs.cloudflare.com') || url.hostname.includes('d3js.org') ||
      url.hostname.includes('unpkg.com')) {
    event.respondWith(cacheFirst(event.request, CACHE_NAME));
    return;
  }

  // 4. Cache-first with network fallback for the app itself
  if (url.pathname.startsWith('/resumecrafter/') || url.pathname === '/') {
    event.respondWith(cacheFirst(event.request, CACHE_NAME));
    return;
  }

  // 5. Default: network with cache fallback
  event.respondWith(networkFirst(event.request));
});

// ═══════════════════════════════════════════════════════
// CACHE STRATEGIES
// ═══════════════════════════════════════════════════════

async function cacheFirst(request, cacheName) {
  try {
    const cache = await caches.open(cacheName);
    const cached = await cache.match(request);
    if (cached) return cached;
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch(e) {
    const cache = await caches.open(cacheName);
    const cached = await cache.match(request);
    if (cached) return cached;
    return offlineFallback(request);
  }
}

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(DATA_CACHE);
      cache.put(request, response.clone());
    }
    return response;
  } catch(e) {
    const cache = await caches.open(DATA_CACHE);
    const cached = await cache.match(request);
    return cached || offlineFallback(request);
  }
}

async function networkOnly(request) {
  try {
    return await fetch(request);
  } catch(e) {
    return new Response(
      JSON.stringify({ error: 'offline', message: 'No internet connection. AI features require connectivity.' }),
      { status: 503, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

function offlineFallback(request) {
  if (request.destination === 'document') {
    return caches.match('./index.html');
  }
  return new Response('Offline — content not available', { status: 503 });
}

// ═══════════════════════════════════════════════════════
// BACKGROUND SYNC — send queued emails when back online
// ═══════════════════════════════════════════════════════
self.addEventListener('sync', event => {
  if (event.tag === 'send-queued-emails') {
    console.log('[SW] Processing queued email sends');
    event.waitUntil(processEmailQueue());
  }
});

async function processEmailQueue() {
  // Notify all open clients to process their email queue
  const clients = await self.clients.matchAll({ type: 'window' });
  clients.forEach(client => {
    client.postMessage({ type: 'PROCESS_EMAIL_QUEUE' });
  });
}

// ═══════════════════════════════════════════════════════
// MESSAGE HANDLER — communicate with main app
// ═══════════════════════════════════════════════════════
self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  if (event.data?.type === 'GET_VERSION') {
    event.ports[0].postMessage({ version: APP_VERSION, cache: CACHE_NAME });
  }
});
