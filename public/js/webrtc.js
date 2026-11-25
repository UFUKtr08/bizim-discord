import { socket, isElectron, state, hooks, $, escapeHTML, showToast, openModal, closeModal } from "./state.js";
import {
    ensureSharedAudioCtx,
    playTone,
    optimizeOpusSDP,
    buildMicPipeline,
    stopMicPipeline,
    applyMuteState,
    attachRemoteAudio,
    cleanupRemoteAudioNode,
    setSpeakingState,
    pushOverlayState
} from "./audio.js";

// =========================================================================
// CANLI VIDEO SAHNESİ (DISCORD TARZI ORANTILI BEST-FIT IZGARA & SPOTLIGHT)
// =========================================================================
let stageResizeObserver = null;
let stageLayoutRaf = null;

function ensureStageObserver() {
    if (stageResizeObserver) return;
    const tilesWrap = $("stage-tiles");
    if (!tilesWrap || typeof ResizeObserver === "undefined") return;
    stageResizeObserver = new ResizeObserver(() => {
        scheduleStageLayout();
    });
    stageResizeObserver.observe(tilesWrap);
}

function scheduleStageLayout() {
    if (stageLayoutRaf) return;
    stageLayoutRaf = requestAnimationFrame(() => {
        stageLayoutRaf = null;
        layoutStageTiles();
    });
}

function clampAspectRatio(rawRatio) {
    if (!Number.isFinite(rawRatio) || rawRatio <= 0) return 16 / 9;
    return Math.max(0.48, Math.min(2.45, rawRatio));
}

function syncTileAspectFromVideo(tile, vid) {
    if (!tile || !vid) return;
    if (vid.videoWidth > 0 && vid.videoHeight > 0) {
        const ratio = clampAspectRatio(vid.videoWidth / vid.videoHeight);
        const prev = parseFloat(tile.dataset.ratio || "0");
        if (Math.abs(prev - ratio) > 0.01) {
            tile.dataset.ratio = String(ratio);
            scheduleStageLayout();
        }
    }
}

export function layoutStageTiles() {
    const stage = $("media-stage");
    const tilesWrap = $("stage-tiles");
    if (!stage || !tilesWrap || !stage.classList.contains("active")) return;

    const visibleTiles = Array.from(tilesWrap.querySelectorAll(".video-tile:not(.hidden-in-spot)"));
    if (!visibleTiles.length) return;

    const W = tilesWrap.clientWidth;
    const H = tilesWrap.clientHeight;
    if (W < 40 || H < 40) {
        scheduleStageLayout();
        return;
    }

    const N = visibleTiles.length;
    const gap = N === 1 ? 0 : 10;
    const ratios = visibleTiles.map((t) => clampAspectRatio(parseFloat(t.dataset.ratio || String(16 / 9))));

    let bestCols = 1;
    let bestArea = -1;
    let bestSizes = [];

    for (let cols = 1; cols <= N; cols++) {
        const rows = Math.ceil(N / cols);
        const cellW = Math.floor((W - gap * (cols - 1)) / cols);
        const cellH = Math.floor((H - gap * (rows - 1)) / rows);
        if (cellW < 60 || cellH < 45) continue;

        let totalArea = 0;
        const sizes = [];

        for (let i = 0; i < N; i++) {
            const r = ratios[i];
            let w;
            let h;
            if (cellW / cellH > r) {
                h = cellH;
                w = Math.floor(h * r);
            } else {
                w = cellW;
                h = Math.floor(w / r);
            }
            w = Math.max(60, Math.min(cellW, w));
            h = Math.max(45, Math.min(cellH, h));
            totalArea += w * h;
            sizes.push({ w, h });
        }

        if (totalArea > bestArea) {
            bestArea = totalArea;
            bestCols = cols;
            bestSizes = sizes;
        }
    }

    if (!bestSizes.length) {
        const fallbackW = Math.max(120, Math.floor(W));
        const fallbackH = Math.max(90, Math.floor(H));
        bestCols = 1;
        bestSizes = ratios.map((r) => {
            if (fallbackW / fallbackH > r) return { w: Math.floor(fallbackH * r), h: fallbackH };
            return { w: fallbackW, h: Math.floor(fallbackW / r) };
        });
    }

    tilesWrap.style.gridTemplateColumns = `repeat(${bestCols}, auto)`;
    tilesWrap.style.gap = `${gap}px`;

    visibleTiles.forEach((tile, idx) => {
        const sz = bestSizes[idx];
        if (!sz) return;
        tile.style.width = `${sz.w}px`;
        tile.style.height = `${sz.h}px`;
    });
}

export function updateStageLayout() {
    const stage = $("media-stage");
    const tilesWrap = $("stage-tiles");
    if (!stage || !tilesWrap) return;

    const tiles = Array.from(tilesWrap.querySelectorAll(".video-tile"));

    if (!tiles.length) {
        stage.classList.remove("active", "expanded");
        state.spotlightTileId = null;
        if ($("btn-exit-spotlight")) $("btn-exit-spotlight").style.display = "none";
        if ($("btn-expand-stage")) $("btn-expand-stage").textContent = "Genişlet";
        return;
    }

    stage.classList.add("active");
    ensureStageObserver();

    if ($("stage-count-lbl")) {
        $("stage-count-lbl").textContent = `Canlı Sahne (${tiles.length} yayın)`;
    }

    const spotExists = state.spotlightTileId && document.getElementById("tile-" + state.spotlightTileId);
    if (!spotExists) state.spotlightTileId = null;

    tilesWrap.classList.toggle("spotlight", Boolean(state.spotlightTileId));
    if ($("btn-exit-spotlight")) {
        $("btn-exit-spotlight").style.display = state.spotlightTileId ? "" : "none";
    }

    tiles.forEach((t) => {
        const tid = t.id.replace(/^tile-/, "");
        t.classList.toggle("hidden-in-spot", Boolean(state.spotlightTileId && tid !== state.spotlightTileId));
    });

    scheduleStageLayout();
}

