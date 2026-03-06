const CACHE_NAME = 'munbyn-scanner-v0.1';
const ASSETS = [
    './',
    './index.html',
    './style.css',
    './app.js',
    './manifest.json'
];

// Install Event: Caches all essential files
self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => cache.addAll(ASSETS))
            .then(() => self.skipWaiting())
    );
});

// Activate Event: Cleans up old caches if the version changes
self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(cacheNames => {
            return Promise.all(
                cacheNames.filter(name => name !== CACHE_NAME)
                    .map(name => caches.delete(name))
            );
        })
    );
});

// Fetch Event: Serves files from cache first, falls back to network
self.addEventListener('fetch', event => {
    // Only handle GET requests
    if (event.request.method !== 'GET') return;

    event.respondWith(
        caches.match(event.request)
            .then(response => {
                // Return cached version if found
                if (response) {
                    return response;
                }

                // Otherwise try the network
                return fetch(event.request).then(networkResponse => {
                    // Optional: You can cache new requests here dynamically if needed
                    return networkResponse;
                }).catch(error => {
                    console.error('Fetch failed; returning offline page instead.', error);
                });
            })
    );
});
