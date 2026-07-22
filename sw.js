"use strict";

/* Cache-first app shell so iSurvey works with zero connectivity once
   installed. Bump CACHE_NAME on every deploy to invalidate old caches. */
const CACHE_NAME = "isurvey-v36";

const SHELL_ASSETS = [
  "./",
  "index.html",
  "styles.css?v=36",
  "app.js?v=36",
  "manifest.json",
  "species/index.json",
  "species/infoflora-ch.json",
  "species/frequency-ch.json",
  "species/typoch-ch.json",
  "vendor/leaflet.js",
  "vendor/leaflet.css",
  "icons/icon.svg",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/icon-maskable-512.png",
  "icons/apple-touch-icon.png",
  "icons/favicon-32.png",
];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  const req = event.request;
  if (req.method !== "GET") return;

  // Network-first for navigations so a fresh deploy is picked up while
  // online; falls back to the cached shell when offline.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req).then(res => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then(cache => cache.put("index.html", copy));
        return res;
      }).catch(() => caches.match("index.html"))
    );
    return;
  }

  // Cache-first for everything else (app shell, species data, icons).
  event.respondWith(
    caches.match(req).then(cached => {
      if (cached) return cached;
      return fetch(req).then(res => {
        if (res.ok && new URL(req.url).origin === location.origin) {
          const copy = res.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(req, copy));
        }
        return res;
      });
    })
  );
});