export function toggleSpotlight(tileKey) {
    state.spotlightTileId = state.spotlightTileId === tileKey ? null : tileKey;
    updateStageLayout();
}

export function showMediaTile(tileKey, label, stream, { kind = "cam", isLocal = false } = {}) {
    const id = "tile-" + tileKey;
    let tile = document.getElementById(id);
    if (!tile) {
        tile = document.createElement("div");
        tile.id = id;
        tile.className = "video-tile";
        tile.dataset.tileKind = kind;
        tile.dataset.ratio = String(16 / 9);
        tile.onclick = () => toggleSpotlight(tileKey);

        const video = document.createElement("video");
        video.autoplay = true;
        video.playsInline = true;
        video.muted = true;
        if (kind === "cam") video.classList.add("cover");
        if (isLocal && kind === "cam" && state.mirrorCam) video.classList.add("mirrored");

        video.addEventListener("loadedmetadata", () => syncTileAspectFromVideo(tile, video));
        video.addEventListener("resize", () => syncTileAspectFromVideo(tile, video));

        const fsBtn = document.createElement("button");
        fsBtn.type = "button";
        fsBtn.className = "tile-fs-btn";
        fsBtn.title = "Tam Ekran";
        fsBtn.textContent = "⛶";
        fsBtn.onclick = (e) => {
            e.stopPropagation();
            if (document.fullscreenElement === tile) {
                document.exitFullscreen?.().catch(() => { });
            } else {
                tile.requestFullscreen?.().catch(() => { });
            }
        };

        const lbl = document.createElement("div");
        lbl.className = "tile-label";
        lbl.textContent = label;

        tile.appendChild(video);
        tile.appendChild(fsBtn);
        tile.appendChild(lbl);
        $("stage-tiles")?.appendChild(tile);
    }

    const vid = tile.querySelector("video");
    if (vid) {
        if (vid.srcObject !== stream) vid.srcObject = stream;
        vid.classList.toggle("cover", kind === "cam");
        if (isLocal && kind === "cam") vid.classList.toggle("mirrored", state.mirrorCam);
        vid.play().catch(() => { });

        const vTrack = stream?.getVideoTracks?.()[0];
        const ts = vTrack?.getSettings?.();
        if (ts?.width > 0 && ts?.height > 0) {
            tile.dataset.ratio = String(clampAspectRatio(ts.width / ts.height));
        }
        syncTileAspectFromVideo(tile, vid);
    }
    const lblEl = tile.querySelector(".tile-label");
    if (lblEl) lblEl.textContent = label;

    updateStageLayout();
}

export function removeMediaTile(tileKey) {
    const tile = document.getElementById("tile-" + tileKey);
    if (tile) {
        if (document.fullscreenElement === tile) {
            document.exitFullscreen?.().catch(() => { });
        }
        const vid = tile.querySelector("video");
        if (vid) {
            try {
                vid.pause();
                vid.srcObject = null;
            } catch { }
        }
        tile.remove();
    }
    if (state.spotlightTileId === tileKey) state.spotlightTileId = null;
    updateStageLayout();
}

// Sunucu durumuyla uzak kamera/ekran kutularını senkronize et (hayalet kutuları temizle)
export function reconcileRemoteMediaWithMembers(memberList) {
    if (!state.voiceChannelId) return;
    const activeIdsInVoice = new Set();

    for (const m of memberList || []) {
        if (!m.online || !m.id || m.voiceChannel !== state.voiceChannelId) continue;
        activeIdsInVoice.add(m.id);
        if (m.id === socket.id) continue;

        if (!m.camOn) removeMediaTile("cam-" + m.id);
        if (!m.screenSharing) removeMediaTile("screen-" + m.id);
    }

    const stageTiles = $("stage-tiles");
    if (!stageTiles) return;
    for (const tile of Array.from(stageTiles.querySelectorAll(".video-tile"))) {
        const tid = tile.id.replace(/^tile-/, "");
        if (tid === "cam-local" || tid === "screen-local") continue;
        const pid = tid.replace(/^(cam|screen)-/, "");
        if (pid && !activeIdsInVoice.has(pid) && !state.peers.has(pid)) {
            removeMediaTile(tid);
        }
    }
}

// =========================================================================
// DISCORD TARZI AKIM ETİKETLEME (MID / TRACKID / STREAMID HARİTASI)
// =========================================================================
function findTransceiverMid(pc, sender) {
    if (!pc || !sender) return null;
    try {
        const t = pc.getTransceivers().find((tr) => tr.sender === sender);
        return t?.mid ?? null;
    } catch {
        return null;
    }
}

function buildLocalTrackMeta(peer) {
    const mids = {};
    const tracks = {};
    const streams = {};

    const register = (sender, streamObj, kind) => {
        if (!sender || !sender.track) return;
        tracks[sender.track.id] = kind;
        const mid = findTransceiverMid(peer.pc, sender);
        if (mid !== null && mid !== undefined) mids[String(mid)] = kind;
        if (streamObj?.id) streams[streamObj.id] = kind;
    };

    register(peer.micSender, state.processedMicStream, "mic");
    register(peer.camSender, state.camStream, "cam");
    register(peer.screenVideoSender, state.screenStream, "screen");
    register(peer.screenAudioSender, state.screenStream, "screen-audio");

    return { mids, tracks, streams };
}

