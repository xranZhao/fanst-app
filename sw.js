const CACHE_NAME = "fanst-v5";
const APP_SHELL = [
  "./",
  "./index.html",
  "./app.js",
  "./style.css",
  "./config.js",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE_NAME).then((c) => c.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  const url = new URL(e.request.url);
  if (url.hostname.includes("aliyuncs.com") || url.hostname.includes("deepseek.com")) return;
  e.respondWith(
    caches.match(e.request).then((res) => res || fetch(e.request))
  );
});
