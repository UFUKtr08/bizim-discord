const {
    getDB,
    saveAndSyncDB,
    activeUsers,
    soundboardCooldown,
    checkRateLimit,
    sanitizeColor,
    extractYouTubeId,
    getRuntime,
    hasPerm
} = require("./db");

function registerToolsHandlers(io, socket) {
    // --- HAZIR KONTROLÜ (READY CHECK) ---
    socket.on("ready-check-start", ({ serverId, title }, cb) => {
        const db = getDB();
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
        const db = getDB();
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
        const db = getDB();
        const user = activeUsers.get(socket.id);
        const srv = db.servers[serverId];
        if (!user || !srv || !srv.members[user.username]) return;

        const rt = getRuntime(serverId);
        if (!rt.readyCheck) return;
        if (rt.readyCheck.initiator !== user.username && !hasPerm(srv, user.username, "manageChannels")) return;

        rt.readyCheck = null;
        io.to("srv:" + serverId).emit("ready-check-update", { serverId, readyCheck: null, isNew: false });
    });

    // --- ANKETLER ---
    socket.on("poll-create", ({ serverId, question, options }, cb) => {
        const db = getDB();
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
        const db = getDB();
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
        const db = getDB();
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

    // --- ORTAK İZLEME (YOUTUBE) ---
    socket.on("watch-start", ({ serverId, url, title }, cb) => {
        const db = getDB();
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
        const db = getDB();
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
        const db = getDB();
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

    // --- EKİP SOUNDBOARD ---
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

    // --- TAKTİK ÇİZİM TAHTASI ---
    socket.on("board-toggle", ({ serverId, active }) => {
        const db = getDB();
        const user = activeUsers.get(socket.id);
        const srv = db.servers[serverId];
        if (!user || !srv || !srv.members[user.username]) return;
        const rt = getRuntime(serverId);
        rt.board.active = Boolean(active);
        io.to("srv:" + serverId).emit("board-state", { serverId, board: rt.board });
    });

    socket.on("board-stroke", ({ serverId, stroke }) => {
        if (!checkRateLimit("board:" + socket.id, 45, 3000)) return;
        const db = getDB();
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
        const db = getDB();
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
        const db = getDB();
        const user = activeUsers.get(socket.id);
        const srv = db.servers[serverId];
        if (!user || !srv || !srv.members[user.username]) return;
        const rt = getRuntime(serverId);
        rt.board.strokes = [];
        io.to("srv:" + serverId).emit("board-state", { serverId, board: rt.board });
    });
}

module.exports = {
    registerToolsHandlers
};