function applyRemoteTrackMeta(peerId, peer, meta) {
    if (!meta || typeof meta !== "object") return;
    peer.remoteMeta = {
        mids: { ...(meta.mids || {}) },
        tracks: { ...(meta.tracks || {}) },
        streams: { ...(meta.streams || {}) }
    };

    const activeKinds = new Set([
        ...Object.values(peer.remoteMeta.mids),
        ...Object.values(peer.remoteMeta.tracks)
    ]);
    if (!activeKinds.has("cam")) {
        const m = state.voiceMembersCache.get(peerId);
        if (!m || !m.camOn) removeMediaTile("cam-" + peerId);
    }
    if (!activeKinds.has("screen")) {
        const m = state.voiceMembersCache.get(peerId);
        if (!m || !m.screenSharing) removeMediaTile("screen-" + peerId);
    }
}

function resolveRemoteTrackKind(peerId, peer, track, stream, transceiver) {
    const mid = transceiver?.mid;
    if (mid !== null && mid !== undefined && peer.remoteMeta?.mids?.[String(mid)]) {
        return peer.remoteMeta.mids[String(mid)];
    }
    if (track?.id && peer.remoteMeta?.tracks?.[track.id]) {
        return peer.remoteMeta.tracks[track.id];
    }
    if (stream?.id && peer.remoteMeta?.streams?.[stream.id]) {
        return peer.remoteMeta.streams[stream.id];
    }

    const m = state.voiceMembersCache.get(peerId) || state.members.find((x) => x.id === peerId);
    if (track.kind === "audio") {
        if (m?.screenStreamId && stream?.id === m.screenStreamId) return "screen-audio";
        return "mic";
    }

    if (m?.screenStreamId && stream?.id === m.screenStreamId) return "screen";
    if (m?.camStreamId && stream?.id === m.camStreamId) return "cam";
    if (m?.screenSharing && !m?.camOn) return "screen";
    if (m?.camOn && !m?.screenSharing) return "cam";
    if (document.getElementById("tile-cam-" + peerId)) return "screen";
    return "cam";
}

// =========================================================================
// VİDEO KALİTE / BITRATE / CONTENT HINT (DISCORD OPTİMİZASYONU)
// =========================================================================
export function getCamConstraints() {
    const q = parseInt($("cam-quality")?.value, 10) || 480;
    const map = {
        360: { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 15, max: 20 } },
        480: { width: { ideal: 854 }, height: { ideal: 480 }, frameRate: { ideal: 24, max: 24 } },
        720: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } }
    };
    const base = map[q] || map[480];
    const devId = $("cam-select")?.value;
    return {
        video: devId ? { ...base, deviceId: { exact: devId } } : { ...base, facingMode: state.facingMode },
        audio: false
    };
}

async function applyVideoSenderTuning(sender, kind, res = 480) {
    if (!sender) return;
    try {
        if (sender.track && "contentHint" in sender.track) {
            sender.track.contentHint = kind === "screen" ? "detail" : "motion";
        }
    } catch { }

    if (typeof sender.getParameters !== "function") return;
    try {
        const params = sender.getParameters();
        if (!params.encodings || !params.encodings.length) params.encodings = [{}];
        if (kind === "screen") {
            params.encodings[0].maxBitrate = res >= 1080 ? 2500000 : 1500000;
            params.degradationPreference = "maintain-resolution";
        } else {
            params.encodings[0].maxBitrate = res >= 720 ? 900000 : (res <= 360 ? 350000 : 550000);
            params.degradationPreference = "balanced";
        }
        await sender.setParameters(params);
    } catch { }
}

// =========================================================================
// PERFECT NEGOTIATION + GLARE-FREE JOIN + SIRALI SİNYAL KUYRUĞU
// =========================================================================
function enqueuePeerOp(peer, fn) {
    peer.queue = peer.queue
        .then(() => {
            if (peer.closed) return;
            return fn();
        })
        .catch(() => { });
    return peer.queue;
}

function isSenderActiveOnPc(pc, sender, expectedTrack) {
    if (!pc || !sender || !expectedTrack) return false;
    if (sender.track !== expectedTrack) return false;
    try {
        const tr = pc.getTransceivers().find((t) => t.sender === sender);
        if (!tr || tr.stopped) return false;
        return tr.direction === "sendonly" || tr.direction === "sendrecv";
    } catch {
        return false;
    }
}

function attachLocalMicOnly(peer) {
    if (peer.closed || !state.processedMicStream) return false;
    const mt = state.processedMicStream.getAudioTracks()[0];
    if (mt && mt.readyState === "live" && !isSenderActiveOnPc(peer.pc, peer.micSender, mt)) {
        peer.micSender = peer.pc.addTrack(mt, state.processedMicStream);
        return true;
    }
    return false;
}

