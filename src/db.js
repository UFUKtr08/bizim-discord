const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const ALLOWED_ORIGIN = (process.env.ALLOWED_ORIGIN || "").trim();
const DB_FILE = path.join(__dirname, "..", "data.json");
const SERVER_STARTED_AT = Date.now();
const APP_VERSION = "5.2.1";

const ENV_ADMIN_USER = (process.env.ADMIN_USER || "").trim().toLowerCase().replace(/[^a-z0-9._-]/g, "");
const ENV_ADMIN_PASS = (process.env.ADMIN_PASS || "").trim();
const ENV_DEFAULT_INVITE = (process.env.DEFAULT_INVITE_CODE || "").trim().toUpperCase();
const BACKUP_SECRET = (process.env.BACKUP_SECRET || "").trim();

// Opsiyonel Render Ortam Değişkeni TURN Desteği
const ENV_TURN_URL = (process.env.TURN_URL || "").trim();
const ENV_TURN_USER = (process.env.TURN_USER || "").trim();
const ENV_TURN_PASS = (process.env.TURN_PASS || "").trim();

// Opsiyonel Ücretsiz Özel GitHub Gist Bulut Kalıcılık Desteği
const GIST_ID = (process.env.GITHUB_GIST_ID || process.env.GIST_ID || "").trim();
const GITHUB_TOKEN = (process.env.GITHUB_TOKEN || process.env.GIST_TOKEN || "").trim();
const GIST_FILENAME = (process.env.GIST_FILENAME || "bizim_discord_db.json").trim();

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
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 gün

let ioRef = null;
function setIO(io) {
    ioRef = io;
}
function getIO() {
    return ioRef;
}

// =========================================================================
// RATE-LIMIT & KRİPTOGRAFİK YARDIMCILAR
// =========================================================================
const rateBuckets = new Map();

function getClientIp(socket) {
    const fwd = socket.handshake.headers["x-forwarded-for"];
    if (typeof fwd === "string" && fwd.length > 0) {
        return fwd.split(",")[0].trim().slice(0, 64);
    }
    return socket.handshake.address || "unknown";
}

function checkRateLimit(key, maxHits, windowMs) {
    const now = Date.now();
    const arr = rateBuckets.get(key) || [];
    const fresh = arr.filter((ts) => now - ts < windowMs);
    if (fresh.length >= maxHits) {
        rateBuckets.set(key, fresh);
        return false;
    }
    fresh.push(now);
    rateBuckets.set(key, fresh);
    return true;
}

setInterval(() => {
    const now = Date.now();
    for (const [k, arr] of rateBuckets.entries()) {
        const fresh = arr.filter((ts) => now - ts < 120000);
        if (fresh.length) rateBuckets.set(k, fresh);
        else rateBuckets.delete(k);
    }
}, 60000);

function hashSecret(secret, salt = crypto.randomBytes(16).toString("hex")) {
    const hash = crypto.scryptSync(String(secret), salt, 64).toString("hex");
    return { salt, hash };
}

function safeEqualHex(aHex, bHex) {
    if (!aHex || !bHex || typeof aHex !== "string" || typeof bHex !== "string") return false;
    if (aHex.length !== bHex.length) return false;
    try {
        return crypto.timingSafeEqual(Buffer.from(aHex, "hex"), Buffer.from(bHex, "hex"));
    } catch {
        return false;
    }
}

function generateRecoveryCode() {
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    const bytes = crypto.randomBytes(12);
    const parts = [];
    for (let g = 0; g < 3; g++) {
        let chunk = "";
        for (let i = 0; i < 4; i++) {
            chunk += alphabet[bytes[g * 4 + i] % alphabet.length];
        }
        parts.push(chunk);
    }
    return parts.join("-");
}

function normalizeRecoveryCodeInput(raw) {
    return String(raw || "")
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, "");
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

