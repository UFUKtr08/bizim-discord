import {
    socket,
    SOUNDBOARD_ITEMS,
    state,
    hooks,
    $,
    escapeHTML,
    showToast,
    openModal,
    renderAvatarContent
} from "./state.js";
import { playSoundboardSynth } from "./audio.js";

export function formatMessageBody(text) {
    let safe = escapeHTML(text);
    safe = safe.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
    safe = safe.replace(/@([a-zA-Z0-9._-]{2,20})/g, '<span class="mention-hl">@$1</span>');
    return safe;
}

// =========================================================================
// HAZIR KONTROLÜ (READY CHECK)
// =========================================================================
export function renderReadyCheckBanner() {
    const banner = $("ready-check-banner");
    if (!banner) return;

    if (!state.activeReadyCheck) {
        banner.style.display = "none";
        return;
    }

    banner.style.display = "flex";
    if ($("rc-title")) $("rc-title").textContent = state.activeReadyCheck.title;
    if ($("rc-meta")) $("rc-meta").textContent = `• ${state.activeReadyCheck.initiatorName} başlattı`;

    const canClose =
        (state.me && state.activeReadyCheck.initiator === state.me.username) ||
        Boolean(state.myPermissions.administrator || state.myPermissions.manageChannels);
    if ($("btn-rc-close")) $("btn-rc-close").style.display = canClose ? "" : "none";

    const chipsWrap = $("rc-chips");
    if (!chipsWrap) return;
    chipsWrap.innerHTML = "";

    const statusLabels = { ready: "✓ Hazır", wait5: "⏳ 5 dk", no: "✕ Yok" };
    Object.values(state.activeReadyCheck.responses || {}).forEach((r) => {
        const chip = document.createElement("span");
        chip.className = `rc-chip ${r.status}`;
        chip.textContent = `${r.displayName}: ${statusLabels[r.status] || r.status}`;
        chipsWrap.appendChild(chip);
    });
}

// =========================================================================
// HIZLI ANKETLER
// =========================================================================
export function renderPollsList() {
    const container = $("polls-list");
    if (!container) return;
    container.innerHTML = "";

    if (!state.serverPolls.length) {
        container.innerHTML = '<div class="muted-note center">Henüz aktif anket yok.</div>';
        return;
    }

    state.serverPolls.forEach((poll) => {
        const card = document.createElement("div");
        card.className = "poll-card";

        const totalVotes = poll.options.reduce((acc, o) => acc + o.votes.length, 0);
        const hdr = document.createElement("div");
        hdr.className = "row-between";
        hdr.innerHTML = `<strong>${escapeHTML(poll.question)}</strong><span class="muted-inline">${escapeHTML(poll.creatorName)} • ${totalVotes} oy ${poll.closed ? "(Kapalı)" : ""}</span>`;
        card.appendChild(hdr);

        poll.options.forEach((opt, idx) => {
            const pct = totalVotes > 0 ? Math.round((opt.votes.length / totalVotes) * 100) : 0;
            const voted = state.me && opt.votes.includes(state.me.username);
            const btn = document.createElement("button");
            btn.className = "poll-opt-btn" + (voted ? " voted" : "");
            btn.disabled = Boolean(poll.closed);
            btn.innerHTML = `
                <span class="poll-opt-fill" style="width:${pct}%"></span>
                <span class="poll-opt-txt">${escapeHTML(opt.label)}</span>
                <span class="poll-opt-cnt">${opt.votes.length} (${pct}%)</span>
            `;
            btn.onclick = () => {
                socket.emit("poll-vote", {
                    serverId: state.activeServerId,
                    pollId: poll.id,
                    optionIndex: idx
                });
            };
            card.appendChild(btn);
        });

        const canClose =
            !poll.closed &&
            ((state.me && poll.creator === state.me.username) ||
                state.myPermissions.administrator ||
                state.myPermissions.manageChannels);
        if (canClose) {
            const closeBtn = document.createElement("button");
            closeBtn.className = "btn xs secondary";
            closeBtn.style.alignSelf = "flex-end";
            closeBtn.textContent = "Anketi Kapat";
            closeBtn.onclick = () => {
                socket.emit("poll-close", { serverId: state.activeServerId, pollId: poll.id });
            };
            card.appendChild(closeBtn);
        }

        container.appendChild(card);
    });
}

