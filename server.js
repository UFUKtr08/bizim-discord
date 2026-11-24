const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    maxHttpBufferSize: 8e6
});

const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, "data.json");
const SERVER_STARTED_AT = Date.now();
const APP_VERSION = "5.0.0";

const ENV_ADMIN_USER = (process.env.ADMIN_USER || "").trim().toLowerCase().replace(/[^a-z0-9._-]/g, "");
const ENV_ADMIN_PASS = (process.env.ADMIN_PASS || "").trim();
const ENV_DEFAULT_INVITE = (process.env.DEFAULT_INVITE_CODE || "").trim().toUpperCase();

const DEFAULT_ICE = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun2.l.google.com:19302" }
];

const PERMISSION_KEYS = [
    "administrator",
    "manageChannels",
    "manageRoles",
    "kickMembers",
    "muteMembers",
    "pinMessages",
    "deleteMessages",
    "manageServer"
];

const ALLOWED_REACTIONS = ["👍", "😂", "🔥", "❤️", "👀", "🎯"];
const USER_PALETTE = ["#5865f2", "#23a559", "#f0b232", "#eb459e", "#00a8fc", "#ed4245", "#1abc9c", "#e67e22"];

app.use(express.static(path.join(__dirname, "public")));

// PWA ve tarayıcı sekmesi için hafif SVG uygulama ikonu
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

// =========================================================================
// YARDIMCI FONKSİYONLAR
// =========================================================================

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
    const hash = crypto.scryptSync(password, salt, 64).toString("hex");
    return { salt, hash };
}

function generateInviteCode(prefix = "BD") {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let code = "";
    const bytes = crypto.randomBytes(6);
    for (let i = 0; i < 6; i++) {
        code += chars[bytes[i] % chars.length];
    }
    return `${prefix}-${code}`;
}

function sanitizeColor(color, fallback = "#5865f2") {
    return typeof color === "string" && /^#[0-9a-fA-F]{6}$/.test(color) ? color : fallback;
}

function sanitizeAvatar(avatar) {
    if (typeof avatar !== "string") return "";
    if (!avatar.startsWith("data:image/")) return "";
    if (avatar.length > 220000) return "";
    return avatar;
}

function sanitizePermissions(raw = {}) {
    const out = {};
    for (const k of PERMISSION_KEYS) {
        out[k] = Boolean(raw && raw[k]);
    }
    return out;
}

function makeDefaultRoles() {
    return [
        {
            id: "role-admin",
            name: "Yönetici",
            color: "#f23f43",
            priority: 100,
            permissions: {
                administrator: true,
                manageChannels: true,
                manageRoles: true,
                kickMembers: true,
                muteMembers: true,
                pinMessages: true,
                deleteMessages: true,
                manageServer: true
            }
        },
        {
            id: "role-mod",
            name: "Moderatör",
            color: "#23a55a",
            priority: 50,
            permissions: {
                administrator: false,
                manageChannels: true,
                manageRoles: false,
                kickMembers: true,
                muteMembers: true,
                pinMessages: true,
                deleteMessages: true,
                manageServer: false
            }
        },
        {
            id: "role-member",
            name: "Üye",
            color: "#949ba4",
            priority: 10,
            permissions: {
                administrator: false,
                manageChannels: false,
                manageRoles: false,
                kickMembers: false,
                muteMembers: false,
                pinMessages: false,
                deleteMessages: false,
                manageServer: false
            }
        }
    ];
}

function createServerObject({ id, name, ownerId, inviteCode, turnServer, channels, messages }) {
    const srvId = id || ("srv-" + Date.now().toString(36) + "-" + crypto.randomBytes(2).toString("hex"));
    const defaultChannels = Array.isArray(channels) && channels.length
        ? channels.map((c) => ({
            id: String(c.id || ("ch-" + crypto.randomBytes(3).toString("hex"))),
            name: String(c.name || "kanal").slice(0, 28),
            type: c.type === "voice" ? "voice" : "text",
            topic: String(c.topic || "").slice(0, 100),
            isAfk: Boolean(c.isAfk)
        }))
        : [
            { id: "genel", name: "genel-sohbet", type: "text", topic: "Herkese açık ana sohbet kanalı", isAfk: false },
            { id: "medya", name: "medya-ve-linkler", type: "text", topic: "Ekran görüntüleri, klipler ve linkler", isAfk: false },
            { id: "ses-1", name: "Ana Ses & Kamera", type: "voice", topic: "", isAfk: false },
            { id: "ses-2", name: "Oyun / Yayın Odası", type: "voice", topic: "", isAfk: false },
            { id: "ses-afk", name: "AFK Odası", type: "voice", topic: "Uzun süre sessiz kalanlar", isAfk: true }
        ];

    const msgs = {};
    if (messages && typeof messages === "object") {
        for (const [cid, arr] of Object.entries(messages)) {
            if (Array.isArray(arr)) msgs[cid] = arr;
        }
    }
    for (const ch of defaultChannels) {
        if (ch.type === "text" && !Array.isArray(msgs[ch.id])) {
            msgs[ch.id] = [];
        }
    }

    const afkCh = defaultChannels.find((c) => c.type === "voice" && c.isAfk);

    return {
        id: srvId,
        name: String(name || "BizimDiscord").trim().slice(0, 32) || "BizimDiscord",
        icon: "",
        inviteCode: (inviteCode || generateInviteCode("BD")).trim().toUpperCase().slice(0, 24),
        ownerId: ownerId || null,
        createdAt: Date.now(),
        afkChannelId: afkCh ? afkCh.id : null,
        afkTimeoutSec: 300,
        turnServer: {
            url: String(turnServer?.url || "").trim().slice(0, 120),
            username: String(turnServer?.username || "").trim().slice(0, 80),
            credential: String(turnServer?.credential || "").trim().slice(0, 120)
        },
        roles: makeDefaultRoles(),
        members: {},
        channels: defaultChannels,
        messages: msgs,
        polls: []
    };
}

function dmKey(u1, u2) {
    return [u1, u2].sort().join("::");
}