function ensureLocalTracksAttached(peerId, peer) {
    if (peer.closed) return false;
    let changed = attachLocalMicOnly(peer);

    if (state.camStream) {
        const ct = state.camStream.getVideoTracks()[0];
        if (ct && ct.readyState === "live" && !isSenderActiveOnPc(peer.pc, peer.camSender, ct)) {
            peer.camSender = peer.pc.addTrack(ct, state.camStream);
            applyVideoSenderTuning(peer.camSender, "cam", parseInt($("cam-quality")?.value, 10) || 480);
            changed = true;
        }
    }

    if (state.screenStream) {
        const svt = state.screenStream.getVideoTracks()[0];
        const sat = state.screenStream.getAudioTracks()[0];
        const resVal = parseInt($("screen-res")?.value, 10) || 720;

        if (svt && svt.readyState === "live" && !isSenderActiveOnPc(peer.pc, peer.screenVideoSender, svt)) {
            peer.screenVideoSender = peer.pc.addTrack(svt, state.screenStream);
            applyVideoSenderTuning(peer.screenVideoSender, "screen", resVal);
            changed = true;
        }
        if (sat && sat.readyState === "live" && !isSenderActiveOnPc(peer.pc, peer.screenAudioSender, sat)) {
            peer.screenAudioSender = peer.pc.addTrack(sat, state.screenStream);
            changed = true;
        }
    }

    // Rollback veya geç katılım sonrası müzakere edilmemiş (mikrofon dahil) gönderici varsa yakala
    if (!changed && peer.pc.signalingState === "stable") {
        const checkUnnegotiated = (sender) => {
            if (!sender || !sender.track) return false;
            try {
                const tr = peer.pc.getTransceivers().find((t) => t.sender === sender);
                if (!tr || tr.stopped) return false;
                const wantsSend = tr.direction === "sendonly" || tr.direction === "sendrecv";
                const curSends = tr.currentDirection === "sendonly" || tr.currentDirection === "sendrecv";
                return wantsSend && !curSends;
            } catch {
                return false;
            }
        };
        if (
            checkUnnegotiated(peer.micSender) ||
            checkUnnegotiated(peer.camSender) ||
            checkUnnegotiated(peer.screenVideoSender) ||
            checkUnnegotiated(peer.screenAudioSender)
        ) {
            changed = true;
        }
    }

    if (changed) {
        scheduleNegotiation(peerId, false);
    }
    return changed;
}

export function scheduleNegotiation(peerId, iceRestart = false) {
    const peer = state.peers.get(peerId);
    if (!peer || peer.closed) return;

    if (iceRestart) peer.pendingIceRestart = true;
    peer.needsNegotiation = true;

    enqueuePeerOp(peer, async () => {
        if (peer.closed || !peer.needsNegotiation) return;
        if (peer.pc.signalingState !== "stable") return;

        const doRestart = Boolean(peer.pendingIceRestart);
        peer.needsNegotiation = false;
        peer.pendingIceRestart = false;

        try {
            peer.makingOffer = true;
            const offer = await peer.pc.createOffer(doRestart ? { iceRestart: true } : undefined);
            if (peer.pc.signalingState !== "stable") {
                peer.needsNegotiation = true;
                return;
            }
            offer.sdp = optimizeOpusSDP(offer.sdp);
            await peer.pc.setLocalDescription(offer);
            const desc = peer.pc.localDescription;
            socket.emit("webrtc-offer", {
                to: peerId,
                offer: {
                    type: desc.type,
                    sdp: desc.sdp,
                    meta: buildLocalTrackMeta(peer)
                }
            });
        } catch {
            peer.needsNegotiation = true;
        } finally {
            peer.makingOffer = false;
        }
    });
}

export function sendOfferToPeer(peerId, iceRestart = false) {
    getOrCreatePeer(peerId, { autoAttach: true });
    scheduleNegotiation(peerId, iceRestart);
}

async function flushCandidates(peer) {
    const q = peer.pendingCandidates;
    peer.pendingCandidates = [];
    for (const c of q) {
        if (peer.closed) break;
        await peer.pc.addIceCandidate(c).catch(() => { });
    }
}

