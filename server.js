const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const {
    PORT,
    ALLOWED_ORIGIN,
    APP_VERSION,
    setIO,
    getDB,
    initCloudDB,
    activeUsers,
    soundboardCooldown,
    getClientIp,
    computeDynamicLoadSnapshot,
    broadcastUserPresenceAcrossServers
} = require("./src/db");

const { registerAuthHandlers } = require("./src/auth");
const { registerServerHandlers } = require("./src/servers");
const { registerToolsHandlers } = require("./src/tools");
const {
    registerVoiceHandlers,
    startAfkWatcher,
    cleanupVoiceOnDisconnect
} = require("./src/voice");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
    maxHttpBufferSize: 2.5e6,
    cors: ALLOWED_ORIGIN ? { origin: ALLOWED_ORIGIN, methods: ["GET", "POST"] } : undefined
});

setIO(io);

app.set("trust proxy", 1);

// HTTP Güvenlik Başlıkları
app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Permissions-Policy", "geolocation=(), payment=(), usb=()");
    next();
});

app.use(express.static(path.join(__dirname, "public")));

app.get("/icon.svg", (_req, res) => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#5865f2"/>
      <stop offset="100%" stop-color="#3b45c7"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" rx="112" fill="#111214"/>
  <rect x="44" y="44" width="424" height="424" rx="88" fill="url(#g)"/>
  <path fill="#ffffff" d="M168 188c0-22 18-40 40-40h96c22 0 40 18 40 40v84c0 22-18 40-40 40h-44l-46 42c-6 5-16 1-16-7v-35h-8c-22 0-40-18-40-40v-84zm58 26a18 18 0 1 0 0 36 18 18 0 0 0 0-36zm64 0a18 18 0 1 0 0 36 18 18 0 0 0 0-36z"/>
</svg>`;
    res.setHeader("Content-Type", "image/svg+xml");
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.status(200).send(svg);
});

// Dışarıya yalnızca uyanış/sağlık sinyali döner (iç metrik sızdırmaz)
app.options("/health", (_req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.sendStatus(204);
});

app.get("/health", (_req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.status(200).json({ ok: true, version: APP_VERSION });
});

// IP Başına Eşzamanlı Bağlantı Limiti
const ipConnCount = new Map();

io.use((socket, next) => {
    const ip = getClientIp(socket);
    const cur = ipConnCount.get(ip) || 0;
    if (cur >= 12) return next(new Error("Çok fazla eşzamanlı bağlantı."));
    ipConnCount.set(ip, cur + 1);
    socket.on("disconnect", () => {
        const nextCount = (ipConnCount.get(ip) || 1) - 1;
        if (nextCount <= 0) ipConnCount.delete(ip);
        else ipConnCount.set(ip, nextCount);
    });
    next();
});

// Otomatik Ses Kanalı AFK İzleyici
startAfkWatcher(io);

// Socket.IO Bağlantı Orkestrasyonu
io.on("connection", (socket) => {
    const db = getDB();
    const defSrv = db.servers[db.globalSettings.defaultServerId] || Object.values(db.servers)[0];

    socket.emit("server-info", {
        version: APP_VERSION,
        serverName: defSrv?.name || "BizimDiscord",
        hasInviteCode: Boolean(db.globalSettings.requireInviteToRegister),
        isFirstSetup: Object.keys(db.users).length === 0
    });

    socket.on("ping-check", (cb) => {
        if (typeof cb === "function") cb();
    });

    socket.on("health-info", (cb) => {
        if (!activeUsers.get(socket.id)) return cb?.({ ok: false });
        if (typeof cb === "function") cb(computeDynamicLoadSnapshot());
    });

    registerAuthHandlers(io, socket);
    registerServerHandlers(io, socket);
    registerToolsHandlers(io, socket);
    registerVoiceHandlers(io, socket);

    socket.on("disconnect", () => {
        const user = activeUsers.get(socket.id);
        soundboardCooldown.delete(socket.id);
        if (!user) return;

        const uname = user.username;
        cleanupVoiceOnDisconnect(io, socket, user);
        activeUsers.delete(socket.id);
        broadcastUserPresenceAcrossServers(uname);
    });
});

// Bulut Gist yedeğini (tanımlıysa) istemci kabul etmeden önce yükle
async function bootstrap() {
    await initCloudDB();
    server.listen(PORT, () => {
        console.log(`BizimDiscord v${APP_VERSION} hazır: http://localhost:${PORT}`);
    });
}

bootstrap();