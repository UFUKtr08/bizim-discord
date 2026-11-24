const { app, BrowserWindow, session, desktopCapturer, ipcMain, shell, globalShortcut } = require("electron");
const path = require("path");
const fs = require("fs");

// =========================================================================
// ALDIĞIN RENDER LİNKİNİ AŞAĞIDAKİ TIRNAK İÇİNE YAPIŞTIR (Sonunda / olmasın)
// =========================================================================
const SERVER_URL = process.env.SERVER_URL || "https://bizim-discord.onrender.com";

const PERF_CFG_PATH = path.join(app.getPath("userData"), "perf-config.json");
function readPerfConfig() {
    try {
        if (fs.existsSync(PERF_CFG_PATH)) return JSON.parse(fs.readFileSync(PERF_CFG_PATH, "utf8"));
    } catch { }
    return { disableGpu: true };
}

const perfConfig = readPerfConfig();
if (perfConfig.disableGpu) {
    app.disableHardwareAcceleration();
    app.commandLine.appendSwitch("disable-gpu-compositing");
}

app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");

const DB_DIR = path.join(app.getPath("documents"), "BizimDiscord_DB");
const LOCAL_DB_PATH = path.join(DB_DIR, "bizim_discord_db.json");

let mainWin = null;
let pendingScreenChoice = { sourceId: null, withAudio: false };

function ensureLocalDBDir() {
    if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
}

ipcMain.handle("get-gpu-mode", async () => perfConfig.disableGpu);
ipcMain.handle("set-gpu-mode", async (_event, disableGpu) => {
    fs.writeFileSync(PERF_CFG_PATH, JSON.stringify({ disableGpu: !!disableGpu }, null, 2), "utf8");
    app.relaunch();
    app.exit(0);
});

ipcMain.handle("db-save", async (_event, data) => {
    try {
        ensureLocalDBDir();
        fs.writeFileSync(LOCAL_DB_PATH, JSON.stringify(data, null, 2), "utf8");
        return { ok: true, path: LOCAL_DB_PATH };
    } catch (err) {
        return { ok: false, error: err.message };
    }
});

ipcMain.handle("db-load", async () => {
    try {
        if (!fs.existsSync(LOCAL_DB_PATH)) return null;
        return JSON.parse(fs.readFileSync(LOCAL_DB_PATH, "utf8"));
    } catch {
        return null;
    }
});

ipcMain.handle("db-path", async () => LOCAL_DB_PATH);

ipcMain.handle("get-screen-sources", async () => {
    const sources = await desktopCapturer.getSources({
        types: ["screen", "window"],
        thumbnailSize: { width: 280, height: 158 }
    });
    return sources.map((s) => ({
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

function createWindow() {
    mainWin = new BrowserWindow({
        width: 1280,
        height: 820,
        minWidth: 380,
        minHeight: 560,
        title: "BizimDiscord",
        autoHideMenuBar: true,
        backgroundColor: "#1e1f22",
        webPreferences: {
            preload: path.join(__dirname, "preload.js"),
            nodeIntegration: false,
            contextIsolation: true
        }
    });

    session.defaultSession.clearCache();

    // Kamera, mikrofon ve tam ekran izinlerini otomatik onayla
    session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
        const allowed = ["media", "mediaKeySystem", "fullscreen", "display-capture"];
        callback(allowed.includes(permission));
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
      body { background:#1e1f22; color:#dbdee1; font-family:'Segoe UI',system-ui,sans-serif; display:flex;
             flex-direction:column; align-items:center; justify-content:center; height:100vh; margin:0; }
      .spinner { width:44px; height:44px; border:4px solid #3f4147; border-top-color:#5865f2;
                 border-radius:50%; animation:spin 0.9s linear infinite; margin-bottom:18px; }
      @keyframes spin { to { transform: rotate(360deg); } }
      h2 { color:#fff; margin:0 0 8px; }
      p { color:#949ba4; font-size:14px; text-align:center; max-width:380px; line-height:1.5; }
      .status { margin-top:12px; font-size:12px; color:#5865f2; font-weight:600; }
    </style></head>
    <body>
      <div class="spinner"></div>
      <h2>BizimDiscord Başlatılıyor...</h2>
      <p>Sunucu uyku modundaysa uyanması 20-30 saniye sürebilir. Hazır olduğunda otomatik bağlanacak.</p>
      <div id="st" class="status">Sunucu kontrol ediliyor...</div>
      <script>
        const target = ${JSON.stringify(SERVER_URL)};
        let tries = 0;
        async function pingServer() {
          tries++;
          document.getElementById("st").textContent = "Bağlantı denemesi #" + tries + "...";
          try {
            const res = await fetch(target + "/health", { cache: "no-store" });
            if (res.ok) { location.href = target; return; }
          } catch {}
          setTimeout(pingServer, 2000);
        }
        pingServer();
      </script>
    </body>
    </html>
  `;

    mainWin.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(wakeUpHTML));

    globalShortcut.register("Alt+M", () => {
        mainWin?.webContents.send("global-shortcut", "toggle-mute");
    });
    globalShortcut.register("Alt+D", () => {
        mainWin?.webContents.send("global-shortcut", "toggle-deafen");
    });
}

app.whenReady().then(createWindow);
app.on("will-quit", () => globalShortcut.unregisterAll());
app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
});