export function getOrCreatePeer(peerId, { autoAttach = true } = {}) {
    if (state.peers.has(peerId)) return state.peers.get(peerId);

    const pc = new RTCPeerConnection({
        iceServers: state.voiceIceServers,
        iceCandidatePoolSize: 2
    });

    const peer = {
        id: peerId,
        pc,
        closed: false,
        createdAt: Date.now(),
        polite: socket.id < peerId,
        makingOffer: false,
        ignoreOffer: false,
        needsNegotiation: false,
        pendingIceRestart: false,
        autoIceRestarted: false,
        joinFallbackTimer: null,
        queue: Promise.resolve(),
        pendingCandidates: [],
        micSender: null,
        camSender: null,
        screenVideoSender: null,
        screenAudioSender: null,
        remoteMeta: { mids: {}, tracks: {}, streams: {} },
        audioNodes: [],
        lastStats: null
    };

    state.peers.set(peerId, peer);

    pc.onnegotiationneeded = () => {
        if (peer.closed) return;
        scheduleNegotiation(peerId, false);
    };

    pc.onicecandidate = (e) => {
        if (e.candidate && !peer.closed) {
            socket.emit("webrtc-ice", { to: peerId, candidate: e.candidate });
        }
    };

    pc.oniceconnectionstatechange = () => {
        if (peer.closed) return;
        hooks.updateHealthPill(state.lastPingMs);

        const st = pc.iceConnectionState;
        if (st === "connected" || st === "completed") {
            peer.autoIceRestarted = false;
        } else if (st === "failed") {
            if (!peer.autoIceRestarted) {
                peer.autoIceRestarted = true;
                setTimeout(() => {
                    if (!peer.closed && (pc.iceConnectionState === "failed" || pc.iceConnectionState === "disconnected")) {
                        scheduleNegotiation(peerId, true);
                    }
                }, 1200);
            } else if (!state.turnAlertShownForChannel && !state.hasTurnConfigured) {
                state.turnAlertShownForChannel = true;
                showToast(
                    "P2P bağlantısı kurulamadı (CGNAT / Aynı ağ NAT engeli). Kesintisiz iletişim için TURN sunucusu gerekli — detaylar için 🩺 paneline bak.",
                    "err",
                    6500
                );
            }
        }
    };

    pc.onconnectionstatechange = () => {
        if (peer.closed) return;
        hooks.updateHealthPill(state.lastPingMs);
    };

    pc.ontrack = (e) => {
        if (peer.closed) return;
        if (e.receiver && "playoutDelayHint" in e.receiver) {
            e.receiver.playoutDelayHint = 0;
        }
        const stream = (e.streams && e.streams[0]) || new MediaStream([e.track]);
        const kind = resolveRemoteTrackKind(peerId, peer, e.track, stream, e.transceiver);

        if (e.track.kind === "audio") {
            attachRemoteAudio(peerId, peer, e.track, stream, { isMic: kind !== "screen-audio" });
            return;
        }

        if (e.track.kind === "video") {
            const tileKind = kind === "screen" ? "screen" : "cam";
            const m = state.voiceMembersCache.get(peerId) || state.members.find((x) => x.id === peerId);
            const name = m?.displayName || m?.username || "Arkadaş";
            const tileKey = `${tileKind}-${peerId}`;
            const icon = tileKind === "screen" ? "🖥️" : "📹";

            const videoOnlyStream = new MediaStream([e.track]);
            showMediaTile(tileKey, `${icon} ${name}`, videoOnlyStream, { kind: tileKind, isLocal: false });

            const cleanupTileIfCurrent = () => {
                const tileEl = document.getElementById("tile-" + tileKey);
                const curVid = tileEl?.querySelector("video");
                const curTrack = curVid?.srcObject?.getVideoTracks?.()[0];
                if (!curTrack || curTrack.id === e.track.id) {
                    removeMediaTile(tileKey);
                }
            };

            e.track.addEventListener("ended", cleanupTileIfCurrent, { once: true });
            e.track.addEventListener("mute", () => {
                setTimeout(() => {
                    if (peer.closed) return;
                    const memberNow = state.voiceMembersCache.get(peerId) || state.members.find((x) => x.id === peerId);
                    const memberStopped = tileKind === "cam" ? memberNow && !memberNow.camOn : memberNow && !memberNow.screenSharing;
                    const trDir = e.transceiver?.currentDirection;
                    const stoppedBySdp = trDir === "inactive" || trDir === "sendonly" || e.transceiver?.stopped;
                    if (e.track.readyState === "ended" || memberStopped || stoppedBySdp) {
                        cleanupTileIfCurrent();
                    }
                }, 700);
            });
            e.track.addEventListener("unmute", () => {
                if (peer.closed) return;
                const mNow = state.voiceMembersCache.get(peerId) || state.members.find((x) => x.id === peerId);
                const nNow = mNow?.displayName || mNow?.username || "Arkadaş";
                showMediaTile(tileKey, `${icon} ${nNow}`, videoOnlyStream, { kind: tileKind, isLocal: false });
            });
        }
    };

    if (autoAttach) {
        ensureLocalTracksAttached(peerId, peer);
    }

    return peer;
}

export function handleIncomingOffer(from, offer) {
    if (!state.voiceChannelId || !from || !offer) return;
    // Gelen offer'da önce tracksiz peer açılır ki setRemoteDescription sonrası mikrofon doğrudan sendrecv bağlansın
    const peer = getOrCreatePeer(from, { autoAttach: false });
    if (peer.joinFallbackTimer) {
        clearTimeout(peer.joinFallbackTimer);
        peer.joinFallbackTimer = null;
    }

    enqueuePeerOp(peer, async () => {
        if (peer.closed) return;

        if (offer.meta) {
            applyRemoteTrackMeta(from, peer, offer.meta);
        }

        const offerCollision = peer.makingOffer || peer.pc.signalingState !== "stable";
        peer.ignoreOffer = !peer.polite && offerCollision;
        if (peer.ignoreOffer) return;

        try {
            const cleanOffer = { type: offer.type, sdp: offer.sdp };
            if (offerCollision) {
                await peer.pc.setLocalDescription({ type: "rollback" }).catch(() => { });
            }
            await peer.pc.setRemoteDescription(cleanOffer);
            await flushCandidates(peer);

            // Mikrofonu createAnswer'dan önce bağla -> tek turda çift yönlü (sendrecv) ses kurulur
            attachLocalMicOnly(peer);

            const answer = await peer.pc.createAnswer();
            answer.sdp = optimizeOpusSDP(answer.sdp);
            await peer.pc.setLocalDescription(answer);

            const desc = peer.pc.localDescription;
            socket.emit("webrtc-answer", {
                to: from,
                answer: {
                    type: desc.type,
                    sdp: desc.sdp,
                    meta: buildLocalTrackMeta(peer)
                }
            });

            // Mikrofon zaten answer ile müzakere edildi; yalnızca aktif kamera/ekran veya eksik gönderici varsa re-offer at
            peer.needsNegotiation = false;
            ensureLocalTracksAttached(from, peer);
        } catch { }
    });
}

export function handleIncomingAnswer(from, answer) {
    const peer = state.peers.get(from);
    if (!peer || !answer) return;

    enqueuePeerOp(peer, async () => {
        if (peer.closed) return;
        if (answer.meta) {
            applyRemoteTrackMeta(from, peer, answer.meta);
        }
        if (peer.pc.signalingState !== "have-local-offer") return;

        try {
            const cleanAnswer = { type: answer.type, sdp: answer.sdp };
            await peer.pc.setRemoteDescription(cleanAnswer);
            await flushCandidates(peer);

            if (peer.needsNegotiation && peer.pc.signalingState === "stable") {
                scheduleNegotiation(from, false);
            }
        } catch { }
    });
}

