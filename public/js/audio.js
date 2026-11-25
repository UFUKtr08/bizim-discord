import { socket, isElectron, state, $, showToast } from "./state.js";

// =========================================================================
// PAYLAŞIMLI AUDIOCONTEXT, ÇIKIŞ AYGITI & ELECTRON 33 HİBRİT SES MOTORU
// =========================================================================
export function ensureSharedAudioCtx() {
    if (!state.sharedAudioCtx) {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        state.sharedAudioCtx = new Ctx({ latencyHint: "interactive" });
        state.masterOutGain = state.sharedAudioCtx.createGain();
        state.masterOutGain.gain.value = state.deafened ? 0 : 1;
        state.masterOutGain.connect(state.sharedAudioCtx.destination);
        applyOutputDevice();
    }
    if (state.sharedAudioCtx.state === "suspended") {
        state.sharedAudioCtx.resume().catch(() => { });
    }
    return state.sharedAudioCtx;
}

export function resumeAudioOnGesture() {
    if (state.sharedAudioCtx && state.sharedAudioCtx.state === "suspended") {
        state.sharedAudioCtx.resume().catch(() => { });
    }
    for (const peer of state.peers.values()) {
        for (const node of peer.audioNodes) {
            if (node.active && node.audioEl && node.audioEl.paused) {
                node.audioEl.play().catch(() => { });
            }
        }
    }
}

export function applyOutputDevice() {
    const sinkId = $("spk-select")?.value;
    if (!sinkId) return;

    if (state.sharedAudioCtx && typeof state.sharedAudioCtx.setSinkId === "function") {
        state.sharedAudioCtx.setSinkId(sinkId).catch(() => { });
    }

    for (const peer of state.peers.values()) {
        for (const node of peer.audioNodes) {
            if (node.active && node.audioEl && typeof node.audioEl.setSinkId === "function") {
                node.audioEl.setSinkId(sinkId).catch(() => { });
            }
        }
    }
}

function getPeerDesiredVolume(peerId) {
    const m = state.voiceMembersCache.get(peerId) || state.members.find((x) => x.id === peerId);
    const volKey = m?.username || peerId;
    return state.userVolumes.has(volKey) ? state.userVolumes.get(volKey) : 1;
}

// Electron 33 / Chromium Hibrit Oynatma:
// 0% - 100%  -> Doğrudan native <audio> (sıfır Web Audio sessizlik riski)
// 101% - 200% -> Native <audio> muted=true ama aktif oynar halde + Web Audio GainNode boost
function applyNodePlaybackVolume(nodeObj, rawVol) {
    if (!nodeObj || !nodeObj.active) return;
    const clamped = Math.max(0, Math.min(2, Number.isFinite(rawVol) ? rawVol : 1));
    nodeObj.volume = clamped;

    const isDeaf = state.deafened;
    const useBoost = !isDeaf && clamped > 1.001 && Boolean(nodeObj.boostGain);

    if (nodeObj.audioEl) {
        if (isDeaf || clamped <= 0.001) {
            nodeObj.audioEl.muted = true;
            nodeObj.audioEl.volume = 0;
        } else if (useBoost) {
            // Chromium'da remote MediaStream'i Web Audio'ya beslemek için <audio> muted ama playing kalır
            nodeObj.audioEl.muted = true;
            nodeObj.audioEl.volume = 0;
        } else {
            nodeObj.audioEl.muted = false;
            nodeObj.audioEl.volume = Math.min(1, clamped);
        }
        if (nodeObj.audioEl.paused) {
            nodeObj.audioEl.play().catch(() => { });
        }
    }

    if (nodeObj.boostGain && state.sharedAudioCtx) {
        const targetGain = useBoost ? clamped : 0;
        try {
            nodeObj.boostGain.gain.setTargetAtTime(targetGain, state.sharedAudioCtx.currentTime, 0.015);
        } catch {
            nodeObj.boostGain.gain.value = targetGain;
        }
    }
}