// =========================================================================
// ORTAK İZLEME (SENKRONİZE YOUTUBE)
// =========================================================================
export function loadYouTubeAPI() {
    if (window.YT && window.YT.Player) return Promise.resolve();
    if (state.ytApiPromise) return state.ytApiPromise;
    state.ytApiPromise = new Promise((resolve) => {
        const prev = window.onYouTubeIframeAPIReady;
        window.onYouTubeIframeAPIReady = () => {
            if (typeof prev === "function") prev();
            resolve();
        };
        const tag = document.createElement("script");
        tag.src = "https://www.youtube.com/iframe_api";
        document.head.appendChild(tag);
    });
    return state.ytApiPromise;
}

export async function applyWatchState(w) {
    state.watchState = w || { active: false };
    const stage = $("watch-stage");
    if (!stage) return;

    if (!state.watchState.active || !state.watchState.videoId) {
        stage.style.display = "none";
        if (state.ytPlayer && typeof state.ytPlayer.destroy === "function") {
            try { state.ytPlayer.destroy(); } catch { }
        }
        state.ytPlayer = null;
        state.ytPlayerVideoId = null;
        if ($("yt-player-host")) $("yt-player-host").innerHTML = "";
        return;
    }

    stage.style.display = "flex";
    if ($("watch-title-lbl")) $("watch-title-lbl").textContent = state.watchState.title || "Ortak İzleme";
    if ($("watch-host-lbl")) $("watch-host-lbl").textContent = state.watchState.hostName ? `• ${state.watchState.hostName}` : "";

    const elapsed = state.watchState.playing ? (Date.now() - (state.watchState.updatedAt || Date.now())) / 1000 : 0;
    const targetTime = Math.max(0, (state.watchState.currentTime || 0) + elapsed);

    await loadYouTubeAPI();

    if (!state.ytPlayer || state.ytPlayerVideoId !== state.watchState.videoId) {
        if (state.ytPlayer && typeof state.ytPlayer.destroy === "function") {
            try { state.ytPlayer.destroy(); } catch { }
        }
        if ($("yt-player-host")) $("yt-player-host").innerHTML = '<div id="yt-inner-player"></div>';
        state.ytPlayerVideoId = state.watchState.videoId;
        state.suppressYtEventsUntil = Date.now() + 1800;

        state.ytPlayer = new window.YT.Player("yt-inner-player", {
            videoId: state.watchState.videoId,
            playerVars: {
                autoplay: state.watchState.playing ? 1 : 0,
                rel: 0,
                modestbranding: 1,
                start: Math.floor(targetTime)
            },
            events: {
                onReady: (ev) => {
                    state.suppressYtEventsUntil = Date.now() + 1400;
                    ev.target.seekTo(targetTime, true);
                    if (state.watchState.playing) ev.target.playVideo();
                    else ev.target.pauseVideo();
                },
                onStateChange: (ev) => {
                    if (Date.now() < state.suppressYtEventsUntil || !state.watchState.active) return;
                    const cur = ev.target.getCurrentTime ? ev.target.getCurrentTime() : 0;
                    if (ev.data === window.YT.PlayerState.PLAYING) {
                        socket.emit("watch-sync", { serverId: state.activeServerId, action: "play", currentTime: cur });
                    } else if (ev.data === window.YT.PlayerState.PAUSED) {
                        socket.emit("watch-sync", { serverId: state.activeServerId, action: "pause", currentTime: cur });
                    }
                }
            }
        });
        return;
    }

    try {
        state.suppressYtEventsUntil = Date.now() + 1200;
        const cur = typeof state.ytPlayer.getCurrentTime === "function" ? state.ytPlayer.getCurrentTime() : 0;
        if (Math.abs(cur - targetTime) > 1.6) {
            state.ytPlayer.seekTo(targetTime, true);
        }
        if (state.watchState.playing) state.ytPlayer.playVideo();
        else state.ytPlayer.pauseVideo();
    } catch { }
}