function extractYouTubeId(rawUrl) {
    if (typeof rawUrl !== "string") return null;
    const trimmed = rawUrl.trim();
    if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) return trimmed;
    const patterns = [
        /(?:youtube\.com\/watch\?.*v=)([a-zA-Z0-9_-]{11})/,
        /(?:youtu\.be\/)([a-zA-Z0-9_-]{11})/,
        /(?:youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
        /(?:youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/,
        /(?:youtube\.com\/live\/)([a-zA-Z0-9_-]{11})/
    ];
    for (const rx of patterns) {
        const m = trimmed.match(rx);
        if (m && m[1]) return m[1];
    }
    return null;
}

// =========================================================================
// VERİTABANI OLUŞTURMA & v4.0 -> v5.0 OTOMATİK MİGRASYON
// =========================================================================

function createDefaultDB() {
    const mainServer = createServerObject({
        id: "srv-main",
        name: "BizimDiscord",
        ownerId: ENV_ADMIN_USER || null,
        inviteCode: ENV_DEFAULT_INVITE || generateInviteCode("BD")
    });

    const base = {
        version: 5,
        users: {},
        sessions: {},
        servers: {
            [mainServer.id]: mainServer
        },
        dms: {},
        globalSettings: {
            defaultServerId: mainServer.id,
            requireInviteToRegister: Boolean(ENV_DEFAULT_INVITE),
            registrationInviteCode: ENV_DEFAULT_INVITE
        },
        meta: {
            seededOnly: true,
            migratedFromV4: false
        }
    };

    if (ENV_ADMIN_USER && ENV_ADMIN_PASS.length >= 4) {
        const { salt, hash } = hashPassword(ENV_ADMIN_PASS);
        base.users[ENV_ADMIN_USER] = {
            salt,
            hash,
            role: "admin",
            isGlobalAdmin: true,
            displayName: ENV_ADMIN_USER,
            color: "#5865f2",
            status: "Çevrimiçi",
            avatar: ""
        };
        mainServer.ownerId = ENV_ADMIN_USER;
        mainServer.members[ENV_ADMIN_USER] = {
            roleIds: ["role-admin"],
            joinedAt: Date.now()
        };
    }

    return base;
}

function migrateV4ToV5(raw) {
    console.log("[Migration] v4.0 veritabanı algılandı, v5.0 çoklu sunucu formatına dönüştürülüyor...");

    const rawUsers = raw?.users && typeof raw.users === "object" ? raw.users : {};
    const rawSessions = raw?.sessions && typeof raw.sessions === "object" ? raw.sessions : {};

    const users = {};
    let primaryOwner = ENV_ADMIN_USER || null;

    for (const [uname, u] of Object.entries(rawUsers)) {
        if (!u || !u.salt || !u.hash) continue;
        const isOldAdmin = u.role === "admin";
        if (isOldAdmin && !primaryOwner) primaryOwner = uname;
        users[uname] = {
            salt: u.salt,
            hash: u.hash,
            role: isOldAdmin ? "admin" : "user",
            isGlobalAdmin: isOldAdmin,
            displayName: typeof u.displayName === "string" && u.displayName.trim() ? u.displayName.trim().slice(0, 28) : uname,
            color: sanitizeColor(u.color, "#5865f2"),
            status: typeof u.status === "string" && u.status.trim() ? u.status.trim().slice(0, 40) : "Çevrimiçi",
            avatar: sanitizeAvatar(u.avatar)
        };
    }

    if (!primaryOwner) {
        const firstUser = Object.keys(users)[0];
        if (firstUser) primaryOwner = firstUser;
    }

    const oldInvite = String(raw?.settings?.inviteCode || "").trim().toUpperCase();
    const mainServer = createServerObject({
        id: "srv-main",
        name: raw?.settings?.serverName || "BizimDiscord",
        ownerId: primaryOwner,
        inviteCode: oldInvite || ENV_DEFAULT_INVITE || generateInviteCode("BD"),
        turnServer: raw?.settings?.turnServer,
        channels: Array.isArray(raw?.channels) && raw.channels.length ? raw.channels : null,
        messages: raw?.messages && typeof raw.messages === "object" ? raw.messages : {}
    });

    // Eski v4.0 kullanıcılarının tamamını ana sunucuya veri kaybı olmadan üye yap
    for (const [uname, u] of Object.entries(users)) {
        mainServer.members[uname] = {
            roleIds: u.isGlobalAdmin ? ["role-admin"] : ["role-member"],
            joinedAt: Date.now()
        };
    }

    const migrated = {
        version: 5,
        users,
        sessions: { ...rawSessions },
        servers: {
            [mainServer.id]: mainServer
        },
        dms: {},
        globalSettings: {
            defaultServerId: mainServer.id,
            requireInviteToRegister: Boolean(oldInvite),
            registrationInviteCode: oldInvite
        },
        meta: {
            seededOnly: Boolean(raw?.meta?.seededOnly),
            migratedFromV4: true,
            migratedAt: Date.now()
        }
    };

    return ensureEnvAdminAndIntegrity(migrated);
}

function normalizeServer(srvId, rawSrv, validUsers) {
    const base = createServerObject({
        id: srvId,
        name: rawSrv?.name || "Sunucu",
        ownerId: rawSrv?.ownerId || null,
        inviteCode: rawSrv?.inviteCode || generateInviteCode("BD"),
        turnServer: rawSrv?.turnServer,
        channels: Array.isArray(rawSrv?.channels) && rawSrv.channels.length ? rawSrv.channels : null,
        messages: rawSrv?.messages && typeof rawSrv.messages === "object" ? rawSrv.messages : {}
    });

    base.icon = sanitizeAvatar(rawSrv?.icon);
    base.createdAt = Number(rawSrv?.createdAt) || Date.now();
    base.afkTimeoutSec = typeof rawSrv?.afkTimeoutSec === "number" && rawSrv.afkTimeoutSec >= 0
        ? Math.min(3600, Math.floor(rawSrv.afkTimeoutSec))
        : 300;

    if (rawSrv?.afkChannelId && base.channels.some((c) => c.id === rawSrv.afkChannelId && c.type === "voice")) {
        base.afkChannelId = rawSrv.afkChannelId;
    } else {
        const flagged = base.channels.find((c) => c.type === "voice" && c.isAfk);
        base.afkChannelId = flagged ? flagged.id : null;
    }

    if (Array.isArray(rawSrv?.roles) && rawSrv.roles.length > 0) {
        base.roles = rawSrv.roles
            .filter((r) => r && r.id && r.name)
            .map((r) => ({
                id: String(r.id),
                name: String(r.name).trim().slice(0, 28) || "Rol",
                color: sanitizeColor(r.color, "#949ba4"),
                priority: Math.max(1, Math.min(999, Number(r.priority) || 10)),
                permissions: sanitizePermissions(r.permissions)
            }))
            .sort((a, b) => b.priority - a.priority);
    }

    if (base.roles.length === 0) {
        base.roles = makeDefaultRoles();
    }

    const validRoleIds = new Set(base.roles.map((r) => r.id));
    const lowestRoleId = base.roles[base.roles.length - 1].id;

    base.members = {};
    if (rawSrv?.members && typeof rawSrv.members === "object") {
        for (const [uname, m] of Object.entries(rawSrv.members)) {
            if (!validUsers[uname]) continue;
            const roleIds = Array.isArray(m?.roleIds)
                ? [...new Set(m.roleIds.filter((rid) => validRoleIds.has(rid)))]
                : [];
            base.members[uname] = {
                roleIds: roleIds.length ? roleIds : [lowestRoleId],
                joinedAt: Number(m?.joinedAt) || Date.now()
            };
        }
    }

    if (base.ownerId && !validUsers[base.ownerId]) {
        base.ownerId = Object.keys(base.members)[0] || null;
    }
    if (base.ownerId && !base.members[base.ownerId]) {
        base.members[base.ownerId] = { roleIds: [base.roles[0].id], joinedAt: Date.now() };
    }

    base.polls = Array.isArray(rawSrv?.polls) ? rawSrv.polls.slice(-15) : [];

    return base;
}

function ensureEnvAdminAndIntegrity(dbObj) {
    if (ENV_ADMIN_USER && ENV_ADMIN_PASS.length >= 4 && !dbObj.users[ENV_ADMIN_USER]) {
        const { salt, hash } = hashPassword(ENV_ADMIN_PASS);
        dbObj.users[ENV_ADMIN_USER] = {
            salt,
            hash,
            role: "admin",
            isGlobalAdmin: true,
            displayName: ENV_ADMIN_USER,
            color: "#5865f2",
            status: "Çevrimiçi",
            avatar: ""
        };
    }

    if (Object.keys(dbObj.servers).length === 0) {
        const fallbackSrv = createServerObject({
            id: "srv-main",
            name: "BizimDiscord",
            ownerId: ENV_ADMIN_USER || Object.keys(dbObj.users)[0] || null,
            inviteCode: ENV_DEFAULT_INVITE || generateInviteCode("BD")
        });
        dbObj.servers[fallbackSrv.id] = fallbackSrv;
        dbObj.globalSettings.defaultServerId = fallbackSrv.id;
    }

    const defaultId = dbObj.servers[dbObj.globalSettings.defaultServerId]
        ? dbObj.globalSettings.defaultServerId
        : Object.keys(dbObj.servers)[0];
    dbObj.globalSettings.defaultServerId = defaultId;

    const defSrv = dbObj.servers[defaultId];
    if (ENV_ADMIN_USER && dbObj.users[ENV_ADMIN_USER]) {
        dbObj.users[ENV_ADMIN_USER].isGlobalAdmin = true;
        dbObj.users[ENV_ADMIN_USER].role = "admin";
        if (!defSrv.ownerId) defSrv.ownerId = ENV_ADMIN_USER;
        if (!defSrv.members[ENV_ADMIN_USER]) {
            const topRole = defSrv.roles[0]?.id || "role-admin";
            defSrv.members[ENV_ADMIN_USER] = { roleIds: [topRole], joinedAt: Date.now() };
        }
    }

    return dbObj;
}

function normalizeDB(raw) {
    if (!raw || typeof raw !== "object") return createDefaultDB();

    // v4.0 tespiti: `servers` yok ama eski format alanları var
    const isV4 = !raw.servers && (Array.isArray(raw.channels) || raw.settings || raw.users);
    if (isV4 && Number(raw.version || 4) < 5) {
        return migrateV4ToV5(raw);
    }

    const users = {};
    if (raw.users && typeof raw.users === "object") {
        for (const [uname, u] of Object.entries(raw.users)) {
            if (!u || !u.salt || !u.hash) continue;
            const isGlobal = Boolean(u.isGlobalAdmin || u.role === "admin");
            users[uname] = {
                salt: u.salt,
                hash: u.hash,
                role: isGlobal ? "admin" : "user",
                isGlobalAdmin: isGlobal,
                displayName: typeof u.displayName === "string" && u.displayName.trim() ? u.displayName.trim().slice(0, 28) : uname,
                color: sanitizeColor(u.color, "#5865f2"),
                status: typeof u.status === "string" && u.status.trim() ? u.status.trim().slice(0, 40) : "Çevrimiçi",
                avatar: sanitizeAvatar(u.avatar)
            };
        }
    }

    const sessions = {};
    if (raw.sessions && typeof raw.sessions === "object") {
        for (const [tok, uname] of Object.entries(raw.sessions)) {
            if (users[uname]) sessions[tok] = uname;
        }
    }

    const servers = {};
    if (raw.servers && typeof raw.servers === "object") {
        for (const [srvId, rawSrv] of Object.entries(raw.servers)) {
            servers[srvId] = normalizeServer(srvId, rawSrv, users);
        }
    }

    const dms = {};
    if (raw.dms && typeof raw.dms === "object") {
        for (const [key, arr] of Object.entries(raw.dms)) {
            if (Array.isArray(arr)) dms[key] = arr.slice(-100);
        }
    }

    const normalized = {
        version: 5,
        users,
        sessions,
        servers,
        dms,
        globalSettings: {
            defaultServerId: raw?.globalSettings?.defaultServerId || "srv-main",
            requireInviteToRegister: Boolean(raw?.globalSettings?.requireInviteToRegister),
            registrationInviteCode: String(raw?.globalSettings?.registrationInviteCode || "").trim().toUpperCase()
        },
        meta: {
            seededOnly: Boolean(raw?.meta?.seededOnly),
            migratedFromV4: Boolean(raw?.meta?.migratedFromV4)
        }
    };

    return ensureEnvAdminAndIntegrity(normalized);
}

function loadDB() {
    if (!fs.existsSync(DB_FILE)) {
        const initial = createDefaultDB();
        fs.writeFileSync(DB_FILE, JSON.stringify(initial, null, 2));
        return initial;
    }
    try {
        const parsed = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
        const normalized = normalizeDB(parsed);
        if (!parsed.version || parsed.version < 5) {
            fs.writeFileSync(DB_FILE, JSON.stringify(normalized, null, 2));
        }
        return normalized;
    } catch {
        return createDefaultDB();
    }
}

let db = loadDB();

// Çevrimiçi kullanıcılar ve sunucu bazlı geçici çalışma verileri (Ready-Check, Watch Together, Çizim Tahtası)
const activeUsers = new Map(); // socket.id -> runtime session
const serverRuntime = new Map(); // serverId -> { readyCheck, watch, board }
const soundboardCooldown = new Map(); // socket.id -> lastTimestamp

function getRuntime(serverId) {
    if (!serverRuntime.has(serverId)) {
        serverRuntime.set(serverId, {
            readyCheck: null,
            watch: {
                active: false,
                videoId: null,
                title: "",
                host: null,
                playing: false,
                currentTime: 0,
                updatedAt: Date.now()
            },
            board: {
                active: false,
                strokes: []
            }
        });
    }
    return serverRuntime.get(serverId);
}

// =========================================================================
// YETKİ & ROL HİYERARŞİSİ MOTORU
// =========================================================================

function getServerIceServers(srv) {
    const list = [...DEFAULT_ICE];
    const t = srv?.turnServer;
    if (t && t.url && t.url.trim()) {
        const entry = { urls: t.url.trim() };
        if (t.username) entry.username = t.username.trim();
        if (t.credential) entry.credential = t.credential.trim();
        list.push(entry);
    }
    return list;
}

function getMemberRoles(srv, username) {
    const member = srv?.members?.[username];
    if (!member) return [];
    const roleMap = new Map(srv.roles.map((r) => [r.id, r]));
    return (member.roleIds || [])
        .map((id) => roleMap.get(id))
        .filter(Boolean)
        .sort((a, b) => b.priority - a.priority);
}

function getMemberPower(srv, username) {
    if (!srv || !username) return 0;
    if (srv.ownerId === username) return Number.MAX_SAFE_INTEGER;
    const roles = getMemberRoles(srv, username);
    if (!roles.length) return 0;
    return Math.max(...roles.map((r) => Number(r.priority) || 0));
}

function getMemberTopRole(srv, username) {
    if (!srv || !username) return null;
    if (srv.ownerId === username) {
        return {
            id: "__owner__",
            name: "Sunucu Sahibi",
            color: "#f0b232",
            priority: 999999,
            isOwner: true
        };
    }
    const roles = getMemberRoles(srv, username);
    if (!roles.length) return null;
    const top = roles[0];
    return {
        id: top.id,
        name: top.name,
        color: top.color,
        priority: top.priority,
        isOwner: false
    };
}

function getMemberPermissions(srv, username) {
    const perms = sanitizePermissions({});
    if (!srv || !username || !srv.members[username]) return perms;

    if (srv.ownerId === username) {
        for (const k of PERMISSION_KEYS) perms[k] = true;
        return perms;
    }

    const roles = getMemberRoles(srv, username);
    let isAdminRole = false;
    for (const r of roles) {
        if (r.permissions?.administrator) isAdminRole = true;
        for (const k of PERMISSION_KEYS) {
            if (r.permissions?.[k]) perms[k] = true;
        }
    }
    if (isAdminRole) {
        for (const k of PERMISSION_KEYS) perms[k] = true;
    }
    return perms;
}

function hasPerm(srv, username, permKey) {
    const perms = getMemberPermissions(srv, username);
    return Boolean(perms.administrator || perms[permKey]);
}

function canActOnMember(srv, actorUsername, targetUsername) {
    if (!srv || !actorUsername || !targetUsername) return false;
    if (actorUsername === targetUsername) return false;
    if (!srv.members[actorUsername] || !srv.members[targetUsername]) return false;
    if (srv.ownerId === targetUsername) return false;
    if (srv.ownerId === actorUsername) return true;
    return getMemberPower(srv, actorUsername) > getMemberPower(srv, targetUsername);
}

function canManageRolePriority(srv, actorUsername, targetPriority) {
    if (!srv || !actorUsername) return false;
    if (srv.ownerId === actorUsername) return true;
    return getMemberPower(srv, actorUsername) > Number(targetPriority);
}

function isGlobalAdminSocket(socket) {
    const u = activeUsers.get(socket.id);
    return Boolean(u && db.users[u.username]?.isGlobalAdmin);
}

function getUserServersList(username) {
    const list = [];
    for (const srv of Object.values(db.servers)) {
        if (!srv.members[username]) continue;
        let onlineCount = 0;
        let voiceCount = 0;
        for (const au of activeUsers.values()) {
            if (srv.members[au.username]) onlineCount++;
            if (au.voiceServerId === srv.id && au.voiceChannel) voiceCount++;
        }
        list.push({
            id: srv.id,
            name: srv.name,
            icon: srv.icon || "",
            isOwner: srv.ownerId === username,
            memberCount: Object.keys(srv.members).length,
            onlineCount,
            voiceCount
        });
    }
    return list;
}

function buildServerMembersPayload(srv) {
    const onlineByUsername = new Map();
    for (const [sid, au] of activeUsers.entries()) {
        onlineByUsername.set(au.username, { socketId: sid, ...au });
    }

    const list = [];
    for (const [uname, m] of Object.entries(srv.members)) {
        const record = db.users[uname];
        if (!record) continue;
        const online = onlineByUsername.get(uname) || null;
        const topRole = getMemberTopRole(srv, uname);
        const power = getMemberPower(srv, uname);
        const inThisServerVoice = online && online.voiceServerId === srv.id ? online.voiceChannel : null;

        list.push({
            id: online ? online.socketId : null,
            username: uname,
            displayName: record.displayName || uname,
            color: record.color || "#5865f2",
            avatar: record.avatar || "",
            status: record.status || "Çevrimiçi",
            online: Boolean(online),
            isOwner: srv.ownerId === uname,
            roleIds: m.roleIds || [],
            topRole,
            power: power === Number.MAX_SAFE_INTEGER ? 999999 : power,
            voiceChannel: inThisServerVoice,
            serverMuted: online ? Boolean(online.serverMuted) : false,
            selfMuted: online ? Boolean(online.selfMuted) : false,
            deafened: online ? Boolean(online.deafened) : false,
            camOn: Boolean(inThisServerVoice && online?.camOn),
            camStreamId: inThisServerVoice ? (online?.camStreamId || null) : null,
            screenSharing: Boolean(inThisServerVoice && online?.screenSharing),
            screenStreamId: inThisServerVoice ? (online?.screenStreamId || null) : null
        });
    }

    // Sıralama: çevrimiçi üstte -> öncelik yüksek üstte -> alfabetik
    list.sort((a, b) => {
        if (a.online !== b.online) return a.online ? -1 : 1;
        if (a.power !== b.power) return b.power - a.power;
        return a.username.localeCompare(b.username, "tr");
    });

    return list;
}

function buildServerPublicSettings(srv, includePrivate = false) {
    const base = {
        id: srv.id,
        name: srv.name,
        icon: srv.icon || "",
        inviteCode: srv.inviteCode,
        ownerId: srv.ownerId,
        afkChannelId: srv.afkChannelId || null,
        afkTimeoutSec: srv.afkTimeoutSec ?? 300,
        iceServers: getServerIceServers(srv)
    };
    if (includePrivate) {
        base.turnServer = { ...srv.turnServer };
    }
    return base;
}

function buildServerSnapshot(srv, username) {
    const rt = getRuntime(srv.id);
    const perms = getMemberPermissions(srv, username);
    const canManage = Boolean(perms.administrator || perms.manageServer);
    const power = getMemberPower(srv, username);

    return {
        serverId: srv.id,
        settings: buildServerPublicSettings(srv, canManage),
        channels: srv.channels,
        roles: srv.roles,
        members: buildServerMembersPayload(srv),
        messages: srv.messages,
        myPermissions: perms,
        myPower: power === Number.MAX_SAFE_INTEGER ? 999999 : power,
        myTopRole: getMemberTopRole(srv, username),
        isOwner: srv.ownerId === username,
        readyCheck: rt.readyCheck,
        polls: srv.polls || [],
        watch: rt.watch,
        board: rt.board
    };
}

// =========================================================================
// VERİTABANI KAYIT, SENKRONİZASYON VE YAYIN
// =========================================================================

function saveAndSyncDB() {
    try {
        const serialized = JSON.stringify(db, null, 2);
        const tmpFile = DB_FILE + ".tmp";
        try {
            fs.writeFileSync(tmpFile, serialized, "utf8");
            fs.renameSync(tmpFile, DB_FILE);
        } catch {
            fs.writeFileSync(DB_FILE, serialized, "utf8");
        }
    } catch (err) {
        console.error("[DB Save Error]", err.message);
    }

    for (const [sid, au] of activeUsers.entries()) {
        if (db.users[au.username]?.isGlobalAdmin) {
            io.to(sid).emit("db-sync", db);
        }
    }
}

function broadcastServerState(serverId) {
    const srv = db.servers[serverId];
    if (!srv) return;

    const membersPayload = buildServerMembersPayload(srv);
    const room = io.sockets.adapter.rooms.get("srv:" + serverId);
    if (!room) return;

    for (const sid of room) {
        const au = activeUsers.get(sid);
        if (!au || !srv.members[au.username]) continue;
        const perms = getMemberPermissions(srv, au.username);
        const canManage = Boolean(perms.administrator || perms.manageServer);
        const power = getMemberPower(srv, au.username);

        io.to(sid).emit("server-state-update", {
            serverId: srv.id,
            settings: buildServerPublicSettings(srv, canManage),
            channels: srv.channels,
            roles: srv.roles,
            members: membersPayload,
            myPermissions: perms,
            myPower: power === Number.MAX_SAFE_INTEGER ? 999999 : power,
            myTopRole: getMemberTopRole(srv, au.username),
            isOwner: srv.ownerId === au.username
        });
    }
}

function broadcastAllUserServers(username) {
    for (const [sid, au] of activeUsers.entries()) {
        if (au.username === username) {
            io.to(sid).emit("my-servers-update", getUserServersList(username));
        }
    }
}

function broadcastUserPresenceAcrossServers(username) {
    for (const srv of Object.values(db.servers)) {
        if (srv.members[username]) {
            broadcastServerState(srv.id);
        }
    }
}

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
        version: APP_VERSION,
        time: Date.now(),
        uptimeSec: Math.floor((Date.now() - SERVER_STARTED_AT) / 1000),
        memRssMB: Math.round(mem.rss / 1024 / 1024),
        memHeapMB: Math.round(mem.heapUsed / 1024 / 1024),
        onlineUsers: activeUsers.size,
        inVoice,
        camCount,
        screenCount,
        registeredUsers: Object.keys(db.users).length,
        serverCount: Object.keys(db.servers).length
    };
}

