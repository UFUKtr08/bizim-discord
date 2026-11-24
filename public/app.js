(() => {
    "use strict";

    // =========================================================================
    // PWA SERVICE WORKER KAYDI
    // =========================================================================
    if ("serviceWorker" in navigator && !window.electronAPI) {
        window.addEventListener("load", () => {
            navigator.serviceWorker.register("/sw.js").catch(() => { });
        });
    }

    // =========================================================================
    // GLOBAL DURUM & SOCKET.IO
    // =========================================================================
    const socket = io();
    const isElectron = Boolean(window.electronAPI && window.electronAPI.isElectron);

    const ALLOWED_REACTIONS = ["👍", "😂", "🔥", "❤️", "👀", "🎯"];
    const SOUNDBOARD_ITEMS = [
        { id: "airhorn", icon: "📯", label: "Havalı Korna" },
        { id: "victory", icon: "🏆", label: "Zafer Fanfarı" },
        { id: "fail", icon: "🎺", label: "Fail Trombon" },
        { id: "headshot", icon: "🎯", label: "Headshot Ding" },
        { id: "countdown", icon: "⏱️", label: "3-2-1 Başla" },
        { id: "gg", icon: "✨", label: "GG Zil" },
        { id: "alert", icon: "🚨", label: "Baskın Alarmı" },
        { id: "laser", icon: "⚡", label: "Lazer Vuruşu" },
        { id: "drum", icon: "🥁", label: "Ba-Dum-Tss" },
        { id: "ping", icon: "🔔", label: "Dikkat Çek" }
    ];

    let me = null;
    let myServers = [];
    let activeServerId = null;
    let activeChannelId = null;

    // Aktif sunucu anlık verisi
    let serverSettings = null;
    let channels = [];
    let roles = [];
    let members = [];
    let messagesByChannel = {};
    let myPermissions = {};
    let myPower = 0;
    let isServerOwner = false;
    let activeReadyCheck = null;
    let serverPolls = [];
    let watchState = { active: false };
    let boardState = { active: false, strokes: [] };

    // Aktif ses bağlantısı (Sunucu değişse de kopmaz)
    let voiceServerId = null;
    let voiceChannelId = null;
    let voiceIceServers = [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun1.l.google.com:19302" },
        { urls: "stun:stun2.l.google.com:19302" }
    ];
    let voiceMembersCache = new Map(); // socketId -> member snapshot (overlay için)

    // Yerel DB önbelleği (Genel Yönetici için)
    let latestServerDB = null;

    // Sohbet yardımcıları
    let replyTarget = null;
    let unreadChannels = new Set();
    let typingUsers = new Map(); // channelId -> Map(username -> displayName)
    let typingTimeout = null;
    let isCurrentlyTyping = false;

    // 1-1 Fısıltı (DM) durumu
    let dmConversations = [];
    let activeDmPeer = null;
    let dmUnread = false;

    // WebRTC & Ses Motoru
    let sharedAudioCtx = null;
    let masterOutGain = null;
    let rawMicStream = null;
    let processedMicStream = null;
    let micSourceNode = null;
    let highPassNode = null;
    let micAnalyserNode = null;
    let noiseGateNode = null;
    let compressorNode = null;
    let micGainNode = null;
    let micDestNode = null;

    let camStream = null;
    let screenStream = null;
    let facingMode = "user";
    let spotlightTileId = null;
    let selectedScreenSourceId = null;

    const peers = new Map(); // socketId -> peer obj
    const speakingMap = new Map(); // socketId -> boolean
    const userVolumes = loadSavedVolumes(); // username -> 0..2

    let selfMuted = false;
    let serverMuted = false;
    let deafened = false;
    let pttEnabled = localStorage.getItem("bd_ptt") === "1";
    let pttKey = localStorage.getItem("bd_ptt_key") || "KeyV";
    let pttPressed = false;
    let awaitingPttKey = false;
    let gateThreshold = parseInt(localStorage.getItem("bd_gate") || "22", 10);
    let gateOpen = false;
    let gateHoldUntil = 0;
    let soundboardVolume = parseInt(localStorage.getItem("bd_sb_vol") || "75", 10);
    let gameMode = localStorage.getItem("bd_gamemode") === "1";
    let mirrorCam = localStorage.getItem("bd_mirror") !== "0";
    let afkExempt = localStorage.getItem("bd_afk_exempt") === "1";

    let dspLoopTimer = null;
    let visualLoopTimer = null;
    let healthPollTimer = null;
    let lastPingMs = null;
    let lastVoiceActivitySent = 0;
    let lastOverlayHash = "";
    let overlayConfigCache = { enabled: false, position: "top-left", size: "md", needsRestart: false };
    let pendingProfileAvatar = undefined; // undefined = değişmedi, "" = sil, "data:..." = yeni

    // YouTube Ortak İzleme
    let ytApiPromise = null;
    let ytPlayer = null;
    let ytPlayerVideoId = null;
    let suppressYtEventsUntil = 0;

    // Taktik Çizim Tahtası
    let boardTool = "pen";
    let boardDrawing = false;
    let currentStrokePoints = [];

    // =========================================================================
    // DOM KISAYOLLARI & TEMEL YARDIMCILAR
    // =========================================================================
    const $ = (id) => document.getElementById(id);

    function escapeHTML(str) {
        return String(str ?? "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");
    }

    function showToast(message, type = "info", duration = 3200) {
        const container = $("toast-container");
        if (!container) return;
        const el = document.createElement("div");
        el.className = `toast ${type}`;
        el.textContent = message;
        container.appendChild(el);
        setTimeout(() => {
            el.style.opacity = "0";
            el.style.transition = "opacity 0.2s";
            setTimeout(() => el.remove(), 220);
        }, duration);
    }

    function openModal(id) {
        closeContextMenu();
        closeToolsPopover();
        const el = $(id);
        if (el) el.classList.add("show");
        if (id === "health-modal") startHealthPolling();
    }

    function closeModal(id) {
        const el = $(id);
        if (el) el.classList.remove("show");
        if (id === "health-modal") stopHealthPolling();
    }

    function closeDrawers() {
        $("left-dock")?.classList.remove("open");
        $("rightbar")?.classList.remove("open");
        $("drawer-backdrop")?.classList.remove("show");
    }

    function toggleDrawer(which) {
        const left = $("left-dock");
        const right = $("rightbar");
        const bd = $("drawer-backdrop");
        if (which === "left") {
            const next = !left.classList.contains("open");
            right.classList.remove("open");
            left.classList.toggle("open", next);
            bd.classList.toggle("show", next);
        } else {
            const next = !right.classList.contains("open");
            left.classList.remove("open");
            right.classList.toggle("open", next);
            bd.classList.toggle("show", next);
        }
    }

    function loadSavedVolumes() {
        const map = new Map();
        try {
            const raw = JSON.parse(localStorage.getItem("bd_user_vols") || "{}");
            for (const [k, v] of Object.entries(raw)) {
                const n = Number(v);
                if (!Number.isNaN(n) && n >= 0 && n <= 2) map.set(k, n);
            }
        } catch { }
        return map;
    }

    function saveUserVolumes() {
        const obj = {};
        for (const [k, v] of userVolumes.entries()) obj[k] = v;
        try {
            localStorage.setItem("bd_user_vols", JSON.stringify(obj));
        } catch { }
    }

    function getInitials(text) {
        const parts = String(text || "?").trim().split(/\s+/).filter(Boolean);
        if (!parts.length) return "?";
        if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
        return (parts[0][0] + parts[1][0]).toUpperCase();
    }

    function renderAvatarContent(el, { avatar, displayName, username, color }) {
        el.innerHTML = "";
        el.style.background = color || "#5865f2";
        if (avatar && avatar.startsWith("data:image/")) {
            const img = document.createElement("img");
            img.src = avatar;
            img.alt = "";
            el.appendChild(img);
        } else {
            el.textContent = (displayName || username || "?").trim().charAt(0).toUpperCase() || "?";
        }
    }

    function copyText(text, successMsg = "Panoya kopyalandı.") {
        if (navigator.clipboard?.writeText) {
            navigator.clipboard.writeText(text).then(() => showToast(successMsg, "ok")).catch(() => fallbackCopy(text, successMsg));
        } else {
            fallbackCopy(text, successMsg);
        }
    }

    function fallbackCopy(text, successMsg) {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        try {
            document.execCommand("copy");
            showToast(successMsg, "ok");
        } catch {
            showToast("Kopyalanamadı.", "err");
        }
        ta.remove();
    }

    function canActOn(targetMember) {
        if (!me || !targetMember) return false;
        if (targetMember.username === me.username) return false;
        if (targetMember.isOwner) return false;
        if (isServerOwner) return true;
        return myPower > (targetMember.power || 0);
    }

    function canManageRole(role) {
        if (!role) return false;
        if (isServerOwner) return true;
        return myPower > (role.priority || 0);
    }

    // =========================================================================
    // PAYLAŞIMLI AUDIOCONTEXT, BİLDİRİM TONLARI & SOUNDBOARD SENTETİZATÖRÜ
    // =========================================================================
    function ensureSharedAudioCtx() {
        if (!sharedAudioCtx) {
            const Ctx = window.AudioContext || window.webkitAudioContext;
            sharedAudioCtx = new Ctx({ latencyHint: "interactive" });
            masterOutGain = sharedAudioCtx.createGain();
            masterOutGain.gain.value = deafened ? 0 : 1;
            masterOutGain.connect(sharedAudioCtx.destination);
            applyOutputDevice();
        }
        if (sharedAudioCtx.state === "suspended") {
            sharedAudioCtx.resume().catch(() => { });
        }
        return sharedAudioCtx;
    }

    function applyOutputDevice() {
        const sinkId = $("spk-select")?.value;
        if (!sinkId) return;
        if (sharedAudioCtx && typeof sharedAudioCtx.setSinkId === "function") {
            sharedAudioCtx.setSinkId(sinkId).catch(() => { });
        }
    }

    function playTone(freq = 640, duration = 0.08, type = "sine", vol = 0.06) {
        if (deafened) return;
        try {
            const ctx = ensureSharedAudioCtx();
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = type;
            osc.frequency.setValueAtTime(freq, ctx.currentTime);
            gain.gain.setValueAtTime(vol, ctx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.0008, ctx.currentTime + duration);
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.start();
            osc.stop(ctx.currentTime + duration);
        } catch { }
    }

    function playSoundboardSynth(soundId) {
        if (deafened || soundboardVolume <= 0) return;
        const vol = (soundboardVolume / 100) * 0.28;
        try {
            const ctx = ensureSharedAudioCtx();
            const now = ctx.currentTime;
            const out = ctx.createGain();
            out.gain.value = vol;
            out.connect(ctx.destination);

            const note = (freq, start, dur, type = "sine", gainVal = 1, slideTo = null) => {
                const o = ctx.createOscillator();
                const g = ctx.createGain();
                o.type = type;
                o.frequency.setValueAtTime(freq, now + start);
                if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, now + start + dur);
                g.gain.setValueAtTime(0.0001, now + start);
                g.gain.linearRampToValueAtTime(gainVal, now + start + 0.015);
                g.gain.exponentialRampToValueAtTime(0.0008, now + start + dur);
                o.connect(g);
                g.connect(out);
                o.start(now + start);
                o.stop(now + start + dur + 0.02);
            };

            const noiseBurst = (start, dur, filterFreq = 1800, gainVal = 0.5) => {
                const bufferSize = Math.floor(ctx.sampleRate * dur);
                const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
                const data = buffer.getChannelData(0);
                for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1;
                const src = ctx.createBufferSource();
                src.buffer = buffer;
                const filter = ctx.createBiquadFilter();
                filter.type = "bandpass";
                filter.frequency.value = filterFreq;
                const g = ctx.createGain();
                g.gain.setValueAtTime(gainVal, now + start);
                g.gain.exponentialRampToValueAtTime(0.001, now + start + dur);
                src.connect(filter);
                filter.connect(g);
                g.connect(out);
                src.start(now + start);
            };

            switch (soundId) {
                case "airhorn":
                    [440, 554.37, 659.25].forEach((f) => {
                        note(f, 0, 0.14, "sawtooth", 0.35);
                        note(f, 0.16, 0.14, "sawtooth", 0.35);
                        note(f, 0.33, 0.55, "sawtooth", 0.4);
                    });
                    break;
                case "victory":
                    note(523.25, 0, 0.14, "triangle", 0.7);
                    note(659.25, 0.13, 0.14, "triangle", 0.7);
                    note(783.99, 0.26, 0.14, "triangle", 0.75);
                    note(1046.5, 0.4, 0.55, "triangle", 0.85);
                    break;
                case "fail":
                    note(311.13, 0, 0.26, "sawtooth", 0.45, 293.66);
                    note(277.18, 0.28, 0.26, "sawtooth", 0.45, 261.63);
                    note(246.94, 0.56, 0.58, "sawtooth", 0.5, 195);
                    break;
                case "headshot":
                    note(1480, 0, 0.08, "sine", 0.9);
                    note(2217, 0.04, 0.24, "sine", 0.75);
                    break;
                case "countdown":
                    note(520, 0, 0.12, "square", 0.4);
                    note(520, 0.35, 0.12, "square", 0.4);
                    note(520, 0.7, 0.12, "square", 0.4);
                    note(1040, 1.05, 0.32, "square", 0.55);
                    break;
                case "gg":
                    note(659.25, 0, 0.2, "sine", 0.7);
                    note(987.77, 0.15, 0.35, "sine", 0.75);
                    break;
                case "alert":
                    note(880, 0, 0.18, "sawtooth", 0.45, 580);
                    note(880, 0.22, 0.18, "sawtooth", 0.45, 580);
                    note(880, 0.44, 0.22, "sawtooth", 0.45, 580);
                    break;
                case "laser":
                    note(1400, 0, 0.24, "sawtooth", 0.55, 140);
                    break;
                case "drum":
                    note(140, 0, 0.12, "sine", 0.9, 55);
                    note(180, 0.18, 0.12, "sine", 0.85, 65);
                    noiseBurst(0.36, 0.38, 4200, 0.55);
                    break;
                case "ping":
                default:
                    note(1046.5, 0, 0.12, "sine", 0.75);
                    note(1318.5, 0.1, 0.22, "sine", 0.65);
                    break;
            }
        } catch { }
    }

    // =========================================================================
    // OPUS SDP OPTİMİZASYONU (32kbps, DTX, FEC, minptime=10)
    // =========================================================================
    function optimizeOpusSDP(sdp) {
        return sdp.replace(/a=fmtp:(\d+) (.+)/g, (match, pt, params) => {
            if (!sdp.includes(`a=rtpmap:${pt} opus/48000`)) return match;
            let p = params;
            if (!p.includes("usedtx=")) p += ";usedtx=1";
            if (!p.includes("useinbandfec=")) p += ";useinbandfec=1";
            if (!p.includes("maxaveragebitrate=")) p += ";maxaveragebitrate=32000";
            if (!p.includes("minptime=")) p += ";minptime=10";
            return `a=fmtp:${pt} ${p}`;
        });
    }

    // =========================================================================
    // TERCİHLER, TEMA, OYUN MODU & ELECTRON OVERLAY AYARLARI
    // =========================================================================
    function updateGameModeUI() {
        document.body.classList.toggle("game-mode", gameMode);
        const btn = $("btn-game-mode");
        const lbl = $("game-mode-lbl");
        if (btn) btn.classList.toggle("active", gameMode);
        if (lbl) lbl.textContent = gameMode ? "Oyun Modu: AÇIK" : "Oyun Modu";
        if (gameMode) clearAllSpeakingVisuals();
    }

    function updateGateMarkerUI() {
        $("gate-val").textContent = gateThreshold > 0 ? `${gateThreshold}%` : "Kapalı";
        $("sidebar-gate-line").style.left = `${gateThreshold}%`;
        $("modal-gate-line").style.left = `${gateThreshold}%`;
    }

    function applyPreferences() {
        const theme = localStorage.getItem("bd_theme") || "dark";
        const accent = localStorage.getItem("bd_accent") || "#5865f2";
        const fontSize = localStorage.getItem("bd_fontsize") || "14px";

        document.body.setAttribute("data-theme", theme);
        document.documentElement.style.setProperty("--accent", accent);
        document.documentElement.style.setProperty("--font-size", fontSize);

        $("theme-select").value = theme;
        $("accent-picker").value = accent;
        $("font-size-select").value = fontSize;
        $("gate-slider").value = String(gateThreshold);
        $("chk-ptt").checked = pttEnabled;
        $("btn-ptt-key").textContent = pttKey;
        $("chk-mirror").checked = mirrorCam;
        $("chk-afk-exempt").checked = afkExempt;
        $("sb-vol-slider").value = String(soundboardVolume);
        $("sb-vol-val").textContent = `${soundboardVolume}%`;

        updateGateMarkerUI();
        updateGameModeUI();
    }

    async function initElectronSettingsUI() {
        if (!isElectron) return;
        $("electron-overlay-card").style.display = "flex";

        try {
            const dbPath = await window.electronAPI.dbPath();
            $("db-info").textContent = `Yerel Master DB: ${dbPath}`;
        } catch { }

        try {
            const cfg = await window.electronAPI.getOverlayConfig();
            syncOverlaySettingsUI(cfg);
        } catch { }

        window.electronAPI.onGlobalShortcut((action) => {
            if (!voiceChannelId && action !== "toggle-overlay") return;
            if (action === "toggle-mute") toggleMute();
            else if (action === "toggle-deafen") toggleDeafen();
            else if (action === "toggle-overlay") toggleOverlayFromShortcut();
        });
    }

    function syncOverlaySettingsUI(cfg) {
        if (!cfg) return;
        overlayConfigCache = cfg;
        $("chk-overlay-enabled").checked = Boolean(cfg.enabled);
        $("overlay-pos-select").value = cfg.position || "top-left";
        $("overlay-size-select").value = cfg.size || "md";
        $("chk-disable-gpu").checked = Boolean(cfg.disableGpu);
        $("overlay-restart-banner").style.display = cfg.needsRestart ? "flex" : "none";
    }

    async function updateOverlaySettings(partial) {
        if (!isElectron) return;
        try {
            const res = await window.electronAPI.setOverlayConfig(partial);
            syncOverlaySettingsUI(res);
            if (res.needsRestart) {
                showToast("Saydam overlay için uygulamayı yeniden başlatın.", "info", 4500);
            } else {
                lastOverlayHash = "";
                pushOverlayState(true);
            }
        } catch { }
    }

    async function toggleOverlayFromShortcut() {
        if (!isElectron) return;
        const nextEnabled = !overlayConfigCache.enabled;
        await updateOverlaySettings({ enabled: nextEnabled });
        if (!overlayConfigCache.needsRestart) {
            showToast(nextEnabled ? "Oyun İçi Overlay açıldı." : "Oyun İçi Overlay kapatıldı.", "info", 2000);
        }
    }

    function pushOverlayState(force = false) {
        if (!isElectron) return;
        if (!voiceChannelId || !voiceServerId) {
            if (force || lastOverlayHash !== "OFF") {
                lastOverlayHash = "OFF";
                window.electronAPI.updateOverlayState({ active: false, channelName: "", users: [] });
            }
            return;
        }

        // Aktif ses kanalındaki kullanıcıları derle (sunucu değiştirilse bile voiceMembersCache'ten beslenir)
        const list = [];
        for (const m of voiceMembersCache.values()) {
            const isMe = me && m.username === me.username;
            const muted = isMe ? (selfMuted || serverMuted || deafened) : Boolean(m.selfMuted || m.serverMuted || m.deafened);
            const speaking = isMe
                ? Boolean(speakingMap.get(socket.id)) && !muted
                : Boolean(m.id && speakingMap.get(m.id)) && !muted;

            list.push({
                username: m.username,
                displayName: m.displayName || m.username,
                color: m.color || "#5865f2",
                avatar: m.avatar || "",
                muted,
                serverMuted: Boolean(isMe ? serverMuted : m.serverMuted),
                deafened: Boolean(isMe ? deafened : m.deafened),
                speaking
            });
        }

        // Konuşanları bozmadan sabit alfabetik sırada tut (listede sıçrama yapmasın)
        list.sort((a, b) => a.displayName.localeCompare(b.displayName, "tr"));

        const hash = list.map((u) => `${u.username}:${u.speaking ? 1 : 0}:${u.muted ? 1 : 0}:${u.displayName}:${u.color}:${u.avatar ? u.avatar.length : 0}`).join("|");
        if (!force && hash === lastOverlayHash) return;
        lastOverlayHash = hash;

        window.electronAPI.updateOverlayState({
            active: true,
            channelName: voiceChannelId,
            users: list
        });
    }

    // =========================================================================
    // BAĞLANTI & SİSTEM SAĞLIĞI (GETSTATS)
    // =========================================================================
    function updateHealthPill(ms) {
        if (typeof ms === "number") lastPingMs = ms;
        const badge = $("ping-badge");
        const dot = $("health-dot");
        if (!badge || !dot) return;

        let anyBad = false;
        let anyWarn = false;
        for (const p of peers.values()) {
            const st = p.pc.connectionState;
            if (st === "failed" || st === "disconnected") anyBad = true;
            else if (st === "connecting" || st === "new") anyWarn = true;
        }

        badge.textContent = lastPingMs !== null ? `${lastPingMs} ms` : "-- ms";
        dot.className = "dot-ind";
        if (anyBad || (lastPingMs !== null && lastPingMs > 180)) dot.classList.add("bad");
        else if (anyWarn || (lastPingMs !== null && lastPingMs > 90)) dot.classList.add("warn");
    }

    function formatUptime(sec) {
        const h = Math.floor(sec / 3600);
        const m = Math.floor((sec % 3600) / 60);
        const s = sec % 60;
        if (h > 0) return `${h}s ${m}dk`;
        if (m > 0) return `${m}dk ${s}sn`;
        return `${s}sn`;
    }

    async function refreshHealthModal() {
        const t0 = Date.now();
        socket.emit("health-info", (info) => {
            if (!info) return;
            const ms = Date.now() - t0;
            updateHealthPill(ms);
            $("h-ping").textContent = `${ms} ms`;
            $("h-uptime").textContent = formatUptime(info.uptimeSec || 0);
            $("h-ram").textContent = `${info.memRssMB} MB`;
        });

        $("h-audio").textContent = sharedAudioCtx ? sharedAudioCtx.state : "Hazır";

        const parts = [];
        parts.push(voiceChannelId ? "Ses: Bağlı" : "Ses: Bağlı değil");
        if (camStream) {
            const s = camStream.getVideoTracks()[0]?.getSettings();
            parts.push(`Kamera: ${s?.width || "?"}x${s?.height || "?"} @${Math.round(s?.frameRate || 0)}fps`);
        }
        if (screenStream) {
            const s = screenStream.getVideoTracks()[0]?.getSettings();
            parts.push(`Ekran: ${s?.width || "?"}x${s?.height || "?"} @${Math.round(s?.frameRate || 0)}fps`);
        }
        parts.push(`Noise Gate: ${gateThreshold > 0 ? gateThreshold + "%" : "Kapalı"}`);
        parts.push(`Oyun Modu: ${gameMode ? "AÇIK" : "Kapalı"}`);
        $("h-local-summary").textContent = parts.join("  •  ");

        const tbody = $("h-peers-body");
        if (peers.size === 0) {
            tbody.innerHTML = '<tr><td colspan="7" class="center muted-note">Aktif P2P bağlantısı yok.</td></tr>';
            return;
        }

        const rows = [];
        for (const [peerId, peer] of peers.entries()) {
            const m = voiceMembersCache.get(peerId) || members.find((x) => x.id === peerId);
            const name = escapeHTML(m?.displayName || m?.username || peerId.slice(0, 6));
            let pathType = "P2P";
            let rttStr = "--";
            let lossStr = "0%";
            let upKbps = 0;
            let downKbps = 0;

            try {
                const stats = await peer.pc.getStats();
                let bytesSent = 0;
                let bytesRecv = 0;
                let packetsLost = 0;
                let packetsRecv = 0;
                let activePair = null;
                const candidates = new Map();

                stats.forEach((r) => {
                    if (r.type === "local-candidate" || r.type === "remote-candidate") {
                        candidates.set(r.id, r);
                    }
                    if (r.type === "candidate-pair" && (r.nominated || r.state === "succeeded")) {
                        if (!activePair || r.nominated) activePair = r;
                    }
                    if (r.type === "outbound-rtp" && !r.isRemote) {
                        bytesSent += r.bytesSent || 0;
                    }
                    if (r.type === "inbound-rtp" && !r.isRemote) {
                        bytesRecv += r.bytesReceived || 0;
                        packetsLost += r.packetsLost || 0;
                        packetsRecv += r.packetsReceived || 0;
                    }
                });

                if (activePair) {
                    if (typeof activePair.currentRoundTripTime === "number") {
                        rttStr = `${Math.round(activePair.currentRoundTripTime * 1000)} ms`;
                    }
                    const lc = candidates.get(activePair.localCandidateId);
                    const rc = candidates.get(activePair.remoteCandidateId);
                    if (lc?.candidateType === "relay" || rc?.candidateType === "relay") {
                        pathType = "TURN Relay";
                    } else {
                        pathType = "Doğrudan P2P";
                    }
                }

                const totalPkt = packetsLost + packetsRecv;
                if (totalPkt > 0) {
                    lossStr = `${((packetsLost / totalPkt) * 100).toFixed(1)}%`;
                }

                const now = Date.now();
                if (peer.lastStats) {
                    const dt = Math.max(0.2, (now - peer.lastStats.ts) / 1000);
                    upKbps = Math.max(0, Math.round(((bytesSent - peer.lastStats.bytesSent) * 8) / (dt * 1000)));
                    downKbps = Math.max(0, Math.round(((bytesRecv - peer.lastStats.bytesRecv) * 8) / (dt * 1000)));
                }
                peer.lastStats = { ts: now, bytesSent, bytesRecv };
            } catch { }

            rows.push(`
                <tr>
                    <td>${name}</td>
                    <td>${escapeHTML(pathType)}</td>
                    <td>${escapeHTML(peer.pc.connectionState || "new")}</td>
                    <td>${rttStr}</td>
                    <td>${lossStr}</td>
                    <td>${upKbps} / ${downKbps} kbps</td>
                    <td><button class="btn xs secondary" data-ice-restart="${escapeHTML(peerId)}">Yenile</button></td>
                </tr>
            `);
        }

        tbody.innerHTML = rows.join("");
        tbody.querySelectorAll("[data-ice-restart]").forEach((btn) => {
            btn.onclick = () => {
                const pid = btn.getAttribute("data-ice-restart");
                sendOfferToPeer(pid, true);
                showToast("ICE bağlantısı yenileniyor...", "info", 1800);
            };
        });
    }

    function startHealthPolling() {
        refreshHealthModal();
        stopHealthPolling();
        healthPollTimer = setInterval(refreshHealthModal, 2000);
    }

    function stopHealthPolling() {
        if (healthPollTimer) {
            clearInterval(healthPollTimer);
            healthPollTimer = null;
        }
    }

    setInterval(() => {
        if (!socket.connected) return;
        const t0 = Date.now();
        socket.emit("ping-check", () => updateHealthPill(Date.now() - t0));
    }, 6000);

    // =========================================================================
    // BAŞLANGIÇ (OTOMATİK PC DB GERİ YÜKLEME + OTURUM HATIRLAMA)
    // =========================================================================
    async function bootSequence() {
        if (isElectron) {
            const needsRestore = await new Promise((resolve) => {
                socket.emit("check-db-needs-restore", (need) => resolve(Boolean(need)));
            });
            if (needsRestore) {
                const localDB = await window.electronAPI.dbLoad();
                if (localDB && localDB.users) {
                    await new Promise((resolve) => {
                        socket.emit("restore-db", localDB, (res) => {
                            if (res?.ok) {
                                showToast(
                                    res.migratedFromV4
                                        ? "v4.0 yerel veritabanınız v5.0 formatına veri kaybı olmadan aktarıldı!"
                                        : "Yerel PC veritabanı sunucuya otomatik geri yüklendi.",
                                    "ok",
                                    5000
                                );
                            }
                            resolve();
                        });
                    });
                }
            }
        }

        const savedToken = localStorage.getItem("bd_token");
        if (savedToken) {
            socket.emit("login-token", savedToken, (res) => {
                if (res?.ok) {
                    handleLoginSuccess(res);
                } else {
                    localStorage.removeItem("bd_token");
                }
            });
        }
    }

    function applyMeUI() {
        if (!me) return;
        $("me-name").textContent = me.displayName || me.username;
        $("me-status").textContent = me.status || "Çevrimiçi";
        renderAvatarContent($("me-avatar"), me);

        $("prof-display-name").value = me.displayName || me.username;
        $("prof-color").value = me.color || "#5865f2";
        $("prof-status").value = me.status || "Çevrimiçi";
        renderAvatarContent($("prof-avatar-preview"), me);
        pendingProfileAvatar = undefined;

        $("tab-db-btn").style.display = me.isGlobalAdmin ? "" : "none";
    }

    function handleLoginSuccess(res) {
        me = res.me;
        myServers = res.servers || [];
        activeServerId = res.activeServerId;

        if (res.token) localStorage.setItem("bd_token", res.token);
        $("auth-overlay").classList.remove("show");
        $("auth-err").textContent = "";

        applyMeUI();
        renderServerRail();
        if (res.snapshot) applyServerSnapshot(res.snapshot);

        // Kullanıcı AFK muafiyet tercihini sunucuya bildir
        if (afkExempt) {
            socket.emit("update-profile", { afkExempt: true });
        }

        loadMediaDevices().catch(() => { });
    }

    function applyServerSnapshot(snap) {
        if (!snap) return;
        activeServerId = snap.serverId;
        serverSettings = snap.settings;
        channels = snap.channels || [];
        roles = snap.roles || [];
        members = snap.members || [];
        messagesByChannel = snap.messages || {};
        myPermissions = snap.myPermissions || {};
        myPower = snap.myPower || 0;
        isServerOwner = Boolean(snap.isOwner);
        activeReadyCheck = snap.readyCheck || null;
        serverPolls = snap.polls || [];
        watchState = snap.watch || { active: false };
        boardState = snap.board || { active: false, strokes: [] };

        if (voiceServerId === activeServerId) {
            refreshVoiceMembersCacheFrom(members);
        }

        const hasCurrentCh = channels.some((c) => c.id === activeChannelId && c.type === "text");
        if (!hasCurrentCh) {
            const firstText = channels.find((c) => c.type === "text");
            activeChannelId = firstText ? firstText.id : null;
        }

        $("server-name-lbl").textContent = serverSettings?.name || "BizimDiscord";
        updateServerPermissionsUI();
        renderServerRail();
        renderChannels();
        renderMembers();
        renderActiveChannelHeader();
        renderMessages();
        renderReadyCheckBanner();
        renderPollsList();
        applyWatchState(watchState);
        applyBoardState(boardState);
        populateServerSettingsForm();
    }

    function updateServerPermissionsUI() {
        const canCh = Boolean(myPermissions.administrator || myPermissions.manageChannels);
        const canSrv = Boolean(myPermissions.administrator || myPermissions.manageServer);
        const canRole = Boolean(myPermissions.administrator || myPermissions.manageRoles);

        $("btn-quick-add-text").style.display = canCh ? "" : "none";
        $("btn-quick-add-voice").style.display = canCh ? "" : "none";

        const showServerTab = canSrv || canRole || !isServerOwner;
        $("tab-server-btn").style.display = showServerTab ? "" : "none";
        $("srv-general-section").style.display = canSrv ? "flex" : "none";
        $("srv-roles-section").style.display = canRole ? "flex" : "none";

        $("btn-leave-server").style.display = !isServerOwner ? "" : "none";
        $("btn-delete-server").style.display = (isServerOwner || me?.isGlobalAdmin) ? "" : "none";
    }

    // =========================================================================
    // ÇOKLU SUNUCU ŞERİDİ & SUNUCU İŞLEMLERİ
    // =========================================================================
    function renderServerRail() {
        const listEl = $("server-list");
        listEl.innerHTML = "";

        myServers.forEach((s) => {
            const btn = document.createElement("button");
            btn.className = "rail-btn" + (s.id === activeServerId ? " active" : "");
            btn.title = `${s.name} (${s.onlineCount}/${s.memberCount} çevrimiçi)`;

            if (s.icon && s.icon.startsWith("data:image/")) {
                const img = document.createElement("img");
                img.src = s.icon;
                img.alt = s.name;
                btn.appendChild(img);
            } else {
                btn.textContent = getInitials(s.name);
            }

            if (voiceServerId === s.id && voiceChannelId) {
                const vInd = document.createElement("span");
                vInd.className = "rail-voice-ind";
                vInd.textContent = "🔊";
                btn.appendChild(vInd);
            }

            btn.onclick = () => selectServer(s.id);
            btn.oncontextmenu = (e) => {
                e.preventDefault();
                showServerContextMenu(e.clientX, e.clientY, s);
            };
            listEl.appendChild(btn);
        });

        $("dm-unread-dot").style.display = dmUnread ? "block" : "none";
    }

    function selectServer(serverId) {
        if (!serverId || serverId === activeServerId) return;
        socket.emit("server-select", { serverId }, (res) => {
            if (!res?.ok) {
                showToast(res?.error || "Sunucuya geçilemedi.", "err");
                return;
            }
            activeChannelId = null;
            clearReply();
            applyServerSnapshot(res.snapshot);
        });
    }

    function showServerContextMenu(x, y, srvObj) {
        const items = [];
        if (srvObj.id === activeServerId && serverSettings?.inviteCode) {
            items.push({
                label: `Davet Kodunu Kopyala (${serverSettings.inviteCode})`,
                icon: "🔗",
                onClick: () => copyText(serverSettings.inviteCode, `Davet kodu kopyalandı: ${serverSettings.inviteCode}`)
            });
        }
        if (srvObj.id === activeServerId && (myPermissions.administrator || myPermissions.manageChannels)) {
            items.push({
                label: "Yeni Kanal Oluştur",
                icon: "➕",
                onClick: () => openChannelModal(null, "text")
            });
        }
        if (srvObj.id === activeServerId && (myPermissions.administrator || myPermissions.manageServer || myPermissions.manageRoles)) {
            items.push({
                label: "Sunucu Ayarları & Roller",
                icon: "🛡️",
                onClick: () => {
                    openModal("settings-modal");
                    activateSettingsTab("tab-server");
                }
            });
        }
        if (!srvObj.isOwner) {
            items.push({ sep: true });
            items.push({
                label: "Sunucudan Ayrıl",
                icon: "🚪",
                danger: true,
                onClick: () => confirmLeaveServer(srvObj.id, srvObj.name)
            });
        }
        if (items.length) openContextMenu(x, y, items);
    }

    function confirmLeaveServer(serverId, name) {
        if (!confirm(`"${name}" sunucusundan ayrılmak istediğine emin misin?`)) return;
        socket.emit("server-leave", { serverId }, (res) => {
            if (!res?.ok) return showToast(res?.error || "Ayrılamadı.", "err");
            myServers = res.servers || [];
            showToast(`"${name}" sunucusundan ayrıldın.`, "info");
            if (res.snapshot) applyServerSnapshot(res.snapshot);
            else renderServerRail();
        });
    }

    // =========================================================================
    // KANAL LİSTESİ & SAĞ TIK / UZUN BASMA BAĞLAM MENÜSÜ
    // =========================================================================
    function renderChannels() {
        const textUl = $("text-channels");
        const voiceUl = $("voice-channels");
        textUl.innerHTML = "";
        voiceUl.innerHTML = "";

        const canManageCh = Boolean(myPermissions.administrator || myPermissions.manageChannels);

        channels.forEach((ch) => {
            const li = document.createElement("li");
            const isActiveText = ch.type === "text" && ch.id === activeChannelId;
            const isJoinedVoice = ch.type === "voice" && voiceServerId === activeServerId && voiceChannelId === ch.id;

            li.className = "channel-item" + (isActiveText ? " active" : "") + (isJoinedVoice ? " voice-joined" : "");
            li.dataset.channelId = ch.id;

            const left = document.createElement("div");
            left.className = "ch-left";

            const hash = document.createElement("span");
            hash.className = "ch-hash";
            hash.textContent = ch.type === "voice" ? "🔊" : "#";

            const nameSpan = document.createElement("span");
            nameSpan.className = "ch-name";
            nameSpan.textContent = ch.name;

            left.appendChild(hash);
            left.appendChild(nameSpan);

            if (ch.type === "voice" && (ch.isAfk || serverSettings?.afkChannelId === ch.id)) {
                const afkTag = document.createElement("span");
                afkTag.className = "ch-afk-tag";
                afkTag.textContent = "AFK";
                left.appendChild(afkTag);
            }

            const right = document.createElement("div");
            right.className = "ch-right";

            if (ch.type === "text" && unreadChannels.has(`${activeServerId}:${ch.id}`)) {
                const dot = document.createElement("span");
                dot.className = "ch-unread";
                right.appendChild(dot);
            }

            // Çarpı (x) butonu YOK; mobilde ve masaüstünde sağ tıka ek olarak zarif "⋯" bağlam menüsü
            const moreBtn = document.createElement("button");
            moreBtn.className = "ch-more-btn";
            moreBtn.title = "Kanal İşlemleri";
            moreBtn.textContent = "⋯";
            moreBtn.onclick = (e) => {
                e.stopPropagation();
                const rect = moreBtn.getBoundingClientRect();
                openChannelContextMenu(rect.left, rect.bottom + 4, ch, canManageCh);
            };
            right.appendChild(moreBtn);

            li.appendChild(left);
            li.appendChild(right);

            // Tıklama davranışı
            li.onclick = () => {
                if (ch.type === "text") {
                    activeChannelId = ch.id;
                    unreadChannels.delete(`${activeServerId}:${ch.id}`);
                    clearReply();
                    renderChannels();
                    renderActiveChannelHeader();
                    renderMessages();
                    closeDrawers();
                } else {
                    if (isJoinedVoice) return;
                    joinVoiceChannel(activeServerId, ch.id);
                    closeDrawers();
                }
            };

            // Sağ tık menüsü
            li.oncontextmenu = (e) => {
                e.preventDefault();
                openChannelContextMenu(e.clientX, e.clientY, ch, canManageCh);
            };

            // Mobil uzun basma (550ms) -> Bağlam menüsü
            let pressTimer = null;
            li.addEventListener("touchstart", (e) => {
                const touch = e.touches[0];
                pressTimer = setTimeout(() => {
                    openChannelContextMenu(touch.clientX, touch.clientY, ch, canManageCh);
                }, 550);
            }, { passive: true });
            li.addEventListener("touchend", () => clearTimeout(pressTimer));
            li.addEventListener("touchmove", () => clearTimeout(pressTimer));

            if (ch.type === "text") {
                textUl.appendChild(li);
            } else {
                voiceUl.appendChild(li);

                // Bu ses kanalındaki kullanıcıları listele
                const occupants = members.filter((m) => m.online && m.voiceChannel === ch.id);
                if (occupants.length) {
                    const occUl = document.createElement("ul");
                    occUl.className = "voice-occupants";
                    occupants.forEach((m) => {
                        const occLi = document.createElement("li");
                        const isSpk = m.id && speakingMap.get(m.id);
                        occLi.className = "voice-occ-item" + (isSpk ? " speaking" : "");
                        occLi.dataset.voiceUid = m.id || "";

                        const av = document.createElement("div");
                        av.className = "avatar-circle xs";
                        renderAvatarContent(av, m);

                        const nm = document.createElement("span");
                        nm.className = "voice-occ-name";
                        nm.textContent = m.displayName || m.username;

                        const flags = document.createElement("span");
                        flags.className = "voice-occ-flags";
                        const fParts = [];
                        if (m.serverMuted) fParts.push("🔇");
                        else if (m.selfMuted) fParts.push("🎙️✕");
                        if (m.deafened) fParts.push("🎧✕");
                        if (m.camOn) fParts.push("📹");
                        if (m.screenSharing) fParts.push("🖥️");
                        flags.textContent = fParts.join(" ");

                        occLi.appendChild(av);
                        occLi.appendChild(nm);
                        if (fParts.length) occLi.appendChild(flags);

                        occLi.oncontextmenu = (e) => {
                            e.preventDefault();
                            openMemberContextMenu(e.clientX, e.clientY, m);
                        };
                        occUl.appendChild(occLi);
                    });
                    voiceUl.appendChild(occUl);
                }
            }
        });
    }

    function openChannelContextMenu(x, y, ch, canManageCh) {
        const items = [];

        items.push({
            label: ch.type === "voice" ? "Ses Kanalına Katıl" : "Kanalı Aç",
            icon: ch.type === "voice" ? "🔊" : "#",
            onClick: () => {
                if (ch.type === "voice") joinVoiceChannel(activeServerId, ch.id);
                else {
                    activeChannelId = ch.id;
                    renderChannels();
                    renderActiveChannelHeader();
                    renderMessages();
                }
            }
        });

        items.push({
            label: "Davet Kodunu Kopyala",
            icon: "🔗",
            onClick: () => {
                const code = serverSettings?.inviteCode || "";
                const shareTxt = `${serverSettings?.name || "BizimDiscord"} (#${ch.name}) — Davet Kodu: ${code}`;
                copyText(code || shareTxt, `Davet kodu kopyalandı: ${code}`);
            }
        });

        if (canManageCh) {
            items.push({ sep: true });
            items.push({
                label: "Kanalı Düzenle (Ad / Konu)",
                icon: "✏️",
                onClick: () => openChannelModal(ch, ch.type)
            });

            if (ch.type === "voice") {
                const isAlreadyAfk = Boolean(ch.isAfk || serverSettings?.afkChannelId === ch.id);
                items.push({
                    label: isAlreadyAfk ? "AFK Kanalı İşaretini Kaldır" : "AFK Odası Olarak Ayarla",
                    icon: "💤",
                    onClick: () => {
                        socket.emit("channel-update", {
                            serverId: activeServerId,
                            channelId: ch.id,
                            isAfk: !isAlreadyAfk
                        }, (res) => {
                            if (!res?.ok) showToast(res?.error || "Güncellenemedi.", "err");
                            else showToast(!isAlreadyAfk ? `"${ch.name}" AFK odası yapıldı.` : "AFK odası kaldırıldı.", "ok");
                        });
                    }
                });
            }

            items.push({
                label: "Kanalı Kapat / Sil",
                icon: "🗑️",
                danger: true,
                onClick: () => {
                    if (!confirm(`"${ch.name}" kanalı ve içindeki mesajlar kalıcı olarak silinsin mi?`)) return;
                    socket.emit("channel-delete", { serverId: activeServerId, channelId: ch.id }, (res) => {
                        if (!res?.ok) showToast(res?.error || "Kanal silinemedi.", "err");
                        else showToast(`"${ch.name}" silindi.`, "info");
                    });
                }
            });
        }

        openContextMenu(x, y, items);
    }

    function openChannelModal(existingCh, defaultType = "text") {
        $("ch-modal-err").textContent = "";
        if (existingCh) {
            $("ch-modal-title").textContent = "Kanalı Düzenle";
            $("ch-modal-id").value = existingCh.id;
            $("ch-modal-name").value = existingCh.name;
            $("ch-modal-type").value = existingCh.type;
            $("ch-modal-type-wrap").style.display = "none";
            $("ch-modal-topic").value = existingCh.topic || "";
            $("ch-modal-afk-wrap").style.display = existingCh.type === "voice" ? "inline-flex" : "none";
            $("ch-modal-afk").checked = Boolean(existingCh.isAfk || serverSettings?.afkChannelId === existingCh.id);
        } else {
            $("ch-modal-title").textContent = "Yeni Kanal Oluştur";
            $("ch-modal-id").value = "";
            $("ch-modal-name").value = "";
            $("ch-modal-type").value = defaultType;
            $("ch-modal-type-wrap").style.display = "block";
            $("ch-modal-topic").value = "";
            $("ch-modal-afk-wrap").style.display = defaultType === "voice" ? "inline-flex" : "none";
            $("ch-modal-afk").checked = false;
        }
        openModal("channel-modal");
        setTimeout(() => $("ch-modal-name").focus(), 40);
    }

    function renderActiveChannelHeader() {
        const ch = channels.find((c) => c.id === activeChannelId);
        $("active-channel-title").textContent = ch ? `# ${ch.name}` : "# kanal";
        $("active-channel-topic").textContent = ch?.topic || "";
    }

    // =========================================================================
    // ÖZEL BAĞLAM MENÜSÜ MOTORU
    // =========================================================================
    function openContextMenu(x, y, items) {
        const menu = $("context-menu");
        menu.innerHTML = "";

        items.forEach((it) => {
            if (it.sep) {
                const sep = document.createElement("div");
                sep.className = "ctx-sep";
                menu.appendChild(sep);
                return;
            }
            const btn = document.createElement("button");
            btn.className = "ctx-item" + (it.danger ? " danger" : "");
            btn.innerHTML = `<span>${it.icon || ""}</span><span>${escapeHTML(it.label)}</span>`;
            btn.onclick = (e) => {
                e.stopPropagation();
                closeContextMenu();
                it.onClick?.();
            };
            menu.appendChild(btn);
        });

        menu.classList.add("show");
        const mw = menu.offsetWidth || 200;
        const mh = menu.offsetHeight || 160;
        const left = Math.min(x, window.innerWidth - mw - 10);
        const top = Math.min(y, window.innerHeight - mh - 10);
        menu.style.left = `${Math.max(8, left)}px`;
        menu.style.top = `${Math.max(8, top)}px`;
    }

    function closeContextMenu() {
        $("context-menu")?.classList.remove("show");
    }

    function closeToolsPopover() {
        $("tools-popover")?.classList.remove("show");
    }

    document.addEventListener("click", (e) => {
        if (!e.target.closest("#context-menu")) closeContextMenu();
        if (!e.target.closest(".tools-wrap")) closeToolsPopover();
    });

    // =========================================================================
    // ÜYE LİSTESİ (ROL HİYERARŞİSİ ETİKETLERİ & KİŞİ BAŞI %0-%200 SES)
    // =========================================================================
    function renderMembers() {
        const ul = $("user-list");
        ul.innerHTML = "";

        const onlineList = members.filter((m) => m.online);
        const offlineList = members.filter((m) => !m.online);
        $("online-count").textContent = String(onlineList.length);

        const renderSection = (title, list) => {
            if (!list.length) return;
            const hdr = document.createElement("li");
            hdr.className = "member-group-lbl";
            hdr.textContent = `${title} — ${list.length}`;
            ul.appendChild(hdr);

            list.forEach((m) => {
                const li = document.createElement("li");
                li.className = "member-card" + (m.online ? "" : " offline");

                const mainRow = document.createElement("div");
                mainRow.className = "member-main";

                const avWrap = document.createElement("div");
                const isSpk = m.id && speakingMap.get(m.id);
                avWrap.className = "member-av-wrap" + (isSpk ? " speaking" : "");
                avWrap.dataset.memberUid = m.id || "";

                const av = document.createElement("div");
                av.className = "avatar-circle sm";
                renderAvatarContent(av, m);

                const pDot = document.createElement("span");
                pDot.className = "presence-dot" + (m.online ? "" : " offline");

                avWrap.appendChild(av);
                avWrap.appendChild(pDot);

                const info = document.createElement("div");
                info.className = "member-info";

                const nameRow = document.createElement("div");
                nameRow.className = "member-name-row";

                const nameEl = document.createElement("span");
                nameEl.className = "member-name";
                nameEl.textContent = m.displayName || m.username;
                nameEl.style.color = m.topRole?.color || m.color || "";
                nameRow.appendChild(nameEl);

                const flags = [];
                if (m.voiceChannel) flags.push("🔊");
                if (m.serverMuted) flags.push("🔇");
                else if (m.selfMuted) flags.push("🎙️✕");
                if (m.deafened) flags.push("🎧✕");
                if (flags.length) {
                    const fEl = document.createElement("span");
                    fEl.className = "member-flags";
                    fEl.textContent = flags.join(" ");
                    nameRow.appendChild(fEl);
                }

                info.appendChild(nameRow);

                // Kişinin en yüksek yetkisi/rolü adının hemen altında zarif etiket olarak
                if (m.topRole) {
                    const roleBadge = document.createElement("span");
                    roleBadge.className = "member-role-badge";
                    const rColor = m.topRole.color || "#949ba4";
                    roleBadge.style.color = rColor;
                    roleBadge.style.borderColor = `${rColor}44`;
                    roleBadge.style.background = `${rColor}14`;

                    const rDot = document.createElement("span");
                    rDot.className = "member-role-dot";
                    rDot.style.background = rColor;

                    const rTxt = document.createElement("span");
                    rTxt.textContent = m.topRole.name;

                    roleBadge.appendChild(rDot);
                    roleBadge.appendChild(rTxt);
                    info.appendChild(roleBadge);
                }

                if (m.online && m.status && m.status !== "Çevrimiçi") {
                    const stEl = document.createElement("div");
                    stEl.className = "member-status-sub";
                    stEl.textContent = m.status;
                    info.appendChild(stEl);
                }

                mainRow.appendChild(avWrap);
                mainRow.appendChild(info);
                li.appendChild(mainRow);

                // Aynı ses kanalındaysak kişi başı %0 - %200 ses ayarı
                const inSameVoice =
                    m.online &&
                    m.id &&
                    me &&
                    m.username !== me.username &&
                    voiceServerId === activeServerId &&
                    voiceChannelId &&
                    m.voiceChannel === voiceChannelId;

                if (inSameVoice) {
                    const curVol = userVolumes.has(m.username) ? userVolumes.get(m.username) : 1;
                    const volRow = document.createElement("div");
                    volRow.className = "member-vol-row";
                    volRow.onclick = (e) => e.stopPropagation();

                    const lbl = document.createElement("span");
                    lbl.textContent = `${Math.round(curVol * 100)}%`;

                    const slider = document.createElement("input");
                    slider.type = "range";
                    slider.min = "0";
                    slider.max = "2";
                    slider.step = "0.05";
                    slider.value = String(curVol);
                    slider.oninput = () => {
                        const v = parseFloat(slider.value);
                        lbl.textContent = `${Math.round(v * 100)}%`;
                        userVolumes.set(m.username, v);
                        saveUserVolumes();
                        const peer = peers.get(m.id);
                        if (peer) {
                            peer.audioNodes.forEach((n) => {
                                if (n.active) n.gain.gain.value = v;
                            });
                        }
                    };

                    volRow.appendChild(document.createTextNode("🔈"));
                    volRow.appendChild(slider);
                    volRow.appendChild(lbl);
                    li.appendChild(volRow);
                }

                li.onclick = (e) => {
                    openMemberContextMenu(e.clientX, e.clientY, m);
                };
                li.oncontextmenu = (e) => {
                    e.preventDefault();
                    openMemberContextMenu(e.clientX, e.clientY, m);
                };

                ul.appendChild(li);
            });
        };

        renderSection("Çevrimiçi", onlineList);
        renderSection("Çevrimdışı", offlineList);
    }

    function openMemberContextMenu(x, y, m) {
        if (!me || !m) return;
        const items = [];

        if (m.username !== me.username) {
            items.push({
                label: `Fısıltı Gönder (@${m.username})`,
                icon: "💬",
                onClick: () => openDmWith(m.username)
            });
        }

        const canManageRoles = Boolean(myPermissions.administrator || myPermissions.manageRoles);
        const canEditTargetRoles = canManageRoles && (canActOn(m) || (isServerOwner && m.username === me.username));
        if (canEditTargetRoles) {
            items.push({
                label: "Rollerini Yönet",
                icon: "🏷️",
                onClick: () => openMemberRolesModal(m)
            });
        }

        const canMute = Boolean(myPermissions.administrator || myPermissions.muteMembers) && canActOn(m);
        if (canMute && m.online) {
            items.push({ sep: true });
            items.push({
                label: m.serverMuted ? "Sunucu Susturmasını Kaldır" : "Sunucuda Sustur",
                icon: m.serverMuted ? "🔊" : "🔇",
                onClick: () => {
                    socket.emit("member-toggle-mute", { serverId: activeServerId, targetUsername: m.username }, (res) => {
                        if (!res?.ok) showToast(res?.error || "İşlem başarısız.", "err");
                    });
                }
            });

            if (m.voiceChannel && serverSettings?.afkChannelId && m.voiceChannel !== serverSettings.afkChannelId) {
                items.push({
                    label: "AFK Odasına Taşı",
                    icon: "💤",
                    onClick: () => {
                        socket.emit("member-move-afk", { serverId: activeServerId, targetUsername: m.username }, (res) => {
                            if (!res?.ok) showToast(res?.error || "Taşınamadı.", "err");
                            else showToast(`${m.displayName || m.username} AFK odasına taşındı.`, "info");
                        });
                    }
                });
            }
        }

        const canKick = Boolean(myPermissions.administrator || myPermissions.kickMembers) && canActOn(m);
        if (canKick) {
            items.push({ sep: true });
            items.push({
                label: "Sunucudan At",
                icon: "⛔",
                danger: true,
                onClick: () => {
                    if (!confirm(`${m.displayName || m.username} bu sunucudan atılsın mı?`)) return;
                    socket.emit("member-kick", { serverId: activeServerId, targetUsername: m.username }, (res) => {
                        if (!res?.ok) showToast(res?.error || "Atılamadı.", "err");
                        else showToast(`${m.displayName || m.username} sunucudan atıldı.`, "info");
                    });
                }
            });
        }

        if (items.length) openContextMenu(x, y, items);
    }

    // =========================================================================
    // ÜYE ROLLERİ MODALI & SUNUCU ROL YÖNETİCİSİ
    // =========================================================================
    let editingMemberUsername = null;

    function openMemberRolesModal(m) {
        editingMemberUsername = m.username;
        $("mr-title").textContent = `Roller — ${m.displayName || m.username}`;
        $("mr-err").textContent = "";

        const listEl = $("mr-roles-list");
        listEl.innerHTML = "";
        const assigned = new Set(m.roleIds || []);

        roles.forEach((r) => {
            const manageable = canManageRole(r);
            const row = document.createElement("label");
            row.className = "role-check-item" + (manageable ? "" : " locked");

            const left = document.createElement("span");
            left.className = "check-row";

            const chk = document.createElement("input");
            chk.type = "checkbox";
            chk.value = r.id;
            chk.checked = assigned.has(r.id);
            chk.disabled = !manageable;

            const dot = document.createElement("span");
            dot.className = "member-role-dot";
            dot.style.background = r.color;

            const nm = document.createElement("span");
            nm.textContent = r.name;
            nm.style.color = r.color;

            left.appendChild(chk);
            left.appendChild(dot);
            left.appendChild(nm);

            const prio = document.createElement("span");
            prio.className = "role-prio-tag";
            prio.textContent = manageable ? `P:${r.priority}` : `🔒 P:${r.priority}`;

            row.appendChild(left);
            row.appendChild(prio);
            listEl.appendChild(row);
        });

        openModal("member-roles-modal");
    }

    function populateServerSettingsForm() {
        if (!serverSettings) return;
        $("adm-server-name").value = serverSettings.name || "";
        $("adm-invite-code").value = serverSettings.inviteCode || "";
        $("adm-turn-url").value = serverSettings.turnServer?.url || "";
        $("adm-turn-user").value = serverSettings.turnServer?.username || "";
        $("adm-turn-pass").value = serverSettings.turnServer?.credential || "";

        const afkSel = $("adm-afk-channel");
        afkSel.innerHTML = '<option value="">Devre Dışı</option>';
        channels
            .filter((c) => c.type === "voice")
            .forEach((c) => {
                const opt = document.createElement("option");
                opt.value = c.id;
                opt.textContent = c.name;
                afkSel.appendChild(opt);
            });
        afkSel.value = serverSettings.afkChannelId || "";
        $("adm-afk-timeout").value = String(serverSettings.afkTimeoutSec ?? 300);

        renderRolesManager();
    }

    function renderRolesManager() {
        const listEl = $("roles-list");
        listEl.innerHTML = "";
        const selectedId = $("edit-role-id").value;

        roles.forEach((r) => {
            const li = document.createElement("li");
            li.className = "role-list-item" + (r.id === selectedId ? " active" : "");

            const left = document.createElement("span");
            left.style.display = "inline-flex";
            left.style.alignItems = "center";
            left.style.gap = "7px";
            left.innerHTML = `<span class="member-role-dot" style="background:${escapeHTML(r.color)}"></span><span>${escapeHTML(r.name)}</span>`;

            const prio = document.createElement("span");
            prio.className = "role-prio-tag";
            prio.textContent = canManageRole(r) ? `${r.priority}` : `🔒 ${r.priority}`;

            li.appendChild(left);
            li.appendChild(prio);
            li.onclick = () => selectRoleInEditor(r);
            listEl.appendChild(li);
        });

        if (!selectedId && roles.length) {
            const editable = roles.find((r) => canManageRole(r)) || roles[0];
            selectRoleInEditor(editable);
        } else if (selectedId) {
            const current = roles.find((r) => r.id === selectedId);
            if (current) fillRoleEditor(current);
        }
    }

    function selectRoleInEditor(role) {
        $("edit-role-id").value = role ? role.id : "";
        fillRoleEditor(role);
        renderRolesManager();
    }

    function fillRoleEditor(role) {
        $("role-editor-err").textContent = "";
        const editable = !role || canManageRole(role);

        $("edit-role-name").value = role ? role.name : "";
        $("edit-role-color").value = role ? role.color : "#5865f2";
        $("edit-role-priority").value = role ? role.priority : Math.max(1, Math.min(40, myPower - 1));

        $("edit-role-name").disabled = !editable;
        $("edit-role-color").disabled = !editable;
        $("edit-role-priority").disabled = !editable;

        document.querySelectorAll(".role-perm-chk").forEach((chk) => {
            const key = chk.getAttribute("data-perm");
            chk.checked = Boolean(role?.permissions?.[key]);
            const lockAdmin = key === "administrator" && !isServerOwner && !myPermissions.administrator;
            chk.disabled = !editable || lockAdmin;
        });

        $("btn-save-role").disabled = !editable;
        $("btn-delete-role").style.display = role && editable && roles.length > 1 ? "" : "none";
        if (!editable) {
            $("role-editor-err").textContent = "Bu rol kendi yetki seviyenize eşit veya üstünde olduğu için kilitli.";
        }
    }

    // =========================================================================
    // METİN SOHBETİ (MESAJLAR, YANIT, REAKSİYON, SABİTLEME, ARAMA)
    // =========================================================================
    function formatMessageBody(text) {
        let safe = escapeHTML(text);
        safe = safe.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
        safe = safe.replace(/@([a-zA-Z0-9._-]{2,20})/g, '<span class="mention-hl">@$1</span>');
        return safe;
    }

    function createMessageElement(msg) {
        const isMentioned = me && msg.text && new RegExp(`@${me.username}\\b`, "i").test(msg.text);
        const row = document.createElement("div");
        row.className = "msg-row" + (isMentioned ? " mentioned" : "") + (msg.pinned ? " pinned-msg" : "");
        row.dataset.msgId = msg.id;

        const av = document.createElement("div");
        av.className = "avatar-circle md";
        renderAvatarContent(av, {
            avatar: msg.avatar,
            displayName: msg.displayName,
            username: msg.sender,
            color: msg.color
        });

        const body = document.createElement("div");
        body.className = "msg-body";

        if (msg.replyTo) {
            const rep = document.createElement("div");
            rep.className = "msg-reply-ref";
            rep.textContent = `↪ ${msg.replyTo.sender}: ${msg.replyTo.text}`;
            body.appendChild(rep);
        }

        const head = document.createElement("div");
        head.className = "msg-head";

        const senderEl = document.createElement("span");
        senderEl.className = "msg-sender";
        senderEl.textContent = msg.displayName || msg.sender;
        senderEl.style.color = msg.topRole?.color || msg.color || "var(--text-bright)";
        senderEl.onclick = () => {
            if (me && msg.sender !== me.username) openDmWith(msg.sender);
        };
        head.appendChild(senderEl);

        if (msg.topRole?.name) {
            const rTag = document.createElement("span");
            rTag.className = "msg-role-tag";
            rTag.style.color = msg.topRole.color || "#949ba4";
            rTag.textContent = msg.topRole.name;
            head.appendChild(rTag);
        }

        const timeEl = document.createElement("span");
        timeEl.className = "msg-time";
        timeEl.textContent = msg.time || "";
        head.appendChild(timeEl);

        if (msg.pinned) {
            const pinEl = document.createElement("span");
            pinEl.className = "msg-pin-flag";
            pinEl.textContent = "📌 Sabitli";
            head.appendChild(pinEl);
        }

        body.appendChild(head);

        if (msg.text) {
            const txtEl = document.createElement("div");
            txtEl.className = "msg-text";
            txtEl.innerHTML = formatMessageBody(msg.text);
            body.appendChild(txtEl);
        }

        if (msg.image) {
            const img = document.createElement("img");
            img.className = "msg-img";
            img.src = msg.image;
            img.alt = "Görsel";
            img.onclick = () => {
                $("lightbox-img").src = msg.image;
                $("lightbox").classList.add("show");
            };
            body.appendChild(img);
        }

        // Reaksiyonlar
        if (msg.reactions && Object.keys(msg.reactions).length) {
            const rWrap = document.createElement("div");
            rWrap.className = "msg-reactions";
            for (const [emoji, usersArr] of Object.entries(msg.reactions)) {
                const pill = document.createElement("button");
                const isMine = me && usersArr.includes(me.username);
                pill.className = "react-pill" + (isMine ? " mine" : "");
                pill.title = usersArr.join(", ");
                pill.textContent = `${emoji} ${usersArr.length}`;
                pill.onclick = () => {
                    socket.emit("toggle-reaction", {
                        serverId: activeServerId,
                        channelId: activeChannelId,
                        msgId: msg.id,
                        emoji
                    });
                };
                rWrap.appendChild(pill);
            }
            body.appendChild(rWrap);
        }

        // Hover aksiyon çubuğu
        const actions = document.createElement("div");
        actions.className = "msg-actions";

        ALLOWED_REACTIONS.slice(0, 3).forEach((emoji) => {
            const b = document.createElement("button");
            b.className = "msg-act-btn";
            b.textContent = emoji;
            b.onclick = () => {
                socket.emit("toggle-reaction", {
                    serverId: activeServerId,
                    channelId: activeChannelId,
                    msgId: msg.id,
                    emoji
                });
            };
            actions.appendChild(b);
        });

        const repBtn = document.createElement("button");
        repBtn.className = "msg-act-btn";
        repBtn.title = "Yanıtla";
        repBtn.textContent = "↩";
        repBtn.onclick = () => setReplyTarget(msg);
        actions.appendChild(repBtn);

        if (myPermissions.administrator || myPermissions.pinMessages) {
            const pinBtn = document.createElement("button");
            pinBtn.className = "msg-act-btn";
            pinBtn.title = msg.pinned ? "Sabitlemeyi Kaldır" : "Sabitle";
            pinBtn.textContent = "📌";
            pinBtn.onclick = () => {
                socket.emit("toggle-pin", {
                    serverId: activeServerId,
                    channelId: activeChannelId,
                    msgId: msg.id
                });
            };
            actions.appendChild(pinBtn);
        }

        const isMine = me && msg.sender === me.username;
        const targetMem = members.find((x) => x.username === msg.sender);
        const canDel = isMine || ((myPermissions.administrator || myPermissions.deleteMessages) && (!targetMem || canActOn(targetMem)));
        if (canDel) {
            const delBtn = document.createElement("button");
            delBtn.className = "msg-act-btn";
            delBtn.title = "Sil";
            delBtn.textContent = "🗑️";
            delBtn.onclick = () => {
                socket.emit("delete-message", {
                    serverId: activeServerId,
                    channelId: activeChannelId,
                    msgId: msg.id
                });
            };
            actions.appendChild(delBtn);
        }

        row.appendChild(av);
        row.appendChild(body);
        row.appendChild(actions);
        return row;
    }

    function renderMessages() {
        const box = $("messages");
        box.innerHTML = "";
        const q = ($("search-input").value || "").trim().toLowerCase();
        const list = messagesByChannel[activeChannelId] || [];

        const filtered = q
            ? list.filter((m) => (m.text || "").toLowerCase().includes(q) || (m.sender || "").toLowerCase().includes(q))
            : list;

        if (!filtered.length) {
            const empty = document.createElement("div");
            empty.className = "sys-msg";
            empty.textContent = q ? "Aramanla eşleşen mesaj bulunamadı." : "Henüz mesaj yok. İlk mesajı yaz!";
            box.appendChild(empty);
            return;
        }

        const frag = document.createDocumentFragment();
        filtered.forEach((m) => frag.appendChild(createMessageElement(m)));
        box.appendChild(frag);
        box.scrollTop = box.scrollHeight;
    }

    function setReplyTarget(msg) {
        replyTarget = {
            id: msg.id,
            sender: msg.displayName || msg.sender,
            text: msg.text || "",
            hasImage: Boolean(msg.image)
        };
        $("reply-text").textContent = `Yanıtlanıyor: ${replyTarget.sender} — ${replyTarget.text || "[Görsel]"}`;
        $("reply-banner").classList.add("show");
        $("chat-input").focus();
    }

    function clearReply() {
        replyTarget = null;
        $("reply-banner").classList.remove("show");
    }

    function compressImageFile(file, maxW = 1280, quality = 0.82) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => {
                const img = new Image();
                img.onload = () => {
                    let w = img.width;
                    let h = img.height;
                    if (w > maxW) {
                        h = Math.round((h * maxW) / w);
                        w = maxW;
                    }
                    const canvas = document.createElement("canvas");
                    canvas.width = w;
                    canvas.height = h;
                    canvas.getContext("2d").drawImage(img, 0, 0, w, h);
                    resolve(canvas.toDataURL("image/jpeg", quality));
                };
                img.onerror = reject;
                img.src = reader.result;
            };
            reader.onerror = reject;
            reader.readAsDataURL(file);
        });
    }

    async function sendChatImage(file) {
        if (!activeServerId || !activeChannelId) return;
        try {
            const dataUrl = await compressImageFile(file, 1280, 0.82);
            socket.emit("chat-message", {
                serverId: activeServerId,
                channelId: activeChannelId,
                text: $("chat-input").value.trim(),
                image: dataUrl,
                replyTo: replyTarget
            });
            $("chat-input").value = "";
            clearReply();
        } catch {
            showToast("Görsel işlenemedi.", "err");
        }
    }

    // =========================================================================
    // SES DSP ZİNCİRİ (85Hz HPF, NOISE GATE, COMPRESSOR, GAIN, NS/AEC/AGC)
    // =========================================================================
    async function loadMediaDevices() {
        if (!navigator.mediaDevices?.enumerateDevices) return;
        const devs = await navigator.mediaDevices.enumerateDevices();
        const micSel = $("mic-select");
        const spkSel = $("spk-select");
        const camSel = $("cam-select");
        const curMic = micSel.value;
        const curSpk = spkSel.value;
        const curCam = camSel.value;

        micSel.innerHTML = '<option value="">Varsayılan Mikrofon</option>';
        spkSel.innerHTML = '<option value="">Varsayılan Çıkış</option>';
        camSel.innerHTML = '<option value="">Varsayılan Kamera</option>';

        devs.forEach((d) => {
            const opt = document.createElement("option");
            opt.value = d.deviceId;
            if (d.kind === "audioinput") {
                opt.textContent = d.label || `Mikrofon ${micSel.length}`;
                micSel.appendChild(opt);
            } else if (d.kind === "audiooutput") {
                opt.textContent = d.label || `Hoparlör ${spkSel.length}`;
                spkSel.appendChild(opt);
            } else if (d.kind === "videoinput") {
                opt.textContent = d.label || `Kamera ${camSel.length}`;
                camSel.appendChild(opt);
            }
        });

        if (curMic) micSel.value = curMic;
        if (curSpk) spkSel.value = curSpk;
        if (curCam) camSel.value = curCam;
    }

    function applyLiveDspToggles() {
        if (highPassNode) {
            highPassNode.type = "highpass";
            highPassNode.frequency.value = $("chk-hpf").checked ? 85 : 10;
            highPassNode.Q.value = 0.7;
        }
        if (compressorNode) {
            if ($("chk-comp").checked) {
                compressorNode.threshold.value = -18;
                compressorNode.knee.value = 18;
                compressorNode.ratio.value = 6;
                compressorNode.attack.value = 0.004;
                compressorNode.release.value = 0.14;
            } else {
                compressorNode.threshold.value = 0;
                compressorNode.ratio.value = 1;
            }
        }
    }

    async function buildMicPipeline() {
        const ctx = ensureSharedAudioCtx();
        if (rawMicStream) rawMicStream.getTracks().forEach((t) => t.stop());
        if (micSourceNode) {
            try { micSourceNode.disconnect(); } catch { }
        }

        rawMicStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                deviceId: $("mic-select").value ? { exact: $("mic-select").value } : undefined,
                noiseSuppression: $("chk-ns").checked,
                echoCancellation: $("chk-aec").checked,
                autoGainControl: $("chk-agc").checked,
                channelCount: 1
            }
        });

        micSourceNode = ctx.createMediaStreamSource(rawMicStream);
        if (!highPassNode) highPassNode = ctx.createBiquadFilter();
        if (!micAnalyserNode) {
            micAnalyserNode = ctx.createAnalyser();
            micAnalyserNode.fftSize = 256;
        }
        if (!noiseGateNode) {
            noiseGateNode = ctx.createGain();
            noiseGateNode.gain.value = 1;
        }
        if (!compressorNode) compressorNode = ctx.createDynamicsCompressor();
        if (!micGainNode) micGainNode = ctx.createGain();
        if (!micDestNode) micDestNode = ctx.createMediaStreamDestination();

        micGainNode.gain.value = parseFloat($("mic-gain").value || "1");
        applyLiveDspToggles();

        micSourceNode.connect(highPassNode);
        highPassNode.connect(micAnalyserNode);
        highPassNode.connect(noiseGateNode);
        noiseGateNode.connect(compressorNode);
        compressorNode.connect(micGainNode);
        micGainNode.connect(micDestNode);

        processedMicStream = micDestNode.stream;
        const newTrack = processedMicStream.getAudioTracks()[0];

        for (const peer of peers.values()) {
            if (peer.micSender && newTrack) {
                await peer.micSender.replaceTrack(newTrack).catch(() => { });
            }
        }

        applyMuteState();
        startDspAndVisualLoops();
        loadMediaDevices().catch(() => { });
    }

    function isEffectivelyMuted() {
        if (serverMuted || selfMuted || deafened) return true;
        if (pttEnabled && !pttPressed) return true;
        return false;
    }

    function applyMuteState() {
        const muted = isEffectivelyMuted();
        if (processedMicStream) {
            processedMicStream.getAudioTracks().forEach((t) => { t.enabled = !muted; });
        }
        if (masterOutGain) {
            masterOutGain.gain.value = deafened ? 0 : 1;
        }

        const micBtn = $("btn-mute");
        const mMicBtn = $("m-btn-mute");
        const deafBtn = $("btn-deafen");
        const mDeafBtn = $("m-btn-deafen");

        const micVisualMuted = selfMuted || serverMuted || deafened;
        [micBtn, mMicBtn].forEach((b) => {
            if (!b) return;
            b.classList.toggle("muted", micVisualMuted);
            b.textContent = serverMuted ? "🔇" : (micVisualMuted ? "🎙️✕" : "🎙️");
        });
        [deafBtn, mDeafBtn].forEach((b) => {
            if (!b) return;
            b.classList.toggle("muted", deafened);
            b.textContent = deafened ? "🎧✕" : "🎧";
        });

        const pttBadge = $("ptt-indicator");
        if (pttBadge) {
            pttBadge.style.display = voiceChannelId && pttEnabled ? "block" : "none";
            pttBadge.textContent = pttPressed
                ? `Bas-Konuş AKTİF [${pttKey}]`
                : `Bas-Konuş: [${pttKey}] Basılı Tut`;
            pttBadge.classList.toggle("active", pttPressed);
        }

        pushOverlayState();
    }

    function toggleMute() {
        if (!voiceChannelId) return;
        if (serverMuted) {
            showToast("Sunucu yöneticisi tarafından susturuldun.", "err");
            return;
        }
        selfMuted = !selfMuted;
        playTone(selfMuted ? 380 : 620, 0.06);
        applyMuteState();
        socket.emit("voice-status-update", { selfMuted });
    }

    function toggleDeafen() {
        if (!voiceChannelId) return;
        deafened = !deafened;
        playTone(deafened ? 310 : 540, 0.07);
        applyMuteState();
        socket.emit("voice-status-update", { deafened });
    }

    function startDspAndVisualLoops() {
        stopDspAndVisualLoops();
        const micBuf = new Uint8Array(128);
        const peerBuf = new Uint8Array(64);

        // 1. Düşük-CPU Noise Gate + AFK aktivite + kendi konuşma tespiti (45ms)
        dspLoopTimer = setInterval(() => {
            if (!micAnalyserNode || !noiseGateNode || !sharedAudioCtx) return;

            micAnalyserNode.getByteTimeDomainData(micBuf);
            let sum = 0;
            for (let i = 0; i < micBuf.length; i++) {
                const v = (micBuf[i] - 128) / 128;
                sum += v * v;
            }
            const rms = Math.sqrt(sum / micBuf.length);
            const pct = Math.min(100, Math.round(rms * 260));

            const now = Date.now();
            const effMuted = isEffectivelyMuted();

            if (effMuted) {
                gateOpen = false;
                noiseGateNode.gain.setTargetAtTime(0, sharedAudioCtx.currentTime, 0.015);
            } else if (gateThreshold <= 0) {
                gateOpen = true;
                noiseGateNode.gain.setTargetAtTime(1, sharedAudioCtx.currentTime, 0.01);
            } else if (pct >= gateThreshold) {
                gateOpen = true;
                gateHoldUntil = now + 240;
                noiseGateNode.gain.setTargetAtTime(1, sharedAudioCtx.currentTime, 0.008);
            } else if (now > gateHoldUntil) {
                gateOpen = false;
                noiseGateNode.gain.setTargetAtTime(0, sharedAudioCtx.currentTime, 0.035);
            }

            const amSpeaking = !effMuted && (gateThreshold > 0 ? gateOpen : pct > 8);
            setSpeakingState(socket.id, amSpeaking);

            // AFK zamanlayıcısını sıfırlamak için 15 saniyede bir ses aktivite sinyali
            if (amSpeaking && now - lastVoiceActivitySent > 15000) {
                lastVoiceActivitySent = now;
                socket.emit("voice-activity");
            }

            if (!document.hidden && !gameMode) {
                const barW = effMuted ? "0%" : `${pct}%`;
                $("mic-meter").style.width = barW;
                $("modal-mic-meter").style.width = barW;
            }
        }, 45);

        // 2. Karşı taraf konuşma algılama + Overlay güncelleme (110ms)
        visualLoopTimer = setInterval(() => {
            for (const [peerId, peer] of peers.entries()) {
                let speaking = false;
                for (const node of peer.audioNodes) {
                    if (!node.active) continue;
                    node.analyser.getByteTimeDomainData(peerBuf);
                    let sum = 0;
                    for (let i = 0; i < peerBuf.length; i++) {
                        const v = (peerBuf[i] - 128) / 128;
                        sum += v * v;
                    }
                    const rms = Math.sqrt(sum / peerBuf.length);
                    if (rms > 0.028) {
                        speaking = true;
                        break;
                    }
                }
                setSpeakingState(peerId, speaking);
            }
            pushOverlayState();
        }, 110);
    }

    function stopDspAndVisualLoops() {
        if (dspLoopTimer) { clearInterval(dspLoopTimer); dspLoopTimer = null; }
        if (visualLoopTimer) { clearInterval(visualLoopTimer); visualLoopTimer = null; }
        $("mic-meter").style.width = "0%";
        $("modal-mic-meter").style.width = "0%";
    }

    function setSpeakingState(socketId, speaking) {
        const prev = Boolean(speakingMap.get(socketId));
        if (prev === speaking) return;
        speakingMap.set(socketId, speaking);

        if (!gameMode && !document.hidden) {
            document.querySelectorAll(`[data-voice-uid="${socketId}"]`).forEach((el) => {
                el.classList.toggle("speaking", speaking);
            });
            document.querySelectorAll(`[data-member-uid="${socketId}"]`).forEach((el) => {
                el.classList.toggle("speaking", speaking);
            });
            const tile = document.getElementById("tile-cam-" + (socketId === socket.id ? "local" : socketId));
            if (tile) tile.classList.toggle("speaking", speaking);
        }

        pushOverlayState();
    }

    function clearAllSpeakingVisuals() {
        document.querySelectorAll(".speaking").forEach((el) => el.classList.remove("speaking"));
    }

    // =========================================================================
    // CANLI VIDEO SAHNESİ (UYARLANABİLİR IZGARA + SPOTLIGHT)
    // =========================================================================
    function updateStageLayout() {
        const stage = $("media-stage");
        const tilesWrap = $("stage-tiles");
        const tiles = Array.from(tilesWrap.querySelectorAll(".video-tile"));

        if (!tiles.length) {
            stage.classList.remove("active", "expanded");
            spotlightTileId = null;
            $("btn-exit-spotlight").style.display = "none";
            return;
        }

        stage.classList.add("active");
        $("stage-count-lbl").textContent = `Canlı Sahne (${tiles.length} yayın)`;

        const spotExists = spotlightTileId && document.getElementById("tile-" + spotlightTileId);
        if (!spotExists) spotlightTileId = null;

        tilesWrap.classList.toggle("spotlight", Boolean(spotlightTileId));
        $("btn-exit-spotlight").style.display = spotlightTileId ? "" : "none";

        tiles.forEach((t) => {
            const tid = t.id.replace(/^tile-/, "");
            t.classList.toggle("hidden-in-spot", Boolean(spotlightTileId && tid !== spotlightTileId));
        });
    }

    function toggleSpotlight(tileKey) {
        spotlightTileId = spotlightTileId === tileKey ? null : tileKey;
        updateStageLayout();
    }

    function showMediaTile(tileKey, label, stream, { kind = "cam", isLocal = false } = {}) {
        const id = "tile-" + tileKey;
        let tile = document.getElementById(id);
        if (!tile) {
            tile = document.createElement("div");
            tile.id = id;
            tile.className = "video-tile";
            tile.onclick = () => toggleSpotlight(tileKey);

            const video = document.createElement("video");
            video.autoplay = true;
            video.playsInline = true;
            video.muted = true; // Sesler Web Audio API üzerinden yönetilir
            if (kind === "cam") video.classList.add("cover");
            if (isLocal && kind === "cam" && mirrorCam) video.classList.add("mirrored");

            const lbl = document.createElement("div");
            lbl.className = "tile-label";
            lbl.textContent = label;

            tile.appendChild(video);
            tile.appendChild(lbl);
            $("stage-tiles").appendChild(tile);
        }

        const vid = tile.querySelector("video");
        if (vid.srcObject !== stream) vid.srcObject = stream;
        tile.querySelector(".tile-label").textContent = label;
        if (isLocal && kind === "cam") vid.classList.toggle("mirrored", mirrorCam);
        vid.play().catch(() => { });

        if (kind === "screen" && !spotlightTileId) {
            spotlightTileId = tileKey;
        }
        updateStageLayout();
    }

    function removeMediaTile(tileKey) {
        const tile = document.getElementById("tile-" + tileKey);
        if (tile) tile.remove();
        if (spotlightTileId === tileKey) spotlightTileId = null;
        updateStageLayout();
    }

    // =========================================================================
    // WEBRTC MESH (PERFECT NEGOTIATION, BITRATE KONTROLÜ, PLAYOUTDELAY=0)
    // =========================================================================
    function getCamConstraints() {
        const q = parseInt($("cam-quality").value, 10) || 480;
        const map = {
            360: { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 15, max: 20 } },
            480: { width: { ideal: 854 }, height: { ideal: 480 }, frameRate: { ideal: 24, max: 24 } },
            720: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } }
        };
        const base = map[q] || map[480];
        const devId = $("cam-select").value;
        return {
            video: devId ? { ...base, deviceId: { exact: devId } } : { ...base, facingMode },
            audio: false
        };
    }

    async function applyVideoBitrateLimit(sender, kind, res = 480) {
        if (!sender || typeof sender.getParameters !== "function") return;
        try {
            const params = sender.getParameters();
            if (!params.encodings || !params.encodings.length) params.encodings = [{}];
            if (kind === "screen") {
                params.encodings[0].maxBitrate = res >= 1080 ? 2500000 : 1500000;
            } else {
                params.encodings[0].maxBitrate = res >= 720 ? 900000 : (res <= 360 ? 350000 : 550000);
            }
            await sender.setParameters(params);
        } catch { }
    }

    function getOrCreatePeer(peerId) {
        if (peers.has(peerId)) return peers.get(peerId);

        const pc = new RTCPeerConnection({ iceServers: voiceIceServers });
        const peer = {
            pc,
            polite: socket.id < peerId,
            makingOffer: false,
            ignoreOffer: false,
            pendingCandidates: [],
            micSender: null,
            camSender: null,
            screenSenders: [],
            audioNodes: [],
            lastStats: null
        };
        peers.set(peerId, peer);

        if (processedMicStream) {
            const mt = processedMicStream.getAudioTracks()[0];
            if (mt) peer.micSender = pc.addTrack(mt, processedMicStream);
        }
        if (camStream) {
            const ct = camStream.getVideoTracks()[0];
            if (ct) {
                peer.camSender = pc.addTrack(ct, camStream);
                applyVideoBitrateLimit(peer.camSender, "cam", parseInt($("cam-quality").value, 10) || 480);
            }
        }
        if (screenStream) {
            const resVal = parseInt($("screen-res").value, 10) || 720;
            screenStream.getTracks().forEach((t) => {
                const s = pc.addTrack(t, screenStream);
                peer.screenSenders.push(s);
                if (t.kind === "video") applyVideoBitrateLimit(s, "screen", resVal);
            });
        }

        pc.onicecandidate = (e) => {
            if (e.candidate) socket.emit("webrtc-ice", { to: peerId, candidate: e.candidate });
        };

        pc.onconnectionstatechange = () => updateHealthPill(lastPingMs);

        pc.ontrack = (e) => {
            if (e.receiver && "playoutDelayHint" in e.receiver) {
                e.receiver.playoutDelayHint = 0;
            }
            const stream = e.streams[0] || new MediaStream([e.track]);

            if (e.track.kind === "audio") {
                attachRemoteAudio(peerId, peer, e.track, stream);
            } else if (e.track.kind === "video") {
                const m = voiceMembersCache.get(peerId) || members.find((x) => x.id === peerId);
                const name = m?.displayName || m?.username || "Arkadaş";
                let kind = "cam";
                if (m?.screenStreamId && stream.id === m.screenStreamId) kind = "screen";
                else if (m?.camStreamId && stream.id === m.camStreamId) kind = "cam";
                else if (document.getElementById("tile-cam-" + peerId) || (m?.screenSharing && !m?.camOn)) kind = "screen";

                const tileKey = `${kind}-${peerId}`;
                const icon = kind === "screen" ? "🖥️" : "📹";
                showMediaTile(tileKey, `${icon} ${name}`, stream, { kind, isLocal: false });

                e.track.onended = () => removeMediaTile(tileKey);
            }
        };

        return peer;
    }

    function attachRemoteAudio(peerId, peer, track, stream) {
        const sinkEl = document.createElement("audio");
        sinkEl.autoplay = true;
        sinkEl.muted = true;
        sinkEl.srcObject = stream;
        $("hidden-audio-sink").appendChild(sinkEl);

        const ctx = ensureSharedAudioCtx();
        const src = ctx.createMediaStreamSource(new MediaStream([track]));
        const gain = ctx.createGain();

        const m = voiceMembersCache.get(peerId) || members.find((x) => x.id === peerId);
        const volKey = m?.username || peerId;
        gain.gain.value = userVolumes.has(volKey) ? userVolumes.get(volKey) : 1;

        const analyser = ctx.createAnalyser();
        analyser.fftSize = 128;

        src.connect(gain);
        gain.connect(analyser);
        gain.connect(masterOutGain);

        const nodeObj = { trackId: track.id, src, gain, analyser, sinkEl, active: true };
        peer.audioNodes.push(nodeObj);
        track.onended = () => cleanupRemoteAudioNode(peer, nodeObj);
    }

    function cleanupRemoteAudioNode(peer, nodeObj) {
        nodeObj.active = false;
        try {
            nodeObj.src.disconnect();
            nodeObj.gain.disconnect();
            nodeObj.analyser.disconnect();
        } catch { }
        nodeObj.sinkEl.remove();
        peer.audioNodes = peer.audioNodes.filter((n) => n !== nodeObj);
    }

    async function sendOfferToPeer(peerId, iceRestart = false) {
        const peer = getOrCreatePeer(peerId);
        try {
            peer.makingOffer = true;
            const offer = await peer.pc.createOffer(iceRestart ? { iceRestart: true } : undefined);
            offer.sdp = optimizeOpusSDP(offer.sdp);
            await peer.pc.setLocalDescription(offer);
            socket.emit("webrtc-offer", { to: peerId, offer: peer.pc.localDescription });
        } catch { } finally {
            peer.makingOffer = false;
        }
    }

    async function flushCandidates(peer) {
        const q = peer.pendingCandidates;
        peer.pendingCandidates = [];
        for (const c of q) {
            await peer.pc.addIceCandidate(c).catch(() => { });
        }
    }

    function closePeer(peerId) {
        const peer = peers.get(peerId);
        if (peer) {
            peer.audioNodes.slice().forEach((n) => cleanupRemoteAudioNode(peer, n));
            peer.pc.close();
            peers.delete(peerId);
        }
        setSpeakingState(peerId, false);
        removeMediaTile("cam-" + peerId);
        removeMediaTile("screen-" + peerId);
    }

    function refreshVoiceMembersCacheFrom(memberList) {
        voiceMembersCache.clear();
        if (!voiceChannelId) return;
        for (const m of memberList) {
            if (m.online && m.id && m.voiceChannel === voiceChannelId) {
                voiceMembersCache.set(m.id, m);
            }
        }
        pushOverlayState();
    }

    function updateVoicePanelUI() {
        const connected = Boolean(voiceChannelId);
        $("voice-conn-wrap").style.display = connected ? "flex" : "none";
        $("mobile-voice-bar").classList.toggle("active", connected);

        if (connected) {
            const srv = myServers.find((s) => s.id === voiceServerId);
            const ch = voiceServerId === activeServerId ? channels.find((c) => c.id === voiceChannelId) : null;
            $("voice-status").textContent = "Ses Bağlı";
            $("voice-channel-sub").textContent = ch
                ? `${ch.name}`
                : (srv ? `${srv.name} (Ses)` : "Aktif Kanal");
        }
        applyMuteState();
    }

    async function joinVoiceChannel(serverId, channelId) {
        ensureSharedAudioCtx();
        if (!processedMicStream) {
            try {
                await buildMicPipeline();
            } catch (err) {
                showToast("Mikrofon açılamadı: " + err.message, "err");
                return;
            }
        }

        if (voiceChannelId) {
            stopCamera(true);
            stopScreenShare(true);
            for (const pid of Array.from(peers.keys())) closePeer(pid);
        }

        socket.emit("join-voice", { serverId, channelId }, async (res) => {
            if (!res || res.ok === false) {
                showToast(res?.error || "Ses kanalına katılınamadı.", "err");
                return;
            }

            voiceServerId = serverId;
            voiceChannelId = channelId;
            if (Array.isArray(res.iceServers) && res.iceServers.length) {
                voiceIceServers = res.iceServers;
            }
            if (res.isAfkChannel) {
                selfMuted = true;
                socket.emit("voice-status-update", { selfMuted: true });
            }

            playTone(680, 0.08);
            updateVoicePanelUI();
            renderServerRail();
            renderChannels();

            const peerIds = Array.isArray(res.peers) ? res.peers : [];
            for (const pid of peerIds) {
                await sendOfferToPeer(pid);
            }
            if (voiceServerId === activeServerId) {
                refreshVoiceMembersCacheFrom(members);
            }
        });
    }

    function leaveVoiceCleanup(notifyServer = true) {
        if (!voiceChannelId) return;
        stopCamera(true);
        stopScreenShare(true);

        for (const pid of Array.from(peers.keys())) closePeer(pid);
        peers.clear();
        speakingMap.clear();
        voiceMembersCache.clear();

        if (rawMicStream) {
            rawMicStream.getTracks().forEach((t) => t.stop());
            rawMicStream = null;
        }
        processedMicStream = null;
        stopDspAndVisualLoops();

        voiceServerId = null;
        voiceChannelId = null;
        selfMuted = false;
        deafened = false;

        if (notifyServer) socket.emit("leave-voice");
        playTone(340, 0.09);
        updateVoicePanelUI();
        renderServerRail();
        renderChannels();
        renderMembers();
        pushOverlayState(true);
    }

    // --- KAMERA AÇ / KAPAT / ÇEVİR ---
    function updateCamButtonsUI(on) {
        $("btn-cam").classList.toggle("on", on);
        $("m-btn-cam").classList.toggle("on", on);
        const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
        $("btn-flip-cam").style.display = on && isMobile ? "" : "none";
        $("m-btn-flip").style.display = on && isMobile ? "" : "none";
    }

    async function toggleCamera() {
        if (!voiceChannelId) return showToast("Kamera açmak için önce bir ses kanalına katıl.", "info");
        if (camStream) return stopCamera();

        try {
            camStream = await navigator.mediaDevices.getUserMedia(getCamConstraints());
        } catch (err) {
            return showToast("Kamera açılamadı: " + err.message, "err");
        }

        const vTrack = camStream.getVideoTracks()[0];
        vTrack.onended = () => stopCamera();

        showMediaTile("cam-local", `📹 ${me.displayName || me.username} (Sen)`, camStream, { kind: "cam", isLocal: true });
        updateCamButtonsUI(true);
        socket.emit("voice-status-update", { camOn: true, camStreamId: camStream.id });

        const q = parseInt($("cam-quality").value, 10) || 480;
        for (const [peerId, peer] of peers.entries()) {
            peer.camSender = peer.pc.addTrack(vTrack, camStream);
            await applyVideoBitrateLimit(peer.camSender, "cam", q);
            await sendOfferToPeer(peerId);
        }
    }

    async function restartCameraTrack() {
        if (!camStream) return;
        try {
            const nextStream = await navigator.mediaDevices.getUserMedia(getCamConstraints());
            const newTrack = nextStream.getVideoTracks()[0];
            const oldTrack = camStream.getVideoTracks()[0];
            camStream.removeTrack(oldTrack);
            oldTrack.stop();
            camStream.addTrack(newTrack);
            newTrack.onended = () => stopCamera();

            const q = parseInt($("cam-quality").value, 10) || 480;
            for (const peer of peers.values()) {
                if (peer.camSender) {
                    await peer.camSender.replaceTrack(newTrack).catch(() => { });
                    await applyVideoBitrateLimit(peer.camSender, "cam", q);
                }
            }
            showMediaTile("cam-local", `📹 ${me.displayName || me.username} (Sen)`, camStream, { kind: "cam", isLocal: true });
        } catch (err) {
            showToast("Kamera değiştirilemedi: " + err.message, "err");
        }
    }

    function flipCamera() {
        facingMode = facingMode === "user" ? "environment" : "user";
        $("cam-select").value = "";
        restartCameraTrack();
    }

    function stopCamera(silent = false) {
        if (!camStream) return;
        camStream.getTracks().forEach((t) => t.stop());
        camStream = null;
        removeMediaTile("cam-local");
        updateCamButtonsUI(false);

        for (const [peerId, peer] of peers.entries()) {
            if (peer.camSender) {
                try { peer.pc.removeTrack(peer.camSender); } catch { }
                peer.camSender = null;
                if (!silent) sendOfferToPeer(peerId);
            }
        }
        if (!silent) socket.emit("cam-stopped");
    }

    // --- EKRAN PAYLAŞIMI (ELECTRON GÖRSEL PENCERE SEÇİCİ + WEB FALLBACK) ---
    async function openScreenShareFlow() {
        if (!voiceChannelId) return showToast("Ekran paylaşmak için önce bir ses kanalına katıl.", "info");
        if (screenStream) return stopScreenShare();

        if (isElectron) {
            const sources = await window.electronAPI.getScreenSources();
            const grid = $("source-grid");
            grid.innerHTML = "";
            selectedScreenSourceId = sources[0]?.id || null;

            sources.forEach((src, idx) => {
                const card = document.createElement("div");
                card.className = "source-card" + (idx === 0 ? " selected" : "");
                card.innerHTML = `<img src="${src.thumbnail}" alt="" /><span>${escapeHTML(src.name)}</span>`;
                card.onclick = () => {
                    grid.querySelectorAll(".source-card").forEach((c) => c.classList.remove("selected"));
                    card.classList.add("selected");
                    selectedScreenSourceId = src.id;
                };
                grid.appendChild(card);
            });
            openModal("screen-modal");
        } else {
            await startScreenCapture();
        }
    }

    async function startScreenCapture() {
        const resVal = parseInt($("screen-res").value, 10) || 720;
        const fpsVal = parseInt($("screen-fps").value, 10) || 30;
        const withAudio = $("screen-audio").checked;

        if (isElectron) {
            await window.electronAPI.selectScreenSource({
                sourceId: selectedScreenSourceId,
                withAudio
            });
            closeModal("screen-modal");
        }

        try {
            screenStream = await navigator.mediaDevices.getDisplayMedia({
                video: {
                    width: { ideal: resVal >= 1080 ? 1920 : 1280 },
                    height: { ideal: resVal },
                    frameRate: { ideal: fpsVal, max: fpsVal }
                },
                audio: withAudio
            });
        } catch (err) {
            showToast("Ekran paylaşımı başlatılamadı.", "err");
            return;
        }

        const vTrack = screenStream.getVideoTracks()[0];
        vTrack.onended = () => stopScreenShare();

        $("btn-screen").classList.add("on");
        showMediaTile("screen-local", `🖥️ ${me.displayName || me.username} (Ekranın)`, screenStream, { kind: "screen", isLocal: true });
        socket.emit("voice-status-update", { screenSharing: true, screenStreamId: screenStream.id });

        for (const [peerId, peer] of peers.entries()) {
            peer.screenSenders = [];
            screenStream.getTracks().forEach((t) => {
                const s = peer.pc.addTrack(t, screenStream);
                peer.screenSenders.push(s);
                if (t.kind === "video") applyVideoBitrateLimit(s, "screen", resVal);
            });
            await sendOfferToPeer(peerId);
        }
    }

    function stopScreenShare(silent = false) {
        if (!screenStream) return;
        screenStream.getTracks().forEach((t) => t.stop());
        screenStream = null;
        $("btn-screen").classList.remove("on");
        removeMediaTile("screen-local");

        for (const [peerId, peer] of peers.entries()) {
            if (peer.screenSenders.length) {
                peer.screenSenders.forEach((s) => {
                    try { peer.pc.removeTrack(s); } catch { }
                });
                peer.screenSenders = [];
                if (!silent) sendOfferToPeer(peerId);
            }
        }
        if (!silent) socket.emit("screen-share-stopped");
    }

    // =========================================================================
    // EKİP & OYUN ARAÇLARI (READY-CHECK, ANKET, WATCH TOGETHER, SOUNDBOARD, BOARD, DM)
    // =========================================================================

    // 1. HAZIR KONTROLÜ (READY-CHECK)
    function renderReadyCheckBanner() {
        const banner = $("ready-check-banner");
        if (!activeReadyCheck) {
            banner.style.display = "none";
            return;
        }

        banner.style.display = "flex";
        $("rc-title").textContent = activeReadyCheck.title;
        $("rc-meta").textContent = `• ${activeReadyCheck.initiatorName} başlattı`;

        const canClose =
            (me && activeReadyCheck.initiator === me.username) ||
            Boolean(myPermissions.administrator || myPermissions.manageChannels);
        $("btn-rc-close").style.display = canClose ? "" : "none";

        const chipsWrap = $("rc-chips");
        chipsWrap.innerHTML = "";

        const statusLabels = { ready: "✓ Hazır", wait5: "⏳ 5 dk", no: "✕ Yok" };
        Object.values(activeReadyCheck.responses || {}).forEach((r) => {
            const chip = document.createElement("span");
            chip.className = `rc-chip ${r.status}`;
            chip.textContent = `${r.displayName}: ${statusLabels[r.status] || r.status}`;
            chipsWrap.appendChild(chip);
        });
    }

    // 2. HIZLI ANKET
    function renderPollsList() {
        const container = $("polls-list");
        container.innerHTML = "";
        if (!serverPolls.length) {
            container.innerHTML = '<div class="muted-note center">Henüz aktif anket yok.</div>';
            return;
        }

        serverPolls.forEach((poll) => {
            const card = document.createElement("div");
            card.className = "poll-card";

            const totalVotes = poll.options.reduce((acc, o) => acc + o.votes.length, 0);
            const hdr = document.createElement("div");
            hdr.className = "row-between";
            hdr.innerHTML = `<strong>${escapeHTML(poll.question)}</strong><span class="muted-inline">${escapeHTML(poll.creatorName)} • ${totalVotes} oy ${poll.closed ? "(Kapalı)" : ""}</span>`;
            card.appendChild(hdr);

            poll.options.forEach((opt, idx) => {
                const pct = totalVotes > 0 ? Math.round((opt.votes.length / totalVotes) * 100) : 0;
                const voted = me && opt.votes.includes(me.username);
                const btn = document.createElement("button");
                btn.className = "poll-opt-btn" + (voted ? " voted" : "");
                btn.disabled = Boolean(poll.closed);
                btn.innerHTML = `
                    <span class="poll-opt-fill" style="width:${pct}%"></span>
                    <span class="poll-opt-txt">${escapeHTML(opt.label)}</span>
                    <span class="poll-opt-cnt">${opt.votes.length} (${pct}%)</span>
                `;
                btn.onclick = () => {
                    socket.emit("poll-vote", { serverId: activeServerId, pollId: poll.id, optionIndex: idx });
                };
                card.appendChild(btn);
            });

            const canClose = !poll.closed && ((me && poll.creator === me.username) || myPermissions.administrator || myPermissions.manageChannels);
            if (canClose) {
                const closeBtn = document.createElement("button");
                closeBtn.className = "btn xs secondary";
                closeBtn.style.alignSelf = "flex-end";
                closeBtn.textContent = "Anketi Kapat";
                closeBtn.onclick = () => socket.emit("poll-close", { serverId: activeServerId, pollId: poll.id });
                card.appendChild(closeBtn);
            }

            container.appendChild(card);
        });
    }

    // 3. ORTAK İZLEME (YOUTUBE IFRAME API SENKRON)
    function loadYouTubeAPI() {
        if (window.YT && window.YT.Player) return Promise.resolve();
        if (ytApiPromise) return ytApiPromise;
        ytApiPromise = new Promise((resolve) => {
            const prev = window.onYouTubeIframeAPIReady;
            window.onYouTubeIframeAPIReady = () => {
                if (typeof prev === "function") prev();
                resolve();
            };
            const tag = document.createElement("script");
            tag.src = "https://www.youtube.com/iframe_api";
            document.head.appendChild(tag);
        });
        return ytApiPromise;
    }

    async function applyWatchState(w) {
        watchState = w || { active: false };
        const stage = $("watch-stage");

        if (!watchState.active || !watchState.videoId) {
            stage.style.display = "none";
            if (ytPlayer && typeof ytPlayer.destroy === "function") {
                try { ytPlayer.destroy(); } catch { }
            }
            ytPlayer = null;
            ytPlayerVideoId = null;
            $("yt-player-host").innerHTML = "";
            return;
        }

        stage.style.display = "flex";
        $("watch-title-lbl").textContent = watchState.title || "Ortak İzleme";
        $("watch-host-lbl").textContent = watchState.hostName ? `• ${watchState.hostName}` : "";

        const elapsed = watchState.playing ? (Date.now() - (watchState.updatedAt || Date.now())) / 1000 : 0;
        const targetTime = Math.max(0, (watchState.currentTime || 0) + elapsed);

        await loadYouTubeAPI();

        if (!ytPlayer || ytPlayerVideoId !== watchState.videoId) {
            if (ytPlayer && typeof ytPlayer.destroy === "function") {
                try { ytPlayer.destroy(); } catch { }
            }
            $("yt-player-host").innerHTML = '<div id="yt-inner-player"></div>';
            ytPlayerVideoId = watchState.videoId;
            suppressYtEventsUntil = Date.now() + 1800;

            ytPlayer = new window.YT.Player("yt-inner-player", {
                videoId: watchState.videoId,
                playerVars: {
                    autoplay: watchState.playing ? 1 : 0,
                    rel: 0,
                    modestbranding: 1,
                    start: Math.floor(targetTime)
                },
                events: {
                    onReady: (ev) => {
                        suppressYtEventsUntil = Date.now() + 1400;
                        ev.target.seekTo(targetTime, true);
                        if (watchState.playing) ev.target.playVideo();
                        else ev.target.pauseVideo();
                    },
                    onStateChange: (ev) => {
                        if (Date.now() < suppressYtEventsUntil || !watchState.active) return;
                        const cur = ev.target.getCurrentTime ? ev.target.getCurrentTime() : 0;
                        if (ev.data === window.YT.PlayerState.PLAYING) {
                            socket.emit("watch-sync", { serverId: activeServerId, action: "play", currentTime: cur });
                        } else if (ev.data === window.YT.PlayerState.PAUSED) {
                            socket.emit("watch-sync", { serverId: activeServerId, action: "pause", currentTime: cur });
                        }
                    }
                }
            });
            return;
        }

        // Mevcut oynatıcıda zaman ve durum eşitle
        try {
            suppressYtEventsUntil = Date.now() + 1200;
            const cur = typeof ytPlayer.getCurrentTime === "function" ? ytPlayer.getCurrentTime() : 0;
            if (Math.abs(cur - targetTime) > 1.6) {
                ytPlayer.seekTo(targetTime, true);
            }
            if (watchState.playing) ytPlayer.playVideo();
            else ytPlayer.pauseVideo();
        } catch { }
    }

    // 4. SOUNDBOARD PANELİ
    function initSoundboardGrid() {
        const grid = $("soundboard-grid");
        grid.innerHTML = "";
        SOUNDBOARD_ITEMS.forEach((item) => {
            const btn = document.createElement("button");
            btn.className = "sb-pad";
            btn.innerHTML = `<span>${item.icon}</span><span>${escapeHTML(item.label)}</span>`;
            btn.onclick = () => {
                if (!voiceChannelId) {
                    playSoundboardSynth(item.id);
                    showToast("Ses kanalında değilsin (yalnızca sana çalındı).", "info", 2000);
                    return;
                }
                socket.emit("soundboard-play", { soundId: item.id });
            };
            grid.appendChild(btn);
        });
    }

    // 5. ORTAK TAKTİK ÇİZİM TAHTASI
    function resizeBoardCanvas() {
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

    function redrawBoard(previewStroke = null) {
        const canvas = $("tactic-canvas");
        if (!canvas) return;
        const ctx = canvas.getContext("2d");
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        (boardState.strokes || []).forEach((st) => drawSingleStroke(ctx, canvas.width, canvas.height, st));
        if (previewStroke) drawSingleStroke(ctx, canvas.width, canvas.height, previewStroke);
    }

    function applyBoardState(b) {
        boardState = b || { active: false, strokes: [] };
        const stage = $("board-stage");
        stage.style.display = boardState.active ? "flex" : "none";
        if (boardState.active) {
            requestAnimationFrame(resizeBoardCanvas);
        }
    }

    function initTacticBoardEvents() {
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
            boardDrawing = true;
            currentStrokePoints = [getNormPt(e)];
        });

        canvas.addEventListener("pointermove", (e) => {
            if (!boardDrawing) return;
            const pt = getNormPt(e);
            if (boardTool === "line" || boardTool === "arrow") {
                currentStrokePoints = [currentStrokePoints[0], pt];
            } else {
                const last = currentStrokePoints[currentStrokePoints.length - 1];
                if (!last || Math.hypot(pt[0] - last[0], pt[1] - last[1]) > 0.004) {
                    currentStrokePoints.push(pt);
                }
            }
            redrawBoard({
                tool: boardTool,
                color: $("board-color").value,
                width: parseInt($("board-width").value, 10) || 3,
                points: currentStrokePoints
            });
        });

        const finishStroke = () => {
            if (!boardDrawing) return;
            boardDrawing = false;
            if (currentStrokePoints.length >= 2) {
                const stroke = {
                    tool: boardTool,
                    color: $("board-color").value,
                    width: parseInt($("board-width").value, 10) || 3,
                    points: currentStrokePoints.slice(0, 300)
                };
                boardState.strokes.push(stroke);
                redrawBoard();
                socket.emit("board-stroke", { serverId: activeServerId, stroke });
            }
            currentStrokePoints = [];
        };

        canvas.addEventListener("pointerup", finishStroke);
        canvas.addEventListener("pointercancel", finishStroke);
        window.addEventListener("resize", () => {
            if (boardState.active) resizeBoardCanvas();
        });
    }

    // 6. 1-1 FISILTI (DM)
    function openDmModal() {
        dmUnread = false;
        renderServerRail();
        openModal("dm-modal");
        socket.emit("dm-list", (convs) => {
            dmConversations = convs || [];
            renderDmConversations();
        });
    }

    function openDmWith(username) {
        if (!username || (me && username === me.username)) return;
        openDmModal();
        loadDmHistory(username);
    }

    function renderDmConversations() {
        const ul = $("dm-conv-list");
        ul.innerHTML = "";
        if (!dmConversations.length) {
            ul.innerHTML = '<li class="muted-note" style="padding:8px;">Henüz özel mesaj yok. Üye listesinden birine tıklayarak başlat.</li>';
            return;
        }
        dmConversations.forEach((c) => {
            const li = document.createElement("li");
            li.className = "dm-conv-item" + (activeDmPeer?.username === c.username ? " active" : "");

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

    function loadDmHistory(username) {
        socket.emit("dm-history", { withUsername: username }, (res) => {
            if (!res?.ok) return;
            activeDmPeer = res.peer;
            $("dm-peer-hdr").textContent = `💬 ${res.peer.displayName} (@${res.peer.username})`;
            $("dm-input").disabled = false;
            $("dm-send-btn").disabled = false;
            renderDmMessages(res.messages || []);
            renderDmConversations();
            $("dm-input").focus();
        });
    }

    function renderDmMessages(list) {
        const box = $("dm-messages");
        box.innerHTML = "";
        if (!list.length) {
            box.innerHTML = '<div class="muted-note center" style="margin-top:24px;">İlk özel mesajı gönder.</div>';
            return;
        }
        list.forEach((m) => appendDmBubble(m));
        box.scrollTop = box.scrollHeight;
    }

    function appendDmBubble(m) {
        const box = $("dm-messages");
        const emptyNote = box.querySelector(".muted-note.center");
        if (emptyNote) emptyNote.remove();

        const isMine = me && m.from === me.username;
        const div = document.createElement("div");
        div.className = "dm-bubble" + (isMine ? " mine" : "");
        div.innerHTML = `
            <div>${formatMessageBody(m.text || "")}</div>
            <div class="dm-bubble-meta">${escapeHTML(m.fromDisplayName || m.from)} • ${escapeHTML(m.time || "")}</div>
        `;
        box.appendChild(div);
        box.scrollTop = box.scrollHeight;
    }

    // =========================================================================
    // UI EVENT BAĞLANTILARI
    // =========================================================================
    function activateSettingsTab(tabId) {
        document.querySelectorAll("#settings-modal .tab-btn").forEach((b) => {
            b.classList.toggle("active", b.dataset.tab === tabId);
        });
        document.querySelectorAll("#settings-modal .tab-pane").forEach((p) => {
            p.classList.toggle("active", p.id === tabId);
        });
        if (tabId === "tab-server") populateServerSettingsForm();
    }

    function bindAllUIEvents() {
        // Modal kapatma butonları ve backdrop
        document.querySelectorAll("[data-close]").forEach((btn) => {
            btn.onclick = () => closeModal(btn.getAttribute("data-close"));
        });
        $("lightbox").onclick = () => $("lightbox").classList.remove("show");
        $("drawer-backdrop").onclick = closeDrawers;
        $("btn-mobile-left").onclick = () => toggleDrawer("left");
        $("btn-mobile-right").onclick = () => toggleDrawer("right");
        $("btn-mobile-right-close").onclick = closeDrawers;

        // Ayarlar sekmeleri
        document.querySelectorAll("#settings-modal .tab-btn").forEach((btn) => {
            btn.onclick = () => activateSettingsTab(btn.dataset.tab);
        });

        // Sunucu Ekle modal sekmeleri
        document.querySelectorAll("#server-add-modal .tab-btn").forEach((btn) => {
            btn.onclick = () => {
                const target = btn.dataset.mtab;
                document.querySelectorAll("#server-add-modal .tab-btn").forEach((b) => b.classList.toggle("active", b === btn));
                document.querySelectorAll("#server-add-modal .tab-pane").forEach((p) => p.classList.toggle("active", p.id === target));
            };
        });

        // Giriş & Kayıt
        const doLogin = () => {
            const username = $("auth-user").value.trim();
            const password = $("auth-pass").value;
            const remember = $("auth-remember").checked;
            $("auth-err").textContent = "";
            socket.emit("login", { username, password, remember }, (res) => {
                if (!res?.ok) $("auth-err").textContent = res?.error || "Giriş başarısız.";
                else handleLoginSuccess(res);
            });
        };

        $("btn-login").onclick = doLogin;
        $("auth-pass").addEventListener("keydown", (e) => {
            if (e.key === "Enter") doLogin();
        });

        $("btn-register").onclick = () => {
            const username = $("auth-user").value.trim();
            const password = $("auth-pass").value;
            const inviteCode = $("auth-invite").value.trim();
            $("auth-err").textContent = "";
            socket.emit("register", { username, password, inviteCode }, (res) => {
                if (!res?.ok) {
                    if (res?.error?.toLowerCase().includes("davet")) {
                        $("auth-invite").style.display = "block";
                    }
                    $("auth-err").textContent = res?.error || "Kayıt başarısız.";
                } else {
                    showToast("Hesap oluşturuldu, giriş yapılıyor...", "ok");
                    doLogin();
                }
            });
        };

        $("btn-logout").onclick = () => {
            if (!confirm("Hesaptan çıkış yapmak istiyor musun?")) return;
            const tok = localStorage.getItem("bd_token");
            socket.emit("logout", tok);
            localStorage.removeItem("bd_token");
            leaveVoiceCleanup(true);
            location.reload();
        };

        // Sunucu Şeridi & Başlık Butonları
        $("btn-dm-rail").onclick = openDmModal;
        $("btn-add-server").onclick = () => {
            $("join-server-code").value = "";
            $("join-server-err").textContent = "";
            $("create-server-name").value = "";
            $("create-server-err").textContent = "";
            openModal("server-add-modal");
        };

        $("btn-server-menu").onclick = (e) => {
            e.stopPropagation();
            const rect = e.currentTarget.getBoundingClientRect();
            const cur = myServers.find((s) => s.id === activeServerId);
            if (cur) showServerContextMenu(rect.left, rect.bottom + 6, cur);
        };

        $("btn-confirm-join-server").onclick = () => {
            const code = $("join-server-code").value.trim();
            $("join-server-err").textContent = "";
            socket.emit("server-join", { inviteCode: code }, (res) => {
                if (!res?.ok) {
                    $("join-server-err").textContent = res?.error || "Katılınamadı.";
                    return;
                }
                myServers = res.servers || [];
                closeModal("server-add-modal");
                applyServerSnapshot(res.snapshot);
                showToast(`"${res.snapshot.settings.name}" sunucusuna katıldın!`, "ok");
            });
        };

        $("btn-confirm-create-server").onclick = () => {
            const name = $("create-server-name").value.trim();
            $("create-server-err").textContent = "";
            socket.emit("server-create", { name }, (res) => {
                if (!res?.ok) {
                    $("create-server-err").textContent = res?.error || "Oluşturulamadı.";
                    return;
                }
                myServers = res.servers || [];
                closeModal("server-add-modal");
                applyServerSnapshot(res.snapshot);
                showToast(`"${name}" oluşturuldu! Davet kodu: ${res.snapshot.settings.inviteCode}`, "ok", 4500);
            });
        };

        // Hızlı Kanal Oluştur / Düzenle
        $("btn-quick-add-text").onclick = () => openChannelModal(null, "text");
        $("btn-quick-add-voice").onclick = () => openChannelModal(null, "voice");
        $("ch-modal-type").onchange = () => {
            $("ch-modal-afk-wrap").style.display = $("ch-modal-type").value === "voice" ? "inline-flex" : "none";
        };

        $("btn-save-channel").onclick = () => {
            const chId = $("ch-modal-id").value;
            const name = $("ch-modal-name").value.trim();
            const type = $("ch-modal-type").value;
            const topic = $("ch-modal-topic").value.trim();
            const isAfk = $("ch-modal-afk").checked;
            $("ch-modal-err").textContent = "";

            if (!name) {
                $("ch-modal-err").textContent = "Kanal adı boş olamaz.";
                return;
            }

            if (chId) {
                socket.emit("channel-update", { serverId: activeServerId, channelId: chId, name, topic, isAfk }, (res) => {
                    if (!res?.ok) $("ch-modal-err").textContent = res?.error || "Güncellenemedi.";
                    else {
                        closeModal("channel-modal");
                        showToast("Kanal güncellendi.", "ok");
                    }
                });
            } else {
                socket.emit("channel-create", { serverId: activeServerId, name, type, topic, isAfk }, (res) => {
                    if (!res?.ok) $("ch-modal-err").textContent = res?.error || "Oluşturulamadı.";
                    else {
                        closeModal("channel-modal");
                        showToast(`"${name}" kanalı oluşturuldu.`, "ok");
                    }
                });
            }
        };

        // Üye Rollerini Kaydet
        $("btn-save-member-roles").onclick = () => {
            if (!editingMemberUsername) return;
            const checkedIds = Array.from(document.querySelectorAll("#mr-roles-list input[type='checkbox']:checked")).map((c) => c.value);
            $("mr-err").textContent = "";
            socket.emit("member-set-roles", {
                serverId: activeServerId,
                targetUsername: editingMemberUsername,
                roleIds: checkedIds
            }, (res) => {
                if (!res?.ok) $("mr-err").textContent = res?.error || "Roller güncellenemedi.";
                else {
                    closeModal("member-roles-modal");
                    showToast("Üye rolleri güncellendi.", "ok");
                }
            });
        };

        // Sunucu Ayarları & Rol Editörü
        $("btn-copy-invite").onclick = () => {
            const code = $("adm-invite-code").value.trim();
            if (code) copyText(code, `Davet kodu kopyalandı: ${code}`);
        };

        $("btn-regen-invite").onclick = () => {
            socket.emit("server-update-settings", { serverId: activeServerId, regenerateInvite: true }, (res) => {
                if (!res?.ok) return showToast(res?.error || "Yenilenemedi.", "err");
                $("adm-invite-code").value = res.inviteCode;
                showToast(`Yeni davet kodu: ${res.inviteCode}`, "ok");
            });
        };

        $("btn-save-server-settings").onclick = () => {
            socket.emit("server-update-settings", {
                serverId: activeServerId,
                name: $("adm-server-name").value.trim(),
                inviteCode: $("adm-invite-code").value.trim(),
                afkChannelId: $("adm-afk-channel").value || "",
                afkTimeoutSec: parseInt($("adm-afk-timeout").value, 10) || 0,
                turnUrl: $("adm-turn-url").value.trim(),
                turnUser: $("adm-turn-user").value.trim(),
                turnPass: $("adm-turn-pass").value.trim()
            }, (res) => {
                if (!res?.ok) showToast(res?.error || "Kaydedilemedi.", "err");
                else showToast("Sunucu ayarları kaydedildi.", "ok");
            });
        };

        $("btn-leave-server").onclick = () => {
            closeModal("settings-modal");
            confirmLeaveServer(activeServerId, serverSettings?.name || "Sunucu");
        };

        $("btn-delete-server").onclick = () => {
            if (!confirm(`"${serverSettings?.name}" sunucusunu kalıcı olarak silmek istediğine emin misin?`)) return;
            socket.emit("server-delete", { serverId: activeServerId }, (res) => {
                if (!res?.ok) return showToast(res?.error || "Silinemedi.", "err");
                myServers = res.servers || [];
                closeModal("settings-modal");
                showToast("Sunucu silindi.", "info");
                if (res.snapshot) applyServerSnapshot(res.snapshot);
            });
        };

        $("btn-new-role").onclick = () => {
            $("edit-role-id").value = "";
            fillRoleEditor(null);
            document.querySelectorAll("#roles-list .role-list-item").forEach((el) => el.classList.remove("active"));
            $("edit-role-name").focus();
        };

        $("btn-save-role").onclick = () => {
            const roleId = $("edit-role-id").value;
            const name = $("edit-role-name").value.trim();
            const color = $("edit-role-color").value;
            const priority = parseInt($("edit-role-priority").value, 10) || 10;
            const permissions = {};
            document.querySelectorAll(".role-perm-chk").forEach((chk) => {
                permissions[chk.getAttribute("data-perm")] = chk.checked;
            });
            $("role-editor-err").textContent = "";

            const evt = roleId ? "role-update" : "role-create";
            socket.emit(evt, { serverId: activeServerId, roleId, name, color, priority, permissions }, (res) => {
                if (!res?.ok) {
                    $("role-editor-err").textContent = res?.error || "Kaydedilemedi.";
                    return;
                }
                if (res.role?.id) $("edit-role-id").value = res.role.id;
                showToast(roleId ? "Rol güncellendi." : `"${name}" rolü oluşturuldu.`, "ok");
            });
        };

        $("btn-delete-role").onclick = () => {
            const roleId = $("edit-role-id").value;
            if (!roleId || !confirm("Bu rolü silmek istediğine emin misin?")) return;
            socket.emit("role-delete", { serverId: activeServerId, roleId }, (res) => {
                if (!res?.ok) $("role-editor-err").textContent = res?.error || "Silinemedi.";
                else {
                    $("edit-role-id").value = "";
                    showToast("Rol silindi.", "info");
                }
            });
        };

        // Topbar & Araçlar Popover
        $("btn-tools-menu").onclick = (e) => {
            e.stopPropagation();
            $("tools-popover").classList.toggle("show");
        };

        document.querySelectorAll("#tools-popover .pop-item").forEach((btn) => {
            btn.onclick = () => {
                const tool = btn.dataset.tool;
                closeToolsPopover();
                if (tool === "ready-check") {
                    const title = prompt("Hazır kontrolü başlığı:", "Maça hazır mısınız?");
                    if (title === null) return;
                    socket.emit("ready-check-start", { serverId: activeServerId, title });
                } else if (tool === "poll") {
                    $("poll-err").textContent = "";
                    renderPollsList();
                    openModal("poll-modal");
                } else if (tool === "watch") {
                    $("watch-err").textContent = "";
                    openModal("watch-modal");
                    setTimeout(() => $("watch-url-input").focus(), 40);
                } else if (tool === "soundboard") {
                    openModal("soundboard-modal");
                } else if (tool === "board") {
                    socket.emit("board-toggle", { serverId: activeServerId, active: !boardState.active });
                } else if (tool === "dm") {
                    openDmModal();
                }
            };
        });

        $("btn-game-mode").onclick = () => {
            gameMode = !gameMode;
            localStorage.setItem("bd_gamemode", gameMode ? "1" : "0");
            updateGameModeUI();
        };

        $("health-pill").onclick = () => openModal("health-modal");
        $("btn-open-health-top").onclick = () => openModal("health-modal");
        $("btn-open-settings").onclick = () => openModal("settings-modal");
        $("btn-profile-quick").onclick = () => {
            openModal("settings-modal");
            activateSettingsTab("tab-overlay");
        };

        $("btn-pins").onclick = () => {
            const list = (messagesByChannel[activeChannelId] || []).filter((m) => m.pinned);
            const container = $("pins-list");
            container.innerHTML = "";
            if (!list.length) {
                container.innerHTML = '<div class="muted-note center">Bu kanalda sabitlenmiş mesaj yok.</div>';
            } else {
                list.forEach((m) => container.appendChild(createMessageElement(m)));
            }
            openModal("pins-modal");
        };

        $("search-input").oninput = renderMessages;

        // Hazır Kontrolü aksiyonları
        document.querySelectorAll("[data-rc-status]").forEach((btn) => {
            btn.onclick = () => {
                if (!activeReadyCheck) return;
                socket.emit("ready-check-respond", {
                    serverId: activeServerId,
                    checkId: activeReadyCheck.id,
                    status: btn.dataset.rcStatus
                });
            };
        });
        $("btn-rc-close").onclick = () => socket.emit("ready-check-close", { serverId: activeServerId });

        // Hızlı Anket oluşturma
        $("btn-create-poll").onclick = () => {
            const question = $("poll-question").value.trim();
            const options = Array.from(document.querySelectorAll(".poll-opt-inp")).map((i) => i.value.trim()).filter(Boolean);
            $("poll-err").textContent = "";
            socket.emit("poll-create", { serverId: activeServerId, question, options }, (res) => {
                if (!res?.ok) {
                    $("poll-err").textContent = res?.error || "Anket oluşturulamadı.";
                    return;
                }
                $("poll-question").value = "";
                document.querySelectorAll(".poll-opt-inp").forEach((i) => { i.value = ""; });
                showToast("Anket yayınlandı!", "ok");
            });
        };

        // Ortak İzleme (YouTube)
        $("btn-start-watch").onclick = () => {
            const url = $("watch-url-input").value.trim();
            const title = $("watch-title-input").value.trim();
            $("watch-err").textContent = "";
            socket.emit("watch-start", { serverId: activeServerId, url, title }, (res) => {
                if (!res?.ok) {
                    $("watch-err").textContent = res?.error || "Video başlatılamadı.";
                    return;
                }
                $("watch-url-input").value = "";
                $("watch-title-input").value = "";
                closeModal("watch-modal");
            });
        };

        $("btn-watch-play").onclick = () => {
            const cur = ytPlayer && typeof ytPlayer.getCurrentTime === "function" ? ytPlayer.getCurrentTime() : (watchState.currentTime || 0);
            socket.emit("watch-sync", { serverId: activeServerId, action: "play", currentTime: cur });
        };
        $("btn-watch-pause").onclick = () => {
            const cur = ytPlayer && typeof ytPlayer.getCurrentTime === "function" ? ytPlayer.getCurrentTime() : (watchState.currentTime || 0);
            socket.emit("watch-sync", { serverId: activeServerId, action: "pause", currentTime: cur });
        };
        $("btn-watch-resync").onclick = () => applyWatchState(watchState);
        $("btn-watch-change").onclick = () => openModal("watch-modal");
        $("btn-watch-stop").onclick = () => socket.emit("watch-stop", { serverId: activeServerId });

        // Soundboard ses düzeyi
        $("sb-vol-slider").oninput = () => {
            soundboardVolume = parseInt($("sb-vol-slider").value, 10);
            $("sb-vol-val").textContent = `${soundboardVolume}%`;
            localStorage.setItem("bd_sb_vol", String(soundboardVolume));
        };

        // Taktik Çizim Tahtası araçları
        document.querySelectorAll("[data-btool]").forEach((btn) => {
            btn.onclick = () => {
                boardTool = btn.dataset.btool;
                document.querySelectorAll("[data-btool]").forEach((b) => b.classList.toggle("active", b === btn));
            };
        });
        $("btn-board-undo").onclick = () => socket.emit("board-undo", { serverId: activeServerId });
        $("btn-board-clear").onclick = () => socket.emit("board-clear", { serverId: activeServerId });
        $("btn-board-close").onclick = () => socket.emit("board-toggle", { serverId: activeServerId, active: false });

        // 1-1 Fısıltı gönderme
        $("dm-form").onsubmit = (e) => {
            e.preventDefault();
            if (!activeDmPeer) return;
            const text = $("dm-input").value.trim();
            if (!text) return;
            $("dm-input").value = "";
            socket.emit("dm-send", { toUsername: activeDmPeer.username, text }, (res) => {
                if (!res?.ok) showToast(res?.error || "Gönderilemedi.", "err");
            });
        };

        // Sohbet formu & resim yapıştırma
        $("btn-cancel-reply").onclick = clearReply;
        $("btn-img").onclick = () => $("img-input").click();
        $("img-input").onchange = (e) => {
            const file = e.target.files?.[0];
            if (file) sendChatImage(file);
            e.target.value = "";
        };

        $("chat-input").addEventListener("paste", (e) => {
            const item = Array.from(e.clipboardData?.items || []).find((i) => i.type.startsWith("image/"));
            if (item) {
                e.preventDefault();
                const file = item.getAsFile();
                if (file) sendChatImage(file);
            }
        });

        $("chat-input").addEventListener("input", () => {
            if (!activeServerId || !activeChannelId) return;
            if (!isCurrentlyTyping) {
                isCurrentlyTyping = true;
                socket.emit("typing", { serverId: activeServerId, channelId: activeChannelId, isTyping: true });
            }
            clearTimeout(typingTimeout);
            typingTimeout = setTimeout(() => {
                isCurrentlyTyping = false;
                socket.emit("typing", { serverId: activeServerId, channelId: activeChannelId, isTyping: false });
            }, 1800);
        });

        $("chat-form").onsubmit = (e) => {
            e.preventDefault();
            const text = $("chat-input").value.trim();
            if (!text || !activeServerId || !activeChannelId) return;
            socket.emit("chat-message", {
                serverId: activeServerId,
                channelId: activeChannelId,
                text,
                replyTo: replyTarget
            });
            $("chat-input").value = "";
            clearReply();
            if (isCurrentlyTyping) {
                isCurrentlyTyping = false;
                socket.emit("typing", { serverId: activeServerId, channelId: activeChannelId, isTyping: false });
            }
        };

        // Ses & Sahne kontrolleri
        $("btn-mute").onclick = toggleMute;
        $("m-btn-mute").onclick = toggleMute;
        $("btn-deafen").onclick = toggleDeafen;
        $("m-btn-deafen").onclick = toggleDeafen;
        $("btn-cam").onclick = toggleCamera;
        $("m-btn-cam").onclick = toggleCamera;
        $("btn-flip-cam").onclick = flipCamera;
        $("m-btn-flip").onclick = flipCamera;
        $("btn-screen").onclick = openScreenShareFlow;
        $("btn-start-share").onclick = startScreenCapture;
        $("btn-leave-voice").onclick = () => leaveVoiceCleanup(true);
        $("m-btn-leave").onclick = () => leaveVoiceCleanup(true);
        $("btn-exit-spotlight").onclick = () => {
            spotlightTileId = null;
            updateStageLayout();
        };
        $("btn-expand-stage").onclick = () => {
            const expanded = $("media-stage").classList.toggle("expanded");
            $("btn-expand-stage").textContent = expanded ? "Küçült" : "Genişlet";
        };

        // Ses DSP & Cihaz Kontrolleri
        $("mic-select").onchange = () => { if (voiceChannelId) buildMicPipeline().catch(() => { }); };
        $("spk-select").onchange = applyOutputDevice;
        $("cam-select").onchange = () => { if (camStream) restartCameraTrack(); };
        $("cam-quality").onchange = () => { if (camStream) restartCameraTrack(); };
        $("chk-ns").onchange = () => { if (voiceChannelId) buildMicPipeline().catch(() => { }); };
        $("chk-aec").onchange = () => { if (voiceChannelId) buildMicPipeline().catch(() => { }); };
        $("chk-agc").onchange = () => { if (voiceChannelId) buildMicPipeline().catch(() => { }); };
        $("chk-hpf").onchange = applyLiveDspToggles;
        $("chk-comp").onchange = applyLiveDspToggles;

        $("gate-slider").oninput = () => {
            gateThreshold = parseInt($("gate-slider").value, 10);
            localStorage.setItem("bd_gate", String(gateThreshold));
            updateGateMarkerUI();
        };

        $("mic-gain").oninput = () => {
            const v = parseFloat($("mic-gain").value);
            $("mic-gain-val").textContent = `${Math.round(v * 100)}%`;
            if (micGainNode) micGainNode.gain.value = v;
        };

        $("chk-mirror").onchange = () => {
            mirrorCam = $("chk-mirror").checked;
            localStorage.setItem("bd_mirror", mirrorCam ? "1" : "0");
            const v = document.querySelector("#tile-cam-local video");
            if (v) v.classList.toggle("mirrored", mirrorCam);
        };

        $("chk-ptt").onchange = () => {
            pttEnabled = $("chk-ptt").checked;
            localStorage.setItem("bd_ptt", pttEnabled ? "1" : "0");
            pttPressed = false;
            applyMuteState();
        };

        $("btn-ptt-key").onclick = () => {
            awaitingPttKey = true;
            $("btn-ptt-key").textContent = "Tuşa bas...";
        };

        // Tema, Overlay & GPU Ayarları
        $("theme-select").onchange = () => {
            const t = $("theme-select").value;
            localStorage.setItem("bd_theme", t);
            document.body.setAttribute("data-theme", t);
        };
        $("accent-picker").oninput = () => {
            const c = $("accent-picker").value;
            localStorage.setItem("bd_accent", c);
            document.documentElement.style.setProperty("--accent", c);
        };
        $("font-size-select").onchange = () => {
            const sz = $("font-size-select").value;
            localStorage.setItem("bd_fontsize", sz);
            document.documentElement.style.setProperty("--font-size", sz);
        };
        $("chk-afk-exempt").onchange = () => {
            afkExempt = $("chk-afk-exempt").checked;
            localStorage.setItem("bd_afk_exempt", afkExempt ? "1" : "0");
            socket.emit("update-profile", { afkExempt });
        };

        if (isElectron) {
            $("chk-overlay-enabled").onchange = () => updateOverlaySettings({ enabled: $("chk-overlay-enabled").checked });
            $("overlay-pos-select").onchange = () => updateOverlaySettings({ position: $("overlay-pos-select").value });
            $("overlay-size-select").onchange = () => updateOverlaySettings({ size: $("overlay-size-select").value });
            $("btn-overlay-restart").onclick = () => window.electronAPI.relaunchApp();
            $("chk-disable-gpu").onchange = () => {
                if (confirm("GPU donanım hızlandırma ayarı için uygulama yeniden başlatılacak. Devam edilsin mi?")) {
                    window.electronAPI.setGpuMode($("chk-disable-gpu").checked);
                } else {
                    $("chk-disable-gpu").checked = !$("chk-disable-gpu").checked;
                }
            };
        }

        // Profil fotoğrafı & Profil kaydet
        $("btn-pick-avatar").onclick = () => $("prof-avatar-file").click();
        $("prof-avatar-file").onchange = async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            try {
                const dataUrl = await compressImageFile(file, 160, 0.85);
                pendingProfileAvatar = dataUrl;
                renderAvatarContent($("prof-avatar-preview"), {
                    avatar: dataUrl,
                    displayName: $("prof-display-name").value,
                    username: me?.username,
                    color: $("prof-color").value
                });
            } catch {
                showToast("Avatar yüklenemedi.", "err");
            }
            e.target.value = "";
        };

        $("btn-clear-avatar").onclick = () => {
            pendingProfileAvatar = "";
            renderAvatarContent($("prof-avatar-preview"), {
                avatar: "",
                displayName: $("prof-display-name").value,
                username: me?.username,
                color: $("prof-color").value
            });
        };

        $("btn-save-profile").onclick = () => {
            const payload = {
                displayName: $("prof-display-name").value.trim(),
                color: $("prof-color").value,
                status: $("prof-status").value.trim(),
                afkExempt
            };
            if (pendingProfileAvatar !== undefined) payload.avatar = pendingProfileAvatar;

            socket.emit("update-profile", payload, (res) => {
                if (!res?.ok) return showToast("Profil kaydedilemedi.", "err");
                me = { ...me, ...res.me };
                applyMeUI();
                showToast("Profil güncellendi.", "ok");
                pushOverlayState(true);
            });
        };

        // Yerel PC DB & JSON İndir / Yükle
        $("btn-restore-pc-db").onclick = async () => {
            if (!isElectron) return showToast("Bu özellik masaüstü (Electron) sürümünde çalışır.", "info");
            const data = await window.electronAPI.dbLoad();
            if (!data) return showToast("Bilgisayarda kayıtlı DB dosyası bulunamadı.", "err");
            socket.emit("restore-db", data, (res) => {
                if (res?.ok) {
                    showToast(
                        res.migratedFromV4
                            ? "v4.0 PC veritabanı v5.0'a dönüştürülerek yüklendi!"
                            : "PC veritabanı sunucuya yüklendi!",
                        "ok"
                    );
                } else {
                    showToast(res?.error || "Yüklenemedi.", "err");
                }
            });
        };

        $("btn-export-db").onclick = () => {
            if (!latestServerDB) return showToast("Yedek verisi henüz hazır değil.", "err");
            const blob = new Blob([JSON.stringify(latestServerDB, null, 2)], { type: "application/json" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = `bizim_discord_v5_db_${new Date().toISOString().slice(0, 10)}.json`;
            a.click();
            URL.revokeObjectURL(url);
        };

        $("btn-import-db").onclick = () => $("db-file-input").click();
        $("db-file-input").onchange = (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = () => {
                try {
                    const parsed = JSON.parse(reader.result);
                    socket.emit("restore-db", parsed, (res) => {
                        if (res?.ok) {
                            showToast(
                                res.migratedFromV4
                                    ? "v4.0 JSON yedeği v5.0 formatına dönüştürülerek geri yüklendi!"
                                    : "JSON veritabanı geri yüklendi!",
                                "ok"
                            );
                        } else {
                            showToast(res?.error || "Geçersiz yedek dosyası.", "err");
                        }
                    });
                } catch {
                    showToast("JSON dosyası okunamadı.", "err");
                }
            };
            reader.readAsText(file);
            e.target.value = "";
        };

        // Klavye & PTT & Arka Plan Optimizasyonu
        window.addEventListener("keydown", (e) => {
            if (awaitingPttKey) {
                e.preventDefault();
                awaitingPttKey = false;
                pttKey = e.code;
                localStorage.setItem("bd_ptt_key", pttKey);
                $("btn-ptt-key").textContent = pttKey;
                applyMuteState();
                return;
            }
            if (e.key === "Escape") {
                closeContextMenu();
                closeToolsPopover();
                document.querySelectorAll(".overlay.show").forEach((ov) => {
                    if (ov.id !== "auth-overlay") closeModal(ov.id);
                });
                return;
            }
            if (pttEnabled && voiceChannelId && e.code === pttKey && !pttPressed) {
                const tag = document.activeElement?.tagName;
                if (tag === "INPUT" || tag === "TEXTAREA") return;
                pttPressed = true;
                applyMuteState();
            }
        });

        window.addEventListener("keyup", (e) => {
            if (pttEnabled && e.code === pttKey && pttPressed) {
                pttPressed = false;
                applyMuteState();
            }
        });

        window.addEventListener("blur", () => {
            if (pttPressed) {
                pttPressed = false;
                applyMuteState();
            }
        });

        document.addEventListener("visibilitychange", () => {
            const videos = document.querySelectorAll("#stage-tiles video");
            if (document.hidden) {
                videos.forEach((v) => v.pause());
                clearAllSpeakingVisuals();
            } else {
                videos.forEach((v) => v.play().catch(() => { }));
            }
        });
    }

    // =========================================================================
    // SOCKET.IO DİNLEYİCİLERİ
    // =========================================================================
    socket.on("connect", () => {
        bootSequence();
    });

    socket.on("server-info", (info) => {
        if (!info) return;
        $("auth-title").textContent = info.serverName || "BizimDiscord";
        $("auth-invite").style.display = info.hasInviteCode && !info.isFirstSetup ? "block" : "none";
        $("auth-hint").textContent = info.isFirstSetup
            ? "İlk kayıt olan hesap otomatik Genel Yönetici olur."
            : "Hesabınla giriş yap veya yeni hesap oluştur.";
    });

    socket.on("db-sync", (fullDB) => {
        latestServerDB = fullDB;
        if (isElectron && me?.isGlobalAdmin) {
            window.electronAPI.dbSave(fullDB).catch(() => { });
        }
    });

    socket.on("my-servers-update", (list) => {
        myServers = Array.isArray(list) ? list : [];
        renderServerRail();
    });

    socket.on("server-state-update", (state) => {
        if (!state) return;

        // Ses bağlı olduğumuz sunucunun güncel üye verilerini overlay için daima taze tut
        if (state.serverId === voiceServerId) {
            if (state.settings?.iceServers) voiceIceServers = state.settings.iceServers;
            refreshVoiceMembersCacheFrom(state.members || []);
            updateVoicePanelUI();
        }

        if (state.serverId !== activeServerId) return;

        serverSettings = state.settings;
        channels = state.channels || [];
        roles = state.roles || [];
        members = state.members || [];
        myPermissions = state.myPermissions || {};
        myPower = state.myPower || 0;
        isServerOwner = Boolean(state.isOwner);

        if (!channels.some((c) => c.id === activeChannelId && c.type === "text")) {
            const firstText = channels.find((c) => c.type === "text");
            activeChannelId = firstText ? firstText.id : null;
            renderMessages();
        }

        $("server-name-lbl").textContent = serverSettings?.name || "BizimDiscord";
        updateServerPermissionsUI();
        renderChannels();
        renderMembers();
        renderActiveChannelHeader();

        if ($("settings-modal").classList.contains("show") && $("tab-server").classList.contains("active")) {
            populateServerSettingsForm();
        }
    });

    socket.on("server-removed", ({ serverId }) => {
        myServers = myServers.filter((s) => s.id !== serverId);
        renderServerRail();
        if (activeServerId === serverId && myServers.length) {
            selectServer(myServers[0].id);
        }
    });

    socket.on("server-kicked", ({ serverId, serverName, by }) => {
        showToast(`${by} tarafından "${serverName}" sunucusundan atıldınız.`, "err", 5000);
        myServers = myServers.filter((s) => s.id !== serverId);
        renderServerRail();
        if (activeServerId === serverId && myServers.length) {
            selectServer(myServers[0].id);
        }
    });

    socket.on("kicked", (reason) => {
        leaveVoiceCleanup(false);
        alert(reason || "Bağlantınız sonlandırıldı.");
        location.reload();
    });

    // Sohbet Olayları
    socket.on("chat-message", (msg) => {
        if (!msg || msg.serverId !== activeServerId) return;
        if (!messagesByChannel[msg.channelId]) messagesByChannel[msg.channelId] = [];
        messagesByChannel[msg.channelId].push(msg);

        if (msg.channelId === activeChannelId) {
            const box = $("messages");
            const empty = box.querySelector(".sys-msg");
            if (empty) empty.remove();
            box.appendChild(createMessageElement(msg));
            box.scrollTop = box.scrollHeight;
        } else {
            unreadChannels.add(`${msg.serverId}:${msg.channelId}`);
            renderChannels();
        }

        if (me && msg.sender !== me.username) {
            const mentioned = msg.text && new RegExp(`@${me.username}\\b`, "i").test(msg.text);
            if (mentioned) playTone(880, 0.11, "triangle", 0.08);
        }
    });

    socket.on("message-updated", (msg) => {
        if (!msg || msg.serverId !== activeServerId) return;
        const arr = messagesByChannel[msg.channelId];
        if (!arr) return;
        const idx = arr.findIndex((m) => m.id === msg.id);
        if (idx !== -1) arr[idx] = msg;
        if (msg.channelId === activeChannelId) renderMessages();
    });

    socket.on("message-deleted", ({ serverId, channelId, msgId }) => {
        if (serverId !== activeServerId || !messagesByChannel[channelId]) return;
        messagesByChannel[channelId] = messagesByChannel[channelId].filter((m) => m.id !== msgId);
        if (channelId === activeChannelId) renderMessages();
    });

    socket.on("user-typing", ({ serverId, channelId, username, displayName, isTyping }) => {
        if (serverId !== activeServerId) return;
        if (!typingUsers.has(channelId)) typingUsers.set(channelId, new Map());
        const map = typingUsers.get(channelId);
        if (isTyping) map.set(username, displayName || username);
        else map.delete(username);

        if (channelId === activeChannelId) {
            const names = Array.from(map.values());
            $("typing-bar").textContent = names.length ? `${names.join(", ")} yazıyor...` : "";
        }
    });

    // 1-1 Fısıltı
    socket.on("dm-message", (msg) => {
        if (!msg || !me) return;
        const other = msg.from === me.username ? msg.to : msg.from;
        const dmOpen = $("dm-modal").classList.contains("show");

        if (dmOpen && activeDmPeer?.username === other) {
            appendDmBubble(msg);
        } else if (msg.from !== me.username) {
            dmUnread = true;
            renderServerRail();
            playTone(760, 0.09, "sine", 0.07);
            showToast(`💬 ${msg.fromDisplayName || msg.from}: ${(msg.text || "[Görsel]").slice(0, 60)}`, "info", 4000);
        }

        if (dmOpen) {
            socket.emit("dm-list", (convs) => {
                dmConversations = convs || [];
                renderDmConversations();
            });
        }
    });

    // Ses & WebRTC Olayları
    socket.on("voice-event", ({ type, serverId, channelId }) => {
        if (serverId === voiceServerId && channelId === voiceChannelId) {
            playTone(type === "join" ? 720 : 420, 0.06, "sine", 0.05);
        }
    });

    socket.on("server-mute-status", (muted) => {
        serverMuted = Boolean(muted);
        applyMuteState();
        showToast(serverMuted ? "Yönetici tarafından susturuldunuz." : "Sunucu susturmanız kaldırıldı.", serverMuted ? "err" : "ok");
    });

    socket.on("force-leave-voice", () => {
        leaveVoiceCleanup(false);
        showToast("Bulunduğunuz ses kanalı kapatıldı.", "info");
    });

    socket.on("voice-afk-moved", async ({ serverId, channelId, channelName, reason, peers: targetPeers }) => {
        stopCamera(true);
        stopScreenShare(true);
        for (const pid of Array.from(peers.keys())) closePeer(pid);

        voiceServerId = serverId;
        voiceChannelId = channelId;
        selfMuted = true;
        applyMuteState();
        updateVoicePanelUI();
        renderChannels();
        playTone(300, 0.14, "triangle", 0.08);

        showToast(
            reason === "auto-afk"
                ? `Uzun süre sessiz kaldığınız için "${channelName}" odasına taşındınız.`
                : `Bir yetkili sizi "${channelName}" odasına taşıdı.`,
            "info",
            4500
        );

        for (const pid of targetPeers || []) {
            await sendOfferToPeer(pid);
        }
    });

    socket.on("user-left-voice", (peerId) => {
        closePeer(peerId);
        voiceMembersCache.delete(peerId);
        pushOverlayState();
    });

    socket.on("screen-share-stopped", (peerId) => removeMediaTile("screen-" + peerId));
    socket.on("cam-stopped", (peerId) => removeMediaTile("cam-" + peerId));

    // Perfect Negotiation Sinyalleşme
    socket.on("webrtc-offer", async ({ from, offer }) => {
        if (!voiceChannelId) return;
        const peer = getOrCreatePeer(from);
        const offerCollision = peer.makingOffer || peer.pc.signalingState !== "stable";
        peer.ignoreOffer = !peer.polite && offerCollision;
        if (peer.ignoreOffer) return;

        try {
            if (offerCollision) {
                await peer.pc.setLocalDescription({ type: "rollback" }).catch(() => { });
            }
            await peer.pc.setRemoteDescription(offer);
            await flushCandidates(peer);
            const answer = await peer.pc.createAnswer();
            answer.sdp = optimizeOpusSDP(answer.sdp);
            await peer.pc.setLocalDescription(answer);
            socket.emit("webrtc-answer", { to: from, answer: peer.pc.localDescription });
        } catch { }
    });

    socket.on("webrtc-answer", async ({ from, answer }) => {
        const peer = peers.get(from);
        if (!peer) return;
        try {
            await peer.pc.setRemoteDescription(answer);
            await flushCandidates(peer);
        } catch { }
    });

    socket.on("webrtc-ice", async ({ from, candidate }) => {
        const peer = peers.get(from);
        if (!peer || !candidate) return;
        if (peer.pc.remoteDescription) {
            await peer.pc.addIceCandidate(candidate).catch(() => { });
        } else {
            peer.pendingCandidates.push(candidate);
        }
    });

    // Ekip & Oyun Araçları Olayları
    socket.on("ready-check-update", ({ serverId, readyCheck, isNew }) => {
        if (serverId !== activeServerId) return;
        activeReadyCheck = readyCheck;
        renderReadyCheckBanner();
        if (isNew && readyCheck) {
            playTone(740, 0.1, "triangle", 0.08);
            setTimeout(() => playTone(980, 0.14, "triangle", 0.08), 110);
            showToast(`✅ ${readyCheck.initiatorName}: ${readyCheck.title}`, "info", 4000);
        }
    });

    socket.on("poll-update", ({ serverId, polls }) => {
        if (serverId !== activeServerId) return;
        serverPolls = polls || [];
        renderPollsList();
    });

    socket.on("watch-state", ({ serverId, watch }) => {
        if (serverId !== activeServerId) return;
        applyWatchState(watch);
    });

    socket.on("soundboard-play", ({ soundId, sender }) => {
        playSoundboardSynth(soundId);
        const item = SOUNDBOARD_ITEMS.find((i) => i.id === soundId);
        if (item) showToast(`${item.icon} ${sender}: ${item.label}`, "info", 1800);
    });

    socket.on("board-state", ({ serverId, board }) => {
        if (serverId !== activeServerId) return;
        applyBoardState(board);
    });

    socket.on("board-stroke", ({ serverId, stroke }) => {
        if (serverId !== activeServerId || !stroke) return;
        boardState.active = true;
        boardState.strokes.push(stroke);
        if ($("board-stage").style.display === "none") {
            applyBoardState(boardState);
        } else {
            redrawBoard();
        }
    });

    // =========================================================================
    // BAŞLATMA
    // =========================================================================
    applyPreferences();
    initSoundboardGrid();
    initTacticBoardEvents();
    bindAllUIEvents();
    initElectronSettingsUI();
})();