// =========================================================================
// EKİP SOUNDBOARD
// =========================================================================
export function initSoundboardGrid() {
    const grid = $("soundboard-grid");
    if (!grid) return;
    grid.innerHTML = "";
    SOUNDBOARD_ITEMS.forEach((item) => {
        const btn = document.createElement("button");
        btn.className = "sb-pad";
        btn.innerHTML = `<span>${item.icon}</span><span>${escapeHTML(item.label)}</span>`;
        btn.onclick = () => {
            if (!state.voiceChannelId) {
                playSoundboardSynth(item.id);
                showToast("Ses kanalında değilsin (yalnızca sana çalındı).", "info", 2000);
                return;
            }
            socket.emit("soundboard-play", { soundId: item.id });
        };
        grid.appendChild(btn);
    });
}

// =========================================================================
// TAKTİK ÇİZİM TAHTASI
// =========================================================================
export function resizeBoardCanvas() {
    const canvas = $("tactic-canvas");
    const wrap = canvas?.parentElement;
    if (!canvas || !wrap) return;
    const rect = wrap.getBoundingClientRect();
    if (rect.width < 10 || rect.height < 10) return;
    canvas.width = Math.round(rect.width * window.devicePixelRatio);
    canvas.height = Math.round(rect.height * window.devicePixelRatio);
    redrawBoard();
}

function drawSingleStroke(ctx, w, h, st) {
    if (!st || !Array.isArray(st.points) || st.points.length < 2) return;
    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.lineWidth = (st.width || 3) * window.devicePixelRatio;

    if (st.tool === "eraser") {
        ctx.globalCompositeOperation = "destination-out";
        ctx.strokeStyle = "rgba(0,0,0,1)";
        ctx.lineWidth = (st.width || 3) * 3 * window.devicePixelRatio;
    } else {
        ctx.strokeStyle = st.color || "#f0b232";
    }

    const pts = st.points;
    ctx.beginPath();
    if (st.tool === "line" || st.tool === "arrow") {
        const [x1, y1] = [pts[0][0] * w, pts[0][1] * h];
        const [x2, y2] = [pts[pts.length - 1][0] * w, pts[pts.length - 1][1] * h];
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();

        if (st.tool === "arrow") {
            const angle = Math.atan2(y2 - y1, x2 - x1);
            const headLen = 12 * window.devicePixelRatio;
            ctx.beginPath();
            ctx.moveTo(x2, y2);
            ctx.lineTo(x2 - headLen * Math.cos(angle - Math.PI / 6), y2 - headLen * Math.sin(angle - Math.PI / 6));
            ctx.moveTo(x2, y2);
            ctx.lineTo(x2 - headLen * Math.cos(angle + Math.PI / 6), y2 - headLen * Math.sin(angle + Math.PI / 6));
            ctx.stroke();
        }
    } else {
        ctx.moveTo(pts[0][0] * w, pts[0][1] * h);
        for (let i = 1; i < pts.length; i++) {
            ctx.lineTo(pts[i][0] * w, pts[i][1] * h);
        }
        ctx.stroke();
    }
    ctx.restore();
}

export function redrawBoard(previewStroke = null) {
    const canvas = $("tactic-canvas");
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    (state.boardState.strokes || []).forEach((st) => drawSingleStroke(ctx, canvas.width, canvas.height, st));
    if (previewStroke) drawSingleStroke(ctx, canvas.width, canvas.height, previewStroke);
}

export function applyBoardState(b) {
    state.boardState = b || { active: false, strokes: [] };
    const stage = $("board-stage");
    if (!stage) return;
    stage.style.display = state.boardState.active ? "flex" : "none";
    if (state.boardState.active) {
        requestAnimationFrame(resizeBoardCanvas);
    }
}

