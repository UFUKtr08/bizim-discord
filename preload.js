const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
    isElectron: true,
    dbSave: (dbData) => ipcRenderer.invoke("db-save", dbData),
    dbLoad: () => ipcRenderer.invoke("db-load"),
    dbPath: () => ipcRenderer.invoke("db-path"),
    getScreenSources: () => ipcRenderer.invoke("get-screen-sources"),
    selectScreenSource: (opts) => ipcRenderer.invoke("select-screen-source", opts),
    getGpuMode: () => ipcRenderer.invoke("get-gpu-mode"),
    setGpuMode: (disableGpu) => ipcRenderer.invoke("set-gpu-mode", disableGpu),
    onGlobalShortcut: (cb) => ipcRenderer.on("global-shortcut", (_e, action) => cb(action))
});