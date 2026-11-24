const { app, BrowserWindow, session, desktopCapturer } = require("electron");

// Arkadaşlarına .exe dağıtmadan önce burayı kendi Render/Cloudflare adresinle değiştir:
const SERVER_URL = process.env.SERVER_URL || "http://localhost:3000";

function createWindow() {
    const win = new BrowserWindow({
        width: 1150,
        height: 750,
        title: "BizimDiscord",
        autoHideMenuBar: true,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true
        }
    });

    // Electron içinde ekran paylaşımını (getDisplayMedia) aktif et
    session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
        const sources = await desktopCapturer.getSources({ types: ["screen", "window"] });
        // Varsayılan olarak ilk ana ekranı paylaşır
        callback({ video: sources[0] });
    });

    win.loadURL(SERVER_URL);
}

app.whenReady().then(createWindow);
app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
});