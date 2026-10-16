# Reqeek

A desktop HTTP/HTTPS capture tool. Reqeek runs a local man-in-the-middle proxy, points the system
proxy at itself for the duration of a recording session, and shows every request that passes
through — method, URL, status, timing, headers and bodies — in a table you can search, filter and
drill into.

The proxy core never leaves your machine: it binds `127.0.0.1`, and the root certificate it signs
with is generated locally on first run. Nothing is uploaded anywhere.

Built with Electron, React and TypeScript. macOS and Windows.

---

## Features

**Recording**

- Local HTTP proxy bound to `127.0.0.1`, installed as the system proxy while recording and restored
  to its previous state when you stop recording or quit
- HTTPS decryption through a locally generated root CA — leaf certificates are signed on demand per
  host and cached in memory
- Anything that can't be decrypted falls back to an opaque CONNECT tunnel rather than failing:
  non-443 ports, built-in exclusions (Apple push and OCSP traffic), and hostnames that can't be
  turned into a valid certificate SAN
- WebSocket and other `101` upgrades are forwarded and byte-counted
- Records survive the window being closed — the tray keeps the session running

**Inspecting**

- Virtualised request list with collapsible domain groups and columns for name, status, type, size,
  time and a waterfall bar; click a header to sort by time, name, status, type, size or duration
- Search across host / path / method / status, with an invert option
- Filter bar of resource-type tabs (All, Fetch/XHR, Doc, CSS, JS, Font, Img, Media, WS, Other) plus
  toggles for errors only and hiding tunnels
- Sidebar that filters by the application that made the request — resolved from the OS, so a
  browser's helper processes all report under one name
- Detail pane that opens beside the list and narrows it to the name column, with five tabs:
  Headers, Payload, Preview, Response and Timing
- Body rendering chosen by content type — JSON and XML trees, a sandboxed HTML preview, an inline
  image preview, decoded URL-encoded form fields, a hex dump for binary, and plain text — with
  `gzip` / `deflate` / `br` decoded on demand and a copy button per body

**Around it**

- System tray with the recording state, so a capture is one click away
- Nine UI languages, light / dark / system theme
- Settings for port, language and theme, applied live — no restart, no save button
- In-app update check that compares against the published version and points you at the download page

### Keyboard shortcuts

| Shortcut         | Action                         |
| ---------------- | ------------------------------ |
| `Cmd/Ctrl` + `R` | Start or stop recording        |
| `Cmd/Ctrl` + `K` | Clear records                  |
| `Cmd/Ctrl` + `F` | Focus the search field         |
| `Cmd/Ctrl` + `,` | Open settings                  |
| `↑` / `↓`        | Move the selection in the list |

`Cmd/Ctrl` + `R` displaces the usual reload shortcut, which is why the dev build puts Force Reload
on `Shift` + `Cmd/Ctrl` + `R`.

### Not implemented yet

- No export — no HAR, no CSV, nothing written to disk. A session lives in the app and is gone when
  you clear it.
- No search inside a body, and no match highlighting. The JSON and XML trees colour by value type,
  not by search term.

## Platform support

| Feature               | macOS           | Windows                | Linux           |
| --------------------- | --------------- | ---------------------- | --------------- |
| System proxy          | `networksetup`  | Registry               | not implemented |
| Root CA trust         | Keychain        | Certificate store      | not implemented |
| Client app resolution | `lsof` / `ps`   | `netstat` / `tasklist` | not implemented |

macOS and Windows are fully supported. Linux packaging is configured and produces installers, but
the two platform-specific pieces the capture engine depends on — installing the system proxy and
trusting the root CA — have no driver yet, so recording cannot start there.

## Installing

