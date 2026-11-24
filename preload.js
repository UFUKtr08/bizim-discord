const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
    isElectron: true,

    // Yerel Master Veritabanı (Belgelerim\BizimDiscord_DB\bizim_discord_db.json)
    dbSave: (dbData) => ipcRenderer.invoke("db-save", dbData),
    dbLoad: () => ipcRenderer.invoke("db-load"),
    dbPath: () => ipcRenderer.invoke("db-path"),

    // Görsel Pencere Seçicili Ekran Paylaşımı
    getScreenSources: () => ipcRenderer.invoke("get-screen-sources"),
    selectScreenSource: (opts) => ipcRenderer.invoke("select-screen-source", opts),

    // Performans / GPU & Yeniden Başlatma
    getGpuMode: () => ipcRenderer.invoke("get-gpu-mode"),
    setGpuMode: (disableGpu) => ipcRenderer.invoke("set-gpu-mode", disableGpu),
    getRuntimePerfInfo: () => ipcRenderer.invoke("get-runtime-perf-info"),
    relaunchApp: () => ipcRenderer.invoke("relaunch-app"),

    // Oyun İçi Saydam Overlay (Ana Pencere <-> Overlay Köprüsü)
    getOverlayConfig: () => ipcRenderer.invoke("get-overlay-config"),
    setOverlayConfig: (cfg) => ipcRenderer.invoke("set-overlay-config", cfg),
    updateOverlayState: (payload) => ipcRenderer.send("overlay-update-state", payload),
    onOverlayData: (cb) => {
        const handler = (_e, data) => cb(data);
        ipcRenderer.on("overlay-data", handler);
        return () => ipcRenderer.removeListener("overlay-data", handler);
    },
    onOverlayConfig: (cb) => {
        const handler = (_e, cfg) => cb(cfg);
        ipcRenderer.on("overlay-config", handler);
        return () => ipcRenderer.removeListener("overlay-config", handler);
    },

    // Global Kısayollar (Alt+M, Alt+D, Alt+O)
    onGlobalShortcut: (cb) => {
        const handler = (_e, action) => cb(action);
        ipcRenderer.on("global-shortcut", handler);
        return () => ipcRenderer.removeListener("global-shortcut", handler);
    }
});