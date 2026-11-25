const {
    getDB,
    activeUsers,
    getServerIceServers,
    hasPerm,
    canActOnMember,
    inSameVoiceChannel,
    broadcastServerState
} = require("./db");

function buildPeerState(srv, sid, u) {
    const nick = srv?.members?.[u.username]?.nickname || "";
    return {
        id: sid,
        username: u.username,
        displayName: nick || u.displayName || u.username,
        camOn: Boolean(u.camOn),
        camStreamId: u.camStreamId || null,
        screenSharing: Boolean(u.screenSharing),
        screenStreamId: u.screenStreamId || null,
        selfMuted: Boolean(u.selfMuted),
        serverMuted: Boolean(u.serverMuted),
        deafened: Boolean(u.deafened)
    };
}

function cleanupVoiceOnDisconnect(io, socket, user) {
    if (!user || !user.voiceServerId || !user.voiceChannel) return;
    const oldSrvId = user.voiceServerId;
    const oldChId = user.voiceChannel;

    user.voiceServerId = null;
    user.voiceChannel = null;
    user.camOn = false;
    user.camStreamId = null;
    user.screenSharing = false;
    user.screenStreamId = null;

    for (const [sid, u] of activeUsers.entries()) {
        if (sid !== socket.id && u.voiceServerId === oldSrvId && u.voiceChannel === oldChId) {
            io.to(sid).emit("user-left-voice", socket.id);
        }
    }

    io.to("srv:" + oldSrvId).emit("voice-event", {
        type: "leave",
        serverId: oldSrvId,
        channelId: oldChId
    });
    broadcastServerState(oldSrvId);
}

function moveMemberToVoiceChannel(io, srv, targetSid, targetUser, destCh, { reason = "moved", movedBy = "" } = {}) {
    const oldChId = targetUser.voiceChannel;

    for (const [sid, u] of activeUsers.entries()) {
        if (sid !== targetSid && u.voiceServerId === srv.id && u.voiceChannel === oldChId) {
            io.to(sid).emit("user-left-voice", targetSid);
        }
    }
    io.to("srv:" + srv.id).emit("voice-event", {
        type: "leave",
        serverId: srv.id,
        channelId: oldChId
    });

    const isAfkDest = Boolean(destCh.isAfk || srv.afkChannelId === destCh.id);
    targetUser.voiceChannel = destCh.id;
    targetUser.camOn = false;
    targetUser.camStreamId = null;
    targetUser.screenSharing = false;
    targetUser.screenStreamId = null;
    targetUser.lastVoiceActivityAt = Date.now();
    if (isAfkDest) targetUser.selfMuted = true;

    const destPeers = [];
    const destPeerStates = [];
    for (const [sid, u] of activeUsers.entries()) {
        if (sid !== targetSid && u.voiceServerId === srv.id && u.voiceChannel === destCh.id) {
            destPeers.push(sid);
            destPeerStates.push(buildPeerState(srv, sid, u));
            io.to(sid).emit("voice-peer-joined", {
                peerId: targetSid,
                serverId: srv.id,
                channelId: destCh.id
            });
        }
    }

    io.to(targetSid).emit("voice-afk-moved", {
        serverId: srv.id,
        channelId: destCh.id,
        channelName: destCh.name,
        isAfkChannel: isAfkDest,
        reason,
        movedBy,
        peers: destPeers,
        peerStates: destPeerStates
    });

    io.to("srv:" + srv.id).emit("voice-event", {
        type: "join",
        serverId: srv.id,
        channelId: destCh.id
    });
    broadcastServerState(srv.id);
}

function startAfkWatcher(io) {
    setInterval(() => {
        const db = getDB();
        const now = Date.now();

        for (const [sid, u] of activeUsers.entries()) {
            if (!u.voiceServerId || !u.voiceChannel || u.afkExempt) continue;
            const srv = db.servers[u.voiceServerId];
            if (!srv || !srv.afkChannelId || !srv.afkTimeoutSec || srv.afkTimeoutSec <= 0) continue;
            if (u.voiceChannel === srv.afkChannelId) continue;

            const afkCh = srv.channels.find((c) => c.id === srv.afkChannelId && c.type === "voice");
            if (!afkCh) continue;

            const idleMs = now - (u.lastVoiceActivityAt || now);
            if (idleMs >= srv.afkTimeoutSec * 1000) {
                moveMemberToVoiceChannel(io, srv, sid, u, afkCh, { reason: "auto-afk" });
            }
        }
    }, 15000);
}

