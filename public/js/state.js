export const socket = io();
export const isElectron = Boolean(window.electronAPI && window.electronAPI.isElectron);

export const ALLOWED_REACTIONS = ["👍", "😂", "🔥", "❤️", "👀", "🎯"];

export const SOUNDBOARD_ITEMS = [
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

export const DEFAULT_ICE_SERVERS = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun2.l.google.com:19302" }
];

export function loadSavedVolumes() {
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

export function saveUserVolumes() {
    const obj = {};
    for (const [k, v] of state.userVolumes.entries()) obj[k] = v;
    try {
        localStorage.setItem("bd_user_vols", JSON.stringify(obj));
    } catch { }
}

export const state = {
    me: null,
    myServers: [],
    activeServerId: null,
    activeChannelId: null,

    serverSettings: null,
    channels: [],
    roles: [],
    members: [],
    messagesByChannel: {},
    myPermissions: {},
    myPower: 0,
    isServerOwner: false,
    activeReadyCheck: null,
    serverPolls: [],
    watchState: { active: false },
    boardState: { active: false, strokes: [] },

    voiceServerId: null,
    voiceChannelId: null,
    voiceIceServers: [...DEFAULT_ICE_SERVERS],
    hasTurnConfigured: false,
    voiceMembersCache: new Map(),

    latestServerDB: null,

    replyTarget: null,
    unreadChannels: new Set(),
    typingUsers: new Map(),
    typingTimeout: null,
    isCurrentlyTyping: false,

    dmConversations: [],
    activeDmPeer: null,
    dmUnread: false,

    sharedAudioCtx: null,
    masterOutGain: null,
    rawMicStream: null,
    processedMicStream: null,
    micSourceNode: null,
    highPassNode: null,
    micAnalyserNode: null,
    noiseGateNode: null,
    compressorNode: null,
    micGainNode: null,
    micDestNode: null,

    camStream: null,
    screenStream: null,
    camBusy: false,
    screenBusy: false,
    camAttemptId: 0,
    screenAttemptId: 0,
    facingMode: "user",
    spotlightTileId: null,
    selectedScreenSourceId: null,

    peers: new Map(),
    speakingMap: new Map(),
    userVolumes: loadSavedVolumes(),

    selfMuted: false,
    serverMuted: false,
    deafened: false,
    pttEnabled: localStorage.getItem("bd_ptt") === "1",
    pttKey: localStorage.getItem("bd_ptt_key") || "KeyV",
    pttPressed: false,
    awaitingPttKey: false,
    gateThreshold: parseInt(localStorage.getItem("bd_gate") || "22", 10),
    gateOpen: false,
    gateHoldUntil: 0,
    soundboardVolume: parseInt(localStorage.getItem("bd_sb_vol") || "75", 10),
    gameMode: localStorage.getItem("bd_gamemode") === "1",
    mirrorCam: localStorage.getItem("bd_mirror") !== "0",
    afkExempt: localStorage.getItem("bd_afk_exempt") === "1",

    dspLoopTimer: null,
    visualLoopTimer: null,
    healthPollTimer: null,
    lastPingMs: null,
    lastVoiceActivitySent: 0,
    lastOverlayHash: "",
    overlayConfigCache: { enabled: false, position: "top-left", size: "md", needsRestart: false },
    pendingProfileAvatar: undefined,
    editingMemberUsername: null,
    turnAlertShownForChannel: false,

    ytApiPromise: null,
    ytPlayer: null,
    ytPlayerVideoId: null,
    suppressYtEventsUntil: 0,

    boardTool: "pen",
    boardDrawing: false,
    currentStrokePoints: []
};

// Modüller arası döngüsel bağımlılığı önleyen kanca deposu
export const hooks = {
    renderServerRail: () => { },
    renderChannels: () => { },
    renderMembers: () => { },
    updateVoicePanelUI: () => { },
    updateHealthPill: () => { },
    startHealthPolling: () => { },
    stopHealthPolling: () => { },
    closeContextMenu: () => { },
    closeToolsPopover: () => { },
    openDmWith: () => { }
};

export const $ = (id) => document.getElementById(id);

export function escapeHTML(str) {
    return String(str ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

export function showToast(message, type = "info", duration = 3200) {
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

export function openModal(id) {
    hooks.closeContextMenu();
    hooks.closeToolsPopover();
    const el = $(id);
    if (el) el.classList.add("show");
    if (id === "health-modal") hooks.startHealthPolling();
}

export function closeModal(id) {
    const el = $(id);
    if (el) el.classList.remove("show");
    if (id === "health-modal") hooks.stopHealthPolling();
}

export function closeDrawers() {
    $("left-dock")?.classList.remove("open");
    $("rightbar")?.classList.remove("open");
    $("drawer-backdrop")?.classList.remove("show");
}

export function toggleDrawer(which) {
    const left = $("left-dock");
    const right = $("rightbar");
    const bd = $("drawer-backdrop");
    if (!left || !right || !bd) return;
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

export function getInitials(text) {
    const parts = String(text || "?").trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return "?";
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[1][0]).toUpperCase();
}

export function renderAvatarContent(el, { avatar, displayName, username, color }) {
    if (!el) return;
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

export function copyText(text, successMsg = "Panoya kopyalandı.") {
    if (navigator.clipboard?.writeText) {
        navigator.clipboard
            .writeText(text)
            .then(() => showToast(successMsg, "ok"))
            .catch(() => fallbackCopy(text, successMsg));
    } else {
        fallbackCopy(text, successMsg);
    }
}

export function canActOn(targetMember) {
    if (!state.me || !targetMember) return false;
    if (targetMember.username === state.me.username) return false;
    if (targetMember.isOwner) return false;
    if (state.isServerOwner) return true;
    return state.myPower > (targetMember.power || 0);
}

export function canManageRole(role) {
    if (!role) return false;
    if (state.isServerOwner) return true;
    return state.myPower > (role.priority || 0);
}

export function compressImageFile(file, maxW = 1280, quality = 0.8) {
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