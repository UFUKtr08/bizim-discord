const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

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
    checkRateLimit,
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

// =========================================================================
// GEÇİCİ DOSYA PAYLAŞIMI (GIST'İ ŞİŞİRMEDEN MAKS 10 MB / TOPLAM 80 MB KOTA)
// =========================================================================
const UPLOAD_DIR = path.join(__dirname, "uploads");
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const MAX_UPLOAD_TOTAL_BYTES = 80 * 1024 * 1024;
const uploadedFiles = new Map();

if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

function pruneUploadsIfNeeded() {
    let total = 0;
    for (const f of uploadedFiles.values()) total += f.size;
    if (total <= MAX_UPLOAD_TOTAL_BYTES) return;

    const sorted = Array.from(uploadedFiles.entries()).sort((a, b) => a[1].createdAt - b[1].createdAt);
    for (const [id, meta] of sorted) {
        if (total <= MAX_UPLOAD_TOTAL_BYTES * 0.75) break;
        fs.unlink(meta.path, () => { });
        uploadedFiles.delete(id);
        total -= meta.size;
    }
}

app.post(
    "/api/upload",
    express.raw({ type: "*/*", limit: "11mb" }),
    (req, res) => {
        const sid = String(req.headers["x-socket-id"] || "").trim();
        if (!sid || !activeUsers.has(sid)) {
            return res.status(401).json({ ok: false, error: "Dosya yüklemek için giriş yapmalısın." });
        }
        if (!checkRateLimit("upload:" + sid, 12, 60000)) {
            return res.status(429).json({ ok: false, error: "Çok sık dosya yükledin. Biraz bekle." });
        }
        if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
            return res.status(400).json({ ok: false, error: "Boş dosya gönderildi." });
        }
        if (req.body.length > MAX_UPLOAD_BYTES) {
            return res.status(413).json({ ok: false, error: "Dosya boyutu en fazla 10 MB olabilir." });
        }

        let rawName = String(req.headers["x-file-name"] || "dosya");
        try {
            rawName = decodeURIComponent(rawName);
        } catch { }
        const safeName = rawName.replace(/[\\/:*?"<>|\r\n]/g, "_").trim().slice(0, 100) || "dosya";
        const mime = String(req.headers["x-file-mime"] || "application/octet-stream").slice(0, 100);
        const id = crypto.randomBytes(12).toString("hex");
        const filePath = path.join(UPLOAD_DIR, id);

        fs.writeFile(filePath, req.body, (err) => {
            if (err) return res.status(500).json({ ok: false, error: "Dosya kaydedilemedi." });
            uploadedFiles.set(id, {
                path: filePath,
                name: safeName,
                mime,
                size: req.body.length,
                createdAt: Date.now()
            });
            pruneUploadsIfNeeded();
            res.json({
                ok: true,
                file: {
                    id,
                    name: safeName,
                    size: req.body.length,
                    mime,
                    url: `/api/files/${id}/${encodeURIComponent(safeName)}`
                }
            });
        });
    }
);

app.get("/api/files/:id/:name?", (req, res) => {
    const id = String(req.params.id || "").replace(/[^a-f0-9]/g, "");
    const meta = uploadedFiles.get(id);
    if (!meta || !fs.existsSync(meta.path)) {
        return res.status(404).send("Dosya bulunamadı veya sunucu yeniden başlatıldığı için süresi doldu.");
    }
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(meta.name)}`);
    res.sendFile(meta.path);
});

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
        hasInviteCode: Boolean(db.globalSettings.requireInviteToRegister)
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

async function bootstrap() {
    await initCloudDB();
    server.listen(PORT, () => {
        console.log(`BizimDiscord v${APP_VERSION} hazır: http://localhost:${PORT}`);
    });
}

bootstrap();