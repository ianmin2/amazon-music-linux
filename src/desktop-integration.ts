/**
 * Desktop-environment capability probes.
 *
 * GNOME has shipped no system tray since 3.26. Electron's `Tray` only renders if
 * something implements the StatusNotifierItem host spec — on Ubuntu GNOME that
 * is the `ubuntu-appindicators` shell extension, which is installed but not
 * always enabled.
 *
 * Without this check, "hide to tray" hides the window into nothing: no window,
 * no icon, no way back except relaunching. So we ask D-Bus whether a tray host
 * actually exists and let the caller degrade gracefully.
 */

import { execFile } from "node:child_process";

const STATUS_NOTIFIER_WATCHER = "org.kde.StatusNotifierWatcher";
const PROBE_TIMEOUT_MS = 2000;

function run(command: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: PROBE_TIMEOUT_MS }, (error, stdout) => {
      resolve(error ? null : stdout);
    });
  });
}

/**
 * True if a StatusNotifierItem host is present, i.e. a tray icon would be
 * visible. Non-Linux platforms always have a real tray.
 *
 * Errs on the side of `true`: if we cannot probe (no `gdbus`, no `busctl`), we
 * assume the tray works rather than disabling a feature that may be fine.
 */
export async function hasSystemTray(): Promise<boolean> {
  if (process.platform !== "linux") {
    return true;
  }

  const gdbus = await run("gdbus", [
    "call",
    "--session",
    "--dest",
    "org.freedesktop.DBus",
    "--object-path",
    "/org/freedesktop/DBus",
    "--method",
    "org.freedesktop.DBus.NameHasOwner",
    STATUS_NOTIFIER_WATCHER,
  ]);
  if (gdbus !== null) {
    return gdbus.includes("true");
  }

  const busctl = await run("busctl", ["--user", "list", "--no-pager"]);
  if (busctl !== null) {
    return busctl.includes(STATUS_NOTIFIER_WATCHER);
  }

  return true;
}

/** Advice shown in the log and the settings window when no tray host is found. */
export const NO_TRAY_ADVICE =
  "No system tray was detected, so the tray icon will not appear and closing the " +
  "window will quit instead of hiding. On GNOME, enable the AppIndicator extension " +
  "to get a tray icon: gnome-extensions enable ubuntu-appindicators@ubuntu.com";