export function setPeerAudioVolume(peerId, vol) {
    const peer = state.peers.get(peerId);
    if (!peer) return;
    for (const node of peer.audioNodes) {
        if (node.active) applyNodePlaybackVolume(node, vol);
    }
}

export function applyAllRemoteAudioRouting() {
    if (state.masterOutGain) {
        state.masterOutGain.gain.value = state.deafened ? 0 : 1;
    }
    for (const [peerId, peer] of state.peers.entries()) {
        const vol = getPeerDesiredVolume(peerId);
        for (const node of peer.audioNodes) {
            if (node.active) applyNodePlaybackVolume(node, vol);
        }
    }
}

export function attachRemoteAudio(peerId, peer, track, _stream, { isMic = true } = {}) {
    // Aynı track ikinci kez eklenmesin
    const existing = peer.audioNodes.find((n) => n.active && n.trackId === track.id);
    if (existing) {
        existing.isMic = isMic;
        applyNodePlaybackVolume(existing, getPeerDesiredVolume(peerId));
        return existing;
    }

    const trackStream = new MediaStream([track]);
    const audioEl = document.createElement("audio");
    audioEl.autoplay = true;
    audioEl.playsInline = true;
    audioEl.srcObject = trackStream;

    const sinkPool = $("hidden-audio-sink") || document.body;
    sinkPool.appendChild(audioEl);

    const sinkId = $("spk-select")?.value;
    if (sinkId && typeof audioEl.setSinkId === "function") {
        audioEl.setSinkId(sinkId).catch(() => { });
    }

    let src = null;
    let boostGain = null;
    let analyser = null;

    try {
        const ctx = ensureSharedAudioCtx();
        src = ctx.createMediaStreamSource(trackStream);
        boostGain = ctx.createGain();
        boostGain.gain.value = 0;

        analyser = ctx.createAnalyser();
        analyser.fftSize = 128;

        // Konuşma tespiti kazançtan bağımsız pasif analyser üzerinden yapılır
        src.connect(analyser);
        src.connect(boostGain);
        boostGain.connect(state.masterOutGain);
    } catch { }

    const nodeObj = {
        trackId: track.id,
        isMic,
        src,
        boostGain,
        analyser,
        audioEl,
        volume: 1,
        active: true
    };

    peer.audioNodes.push(nodeObj);
    applyNodePlaybackVolume(nodeObj, getPeerDesiredVolume(peerId));
    audioEl.play().catch(() => { });

    track.addEventListener("ended", () => cleanupRemoteAudioNode(peer, nodeObj), { once: true });
    return nodeObj;
}

export function cleanupRemoteAudioNode(peer, nodeObj) {
    if (!nodeObj || !nodeObj.active) return;
    nodeObj.active = false;
    try {
        nodeObj.src?.disconnect();
        nodeObj.boostGain?.disconnect();
        nodeObj.analyser?.disconnect();
    } catch { }
    if (nodeObj.audioEl) {
        try {
            nodeObj.audioEl.pause();
            nodeObj.audioEl.srcObject = null;
            nodeObj.audioEl.remove();
        } catch { }
    }
    peer.audioNodes = peer.audioNodes.filter((n) => n !== nodeObj);
}