export function handleIncomingIce(from, candidate) {
    const peer = state.peers.get(from);
    if (!peer || !candidate || peer.closed) return;

    if (peer.pc.remoteDescription && peer.pc.remoteDescription.type) {
        peer.pc.addIceCandidate(candidate).catch(() => { });
    } else {
        peer.pendingCandidates.push(candidate);
    }
}

export function handlePeerJoinedVoice({ peerId, serverId, channelId }) {
    if (!peerId || peerId === socket.id) return;
    if (serverId !== state.voiceServerId || channelId !== state.voiceChannelId) return;

    // İlk offer'ı yeni katılan kişi atar (glare olmaz). 3 sn içinde gelmezse yedek olarak biz başlatırız.
    const peer = getOrCreatePeer(peerId, { autoAttach: false });
    if (peer.joinFallbackTimer) clearTimeout(peer.joinFallbackTimer);
    peer.joinFallbackTimer = setTimeout(() => {
        peer.joinFallbackTimer = null;
        if (!peer.closed && !peer.pc.remoteDescription && peer.pc.signalingState === "stable") {
            ensureLocalTracksAttached(peerId, peer);
        }
    }, 3000);
}

export function closePeer(peerId) {
    const peer = state.peers.get(peerId);
    if (peer) {
        peer.closed = true;
        if (peer.joinFallbackTimer) {
            clearTimeout(peer.joinFallbackTimer);
            peer.joinFallbackTimer = null;
        }
        peer.audioNodes.slice().forEach((n) => cleanupRemoteAudioNode(peer, n));
        try {
            peer.pc.onnegotiationneeded = null;
            peer.pc.onicecandidate = null;
            peer.pc.ontrack = null;
            peer.pc.oniceconnectionstatechange = null;
            peer.pc.onconnectionstatechange = null;
            peer.pc.close();
        } catch { }
        state.peers.delete(peerId);
    }
    setSpeakingState(peerId, false);
    removeMediaTile("cam-" + peerId);
    removeMediaTile("screen-" + peerId);
    hooks.updateHealthPill(state.lastPingMs);
}

// =========================================================================
// SES KANALI YAŞAM DÖNGÜSÜ
// =========================================================================
export function refreshVoiceMembersCacheFrom(memberList) {
    state.voiceMembersCache.clear();
    if (!state.voiceChannelId) return;
    for (const m of memberList || []) {
        if (m.online && m.id && m.voiceChannel === state.voiceChannelId) {
            state.voiceMembersCache.set(m.id, m);
        }
    }
    reconcileRemoteMediaWithMembers(memberList);
    pushOverlayState();
}

export function updateVoicePanelUI() {
    const connected = Boolean(state.voiceChannelId);
    if ($("voice-conn-wrap")) $("voice-conn-wrap").style.display = connected ? "flex" : "none";
    if ($("mobile-voice-bar")) $("mobile-voice-bar").classList.toggle("active", connected);

    if (connected) {
        const srv = state.myServers.find((s) => s.id === state.voiceServerId);
        const ch = state.voiceServerId === state.activeServerId
            ? state.channels.find((c) => c.id === state.voiceChannelId)
            : null;
        if ($("voice-status")) $("voice-status").textContent = "Ses Bağlı";
        if ($("voice-channel-sub")) {
            $("voice-channel-sub").textContent = ch
                ? `${ch.name}`
                : (srv ? `${srv.name} (Ses)` : "Aktif Kanal");
        }
    }
    applyMuteState();
}

export async function joinVoiceChannel(serverId, channelId) {
    ensureSharedAudioCtx();
    if (!state.processedMicStream) {
        try {
            await buildMicPipeline();
        } catch (err) {
            showToast("Mikrofon açılamadı: " + err.message, "err");
            return;
        }
    }

    if (state.voiceChannelId) {
        stopCamera(true);
        stopScreenShare(true);
        for (const pid of Array.from(state.peers.keys())) closePeer(pid);
    }

    socket.emit("join-voice", { serverId, channelId }, async (res) => {
        if (!res || res.ok === false) {
            showToast(res?.error || "Ses kanalına katılınamadı.", "err");
            return;
        }

        state.voiceServerId = serverId;
        state.voiceChannelId = channelId;
        state.turnAlertShownForChannel = false;

        if (Array.isArray(res.iceServers) && res.iceServers.length) {
            state.voiceIceServers = res.iceServers;
        }
        state.hasTurnConfigured = Boolean(res.hasTurnConfigured);

        if (state.voiceServerId === state.activeServerId) {
            refreshVoiceMembersCacheFrom(state.members);
        }
        if (Array.isArray(res.peerStates)) {
            for (const ps of res.peerStates) {
                const prev = state.voiceMembersCache.get(ps.id) || {};
                state.voiceMembersCache.set(ps.id, { ...prev, ...ps });
            }
        }

        if (res.isAfkChannel) {
            state.selfMuted = true;
            socket.emit("voice-status-update", { selfMuted: true });
        }

        playTone(680, 0.08);
        updateVoicePanelUI();
        hooks.renderServerRail();
        hooks.renderChannels();

        const peerIds = Array.isArray(res.peers) ? res.peers : [];
        if (peerIds.length >= 7) {
            showToast(`Odada ${peerIds.length + 1} kişi var: Kamera/yayın açarken ping ve CPU'yu Dinamik Panelden takip et.`, "info", 4200);
        }

        for (const pid of peerIds) {
            sendOfferToPeer(pid, false);
        }
    });
}

