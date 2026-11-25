const {
    getDB,
    activeUsers,
    inSameVoiceChannel,
    getServerIceServers,
    broadcastServerState
} = require("./db");

function moveSocketToVoiceChannel(io, socketId, serverId, targetChannelId, reason = "afk") {
    const db = getDB();
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
            displayName: au.displayName || au.username,
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

let afkWatcherStarted = false;

function startAfkWatcher(io) {
    if (afkWatcherStarted) return;
    afkWatcherStarted = true;

    setInterval(() => {
        const db = getDB();
        const now = Date.now();
        for (const [sid, au] of activeUsers.entries()) {
            if (!au.voiceServerId || !au.voiceChannel) continue;
            if (au.afkExempt) continue;

            const srv = db.servers[au.voiceServerId];
            if (!srv || !srv.afkChannelId || !srv.afkTimeoutSec || srv.afkTimeoutSec <= 0) continue;
            if (au.voiceChannel === srv.afkChannelId) continue;
            if (au.camOn || au.screenSharing) continue;

            const afkChannelExists = srv.channels.some((c) => c.id === srv.afkChannelId && c.type === "voice");
            if (!afkChannelExists) continue;

            const idleMs = now - (au.lastVoiceActivityAt || now);
            if (idleMs >= srv.afkTimeoutSec * 1000) {
                moveSocketToVoiceChannel(io, sid, srv.id, srv.afkChannelId, "auto-afk");
            }
        }
    }, 15000);
}

function cleanupVoiceOnDisconnect(io, socket, user) {
    const oldVoiceSrv = user.voiceServerId;
    const oldVoiceCh = user.voiceChannel;
    if (!oldVoiceSrv || !oldVoiceCh) return;

    io.to("srv:" + oldVoiceSrv).emit("user-left-voice", socket.id);
    io.to("srv:" + oldVoiceSrv).emit("voice-event", {
        type: "leave",
        serverId: oldVoiceSrv,
        username: user.username,
        displayName: user.displayName || user.username,
        channelId: oldVoiceCh
    });
}

function registerVoiceHandlers(io, socket) {
    socket.on("join-voice", (payload, cb) => {
        const db = getDB();
        const user = activeUsers.get(socket.id);
        if (!user) return cb?.({ ok: false, error: "Oturum bulunamadı." });

        const serverId = typeof payload === "object" ? payload.serverId : user.activeServerId;
        const channelId = typeof payload === "object" ? payload.channelId : payload;
        const srv = db.servers[serverId];
        if (!srv || !srv.members[user.username]) return cb?.({ ok: false, error: "Sunucu bulunamadı." });

        const ch = srv.channels.find((c) => c.id === channelId && c.type === "voice");
        if (!ch) return cb?.({ ok: false, error: "Ses kanalı bulunamadı." });

        const prevServerId = user.voiceServerId;
        const prevChannelId = user.voiceChannel;

        if (prevServerId && prevChannelId) {
            io.to("srv:" + prevServerId).emit("user-left-voice", socket.id);
        }

        const peersInChannel = [];
        const peerStates = [];
        for (const [id, u] of activeUsers.entries()) {
            if (id !== socket.id && u.voiceServerId === serverId && u.voiceChannel === channelId) {
                peersInChannel.push(id);
                peerStates.push({
                    id,
                    username: u.username,
                    displayName: u.displayName || u.username,
                    camOn: Boolean(u.camOn),
                    camStreamId: u.camStreamId || null,
                    screenSharing: Boolean(u.screenSharing),
                    screenStreamId: u.screenStreamId || null
                });
            }
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

        // Odadaki mevcut kullanıcılara yeni katılanı bildir (aktif kamera/ekran varsa re-offer tetikleyebilsin)
        for (const pid of peersInChannel) {
            io.to(pid).emit("voice-peer-joined", {
                peerId: socket.id,
                username: user.username,
                displayName: user.displayName || user.username,
                serverId,
                channelId
            });
        }

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
            peerStates,
            iceServers: getServerIceServers(srv),
            hasTurnConfigured: Boolean(
                (srv.turnServer?.url && srv.turnServer.url.trim()) ||
                (process.env.TURN_URL && process.env.TURN_URL.trim())
            ),
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

    // --- WEBRTC SİNYALLEŞME (AYNI SES KANALI DOĞRULAMALI) ---
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
}

module.exports = {
    registerVoiceHandlers,
    moveSocketToVoiceChannel,
    startAfkWatcher,
    cleanupVoiceOnDisconnect
};