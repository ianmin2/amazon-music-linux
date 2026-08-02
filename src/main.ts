/**
 * Main process.
 *
 * Notable departures from the version this replaces:
 *
 *   - Widevine comes from castLabs' component updater (`components.whenReady()`)
 *     instead of a hand-bundled `libwidevinecdm.so` pinned to 4.10.1610.0, which
 *     Amazon's licence server has long since stopped accepting.
 *   - The Amazon Music page is loaded directly in a context-isolated, sandboxed
 *     window rather than inside a `<webview>` hosted by a `nodeIntegration: true`,
 *     `webSecurity: false` renderer.
 *   - Top-level navigation is confined to Amazon hosts; everything else opens in
 *     the system browser.
 *   - Every IPC handler checks which WebContents actually sent the message.
 */

import {
  app,
  BrowserWindow,
  components,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  net,
  session,
  shell,
  Tray,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions,
  type NativeImage,
} from "electron";
import * as path from "node:path";

import { CompanionServer, type CompanionCommand } from "./companion-server";
import { APP_NAME, isAllowedArtworkUrl, isAllowedNavigation, musicUrlForRegion, regionFromLocale, REGIONS } from "./const";
import {
  flush as flushSettings,
  getSettings,
  initSettings,
  updateSettings,
  type AppSettings,
  type SettingsPatch,
} from "./settings-store";

type ControlAction = "playPause" | "play" | "pause" | "next" | "previous";

interface TrackInfo {
  title: string;
  artist: string;
  album: string;
  artwork: string | null;
}

const ICON_PATH = path.join(__dirname, "assets", "favicon.png");
const MUSIC_PRELOAD = path.join(__dirname, "preload-music.js");
const SETTINGS_PRELOAD = path.join(__dirname, "preload-settings.js");
const SETTINGS_PAGE = path.join(__dirname, "settings.html");

/** Artwork is small; anything larger is not album art and is not worth fetching. */
const MAX_ARTWORK_BYTES = 4 * 1024 * 1024;

let mainWindow: BrowserWindow | null = null;
let settingsWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let trayBaseImage: NativeImage | null = null;
let isQuitting = false;

let currentTrack: TrackInfo | null = null;
let isPlaying = false;
let lastArtworkUrl: string | null = null;

const companion = new CompanionServer();

/* ------------------------------------------------------------------ *
 * Command-line switches — must be set before `ready`.
 * ------------------------------------------------------------------ */

// Let Chromium own the media keys. On Linux this also publishes an MPRIS
// interface, which is what makes the GNOME/KDE "now playing" widget and media
// keys work under Wayland, where `globalShortcut` is a no-op.
app.commandLine.appendSwitch("enable-features", "HardwareMediaKeyHandling,MediaSessionService");

/* ------------------------------------------------------------------ *
 * Single instance
 * ------------------------------------------------------------------ */

// The previous code called `requestSingleInstanceLock()` and threw the result
// away, so the lock was never actually enforced and a second launch produced a
// second player.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => showMainWindow());
  void bootstrap();
}

async function bootstrap(): Promise<void> {
  await app.whenReady();

  const settings = initSettings();

  try {
    await components.whenReady();
    console.log("[widevine] components ready:", JSON.stringify(components.status()));
  } catch (error) {
    // Playback of anything DRM-protected will fail, but the UI should still come
    // up so the user can see why.
    console.error("[widevine] component installation failed — playback will not work:", error);
  }

  configureSession();
  hardenWebContents();
  buildApplicationMenu();
  createMainWindow(settings);
  createTray();
  applyGlobalShortcuts(settings);
  await restartCompanionServer(settings);
}

/* ------------------------------------------------------------------ *
 * Session hardening
 * ------------------------------------------------------------------ */

function chromeUserAgent(): string {
  // Amazon serves a degraded experience to user agents it does not recognise, and
  // the default string advertises both Electron and the app name.
  return (
    `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) ` +
    `Chrome/${process.versions.chrome.split(".")[0]}.0.0.0 Safari/537.36`
  );
}

