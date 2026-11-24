const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, "data.json");

app.use(express.static(path.join(__dirname, "public")));

// --- KALICI VERİTABANI (JSON) ---
function loadDB() {
    if (!fs.existsSync(DB_FILE)) {
        const initial = {
            users: {}, // username -> { hash, salt, role: "admin"|"user" }
            channels: [
                { id: "genel", name: "genel-sohbet", type: "text" },
                { id: "ses-1", name: "Ana Ses Odası", type: "voice" }
            ],
            messages: { genel: [] },
            settings: { voiceTimeLimitMin: 60 } // 0 = sınırsız
        };
        fs.writeFileSync(DB_FILE, JSON.stringify(initial, null, 2));
        return initial;
    }
    return JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
}

function saveDB() {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
    const hash = crypto.scryptSync(password, salt, 64).toString("hex");
    return { salt, hash };
}

const db = loadDB();
const activeUsers = new Map(); // socket.id -> { username, role, voiceChannel, serverMuted }
const voiceTimers = new Map(); // channelId -> { endsAt, interval }

function broadcastState() {
    const list = Array.from(activeUsers.entries()).map(([id, u]) => ({
        id,
        username: u.username,
        role: u.role,
        voiceChannel: u.voiceChannel,
        serverMuted: u.serverMuted
    }));
    io.emit("state-update", {
        users: list,
        channels: db.channels,
        settings: db.settings
    });
}

// --- GOOGLE MEET TARZI YAYIN SÜRESİ SAYACI ---
function checkStartVoiceTimer(channelId) {
    const limitMin = db.settings.voiceTimeLimitMin;
    if (!limitMin || limitMin <= 0 || voiceTimers.has(channelId)) return;

    const endsAt = Date.now() + limitMin * 60 * 1000;
    const interval = setInterval(() => {
        const remainingSec = Math.max(0, Math.floor((endsAt - Date.now()) / 1000));
        io.emit("voice-timer", { channelId, remainingSec });

        if (remainingSec <= 0) {
            clearInterval(interval);
            voiceTimers.delete(channelId);
            // Süre doldu: kanaldaki herkesi çıkar
            for (const [sid, u] of activeUsers.entries()) {
                if (u.voiceChannel === channelId) {
                    u.voiceChannel = null;
                    io.to(sid).emit("force-leave-voice", "Yayın süresi doldu.");
                    io.emit("user-left-voice", sid);
                }
            }
            broadcastState();
        }
    }, 1000);

    voiceTimers.set(channelId, { endsAt, interval });
}

function checkStopVoiceTimer(channelId) {
    if (!channelId || !voiceTimers.has(channelId)) return;
    const stillInside = Array.from(activeUsers.values()).some((u) => u.voiceChannel === channelId);
    if (!stillInside) {
        clearInterval(voiceTimers.get(channelId).interval);
        voiceTimers.delete(channelId);
        io.emit("voice-timer", { channelId, remainingSec: null });
    }
}

function isAdmin(socket) {
    return activeUsers.get(socket.id)?.role === "admin";
}

