const { app, BrowserWindow, session, desktopCapturer, ipcMain, shell } = require("electron");
const path = require("path");
const fs = require("fs");

// =========================================================================
// ALDIĞIN RENDER LİNKİNİ AŞAĞIDAKİ TIRNAK İÇİNE YAPIŞTIR (Sonunda / olmasın)
// Yerelde test ederken: "http://localhost:3000"
// =========================================================================
const SERVER_URL = process.env.SERVER_URL || "https://bizim-discord.onrender.com";

const DB_DIR = path.join(app.getPath("documents"), "BizimDiscord_DB");
const LOCAL_DB_PATH = path.join(DB_DIR, "bizim_discord_db.json");

let pendingScreenChoice = { sourceId: null, withAudio: false };

function ensureLocalDBDir() {
    if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
}

// --- PC YEREL VERİTABANI IPC ---
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

// --- GÖRSEL EKRAN / PENCERE SEÇİCİ IPC ---
ipcMain.handle("get-screen-sources", async () => {
    const sources = await desktopCapturer.getSources({
        types: ["screen", "window"],
        thumbnailSize: { width: 320, height: 180 }
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
    const win = new BrowserWindow({
        width: 1280,
        height: 820,
        minWidth: 960,
        minHeight: 640,
        title: "BizimDiscord",
        autoHideMenuBar: true,
        backgroundColor: "#1e1f22",
        webPreferences: {
            preload: path.join(__dirname, "preload.js"),
            nodeIntegration: false,
            contextIsolation: true
        }
    });

    // Her açılışta güncel arayüzü çekmek için önbelleği temizle
    session.defaultSession.clearCache();

    // Sohbetteki linklere tıklandığında sistemin varsayılan tarayıcısında aç
    win.webContents.setWindowOpenHandler(({ url }) => {
        if (url.startsWith("http://") || url.startsWith("https://")) {
            shell.openExternal(url);
        }
        return { action: "deny" };
    });

    // Seçilen pencere/ekranı ve isteğe bağlı Windows sistem sesini paylaş
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

    // Render uyandırma ekranı
    const wakeUpHTML = `
    <!DOCTYPE html>
    <html lang="tr">
    <head><meta charset="UTF-8"><style>
      body { background:#1e1f22; color:#dbdee1; font-family:'Segoe UI',system-ui,sans-serif; display:flex;
             flex-direction:column; align-items:center; justify-content:center; height:100vh; margin:0; }
      .spinner { width:46px; height:46px; border:4px solid #3f4147; border-top-color:#5865f2;
                 border-radius:50%; animation:spin 0.9s linear infinite; margin-bottom:20px; }
      @keyframes spin { to { transform: rotate(360deg); } }
      h2 { color:#fff; margin:0 0 8px; }
      p { color:#949ba4; font-size:14px; text-align:center; max-width:380px; line-height:1.5; }
      .status { margin-top:14px; font-size:12px; color:#5865f2; font-weight:600; }
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

    win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(wakeUpHTML));
}

app.whenReady().then(createWindow);
app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
});