app.get("/health", (_req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.status(200).json(getServerHealthSnapshot());
});

// =========================================================================
// SESLİ KANAL OTOMATİK AFK KORUMASI
// =========================================================================

function moveSocketToVoiceChannel(socketId, serverId, targetChannelId, reason = "afk") {
    const au = activeUsers.get(socketId);
    const srv = db.servers[serverId];
    if (!au || !srv) return;

    const oldServerId = au.voiceServerId;
    const oldChannelId = au.voiceChannel;

    if (oldServerId && oldChannelId) {
        io.to("srv:" + oldServerId).emit("user-left-voice", socketId);
        io.to("srv:" + oldServerId).emit("voice-event", {
            type: "leave",
            serverId: oldServerId,
            username: au.username,
            channelId: oldChannelId
        });
    }

    au.voiceServerId = serverId;
    au.voiceChannel = targetChannelId;
    au.selfMuted = true;
    au.camOn = false;
    au.camStreamId = null;
    au.screenSharing = false;
    au.screenStreamId = null;
    au.lastVoiceActivityAt = Date.now();

    const peersInTarget = [];
    for (const [id, u] of activeUsers.entries()) {
        if (id !== socketId && u.voiceServerId === serverId && u.voiceChannel === targetChannelId) {
            peersInTarget.push(id);
        }
    }

    const targetCh = srv.channels.find((c) => c.id === targetChannelId);
    io.to(socketId).emit("voice-afk-moved", {
        serverId,
        channelId: targetChannelId,
        channelName: targetCh?.name || "AFK",
        reason,
        peers: peersInTarget
    });

    if (oldServerId && oldServerId !== serverId) {
        broadcastServerState(oldServerId);
    }
    broadcastServerState(serverId);
}

setInterval(() => {
    const now = Date.now();
    for (const [sid, au] of activeUsers.entries()) {
        if (!au.voiceServerId || !au.voiceChannel) continue;
        if (au.afkExempt) continue;

        const srv = db.servers[au.voiceServerId];
        if (!srv || !srv.afkChannelId || !srv.afkTimeoutSec || srv.afkTimeoutSec <= 0) continue;
        if (au.voiceChannel === srv.afkChannelId) continue;

        // Kamera veya ekran paylaşımı aktifse otomatik AFK taşımayalım
        if (au.camOn || au.screenSharing) continue;

        const afkChannelExists = srv.channels.some((c) => c.id === srv.afkChannelId && c.type === "voice");
        if (!afkChannelExists) continue;

        const idleMs = now - (au.lastVoiceActivityAt || now);
        if (idleMs >= srv.afkTimeoutSec * 1000) {
            moveSocketToVoiceChannel(sid, srv.id, srv.afkChannelId, "auto-afk");
        }
    }
}, 15000);

// =========================================================================
// OTURUM TAMAMLAMA
// =========================================================================

