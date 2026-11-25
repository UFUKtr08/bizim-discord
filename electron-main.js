const {
    app,
    BrowserWindow,
    session,
    desktopCapturer,
    ipcMain,
    shell,
    globalShortcut,
    screen,
    net
} = require("electron");
const path = require("path");
const fs = require("fs");

// =========================================================================
// ALDIĞIN RENDER LİNKİNİ AŞAĞIDAKİ TIRNAK İÇİNE YAPIŞTIR (Sonunda / olmasın)
// =========================================================================
const SERVER_URL = process.env.SERVER_URL || "https://bizim-discord.onrender.com";

const PERF_CFG_PATH = path.join(app.getPath("userData"), "perf-config.json");

const DEFAULT_PERF_CONFIG = {
    disableGpu: true,
    overlay: {
        enabled: false,
        position: "top-left", // top-left | top-right | bottom-left | bottom-right
        size: "md"            // sm | md | lg
    }
};

function sanitizePerfConfig(raw) {
    const validPos = ["top-left", "top-right", "bottom-left", "bottom-right"];
    const validSize = ["sm", "md", "lg"];
    return {
        disableGpu: typeof raw?.disableGpu === "boolean" ? raw.disableGpu : DEFAULT_PERF_CONFIG.disableGpu,
        overlay: {
            enabled: Boolean(raw?.overlay?.enabled),
            position: validPos.includes(raw?.overlay?.position) ? raw.overlay.position : DEFAULT_PERF_CONFIG.overlay.position,
            size: validSize.includes(raw?.overlay?.size) ? raw.overlay.size : DEFAULT_PERF_CONFIG.overlay.size
        }
    };
}

function readPerfConfig() {
    try {
        if (fs.existsSync(PERF_CFG_PATH)) {
            return sanitizePerfConfig(JSON.parse(fs.readFileSync(PERF_CFG_PATH, "utf8")));
        }
    } catch { }
    return sanitizePerfConfig(DEFAULT_PERF_CONFIG);
}

function savePerfConfig(cfg) {
    try {
        fs.writeFileSync(PERF_CFG_PATH, JSON.stringify(cfg, null, 2), "utf8");
    } catch { }
}

let perfConfig = readPerfConfig();

const bootedWithoutGpu = perfConfig.disableGpu && !perfConfig.overlay.enabled;
if (bootedWithoutGpu) {
    app.disableHardwareAcceleration();
    app.commandLine.appendSwitch("disable-gpu-compositing");
}

app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");

const DB_DIR = path.join(app.getPath("documents"), "BizimDiscord_DB");
const LOCAL_DB_PATH = path.join(DB_DIR, "bizim_discord_db.json");
const LOCAL_DB_BAK_PATH = path.join(DB_DIR, "bizim_discord_db.bak.json");

let mainWin = null;
let overlayWin = null;
let pendingScreenChoice = { sourceId: null, withAudio: false };
let lastOverlayState = { active: false, channelName: "", users: [] };

function ensureLocalDBDir() {
    if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
}

function countDbMetrics(dbObj) {
    if (!dbObj || typeof dbObj !== "object") {
        return { users: 0, servers: 0, messages: 0, seededOnly: true };
    }
    const users = Object.keys(dbObj.users || {}).length;
    const servers = Object.keys(dbObj.servers || {}).length;
    let messages = 0;
    for (const srv of Object.values(dbObj.servers || {})) {
        for (const arr of Object.values(srv?.messages || {})) {
            if (Array.isArray(arr)) messages += arr.length;
        }
    }
    return {
        users,
        servers,
        messages,
        seededOnly: Boolean(dbObj.meta?.seededOnly)
    };
}

function getOverlayDimensions(size) {
    if (size === "sm") return { width: 240, height: 340 };
    if (size === "lg") return { width: 320, height: 480 };
    return { width: 276, height: 410 };
}

function positionOverlayWindow() {
    if (!overlayWin || overlayWin.isDestroyed()) return;
    const primary = screen.getPrimaryDisplay();
    const area = primary.workArea || primary.bounds;
    const { width, height } = getOverlayDimensions(perfConfig.overlay.size);
    const margin = 16;

    let x = area.x + margin;
    let y = area.y + margin;

    switch (perfConfig.overlay.position) {
        case "top-right":
            x = area.x + area.width - width - margin;
            y = area.y + margin;
            break;
        case "bottom-left":
            x = area.x + margin;
            y = area.y + area.height - height - margin;
            break;
        case "bottom-right":
            x = area.x + area.width - width - margin;
            y = area.y + area.height - height - margin;
            break;
        case "top-left":
        default:
            x = area.x + margin;
            y = area.y + margin;
            break;
    }

    overlayWin.setBounds({
        x: Math.round(x),
        y: Math.round(y),
        width,
        height
    });
}

