import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("bridge", {
  getRuntimeInfo: () => ipcRenderer.invoke("GET_RUNTIME_INFO"),
  listSources: () => ipcRenderer.invoke("LIST_SOURCES"),
  screenshotSource: (id: string) => ipcRenderer.invoke("SCREENSHOT_SOURCE", id),
  openStickyNote: (text: string) => ipcRenderer.invoke("OPEN_STICKY_NOTE", { text }),
  onToggleCaptureShortcut: (callback: () => void) => {
    const handler = () => callback();
    ipcRenderer.on("TOGGLE_CAPTURE_SHORTCUT", handler);
    return () => ipcRenderer.removeListener("TOGGLE_CAPTURE_SHORTCUT", handler);
  }
});

export {};
