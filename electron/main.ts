import electron from "electron";
import type { BrowserWindow as ElectronBrowserWindow } from "electron";
import path from "path";
import url from "url";

const { app, BrowserWindow, desktopCapturer, dialog, globalShortcut, ipcMain } = electron;

type StartedBackend = {
  port: number;
  close: () => Promise<void>;
};

const TOGGLE_CAPTURE_SHORTCUT_CHANNEL = "TOGGLE_CAPTURE_SHORTCUT";
const GLOBAL_CAPTURE_SHORTCUT = "CommandOrControl+Alt+A";

let mainWindow: ElectronBrowserWindow | null = null;
const stickyWindows = new Set<ElectronBrowserWindow>();

const isDev = !app.isPackaged && process.env.NODE_ENV !== "production";
let serverBaseUrl = process.env.SERVER_BASE_URL || (isDev ? "http://localhost:8787" : "http://127.0.0.1:8787");
let embeddedBackend: StartedBackend | null = null;

function getPreloadPath(): string {
  if (isDev) {
    return path.join(__dirname, "preload.js");
  }
  return path.join(app.getAppPath(), "electron", "preload.js");
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function stickyNoteHtml(messageText: string): string {
  const content = escapeHtml(messageText || "(empty message)");
  return `
<!doctype html>
<html>
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Sticky Note</title>
    <style>
      :root { color-scheme: dark; }
      * { box-sizing: border-box; }
      html, body {
        margin: 0;
        width: 100%;
        height: 100%;
        background: #101010;
        color: #eaeaea;
        font-family: "Segoe UI", Roboto, Arial, sans-serif;
      }
      .wrap {
        height: 100%;
        padding: 12px;
        background: #111;
        border: 1px solid #242424;
        box-shadow: 0 10px 28px rgba(0, 0, 0, 0.35);
        display: flex;
        flex-direction: column;
        gap: 10px;
      }
      .top {
        display: flex;
        justify-content: space-between;
        align-items: center;
      }
      .title {
        font-size: 12px;
        color: #b9b9b9;
        letter-spacing: 0.2px;
      }
      .close {
        border: 1px solid #2c2c2c;
        background: #0f0f0f;
        color: #dedede;
        border-radius: 8px;
        width: 28px;
        height: 24px;
        cursor: pointer;
      }
      .close:hover { background: #1a1a1a; }
      .body {
        flex: 1;
        overflow: auto;
        border: 1px solid #232323;
        border-radius: 10px;
        background: #0d0d0d;
        padding: 12px;
        white-space: pre-wrap;
        line-height: 1.4;
        font-size: 14px;
      }
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="top">
        <div class="title">Assistant Sticky Note</div>
        <button class="close" id="closeBtn" title="Close">X</button>
      </div>
      <div class="body">${content}</div>
    </div>
    <script>
      const btn = document.getElementById("closeBtn");
      if (btn) btn.addEventListener("click", () => window.close());
    </script>
  </body>
</html>
  `.trim();
}

async function startEmbeddedBackendIfNeeded(): Promise<void> {
  if (isDev) {
    serverBaseUrl = process.env.SERVER_BASE_URL || "http://localhost:8787";
    return;
  }

  const serverModulePath = path.join(__dirname, "../dist-server/index.js");
  const mod = require(serverModulePath) as {
    startServer: (options?: { port?: number; preferRandomPortOnBusy?: boolean }) => Promise<StartedBackend>;
  };

  const requestedPort = Number(process.env.PORT || 8787);
  embeddedBackend = await mod.startServer({
    port: requestedPort,
    preferRandomPortOnBusy: true
  });

  serverBaseUrl = `http://127.0.0.1:${embeddedBackend.port}`;
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    backgroundColor: "#0b0b0b",
    webPreferences: {
      preload: getPreloadPath(),
      contextIsolation: true
    }
  });

  if (isDev) {
    mainWindow.loadURL("http://localhost:5173");
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    mainWindow.loadURL(
      url.format({
        pathname: path.join(__dirname, "../dist/index.html"),
        protocol: "file:",
        slashes: true
      })
    );
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function createStickyWindow(messageText: string) {
  const popup = new BrowserWindow({
    width: 380,
    height: 280,
    minWidth: 300,
    minHeight: 220,
    show: false,
    alwaysOnTop: true,
    resizable: true,
    minimizable: false,
    maximizable: false,
    backgroundColor: "#101010"
  });

  stickyWindows.add(popup);
  popup.on("closed", () => {
    stickyWindows.delete(popup);
  });

  popup.once("ready-to-show", () => popup.show());
  popup.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(stickyNoteHtml(messageText))}`);
}

function registerGlobalShortcuts() {
  const ok = globalShortcut.register(GLOBAL_CAPTURE_SHORTCUT, () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send(TOGGLE_CAPTURE_SHORTCUT_CHANNEL);
  });

  if (!ok) {
    console.error(`Failed to register global shortcut: ${GLOBAL_CAPTURE_SHORTCUT}`);
  }
}

app.whenReady().then(async () => {
  try {
    await startEmbeddedBackendIfNeeded();
  } catch (err: any) {
    dialog.showErrorBox(
      "Failed to start local backend",
      `The app could not start its local API server.\n\n${err?.message || String(err)}`
    );
    app.quit();
    return;
  }

  createMainWindow();
  registerGlobalShortcuts();
});

app.on("activate", () => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createMainWindow();
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  for (const popup of stickyWindows) {
    if (!popup.isDestroyed()) popup.close();
  }
  stickyWindows.clear();

  if (embeddedBackend) {
    void embeddedBackend.close().catch(() => {});
    embeddedBackend = null;
  }
});

ipcMain.handle("GET_RUNTIME_INFO", async () => {
  return {
    serverBaseUrl,
    isDev,
    appVersion: app.getVersion()
  };
});

ipcMain.handle("LIST_SOURCES", async () => {
  const sources = await desktopCapturer.getSources({
    types: ["window", "screen"],
    thumbnailSize: { width: 340, height: 220 },
    fetchWindowIcons: true
  });

  return sources.map((s) => ({
    id: s.id,
    name: s.name,
    thumb: s.thumbnail.toDataURL()
  }));
});

ipcMain.handle("SCREENSHOT_SOURCE", async (_evt, sourceId: string) => {
  const sources = await desktopCapturer.getSources({
    types: ["window", "screen"],
    thumbnailSize: { width: 960, height: 540 }
  });

  const src = sources.find((s) => s.id === sourceId);
  if (!src) throw new Error("Source not found");

  return src.thumbnail.toPNG();
});

ipcMain.handle("OPEN_STICKY_NOTE", async (_evt, payload: { text?: string }) => {
  const text = String(payload?.text || "");
  const clipped = text.length > 200000 ? `${text.slice(0, 200000)}\n\n...[truncated]` : text;
  createStickyWindow(clipped);
  return { ok: true };
});
