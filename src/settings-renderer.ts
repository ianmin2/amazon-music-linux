/**
 * Settings window renderer.
 *
 * Loaded with a plain <script> tag, so this file must stay a global script — no
 * imports or exports, or TypeScript emits CommonJS wrappers that the browser
 * cannot execute. It talks to the main process only through the `settingsApi`
 * bridge installed by `preload-settings.ts`.
 */

interface SettingsPayload {
  settings: {
    region: string;
    closeToTray: boolean;
    globalMediaKeys: boolean;
    companionServer: { enabled: boolean; host: string; port: number; token: string };
  };
  regions: ReadonlyArray<{ id: string; label: string }>;
  resolvedRegion: string;
}

declare const settingsApi: {
  load(): Promise<SettingsPayload>;
  save(patch: unknown): Promise<{ settings: SettingsPayload["settings"]; resolvedRegion: string }>;
};

(() => {
  const byId = <T extends HTMLElement>(id: string): T => {
    const element = document.getElementById(id);
    if (!element) {
      throw new Error(`missing element #${id}`);
    }
    return element as T;
  };

  const regionSelect = byId<HTMLSelectElement>("region");
  const regionHint = byId<HTMLParagraphElement>("region-hint");
  const closeToTray = byId<HTMLInputElement>("close-to-tray");
  const globalMediaKeys = byId<HTMLInputElement>("global-media-keys");
  const serverEnabled = byId<HTMLInputElement>("server-enabled");
  const serverHost = byId<HTMLSelectElement>("server-host");
  const serverPort = byId<HTMLInputElement>("server-port");
  const serverToken = byId<HTMLInputElement>("server-token");
  const status = byId<HTMLParagraphElement>("status");

  let statusTimer: number | undefined;

  const flash = (message: string): void => {
    status.textContent = message;
    if (statusTimer !== undefined) {
      window.clearTimeout(statusTimer);
    }
    statusTimer = window.setTimeout(() => (status.textContent = ""), 1800);
  };

  const setServerControlsEnabled = (enabled: boolean): void => {
    serverHost.disabled = !enabled;
    serverPort.disabled = !enabled;
  };

  const render = (payload: SettingsPayload): void => {
    const { settings, regions, resolvedRegion } = payload;

    regionSelect.replaceChildren();
    const auto = document.createElement("option");
    auto.value = "auto";
    auto.textContent = "Detect from system locale";
    regionSelect.append(auto);
    for (const region of regions) {
      const option = document.createElement("option");
      option.value = region.id;
      option.textContent = region.label;
      regionSelect.append(option);
    }
    regionSelect.value = settings.region;
    regionHint.textContent = `Currently using music.amazon.${resolvedRegion}`;

    closeToTray.checked = settings.closeToTray;
    globalMediaKeys.checked = settings.globalMediaKeys;
    serverEnabled.checked = settings.companionServer.enabled;
    serverHost.value = settings.companionServer.host;
    serverPort.value = String(settings.companionServer.port);
    serverToken.value = settings.companionServer.token;
    setServerControlsEnabled(settings.companionServer.enabled);
  };

  const save = async (patch: unknown): Promise<void> => {
    try {
      const result = await settingsApi.save(patch);
      regionHint.textContent = `Currently using music.amazon.${result.resolvedRegion}`;
      // The main process re-validates and may clamp values, so mirror what it kept.
      serverPort.value = String(result.settings.companionServer.port);
      flash("Saved");
    } catch (error) {
      flash(`Could not save: ${String(error)}`);
    }
  };

  regionSelect.addEventListener("change", () => void save({ region: regionSelect.value }));
  closeToTray.addEventListener("change", () => void save({ closeToTray: closeToTray.checked }));
  globalMediaKeys.addEventListener("change", () => void save({ globalMediaKeys: globalMediaKeys.checked }));

  serverEnabled.addEventListener("change", () => {
    setServerControlsEnabled(serverEnabled.checked);
    void save({ companionServer: { enabled: serverEnabled.checked } });
  });
  serverHost.addEventListener("change", () => void save({ companionServer: { host: serverHost.value } }));
  serverPort.addEventListener("change", () =>
    void save({ companionServer: { port: Number(serverPort.value) } }),
  );

  serverToken.addEventListener("focus", () => serverToken.select());

  settingsApi
    .load()
    .then(render)
    .catch((error: unknown) => flash(`Could not load settings: ${String(error)}`));
})();