export function initTacticBoardEvents() {
    const canvas = $("tactic-canvas");
    if (!canvas) return;

    const getNormPt = (e) => {
        const rect = canvas.getBoundingClientRect();
        return [
            Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)),
            Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height))
        ];
    };

    canvas.addEventListener("pointerdown", (e) => {
        canvas.setPointerCapture(e.pointerId);
        state.boardDrawing = true;
        state.currentStrokePoints = [getNormPt(e)];
    });

    canvas.addEventListener("pointermove", (e) => {
        if (!state.boardDrawing) return;
        const pt = getNormPt(e);
        if (state.boardTool === "line" || state.boardTool === "arrow") {
            state.currentStrokePoints = [state.currentStrokePoints[0], pt];
        } else {
            const last = state.currentStrokePoints[state.currentStrokePoints.length - 1];
            if (!last || Math.hypot(pt[0] - last[0], pt[1] - last[1]) > 0.004) {
                state.currentStrokePoints.push(pt);
            }
        }
        redrawBoard({
            tool: state.boardTool,
            color: $("board-color")?.value || "#f0b232",
            width: parseInt($("board-width")?.value, 10) || 3,
            points: state.currentStrokePoints
        });
    });

    const finishStroke = () => {
        if (!state.boardDrawing) return;
        state.boardDrawing = false;
        if (state.currentStrokePoints.length >= 2) {
            const stroke = {
                tool: state.boardTool,
                color: $("board-color")?.value || "#f0b232",
                width: parseInt($("board-width")?.value, 10) || 3,
                points: state.currentStrokePoints.slice(0, 300)
            };
            state.boardState.strokes.push(stroke);
            redrawBoard();
            socket.emit("board-stroke", { serverId: state.activeServerId, stroke });
        }
        state.currentStrokePoints = [];
    };

    canvas.addEventListener("pointerup", finishStroke);
    canvas.addEventListener("pointercancel", finishStroke);
    window.addEventListener("resize", () => {
        if (state.boardState.active) resizeBoardCanvas();
    });
}

// =========================================================================
// 1-1 FISILTI (DM)
// =========================================================================
export function renderDmConversations() {
    const ul = $("dm-conv-list");
    if (!ul) return;
    ul.innerHTML = "";
    if (!state.dmConversations.length) {
        ul.innerHTML = '<li class="muted-note" style="padding:8px;">Henüz özel mesaj yok. Üye listesinden birine tıklayarak başlat.</li>';
        return;
    }
    state.dmConversations.forEach((c) => {
        const li = document.createElement("li");
        li.className = "dm-conv-item" + (state.activeDmPeer?.username === c.username ? " active" : "");

        const av = document.createElement("div");
        av.className = "avatar-circle xs";
        renderAvatarContent(av, c);

        const info = document.createElement("div");
        info.style.minWidth = "0";
        info.innerHTML = `<div style="font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHTML(c.displayName)}</div>
                          <div class="muted-inline" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHTML(c.lastMessage || "")}</div>`;

        li.appendChild(av);
        li.appendChild(info);
        li.onclick = () => loadDmHistory(c.username);
        ul.appendChild(li);
    });
}

export function appendDmBubble(m) {
    const box = $("dm-messages");
    if (!box) return;
    const emptyNote = box.querySelector(".muted-note.center");
    if (emptyNote) emptyNote.remove();

    const isMine = state.me && m.from === state.me.username;
    const div = document.createElement("div");
    div.className = "dm-bubble" + (isMine ? " mine" : "");
    div.innerHTML = `
        <div>${formatMessageBody(m.text || "")}</div>
        <div class="dm-bubble-meta">${escapeHTML(m.fromDisplayName || m.from)} • ${escapeHTML(m.time || "")}</div>
    `;
    box.appendChild(div);
    box.scrollTop = box.scrollHeight;
}

export function renderDmMessages(list) {
    const box = $("dm-messages");
    if (!box) return;
    box.innerHTML = "";
    if (!list.length) {
        box.innerHTML = '<div class="muted-note center" style="margin-top:24px;">İlk özel mesajı gönder.</div>';
        return;
    }
    list.forEach((m) => appendDmBubble(m));
    box.scrollTop = box.scrollHeight;
}

export function loadDmHistory(username) {
    socket.emit("dm-history", { withUsername: username }, (res) => {
        if (!res?.ok) return;
        state.activeDmPeer = res.peer;
        if ($("dm-peer-hdr")) $("dm-peer-hdr").textContent = `💬 ${res.peer.displayName} (@${res.peer.username})`;
        if ($("dm-input")) $("dm-input").disabled = false;
        if ($("dm-send-btn")) $("dm-send-btn").disabled = false;
        renderDmMessages(res.messages || []);
        renderDmConversations();
        $("dm-input")?.focus();
    });
}

export function openDmModal() {
    state.dmUnread = false;
    hooks.renderServerRail();
    openModal("dm-modal");
    socket.emit("dm-list", (convs) => {
        state.dmConversations = convs || [];
        renderDmConversations();
    });
}

export function openDmWith(username) {
    if (!username || (state.me && username === state.me.username)) return;
    openDmModal();
    loadDmHistory(username);
}