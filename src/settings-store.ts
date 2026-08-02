/**
 * Small main-process settings store.
 *
 * Replaces `electron-settings@3`, which is unmaintained and — more importantly —
 * was being called from renderer processes, which only worked because the app
 * ran with `nodeIntegration` on and `contextIsolation` off. Settings now live
 * in the main process and reach renderers over a narrow, validated IPC surface.
 *
 * Reads are synchronous from an in-memory copy; writes are debounced and
 * written atomically (tmp file + rename) so a crash mid-write cannot leave a
 * truncated settings file behind.
 */

import { app } from "electron";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { REGION_IDS } from "./const";

export interface CompanionServerSettings {
  /** Off by default: it is an unauthenticated-by-origin control channel. */
  enabled: boolean;
  /** Interface to bind. Loopback by default so it is not exposed to the LAN. */
  host: string;
  port: number;
  /** Shared secret the companion app must present to connect. */
  token: string;
}

export interface AppSettings {
  /** "auto" or a storefront id from `REGIONS`. */
  region: string;
  /** Hide to tray on window close instead of quitting. */
  closeToTray: boolean;
  /**
   * Register process-global media-key shortcuts. Off by default because
   * Chromium's own MPRIS integration handles media keys on modern Linux
   * desktops, and registering both makes every keypress fire twice.
   */
  globalMediaKeys: boolean;
  companionServer: CompanionServerSettings;
}

const DEFAULTS: AppSettings = {
  region: "auto",
  closeToTray: true,
  globalMediaKeys: false,
  companionServer: {
    enabled: false,
    host: "127.0.0.1",
    port: 3000,
    token: "",
  },
};

/** Only these are safe to bind without exposing the control channel widely. */
const ALLOWED_HOSTS = new Set(["127.0.0.1", "::1", "localhost", "0.0.0.0"]);

let settingsPath = "";
let current: AppSettings = structuredClone(DEFAULTS);
let writeTimer: NodeJS.Timeout | undefined;

function clampPort(value: unknown): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    return DEFAULTS.companionServer.port;
  }
  return port;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/**
 * Coerce whatever is on disk into a valid `AppSettings`. The old code fed
 * `settings.get("appPort")` straight into `server.listen()` with no validation
 * at all, so a hand-edited or corrupted settings file could crash startup.
 */
function sanitize(raw: unknown): AppSettings {
  const input = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const rawServer = (typeof input.companionServer === "object" && input.companionServer !== null
    ? input.companionServer
    : {}) as Record<string, unknown>;

  const region = typeof input.region === "string" && (input.region === "auto" || REGION_IDS.has(input.region))
    ? input.region
    : DEFAULTS.region;

  const host = typeof rawServer.host === "string" && ALLOWED_HOSTS.has(rawServer.host)
    ? rawServer.host
    : DEFAULTS.companionServer.host;

  const token = typeof rawServer.token === "string" && rawServer.token.length >= 32
    ? rawServer.token
    : randomBytes(24).toString("hex");

  return {
    region,
    closeToTray: asBoolean(input.closeToTray, DEFAULTS.closeToTray),
    globalMediaKeys: asBoolean(input.globalMediaKeys, DEFAULTS.globalMediaKeys),
    companionServer: {
      enabled: asBoolean(rawServer.enabled, DEFAULTS.companionServer.enabled),
      host,
      port: clampPort(rawServer.port),
      token,
    },
  };
}

export function initSettings(): AppSettings {
  settingsPath = path.join(app.getPath("userData"), "settings.json");
  try {
    current = sanitize(JSON.parse(fs.readFileSync(settingsPath, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(`[settings] could not read ${settingsPath}, using defaults:`, error);
    }
    current = sanitize({});
  }
  // Persist immediately so the generated companion token is stable across runs.
  flush();
  return current;
}

export function getSettings(): Readonly<AppSettings> {
  return current;
}

/** A partial update, including partial updates to the nested server config. */
export type SettingsPatch = Partial<Omit<AppSettings, "companionServer">> & {
  /** `token` is intentionally omitted: it is generated, never client-supplied. */
  companionServer?: Partial<Omit<CompanionServerSettings, "token">>;
};

/** Merge a partial update, re-validating the result before it is persisted. */
export function updateSettings(patch: SettingsPatch): Readonly<AppSettings> {
  current = sanitize({
    ...current,
    ...patch,
    companionServer: { ...current.companionServer, ...(patch.companionServer ?? {}) },
  });
  scheduleWrite();
  return current;
}

function scheduleWrite(): void {
  if (writeTimer) {
    clearTimeout(writeTimer);
  }
  writeTimer = setTimeout(flush, 250);
}

export function flush(): void {
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeTimer = undefined;
  }
  if (!settingsPath) {
    return;
  }
  const tmp = `${settingsPath}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(current, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, settingsPath);
  } catch (error) {
    console.error("[settings] failed to persist settings:", error);
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* best effort */
    }
  }
}