export function leaveVoiceCleanup(notifyServer = true) {
    if (!state.voiceChannelId) return;
    stopCamera(true);
    stopScreenShare(true);

    for (const pid of Array.from(state.peers.keys())) closePeer(pid);
    state.peers.clear();
    state.speakingMap.clear();
    state.voiceMembersCache.clear();

    stopMicPipeline();

    state.voiceServerId = null;
    state.voiceChannelId = null;
    state.selfMuted = false;
    state.deafened = false;
    state.turnAlertShownForChannel = false;

    if (notifyServer) socket.emit("leave-voice");
    playTone(340, 0.09);
    updateVoicePanelUI();
    hooks.renderServerRail();
    hooks.renderChannels();
    hooks.renderMembers();
    pushOverlayState(true);
}

export async function handleVoiceAfkMoved({ serverId, channelId, channelName, reason, peers: targetPeers }) {
    stopCamera(true);
    stopScreenShare(true);
    for (const pid of Array.from(state.peers.keys())) closePeer(pid);

    state.voiceServerId = serverId;
    state.voiceChannelId = channelId;
    state.selfMuted = true;
    state.turnAlertShownForChannel = false;
    applyMuteState();
    updateVoicePanelUI();
    hooks.renderChannels();
    playTone(300, 0.14, "triangle", 0.08);

    showToast(
        reason === "auto-afk"
            ? `Uzun süre sessiz kaldığınız için "${channelName}" odasına taşındınız.`
            : `Bir yetkili sizi "${channelName}" odasına taşıdı.`,
        "info",
        4500
    );

    for (const pid of targetPeers || []) {
        sendOfferToPeer(pid, false);
    }
}

// =========================================================================
// KAMERA PAYLAŞIMI (YARIŞ KORUMALI & HAYALET İKONSUZ)
// =========================================================================
export function updateCamButtonsUI(on) {
    $("btn-cam")?.classList.toggle("on", on);
    $("m-btn-cam")?.classList.toggle("on", on);
    const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    if ($("btn-flip-cam")) $("btn-flip-cam").style.display = on && isMobile ? "" : "none";
    if ($("m-btn-flip")) $("m-btn-flip").style.display = on && isMobile ? "" : "none";
}

export async function toggleCamera() {
    if (!state.voiceChannelId) return showToast("Kamera açmak için önce bir ses kanalına katıl.", "info");
    if (state.camStream || state.camBusy) {
        stopCamera(false);
        return;
    }

    const attemptId = ++state.camAttemptId;
    state.camBusy = true;

    let stream = null;
    try {
        stream = await navigator.mediaDevices.getUserMedia(getCamConstraints());
    } catch (err) {
        state.camBusy = false;
        return showToast("Kamera açılamadı: " + err.message, "err");
    }

    if (attemptId !== state.camAttemptId || !state.voiceChannelId) {
        stream.getTracks().forEach((t) => t.stop());
        state.camBusy = false;
        return;
    }

    state.camBusy = false;
    state.camStream = stream;

    const vTrack = state.camStream.getVideoTracks()[0];
    if ("contentHint" in vTrack) vTrack.contentHint = "motion";
    vTrack.addEventListener("ended", () => {
        if (state.camStream === stream) stopCamera(false);
    }, { once: true });

    showMediaTile("cam-local", `📹 ${state.me.displayName || state.me.username} (Sen)`, state.camStream, {
        kind: "cam",
        isLocal: true
    });
    updateCamButtonsUI(true);
    socket.emit("voice-status-update", { camOn: true, camStreamId: state.camStream.id });

    const q = parseInt($("cam-quality")?.value, 10) || 480;
    for (const [peerId, peer] of state.peers.entries()) {
        if (peer.closed) continue;
        peer.camSender = peer.pc.addTrack(vTrack, state.camStream);
        await applyVideoSenderTuning(peer.camSender, "cam", q);
        scheduleNegotiation(peerId, false);
    }
}

export async function restartCameraTrack() {
    if (!state.camStream) return;
    try {
        const nextStream = await navigator.mediaDevices.getUserMedia(getCamConstraints());
        const newTrack = nextStream.getVideoTracks()[0];
        if ("contentHint" in newTrack) newTrack.contentHint = "motion";

        const oldTrack = state.camStream.getVideoTracks()[0];
        state.camStream.removeTrack(oldTrack);
        oldTrack.stop();
        state.camStream.addTrack(newTrack);

        const activeRef = state.camStream;
        newTrack.addEventListener("ended", () => {
            if (state.camStream === activeRef) stopCamera(false);
        }, { once: true });

        const q = parseInt($("cam-quality")?.value, 10) || 480;
        for (const peer of state.peers.values()) {
            if (peer.camSender) {
                await peer.camSender.replaceTrack(newTrack).catch(() => { });
                await applyVideoSenderTuning(peer.camSender, "cam", q);
            }
        }
        showMediaTile("cam-local", `📹 ${state.me.displayName || state.me.username} (Sen)`, state.camStream, {
            kind: "cam",
            isLocal: true
        });
    } catch (err) {
        showToast("Kamera değiştirilemedi: " + err.message, "err");
    }
}

export function flipCamera() {
    state.facingMode = state.facingMode === "user" ? "environment" : "user";
    if ($("cam-select")) $("cam-select").value = "";
    restartCameraTrack();
}

