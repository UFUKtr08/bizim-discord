const crypto = require("crypto");
const {
    ALLOWED_REACTIONS,
    getDB,
    saveAndSyncDB,
    activeUsers,
    serverRuntime,
    getClientIp,
    checkRateLimit,
    generateInviteCode,
    sanitizeColor,
    isSafeRasterDataUrl,
    sanitizeAvatar,
    sanitizePermissions,
    createServerObject,
    dmKey,
    getMemberTopRole,
    getMemberPermissions,
    hasPerm,
    canActOnMember,
    canManageRolePriority,
    getUserServersList,
    buildServerSnapshot,
    broadcastServerState,
    broadcastAllUserServers
} = require("./db");

const { moveSocketToVoiceChannel } = require("./voice");

function registerServerHandlers(io, socket) {
    // --- ÇOKLU SUNUCU YÖNETİMİ ---
    socket.on("server-create", ({ name, icon }, cb) => {
        const db = getDB();
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
        if (!checkRateLimit("join:" + getClientIp(socket), 12, 60000)) {
            return cb?.({ ok: false, error: "Çok fazla sunucu katılım denemesi. Bekleyin." });
        }

        const db = getDB();
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
        const db = getDB();
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
        const db = getDB();
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
        const db = getDB();
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
        const db = getDB();
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
                url: String(turnUrl ?? srv.turnServer.url ?? "").trim().slice(0, 200),
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

    // --- KANAL YÖNETİMİ ---
    socket.on("channel-create", ({ serverId, name, type, topic, isAfk }, cb) => {
        const db = getDB();
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
        const db = getDB();
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
        const db = getDB();
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
        const db = getDB();
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
        const db = getDB();
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
        const db = getDB();
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
        const db = getDB();
        const user = activeUsers.get(socket.id);
        const srv = db.servers[serverId];
        if (!user || !srv || !hasPerm(srv, user.username, "manageRoles")) {
            return cb?.({ ok: false, error: "Üye rollerini değiştirme yetkiniz yok." });
        }
        if (!srv.members[targetUsername]) {
            return cb?.({ ok: false, error: "Üye sunucuda bulunamadı." });
        }

        const isSelfOwner = srv.ownerId === user.username && targetUsername === user.username;
        if (!isSelfOwner && !canActOnMember(srv, user.username, targetUsername)) {
            return cb?.({ ok: false, error: "Kendi yetki seviyenize eşit veya üstündeki bir üyenin rollerini değiştiremezsiniz." });
        }

        const roleMap = new Map(srv.roles.map((r) => [r.id, r]));
        const currentIds = new Set(srv.members[targetUsername].roleIds || []);
        const nextIds = new Set(
            (Array.isArray(roleIds) ? roleIds : []).filter((rid) => roleMap.has(rid))
        );

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

    // --- MODERASYON ---
    socket.on("member-kick", ({ serverId, targetUsername }, cb) => {
        const db = getDB();
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
        const db = getDB();
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
        const db = getDB();
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

        moveSocketToVoiceChannel(io, targetSid, serverId, srv.afkChannelId, "admin-move");
        cb?.({ ok: true });
    });

    // --- METİN SOHBETİ ---
    socket.on("chat-message", ({ serverId, channelId, text, image, file, replyTo }) => {
        const db = getDB();
        const user = activeUsers.get(socket.id);
        const srv = serverId && db.servers[serverId];
        if (!user || !srv || !srv.members[user.username]) return;

        const ch = srv.channels.find((c) => c.id === channelId && c.type === "text");
        if (!ch) return;

        const cleanText = typeof text === "string" ? text.trim().slice(0, 2000) : "";
        const safeImage = isSafeRasterDataUrl(image, 1800000) ? image : null;

        let safeFile = null;
        if (file && typeof file === "object" && typeof file.url === "string" && file.url.startsWith("/api/files/")) {
            safeFile = {
                id: String(file.id || "").slice(0, 32),
                name: String(file.name || "dosya").slice(0, 100),
                size: Math.max(0, Math.min(10 * 1024 * 1024, Number(file.size) || 0)),
                mime: String(file.mime || "").slice(0, 80),
                url: file.url.slice(0, 260)
            };
        }

        if (!cleanText && !safeImage && !safeFile) return;

        const safeReply = replyTo && typeof replyTo === "object"
            ? {
                id: String(replyTo.id || "").slice(0, 40),
                sender: String(replyTo.sender || "").slice(0, 32),
                text: String(replyTo.text || "").slice(0, 140),
                hasImage: Boolean(replyTo.hasImage),
                hasFile: Boolean(replyTo.hasFile)
            }
            : null;

        const rec = db.users[user.username];
        const msg = {
            id: "msg-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6),
            serverId: srv.id,
            channelId: ch.id,
            sender: user.username,
            displayName: rec?.displayName || user.username,
            color: rec?.color || "#5865f2",
            avatar: rec?.avatar || "",
            topRole: getMemberTopRole(srv, user.username),
            text: cleanText,
            image: safeImage,
            file: safeFile,
            replyTo: safeReply,
            reactions: {},
            pinned: false,
            time: new Date().toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" })
        };

        if (!Array.isArray(srv.messages[ch.id])) srv.messages[ch.id] = [];
        srv.messages[ch.id].push(msg);
        if (srv.messages[ch.id].length > 200) {
            srv.messages[ch.id] = srv.messages[ch.id].slice(-200);
        }

        db.meta.seededOnly = false;
        saveAndSyncDB();
        io.to("srv:" + srv.id).emit("chat-message", msg);
    });

    socket.on("toggle-reaction", ({ serverId, channelId, msgId, emoji }) => {
        const db = getDB();
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
        const db = getDB();
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
        const db = getDB();
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
        const db = getDB();
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

    // --- 1-1 FISILTI (DM) ---
    socket.on("dm-list", (cb) => {
        const db = getDB();
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
        const db = getDB();
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
        if (!checkRateLimit("dm:" + socket.id, 12, 5000)) {
            return cb?.({ ok: false, error: "Çok hızlı mesaj gönderiyorsunuz." });
        }
        const db = getDB();
        const user = activeUsers.get(socket.id);
        if (!user || !toUsername || toUsername === user.username || !db.users[toUsername]) {
            return cb?.({ ok: false, error: "Alıcı bulunamadı." });
        }
        const safeImage = isSafeRasterDataUrl(image, 1600000) ? image : null;
        if (!text?.trim() && !safeImage) return cb?.({ ok: false });

        const key = dmKey(user.username, toUsername);
        const msg = {
            id: "dm-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6),
            from: user.username,
            fromDisplayName: user.displayName || user.username,
            fromColor: user.color,
            fromAvatar: user.avatar || "",
            to: toUsername,
            text: (text || "").trim().slice(0, 2000),
            image: safeImage,
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
}

module.exports = {
    registerServerHandlers
};