Prebuilt installers are attached to [Releases](https://github.com/MonshinYu/Reqeek/releases): a
`.dmg` per architecture for macOS, and an NSIS `.exe` setup per architecture for Windows.

The builds are unsigned. macOS release builds carry an ad-hoc signature (Apple Silicon refuses to
launch a completely unsigned binary) but no Developer ID, so Gatekeeper will still ask you to
confirm on first launch, and the Windows installer will show an unknown-publisher warning.

### First run

Reqeek cannot decrypt HTTPS until its root certificate is trusted, and it refuses to start recording
until it is. The main window opens on a three-step gate:

1. **Generate** — the root CA is created in the app's data directory on first launch
2. **Install and trust** — macOS asks for keychain authorization; Windows shows a certificate
   installation prompt
3. **Verify** — the gate re-checks the trust state and lets you through

The gate distinguishes "in the trust store" from "trusted". Importing a certificate on macOS does
not trust it, and the difference shows up as a handshake failure with no other explanation, so the
gate reports the exact state and tells you what to change.

The root certificate and its private key live only in the app data directory
(`~/Library/Application Support/Reqeek/ca` on macOS, `%APPDATA%\Reqeek\ca` on Windows). Both can be
removed from the CA dialog; the private key is written `0600` and never leaves the machine.

## Development

### Requirements

- Node.js 20 or newer
- pnpm 11 (`packageManager` in `package.json` pins the version)

### Setup

```bash
pnpm install
pnpm dev
```

`pnpm dev` starts electron-vite with hot reload for the renderer and restarts the main process on
change.

### Scripts

| Command             | What it does                                          |
| ------------------- | ----------------------------------------------------- |
| `pnpm dev`          | Development with hot reload                           |
| `pnpm start`        | Preview a production build                            |
| `pnpm typecheck`    | Type-check the main/preload and renderer projects     |
| `pnpm build`        | Type-check, then build to `out/`                      |
| `pnpm build:mac`    | Build and package for macOS                           |
| `pnpm build:win`    | Build and package for Windows                         |
| `pnpm build:linux`  | Build and package for Linux                           |
| `pnpm build:unpack` | Package to a directory without producing an installer |

There is no test suite. `pnpm typecheck` (also run as part of `pnpm build`) is the gate.

### Project layout

```
src/
├── main/                    Electron main process
│   ├── index.ts             Lifecycle, windows, single-instance lock
│   ├── menu.ts  tray.ts     Application menu and tray menu
│   ├── theme.ts             nativeTheme, window background, title bar overlay
│   ├── settings.ts          settings.json load / normalize / save
│   ├── settings-window.ts   The separate settings window
│   ├── i18n.ts              Main-process translations
│   ├── ipc/                 IPC channel registration
│   └── proxy/               The capture engine — imports no Electron
│       ├── index.ts         Lifecycle facade (start / stop / recover)
│       ├── server.ts        HTTP forwarding and CONNECT handling
│       ├── tunnel.ts        Opaque CONNECT tunnels
│       ├── mitm/            TLS interception
│       ├── ca/              Root CA, leaf signing, platform trust drivers
│       ├── system-proxy/    Platform drivers and the snapshot state machine
│       ├── capture.ts       Header and body capture
│       ├── body-decode.ts   gzip / deflate / brotli decoding
│       ├── detail-store.ts  Budgeted store for headers and bodies
│       ├── client-process.ts Client app resolution
│       └── filters.ts       Which CONNECT targets get intercepted
├── preload/                 The contextBridge API surface
├── renderer/                React UI (two windows: home and settings)
│   └── src/
│       ├── views/           Home and Settings roots
│       ├── components/      UI kit
│       ├── lib/             Pure helpers (filtering, sorting, grouping, formatting)
│       ├── store/           Traffic state
│       └── styles/          Design tokens and global CSS
└── shared/                  Types, settings constraints, i18n, locale files
```

`@main`, `@shared` and `@` (renderer) are path aliases configured in `electron.vite.config.ts`.

## How it works

### Process model

One main process owns the proxy, the CA, the system proxy state and the traffic history; two
renderer windows (home and settings) talk to it over IPC through a `contextBridge` API. The proxy
core deliberately imports nothing from Electron — it takes its state directory as a parameter — so
it can move into a utility process, or be tested in plain Node, without changes.

The app takes a single-instance lock. Only one process may hold the system proxy snapshot at a time;
a second instance would otherwise treat the first one's live state as crash residue and restore the
user's proxy settings out from under it.

### Capture pipeline

```
client ──▶ HTTP proxy (127.0.0.1:8989)
              │
              ├─ CONNECT ─▶ intercepted? ─yes─▶ TLS termination ─▶ HTTP forwarding
              │                            └─no──▶ opaque tunnel (bytes counted, not parsed)
              └─ plain HTTP ─▶ forwarding
```

A `CONNECT` request is decrypted only when the target port is 443 (plus any configured ports), the
host is not on the exclusion list, and the hostname normalizes into a certificate the client will
actually accept. Everything else is tunneled verbatim. That last condition is not a formality: a
certificate signed with the wrong SAN type is still a valid certificate, it just fails the handshake
with no obvious cause, so any hostname Reqeek isn't certain about is tunneled instead of decrypted.

Both paths produce the same `Flow` record, so tunnels show up in the list with their duration and
byte counts — just without headers or bodies.

### Certificates

The root CA is an ECDSA P-256 certificate valid for 10 years. Leaf certificates are signed on demand
per host (199 days, with the validity start backdated two days to absorb clock skew) and cached in
an LRU of 512 hosts. Private keys are written `0600` in a `0700` directory.

Regeneration is conservative by design. If both CA files are missing it generates a new pair; if
only one is present it treats the pair as debris and regenerates; if both are present but don't
match, it refuses to start rather than overwrite something the user may still be able to recover.

### System proxy handling

The system proxy is four independent settings — web, secureWeb, SOCKS and PAC — each with its own
switch and address, and different platforms store them completely differently (per network service
via `networksetup` on macOS, registry keys on Windows). Reqeek models that instead of treating the
proxy as one on/off switch: only web and secureWeb are touched, SOCKS and PAC are left alone, and
the bypass list is merged with rather than replaced by Reqeek's own `localhost` / `127.0.0.1` entries.

Before anything is written, the current configuration is snapshotted to disk with the owning
process's identity, and the snapshot is written **before** the system is modified. If the app is
killed mid-recording, the next launch finds that snapshot and restores exactly what was there. The
restore is per-field, never a blanket "turn the proxy off".

Start and stop are ordered for the same reason: bind the port before installing the system proxy,
and remove the system proxy before closing the port. Inverted, either leaves a window in which the
machine's proxy points at nothing.

### Memory budgets

Capture is bounded at every stage, because a proxy that grows without limit is a proxy that takes
the machine down with it.

| Bound          | Value  | Applies to                                     |
| -------------- | ------ | ---------------------------------------------- |
| Per body       | 5 MB   | Retained bytes; the full size is still counted |
| Decoded output | 20 MB  | Decompression, against crafted bombs           |
| All details    | 64 MB  | Whole entries evicted oldest-first             |
| Retained flows | 20,000 | History replayed to a reloading window         |

The list and the details are separate: `Flow` records are pushed to the renderer in batches (500 per
100 ms, widening to 2,000 per 50 ms when the backlog grows), while headers and bodies are fetched
per request, and only when you open a record.

## Updating

Reqeek checks `https://reqeek.com/api/version` when you ask it to, compares the version against the
running build, and — if there's something newer — links you to the website. It does not download or
install anything itself: on macOS a self-update would need a Developer ID signature the project
doesn't have, and on Windows it would need to execute an unsigned installer.

The request deliberately does not go through Electron's network stack. Reqeek *is* a proxy, the
system proxy usually points back at it, and the update endpoint isn't in the bypass list — so a
request through Chromium's stack would be intercepted by Reqeek's own MITM and fail whenever the
root certificate isn't trusted. It uses Node's global `fetch` instead, which ignores the proxy
environment and connects directly.

## Security notes

- `contextIsolation` and `sandbox` are on, `nodeIntegration` is off; renderers see only the API
  exposed in `src/preload/index.ts`
- A Content-Security-Policy restricts the home window to `'self'` (plus `data:` images)
- New windows and navigation away from the app are denied outright
- The IPC surface is fixed: the renderer can trigger "open the update website" but cannot pass a URL
- The proxy listens on `127.0.0.1` only, and refuses to start while the root certificate is
  untrusted — an untrusted CA means unreadable traffic and a pointless system proxy change
- The root CA — private key included — and the system proxy snapshot are written `0600` inside a
  `0700` directory

## Internationalization

Nine languages ship today: German, English, Spanish, French, Japanese, Korean, Portuguese, Russian
and Simplified Chinese. The language list lives in `src/shared/i18n.ts`, and adding one means
touching the locale directory plus the two import sites noted in that file.

## Releasing

`.github/workflows/release.yml` is manual-only. Run it from the Actions page with a tag (for example
`v0.1.0`) to build all four packages and open a draft release; the tag must already exist on the
remote, and its version must match `package.json`. Leave the tag empty to build and upload artifacts
without creating a release.

Each platform job produces both architectures. macOS builds are ad-hoc signed; there is no
notarization.

## License

[MIT](LICENSE) © 2026 MonshinYu