function configureSession(): void {
  const defaultSession = session.defaultSession;

  app.userAgentFallback = chromeUserAgent();
  defaultSession.setUserAgent(chromeUserAgent());

  const allowedPermissions = new Set([
    "protectedMediaIdentifier",
    "fullscreen",
    "clipboard-sanitized-write",
    "background-sync",
  ]);

  // Default-deny. The old build granted whatever the page asked for.
  defaultSession.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(allowedPermissions.has(permission));
  });
  defaultSession.setPermissionCheckHandler((_contents, permission) => allowedPermissions.has(permission));
}

/** Applies to every WebContents the app ever creates, including popups. */
function hardenWebContents(): void {
  app.on("web-contents-created", (_event, contents) => {
    contents.on("will-navigate", (event, url) => {
      if (!isAllowedNavigation(url)) {
        event.preventDefault();
        void shell.openExternal(url);
      }
    });

    contents.setWindowOpenHandler(({ url }) => {
      // Keep Amazon's own popups (sign-in, device auth) in-app; send the rest to
      // the system browser rather than opening a second Electron window.
      if (isAllowedNavigation(url)) {
        return {
          action: "allow",
          overrideBrowserWindowOptions: {
            webPreferences: {
              preload: MUSIC_PRELOAD,
              contextIsolation: true,
              nodeIntegration: false,
              sandbox: true,
            },
          },
        };
      }
      void shell.openExternal(url);
      return { action: "deny" };
    });

    // `webviewTag` is off everywhere, but deny attachment defensively in case a
    // future window enables it.
    contents.on("will-attach-webview", (event) => event.preventDefault());
  });
}

/* ------------------------------------------------------------------ *
 * Windows
 * ------------------------------------------------------------------ */

function resolvedRegion(settings: Readonly<AppSettings>): string {
  return settings.region === "auto" ? regionFromLocale(app.getLocale()) : settings.region;
}

