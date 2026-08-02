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

For a `.deb` in one step:

```
npm run dist-deb
```

For a `.rpm` in one step:

```
npm run dist-rpm
```

The individual stages, if you need them separately:

| Script | Produces |
| --- | --- |
| `npm run package-linux` | `release-builds/amazon-music-linux-linux-x64/` — an unpacked app directory, **not** an installable package |
| `npm run deb` | `release-builds/amazon-music-linux_<version>_amd64.deb` |
| `npm run rpm` | `release-builds/amazon-music-linux-<version>.x86_64.rpm` (needs `rpmbuild` installed) |

`deb` and `rpm` both consume the directory that `package-linux` produces, so run that first.

### Releasing

[`.github/workflows/release.yml`](.github/workflows/release.yml) builds both packages in CI.
Publish a GitHub release tagged `vX.Y.Z` and the workflow will build the `.deb` and `.rpm` and
attach them to it. The tag is treated as the source of truth for the version, so the filenames can
never drift from the tag they hang off — you do not have to remember to bump `package.json` first.

It also runs on `workflow_dispatch` (build without publishing, artifacts retained for 14 days) and
on pull requests that touch the packaging config. Before uploading anything it asserts that all nine
hicolor icon sizes are present and that `StartupWMClass` matches the `.desktop` basename, so a
regression in the dock icon fails the build instead of shipping.

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
- **No tray icon / the app seems to vanish when closed** — GNOME has shipped no system tray since
  3.26, and Electron's tray icon only appears if something implements the StatusNotifierItem spec.
  On Ubuntu GNOME that is the AppIndicator extension, which ships installed but is not always
  enabled:
  ```
  gnome-extensions enable ubuntu-appindicators@ubuntu.com
  ```
  The app probes for a tray host at startup. If none is found it logs a warning, skips the tray icon
  and makes closing the window quit, so it can never hide somewhere invisible. You can always quit
  with **Ctrl+Q**, *File → Quit*, or *Window → Quit*.
- **The dock shows a generic gear instead of the app icon** — the window's `StartupWMClass` must
  match the `.desktop` filename, and the icon must be installed into the hicolor theme (a lone
  `/usr/share/pixmaps` entry is not enough for GNOME docks). Both are handled by the packaging
  config; if you are upgrading from an older build, reinstall the `.deb` to pick them up.
- **Asked to sign in on every launch** — Amazon serves the storefront that matches your *account*,
  which is not necessarily the one your system locale implies; a UK account on an `en_US` system
  gets sent to `music.amazon.com` and bounced to `co.uk`, re-running sign-in each time. With region
  set to *Detect from system locale*, the app now remembers where Amazon actually redirected it and
  goes straight there next launch. You can also just pick your storefront explicitly in Settings.
  Signing out on quit can also mean the app was killed rather than quit — see below.
- **Media keys or tray buttons do nothing** — Amazon changes the player's DOM regularly. Run
  **Playback → Dump Player Diagnostics to Log** from the menu bar and open an issue with the output;
  it lists every control the app can currently see.
- **Error about `libXss.so.1`** — install `libXScrnSaver` or your distro's equivalent.

## Legal Disclaimer

No affiliation with Amazon.com, Inc. All trademarks and registered trademarks are the property of
their respective owners.