io.on("connection", (socket) => {
    // 1. KAYIT OLMA
    socket.on("register", ({ username, password }, cb) => {
        const clean = (username || "").trim().toLowerCase().slice(0, 20);
        if (!clean || !password || password.length < 4) {
            return cb({ ok: false, error: "Kullanıcı adı ve en az 4 haneli şifre gerekli." });
        }
        if (db.users[clean]) {
            return cb({ ok: false, error: "Bu kullanıcı adı zaten alınmış." });
        }
        const isFirstUser = Object.keys(db.users).length === 0;
        const { salt, hash } = hashPassword(password);
        db.users[clean] = { salt, hash, role: isFirstUser ? "admin" : "user" };
        saveDB();
        cb({ ok: true, role: db.users[clean].role });
    });

    // 2. GİRİŞ YAPMA
    socket.on("login", ({ username, password }, cb) => {
        const clean = (username || "").trim().toLowerCase();
        const record = db.users[clean];
        if (!record) return cb({ ok: false, error: "Kullanıcı bulunamadı." });

        const { hash } = hashPassword(password, record.salt);
        if (hash !== record.hash) return cb({ ok: false, error: "Şifre hatalı." });

        activeUsers.set(socket.id, {
            username: clean,
            role: record.role,
            voiceChannel: null,
            serverMuted: false
        });

        cb({
            ok: true,
            me: { id: socket.id, username: clean, role: record.role },
            channels: db.channels,
            messages: db.messages,
            settings: db.settings
        });
        broadcastState();
    });

    // 3. METİN SOHBETİ
    socket.on("chat-message", ({ channelId, text }) => {
        const user = activeUsers.get(socket.id);
        if (!user || !text || !text.trim()) return;

        const msg = {
            channelId,
            sender: user.username,
            role: user.role,
            text: text.trim().slice(0, 1000),
            time: new Date().toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" })
        };

        if (!db.messages[channelId]) db.messages[channelId] = [];
        db.messages[channelId].push(msg);
        if (db.messages[channelId].length > 100) db.messages[channelId].shift();
        saveDB();

        io.emit("chat-message", msg);
    });

    // 4. SES KANALINA KATILMA / AYRILMA
    socket.on("join-voice", (channelId, cb) => {
        const user = activeUsers.get(socket.id);
        if (!user) return;

        const oldChannel = user.voiceChannel;
        if (oldChannel) {
            socket.broadcast.emit("user-left-voice", socket.id);
            user.voiceChannel = null;
            checkStopVoiceTimer(oldChannel);
        }

        const peersInChannel = [];
        for (const [id, u] of activeUsers.entries()) {
            if (id !== socket.id && u.voiceChannel === channelId) {
                peersInChannel.push(id);
            }
        }

        user.voiceChannel = channelId;
        checkStartVoiceTimer(channelId);
        broadcastState();
        cb(peersInChannel);
    });

    socket.on("leave-voice", () => {
        const user = activeUsers.get(socket.id);
        if (!user || !user.voiceChannel) return;
        const oldChannel = user.voiceChannel;
        user.voiceChannel = null;
        socket.broadcast.emit("user-left-voice", socket.id);
        checkStopVoiceTimer(oldChannel);
        broadcastState();
    });

    // 5. WEBRTC SİNYALLEŞME (SES + EKRAN PAYLAŞIMI)
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
        socket.broadcast.emit("screen-share-stopped", socket.id);
    });

    // 6. ADMİN YETKİLERİ
    socket.on("admin-kick", (targetId) => {
        if (!isAdmin(socket) || targetId === socket.id) return;
        io.to(targetId).emit("kicked", "Admin tarafından odadan atıldınız.");
        const targetSocket = io.sockets.sockets.get(targetId);
        if (targetSocket) targetSocket.disconnect(true);
    });

    socket.on("admin-toggle-mute", (targetId) => {
        if (!isAdmin(socket)) return;
        const target = activeUsers.get(targetId);
        if (!target) return;
        target.serverMuted = !target.serverMuted;
        io.to(targetId).emit("server-mute-status", target.serverMuted);
        broadcastState();
    });

    socket.on("admin-create-channel", ({ name, type }) => {
        if (!isAdmin(socket) || !name?.trim()) return;
        const id = "ch-" + Date.now();
        db.channels.push({ id, name: name.trim().slice(0, 24), type: type === "voice" ? "voice" : "text" });
        if (type === "text") db.messages[id] = [];
        saveDB();
        broadcastState();
    });

    socket.on("admin-delete-channel", (channelId) => {
        if (!isAdmin(socket) || db.channels.length <= 1) return;
        db.channels = db.channels.filter((c) => c.id !== channelId);
        delete db.messages[channelId];
        saveDB();
        broadcastState();
    });

    socket.on("admin-set-time-limit", (minutes) => {
        if (!isAdmin(socket)) return;
        db.settings.voiceTimeLimitMin = Math.max(0, parseInt(minutes, 10) || 0);
        saveDB();
        broadcastState();
    });

    // 7. BAĞLANTI KOPMASI
    socket.on("disconnect", () => {
        const user = activeUsers.get(socket.id);
        if (!user) return;
        const oldChannel = user.voiceChannel;
        activeUsers.delete(socket.id);
        if (oldChannel) {
            socket.broadcast.emit("user-left-voice", socket.id);
            checkStopVoiceTimer(oldChannel);
        }
        broadcastState();
    });
});

server.listen(PORT, () => {
    console.log(`Sunucu hazır: http://localhost:${PORT}`);
});