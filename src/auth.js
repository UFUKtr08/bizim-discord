const crypto = require("crypto");
const {
    APP_VERSION,
    BACKUP_SECRET,
    USER_PALETTE,
    SESSION_TTL_MS,
    getDB,
    setDB,
    saveAndSyncDB,
    activeUsers,
    getClientIp,
    checkRateLimit,
    hashSecret,
    safeEqualHex,
    generateRecoveryCode,
    normalizeRecoveryCodeInput,
    sanitizeAvatar,
    normalizeSessionEntry,
    getDBSummary,
    mergeOrRestoreDB,
    isGlobalAdminSocket,
    getUserServersList,
    buildServerSnapshot,
    broadcastServerState,
    broadcastUserPresenceAcrossServers
} = require("./db");

function completeUserSession(io, socket, username, record, tokenToReturn) {
    const db = getDB();

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

    for (const s of userServers) {
        socket.join("srv:" + s.id);
    }

    // Boş/sıfırlanmış (seededOnly) DB asla yerel yedeğin üzerine senkronize edilmez
    if (record.isGlobalAdmin && !db.meta?.seededOnly) {
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
            status: record.status || "Çevrimiçi",
            hasRecoveryCode: Boolean(record.recoveryHash && record.recoverySalt)
        },
        servers: userServers,
        activeServerId: initialServerId,
        snapshot: activeSrv ? buildServerSnapshot(activeSrv, username) : null
    };
}

