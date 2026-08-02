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
import { hasSystemTray, NO_TRAY_ADVICE } from "./desktop-integration";
import {
  APP_NAME,
  isAllowedArtworkUrl,
  isAllowedNavigation,
  musicUrlForRegion,
  regionFromHost,
  regionFromLocale,
  REGIONS,
} from "./const";
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
/** False when no StatusNotifierItem host exists, i.e. a tray icon would be invisible. */
let trayAvailable = true;

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

// Pin the X11 WM_CLASS / Wayland app_id to the .desktop file's basename. Without
// this the window reports a name that does not match `StartupWMClass`, so docks
// and GNOME Shell cannot associate it with amazon-music-linux.desktop and fall
// back to a generic gear icon.
app.commandLine.appendSwitch("class", "amazon-music-linux");

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

  trayAvailable = await hasSystemTray();
  if (!trayAvailable) {
    console.warn(`[tray] ${NO_TRAY_ADVICE}`);
  }

  configureSession();
  hardenWebContents();
  buildApplicationMenu();
  createMainWindow(settings);
  if (trayAvailable) {
    createTray();
  }
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
  if (settings.region !== "auto") {
    return settings.region;
  }
  // Prefer where Amazon actually sent us over a guess from the system locale.
  return settings.learnedRegion || regionFromLocale(app.getLocale());
}

/**
 * Amazon redirects to the storefront that matches the *account*, not the system
 * locale. Remember that, so the next launch goes straight there instead of
 * bouncing through the wrong domain and re-running sign-in.
 */
function rememberStorefront(rawUrl: string): void {
  const settings = getSettings();
  if (settings.region !== "auto") {
    return;
  }
  let hostname: string;
  try {
    hostname = new URL(rawUrl).hostname;
  } catch {
    return;
  }
  const region = regionFromHost(hostname);
  if (region && region !== settings.learnedRegion) {
    console.log(`[region] Amazon served the "${region}" storefront; remembering it for next launch`);
    updateSettings({ learnedRegion: region });
  }
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
    // GNOME's default `button-layout` is `appmenu:close`, so the titlebar offers
    // no minimize or maximize button. Keep the menu bar visible so those actions
    // are always reachable; View → Toggle Menu Bar hides it again.
    autoHideMenuBar: false,
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

  mainWindow.webContents.on("did-navigate", (_event, url) => rememberStorefront(url));

  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    console.error("[window] renderer gone:", details.reason);
  });

  mainWindow.on("close", (event) => {
    // Only hide if there is somewhere visible to hide *to*. With no tray host
    // the window would vanish with no icon and no way back, which is how this
    // app previously became unkillable from the desktop.
    if (!isQuitting && getSettings().closeToTray && trayAvailable) {
      event.preventDefault();
      mainWindow?.hide();
      return;
    }
    isQuitting = true;
  });

  // Keeps the tray's Maximize/Restore label in step with the actual window state.
  mainWindow.on("maximize", refreshTrayMenu);
  mainWindow.on("unmaximize", refreshTrayMenu);

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

/** Menu actions apply to whichever window has focus, falling back to the player. */
function targetWindow(): BrowserWindow | null {
  return BrowserWindow.getFocusedWindow() ?? mainWindow;
}

function toggleMaximize(): void {
  const window = targetWindow();
  if (!window) {
    return;
  }
  if (window.isMaximized()) {
    window.unmaximize();
  } else {
    window.maximize();
  }
}

function toggleMenuBar(): void {
  const window = targetWindow();
  if (!window) {
    return;
  }
  const hidden = !window.isMenuBarVisible();
  window.setAutoHideMenuBar(!hidden);
  window.setMenuBarVisibility(hidden);
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
        { type: "separator" },
        { label: "Toggle Menu Bar", accelerator: "Ctrl+Shift+M", click: toggleMenuBar },
      ],
    },
    {
      label: "Window",
      submenu: [
        { label: "Minimize", accelerator: "CmdOrCtrl+M", click: () => targetWindow()?.minimize() },
        { label: "Maximize", click: () => targetWindow()?.maximize() },
        { label: "Restore", click: () => targetWindow()?.unmaximize() },
        { label: "Maximize/Restore", accelerator: "CmdOrCtrl+Shift+Up", click: toggleMaximize },
        { type: "separator" },
        { label: "Full Screen", accelerator: "F11", role: "togglefullscreen" },
        { type: "separator" },
        // Pointless — and a trap — when nothing can render a tray icon.
        { label: "Hide to Tray", click: () => mainWindow?.hide(), enabled: trayAvailable },
        { label: "Close Window", accelerator: "CmdOrCtrl+W", role: "close" },
        { type: "separator" },
        { label: "Quit", accelerator: "CmdOrCtrl+Q", click: quitApplication },
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
      {
        label: "Minimize",
        click: () => mainWindow?.minimize(),
        enabled: mainWindow !== null,
      },
      {
        label: mainWindow?.isMaximized() ? "Restore" : "Maximize",
        click: () => {
          showMainWindow();
          toggleMaximize();
        },
        enabled: mainWindow !== null,
      },
      { type: "separator" },
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
    trayAvailable,
    noTrayAdvice: NO_TRAY_ADVICE,
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
  // Cookies are written lazily; force them out before the process goes away.
  void session.defaultSession.cookies.flushStore();
});

/**
 * Without these, a `SIGTERM` (pkill, a logout, systemd) kills the process
 * outright. Chromium never runs its shutdown path, so localStorage/IndexedDB —
 * where Amazon Music keeps its session — are never committed, and the next
 * launch asks you to sign in again. Routing signals through `app.quit()` gives
 * Chromium the chance to flush.
 */
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => {
    console.log(`[lifecycle] received ${signal}, shutting down cleanly`);
    quitApplication();
  });
}

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  flushSettings();
  void companion.stop();
});