function syncOverlayVisibility() {
    const shouldShow =
        perfConfig.overlay.enabled &&
        !bootedWithoutGpu &&
        Boolean(lastOverlayState.active) &&
        Array.isArray(lastOverlayState.users) &&
        lastOverlayState.users.length > 0;

    if (!shouldShow) {
        if (overlayWin && !overlayWin.isDestroyed() && overlayWin.isVisible()) {
            overlayWin.hide();
        }
        return;
    }

    if (!overlayWin || overlayWin.isDestroyed()) {
        createOverlayWindow();
        return;
    }

    positionOverlayWindow();
    if (!overlayWin.isVisible()) {
        overlayWin.showInactive();
    }
    overlayWin.setAlwaysOnTop(true, "screen-saver", 1);
    overlayWin.setIgnoreMouseEvents(true, { forward: true });
}

function createOverlayWindow() {
    if (bootedWithoutGpu) return;
    if (overlayWin && !overlayWin.isDestroyed()) return;

    const { width, height } = getOverlayDimensions(perfConfig.overlay.size);

    overlayWin = new BrowserWindow({
        width,
        height,
        frame: false,
        transparent: true,
        backgroundColor: "#00000000",
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        closable: false,
        focusable: false,
        skipTaskbar: true,
        hasShadow: false,
        alwaysOnTop: true,
        show: false,
        webPreferences: {
            preload: path.join(__dirname, "preload.js"),
            nodeIntegration: false,
            contextIsolation: true
        }
    });

    overlayWin.setAlwaysOnTop(true, "screen-saver", 1);
    overlayWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    overlayWin.setIgnoreMouseEvents(true, { forward: true });

    positionOverlayWindow();
    overlayWin.loadFile(path.join(__dirname, "overlay.html"));

    overlayWin.webContents.on("did-finish-load", () => {
        if (!overlayWin || overlayWin.isDestroyed()) return;
        overlayWin.webContents.send("overlay-config", perfConfig.overlay);
        overlayWin.webContents.send("overlay-data", lastOverlayState);
        syncOverlayVisibility();
    });

    overlayWin.on("closed", () => {
        overlayWin = null;
    });
}

// =========================================================================
// IPC HANDLERS
// =========================================================================

ipcMain.handle("get-gpu-mode", async () => perfConfig.disableGpu);

ipcMain.handle("set-gpu-mode", async (_event, disableGpu) => {
    perfConfig = sanitizePerfConfig({
        ...perfConfig,
        disableGpu: !!disableGpu
    });
    savePerfConfig(perfConfig);
    app.relaunch();
    app.exit(0);
});

ipcMain.handle("get-runtime-perf-info", async () => ({
    disableGpu: perfConfig.disableGpu,
    effectiveDisableGpu: perfConfig.disableGpu && !perfConfig.overlay.enabled,
    bootedWithoutGpu,
    overlay: perfConfig.overlay
}));

ipcMain.handle("relaunch-app", async () => {
    app.relaunch();
    app.exit(0);
});

ipcMain.handle("get-overlay-config", async () => ({
    ...perfConfig.overlay,
    disableGpu: perfConfig.disableGpu,
    bootedWithoutGpu,
    needsRestart: perfConfig.overlay.enabled && bootedWithoutGpu
}));

ipcMain.handle("set-overlay-config", async (_event, partialCfg) => {
    const nextOverlay = {
        ...perfConfig.overlay,
        ...(partialCfg && typeof partialCfg === "object" ? partialCfg : {})
    };
    perfConfig = sanitizePerfConfig({
        ...perfConfig,
        overlay: nextOverlay
    });
    savePerfConfig(perfConfig);

    const needsRestart = perfConfig.overlay.enabled && bootedWithoutGpu;

    if (!needsRestart) {
        if (perfConfig.overlay.enabled && (!overlayWin || overlayWin.isDestroyed())) {
            createOverlayWindow();
        }
        if (overlayWin && !overlayWin.isDestroyed()) {
            positionOverlayWindow();
            overlayWin.webContents.send("overlay-config", perfConfig.overlay);
        }
        syncOverlayVisibility();
    } else if (overlayWin && !overlayWin.isDestroyed()) {
        overlayWin.hide();
    }

    return {
        ...perfConfig.overlay,
        disableGpu: perfConfig.disableGpu,
        bootedWithoutGpu,
        needsRestart
    };
});