export function stopCamera(silent = false) {
    state.camAttemptId++;
    state.camBusy = false;

    const hadStream = Boolean(state.camStream);
    if (state.camStream) {
        state.camStream.getTracks().forEach((t) => {
            try { t.stop(); } catch { }
        });
        state.camStream = null;
    }

    removeMediaTile("cam-local");
    updateCamButtonsUI(false);

    for (const [peerId, peer] of state.peers.entries()) {
        if (peer.camSender) {
            try { peer.pc.removeTrack(peer.camSender); } catch { }
            peer.camSender = null;
            if (!silent) scheduleNegotiation(peerId, false);
        }
    }

    if (!silent) {
        socket.emit("voice-status-update", { camOn: false, camStreamId: null });
        if (hadStream) socket.emit("cam-stopped");
    }
}

// =========================================================================
// EKRAN PAYLAŞIMI (DISCORD MODELİ: AYRI VİDEO + AYRI SİSTEM SESİ)
// =========================================================================
export async function openScreenShareFlow() {
    if (!state.voiceChannelId) return showToast("Ekran paylaşmak için önce bir ses kanalına katıl.", "info");
    if (state.screenStream || state.screenBusy) {
        stopScreenShare(false);
        return;
    }

    if (isElectron) {
        const sources = await window.electronAPI.getScreenSources();
        const grid = $("source-grid");
        if (!grid) return;
        grid.innerHTML = "";
        state.selectedScreenSourceId = sources[0]?.id || null;

        sources.forEach((src, idx) => {
            const card = document.createElement("div");
            card.className = "source-card" + (idx === 0 ? " selected" : "");
            card.innerHTML = `<img src="${src.thumbnail}" alt="" /><span>${escapeHTML(src.name)}</span>`;
            card.onclick = () => {
                grid.querySelectorAll(".source-card").forEach((c) => c.classList.remove("selected"));
                card.classList.add("selected");
                state.selectedScreenSourceId = src.id;
            };
            grid.appendChild(card);
        });
        openModal("screen-modal");
    } else {
        await startScreenCapture();
    }
}

export async function startScreenCapture() {
    if (!state.voiceChannelId) return;
    if (state.screenStream) stopScreenShare(false);

    const resVal = parseInt($("screen-res")?.value, 10) || 720;
    const fpsVal = parseInt($("screen-fps")?.value, 10) || 30;
    const withAudio = Boolean($("screen-audio")?.checked);

    const attemptId = ++state.screenAttemptId;
    state.screenBusy = true;

    if (isElectron) {
        await window.electronAPI.selectScreenSource({
            sourceId: state.selectedScreenSourceId,
            withAudio
        });
        closeModal("screen-modal");
    }

    let stream = null;
    try {
        stream = await navigator.mediaDevices.getDisplayMedia({
            video: {
                width: { ideal: resVal >= 1080 ? 1920 : 1280 },
                height: { ideal: resVal },
                frameRate: { ideal: fpsVal, max: fpsVal }
            },
            audio: withAudio
        });
    } catch {
        state.screenBusy = false;
        showToast("Ekran paylaşımı başlatılamadı.", "err");
        return;
    }

    if (attemptId !== state.screenAttemptId || !state.voiceChannelId) {
        stream.getTracks().forEach((t) => t.stop());
        state.screenBusy = false;
        return;
    }

    state.screenBusy = false;
    state.screenStream = stream;

    const vTrack = state.screenStream.getVideoTracks()[0];
    const aTrack = state.screenStream.getAudioTracks()[0] || null;
    if (vTrack && "contentHint" in vTrack) vTrack.contentHint = "detail";

    if (vTrack) {
        vTrack.addEventListener("ended", () => {
            if (state.screenStream === stream) stopScreenShare(false);
        }, { once: true });
    }

    $("btn-screen")?.classList.add("on");
    showMediaTile(
        "screen-local",
        `🖥️ ${state.me.displayName || state.me.username} (Ekranın)`,
        new MediaStream([vTrack]),
        { kind: "screen", isLocal: true }
    );
    socket.emit("voice-status-update", { screenSharing: true, screenStreamId: state.screenStream.id });

    for (const [peerId, peer] of state.peers.entries()) {
        if (peer.closed) continue;
        if (vTrack) {
            peer.screenVideoSender = peer.pc.addTrack(vTrack, state.screenStream);
            await applyVideoSenderTuning(peer.screenVideoSender, "screen", resVal);
        }
        if (aTrack) {
            peer.screenAudioSender = peer.pc.addTrack(aTrack, state.screenStream);
        }
        scheduleNegotiation(peerId, false);
    }
}

export function stopScreenShare(silent = false) {
    state.screenAttemptId++;
    state.screenBusy = false;

    const hadStream = Boolean(state.screenStream);
    if (state.screenStream) {
        state.screenStream.getTracks().forEach((t) => {
            try { t.stop(); } catch { }
        });
        state.screenStream = null;
    }

    $("btn-screen")?.classList.remove("on");
    removeMediaTile("screen-local");

    for (const [peerId, peer] of state.peers.entries()) {
        let removed = false;
        if (peer.screenVideoSender) {
            try { peer.pc.removeTrack(peer.screenVideoSender); } catch { }
            peer.screenVideoSender = null;
            removed = true;
        }
        if (peer.screenAudioSender) {
            try { peer.pc.removeTrack(peer.screenAudioSender); } catch { }
            peer.screenAudioSender = null;
            removed = true;
        }
        if (removed && !silent) scheduleNegotiation(peerId, false);
    }

    if (!silent) {
        socket.emit("voice-status-update", { screenSharing: false, screenStreamId: null });
        if (hadStream) socket.emit("screen-share-stopped");
    }
}