function completeUserSession(socket, username, record, tokenToReturn) {
    // Aynı hesaptan eski bağlantıyı kapat
    for (const [oldId, u] of activeUsers.entries()) {
        if (u.username === username && oldId !== socket.id) {
            const oldVoiceSrv = u.voiceServerId;
            io.to(oldId).emit("kicked", "Hesabınıza başka bir cihazdan giriş yapıldı.");
            io.sockets.sockets.get(oldId)?.disconnect(true);
            activeUsers.delete(oldId);
            if (oldVoiceSrv) {
                io.to("srv:" + oldVoiceSrv).emit("user-left-voice", oldId);
                broadcastServerState(oldVoiceSrv);
            }
        }
    }

    // Kullanıcının hiç sunucusu yoksa varsayılan sunucuya ekle
    let userServers = getUserServersList(username);
    if (userServers.length === 0) {
        const defSrv = db.servers[db.globalSettings.defaultServerId] || Object.values(db.servers)[0];
        if (defSrv) {
            const defaultRole = defSrv.roles[defSrv.roles.length - 1]?.id || "role-member";
            defSrv.members[username] = {
                roleIds: record.isGlobalAdmin ? [defSrv.roles[0]?.id || defaultRole] : [defaultRole],
                joinedAt: Date.now()
            };
            saveAndSyncDB();
            userServers = getUserServersList(username);
        }
    }

    const initialServerId = userServers[0]?.id || null;

    activeUsers.set(socket.id, {
        username,
        displayName: record.displayName || username,
        isGlobalAdmin: Boolean(record.isGlobalAdmin),
        color: record.color || "#5865f2",
        avatar: record.avatar || "",
        status: record.status || "Çevrimiçi",
        activeServerId: initialServerId,
        voiceServerId: null,
        voiceChannel: null,
        serverMuted: false,
        selfMuted: false,
        deafened: false,
        camOn: false,
        camStreamId: null,
        screenSharing: false,
        screenStreamId: null,
        afkExempt: false,
        lastVoiceActivityAt: Date.now()
    });

    // Kullanıcının üyesi olduğu tüm sunucuların Socket.IO odalarına katıl
    for (const s of userServers) {
        socket.join("srv:" + s.id);
    }

    if (record.isGlobalAdmin) {
        socket.emit("db-sync", db);
    }

    broadcastUserPresenceAcrossServers(username);

    const activeSrv = initialServerId ? db.servers[initialServerId] : null;

    return {
        ok: true,
        token: tokenToReturn || null,
        me: {
            id: socket.id,
            username,
            displayName: record.displayName || username,
            role: record.isGlobalAdmin ? "admin" : "user",
            isGlobalAdmin: Boolean(record.isGlobalAdmin),
            color: record.color || "#5865f2",
            avatar: record.avatar || "",
            status: record.status || "Çevrimiçi"
        },
        servers: userServers,
        activeServerId: initialServerId,
        snapshot: activeSrv ? buildServerSnapshot(activeSrv, username) : null
    };
}

// =========================================================================
// SOCKET.IO OLAYLARI
// =========================================================================

