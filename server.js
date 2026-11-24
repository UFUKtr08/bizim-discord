const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    maxHttpBufferSize: 6e6
});

const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, "data.json");
const SERVER_STARTED_AT = Date.now();

const ENV_ADMIN_USER = (process.env.ADMIN_USER || "").trim().toLowerCase().replace(/[^a-z0-9._-]/g, "");
const ENV_ADMIN_PASS = (process.env.ADMIN_PASS || "").trim();

app.use(express.static(path.join(__dirname, "public")));

function getServerHealthSnapshot() {
    const mem = process.memoryUsage();
    let inVoice = 0;
    let camCount = 0;
    let screenCount = 0;
    for (const u of activeUsers.values()) {
        if (u.voiceChannel) inVoice++;
        if (u.camOn) camCount++;
        if (u.screenSharing) screenCount++;
    }
    return {
        ok: true,
        time: Date.now(),
        uptimeSec: Math.floor((Date.now() - SERVER_STARTED_AT) / 1000),
        memRssMB: Math.round(mem.rss / 1024 / 1024),
        memHeapMB: Math.round(mem.heapUsed / 1024 / 1024),
        onlineUsers: activeUsers.size,
        inVoice,
        camCount,
        screenCount,
        registeredUsers: Object.keys(db.users).length
    };
}

app.get("/health", (_req, res) => {
    res.status(200).json(getServerHealthSnapshot());
});

const DEFAULT_ICE = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun2.l.google.com:19302" }
];

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
    const hash = crypto.scryptSync(password, salt, 64).toString("hex");
    return { salt, hash };
}

function createDefaultDB() {
    const base = {
        users: {},
        sessions: {},
        channels: [
            { id: "genel", name: "genel-sohbet", type: "text", topic: "Herkese açık ana sohbet kanalı" },
            { id: "medya", name: "medya-ve-linkler", type: "text", topic: "Ekran görüntüleri, klipler ve linkler" },
            { id: "ses-1", name: "Ana Ses & Kamera", type: "voice", topic: "" },
            { id: "ses-2", name: "Oyun / Yayın Odası", type: "voice", topic: "" }
        ],
        messages: { genel: [], medya: [] },
        settings: {
            serverName: "BizimDiscord",
            inviteCode: (process.env.DEFAULT_INVITE_CODE || "").trim(),
            turnServer: { url: "", username: "", credential: "" }
        },
        meta: { seededOnly: true }
    };

    if (ENV_ADMIN_USER && ENV_ADMIN_PASS.length >= 4) {
        const { salt, hash } = hashPassword(ENV_ADMIN_PASS);
        base.users[ENV_ADMIN_USER] = {
            salt,
            hash,
            role: "admin",
            color: "#5865f2",
            status: "Çevrimiçi"
        };
    }
    return base;
}

function normalizeDB(raw) {
    const def = createDefaultDB();
    const normalized = {
        users: raw?.users && typeof raw.users === "object" ? raw.users : {},
        sessions: raw?.sessions && typeof raw.sessions === "object" ? raw.sessions : {},
        channels: Array.isArray(raw?.channels) && raw.channels.length ? raw.channels : def.channels,
        messages: raw?.messages && typeof raw.messages === "object" ? raw.messages : def.messages,
        settings: {
            serverName: raw?.settings?.serverName || def.settings.serverName,
            inviteCode: raw?.settings?.inviteCode ?? def.settings.inviteCode,
            turnServer: {
                url: raw?.settings?.turnServer?.url || "",
                username: raw?.settings?.turnServer?.username || "",
                credential: raw?.settings?.turnServer?.credential || ""
            }
        },
        meta: {
            seededOnly: Boolean(raw?.meta?.seededOnly)
        }
    };

    if (ENV_ADMIN_USER && ENV_ADMIN_PASS.length >= 4 && !normalized.users[ENV_ADMIN_USER]) {
        const { salt, hash } = hashPassword(ENV_ADMIN_PASS);
        normalized.users[ENV_ADMIN_USER] = {
            salt,
            hash,
            role: "admin",
            color: "#5865f2",
            status: "Çevrimiçi"
        };
    }
    return normalized;
}

function loadDB() {
    if (!fs.existsSync(DB_FILE)) {
        const initial = createDefaultDB();
        fs.writeFileSync(DB_FILE, JSON.stringify(initial, null, 2));
        return initial;
    }
    try {
        return normalizeDB(JSON.parse(fs.readFileSync(DB_FILE, "utf8")));
    } catch {
        return createDefaultDB();
    }
}