function registerAuthHandlers(io, socket) {
    // --- YEREL MASTER VERİTABANI SENKRONİZASYONU & RENDER SIFIRLANMA KORUMASI ---
    socket.on("check-db-needs-restore", (clientMeta, cb) => {
        const callback = typeof clientMeta === "function" ? clientMeta : cb;
        const meta = typeof clientMeta === "object" && clientMeta ? clientMeta : {};
        const db = getDB();
        const srvSum = getDBSummary(db);

        const localUsers = Number(meta.localUsers) || 0;
        const localMessages = Number(meta.localMessages) || 0;

        const serverEmptyOrSeeded = srvSum.users === 0 || srvSum.seededOnly;
        const localIsRicher =
            localUsers > srvSum.users ||
            (localMessages > srvSum.messages && localUsers >= srvSum.users);

        const needs = serverEmptyOrSeeded || localIsRicher;
        if (typeof callback === "function") {
            callback({
                needsRestore: needs,
                requiresSecret: Boolean(needs && BACKUP_SECRET && !isGlobalAdminSocket(socket)),
                serverSummary: srvSum
            });
        }
    });

    socket.on("restore-db", (payload, cb) => {
        if (!checkRateLimit("restore:" + getClientIp(socket), 5, 60000)) {
            return cb?.({ ok: false, error: "Çok fazla geri yükleme denemesi. Bekleyin." });
        }

        const incomingDB = payload && payload.db ? payload.db : payload;
        const providedSecret = String(payload?.backupSecret || incomingDB?._backupSecret || "").trim();
        const sessionToken = String(payload?.sessionToken || "").trim();

        if (!incomingDB || typeof incomingDB !== "object" || !incomingDB.users) {
            return cb?.({ ok: false, error: "Geçersiz veritabanı dosyası." });
        }

        const currentDB = getDB();
        const srvSum = getDBSummary(currentDB);
        const serverNeedsRestore = srvSum.users === 0 || srvSum.seededOnly;

        const hasAdminInBackup = Object.values(incomingDB.users).some(
            (u) => u && (u.role === "admin" || u.isGlobalAdmin)
        );
        if (!hasAdminInBackup) {
            return cb?.({ ok: false, error: "Yedek dosyasında yönetici hesabı bulunamadı." });
        }

        let validAdminTokenInBackup = false;
        if (sessionToken && incomingDB.sessions && incomingDB.sessions[sessionToken]) {
            const normTok = normalizeSessionEntry(incomingDB.sessions[sessionToken], incomingDB.users);
            if (
                normTok &&
                (incomingDB.users[normTok.username]?.isGlobalAdmin || incomingDB.users[normTok.username]?.role === "admin")
            ) {
                validAdminTokenInBackup = true;
            }
        }

        const isAuthorizedAdmin = isGlobalAdminSocket(socket) || validAdminTokenInBackup;

        if (!serverNeedsRestore && !isAuthorizedAdmin) {
            return cb?.({ ok: false, error: "Dolu sunucuya geri yükleme için Genel Yönetici yetkisi gerekli." });
        }

        if (serverNeedsRestore && BACKUP_SECRET && providedSecret !== BACKUP_SECRET && !isAuthorizedAdmin) {
            return cb?.({ ok: false, error: "Boş sunucuya geri yükleme için BACKUP_SECRET veya yönetici oturumu gerekli." });
        }

        const wasV4 = !incomingDB.servers;
        const nextDB = mergeOrRestoreDB(incomingDB);
        setDB(nextDB);
        saveAndSyncDB({ immediateDisk: true });

        const newDefSrv = nextDB.servers[nextDB.globalSettings.defaultServerId] || Object.values(nextDB.servers)[0];
        io.emit("server-info", {
            version: APP_VERSION,
            serverName: newDefSrv?.name || "BizimDiscord",
            hasInviteCode: Boolean(nextDB.globalSettings.requireInviteToRegister),
            isFirstSetup: false
        });

        // Bağlı tüm kullanıcıların sunucu odalarını, sunucu listelerini ve aktif snapshot'larını anında yenile
        for (const [sid, au] of activeUsers.entries()) {
            const targetSock = io.sockets.sockets.get(sid);
            if (!targetSock) continue;
            const userServers = getUserServersList(au.username);
            for (const s of userServers) {
                targetSock.join("srv:" + s.id);
            }
            if (!au.activeServerId || !nextDB.servers[au.activeServerId]) {
                au.activeServerId = userServers[0]?.id || null;
            }
            io.to(sid).emit("my-servers-update", userServers);
            if (au.activeServerId && nextDB.servers[au.activeServerId]) {
                io.to(sid).emit("server-snapshot-refresh", buildServerSnapshot(nextDB.servers[au.activeServerId], au.username));
            }
        }

        for (const srvId of Object.keys(nextDB.servers)) {
            broadcastServerState(srvId);
        }

        cb?.({ ok: true, migratedFromV4: wasV4, userCount: Object.keys(nextDB.users).length });
    });

    // --- KİMLİK DOĞRULAMA & KİŞİSEL KURTARMA KODU ---
    socket.on("register", ({ username, password, inviteCode }, cb) => {
        if (!checkRateLimit("reg:" + getClientIp(socket), 5, 300000)) {
            return cb?.({ ok: false, error: "Çok fazla kayıt denemesi. Lütfen birkaç dakika sonra tekrar deneyin." });
        }

        const db = getDB();
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
        const { salt, hash } = hashSecret(password);

        const recoveryCode = generateRecoveryCode();
        const recHashObj = hashSecret(normalizeRecoveryCodeInput(recoveryCode));

        db.users[clean] = {
            salt,
            hash,
            recoverySalt: recHashObj.salt,
            recoveryHash: recHashObj.hash,
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
        saveAndSyncDB({ immediateDisk: true });
        if (targetServer) broadcastServerState(targetServer.id);
        cb?.({ ok: true, role: db.users[clean].role, recoveryCode });
    });

    socket.on("login", ({ username, password, remember }, cb) => {
        if (!checkRateLimit("login:" + getClientIp(socket), 8, 60000)) {
            return cb?.({ ok: false, error: "Çok fazla giriş denemesi. 1 dakika bekleyin." });
        }

        const db = getDB();
        const clean = (username || "").trim().toLowerCase();
        const record = db.users[clean];
        if (!record) return cb?.({ ok: false, error: "Kullanıcı adı veya şifre hatalı." });

        const { hash } = hashSecret(password, record.salt);
        if (!safeEqualHex(hash, record.hash)) {
            return cb?.({ ok: false, error: "Kullanıcı adı veya şifre hatalı." });
        }

        let token = null;
        if (remember) {
            token = crypto.randomBytes(24).toString("hex");
            db.sessions[token] = {
                username: clean,
                expiresAt: Date.now() + SESSION_TTL_MS
            };
            saveAndSyncDB();
        }

        cb?.(completeUserSession(io, socket, clean, record, token));
    });

    socket.on("login-token", (token, cb) => {
        const db = getDB();
        const entry = token && db.sessions[token];
        const norm = normalizeSessionEntry(entry, db.users);
        if (!norm) {
            if (token && db.sessions[token]) {
                delete db.sessions[token];
                saveAndSyncDB();
            }
            return cb?.({ ok: false });
        }
        const record = db.users[norm.username];
        cb?.(completeUserSession(io, socket, norm.username, record, token));
    });

    socket.on("logout", (token) => {
        const db = getDB();
        if (token && db.sessions[token]) {
            delete db.sessions[token];
            saveAndSyncDB();
        }
    });

    socket.on("reset-password-recovery", ({ username, recoveryCode, newPassword }, cb) => {
        if (!checkRateLimit("recover:" + getClientIp(socket), 5, 300000)) {
            return cb?.({ ok: false, error: "Çok fazla kurtarma denemesi. 5 dakika bekleyin." });
        }

        const db = getDB();
        const clean = (username || "").trim().toLowerCase();
        const cleanRec = normalizeRecoveryCodeInput(recoveryCode);
        const record = db.users[clean];

        if (!record || !record.recoveryHash || !record.recoverySalt || !cleanRec) {
            return cb?.({ ok: false, error: "Kullanıcı adı veya kişisel kurtarma kodu hatalı." });
        }
        if (!newPassword || newPassword.length < 4) {
            return cb?.({ ok: false, error: "Yeni şifre en az 4 karakter olmalı." });
        }

        const { hash: checkRecHash } = hashSecret(cleanRec, record.recoverySalt);
        if (!safeEqualHex(checkRecHash, record.recoveryHash)) {
            return cb?.({ ok: false, error: "Kullanıcı adı veya kişisel kurtarma kodu hatalı." });
        }

        const nextPass = hashSecret(newPassword);
        record.salt = nextPass.salt;
        record.hash = nextPass.hash;

        const nextRecoveryCode = generateRecoveryCode();
        const nextRec = hashSecret(normalizeRecoveryCodeInput(nextRecoveryCode));
        record.recoverySalt = nextRec.salt;
        record.recoveryHash = nextRec.hash;

        for (const [tok, sEntry] of Object.entries(db.sessions)) {
            const sUser = typeof sEntry === "string" ? sEntry : sEntry?.username;
            if (sUser === clean) delete db.sessions[tok];
        }

        saveAndSyncDB({ immediateDisk: true });
        cb?.({
            ok: true,
            newRecoveryCode: nextRecoveryCode
        });
    });

    socket.on("regenerate-recovery-code", (_payload, cb) => {
        const db = getDB();
        const user = activeUsers.get(socket.id);
        const record = user && db.users[user.username];
        if (!user || !record) return cb?.({ ok: false, error: "Oturum bulunamadı." });

        const nextRecoveryCode = generateRecoveryCode();
        const recObj = hashSecret(normalizeRecoveryCodeInput(nextRecoveryCode));
        record.recoverySalt = recObj.salt;
        record.recoveryHash = recObj.hash;
        saveAndSyncDB({ immediateDisk: true });
        cb?.({ ok: true, recoveryCode: nextRecoveryCode });
    });

    socket.on("update-profile", ({ displayName, color, status, avatar, afkExempt }, cb) => {
        const db = getDB();
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
}

module.exports = {
    registerAuthHandlers,
    completeUserSession
};