ipcMain.on("overlay-update-state", (_event, payload) => {
    lastOverlayState = {
        active: Boolean(payload?.active),
        channelName: String(payload?.channelName || ""),
        users: Array.isArray(payload?.users) ? payload.users : []
    };

    if (overlayWin && !overlayWin.isDestroyed()) {
        overlayWin.webContents.send("overlay-data", lastOverlayState);
    }
    syncOverlayVisibility();
});

// Zırhlı Yerel DB Yazımı: Daha az kullanıcılı veya sıfırlanmış sunucu verisi dolu yedeği asla ezemez
ipcMain.handle("db-save", async (_event, data) => {
    try {
        ensureLocalDBDir();
        if (!data || typeof data !== "object" || !data.users) {
            return { ok: false, error: "Geçersiz DB verisi." };
        }

        let existing = null;
        if (fs.existsSync(LOCAL_DB_PATH)) {
            try {
                existing = JSON.parse(fs.readFileSync(LOCAL_DB_PATH, "utf8"));
            } catch { }
        }

        const incStats = countDbMetrics(data);
        const curStats = countDbMetrics(existing);

        if (existing && (curStats.users > 1 || curStats.messages > 0 || !curStats.seededOnly)) {
            if (incStats.seededOnly || incStats.users < curStats.users) {
                return {
                    ok: false,
                    blocked: true,
                    reason: "Yerel yedek daha kapsamlı olduğu için ezilmedi."
                };
            }
            try {
                fs.writeFileSync(LOCAL_DB_BAK_PATH, JSON.stringify(existing, null, 2), "utf8");
            } catch { }
        }

        const serialized = JSON.stringify(data, null, 2);
        const tmpPath = LOCAL_DB_PATH + ".tmp";
        try {
            fs.writeFileSync(tmpPath, serialized, "utf8");
            fs.renameSync(tmpPath, LOCAL_DB_PATH);
        } catch {
            fs.writeFileSync(LOCAL_DB_PATH, serialized, "utf8");
        }
        return { ok: true, path: LOCAL_DB_PATH };
    } catch (err) {
        return { ok: false, error: err.message };
    }
});

// Ana dosya ve .bak yedeğini karşılaştırır, en dolu/sağlam olanı döndürür
ipcMain.handle("db-load", async () => {
    const readValid = (filePath) => {
        try {
            if (!fs.existsSync(filePath)) return null;
            const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
            return parsed && typeof parsed === "object" && parsed.users ? parsed : null;
        } catch {
            return null;
        }
    };

    const primary = readValid(LOCAL_DB_PATH);
    const backup = readValid(LOCAL_DB_BAK_PATH);
    if (!primary) return backup;
    if (!backup) return primary;

    const pStats = countDbMetrics(primary);
    const bStats = countDbMetrics(backup);

    if (pStats.seededOnly && !bStats.seededOnly) return backup;
    if (bStats.users > pStats.users) return backup;
    if (bStats.users === pStats.users && bStats.messages > pStats.messages) return backup;
    return primary;
});

ipcMain.handle("db-path", async () => LOCAL_DB_PATH);

ipcMain.handle("get-screen-sources", async () => {
    const sources = await desktopCapturer.getSources({
        types: ["screen", "window"],
        thumbnailSize: { width: 280, height: 158 }
    });
    return sources
        .filter((s) => s.name !== "BizimDiscord Overlay")
        .map((s) => ({
            id: s.id,
            name: s.name,
            isScreen: s.id.startsWith("screen:"),
            thumbnail: s.thumbnail.toDataURL()
        }));
});

ipcMain.handle("select-screen-source", async (_event, opts) => {
    pendingScreenChoice = {
        sourceId: opts?.sourceId || null,
        withAudio: !!opts?.withAudio
    };
    return true;
});