let db = loadDB();
const activeUsers = new Map();

function getPublicIceServers() {
    const list = [...DEFAULT_ICE];
    const t = db.settings.turnServer;
    if (t && t.url && t.url.trim()) {
        const entry = { urls: t.url.trim() };
        if (t.username) entry.username = t.username.trim();
        if (t.credential) entry.credential = t.credential.trim();
        list.push(entry);
    }
    return list;
}

function getPublicSettings() {
    return {
        serverName: db.settings.serverName,
        hasInviteCode: Boolean(db.settings.inviteCode),
        iceServers: getPublicIceServers()
    };
}

function saveAndSyncDB() {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
    for (const [sid, u] of activeUsers.entries()) {
        if (u.role === "admin") {
            io.to(sid).emit("db-sync", db);
        }
    }
}

function broadcastState() {
    const list = Array.from(activeUsers.entries()).map(([id, u]) => ({
        id,
        username: u.username,
        role: u.role,
        color: u.color,
        status: u.status,
        voiceChannel: u.voiceChannel,
        serverMuted: u.serverMuted,
        selfMuted: u.selfMuted,
        deafened: u.deafened,
        camOn: u.camOn,
        camStreamId: u.camStreamId,
        screenSharing: u.screenSharing,
        screenStreamId: u.screenStreamId
    }));
    io.emit("state-update", {
        users: list,
        channels: db.channels,
        settings: getPublicSettings()
    });
}

function isAdmin(socket) {
    return activeUsers.get(socket.id)?.role === "admin";
}

function completeUserSession(socket, clean, record, tokenToReturn) {
    for (const [oldId, u] of activeUsers.entries()) {
        if (u.username === clean && oldId !== socket.id) {
            io.to(oldId).emit("kicked", "Hesabınıza başka bir cihazdan giriş yapıldı.");
            io.sockets.sockets.get(oldId)?.disconnect(true);
            activeUsers.delete(oldId);
        }
    }

    activeUsers.set(socket.id, {
        username: clean,
        role: record.role,
        color: record.color || "#5865f2",
        status: record.status || "Çevrimiçi",
        voiceChannel: null,
        serverMuted: false,
        selfMuted: false,
        deafened: false,
        camOn: false,
        camStreamId: null,
        screenSharing: false,
        screenStreamId: null
    });

    if (record.role === "admin") {
        socket.emit("db-sync", db);
    }
    broadcastState();

    return {
        ok: true,
        token: tokenToReturn || null,
        me: {
            id: socket.id,
            username: clean,
            role: record.role,
            color: record.color || "#5865f2",
            status: record.status || "Çevrimiçi"
        },
        channels: db.channels,
        messages: db.messages,
        settings: getPublicSettings(),
        adminSettings: record.role === "admin" ? db.settings : null
    };
}

