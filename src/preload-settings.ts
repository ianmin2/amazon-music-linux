/**
 * Preload for the settings window.
 *
 * Exposes a deliberately narrow API over `contextBridge`. The settings page used
 * to run with full Node integration and pulled Bootstrap, jQuery and Popper from
 * three different CDNs — any one of which could have executed arbitrary code
 * with the user's privileges, and all of which broke the page when offline.
 */

import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("settingsApi", {
  load: () => ipcRenderer.invoke("settings:get"),
  save: (patch: unknown) => ipcRenderer.invoke("settings:set", patch),
});