// =========================================================================
// BİLDİRİM TONLARI, SOUNDBOARD & OPUS SDP OPTİMİZASYONU
// =========================================================================
export function playTone(freq = 640, duration = 0.08, type = "sine", vol = 0.06) {
    if (state.deafened) return;
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

export function playSoundboardSynth(soundId) {
    if (state.deafened || state.soundboardVolume <= 0) return;
    const vol = (state.soundboardVolume / 100) * 0.28;
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

export function optimizeOpusSDP(sdp) {
    if (!sdp) return sdp;
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
// TERCİHLER, TEMA, OYUN MODU & ELECTRON OVERLAY
// =========================================================================
export function clearAllSpeakingVisuals() {
    document.querySelectorAll(".speaking").forEach((el) => el.classList.remove("speaking"));
}

export function updateGameModeUI() {
    document.body.classList.toggle("game-mode", state.gameMode);
    const btn = $("btn-game-mode");
    const lbl = $("game-mode-lbl");
    if (btn) btn.classList.toggle("active", state.gameMode);
    if (lbl) lbl.textContent = state.gameMode ? "Oyun Modu: AÇIK" : "Oyun Modu";
    if (state.gameMode) clearAllSpeakingVisuals();
}

export function updateGateMarkerUI() {
    const valEl = $("gate-val");
    const sbLine = $("sidebar-gate-line");
    const mdLine = $("modal-gate-line");
    if (valEl) valEl.textContent = state.gateThreshold > 0 ? `${state.gateThreshold}%` : "Kapalı";
    if (sbLine) sbLine.style.left = `${state.gateThreshold}%`;
    if (mdLine) mdLine.style.left = `${state.gateThreshold}%`;
}

export function applyPreferences() {
    const theme = localStorage.getItem("bd_theme") || "dark";
    const accent = localStorage.getItem("bd_accent") || "#5865f2";
    const fontSize = localStorage.getItem("bd_fontsize") || "14px";

    document.body.setAttribute("data-theme", theme);
    document.documentElement.style.setProperty("--accent", accent);
    document.documentElement.style.setProperty("--font-size", fontSize);

    if ($("theme-select")) $("theme-select").value = theme;
    if ($("accent-picker")) $("accent-picker").value = accent;
    if ($("font-size-select")) $("font-size-select").value = fontSize;
    if ($("gate-slider")) $("gate-slider").value = String(state.gateThreshold);
    if ($("chk-ptt")) $("chk-ptt").checked = state.pttEnabled;
    if ($("btn-ptt-key")) $("btn-ptt-key").textContent = state.pttKey;
    if ($("chk-mirror")) $("chk-mirror").checked = state.mirrorCam;
    if ($("chk-afk-exempt")) $("chk-afk-exempt").checked = state.afkExempt;
    if ($("sb-vol-slider")) $("sb-vol-slider").value = String(state.soundboardVolume);
    if ($("sb-vol-val")) $("sb-vol-val").textContent = `${state.soundboardVolume}%`;

    updateGateMarkerUI();
    updateGameModeUI();
}

export function syncOverlaySettingsUI(cfg) {
    if (!cfg) return;
    state.overlayConfigCache = cfg;
    if ($("chk-overlay-enabled")) $("chk-overlay-enabled").checked = Boolean(cfg.enabled);
    if ($("overlay-pos-select")) $("overlay-pos-select").value = cfg.position || "top-left";
    if ($("overlay-size-select")) $("overlay-size-select").value = cfg.size || "md";
    if ($("chk-disable-gpu")) $("chk-disable-gpu").checked = Boolean(cfg.disableGpu);
    if ($("overlay-restart-banner")) $("overlay-restart-banner").style.display = cfg.needsRestart ? "flex" : "none";
}

export function pushOverlayState(force = false) {
    if (!isElectron) return;
    if (!state.voiceChannelId || !state.voiceServerId) {
        if (force || state.lastOverlayHash !== "OFF") {
            state.lastOverlayHash = "OFF";
            window.electronAPI.updateOverlayState({ active: false, channelName: "", users: [] });
        }
        return;
    }

    const list = [];
    for (const m of state.voiceMembersCache.values()) {
        const isMe = state.me && m.username === state.me.username;
        const muted = isMe
            ? (state.selfMuted || state.serverMuted || state.deafened)
            : Boolean(m.selfMuted || m.serverMuted || m.deafened);
        const speaking = isMe
            ? Boolean(state.speakingMap.get(socket.id)) && !muted
            : Boolean(m.id && state.speakingMap.get(m.id)) && !muted;

        list.push({
            username: m.username,
            displayName: m.displayName || m.username,
            color: m.color || "#5865f2",
            avatar: m.avatar || "",
            muted,
            serverMuted: Boolean(isMe ? state.serverMuted : m.serverMuted),
            deafened: Boolean(isMe ? state.deafened : m.deafened),
            speaking
        });
    }

    list.sort((a, b) => a.displayName.localeCompare(b.displayName, "tr"));

    const hash = list
        .map((u) => `${u.username}:${u.speaking ? 1 : 0}:${u.muted ? 1 : 0}:${u.displayName}:${u.color}:${u.avatar ? u.avatar.length : 0}`)
        .join("|");
    if (!force && hash === state.lastOverlayHash) return;
    state.lastOverlayHash = hash;

    window.electronAPI.updateOverlayState({
        active: true,
        channelName: state.voiceChannelId,
        users: list
    });
}

export async function updateOverlaySettings(partial) {
    if (!isElectron) return;
    try {
        const res = await window.electronAPI.setOverlayConfig(partial);
        syncOverlaySettingsUI(res);
        if (res.needsRestart) {
            showToast("Saydam overlay için uygulamayı yeniden başlatın.", "info", 4500);
        } else {
            state.lastOverlayHash = "";
            pushOverlayState(true);
        }
    } catch { }
}

export async function toggleOverlayFromShortcut() {
    if (!isElectron) return;
    const nextEnabled = !state.overlayConfigCache.enabled;
    await updateOverlaySettings({ enabled: nextEnabled });
    if (!state.overlayConfigCache.needsRestart) {
        showToast(nextEnabled ? "Oyun İçi Overlay açıldı." : "Oyun İçi Overlay kapatıldı.", "info", 2000);
    }
}

export async function initElectronSettingsUI() {
    if (!isElectron) return;
    if ($("electron-overlay-card")) $("electron-overlay-card").style.display = "flex";

    try {
        const dbPath = await window.electronAPI.dbPath();
        if ($("db-info")) $("db-info").textContent = `Yerel Master DB: ${dbPath}`;
    } catch { }

    try {
        const cfg = await window.electronAPI.getOverlayConfig();
        syncOverlaySettingsUI(cfg);
    } catch { }

    window.electronAPI.onGlobalShortcut((action) => {
        if (!state.voiceChannelId && action !== "toggle-overlay") return;
        if (action === "toggle-mute") toggleMute();
        else if (action === "toggle-deafen") toggleDeafen();
        else if (action === "toggle-overlay") toggleOverlayFromShortcut();
    });
}

// =========================================================================
// MİKROFON DSP ZİNCİRİ & KONUŞMA TESPİTİ
// =========================================================================
export async function loadMediaDevices() {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    const devs = await navigator.mediaDevices.enumerateDevices();
    const micSel = $("mic-select");
    const spkSel = $("spk-select");
    const camSel = $("cam-select");
    if (!micSel || !spkSel || !camSel) return;

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

export function applyLiveDspToggles() {
    if (state.highPassNode) {
        state.highPassNode.type = "highpass";
        state.highPassNode.frequency.value = $("chk-hpf")?.checked ? 85 : 10;
        state.highPassNode.Q.value = 0.7;
    }
    if (state.compressorNode) {
        if ($("chk-comp")?.checked) {
            state.compressorNode.threshold.value = -18;
            state.compressorNode.knee.value = 18;
            state.compressorNode.ratio.value = 6;
            state.compressorNode.attack.value = 0.004;
            state.compressorNode.release.value = 0.14;
        } else {
            state.compressorNode.threshold.value = 0;
            state.compressorNode.ratio.value = 1;
        }
    }
}

export async function buildMicPipeline() {
    const ctx = ensureSharedAudioCtx();
    if (state.rawMicStream) state.rawMicStream.getTracks().forEach((t) => t.stop());
    if (state.micSourceNode) {
        try { state.micSourceNode.disconnect(); } catch { }
    }

    state.rawMicStream = await navigator.mediaDevices.getUserMedia({
        audio: {
            deviceId: $("mic-select")?.value ? { exact: $("mic-select").value } : undefined,
            noiseSuppression: Boolean($("chk-ns")?.checked),
            echoCancellation: Boolean($("chk-aec")?.checked),
            autoGainControl: Boolean($("chk-agc")?.checked),
            channelCount: 1
        }
    });

    state.micSourceNode = ctx.createMediaStreamSource(state.rawMicStream);
    if (!state.highPassNode) state.highPassNode = ctx.createBiquadFilter();
    if (!state.micAnalyserNode) {
        state.micAnalyserNode = ctx.createAnalyser();
        state.micAnalyserNode.fftSize = 256;
    }
    if (!state.noiseGateNode) {
        state.noiseGateNode = ctx.createGain();
        state.noiseGateNode.gain.value = 1;
    }
    if (!state.compressorNode) state.compressorNode = ctx.createDynamicsCompressor();
    if (!state.micGainNode) state.micGainNode = ctx.createGain();
    if (!state.micDestNode) state.micDestNode = ctx.createMediaStreamDestination();

    state.micGainNode.gain.value = parseFloat($("mic-gain")?.value || "1");
    applyLiveDspToggles();

    state.micSourceNode.connect(state.highPassNode);
    state.highPassNode.connect(state.micAnalyserNode);
    state.highPassNode.connect(state.noiseGateNode);
    state.noiseGateNode.connect(state.compressorNode);
    state.compressorNode.connect(state.micGainNode);
    state.micGainNode.connect(state.micDestNode);

    state.processedMicStream = state.micDestNode.stream;
    const newTrack = state.processedMicStream.getAudioTracks()[0];

    for (const peer of state.peers.values()) {
        if (peer.micSender && newTrack) {
            await peer.micSender.replaceTrack(newTrack).catch(() => { });
        }
    }

    applyMuteState();
    startDspAndVisualLoops();
    loadMediaDevices().catch(() => { });
}

export function stopMicPipeline() {
    if (state.rawMicStream) {
        state.rawMicStream.getTracks().forEach((t) => t.stop());
        state.rawMicStream = null;
    }
    state.processedMicStream = null;
    stopDspAndVisualLoops();
}

export function isEffectivelyMuted() {
    if (state.serverMuted || state.selfMuted || state.deafened) return true;
    if (state.pttEnabled && !state.pttPressed) return true;
    return false;
}

export function applyMuteState() {
    const muted = isEffectivelyMuted();
    if (state.processedMicStream) {
        state.processedMicStream.getAudioTracks().forEach((t) => { t.enabled = !muted; });
    }
    applyAllRemoteAudioRouting();

    const micBtn = $("btn-mute");
    const mMicBtn = $("m-btn-mute");
    const deafBtn = $("btn-deafen");
    const mDeafBtn = $("m-btn-deafen");

    const micVisualMuted = state.selfMuted || state.serverMuted || state.deafened;
    [micBtn, mMicBtn].forEach((b) => {
        if (!b) return;
        b.classList.toggle("muted", micVisualMuted);
        b.textContent = state.serverMuted ? "🔇" : (micVisualMuted ? "🎙️✕" : "🎙️");
    });
    [deafBtn, mDeafBtn].forEach((b) => {
        if (!b) return;
        b.classList.toggle("muted", state.deafened);
        b.textContent = state.deafened ? "🎧✕" : "🎧";
    });

    const pttBadge = $("ptt-indicator");
    if (pttBadge) {
        pttBadge.style.display = state.voiceChannelId && state.pttEnabled ? "block" : "none";
        pttBadge.textContent = state.pttPressed
            ? `Bas-Konuş AKTİF [${state.pttKey}]`
            : `Bas-Konuş: [${state.pttKey}] Basılı Tut`;
        pttBadge.classList.toggle("active", state.pttPressed);
    }

    pushOverlayState();
}

export function toggleMute() {
    if (!state.voiceChannelId) return;
    if (state.serverMuted) {
        showToast("Sunucu yöneticisi tarafından susturuldun.", "err");
        return;
    }
    state.selfMuted = !state.selfMuted;
    playTone(state.selfMuted ? 380 : 620, 0.06);
    applyMuteState();
    socket.emit("voice-status-update", { selfMuted: state.selfMuted });
}

export function toggleDeafen() {
    if (!state.voiceChannelId) return;
    state.deafened = !state.deafened;
    playTone(state.deafened ? 310 : 540, 0.07);
    applyMuteState();
    socket.emit("voice-status-update", { deafened: state.deafened });
}

export function setSpeakingState(socketId, speaking) {
    const prev = Boolean(state.speakingMap.get(socketId));
    if (prev === speaking) return;
    state.speakingMap.set(socketId, speaking);

    if (!state.gameMode && !document.hidden) {
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

export function startDspAndVisualLoops() {
    stopDspAndVisualLoops();
    const micBuf = new Uint8Array(128);
    const peerBuf = new Uint8Array(64);

    state.dspLoopTimer = setInterval(() => {
        if (!state.micAnalyserNode || !state.noiseGateNode || !state.sharedAudioCtx) return;

        state.micAnalyserNode.getByteTimeDomainData(micBuf);
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
            state.gateOpen = false;
            state.noiseGateNode.gain.setTargetAtTime(0, state.sharedAudioCtx.currentTime, 0.015);
        } else if (state.gateThreshold <= 0) {
            state.gateOpen = true;
            state.noiseGateNode.gain.setTargetAtTime(1, state.sharedAudioCtx.currentTime, 0.01);
        } else if (pct >= state.gateThreshold) {
            state.gateOpen = true;
            state.gateHoldUntil = now + 240;
            state.noiseGateNode.gain.setTargetAtTime(1, state.sharedAudioCtx.currentTime, 0.008);
        } else if (now > state.gateHoldUntil) {
            state.gateOpen = false;
            state.noiseGateNode.gain.setTargetAtTime(0, state.sharedAudioCtx.currentTime, 0.035);
        }

        const amSpeaking = !effMuted && (state.gateThreshold > 0 ? state.gateOpen : pct > 8);
        setSpeakingState(socket.id, amSpeaking);

        if (amSpeaking && now - state.lastVoiceActivitySent > 15000) {
            state.lastVoiceActivitySent = now;
            socket.emit("voice-activity");
        }

        if (!document.hidden && !state.gameMode) {
            const barW = effMuted ? "0%" : `${pct}%`;
            if ($("mic-meter")) $("mic-meter").style.width = barW;
            if ($("modal-mic-meter")) $("modal-mic-meter").style.width = barW;
        }
    }, 45);

    state.visualLoopTimer = setInterval(() => {
        for (const [peerId, peer] of state.peers.entries()) {
            let speaking = false;
            for (const node of peer.audioNodes) {
                if (!node.active || !node.isMic || !node.analyser) continue;
                node.analyser.getByteTimeDomainData(peerBuf);
                let sum = 0;
                for (let i = 0; i < peerBuf.length; i++) {
                    const v = (peerBuf[i] - 128) / 128;
                    sum += v * v;
                }
                const rms = Math.sqrt(sum / peerBuf.length);
                if (rms > 0.025) {
                    speaking = true;
                    break;
                }
            }
            setSpeakingState(peerId, speaking);
        }
        pushOverlayState();
    }, 110);
}

export function stopDspAndVisualLoops() {
    if (state.dspLoopTimer) {
        clearInterval(state.dspLoopTimer);
        state.dspLoopTimer = null;
    }
    if (state.visualLoopTimer) {
        clearInterval(state.visualLoopTimer);
        state.visualLoopTimer = null;
    }
    if ($("mic-meter")) $("mic-meter").style.width = "0%";
    if ($("modal-mic-meter")) $("modal-mic-meter").style.width = "0%";
}