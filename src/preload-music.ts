/**
 * Preload for the Amazon Music page.
 *
 * Runs in an isolated world with `contextIsolation: true` and `sandbox: true`,
 * so it shares the DOM with the page but not its JavaScript globals, and it
 * deliberately exposes *nothing* back to the page via `contextBridge`.
 *
 * The version this replaces assigned `__am = { ipcRenderer: require("electron").ipcRenderer }`
 * onto the shared window object, which handed amazon.com — and anything injected
 * into it — a direct line to the main process.
 *
 * Track metadata is read from the Media Session API, which Amazon Music
 * populates and which survives UI redesigns. DOM scraping is only a fallback:
 * every selector in the old `inject.js` (`trackTitle`, `playButton`,
 * `nowPlayingLyricsContainer`, …) belongs to a player UI that no longer exists.
 *
 * NOTE: sandboxed preloads cannot resolve relative `require`s, so this file must
 * not import anything from the rest of the project.
 */

import { ipcRenderer } from "electron";

type PlaybackState = "playing" | "paused" | "stopped";

interface TrackInfo {
  title: string;
  artist: string;
  album: string;
  artwork: string | null;
}

type ControlAction = "playPause" | "play" | "pause" | "next" | "previous";

const POLL_INTERVAL_MS = 1000;

let lastSerializedTrack = "";
let lastPlaybackState: PlaybackState | "" = "";

/* ------------------------------------------------------------------ *
 * DOM traversal
 * ------------------------------------------------------------------ */

/**
 * Amazon Music is built from `music-*` web components, so most controls live
 * inside shadow roots and are invisible to a plain `document.querySelector`.
 */
function* walkElements(root: Document | ShadowRoot): Generator<Element> {
  const stack: Array<Document | ShadowRoot | Element> = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    for (const child of Array.from(node.children)) {
      yield child;
      stack.push(child);
      if (child.shadowRoot) {
        stack.push(child.shadowRoot);
      }
    }
  }
}

function findMediaElement(): HTMLMediaElement | null {
  for (const element of walkElements(document)) {
    if (element instanceof HTMLMediaElement && element.src !== "") {
      return element;
    }
  }
  // MSE-backed players often have no `src`; fall back to any media element.
  for (const element of walkElements(document)) {
    if (element instanceof HTMLMediaElement) {
      return element;
    }
  }
  return null;
}

/** Text we can use to identify a control, lowercased. */
function controlLabels(element: Element): string[] {
  const attributes = ["aria-label", "title", "data-key", "icon-name", "name", "aria-labelledby"];
  const values = attributes
    .map((attribute) => element.getAttribute(attribute))
    .filter((value): value is string => typeof value === "string");
  values.push(element.className?.toString?.() ?? "");
  return values.map((value) => value.toLowerCase());
}

const CONTROL_PATTERNS: Record<Exclude<ControlAction, "playPause">, RegExp> = {
  play: /(^|[^a-z])(play|abspielen|lecture|reproducir|riproduci|tocar|afspelen)([^a-z]|$)/,
  pause: /(^|[^a-z])(pause|pausa|pausieren|pauzeren)([^a-z]|$)/,
  next: /(next|skip.?forward|forward|vor|suivant|siguiente|successivo|próxima|volgende)/,
  previous: /(prev|previous|skip.?back|back|zurück|précédent|anterior|precedente|vorige)/,
};

function isClickable(element: Element): boolean {
  if (element instanceof HTMLButtonElement) {
    return true;
  }
  const tag = element.tagName.toLowerCase();
  return tag === "music-button" || element.getAttribute("role") === "button";
}