io.on("connection", (socket) => {
    socket.emit("server-info", {
        serverName: db.settings.serverName,
        hasInviteCode: Boolean(db.settings.inviteCode),
        isFirstSetup: Object.keys(db.users).length === 0
    });

    socket.on("ping-check", (cb) => {
        if (typeof cb === "function") cb();
    });

    socket.on("health-info", (cb) => {
        if (typeof cb === "function") cb(getServerHealthSnapshot());
    });

    socket.on("check-db-needs-restore", (cb) => {
        const needs = Object.keys(db.users).length === 0 || Boolean(db.meta?.seededOnly);
        if (typeof cb === "function") cb(needs);
    });

    socket.on("restore-db", (incomingDB, cb) => {
        if (!incomingDB || typeof incomingDB !== "object" || !incomingDB.users) {
            return cb?.({ ok: false, error: "Geçersiz veritabanı dosyası." });
        }
        const serverNeedsRestore = Object.keys(db.users).length === 0 || Boolean(db.meta?.seededOnly);
        const hasAdminInBackup = Object.values(incomingDB.users).some((u) => u?.role === "admin");
        if (!hasAdminInBackup) {
            return cb?.({ ok: false, error: "Yedek dosyasında admin hesabı bulunamadı." });
        }
        if (!serverNeedsRestore && !isAdmin(socket)) {
            return cb?.({ ok: false, error: "Dolu sunucuya geri yükleme için Admin yetkisi gerekli." });
        }

        db = normalizeDB(incomingDB);
        db.meta.seededOnly = false;
        fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
        io.emit("server-info", {
            serverName: db.settings.serverName,
            hasInviteCode: Boolean(db.settings.inviteCode),
            isFirstSetup: false
        });
        broadcastState();
        cb?.({ ok: true });
    });

    socket.on("register", ({ username, password, inviteCode }, cb) => {
        const clean = (username || "").trim().toLowerCase().replace(/[^a-z0-9._-]/g, "").slice(0, 20);
        if (!clean || clean.length < 2) {
            return cb({ ok: false, error: "Kullanıcı adı en az 2 karakter (harf/rakam) olmalı." });
        }
        if (!password || password.length < 4) {
            return cb({ ok: false, error: "Şifre en az 4 karakter olmalı." });
        }
        if (db.users[clean]) {
            return cb({ ok: false, error: "Bu kullanıcı adı zaten alınmış." });
        }
        const isFirstUser = Object.keys(db.users).length === 0;
        if (!isFirstUser && db.settings.inviteCode && (inviteCode || "").trim() !== db.settings.inviteCode) {
            return cb({ ok: false, error: "Sunucu davet kodu hatalı." });
        }

        const palette = ["#5865f2", "#23a559", "#f0b232", "#eb459e", "#00a8fc", "#ed4245"];
        const color = palette[Math.floor(Math.random() * palette.length)];
        const { salt, hash } = hashPassword(password);
        db.users[clean] = {
            salt,
            hash,
            role: isFirstUser ? "admin" : "user",
            color,
            status: "Çevrimiçi"
        };
        db.meta.seededOnly = false;
        saveAndSyncDB();
        cb({ ok: true, role: db.users[clean].role });
    });

    socket.on("login", ({ username, password, remember }, cb) => {
        const clean = (username || "").trim().toLowerCase();
        const record = db.users[clean];
        if (!record) return cb({ ok: false, error: "Kullanıcı bulunamadı." });

        const { hash } = hashPassword(password, record.salt);
        if (hash !== record.hash) return cb({ ok: false, error: "Şifre hatalı." });

        let token = null;
        if (remember) {
            token = crypto.randomBytes(24).toString("hex");
            db.sessions[token] = clean;
            saveAndSyncDB();
        }

        cb(completeUserSession(socket, clean, record, token));
    });

    socket.on("login-token", (token, cb) => {
        const clean = token && db.sessions[token];
        const record = clean && db.users[clean];
        if (!clean || !record) return cb({ ok: false });
        cb(completeUserSession(socket, clean, record, token));
    });

    socket.on("logout", (token) => {
        if (token && db.sessions[token]) {
            delete db.sessions[token];
            saveAndSyncDB();
        }
    });

    socket.on("update-profile", ({ color, status }) => {
        const user = activeUsers.get(socket.id);
        if (!user || !db.users[user.username]) return;
        if (typeof color === "string" && /^#[0-9a-fA-F]{6}$/.test(color)) {
            user.color = color;
            db.users[user.username].color = color;
        }
        if (typeof status === "string") {
            const cleanStatus = status.trim().slice(0, 40) || "Çevrimiçi";
            user.status = cleanStatus;
            db.users[user.username].status = cleanStatus;
        }
        db.meta.seededOnly = false;
        saveAndSyncDB();
        broadcastState();
    });

    socket.on("chat-message", ({ channelId, text, image, replyTo }) => {
        const user = activeUsers.get(socket.id);
        if (!user || (!text?.trim() && !image)) return;

        let safeReply = null;
        if (replyTo && replyTo.sender && (replyTo.text || replyTo.hasImage)) {
            safeReply = {
                id: String(replyTo.id || ""),
                sender: String(replyTo.sender).slice(0, 20),
                text: String(replyTo.text || "[Resim]").slice(0, 120)
            };
        }

        const msg = {
            id: "m-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6),
            channelId,
            sender: user.username,
            role: user.role,
            color: user.color,
            text: (text || "").trim().slice(0, 2000),
            image: typeof image === "string" && image.startsWith("data:image/") ? image : null,
            replyTo: safeReply,
            reactions: {},
            pinned: false,
            time: new Date().toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" })
        };

        if (!db.messages[channelId]) db.messages[channelId] = [];
        db.messages[channelId].push(msg);
        if (db.messages[channelId].length > 200) {
            const idx = db.messages[channelId].findIndex((m) => !m.pinned);
            if (idx !== -1) db.messages[channelId].splice(idx, 1);
        }
        db.meta.seededOnly = false;
        saveAndSyncDB();
        io.emit("chat-message", msg);
    });

    socket.on("toggle-reaction", ({ channelId, msgId, emoji }) => {
        const user = activeUsers.get(socket.id);
        const allowed = ["👍", "😂", "🔥", "❤️", "👀", "🎯"];
        if (!user || !allowed.includes(emoji)) return;
        const msg = db.messages[channelId]?.find((m) => m.id === msgId);
        if (!msg) return;

        if (!msg.reactions) msg.reactions = {};
        if (!msg.reactions[emoji]) msg.reactions[emoji] = [];
        const idx = msg.reactions[emoji].indexOf(user.username);
        if (idx === -1) msg.reactions[emoji].push(user.username);
        else msg.reactions[emoji].splice(idx, 1);
        if (msg.reactions[emoji].length === 0) delete msg.reactions[emoji];

        saveAndSyncDB();
        io.emit("message-updated", msg);
    });

    socket.on("toggle-pin", ({ channelId, msgId }) => {
        if (!isAdmin(socket)) return;
        const msg = db.messages[channelId]?.find((m) => m.id === msgId);
        if (!msg) return;
        msg.pinned = !msg.pinned;
        saveAndSyncDB();
        io.emit("message-updated", msg);
    });

    socket.on("delete-message", ({ channelId, msgId }) => {
        const user = activeUsers.get(socket.id);
        if (!user || !db.messages[channelId]) return;
        const target = db.messages[channelId].find((m) => m.id === msgId);
        if (!target) return;
        if (user.role !== "admin" && target.sender !== user.username) return;

        db.messages[channelId] = db.messages[channelId].filter((m) => m.id !== msgId);
        saveAndSyncDB();
        io.emit("message-deleted", { channelId, msgId });
    });

    socket.on("typing", ({ channelId, isTyping }) => {
        const user = activeUsers.get(socket.id);
        if (!user) return;
        socket.broadcast.emit("user-typing", { channelId, username: user.username, isTyping });
    });

    // --- SES & KAMERA KANALLARI ---
    socket.on("join-voice", (channelId, cb) => {
        const user = activeUsers.get(socket.id);
        if (!user) return;

        if (user.voiceChannel) {
            socket.broadcast.emit("user-left-voice", socket.id);
        }

        const peersInChannel = [];
        for (const [id, u] of activeUsers.entries()) {
            if (id !== socket.id && u.voiceChannel === channelId) {
                peersInChannel.push(id);
            }
        }

        user.voiceChannel = channelId;
        user.camOn = false;
        user.camStreamId = null;
        user.screenSharing = false;
        user.screenStreamId = null;
        broadcastState();
        socket.broadcast.emit("voice-event", { type: "join", username: user.username, channelId });
        cb(peersInChannel);
    });

    socket.on("leave-voice", () => {
        const user = activeUsers.get(socket.id);
        if (!user || !user.voiceChannel) return;
        const oldCh = user.voiceChannel;
        user.voiceChannel = null;
        user.camOn = false;
        user.camStreamId = null;
        user.screenSharing = false;
        user.screenStreamId = null;
        socket.broadcast.emit("user-left-voice", socket.id);
        socket.broadcast.emit("voice-event", { type: "leave", username: user.username, channelId: oldCh });
        broadcastState();
    });

    socket.on("voice-status-update", (payload) => {
        const user = activeUsers.get(socket.id);
        if (!user || !payload) return;
        if (typeof payload.selfMuted === "boolean") user.selfMuted = payload.selfMuted;
        if (typeof payload.deafened === "boolean") user.deafened = payload.deafened;
        if (typeof payload.camOn === "boolean") user.camOn = payload.camOn;
        if (payload.camStreamId !== undefined) user.camStreamId = payload.camStreamId || null;
        if (typeof payload.screenSharing === "boolean") user.screenSharing = payload.screenSharing;
        if (payload.screenStreamId !== undefined) user.screenStreamId = payload.screenStreamId || null;
        broadcastState();
    });

    // --- WEBRTC SİNYALLEŞME ---
    socket.on("webrtc-offer", ({ to, offer }) => {
        io.to(to).emit("webrtc-offer", { from: socket.id, offer });
    });
    socket.on("webrtc-answer", ({ to, answer }) => {
        io.to(to).emit("webrtc-answer", { from: socket.id, answer });
    });
    socket.on("webrtc-ice", ({ to, candidate }) => {
        io.to(to).emit("webrtc-ice", { from: socket.id, candidate });
    });
    socket.on("screen-share-stopped", () => {
        const user = activeUsers.get(socket.id);
        if (user) { user.screenSharing = false; user.screenStreamId = null; }
        socket.broadcast.emit("screen-share-stopped", socket.id);
        broadcastState();
    });
    socket.on("cam-stopped", () => {
        const user = activeUsers.get(socket.id);
        if (user) { user.camOn = false; user.camStreamId = null; }
        socket.broadcast.emit("cam-stopped", socket.id);
        broadcastState();
    });

    // --- ADMİN YETKİLERİ ---
    socket.on("admin-kick", (targetId) => {
        if (!isAdmin(socket) || targetId === socket.id) return;
        io.to(targetId).emit("kicked", "Admin tarafından odadan atıldınız.");
        io.sockets.sockets.get(targetId)?.disconnect(true);
    });

    socket.on("admin-toggle-mute", (targetId) => {
        if (!isAdmin(socket)) return;
        const target = activeUsers.get(targetId);
        if (!target) return;
        target.serverMuted = !target.serverMuted;
        io.to(targetId).emit("server-mute-status", target.serverMuted);
        broadcastState();
    });

    socket.on("admin-toggle-role", (targetId) => {
        if (!isAdmin(socket) || targetId === socket.id) return;
        const target = activeUsers.get(targetId);
        if (!target || !db.users[target.username]) return;
        const newRole = target.role === "admin" ? "user" : "admin";
        target.role = newRole;
        db.users[target.username].role = newRole;
        db.meta.seededOnly = false;
        saveAndSyncDB();
        io.to(targetId).emit("role-updated", { role: newRole, adminSettings: newRole === "admin" ? db.settings : null });
        broadcastState();
    });

    socket.on("admin-create-channel", ({ name, type, topic }) => {
        if (!isAdmin(socket) || !name?.trim()) return;
        const id = "ch-" + Date.now();
        db.channels.push({
            id,
            name: name.trim().slice(0, 24),
            type: type === "voice" ? "voice" : "text",
            topic: (topic || "").trim().slice(0, 80)
        });
        if (type !== "voice") db.messages[id] = [];
        db.meta.seededOnly = false;
        saveAndSyncDB();
        broadcastState();
    });

    socket.on("admin-delete-channel", (channelId) => {
        if (!isAdmin(socket) || db.channels.length <= 1) return;
        db.channels = db.channels.filter((c) => c.id !== channelId);
        delete db.messages[channelId];
        for (const [sid, u] of activeUsers.entries()) {
            if (u.voiceChannel === channelId) {
                u.voiceChannel = null;
                u.camOn = false;
                u.camStreamId = null;
                u.screenSharing = false;
                u.screenStreamId = null;
                io.to(sid).emit("force-leave-voice");
                io.emit("user-left-voice", sid);
            }
        }
        db.meta.seededOnly = false;
        saveAndSyncDB();
        broadcastState();
    });

    socket.on("admin-update-settings", ({ serverName, inviteCode, turnUrl, turnUser, turnPass }, cb) => {
        if (!isAdmin(socket)) return;
        if (typeof serverName === "string" && serverName.trim()) {
            db.settings.serverName = serverName.trim().slice(0, 30);
        }
        if (typeof inviteCode === "string") {
            db.settings.inviteCode = inviteCode.trim().slice(0, 30);
        }
        db.settings.turnServer = {
            url: (turnUrl || "").trim().slice(0, 120),
            username: (turnUser || "").trim().slice(0, 80),
            credential: (turnPass || "").trim().slice(0, 120)
        };
        db.meta.seededOnly = false;
        saveAndSyncDB();
        broadcastState();
        cb?.({ ok: true });
    });

    socket.on("disconnect", () => {
        const user = activeUsers.get(socket.id);
        if (!user) return;
        const oldCh = user.voiceChannel;
        activeUsers.delete(socket.id);
        if (oldCh) {
            socket.broadcast.emit("user-left-voice", socket.id);
            socket.broadcast.emit("voice-event", { type: "leave", username: user.username, channelId: oldCh });
        }
        broadcastState();
    });
});

server.listen(PORT, () => {
    console.log(`Sunucu hazır: http://localhost:${PORT}`);
});