function createMainWindow(settings: Readonly<AppSettings>): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 800,
    minHeight: 600,
    title: APP_NAME,
    icon: ICON_PATH,
    backgroundColor: "#15161a",
    autoHideMenuBar: true,
    webPreferences: {
      preload: MUSIC_PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      sandbox: true,
      webviewTag: false,
      // Was `false`, which disabled the same-origin policy for a window that also
      // had Node integration — an XSS anywhere in the page meant local code
      // execution.
      webSecurity: true,
    },
  });

  void mainWindow.loadURL(musicUrlForRegion(resolvedRegion(settings)));

  mainWindow.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (isMainFrame && errorCode !== -3 /* ERR_ABORTED */) {
      console.error(`[window] failed to load ${validatedURL}: ${errorDescription} (${errorCode})`);
    }
  });

  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    console.error("[window] renderer gone:", details.reason);
  });

  mainWindow.on("close", (event) => {
    if (!isQuitting && getSettings().closeToTray) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function showMainWindow(): void {
  if (!mainWindow) {
    createMainWindow(getSettings());
    return;
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.show();
  mainWindow.focus();
}

function toggleMainWindow(): void {
  if (mainWindow?.isVisible()) {
    mainWindow.hide();
  } else {
    showMainWindow();
  }
}

function openSettingsWindow(): void {
  if (settingsWindow) {
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }
  settingsWindow = new BrowserWindow({
    width: 560,
    height: 620,
    title: `${APP_NAME} — Settings`,
    icon: ICON_PATH,
    parent: mainWindow ?? undefined,
    autoHideMenuBar: true,
    backgroundColor: "#15161a",
    webPreferences: {
      preload: SETTINGS_PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  settingsWindow.setMenu(null);
  void settingsWindow.loadFile(SETTINGS_PAGE);
  settingsWindow.on("closed", () => {
    settingsWindow = null;
  });
}

function buildApplicationMenu(): void {
  // `setMenu(null)` cost the app clipboard, zoom and reload accelerators. The
  // menu bar is auto-hidden, so it stays out of the way but the keys work.
  const template: MenuItemConstructorOptions[] = [
    {
      label: "File",
      submenu: [
        { label: "Settings", click: openSettingsWindow },
        { type: "separator" },
        { label: "Quit", accelerator: "CmdOrCtrl+Q", click: quitApplication },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
        { role: "toggleDevTools" },
      ],
    },
    {
      label: "Playback",
      submenu: [
        { label: "Play/Pause", click: () => sendControl("playPause") },
        { label: "Next Track", click: () => sendControl("next") },
        { label: "Previous Track", click: () => sendControl("previous") },
        { type: "separator" },
        { label: "Dump Player Diagnostics to Log", click: requestDiagnostics },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ------------------------------------------------------------------ *
 * Tray
 * ------------------------------------------------------------------ */

function createTray(): void {
  trayBaseImage = nativeImage.createFromPath(ICON_PATH);
  tray = new Tray(trayBaseImage.isEmpty() ? nativeImage.createEmpty() : trayBaseImage.resize({ width: 22, height: 22 }));
  tray.setToolTip(APP_NAME);
  tray.on("click", toggleMainWindow);
  refreshTrayMenu();
}

function refreshTrayMenu(): void {
  if (!tray) {
    return;
  }
  const nowPlaying = currentTrack
    ? `${currentTrack.title}${currentTrack.artist ? ` — ${currentTrack.artist}` : ""}`
    : "Nothing playing";

  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: nowPlaying.slice(0, 96), enabled: false },
      { type: "separator" },
      { label: "Show/Hide Window", click: toggleMainWindow },
      { label: isPlaying ? "Pause" : "Play", click: () => sendControl("playPause") },
      { label: "Next Track", click: () => sendControl("next") },
      { label: "Previous Track", click: () => sendControl("previous") },
      { type: "separator" },
      { label: "Settings", click: openSettingsWindow },
      { label: "Quit", click: quitApplication },
    ]),
  );
  tray.setToolTip(currentTrack ? `${APP_NAME} — ${nowPlaying}`.slice(0, 128) : APP_NAME);
}

async function updateTrayArtwork(url: string | null): Promise<void> {
  if (!tray) {
    return;
  }
  if (!url) {
    lastArtworkUrl = null;
    if (trayBaseImage && !trayBaseImage.isEmpty()) {
      tray.setImage(trayBaseImage.resize({ width: 22, height: 22 }));
    }
    return;
  }
  if (url === lastArtworkUrl) {
    return;
  }
  // The old code fetched whatever URL the page handed it, with no scheme or host
  // check, using the long-deprecated `request` package.
  if (!isAllowedArtworkUrl(url)) {
    console.warn(`[tray] refusing to fetch artwork from disallowed URL: ${url}`);
    return;
  }
  lastArtworkUrl = url;
  try {
    const response = await net.fetch(url);
    if (!response.ok) {
      return;
    }
    const length = Number(response.headers.get("content-length") ?? 0);
    if (length > MAX_ARTWORK_BYTES) {
      return;
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > MAX_ARTWORK_BYTES) {
      return;
    }
    const image = nativeImage.createFromBuffer(buffer);
    if (!image.isEmpty() && url === lastArtworkUrl) {
      tray.setImage(image.resize({ width: 22, height: 22 }));
    }
  } catch (error) {
    console.warn("[tray] artwork fetch failed:", error);
  }
}

/* ------------------------------------------------------------------ *
 * Playback control
 * ------------------------------------------------------------------ */

function sendControl(action: ControlAction): void {
  mainWindow?.webContents.send("control", action);
}

function requestDiagnostics(): void {
  mainWindow?.webContents.send("collect-diagnostics");
}

function applyGlobalShortcuts(settings: Readonly<AppSettings>): void {
  globalShortcut.unregisterAll();
  if (!settings.globalMediaKeys) {
    return;
  }
  const bindings: Array<[string, ControlAction]> = [
    ["MediaPlayPause", "playPause"],
    ["MediaNextTrack", "next"],
    ["MediaPreviousTrack", "previous"],
    ["MediaStop", "pause"],
  ];
  for (const [accelerator, action] of bindings) {
    if (!globalShortcut.register(accelerator, () => sendControl(action))) {
      console.warn(`[shortcuts] could not register ${accelerator}`);
    }
  }
}

/* ------------------------------------------------------------------ *
 * IPC — every handler verifies the sender
 * ------------------------------------------------------------------ */

function isFromMusicWindow(event: IpcMainEvent): boolean {
  return mainWindow !== null && event.sender.id === mainWindow.webContents.id;
}

function isFromSettingsWindow(event: IpcMainInvokeEvent): boolean {
  return settingsWindow !== null && event.sender.id === settingsWindow.webContents.id;
}

ipcMain.on("media:track", (event, track: TrackInfo | null) => {
  if (!isFromMusicWindow(event)) {
    return;
  }
  currentTrack = track;
  mainWindow?.setTitle(track ? `${track.title} — ${track.artist} · ${APP_NAME}` : APP_NAME);
  refreshTrayMenu();
  companion.setTrack(track);
  void updateTrayArtwork(track?.artwork ?? null);
});

ipcMain.on("media:playback-state", (event, state: string) => {
  if (!isFromMusicWindow(event)) {
    return;
  }
  isPlaying = state === "playing";
  refreshTrayMenu();
  companion.setPlaying(isPlaying);
});

ipcMain.on("media:log", (event, message: string) => {
  if (isFromMusicWindow(event)) {
    console.log("[player]", String(message).slice(0, 500));
  }
});

ipcMain.on("media:diagnostics", (event, payload: unknown) => {
  if (isFromMusicWindow(event)) {
    console.log("[player diagnostics]", JSON.stringify(payload, null, 2));
  }
});

/**
 * Whitelist the fields a renderer may change. In particular the companion token
 * is generated in the main process and must never be settable from a page.
 */
function sanitizePatch(patch: unknown): SettingsPatch {
  const input = (typeof patch === "object" && patch !== null ? patch : {}) as Record<string, unknown>;
  const rawServer = (typeof input.companionServer === "object" && input.companionServer !== null
    ? input.companionServer
    : {}) as Record<string, unknown>;

  const result: SettingsPatch = {};
  if (typeof input.region === "string") {
    result.region = input.region;
  }
  if (typeof input.closeToTray === "boolean") {
    result.closeToTray = input.closeToTray;
  }
  if (typeof input.globalMediaKeys === "boolean") {
    result.globalMediaKeys = input.globalMediaKeys;
  }

  const server: NonNullable<SettingsPatch["companionServer"]> = {};
  if (typeof rawServer.enabled === "boolean") {
    server.enabled = rawServer.enabled;
  }
  if (typeof rawServer.host === "string") {
    server.host = rawServer.host;
  }
  if (typeof rawServer.port === "number") {
    server.port = rawServer.port;
  }
  if (Object.keys(server).length > 0) {
    result.companionServer = server;
  }
  return result;
}

ipcMain.handle("settings:get", (event) => {
  if (!isFromSettingsWindow(event)) {
    throw new Error("unauthorized");
  }
  const settings = getSettings();
  return {
    settings,
    regions: REGIONS,
    resolvedRegion: resolvedRegion(settings),
  };
});

ipcMain.handle("settings:set", async (event, patch: SettingsPatch) => {
  if (!isFromSettingsWindow(event)) {
    throw new Error("unauthorized");
  }
  const before = getSettings();
  const previousRegion = resolvedRegion(before);
  const previousServer = { ...before.companionServer };

  const after = updateSettings(sanitizePatch(patch));

  if (resolvedRegion(after) !== previousRegion) {
    void mainWindow?.loadURL(musicUrlForRegion(resolvedRegion(after)));
  }
  if (
    after.companionServer.enabled !== previousServer.enabled ||
    after.companionServer.host !== previousServer.host ||
    after.companionServer.port !== previousServer.port
  ) {
    await restartCompanionServer(after);
  }
  applyGlobalShortcuts(after);

  return { settings: after, resolvedRegion: resolvedRegion(after) };
});

/* ------------------------------------------------------------------ *
 * Companion server
 * ------------------------------------------------------------------ */

async function restartCompanionServer(settings: Readonly<AppSettings>): Promise<void> {
  await companion.start(settings.companionServer, {
    onCommand: (command: CompanionCommand) => sendControl(command),
    onClientConnected: () => {
      companion.setTrack(currentTrack);
      companion.setPlaying(isPlaying);
    },
  });
}

/* ------------------------------------------------------------------ *
 * Lifecycle
 * ------------------------------------------------------------------ */

function quitApplication(): void {
  isQuitting = true;
  app.quit();
}

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createMainWindow(getSettings());
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    quitApplication();
  }
});

app.on("before-quit", () => {
  isQuitting = true;
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  flushSettings();
  void companion.stop();
});
