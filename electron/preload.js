const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("bridge", {
  getRuntimeInfo: () => ipcRenderer.invoke("GET_RUNTIME_INFO"),
  listSources: () => ipcRenderer.invoke("LIST_SOURCES"),
  screenshotSource: (id) => ipcRenderer.invoke("SCREENSHOT_SOURCE", id),
  openStickyNote: (text) => ipcRenderer.invoke("OPEN_STICKY_NOTE", { text }),
  onToggleCaptureShortcut: (callback) => {
    const handler = () => callback();
    ipcRenderer.on("TOGGLE_CAPTURE_SHORTCUT", handler);
    return () => ipcRenderer.removeListener("TOGGLE_CAPTURE_SHORTCUT", handler);
  },
});