io.on("connection", (socket) => {
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
        if (typeof cb === "function") cb(getServerHealthSnapshot());
    });

    // --- YEREL MASTER VERİTABANI SENKRONİZASYONU ---
    socket.on("check-db-needs-restore", (cb) => {
        const needs = Object.keys(db.users).length === 0 || Boolean(db.meta?.seededOnly);
        if (typeof cb === "function") cb(needs);
    });

    socket.on("restore-db", (incomingDB, cb) => {
        if (!incomingDB || typeof incomingDB !== "object" || !incomingDB.users) {
            return cb?.({ ok: false, error: "Geçersiz veritabanı dosyası." });
        }

        const serverNeedsRestore = Object.keys(db.users).length === 0 || Boolean(db.meta?.seededOnly);
        const hasAdminInBackup = Object.values(incomingDB.users).some(
            (u) => u && (u.role === "admin" || u.isGlobalAdmin)
        );
        if (!hasAdminInBackup) {
            return cb?.({ ok: false, error: "Yedek dosyasında yönetici hesabı bulunamadı." });
        }
        if (!serverNeedsRestore && !isGlobalAdminSocket(socket)) {
            return cb?.({ ok: false, error: "Dolu sunucuya geri yükleme için Genel Yönetici yetkisi gerekli." });
        }

        const wasV4 = !incomingDB.servers;
        db = normalizeDB(incomingDB);
        db.meta.seededOnly = false;
        saveAndSyncDB();

        const newDefSrv = db.servers[db.globalSettings.defaultServerId] || Object.values(db.servers)[0];
        io.emit("server-info", {
            version: APP_VERSION,
            serverName: newDefSrv?.name || "BizimDiscord",
            hasInviteCode: Boolean(db.globalSettings.requireInviteToRegister),
            isFirstSetup: false
        });

        for (const srvId of Object.keys(db.servers)) {
            broadcastServerState(srvId);
        }

        cb?.({ ok: true, migratedFromV4: wasV4 });
    });

    // --- KİMLİK DOĞRULAMA ---
    socket.on("register", ({ username, password, inviteCode }, cb) => {
        const clean = (username || "").trim().toLowerCase().replace(/[^a-z0-9._-]/g, "").slice(0, 20);
        if (!clean || clean.length < 2) {
            return cb?.({ ok: false, error: "Kullanıcı adı en az 2 karakter (harf/rakam) olmalı." });
        }
        if (!password || password.length < 4) {
            return cb?.({ ok: false, error: "Şifre en az 4 karakter olmalı." });
        }
        if (db.users[clean]) {
            return cb?.({ ok: false, error: "Bu kullanıcı adı zaten alınmış." });
        }

        const isFirstUser = Object.keys(db.users).length === 0;
        const cleanInvite = (inviteCode || "").trim().toUpperCase();

        // Girilen davet kodu herhangi bir sunucuya ait mi?
        let targetServer = null;
        if (cleanInvite) {
            targetServer = Object.values(db.servers).find(
                (s) => s.inviteCode && s.inviteCode.toUpperCase() === cleanInvite
            );
        }

        if (!isFirstUser && db.globalSettings.requireInviteToRegister) {
            const matchesGlobal = db.globalSettings.registrationInviteCode && cleanInvite === db.globalSettings.registrationInviteCode;
            if (!targetServer && !matchesGlobal) {
                return cb?.({ ok: false, error: "Geçerli bir sunucu davet kodu gerekli." });
            }
        }

        if (!targetServer) {
            targetServer = db.servers[db.globalSettings.defaultServerId] || Object.values(db.servers)[0];
        }

        const color = USER_PALETTE[Math.floor(Math.random() * USER_PALETTE.length)];
        const { salt, hash } = hashPassword(password);

        db.users[clean] = {
            salt,
            hash,
            role: isFirstUser ? "admin" : "user",
            isGlobalAdmin: isFirstUser,
            displayName: clean,
            color,
            status: "Çevrimiçi",
            avatar: ""
        };

        if (targetServer) {
            if (isFirstUser && !targetServer.ownerId) {
                targetServer.ownerId = clean;
            }
            const assignRoleId = isFirstUser
                ? (targetServer.roles[0]?.id || "role-admin")
                : (targetServer.roles[targetServer.roles.length - 1]?.id || "role-member");
            targetServer.members[clean] = {
                roleIds: [assignRoleId],
                joinedAt: Date.now()
            };
        }

        db.meta.seededOnly = false;
        saveAndSyncDB();
        cb?.({ ok: true, role: db.users[clean].role });
    });

    socket.on("login", ({ username, password, remember }, cb) => {
        const clean = (username || "").trim().toLowerCase();
        const record = db.users[clean];
        if (!record) return cb?.({ ok: false, error: "Kullanıcı bulunamadı." });

        const { hash } = hashPassword(password, record.salt);
        if (hash !== record.hash) return cb?.({ ok: false, error: "Şifre hatalı." });

        let token = null;
        if (remember) {
            token = crypto.randomBytes(24).toString("hex");
            db.sessions[token] = clean;
            saveAndSyncDB();
        }

        cb?.(completeUserSession(socket, clean, record, token));
    });

    socket.on("login-token", (token, cb) => {
        const clean = token && db.sessions[token];
        const record = clean && db.users[clean];
        if (!clean || !record) return cb?.({ ok: false });
        cb?.(completeUserSession(socket, clean, record, token));
    });

    socket.on("logout", (token) => {
        if (token && db.sessions[token]) {
            delete db.sessions[token];
            saveAndSyncDB();
        }
    });

    socket.on("update-profile", ({ displayName, color, status, avatar, afkExempt }, cb) => {
        const user = activeUsers.get(socket.id);
        if (!user || !db.users[user.username]) return cb?.({ ok: false });

        const rec = db.users[user.username];
        if (typeof displayName === "string") {
            const cleanName = displayName.trim().slice(0, 28) || user.username;
            user.displayName = cleanName;
            rec.displayName = cleanName;
        }
        if (typeof color === "string" && /^#[0-9a-fA-F]{6}$/.test(color)) {
            user.color = color;
            rec.color = color;
        }
        if (typeof status === "string") {
            const cleanStatus = status.trim().slice(0, 40) || "Çevrimiçi";
            user.status = cleanStatus;
            rec.status = cleanStatus;
        }
        if (avatar !== undefined) {
            const safeAv = avatar === "" ? "" : sanitizeAvatar(avatar);
            if (avatar === "" || safeAv) {
                user.avatar = safeAv;
                rec.avatar = safeAv;
            }
        }
        if (typeof afkExempt === "boolean") {
            user.afkExempt = afkExempt;
        }

        db.meta.seededOnly = false;
        saveAndSyncDB();
        broadcastUserPresenceAcrossServers(user.username);
        cb?.({
            ok: true,
            me: {
                displayName: rec.displayName,
                color: rec.color,
                status: rec.status,
                avatar: rec.avatar
            }
        });
    });

    // --- ÇOKLU SUNUCU YÖNETİMİ ---
    socket.on("server-create", ({ name, icon }, cb) => {
        const user = activeUsers.get(socket.id);
        if (!user) return cb?.({ ok: false, error: "Oturum bulunamadı." });

        const cleanName = (name || "").trim().slice(0, 32);
        if (cleanName.length < 2) {
            return cb?.({ ok: false, error: "Sunucu adı en az 2 karakter olmalı." });
        }

        const existingCodes = new Set(Object.values(db.servers).map((s) => s.inviteCode.toUpperCase()));
        let code = generateInviteCode("SRV");
        while (existingCodes.has(code)) {
            code = generateInviteCode("SRV");
        }

        const newSrv = createServerObject({
            name: cleanName,
            ownerId: user.username,
            inviteCode: code
        });
        if (icon) newSrv.icon = sanitizeAvatar(icon);
        newSrv.members[user.username] = {
            roleIds: ["role-admin"],
            joinedAt: Date.now()
        };

        db.servers[newSrv.id] = newSrv;
        db.meta.seededOnly = false;
        saveAndSyncDB();

        socket.join("srv:" + newSrv.id);
        user.activeServerId = newSrv.id;

        const serversList = getUserServersList(user.username);
        socket.emit("my-servers-update", serversList);

        cb?.({
            ok: true,
            serverId: newSrv.id,
            servers: serversList,
            snapshot: buildServerSnapshot(newSrv, user.username)
        });
    });

    socket.on("server-join", ({ inviteCode }, cb) => {
        const user = activeUsers.get(socket.id);
        if (!user) return cb?.({ ok: false, error: "Oturum bulunamadı." });

        const cleanCode = (inviteCode || "").trim().toUpperCase();
        if (!cleanCode) return cb?.({ ok: false, error: "Davet kodu boş olamaz." });

        const targetSrv = Object.values(db.servers).find(
            (s) => s.inviteCode && s.inviteCode.toUpperCase() === cleanCode
        );
        if (!targetSrv) {
            return cb?.({ ok: false, error: "Bu davet koduna ait sunucu bulunamadı." });
        }

        if (!targetSrv.members[user.username]) {
            const defaultRole = targetSrv.roles[targetSrv.roles.length - 1]?.id || "role-member";
            targetSrv.members[user.username] = {
                roleIds: [defaultRole],
                joinedAt: Date.now()
            };
            db.meta.seededOnly = false;
            saveAndSyncDB();
        }

        socket.join("srv:" + targetSrv.id);
        user.activeServerId = targetSrv.id;

        const serversList = getUserServersList(user.username);
        socket.emit("my-servers-update", serversList);
        broadcastServerState(targetSrv.id);

        cb?.({
            ok: true,
            serverId: targetSrv.id,
            servers: serversList,
            snapshot: buildServerSnapshot(targetSrv, user.username)
        });
    });

    socket.on("server-select", ({ serverId }, cb) => {
        const user = activeUsers.get(socket.id);
        const srv = db.servers[serverId];
        if (!user || !srv || !srv.members[user.username]) {
            return cb?.({ ok: false, error: "Bu sunucuya erişiminiz yok." });
        }
        socket.join("srv:" + srv.id);
        user.activeServerId = srv.id;
        cb?.({
            ok: true,
            snapshot: buildServerSnapshot(srv, user.username)
        });
    });

    socket.on("server-leave", ({ serverId }, cb) => {
        const user = activeUsers.get(socket.id);
        const srv = db.servers[serverId];
        if (!user || !srv || !srv.members[user.username]) {
            return cb?.({ ok: false, error: "Sunucu bulunamadı." });
        }
        if (srv.ownerId === user.username) {
            return cb?.({ ok: false, error: "Sunucu sahibi sunucudan ayrılamaz; sunucuyu silebilirsiniz." });
        }

        if (user.voiceServerId === serverId) {
            user.voiceServerId = null;
            user.voiceChannel = null;
            user.camOn = false;
            user.camStreamId = null;
            user.screenSharing = false;
            user.screenStreamId = null;
            io.to("srv:" + serverId).emit("user-left-voice", socket.id);
            socket.emit("force-leave-voice");
        }

        delete srv.members[user.username];
        socket.leave("srv:" + serverId);
        db.meta.seededOnly = false;
        saveAndSyncDB();

        broadcastServerState(serverId);
        const serversList = getUserServersList(user.username);
        socket.emit("my-servers-update", serversList);

        const nextSrvId = serversList[0]?.id || null;
        user.activeServerId = nextSrvId;
        cb?.({
            ok: true,
            servers: serversList,
            nextServerId: nextSrvId,
            snapshot: nextSrvId && db.servers[nextSrvId] ? buildServerSnapshot(db.servers[nextSrvId], user.username) : null
        });
    });

    socket.on("server-delete", ({ serverId }, cb) => {
        const user = activeUsers.get(socket.id);
        const srv = db.servers[serverId];
        if (!user || !srv) return cb?.({ ok: false, error: "Sunucu bulunamadı." });
        if (srv.ownerId !== user.username && !user.isGlobalAdmin) {
            return cb?.({ ok: false, error: "Sadece sunucu sahibi sunucuyu silebilir." });
        }
        if (Object.keys(db.servers).length <= 1) {
            return cb?.({ ok: false, error: "Son kalan sunucu silinemez." });
        }

        const affectedUsernames = Object.keys(srv.members);
        for (const [sid, au] of activeUsers.entries()) {
            if (au.voiceServerId === serverId) {
                au.voiceServerId = null;
                au.voiceChannel = null;
                au.camOn = false;
                au.camStreamId = null;
                au.screenSharing = false;
                au.screenStreamId = null;
                io.to(sid).emit("force-leave-voice");
            }
            const sock = io.sockets.sockets.get(sid);
            sock?.leave("srv:" + serverId);
        }

        delete db.servers[serverId];
        serverRuntime.delete(serverId);
        if (db.globalSettings.defaultServerId === serverId) {
            db.globalSettings.defaultServerId = Object.keys(db.servers)[0];
        }
        db.meta.seededOnly = false;
        saveAndSyncDB();

        for (const uname of affectedUsernames) {
            broadcastAllUserServers(uname);
        }
        io.emit("server-removed", { serverId });

        const serversList = getUserServersList(user.username);
        const nextSrvId = serversList[0]?.id || null;
        cb?.({
            ok: true,
            servers: serversList,
            nextServerId: nextSrvId,
            snapshot: nextSrvId && db.servers[nextSrvId] ? buildServerSnapshot(db.servers[nextSrvId], user.username) : null
        });
    });

    socket.on("server-update-settings", ({
        serverId,
        name,
        icon,
        inviteCode,
        regenerateInvite,
        turnUrl,
        turnUser,
        turnPass,
        afkChannelId,
        afkTimeoutSec
    }, cb) => {
        const user = activeUsers.get(socket.id);
        const srv = db.servers[serverId];
        if (!user || !srv || !hasPerm(srv, user.username, "manageServer")) {
            return cb?.({ ok: false, error: "Sunucu ayarlarını düzenleme yetkiniz yok." });
        }

        if (typeof name === "string" && name.trim().length >= 2) {
            srv.name = name.trim().slice(0, 32);
        }
        if (icon !== undefined) {
            srv.icon = icon === "" ? "" : (sanitizeAvatar(icon) || srv.icon);
        }
        if (regenerateInvite) {
            const existingCodes = new Set(Object.values(db.servers).map((s) => s.inviteCode.toUpperCase()));
            let code = generateInviteCode("BD");
            while (existingCodes.has(code)) code = generateInviteCode("BD");
            srv.inviteCode = code;
        } else if (typeof inviteCode === "string" && inviteCode.trim().length >= 3) {
            const candidate = inviteCode.trim().toUpperCase().replace(/[^A-Z0-9_-]/g, "").slice(0, 24);
            const conflict = Object.values(db.servers).some(
                (s) => s.id !== srv.id && s.inviteCode.toUpperCase() === candidate
            );
            if (conflict) {
                return cb?.({ ok: false, error: "Bu davet kodu başka bir sunucu tarafından kullanılıyor." });
            }
            if (candidate.length >= 3) srv.inviteCode = candidate;
        }

        if (turnUrl !== undefined || turnUser !== undefined || turnPass !== undefined) {
            srv.turnServer = {
                url: String(turnUrl ?? srv.turnServer.url ?? "").trim().slice(0, 120),
                username: String(turnUser ?? srv.turnServer.username ?? "").trim().slice(0, 80),
                credential: String(turnPass ?? srv.turnServer.credential ?? "").trim().slice(0, 120)
            };
        }

        if (afkChannelId !== undefined) {
            if (!afkChannelId) {
                srv.afkChannelId = null;
            } else if (srv.channels.some((c) => c.id === afkChannelId && c.type === "voice")) {
                srv.afkChannelId = afkChannelId;
                srv.channels.forEach((c) => {
                    if (c.type === "voice") c.isAfk = c.id === afkChannelId;
                });
            }
        }

        if (afkTimeoutSec !== undefined) {
            const sec = Number(afkTimeoutSec);
            if (!Number.isNaN(sec) && sec >= 0 && sec <= 3600) {
                srv.afkTimeoutSec = Math.floor(sec);
            }
        }

        db.meta.seededOnly = false;
        saveAndSyncDB();
        broadcastServerState(srv.id);
        for (const uname of Object.keys(srv.members)) {
            broadcastAllUserServers(uname);
        }
        cb?.({ ok: true, inviteCode: srv.inviteCode });
    });

    // --- KANAL YÖNETİMİ (SAĞ TIK MENÜSÜ CRUD) ---
    socket.on("channel-create", ({ serverId, name, type, topic, isAfk }, cb) => {
        const user = activeUsers.get(socket.id);
        const srv = db.servers[serverId];
        if (!user || !srv || !hasPerm(srv, user.username, "manageChannels")) {
            return cb?.({ ok: false, error: "Kanal oluşturma yetkiniz yok." });
        }
        const cleanName = (name || "").trim().slice(0, 28);
        if (!cleanName) return cb?.({ ok: false, error: "Kanal adı boş olamaz." });

        const chType = type === "voice" ? "voice" : "text";
        const id = "ch-" + Date.now().toString(36) + "-" + crypto.randomBytes(2).toString("hex");
        const ch = {
            id,
            name: cleanName,
            type: chType,
            topic: (topic || "").trim().slice(0, 100),
            isAfk: chType === "voice" && Boolean(isAfk)
        };
        srv.channels.push(ch);
        if (chType === "text") srv.messages[id] = [];
        if (ch.isAfk) {
            srv.afkChannelId = id;
            srv.channels.forEach((c) => {
                if (c.type === "voice" && c.id !== id) c.isAfk = false;
            });
        }

        db.meta.seededOnly = false;
        saveAndSyncDB();
        broadcastServerState(srv.id);
        cb?.({ ok: true, channel: ch });
    });

    socket.on("channel-update", ({ serverId, channelId, name, topic, isAfk }, cb) => {
        const user = activeUsers.get(socket.id);
        const srv = db.servers[serverId];
        if (!user || !srv || !hasPerm(srv, user.username, "manageChannels")) {
            return cb?.({ ok: false, error: "Kanal düzenleme yetkiniz yok." });
        }
        const ch = srv.channels.find((c) => c.id === channelId);
        if (!ch) return cb?.({ ok: false, error: "Kanal bulunamadı." });

        if (typeof name === "string" && name.trim()) {
            ch.name = name.trim().slice(0, 28);
        }
        if (typeof topic === "string") {
            ch.topic = topic.trim().slice(0, 100);
        }
        if (ch.type === "voice" && typeof isAfk === "boolean") {
            ch.isAfk = isAfk;
            if (isAfk) {
                srv.afkChannelId = ch.id;
                srv.channels.forEach((c) => {
                    if (c.type === "voice" && c.id !== ch.id) c.isAfk = false;
                });
            } else if (srv.afkChannelId === ch.id) {
                srv.afkChannelId = null;
            }
        }

        db.meta.seededOnly = false;
        saveAndSyncDB();
        broadcastServerState(srv.id);
        cb?.({ ok: true, channel: ch });
    });

    socket.on("channel-delete", ({ serverId, channelId }, cb) => {
        const user = activeUsers.get(socket.id);
        const srv = db.servers[serverId];
        if (!user || !srv || !hasPerm(srv, user.username, "manageChannels")) {
            return cb?.({ ok: false, error: "Kanal silme yetkiniz yok." });
        }
        const target = srv.channels.find((c) => c.id === channelId);
        if (!target) return cb?.({ ok: false, error: "Kanal bulunamadı." });

        if (target.type === "text" && srv.channels.filter((c) => c.type === "text").length <= 1) {
            return cb?.({ ok: false, error: "Sunucuda en az bir metin kanalı kalmalı." });
        }
        if (srv.channels.length <= 1) {
            return cb?.({ ok: false, error: "Son kanal silinemez." });
        }

        srv.channels = srv.channels.filter((c) => c.id !== channelId);
        delete srv.messages[channelId];
        if (srv.afkChannelId === channelId) srv.afkChannelId = null;

        for (const [sid, au] of activeUsers.entries()) {
            if (au.voiceServerId === serverId && au.voiceChannel === channelId) {
                au.voiceServerId = null;
                au.voiceChannel = null;
                au.camOn = false;
                au.camStreamId = null;
                au.screenSharing = false;
                au.screenStreamId = null;
                io.to(sid).emit("force-leave-voice");
                io.to("srv:" + serverId).emit("user-left-voice", sid);
            }
        }

        db.meta.seededOnly = false;
        saveAndSyncDB();
        broadcastServerState(srv.id);
        cb?.({ ok: true });
    });

    // --- ÖZEL ROL & YETKİ HİYERARŞİSİ ---
    socket.on("role-create", ({ serverId, name, color, priority, permissions }, cb) => {
        const user = activeUsers.get(socket.id);
        const srv = db.servers[serverId];
        if (!user || !srv || !hasPerm(srv, user.username, "manageRoles")) {
            return cb?.({ ok: false, error: "Rol oluşturma yetkiniz yok." });
        }

        const cleanName = (name || "").trim().slice(0, 28);
        if (!cleanName) return cb?.({ ok: false, error: "Rol adı boş olamaz." });

        const prio = Math.max(1, Math.min(999, Math.floor(Number(priority) || 10)));
        if (!canManageRolePriority(srv, user.username, prio)) {
            return cb?.({ ok: false, error: "Kendi yetki önceliğinize eşit veya daha yüksek öncelikli rol oluşturamazsınız." });
        }

        const safePerms = sanitizePermissions(permissions);
        const actorPerms = getMemberPermissions(srv, user.username);
        if (safePerms.administrator && !actorPerms.administrator && srv.ownerId !== user.username) {
            return cb?.({ ok: false, error: "Yönetici iznine sahip olmadan Yönetici rolü oluşturamazsınız." });
        }

        const role = {
            id: "role-" + Date.now().toString(36) + "-" + crypto.randomBytes(2).toString("hex"),
            name: cleanName,
            color: sanitizeColor(color, "#5865f2"),
            priority: prio,
            permissions: safePerms
        };

        srv.roles.push(role);
        srv.roles.sort((a, b) => b.priority - a.priority);
        db.meta.seededOnly = false;
        saveAndSyncDB();
        broadcastServerState(srv.id);
        cb?.({ ok: true, role });
    });

    socket.on("role-update", ({ serverId, roleId, name, color, priority, permissions }, cb) => {
        const user = activeUsers.get(socket.id);
        const srv = db.servers[serverId];
        if (!user || !srv || !hasPerm(srv, user.username, "manageRoles")) {
            return cb?.({ ok: false, error: "Rol düzenleme yetkiniz yok." });
        }

        const role = srv.roles.find((r) => r.id === roleId);
        if (!role) return cb?.({ ok: false, error: "Rol bulunamadı." });

        if (!canManageRolePriority(srv, user.username, role.priority)) {
            return cb?.({ ok: false, error: "Kendi yetki seviyenize eşit veya üstündeki bir rolü düzenleyemezsiniz." });
        }

        const newPrio = priority !== undefined
            ? Math.max(1, Math.min(999, Math.floor(Number(priority) || role.priority)))
            : role.priority;

        if (!canManageRolePriority(srv, user.username, newPrio)) {
            return cb?.({ ok: false, error: "Rol önceliğini kendi seviyenize eşit veya üstüne çıkaramazsınız." });
        }

        const safePerms = permissions ? sanitizePermissions(permissions) : role.permissions;
        const actorPerms = getMemberPermissions(srv, user.username);
        if (safePerms.administrator && !actorPerms.administrator && srv.ownerId !== user.username) {
            return cb?.({ ok: false, error: "Yönetici izni verebilmek için Yönetici olmalısınız." });
        }

        if (typeof name === "string" && name.trim()) role.name = name.trim().slice(0, 28);
        if (color) role.color = sanitizeColor(color, role.color);
        role.priority = newPrio;
        role.permissions = safePerms;

        srv.roles.sort((a, b) => b.priority - a.priority);
        db.meta.seededOnly = false;
        saveAndSyncDB();
        broadcastServerState(srv.id);
        cb?.({ ok: true, role });
    });

    socket.on("role-delete", ({ serverId, roleId }, cb) => {
        const user = activeUsers.get(socket.id);
        const srv = db.servers[serverId];
        if (!user || !srv || !hasPerm(srv, user.username, "manageRoles")) {
            return cb?.({ ok: false, error: "Rol silme yetkiniz yok." });
        }
        if (srv.roles.length <= 1) {
            return cb?.({ ok: false, error: "Sunucudaki son rol silinemez." });
        }

        const role = srv.roles.find((r) => r.id === roleId);
        if (!role) return cb?.({ ok: false, error: "Rol bulunamadı." });

        if (!canManageRolePriority(srv, user.username, role.priority)) {
            return cb?.({ ok: false, error: "Kendi yetki seviyenize eşit veya üstündeki bir rolü silemezsiniz." });
        }

        srv.roles = srv.roles.filter((r) => r.id !== roleId);
        const fallbackRoleId = srv.roles[srv.roles.length - 1].id;
        for (const m of Object.values(srv.members)) {
            m.roleIds = (m.roleIds || []).filter((id) => id !== roleId);
            if (m.roleIds.length === 0) m.roleIds = [fallbackRoleId];
        }

        db.meta.seededOnly = false;
        saveAndSyncDB();
        broadcastServerState(srv.id);
        cb?.({ ok: true });
    });

    socket.on("member-set-roles", ({ serverId, targetUsername, roleIds }, cb) => {
        const user = activeUsers.get(socket.id);
        const srv = db.servers[serverId];
        if (!user || !srv || !hasPerm(srv, user.username, "manageRoles")) {
            return cb?.({ ok: false, error: "Üye rollerini değiştirme yetkiniz yok." });
        }
        if (!srv.members[targetUsername]) {
            return cb?.({ ok: false, error: "Üye sunucuda bulunamadı." });
        }

        // Sunucu sahibi kendi etiket rollerini de güncelleyebilir; başkaları kendi seviyesine/üstüne dokunamaz
        const isSelfOwner = srv.ownerId === user.username && targetUsername === user.username;
        if (!isSelfOwner && !canActOnMember(srv, user.username, targetUsername)) {
            return cb?.({ ok: false, error: "Kendi yetki seviyenize eşit veya üstündeki bir üyenin rollerini değiştiremezsiniz." });
        }

        const roleMap = new Map(srv.roles.map((r) => [r.id, r]));
        const currentIds = new Set(srv.members[targetUsername].roleIds || []);
        const nextIds = new Set(
            (Array.isArray(roleIds) ? roleIds : []).filter((rid) => roleMap.has(rid))
        );

        // Eklenen veya çıkarılan her rol aktörün kendi önceliğinden düşük olmalı
        const changedIds = new Set([...currentIds, ...nextIds]);
        for (const rid of changedIds) {
            const wasIn = currentIds.has(rid);
            const isIn = nextIds.has(rid);
            if (wasIn !== isIn) {
                const role = roleMap.get(rid);
                if (role && !canManageRolePriority(srv, user.username, role.priority)) {
                    return cb?.({
                        ok: false,
                        error: `"${role.name}" rolü kendi seviyenize eşit veya yüksek olduğu için atanamaz/alınamaz.`
                    });
                }
            }
        }

        const finalIds = [...nextIds];
        if (finalIds.length === 0) {
            finalIds.push(srv.roles[srv.roles.length - 1].id);
        }

        srv.members[targetUsername].roleIds = finalIds;
        db.meta.seededOnly = false;
        saveAndSyncDB();
        broadcastServerState(srv.id);
        cb?.({ ok: true });
    });

    // --- MODERASYON (HİYERARŞİ KORUMALI) ---
    socket.on("member-kick", ({ serverId, targetUsername }, cb) => {
        const user = activeUsers.get(socket.id);
        const srv = db.servers[serverId];
        if (!user || !srv || !hasPerm(srv, user.username, "kickMembers")) {
            return cb?.({ ok: false, error: "Üye atma yetkiniz yok." });
        }
        if (!canActOnMember(srv, user.username, targetUsername)) {
            return cb?.({ ok: false, error: "Kendi seviyenize eşit veya üstündeki bir üyeyi atamazsınız." });
        }

        delete srv.members[targetUsername];
        db.meta.seededOnly = false;
        saveAndSyncDB();

        for (const [sid, au] of activeUsers.entries()) {
            if (au.username === targetUsername) {
                const targetSocket = io.sockets.sockets.get(sid);
                if (au.voiceServerId === serverId) {
                    au.voiceServerId = null;
                    au.voiceChannel = null;
                    au.camOn = false;
                    au.camStreamId = null;
                    au.screenSharing = false;
                    au.screenStreamId = null;
                    io.to("srv:" + serverId).emit("user-left-voice", sid);
                    io.to(sid).emit("force-leave-voice");
                }
                targetSocket?.leave("srv:" + serverId);
                io.to(sid).emit("server-kicked", {
                    serverId,
                    serverName: srv.name,
                    by: user.displayName || user.username
                });
                io.to(sid).emit("my-servers-update", getUserServersList(targetUsername));
            }
        }

        broadcastServerState(serverId);
        cb?.({ ok: true });
    });

    socket.on("member-toggle-mute", ({ serverId, targetUsername }, cb) => {
        const user = activeUsers.get(socket.id);
        const srv = db.servers[serverId];
        if (!user || !srv || !hasPerm(srv, user.username, "muteMembers")) {
            return cb?.({ ok: false, error: "Susturma yetkiniz yok." });
        }
        if (!canActOnMember(srv, user.username, targetUsername)) {
            return cb?.({ ok: false, error: "Kendi seviyenize eşit veya üstündeki bir üyeyi susturamazsınız." });
        }

        let foundSocketId = null;
        for (const [sid, au] of activeUsers.entries()) {
            if (au.username === targetUsername) {
                foundSocketId = sid;
                au.serverMuted = !au.serverMuted;
                io.to(sid).emit("server-mute-status", au.serverMuted);
                break;
            }
        }
        if (!foundSocketId) return cb?.({ ok: false, error: "Kullanıcı çevrimiçi değil." });

        broadcastServerState(serverId);
        cb?.({ ok: true });
    });

    socket.on("member-move-afk", ({ serverId, targetUsername }, cb) => {
        const user = activeUsers.get(socket.id);
        const srv = db.servers[serverId];
        if (!user || !srv || !hasPerm(srv, user.username, "muteMembers")) {
            return cb?.({ ok: false, error: "Üyeyi AFK kanalına taşıma yetkiniz yok." });
        }
        if (!srv.afkChannelId) {
            return cb?.({ ok: false, error: "Bu sunucuda AFK ses kanalı tanımlı değil." });
        }
        if (!canActOnMember(srv, user.username, targetUsername)) {
            return cb?.({ ok: false, error: "Kendi seviyenize eşit veya üstündeki bir üyeyi taşıyamazsınız." });
        }

        let targetSid = null;
        for (const [sid, au] of activeUsers.entries()) {
            if (au.username === targetUsername && au.voiceServerId === serverId && au.voiceChannel) {
                targetSid = sid;
                break;
            }
        }
        if (!targetSid) {
            return cb?.({ ok: false, error: "Üye bu sunucuda bir ses kanalında değil." });
        }

        moveSocketToVoiceChannel(targetSid, serverId, srv.afkChannelId, "admin-move");
        cb?.({ ok: true });
    });

    // --- METİN SOHBETİ (SUNUCU BAZLI İZOLE) ---
    socket.on("chat-message", ({ serverId, channelId, text, image, replyTo }) => {
        const user = activeUsers.get(socket.id);
        const srv = db.servers[serverId];
        if (!user || !srv || !srv.members[user.username]) return;
        if (!text?.trim() && !image) return;

        const ch = srv.channels.find((c) => c.id === channelId && c.type === "text");
        if (!ch) return;

        let safeReply = null;
        if (replyTo && replyTo.sender && (replyTo.text || replyTo.hasImage)) {
            safeReply = {
                id: String(replyTo.id || ""),
                sender: String(replyTo.sender).slice(0, 28),
                text: String(replyTo.text || "[Resim]").slice(0, 120)
            };
        }

        const topRole = getMemberTopRole(srv, user.username);
        const msg = {
            id: "m-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6),
            serverId,
            channelId,
            sender: user.username,
            displayName: user.displayName || user.username,
            avatar: user.avatar || "",
            color: user.color,
            topRole: topRole ? { name: topRole.name, color: topRole.color } : null,
            text: (text || "").trim().slice(0, 2000),
            image: typeof image === "string" && image.startsWith("data:image/") ? image : null,
            replyTo: safeReply,
            reactions: {},
            pinned: false,
            time: new Date().toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" })
        };

        if (!srv.messages[channelId]) srv.messages[channelId] = [];
        srv.messages[channelId].push(msg);
        if (srv.messages[channelId].length > 200) {
            const idx = srv.messages[channelId].findIndex((m) => !m.pinned);
            if (idx !== -1) srv.messages[channelId].splice(idx, 1);
        }

        db.meta.seededOnly = false;
        saveAndSyncDB();
        io.to("srv:" + serverId).emit("chat-message", msg);
    });

    socket.on("toggle-reaction", ({ serverId, channelId, msgId, emoji }) => {
        const user = activeUsers.get(socket.id);
        const srv = db.servers[serverId];
        if (!user || !srv || !srv.members[user.username] || !ALLOWED_REACTIONS.includes(emoji)) return;

        const msg = srv.messages[channelId]?.find((m) => m.id === msgId);
        if (!msg) return;

        if (!msg.reactions) msg.reactions = {};
        if (!msg.reactions[emoji]) msg.reactions[emoji] = [];
        const idx = msg.reactions[emoji].indexOf(user.username);
        if (idx === -1) msg.reactions[emoji].push(user.username);
        else msg.reactions[emoji].splice(idx, 1);
        if (msg.reactions[emoji].length === 0) delete msg.reactions[emoji];

        saveAndSyncDB();
        io.to("srv:" + serverId).emit("message-updated", { ...msg, serverId });
    });

    socket.on("toggle-pin", ({ serverId, channelId, msgId }) => {
        const user = activeUsers.get(socket.id);
        const srv = db.servers[serverId];
        if (!user || !srv || !hasPerm(srv, user.username, "pinMessages")) return;

        const msg = srv.messages[channelId]?.find((m) => m.id === msgId);
        if (!msg) return;

        msg.pinned = !msg.pinned;
        saveAndSyncDB();
        io.to("srv:" + serverId).emit("message-updated", { ...msg, serverId });
    });

    socket.on("delete-message", ({ serverId, channelId, msgId }) => {
        const user = activeUsers.get(socket.id);
        const srv = db.servers[serverId];
        if (!user || !srv || !srv.messages[channelId]) return;

        const target = srv.messages[channelId].find((m) => m.id === msgId);
        if (!target) return;

        const canDeleteOthers = hasPerm(srv, user.username, "deleteMessages");
        if (target.sender !== user.username) {
            if (!canDeleteOthers) return;
            if (srv.members[target.sender] && !canActOnMember(srv, user.username, target.sender)) return;
        }

        srv.messages[channelId] = srv.messages[channelId].filter((m) => m.id !== msgId);
        saveAndSyncDB();
        io.to("srv:" + serverId).emit("message-deleted", { serverId, channelId, msgId });
    });

    socket.on("typing", ({ serverId, channelId, isTyping }) => {
        const user = activeUsers.get(socket.id);
        const srv = db.servers[serverId];
        if (!user || !srv || !srv.members[user.username]) return;
        socket.to("srv:" + serverId).emit("user-typing", {
            serverId,
            channelId,
            username: user.username,
            displayName: user.displayName || user.username,
            isTyping: Boolean(isTyping)
        });
    });

    // --- 1-1 FISILTI (DIRECT MESSAGES) ---
    socket.on("dm-list", (cb) => {
        const user = activeUsers.get(socket.id);
        if (!user) return cb?.([]);

        const conversations = [];
        for (const [key, msgs] of Object.entries(db.dms)) {
            const parts = key.split("::");
            if (parts.length !== 2 || !parts.includes(user.username)) continue;
            const other = parts[0] === user.username ? parts[1] : parts[0];
            const rec = db.users[other];
            if (!rec) continue;
            const lastMsg = msgs[msgs.length - 1] || null;
            let online = false;
            for (const au of activeUsers.values()) {
                if (au.username === other) { online = true; break; }
            }
            conversations.push({
                username: other,
                displayName: rec.displayName || other,
                color: rec.color || "#5865f2",
                avatar: rec.avatar || "",
                online,
                lastMessage: lastMsg ? (lastMsg.text || "[Görsel]") : "",
                lastTime: lastMsg?.time || "",
                updatedAt: lastMsg?.ts || 0
            });
        }

        conversations.sort((a, b) => b.updatedAt - a.updatedAt);
        cb?.(conversations);
    });

    socket.on("dm-history", ({ withUsername }, cb) => {
        const user = activeUsers.get(socket.id);
        if (!user || !withUsername || !db.users[withUsername]) return cb?.({ ok: false, messages: [] });
        const key = dmKey(user.username, withUsername);
        const other = db.users[withUsername];
        cb?.({
            ok: true,
            peer: {
                username: withUsername,
                displayName: other.displayName || withUsername,
                color: other.color || "#5865f2",
                avatar: other.avatar || ""
            },
            messages: db.dms[key] || []
        });
    });

    socket.on("dm-send", ({ toUsername, text, image }, cb) => {
        const user = activeUsers.get(socket.id);
        if (!user || !toUsername || toUsername === user.username || !db.users[toUsername]) {
            return cb?.({ ok: false, error: "Alıcı bulunamadı." });
        }
        if (!text?.trim() && !image) return cb?.({ ok: false });

        const key = dmKey(user.username, toUsername);
        const msg = {
            id: "dm-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6),
            from: user.username,
            fromDisplayName: user.displayName || user.username,
            fromColor: user.color,
            fromAvatar: user.avatar || "",
            to: toUsername,
            text: (text || "").trim().slice(0, 2000),
            image: typeof image === "string" && image.startsWith("data:image/") ? image : null,
            time: new Date().toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" }),
            ts: Date.now()
        };

        if (!db.dms[key]) db.dms[key] = [];
        db.dms[key].push(msg);
        if (db.dms[key].length > 100) db.dms[key].shift();

        db.meta.seededOnly = false;
        saveAndSyncDB();

        socket.emit("dm-message", msg);
        for (const [sid, au] of activeUsers.entries()) {
            if (au.username === toUsername) {
                io.to(sid).emit("dm-message", msg);
            }
        }
        cb?.({ ok: true, message: msg });
    });

    // --- SES & KAMERA KANALLARI (WEBRTC MESH) ---
    socket.on("join-voice", (payload, cb) => {
        const user = activeUsers.get(socket.id);
        if (!user) return cb?.([]);

        const serverId = typeof payload === "object" ? payload.serverId : user.activeServerId;
        const channelId = typeof payload === "object" ? payload.channelId : payload;
        const srv = db.servers[serverId];
        if (!srv || !srv.members[user.username]) return cb?.([]);

        const ch = srv.channels.find((c) => c.id === channelId && c.type === "voice");
        if (!ch) return cb?.([]);

        const prevServerId = user.voiceServerId;
        const prevChannelId = user.voiceChannel;

        if (prevServerId && prevChannelId) {
            io.to("srv:" + prevServerId).emit("user-left-voice", socket.id);
        }

        const peersInChannel = [];
        for (const [id, u] of activeUsers.entries()) {
            if (id !== socket.id && u.voiceServerId === serverId && u.voiceChannel === channelId) {
                peersInChannel.push(id);
            }
        }

        // Maksimum 10 kişi Mesh koruması (9 peer + kendisi = 10)
        if (peersInChannel.length >= 9) {
            return cb?.({ ok: false, error: "Bu ses kanalında maksimum 10 kişi sınırı dolu.", peers: [] });
        }

        user.voiceServerId = serverId;
        user.voiceChannel = channelId;
        user.camOn = false;
        user.camStreamId = null;
        user.screenSharing = false;
        user.screenStreamId = null;
        user.lastVoiceActivityAt = Date.now();

        if (prevServerId && prevServerId !== serverId) {
            broadcastServerState(prevServerId);
        }
        broadcastServerState(serverId);

        socket.to("srv:" + serverId).emit("voice-event", {
            type: "join",
            serverId,
            username: user.username,
            displayName: user.displayName || user.username,
            channelId
        });

        cb?.({
            ok: true,
            peers: peersInChannel,
            iceServers: getServerIceServers(srv),
            isAfkChannel: Boolean(ch.isAfk || srv.afkChannelId === channelId)
        });
    });

    socket.on("leave-voice", () => {
        const user = activeUsers.get(socket.id);
        if (!user || !user.voiceChannel) return;
        const oldSrv = user.voiceServerId;
        const oldCh = user.voiceChannel;
        user.voiceServerId = null;
        user.voiceChannel = null;
        user.camOn = false;
        user.camStreamId = null;
        user.screenSharing = false;
        user.screenStreamId = null;

        if (oldSrv) {
            io.to("srv:" + oldSrv).emit("user-left-voice", socket.id);
            socket.to("srv:" + oldSrv).emit("voice-event", {
                type: "leave",
                serverId: oldSrv,
                username: user.username,
                displayName: user.displayName || user.username,
                channelId: oldCh
            });
            broadcastServerState(oldSrv);
        }
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
        user.lastVoiceActivityAt = Date.now();
        if (user.voiceServerId) {
            broadcastServerState(user.voiceServerId);
        }
    });

    socket.on("voice-activity", () => {
        const user = activeUsers.get(socket.id);
        if (user) user.lastVoiceActivityAt = Date.now();
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
        if (!user) return;
        user.screenSharing = false;
        user.screenStreamId = null;
        if (user.voiceServerId) {
            socket.to("srv:" + user.voiceServerId).emit("screen-share-stopped", socket.id);
            broadcastServerState(user.voiceServerId);
        }
    });
    socket.on("cam-stopped", () => {
        const user = activeUsers.get(socket.id);
        if (!user) return;
        user.camOn = false;
        user.camStreamId = null;
        if (user.voiceServerId) {
            socket.to("srv:" + user.voiceServerId).emit("cam-stopped", socket.id);
            broadcastServerState(user.voiceServerId);
        }
    });

    // --- EKİP & OYUN ARAÇLARI (v4.5 PAKETİ) ---

    // 1. Oyun Hazır Kontrolü (Ready-Check)
    socket.on("ready-check-start", ({ serverId, title }, cb) => {
        const user = activeUsers.get(socket.id);
        const srv = db.servers[serverId];
        if (!user || !srv || !srv.members[user.username]) return cb?.({ ok: false });

        const rt = getRuntime(serverId);
        rt.readyCheck = {
            id: "rc-" + Date.now().toString(36),
            serverId,
            title: (title || "Maça hazır mısınız?").trim().slice(0, 60) || "Maça hazır mısınız?",
            initiator: user.username,
            initiatorName: user.displayName || user.username,
            createdAt: Date.now(),
            responses: {
                [user.username]: {
                    status: "ready",
                    displayName: user.displayName || user.username,
                    color: user.color
                }
            }
        };

        io.to("srv:" + serverId).emit("ready-check-update", { serverId, readyCheck: rt.readyCheck, isNew: true });
        cb?.({ ok: true, readyCheck: rt.readyCheck });
    });

    socket.on("ready-check-respond", ({ serverId, checkId, status }) => {
        const user = activeUsers.get(socket.id);
        const srv = db.servers[serverId];
        if (!user || !srv || !srv.members[user.username]) return;
        if (!["ready", "wait5", "no"].includes(status)) return;

        const rt = getRuntime(serverId);
        if (!rt.readyCheck || (checkId && rt.readyCheck.id !== checkId)) return;

        rt.readyCheck.responses[user.username] = {
            status,
            displayName: user.displayName || user.username,
            color: user.color
        };

        io.to("srv:" + serverId).emit("ready-check-update", { serverId, readyCheck: rt.readyCheck, isNew: false });
    });

    socket.on("ready-check-close", ({ serverId }) => {
        const user = activeUsers.get(socket.id);
        const srv = db.servers[serverId];
        if (!user || !srv || !srv.members[user.username]) return;

        const rt = getRuntime(serverId);
        if (!rt.readyCheck) return;
        if (rt.readyCheck.initiator !== user.username && !hasPerm(srv, user.username, "manageChannels")) return;

        rt.readyCheck = null;
        io.to("srv:" + serverId).emit("ready-check-update", { serverId, readyCheck: null, isNew: false });
    });

    // 2. Hızlı Anket (Quick Poll)
    socket.on("poll-create", ({ serverId, question, options }, cb) => {
        const user = activeUsers.get(socket.id);
        const srv = db.servers[serverId];
        if (!user || !srv || !srv.members[user.username]) return cb?.({ ok: false });

        const cleanQ = (question || "").trim().slice(0, 100);
        const cleanOpts = (Array.isArray(options) ? options : [])
            .map((o) => String(o || "").trim().slice(0, 48))
            .filter(Boolean)
            .slice(0, 6);

        if (!cleanQ || cleanOpts.length < 2) {
            return cb?.({ ok: false, error: "Soru ve en az 2 seçenek gerekli." });
        }

        const poll = {
            id: "poll-" + Date.now().toString(36),
            serverId,
            question: cleanQ,
            creator: user.username,
            creatorName: user.displayName || user.username,
            createdAt: Date.now(),
            closed: false,
            options: cleanOpts.map((label) => ({ label, votes: [] }))
        };

        if (!Array.isArray(srv.polls)) srv.polls = [];
        srv.polls.unshift(poll);
        if (srv.polls.length > 12) srv.polls.pop();

        db.meta.seededOnly = false;
        saveAndSyncDB();
        io.to("srv:" + serverId).emit("poll-update", { serverId, polls: srv.polls });
        cb?.({ ok: true, poll });
    });

    socket.on("poll-vote", ({ serverId, pollId, optionIndex }) => {
        const user = activeUsers.get(socket.id);
        const srv = db.servers[serverId];
        if (!user || !srv || !srv.members[user.username]) return;

        const poll = (srv.polls || []).find((p) => p.id === pollId);
        if (!poll || poll.closed) return;
        if (typeof optionIndex !== "number" || optionIndex < 0 || optionIndex >= poll.options.length) return;

        const alreadyInChosen = poll.options[optionIndex].votes.includes(user.username);
        for (const opt of poll.options) {
            opt.votes = opt.votes.filter((u) => u !== user.username);
        }
        if (!alreadyInChosen) {
            poll.options[optionIndex].votes.push(user.username);
        }

        saveAndSyncDB();
        io.to("srv:" + serverId).emit("poll-update", { serverId, polls: srv.polls });
    });

    socket.on("poll-close", ({ serverId, pollId }) => {
        const user = activeUsers.get(socket.id);
        const srv = db.servers[serverId];
        if (!user || !srv || !srv.members[user.username]) return;

        const poll = (srv.polls || []).find((p) => p.id === pollId);
        if (!poll) return;
        if (poll.creator !== user.username && !hasPerm(srv, user.username, "manageChannels")) return;

        poll.closed = true;
        saveAndSyncDB();
        io.to("srv:" + serverId).emit("poll-update", { serverId, polls: srv.polls });
    });

    // 3. Ortak İzleme (Watch Together — YouTube Senkron)
    socket.on("watch-start", ({ serverId, url, title }, cb) => {
        const user = activeUsers.get(socket.id);
        const srv = db.servers[serverId];
        if (!user || !srv || !srv.members[user.username]) return cb?.({ ok: false });

        const videoId = extractYouTubeId(url);
        if (!videoId) {
            return cb?.({ ok: false, error: "Geçerli bir YouTube linki veya video ID girin." });
        }

        const rt = getRuntime(serverId);
        rt.watch = {
            active: true,
            videoId,
            title: (title || "").trim().slice(0, 80),
            host: user.username,
            hostName: user.displayName || user.username,
            playing: true,
            currentTime: 0,
            updatedAt: Date.now()
        };

        io.to("srv:" + serverId).emit("watch-state", { serverId, watch: rt.watch });
        cb?.({ ok: true, watch: rt.watch });
    });

    socket.on("watch-sync", ({ serverId, action, currentTime }) => {
        const user = activeUsers.get(socket.id);
        const srv = db.servers[serverId];
        if (!user || !srv || !srv.members[user.username]) return;

        const rt = getRuntime(serverId);
        if (!rt.watch.active) return;

        const safeTime = Math.max(0, Number(currentTime) || 0);
        if (action === "play") rt.watch.playing = true;
        else if (action === "pause") rt.watch.playing = false;

        rt.watch.currentTime = safeTime;
        rt.watch.updatedAt = Date.now();
        rt.watch.lastActor = user.displayName || user.username;

        io.to("srv:" + serverId).emit("watch-state", { serverId, watch: rt.watch });
    });

    socket.on("watch-stop", ({ serverId }) => {
        const user = activeUsers.get(socket.id);
        const srv = db.servers[serverId];
        if (!user || !srv || !srv.members[user.username]) return;

        const rt = getRuntime(serverId);
        rt.watch = {
            active: false,
            videoId: null,
            title: "",
            host: null,
            playing: false,
            currentTime: 0,
            updatedAt: Date.now()
        };
        io.to("srv:" + serverId).emit("watch-state", { serverId, watch: rt.watch });
    });

    // 4. Özel Ekip Soundboard (Yalnızca aktif ses kanalındaki herkese gider)
    socket.on("soundboard-play", ({ soundId }) => {
        const user = activeUsers.get(socket.id);
        if (!user || !user.voiceServerId || !user.voiceChannel) return;
        if (user.serverMuted) return;

        const now = Date.now();
        const last = soundboardCooldown.get(socket.id) || 0;
        if (now - last < 1100) return;
        soundboardCooldown.set(socket.id, now);

        const cleanId = String(soundId || "").slice(0, 32);
        if (!cleanId) return;

        for (const [sid, au] of activeUsers.entries()) {
            if (au.voiceServerId === user.voiceServerId && au.voiceChannel === user.voiceChannel) {
                io.to(sid).emit("soundboard-play", {
                    soundId: cleanId,
                    sender: user.displayName || user.username,
                    color: user.color
                });
            }
        }
    });

    // 5. Ortak Taktik Çizim Tahtası (Normalize 0..1 Koordinatlı Canvas)
    socket.on("board-toggle", ({ serverId, active }) => {
        const user = activeUsers.get(socket.id);
        const srv = db.servers[serverId];
        if (!user || !srv || !srv.members[user.username]) return;
        const rt = getRuntime(serverId);
        rt.board.active = Boolean(active);
        io.to("srv:" + serverId).emit("board-state", { serverId, board: rt.board });
    });

    socket.on("board-stroke", ({ serverId, stroke }) => {
        const user = activeUsers.get(socket.id);
        const srv = db.servers[serverId];
        if (!user || !srv || !srv.members[user.username] || !stroke) return;
        if (!Array.isArray(stroke.points) || stroke.points.length < 2) return;

        const safePoints = stroke.points
            .slice(0, 300)
            .map((p) => [
                Math.max(0, Math.min(1, Number(p[0]) || 0)),
                Math.max(0, Math.min(1, Number(p[1]) || 0))
            ]);

        const cleanStroke = {
            id: "st-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 5),
            sender: user.username,
            tool: ["pen", "arrow", "line", "eraser"].includes(stroke.tool) ? stroke.tool : "pen",
            color: sanitizeColor(stroke.color, "#f0b232"),
            width: Math.max(1, Math.min(24, Number(stroke.width) || 3)),
            points: safePoints
        };

        const rt = getRuntime(serverId);
        rt.board.active = true;
        rt.board.strokes.push(cleanStroke);
        if (rt.board.strokes.length > 400) rt.board.strokes.shift();

        socket.to("srv:" + serverId).emit("board-stroke", { serverId, stroke: cleanStroke });
    });

    socket.on("board-undo", ({ serverId }) => {
        const user = activeUsers.get(socket.id);
        const srv = db.servers[serverId];
        if (!user || !srv || !srv.members[user.username]) return;
        const rt = getRuntime(serverId);
        for (let i = rt.board.strokes.length - 1; i >= 0; i--) {
            if (rt.board.strokes[i].sender === user.username || hasPerm(srv, user.username, "manageChannels")) {
                rt.board.strokes.splice(i, 1);
                break;
            }
        }
        io.to("srv:" + serverId).emit("board-state", { serverId, board: rt.board });
    });

    socket.on("board-clear", ({ serverId }) => {
        const user = activeUsers.get(socket.id);
        const srv = db.servers[serverId];
        if (!user || !srv || !srv.members[user.username]) return;
        const rt = getRuntime(serverId);
        rt.board.strokes = [];
        io.to("srv:" + serverId).emit("board-state", { serverId, board: rt.board });
    });

    // --- BAĞLANTI KOPMASI ---
    socket.on("disconnect", () => {
        const user = activeUsers.get(socket.id);
        soundboardCooldown.delete(socket.id);
        if (!user) return;

        const oldVoiceSrv = user.voiceServerId;
        const oldVoiceCh = user.voiceChannel;
        const uname = user.username;

        activeUsers.delete(socket.id);

        if (oldVoiceSrv && oldVoiceCh) {
            io.to("srv:" + oldVoiceSrv).emit("user-left-voice", socket.id);
            io.to("srv:" + oldVoiceSrv).emit("voice-event", {
                type: "leave",
                serverId: oldVoiceSrv,
                username: uname,
                displayName: user.displayName || uname,
                channelId: oldVoiceCh
            });
        }

        broadcastUserPresenceAcrossServers(uname);
    });
});

server.listen(PORT, () => {
    console.log(`BizimDiscord v${APP_VERSION} hazır: http://localhost:${PORT}`);
});