function findControl(kind: Exclude<ControlAction, "playPause">): Element | null {
  const pattern = CONTROL_PATTERNS[kind];
  for (const element of walkElements(document)) {
    if (!isClickable(element)) {
      continue;
    }
    if (controlLabels(element).some((label) => pattern.test(label))) {
      return element;
    }
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Metadata
 * ------------------------------------------------------------------ */

function largestArtwork(artwork: readonly MediaImage[] | undefined): string | null {
  if (!artwork || artwork.length === 0) {
    return null;
  }
  const area = (entry: MediaImage): number => {
    const [width, height] = (entry.sizes ?? "0x0").split("x").map((n) => parseInt(n, 10) || 0);
    return width * height;
  };
  return [...artwork].sort((a, b) => area(b) - area(a))[0]?.src ?? null;
}

function readTrack(): TrackInfo | null {
  const metadata = navigator.mediaSession?.metadata;
  if (metadata && metadata.title) {
    return {
      title: metadata.title,
      artist: metadata.artist ?? "",
      album: metadata.album ?? "",
      artwork: largestArtwork(metadata.artwork),
    };
  }
  return null;
}

function readPlaybackState(): PlaybackState {
  const media = findMediaElement();
  if (media) {
    if (media.ended) {
      return "stopped";
    }
    return media.paused ? "paused" : "playing";
  }
  switch (navigator.mediaSession?.playbackState) {
    case "playing":
      return "playing";
    case "paused":
      return "paused";
    default:
      return "stopped";
  }
}

function publishState(): void {
  const track = readTrack();
  const serialized = track ? JSON.stringify(track) : "";
  if (serialized !== lastSerializedTrack) {
    lastSerializedTrack = serialized;
    ipcRenderer.send("media:track", track);
  }

  const state = readPlaybackState();
  if (state !== lastPlaybackState) {
    lastPlaybackState = state;
    ipcRenderer.send("media:playback-state", state);
  }
}

/* ------------------------------------------------------------------ *
 * Controls
 * ------------------------------------------------------------------ */

/**
 * Returns the strategy that worked, so failures are diagnosable from the main
 * process log rather than silently doing nothing (the old failure mode).
 */
function performControl(action: ControlAction): string {
  const media = findMediaElement();

  if (action === "playPause" || action === "play" || action === "pause") {
    const shouldPlay = action === "play" || (action === "playPause" && readPlaybackState() !== "playing");

    // Prefer the page's own button so its UI state stays in sync.
    const button = findControl(shouldPlay ? "play" : "pause") ?? findControl(shouldPlay ? "pause" : "play");
    if (button instanceof HTMLElement) {
      button.click();
      return "dom-button";
    }
    if (media) {
      if (shouldPlay) {
        void media.play().catch(() => undefined);
      } else {
        media.pause();
      }
      return "media-element";
    }
    return "failed";
  }

  const button = findControl(action);
  if (button instanceof HTMLElement) {
    button.click();
    return "dom-button";
  }
  return "failed";
}

/** Lists candidate controls so a broken selector can be diagnosed in the field. */
function collectDiagnostics(): unknown {
  const candidates: Array<{ tag: string; labels: string[] }> = [];
  for (const element of walkElements(document)) {
    if (isClickable(element)) {
      const labels = controlLabels(element).filter((label) => label.length > 0 && label.length < 80);
      if (labels.length > 0) {
        candidates.push({ tag: element.tagName.toLowerCase(), labels });
      }
    }
  }
  return {
    url: location.href,
    hasMediaElement: findMediaElement() !== null,
    mediaSessionMetadata: readTrack(),
    playbackState: readPlaybackState(),
    clickableCandidates: candidates.slice(0, 120),
  };
}

/* ------------------------------------------------------------------ *
 * Wiring
 * ------------------------------------------------------------------ */

ipcRenderer.on("control", (_event, action: ControlAction) => {
  let result = "failed";
  try {
    result = performControl(action);
  } catch (error) {
    ipcRenderer.send("media:log", `control "${action}" threw: ${String(error)}`);
  }
  if (result === "failed") {
    ipcRenderer.send("media:log", `control "${action}" found no target`);
  }
  // Playback state changes are picked up by the poll, but nudge it so the tray
  // and companion app update immediately rather than up to a second later.
  setTimeout(publishState, 150);
});

ipcRenderer.on("collect-diagnostics", () => {
  try {
    ipcRenderer.send("media:diagnostics", collectDiagnostics());
  } catch (error) {
    ipcRenderer.send("media:log", `diagnostics failed: ${String(error)}`);
  }
});

window.addEventListener("DOMContentLoaded", () => {
  publishState();
  setInterval(publishState, POLL_INTERVAL_MS);

  // Media elements are created lazily, so bind opportunistically on the events
  // that bubble to the document.
  for (const eventName of ["play", "pause", "ended", "loadedmetadata"]) {
    document.addEventListener(eventName, () => setTimeout(publishState, 50), true);
  }
});
