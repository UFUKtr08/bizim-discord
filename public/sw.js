const CACHE_NAME = "bizim-discord-v5-shell";
const SHELL_ASSETS = [
    "/",
    "/style.css",
    "/app.js",
    "/manifest.json",
    "/icon.svg"
];

self.addEventListener("install", (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => cache.addAll(SHELL_ASSETS))
            .catch(() => { })
            .then(() => self.skipWaiting())
    );
});

self.addEventListener("activate", (event) => {
    event.waitUntil(
        caches.keys()
            .then((keys) =>
                Promise.all(
                    keys
                        .filter((key) => key !== CACHE_NAME)
                        .map((key) => caches.delete(key))
                )
            )
            .then(() => self.clients.claim())
    );
});

self.addEventListener("fetch", (event) => {
    const req = event.request;
    if (req.method !== "GET") return;

    const url = new URL(req.url);

    // Canlı Socket.IO, health-check ve dış bağlantıları asla önbelleğe alma
    if (
        url.origin !== self.location.origin ||
        url.pathname.startsWith("/socket.io") ||
        url.pathname.startsWith("/health")
    ) {
        return;
    }
    // Network-First: Render güncellemeleri anında yansır, bağlantı yoksa kabuk önbellekten açılır
    event.respondWith(
        fetch(req)
            .then((res) => {
                if (res && res.status === 200 && res.type === "basic") {
                    const copy = res.clone();
                    caches.open(CACHE_NAME).then((cache) => cache.put(req, copy)).catch(() => { });
                }
                return res;
            })
            .catch(() => caches.match(req))
    );
});