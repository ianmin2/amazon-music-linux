# amazon-music-linux

A standalone desktop app for Amazon Music Unlimited / Prime Music on Linux.

Amazon Music streams are protected with Google Widevine, so this is built on
[castLabs' Electron fork](https://github.com/castlabs/electron-releases), which ships a
Widevine-enabled Chromium along with the component updater that keeps the CDM current.

## Requirements

- Node.js 22.12 or newer

## Running from source

```
git clone https://github.com/ianmin2/amazon-music-linux
cd amazon-music-linux
npm install
npm start
```

The Widevine CDM is **not** vendored in this repository. castLabs' `+wvcus` builds fetch and update
it at runtime through Electron's component updater, so the first launch needs network access; after
that it is cached under the app's user-data directory.

## Building a package

```
npm run package-linux
```

That compiles and bundles with `@electron/packager`. The output lands in `release-builds/`.

Then, for a distro package:

- Ubuntu/Debian:
  ```
  npx electron-installer-debian --src release-builds/amazon-music-linux-linux-x64/ --arch amd64 --config build-config.json
  ```

- Fedora/openSUSE:
  ```
  npx electron-installer-redhat --src release-builds/amazon-music-linux-linux-x64/ --arch x86_64 --config build-config.json
  ```

### A note on VMP signing

You do not need it here, and there is no step to run. On Windows and macOS, castLabs' EVS service
VMP-signs the packaged executable, and licence servers reject builds that lack a signature. Linux is
different: [the Linux Widevine CDM does not support VMP](https://github.com/castlabs/electron-releases/wiki/EVS),
so no signature is required and EVS does not sign Linux binaries at all. `evs-vmp sign-pkg` only
looks for `.app` and `.exe` executables and will report `No matching executable found` if pointed at
a Linux package directory.

A Linux build therefore reports VMP status `PLATFORM_UNVERIFIED`, which castLabs documents as
expected on this platform and is sufficient for the temporary licences streaming uses. The one thing
Linux gives up is persistent licences, i.e. offline playback — which Amazon Music's web player does
not offer anyway.

## Settings

Tray icon → **Settings**, or **File → Settings**.

- **Storefront** — which `music.amazon.*` domain to load. Defaults to detecting from your system
  locale.
- **Close to tray** — whether closing the window hides it instead of quitting.
- **Media keys** — leave off on Wayland, GNOME and KDE, where the desktop already routes media keys
  via MPRIS. Turn it on only if media keys do nothing (typically bare X11 setups); enabling both
  routes makes each keypress fire twice.
- **Companion app server** — off by default. See below.

Settings are stored in `~/.config/Amazon Music/settings.json`.

## Companion app server

The [Android companion app](https://github.com/flokol120/amazon-music-linux-app) talks to the player
over a local Socket.IO server. It is **disabled by default**, and when enabled it binds `127.0.0.1`
and requires the pairing token shown in the settings window.

Switching it to *All interfaces* exposes playback control and the current track to every device on
your network, so only do that on a network you trust.

## Troubleshooting

- **Playback fails with a licence/DRM error** — check the startup log for `[widevine] components
  ready:`. If component installation failed, the CDM could not be downloaded; it needs network
  access on first launch. This is *not* a signing problem — see
  [A note on VMP signing](#a-note-on-vmp-signing).
- **Media keys or tray buttons do nothing** — Amazon changes the player's DOM regularly. Run
  **Playback → Dump Player Diagnostics to Log** from the menu bar and open an issue with the output;
  it lists every control the app can currently see.
- **Error about `libXss.so.1`** — install `libXScrnSaver` or your distro's equivalent.

## Legal Disclaimer

No affiliation with Amazon.com, Inc. All trademarks and registered trademarks are the property of
their respective owners.