function registerVoiceHandlers(io, socket) {
    socket.on("join-voice", ({ serverId, channelId }, cb) => {
        const db = getDB();
        const user = activeUsers.get(socket.id);
        const srv = serverId && db.servers[serverId];
        if (!user || !srv || !srv.members[user.username]) {
            return cb?.({ ok: false, error: "Bu sunucuya erişimin yok." });
        }

        const ch = srv.channels.find((c) => c.id === channelId && c.type === "voice");
        if (!ch) return cb?.({ ok: false, error: "Ses kanalı bulunamadı." });

        if (user.voiceServerId && user.voiceChannel) {
            if (user.voiceServerId === srv.id && user.voiceChannel === ch.id) {
                return cb?.({ ok: false, error: "Zaten bu ses kanalındasın." });
            }
            cleanupVoiceOnDisconnect(io, socket, user);
        }

        const isAfkChannel = Boolean(ch.isAfk || srv.afkChannelId === ch.id);
        user.voiceServerId = srv.id;
        user.voiceChannel = ch.id;
        user.camOn = false;
        user.camStreamId = null;
        user.screenSharing = false;
        user.screenStreamId = null;
        user.lastVoiceActivityAt = Date.now();
        if (isAfkChannel) user.selfMuted = true;

        const peers = [];
        const peerStates = [];
        for (const [sid, u] of activeUsers.entries()) {
            if (sid !== socket.id && u.voiceServerId === srv.id && u.voiceChannel === ch.id) {
                peers.push(sid);
                peerStates.push(buildPeerState(srv, sid, u));
                io.to(sid).emit("voice-peer-joined", {
                    peerId: socket.id,
                    serverId: srv.id,
                    channelId: ch.id
                });
            }
        }

        io.to("srv:" + srv.id).emit("voice-event", {
            type: "join",
            serverId: srv.id,
            channelId: ch.id
        });
        broadcastServerState(srv.id);

        const iceServers = getServerIceServers(srv);
        cb?.({
            ok: true,
            peers,
            peerStates,
            iceServers,
            hasTurnConfigured: iceServers.length > 3,
            isAfkChannel
        });
    });

    socket.on("leave-voice", () => {
        const user = activeUsers.get(socket.id);
        if (user) cleanupVoiceOnDisconnect(io, socket, user);
    });

    socket.on("voice-status-update", (payload) => {
        const user = activeUsers.get(socket.id);
        if (!user || !payload || typeof payload !== "object") return;

        if (typeof payload.selfMuted === "boolean") user.selfMuted = payload.selfMuted;
        if (typeof payload.deafened === "boolean") user.deafened = payload.deafened;
        if (typeof payload.camOn === "boolean") user.camOn = payload.camOn;
        if (payload.camStreamId !== undefined) user.camStreamId = payload.camStreamId ? String(payload.camStreamId).slice(0, 80) : null;
        if (typeof payload.screenSharing === "boolean") user.screenSharing = payload.screenSharing;
        if (payload.screenStreamId !== undefined) user.screenStreamId = payload.screenStreamId ? String(payload.screenStreamId).slice(0, 80) : null;

        user.lastVoiceActivityAt = Date.now();
        if (user.voiceServerId) broadcastServerState(user.voiceServerId);
    });

    socket.on("voice-activity", () => {
        const user = activeUsers.get(socket.id);
        if (user) user.lastVoiceActivityAt = Date.now();
    });

    socket.on("cam-stopped", () => {
        const user = activeUsers.get(socket.id);
        if (!user || !user.voiceServerId || !user.voiceChannel) return;
        user.camOn = false;
        user.camStreamId = null;
        for (const [sid, u] of activeUsers.entries()) {
            if (sid !== socket.id && u.voiceServerId === user.voiceServerId && u.voiceChannel === user.voiceChannel) {
                io.to(sid).emit("cam-stopped", socket.id);
            }
        }
        broadcastServerState(user.voiceServerId);
    });

    socket.on("screen-share-stopped", () => {
        const user = activeUsers.get(socket.id);
        if (!user || !user.voiceServerId || !user.voiceChannel) return;
        user.screenSharing = false;
        user.screenStreamId = null;
        for (const [sid, u] of activeUsers.entries()) {
            if (sid !== socket.id && u.voiceServerId === user.voiceServerId && u.voiceChannel === user.voiceChannel) {
                io.to(sid).emit("screen-share-stopped", socket.id);
            }
        }
        broadcastServerState(user.voiceServerId);
    });

    // Yetkiye bağlı AFK odasına taşıma
    socket.on("member-move-afk", ({ serverId, targetUsername }, cb) => {
        const db = getDB();
        const actor = activeUsers.get(socket.id);
        const srv = serverId && db.servers[serverId];
        if (!actor || !srv || !srv.members[actor.username]) {
            return cb?.({ ok: false, error: "Yetkisiz işlem." });
        }

        const canMove =
            hasPerm(srv, actor.username, "moveMembers") ||
            hasPerm(srv, actor.username, "muteMembers") ||
            hasPerm(srv, actor.username, "administrator");
        if (!canMove) return cb?.({ ok: false, error: "AFK odasına taşıma yetkin yok." });

        const targetUname = String(targetUsername || "").trim().toLowerCase();
        if (!canActOnMember(srv, actor.username, targetUname)) {
            return cb?.({ ok: false, error: "Bu üyeyi taşıma yetkin yok." });
        }

        const afkCh = srv.afkChannelId
            ? srv.channels.find((c) => c.id === srv.afkChannelId && c.type === "voice")
            : null;
        if (!afkCh) return cb?.({ ok: false, error: "AFK kanalı ayarlanmamış." });

        let targetSid = null;
        let targetUser = null;
        for (const [sid, u] of activeUsers.entries()) {
            if (u.username === targetUname) {
                targetSid = sid;
                targetUser = u;
                break;
            }
        }
        if (!targetSid || !targetUser || targetUser.voiceServerId !== srv.id || !targetUser.voiceChannel) {
            return cb?.({ ok: false, error: "Kullanıcı ses kanalında değil." });
        }
        if (targetUser.voiceChannel === afkCh.id) {
            return cb?.({ ok: false, error: "Kullanıcı zaten AFK odasında." });
        }

        const actorRec = db.users[actor.username];
        const actorName = srv.members[actor.username]?.nickname || actorRec?.displayName || actor.username;
        moveMemberToVoiceChannel(io, srv, targetSid, targetUser, afkCh, {
            reason: "manual-afk",
            movedBy: actorName
        });
        cb?.({ ok: true });
    });

    // Yetkiye bağlı sürükle-bırak ses kanalından kanala taşıma
    socket.on("member-move-voice", ({ serverId, targetUsername, targetChannelId }, cb) => {
        const db = getDB();
        const actor = activeUsers.get(socket.id);
        const srv = serverId && db.servers[serverId];
        if (!actor || !srv || !srv.members[actor.username]) {
            return cb?.({ ok: false, error: "Yetkisiz işlem." });
        }

        const canMove =
            hasPerm(srv, actor.username, "moveMembers") ||
            hasPerm(srv, actor.username, "administrator");
        if (!canMove) {
            return cb?.({ ok: false, error: "Üyeleri ses kanalları arasında taşıma yetkin yok." });
        }

        const targetUname = String(targetUsername || "").trim().toLowerCase();
        const isSelfMove = actor.username === targetUname;
        if (!isSelfMove && !canActOnMember(srv, actor.username, targetUname)) {
            return cb?.({ ok: false, error: "Kendinle eşit veya üst yetkideki bir üyeyi taşıyamazsın." });
        }

        const destCh = srv.channels.find((c) => c.id === targetChannelId && c.type === "voice");
        if (!destCh) return cb?.({ ok: false, error: "Hedef ses kanalı bulunamadı." });

        let targetSid = null;
        let targetUser = null;
        for (const [sid, u] of activeUsers.entries()) {
            if (u.username === targetUname) {
                targetSid = sid;
                targetUser = u;
                break;
            }
        }
        if (!targetSid || !targetUser || targetUser.voiceServerId !== srv.id || !targetUser.voiceChannel) {
            return cb?.({ ok: false, error: "Kullanıcı bu sunucuda bir ses kanalında değil." });
        }
        if (targetUser.voiceChannel === destCh.id) {
            return cb?.({ ok: false, error: "Kullanıcı zaten bu ses kanalında." });
        }

        const isAfkDest = Boolean(destCh.isAfk || srv.afkChannelId === destCh.id);
        const actorRec = db.users[actor.username];
        const actorName = srv.members[actor.username]?.nickname || actorRec?.displayName || actor.username;

        moveMemberToVoiceChannel(io, srv, targetSid, targetUser, destCh, {
            reason: isAfkDest ? "manual-afk" : "moved",
            movedBy: actorName
        });
        cb?.({ ok: true });
    });

    // WebRTC Sinyalleme (yalnızca aynı ses kanalındaki eşler arası)
    socket.on("webrtc-offer", ({ to, offer }) => {
        if (!to || !offer || !inSameVoiceChannel(socket.id, to)) return;
        io.to(to).emit("webrtc-offer", { from: socket.id, offer });
    });

    socket.on("webrtc-answer", ({ to, answer }) => {
        if (!to || !answer || !inSameVoiceChannel(socket.id, to)) return;
        io.to(to).emit("webrtc-answer", { from: socket.id, answer });
    });

    socket.on("webrtc-ice", ({ to, candidate }) => {
        if (!to || !candidate || !inSameVoiceChannel(socket.id, to)) return;
        io.to(to).emit("webrtc-ice", { from: socket.id, candidate });
    });
}

module.exports = {
    registerVoiceHandlers,
    startAfkWatcher,
    cleanupVoiceOnDisconnect
};