function isSafeRasterDataUrl(str, maxChars = 1800000) {
    if (typeof str !== "string" || str.length === 0 || str.length > maxChars) return false;
    return /^data:image\/(png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/=]+$/i.test(str);
}

function sanitizeAvatar(avatar) {
    if (typeof avatar !== "string") return "";
    if (!isSafeRasterDataUrl(avatar, 260000)) return "";
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
            if (Array.isArray(arr)) msgs[cid] = arr.slice(-200);
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
            url: String(turnServer?.url || "").trim().slice(0, 200),
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
// VERİTABANI OLUŞTURMA, v4->v5 MİGRASYON, YETİM ÜYE ONARIMI & BİRLEŞTİRME
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
        const { salt, hash } = hashSecret(ENV_ADMIN_PASS);
        base.users[ENV_ADMIN_USER] = {
            salt,
            hash,
            recoverySalt: null,
            recoveryHash: null,
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
    const rawUsers = raw?.users && typeof raw.users === "object" ? raw.users : {};
    const rawSessions = raw?.sessions && typeof raw.sessions === "object" ? raw.sessions : {};

    const users = {};
    let primaryOwner = ENV_ADMIN_USER || null;

    for (const [uname, u] of Object.entries(rawUsers)) {
        if (!u || !u.salt || !u.hash) continue;
        const cleanUname = String(uname).trim().toLowerCase();
        if (!cleanUname) continue;
        const isOldAdmin = u.role === "admin";
        if (isOldAdmin && !primaryOwner) primaryOwner = cleanUname;
        users[cleanUname] = {
            salt: u.salt,
            hash: u.hash,
            recoverySalt: u.recoverySalt || null,
            recoveryHash: u.recoveryHash || null,
            role: isOldAdmin ? "admin" : "user",
            isGlobalAdmin: isOldAdmin,
            displayName: typeof u.displayName === "string" && u.displayName.trim() ? u.displayName.trim().slice(0, 28) : cleanUname,
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
        for (const [rawUname, m] of Object.entries(rawSrv.members)) {
            const uname = String(rawUname).trim().toLowerCase();
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

    if (base.ownerId) base.ownerId = String(base.ownerId).trim().toLowerCase();
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
        const { salt, hash } = hashSecret(ENV_ADMIN_PASS);
        dbObj.users[ENV_ADMIN_USER] = {
            salt,
            hash,
            recoverySalt: null,
            recoveryHash: null,
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

    // Hiçbir sunucuya bağlı görünmeyen kayıtlı kullanıcıları (örn. hako) otomatik varsayılan sunucuya bağla
    const allServers = Object.values(dbObj.servers);
    const defaultMemberRole = defSrv.roles[defSrv.roles.length - 1]?.id || "role-member";
    const adminRole = defSrv.roles[0]?.id || defaultMemberRole;
    for (const [uname, uRec] of Object.entries(dbObj.users)) {
        const inAnyServer = allServers.some((s) => Boolean(s.members && s.members[uname]));
        if (!inAnyServer) {
            defSrv.members[uname] = {
                roleIds: [uRec?.isGlobalAdmin ? adminRole : defaultMemberRole],
                joinedAt: Date.now()
            };
        }
    }

    return dbObj;
}

function normalizeSessionEntry(entry, validUsers) {
    const now = Date.now();
    if (typeof entry === "string") {
        const u = entry.trim().toLowerCase();
        if (!validUsers[u]) return null;
        return { username: u, expiresAt: now + SESSION_TTL_MS };
    }
    if (entry && typeof entry === "object" && entry.username) {
        const u = String(entry.username).trim().toLowerCase();
        if (!validUsers[u]) return null;
        const exp = Number(entry.expiresAt) || (now + SESSION_TTL_MS);
        if (exp <= now) return null;
        return { username: u, expiresAt: exp };
    }
    return null;
}

function normalizeDB(raw) {
    if (!raw || typeof raw !== "object") return createDefaultDB();

    const isV4 = !raw.servers && (Array.isArray(raw.channels) || raw.settings || raw.users);
    if (isV4 && Number(raw.version || 4) < 5) {
        return migrateV4ToV5(raw);
    }

    const users = {};
    if (raw.users && typeof raw.users === "object") {
        for (const [rawUname, u] of Object.entries(raw.users)) {
            if (!u || !u.salt || !u.hash) continue;
            const uname = String(rawUname).trim().toLowerCase();
            if (!uname) continue;
            const isGlobal = Boolean(u.isGlobalAdmin || u.role === "admin");
            users[uname] = {
                salt: u.salt,
                hash: u.hash,
                recoverySalt: u.recoverySalt || null,
                recoveryHash: u.recoveryHash || null,
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
        for (const [tok, entry] of Object.entries(raw.sessions)) {
            const norm = normalizeSessionEntry(entry, users);
            if (norm) sessions[tok] = norm;
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

function getDBSummary(dbObj) {
    if (!dbObj || typeof dbObj !== "object") {
        return { users: 0, servers: 0, messages: 0, seededOnly: true };
    }
    const users = Object.keys(dbObj.users || {}).length;
    const servers = Object.keys(dbObj.servers || {}).length;
    let messages = 0;
    for (const srv of Object.values(dbObj.servers || {})) {
        for (const arr of Object.values(srv?.messages || {})) {
            if (Array.isArray(arr)) messages += arr.length;
        }
    }
    return {
        users,
        servers,
        messages,
        seededOnly: Boolean(dbObj.meta?.seededOnly)
    };
}

// Yedek geri yüklenirken sunucuda arada oluşmuş yeni kullanıcıları, oturumları ve mesajları kaybetmeden birleştirir
function mergeOrRestoreDB(incomingRaw) {
    const prevDB = db;
    const nextDB = normalizeDB(incomingRaw);

    if (prevDB && prevDB.users) {
        const defSrv = nextDB.servers[nextDB.globalSettings.defaultServerId] || Object.values(nextDB.servers)[0];
        const fallbackRole = defSrv?.roles?.[defSrv.roles.length - 1]?.id || "role-member";

        for (const [uname, uRec] of Object.entries(prevDB.users)) {
            if (!nextDB.users[uname] && uRec?.salt && uRec?.hash) {
                nextDB.users[uname] = { ...uRec };
                if (defSrv && !defSrv.members[uname]) {
                    defSrv.members[uname] = { roleIds: [fallbackRole], joinedAt: Date.now() };
                }
            }
        }

        for (const [tok, sEntry] of Object.entries(prevDB.sessions || {})) {
            if (!nextDB.sessions[tok] && nextDB.users[sEntry?.username]) {
                nextDB.sessions[tok] = sEntry;
            }
        }

        for (const [srvId, prevSrv] of Object.entries(prevDB.servers || {})) {
            const targetSrv = nextDB.servers[srvId];
            if (!targetSrv) continue;
            for (const [chId, prevMsgs] of Object.entries(prevSrv.messages || {})) {
                if (!Array.isArray(prevMsgs) || !prevMsgs.length) continue;
                if (!Array.isArray(targetSrv.messages[chId])) targetSrv.messages[chId] = [];
                const existingIds = new Set(targetSrv.messages[chId].map((m) => m.id));
                for (const m of prevMsgs) {
                    if (m?.id && !existingIds.has(m.id)) {
                        targetSrv.messages[chId].push(m);
                        existingIds.add(m.id);
                    }
                }
                if (targetSrv.messages[chId].length > 200) {
                    targetSrv.messages[chId] = targetSrv.messages[chId].slice(-200);
                }
            }
        }

        for (const [key, prevDms] of Object.entries(prevDB.dms || {})) {
            if (!Array.isArray(prevDms) || !prevDms.length) continue;
            if (!Array.isArray(nextDB.dms[key])) nextDB.dms[key] = [];
            const existingIds = new Set(nextDB.dms[key].map((m) => m.id));
            for (const m of prevDms) {
                if (m?.id && !existingIds.has(m.id)) {
                    nextDB.dms[key].push(m);
                    existingIds.add(m.id);
                }
            }
            if (nextDB.dms[key].length > 100) {
                nextDB.dms[key] = nextDB.dms[key].slice(-100);
            }
        }
    }

    nextDB.meta.seededOnly = false;
    return ensureEnvAdminAndIntegrity(nextDB);
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

function getDB() {
    return db;
}

function setDB(nextDb) {
    db = nextDb;
    return db;
}

// =========================================================================
// ÜCRETSİZ ÖZEL GITHUB GIST BULUT KALICILIK MOTORU (OPSİYONEL)
// =========================================================================
let cloudPushTimer = null;
let cloudPushInFlight = false;
let cloudPushPending = false;
let cloudReady = false;

function isCloudEnabled() {
    return Boolean(GIST_ID && GITHUB_TOKEN);
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

async function initCloudDB() {
    if (!isCloudEnabled()) {
        cloudReady = false;
        return db;
    }

    try {
        const res = await fetchWithTimeout(`https://api.github.com/gists/${encodeURIComponent(GIST_ID)}`, {
            headers: {
                Authorization: `Bearer ${GITHUB_TOKEN}`,
                Accept: "application/vnd.github+json",
                "User-Agent": "BizimDiscord-Server"
            }
        }, 9000);

        if (!res.ok) {
            console.error(`[CloudDB] Gist okunamadı (HTTP ${res.status})`);
            cloudReady = true;
            return db;
        }

        const gist = await res.json();
        const files = gist?.files || {};
        const fileObj = files[GIST_FILENAME] || Object.values(files).find((f) => f && f.filename?.endsWith(".json"));
        let rawText = fileObj?.content || "";

        if (fileObj?.truncated && fileObj?.raw_url) {
            const rawRes = await fetchWithTimeout(fileObj.raw_url, {
                headers: {
                    Authorization: `Bearer ${GITHUB_TOKEN}`,
                    "User-Agent": "BizimDiscord-Server"
                }
            }, 9000);
            if (rawRes.ok) rawText = await rawRes.text();
        }

        if (rawText && rawText.trim().startsWith("{")) {
            const parsed = JSON.parse(rawText);
            if (parsed && parsed.users && Object.keys(parsed.users).length > 0) {
                const cloudDB = normalizeDB(parsed);
                cloudDB.meta.seededOnly = false;
                db = cloudDB;
                await fs.promises.writeFile(DB_FILE, JSON.stringify(db, null, 2), "utf8");
                console.log(`[CloudDB] GitHub Gist'ten yüklendi (${Object.keys(db.users).length} kullanıcı, ${Object.keys(db.servers).length} sunucu).`);
            } else {
                console.log("[CloudDB] Gist henüz boş; ilk gerçek kayıtta senkronize edilecek.");
            }
        }
        cloudReady = true;
    } catch (err) {
        console.error("[CloudDB] Başlangıç yükleme hatası:", err.message);
        cloudReady = true;
    }

    return db;
}

async function pushCloudDBNow() {
    if (!isCloudEnabled() || !cloudReady) return;
    const sum = getDBSummary(db);
    // Boş/sıfırlanmış varsayılan DB asla bulut yedeğinin üzerine yazılmaz
    if (sum.seededOnly && sum.users <= 1 && sum.messages === 0) return;

    if (cloudPushInFlight) {
        cloudPushPending = true;
        return;
    }

    cloudPushInFlight = true;
    try {
        const res = await fetchWithTimeout(`https://api.github.com/gists/${encodeURIComponent(GIST_ID)}`, {
            method: "PATCH",
            headers: {
                Authorization: `Bearer ${GITHUB_TOKEN}`,
                Accept: "application/vnd.github+json",
                "Content-Type": "application/json",
                "User-Agent": "BizimDiscord-Server"
            },
            body: JSON.stringify({
                files: {
                    [GIST_FILENAME]: {
                        content: JSON.stringify(db, null, 2)
                    }
                }
            })
        }, 10000);

        if (!res.ok) {
            console.error(`[CloudDB] Gist yazma hatası (HTTP ${res.status})`);
        }
    } catch (err) {
        console.error("[CloudDB] Gist yazma hatası:", err.message);
    } finally {
        cloudPushInFlight = false;
        if (cloudPushPending) {
            cloudPushPending = false;
            scheduleCloudPush(4000);
        }
    }
}

function scheduleCloudPush(delayMs = 4000) {
    if (!isCloudEnabled() || !cloudReady) return;
    if (cloudPushTimer) clearTimeout(cloudPushTimer);
    cloudPushTimer = setTimeout(() => {
        cloudPushTimer = null;
        pushCloudDBNow();
    }, delayMs);
}

// =========================================================================
// ASENKRON + DEBOUNCED DB YAZIMI & GLOBAL ADMIN SENKRONİZASYONU
// =========================================================================
let saveTimer = null;
let saveInFlight = false;
let saveQueuedAgain = false;

const activeUsers = new Map();
const serverRuntime = new Map();
const soundboardCooldown = new Map();
let lastCpuSample = process.cpuUsage();
let lastCpuSampleTime = Date.now();

function emitDbSyncToGlobalAdmins() {
    if (!ioRef) return;
    if (db.meta?.seededOnly) return;
    for (const [sid, au] of activeUsers.entries()) {
        if (db.users[au.username]?.isGlobalAdmin) {
            ioRef.to(sid).emit("db-sync", db);
        }
    }
}

async function flushDBToDiskNow() {
    if (saveInFlight) {
        saveQueuedAgain = true;
        return;
    }
    saveInFlight = true;
    try {
        const serialized = JSON.stringify(db, null, 2);
        const tmpFile = DB_FILE + ".tmp";
        await fs.promises.writeFile(tmpFile, serialized, "utf8");
        try {
            await fs.promises.rename(tmpFile, DB_FILE);
        } catch {
            await fs.promises.writeFile(DB_FILE, serialized, "utf8");
        }
    } catch (err) {
        console.error("[DB Async Save Error]", err.message);
    } finally {
        saveInFlight = false;
        if (saveQueuedAgain) {
            saveQueuedAgain = false;
            flushDBToDiskNow();
        }
    }
}

function saveAndSyncDB({ immediateDisk = false } = {}) {
    emitDbSyncToGlobalAdmins();
    scheduleCloudPush(immediateDisk ? 1200 : 4000);
    if (immediateDisk) {
        if (saveTimer) {
            clearTimeout(saveTimer);
            saveTimer = null;
        }
        flushDBToDiskNow();
        return;
    }
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        saveTimer = null;
        flushDBToDiskNow();
    }, 900);
}

// =========================================================================
// ÇALIŞMA DURUMU, ICE/TURN, YETKİ HİYERARŞİSİ & TELEMETRİ
// =========================================================================
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

function parseTurnEntry(urlStr, username, credential) {
    const urls = String(urlStr || "")
        .split(",")
        .map((u) => u.trim())
        .filter(Boolean);
    if (!urls.length) return null;
    const entry = { urls: urls.length === 1 ? urls[0] : urls };
    if (username && String(username).trim()) entry.username = String(username).trim();
    if (credential && String(credential).trim()) entry.credential = String(credential).trim();
    return entry;
}

function getServerIceServers(srv) {
    const list = [...DEFAULT_ICE];
    const srvTurn = parseTurnEntry(
        srv?.turnServer?.url,
        srv?.turnServer?.username,
        srv?.turnServer?.credential
    );
    if (srvTurn) list.push(srvTurn);

    const envTurn = parseTurnEntry(ENV_TURN_URL, ENV_TURN_USER, ENV_TURN_PASS);
    if (envTurn) {
        const srvKey = srvTurn ? JSON.stringify(srvTurn.urls) : "";
        const envKey = JSON.stringify(envTurn.urls);
        if (envKey !== srvKey) list.push(envTurn);
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

function inSameVoiceChannel(sidA, sidB) {
    const a = activeUsers.get(sidA);
    const b = activeUsers.get(sidB);
    return Boolean(
        a &&
        b &&
        a.voiceServerId &&
        a.voiceServerId === b.voiceServerId &&
        a.voiceChannel &&
        a.voiceChannel === b.voiceChannel
    );
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

    list.sort((a, b) => {
        if (a.online !== b.online) return a.online ? -1 : 1;
        if (a.power !== b.power) return b.power - a.power;
        return a.username.localeCompare(b.username, "tr");
    });

    return list;
}

function buildServerPublicSettings(srv, includePrivate = false) {
    const hasSrvTurn = Boolean(srv.turnServer?.url && srv.turnServer.url.trim());
    const hasEnvTurn = Boolean(ENV_TURN_URL);
    const base = {
        id: srv.id,
        name: srv.name,
        icon: srv.icon || "",
        inviteCode: srv.inviteCode,
        ownerId: srv.ownerId,
        afkChannelId: srv.afkChannelId || null,
        afkTimeoutSec: srv.afkTimeoutSec ?? 300,
        iceServers: getServerIceServers(srv),
        hasTurnConfigured: hasSrvTurn || hasEnvTurn,
        hasEnvTurn,
        cloudSyncEnabled: isCloudEnabled()
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

function broadcastServerState(serverId) {
    if (!ioRef) return;
    const srv = db.servers[serverId];
    if (!srv) return;

    const membersPayload = buildServerMembersPayload(srv);
    const room = ioRef.sockets.adapter.rooms.get("srv:" + serverId);
    if (!room) return;

    for (const sid of room) {
        const au = activeUsers.get(sid);
        if (!au || !srv.members[au.username]) continue;
        const perms = getMemberPermissions(srv, au.username);
        const canManage = Boolean(perms.administrator || perms.manageServer);
        const power = getMemberPower(srv, au.username);

        ioRef.to(sid).emit("server-state-update", {
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
    if (!ioRef) return;
    for (const [sid, au] of activeUsers.entries()) {
        if (au.username === username) {
            ioRef.to(sid).emit("my-servers-update", getUserServersList(username));
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

function computeDynamicLoadSnapshot() {
    const mem = process.memoryUsage();
    const now = Date.now();
    const cpuDelta = process.cpuUsage(lastCpuSample);
    const elapsedUs = Math.max(1000, (now - lastCpuSampleTime) * 1000);
    lastCpuSample = process.cpuUsage();
    lastCpuSampleTime = now;

    const processCpuPct = Math.min(100, Math.round(((cpuDelta.user + cpuDelta.system) / elapsedUs) * 100));

    const roomCounts = new Map();
    let inVoice = 0;
    let camCount = 0;
    let screenCount = 0;

    for (const u of activeUsers.values()) {
        if (u.voiceChannel) {
            inVoice++;
            const key = `${u.voiceServerId}:${u.voiceChannel}`;
            roomCounts.set(key, (roomCounts.get(key) || 0) + 1);
        }
        if (u.camOn) camCount++;
        if (u.screenSharing) screenCount++;
    }

    let maxRoomVoice = 0;
    let totalMeshLinks = 0;
    for (const cnt of roomCounts.values()) {
        if (cnt > maxRoomVoice) maxRoomVoice = cnt;
        if (cnt > 1) totalMeshLinks += cnt * (cnt - 1);
    }

    const rssMB = Math.round(mem.rss / 1024 / 1024);
    const renderFreeRamCapMB = 512;
    const ramPct = Math.min(100, Math.round((rssMB / renderFreeRamCapMB) * 100));

    let dbSizeKB = 0;
    try {
        dbSizeKB = Math.round(fs.statSync(DB_FILE).size / 1024);
    } catch {
        dbSizeKB = Math.round(Buffer.byteLength(JSON.stringify(db), "utf8") / 1024);
    }

    const meshPressure = Math.min(45, Math.round((maxRoomVoice / 14) * 35 + (camCount + screenCount) * 4));
    const ramPressure = Math.min(40, Math.round((ramPct / 100) * 40));
    const cpuPressure = Math.min(25, Math.round(processCpuPct * 0.25));
    const strainScore = Math.min(100, meshPressure + ramPressure + cpuPressure);

    let level = "Rahat";
    let recommendation = "Mevcut ücretsiz Render + Mesh yapısı bu yük için yeterli. Ek masrafa gerek yok.";

    if (strainScore >= 75 || ramPct >= 82 || maxRoomVoice >= 11) {
        level = "Kritik (Yükseltme Zamanı)";
        recommendation = "Tek odada 11+ kişi veya %80+ RAM baskısı var. Ücretsiz/düşük maliyetli bir VPS (2 vCPU / 4 GB RAM) + LiveKit SFU ve PostgreSQL'e geçiş önerilir.";
    } else if (strainScore >= 45 || ramPct >= 60 || maxRoomVoice >= 7) {
        level = "Orta (Dikkat)";
        recommendation = "Kamera/ekran paylaşımı artarsa upload veya RAM sınırına yaklaşılır. 360p/480p kamera, 720p30 ekran paylaşımı ve kalıcı bulut yedeği kullan.";
    }

    return {
        ok: true,
        version: APP_VERSION,
        time: now,
        uptimeSec: Math.floor((now - SERVER_STARTED_AT) / 1000),
        memRssMB: rssMB,
        memHeapMB: Math.round(mem.heapUsed / 1024 / 1024),
        renderFreeRamCapMB,
        ramPct,
        processCpuPct,
        dbSizeKB,
        onlineUsers: activeUsers.size,
        inVoice,
        maxRoomVoice,
        totalMeshLinks,
        camCount,
        screenCount,
        registeredUsers: Object.keys(db.users).length,
        serverCount: Object.keys(db.servers).length,
        hasEnvTurn: Boolean(ENV_TURN_URL),
        cloudSyncEnabled: isCloudEnabled(),
        strainScore,
        level,
        recommendation
    };
}

module.exports = {
    PORT,
    ALLOWED_ORIGIN,
    DB_FILE,
    APP_VERSION,
    BACKUP_SECRET,
    PERMISSION_KEYS,
    ALLOWED_REACTIONS,
    USER_PALETTE,
    SESSION_TTL_MS,
    setIO,
    getIO,
    getDB,
    setDB,
    initCloudDB,
    isCloudEnabled,
    saveAndSyncDB,
    activeUsers,
    serverRuntime,
    soundboardCooldown,
    getClientIp,
    checkRateLimit,
    hashSecret,
    safeEqualHex,
    generateRecoveryCode,
    normalizeRecoveryCodeInput,
    generateInviteCode,
    sanitizeColor,
    isSafeRasterDataUrl,
    sanitizeAvatar,
    sanitizePermissions,
    createServerObject,
    dmKey,
    extractYouTubeId,
    normalizeSessionEntry,
    normalizeDB,
    getDBSummary,
    mergeOrRestoreDB,
    getRuntime,
    getServerIceServers,
    getMemberRoles,
    getMemberPower,
    getMemberTopRole,
    getMemberPermissions,
    hasPerm,
    canActOnMember,
    canManageRolePriority,
    isGlobalAdminSocket,
    inSameVoiceChannel,
    getUserServersList,
    buildServerMembersPayload,
    buildServerPublicSettings,
    buildServerSnapshot,
    broadcastServerState,
    broadcastAllUserServers,
    broadcastUserPresenceAcrossServers,
    computeDynamicLoadSnapshot
};