// =========================================================================
// ANA PENCERE
// =========================================================================
function createWindow() {
    mainWin = new BrowserWindow({
        width: 1280,
        height: 820,
        minWidth: 380,
        minHeight: 560,
        title: "BizimDiscord",
        icon: path.join(__dirname, "icon.png"),
        autoHideMenuBar: true,
        backgroundColor: "#111214",
        webPreferences: {
            preload: path.join(__dirname, "preload.js"),
            nodeIntegration: false,
            contextIsolation: true
        }
    });

    session.defaultSession.clearCache();

    // İzinleri yalnızca güvenilir sunucu origin'i için onayla
    session.defaultSession.setPermissionRequestHandler((wc, permission, callback) => {
        const allowed = ["media", "mediaKeySystem", "fullscreen", "display-capture"];
        const currentUrl = wc?.getURL() || "";
        const trusted = currentUrl.startsWith(SERVER_URL);
        callback(trusted && allowed.includes(permission));
    });

    mainWin.webContents.setWindowOpenHandler(({ url }) => {
        if (url.startsWith("http://") || url.startsWith("https://")) {
            shell.openExternal(url);
        }
        return { action: "deny" };
    });

    session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
        try {
            const sources = await desktopCapturer.getSources({ types: ["screen", "window"] });
            const chosen = sources.find((s) => s.id === pendingScreenChoice.sourceId) || sources[0];
            if (!chosen) return callback({});
            const res = { video: chosen };
            if (pendingScreenChoice.withAudio && process.platform === "win32") {
                res.audio = "loopback";
            }
            callback(res);
        } catch {
            callback({});
        }
    });

    const wakeUpHTML = `
    <!DOCTYPE html>
    <html lang="tr">
    <head><meta charset="UTF-8"><style>
      body { background:#111214; color:#dbdee1; font-family:'Segoe UI',system-ui,sans-serif; display:flex;
             flex-direction:column; align-items:center; justify-content:center; height:100vh; margin:0; }
      .spinner { width:40px; height:40px; border:3px solid #2b2d31; border-top-color:#5865f2;
                 border-radius:50%; animation:spin 0.85s linear infinite; margin-bottom:18px; }
      @keyframes spin { to { transform: rotate(360deg); } }
      h2 { color:#f2f3f5; margin:0 0 8px; font-weight:600; font-size:20px; letter-spacing:-0.2px; }
      p { color:#949ba4; font-size:13.5px; text-align:center; max-width:360px; line-height:1.55; margin:0; }
      .status { margin-top:14px; font-size:12px; color:#7983f5; font-weight:600; }
    </style></head>
    <body>
      <div class="spinner"></div>
      <h2>BizimDiscord v5.2.1 Başlatılıyor...</h2>
      <p>Sunucu uyku modundaysa uyanması 20-30 saniye sürebilir. Hazır olduğunda otomatik bağlanacak.</p>
      <div id="st" class="status">Sunucu kontrol ediliyor...</div>
    </body>
    </html>
    `;

    mainWin.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(wakeUpHTML));

    let tries = 0;
    let stopped = false;

    mainWin.on("closed", () => {
        stopped = true;
        if (overlayWin && !overlayWin.isDestroyed()) {
            overlayWin.destroy();
            overlayWin = null;
        }
        mainWin = null;
    });

    async function wakeAndLoadServer() {
        if (stopped || !mainWin || mainWin.isDestroyed()) return;
        tries++;
        mainWin.webContents
            .executeJavaScript(`document.getElementById("st") && (document.getElementById("st").textContent = "Bağlantı denemesi #${tries}...")`)
            .catch(() => { });

        try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 8000);
            const res = await net.fetch(SERVER_URL + "/health", {
                cache: "no-store",
                signal: controller.signal
            });
            clearTimeout(timer);

            if (res.ok && !stopped && mainWin && !mainWin.isDestroyed()) {
                mainWin.loadURL(SERVER_URL);
                return;
            }
        } catch { }

        if (!stopped) setTimeout(wakeAndLoadServer, 2000);
    }

    wakeAndLoadServer();

    if (perfConfig.overlay.enabled && !bootedWithoutGpu) {
        createOverlayWindow();
    }

    screen.on("display-metrics-changed", positionOverlayWindow);

    globalShortcut.register("Alt+M", () => {
        mainWin?.webContents.send("global-shortcut", "toggle-mute");
    });
    globalShortcut.register("Alt+D", () => {
        mainWin?.webContents.send("global-shortcut", "toggle-deafen");
    });
    globalShortcut.register("Alt+O", () => {
        mainWin?.webContents.send("global-shortcut", "toggle-overlay");
    });
}

app.whenReady().then(createWindow);
app.on("will-quit", () => globalShortcut.unregisterAll());
app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
});