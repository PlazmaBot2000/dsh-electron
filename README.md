# DeepSeek Harness — Desktop Shell

A native desktop application for [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh) (`dsh`). It opens the harness in a real window with a **real system title bar**, supervises the local `dsh web` runtime for you, and disappears as a concern — no browser tab, no terminal babysitting, no second copy of your config.

```
┌─ DeepSeek Harness ───────────────────────────────────────── ✕ ┐
│                                                                │
│   the harness UI, exactly as `dsh web` serves it               │
│   — sessions, plugins, settings, everything                    │
│                                                                │
└────────────────────────────────────────────────────────────────┘
        ▲ drawn by your window manager, themed by your desktop
```

> **Not a website wrapper.** The shell ships no harness code and reimplements nothing. It launches *your* installed `dsh` with the *same* `web` profile the CLI uses, so your sessions, plugins, credentials and settings under `~/.dsh` are the ones on screen — the day you update `dsh`, the app updates with it.

---

## Contents

- [Why](#why)
- [Features](#features)
- [Requirements](#requirements)
- [Install](#install)
- [Keyboard & menus](#keyboard--menus)
- [Configuration](#configuration)
- [How it works](#how-it-works)
- [The title bar story](#the-title-bar-story)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [License](#license)

---

## Why

Running `dsh web` by hand has a rhythm that gets old fast: start the process, find the URL with the token in the terminal noise, open a browser tab, lose the tab among forty others, and notice the server died sometime during your work.

This shell turns that into **one window on the dock**. It knows the URL because it read it from the harness, it knows the harness died because it is watching the process, and it brings the window back when you click the dock icon. Everything the harness can do, it can do — it is the same server, the same interface, the same profile.

## Features

| | |
|---|---|
|  **Real system window** | Native title bar with working minimize/maximize/close, drawn and themed by your window manager — not an HTML imitation |
| 🧩 **Zero divergence** | Uses your installed `dsh` and its `web` profile: same sessions, plugins, skills, and credentials as the CLI |
| 🩺 **Supervised runtime** | Reads the authenticated URL from the harness, health-checks it, restarts a crashed harness with backoff, and reports *why* it gave up |
| 🧹 **No config files** | Nothing to learn and nothing to clean up: settings come from the environment, and the only files written are the log and Chromium's own profile, both under one directory |
| 🔍 **Pixel-exact text** | Scale factor is pinned to 1:1 by default, so the dense interface renders crisp rather than compositor-upscaled — `DSH_ELECTRON_SCALE=auto` gives that back |
| 📂 **Native folder picker** | The harness's directory chooser opens the real OS dialog through a single, minimal IPC seam |
| ⌨️ **Keyboard-first** | No menu bar stealing vertical space; every shell action has a shortcut and a right-click entry |
| 🔒 **Single instance** | Launching again focuses the existing window instead of starting a second server |
| 🧯 **Honest failure** | A dedicated error screen shows the actual problem plus a tail of the log, with a retry button |
| 🖼️ **Dock & launcher** | XDG desktop entry, hicolor icons, correct `StartupWMClass` grouping |
| 🔌 **Tray when available** | Resides in the tray when the desktop offers a StatusNotifier host — and never pretends to |

## Requirements

- **Linux** (primary target; GNOME/KDE, Wayland or X11) — macOS and Windows work in principle, the launcher's decoration logic is Linux-specific.
- **`dsh`** installed and working: `npm install -g @deepseek-ai/dsh`
- **Electron ≥ 30** — either your distribution's package (`electron44`, `electron30`, …), which the launcher finds automatically, or a local `npm install`.
- Node.js ≥ 20 (what `dsh` itself needs).

## Install

### Run it directly

```bash
git clone https://github.com/PlazmaBot2000/dsh-electron.git
cd dsh-electron
./bin/dsh-electron          # finds a system Electron, or
npm install && npm start    # uses a local one
```

Use the launcher when you want the system title bar: `npm start` runs `electron .` directly, which skips the backend selection and lands on native Wayland with Chromium's own bare decoration. See [The title bar story](#the-title-bar-story).

### Install as a desktop application

```bash
./scripts/install.sh
```

This writes a `dsh-electron` launcher into `~/.local/bin`, icons into the hicolor theme, and a proper `.desktop` entry, so **DeepSeek Harness** appears in your application menu and dock. Undo everything with `./scripts/uninstall.sh` (your config is kept).

## Keyboard & menus

There is deliberately **no application menu bar** — Electron would draw one inside the window and eat vertical space the harness should own. Instead:

| Shortcut | Action |
|---|---|
| `Ctrl+Shift+R` | Restart the harness runtime |
| `Ctrl+Shift+B` | Open the running harness in your browser |
| `F5` / `Ctrl+R` | Reload the window |
| `F11` | Full screen |
| `F12` / `Ctrl+Shift+I` | Developer tools |
| `Ctrl+Shift+L` | Reveal the log file |
| `Ctrl+Q` | Quit |

**Right-click** any empty part of the interface for the full action menu (Restart, Status, Working Directory, About, Quit…). Editable fields and text selections are left to the harness itself.

## Configuration

There is none to learn — the shell reads **no config file**. It works out of the box: it finds your `dsh`, picks a working directory, and binds a stable port. Everything is overridable through the environment when you need it:

| Variable | Default | Effect |
|---|---|---|
| `DSH_BIN` | auto | Absolute path to `dsh`. Auto-discovery searches `PATH`, `~/.npm-global/bin`, `~/.local/bin`, `/usr/local/bin`, `/usr/bin` |
| `DSH_NODE_BIN` | auto | Node binary used to run a `.js` `dsh` entry |
| `DSH_HOME` | `~/.dsh` | Harness home — point at a separate profile |
| `DSH_ELECTRON_CWD` | `~/AI_workspace`, else `~` | Working directory the harness is spawned in |
| `DSH_ELECTRON_HOST` | `127.0.0.1` | Bind address for `dsh web` |
| `DSH_ELECTRON_PORT` | `3080` | A stable port keeps the browser origin constant, which is what localStorage is keyed on. `0` always asks the OS |
| `DSH_ELECTRON_ARGS` | — | Extra arguments appended to `dsh web …` (space-separated argv, never a shell string) |
| `DSH_ELECTRON_OZONE` | `x11` on Wayland | `x11` for real WM decorations, `wayland` for the native path |
| `DSH_ELECTRON_BIN` | auto | Which Electron binary to run |
| `DSH_ELECTRON_DISABLE_GPU` | — | `1` turns off hardware acceleration |
| `DSH_ELECTRON_TRAY` | enabled | `0` disables the tray icon |
| `DSH_ELECTRON_DEVTOOLS` | off | `1` opens dev tools on every start |
| `DSH_ELECTRON_DEBUG` | off | `1` logs at debug level |
| `DSH_ELECTRON_SCALE` | `1` | Device scale factor forced on Chromium. The default pins it to 1:1 so the text-dense interface renders crisply instead of being blown up by the compositor; `auto` hands the choice back to the desktop, a number (`1.5`, `2`) sets it directly |
| `XDG_CONFIG_HOME` | `~/.config` | Relocates everything the shell writes |

If `DSH_ELECTRON_PORT` is already taken, the shell does not fail — it asks the OS for a free port and reads the real one back from the harness.

### What it writes

Everything lives in `~/.config/dsh-electron/` and nowhere else:

```
dsh-electron.log    the shell's own log
chromium/           Chromium's profile (cache, cookies, localStorage)
```

No `config.json`, no window-state file. The window deliberately does not remember its geometry: doing so means writing a file on every drag, and a remembered position is exactly what strands a window off-screen after a monitor change. Placement belongs to the window manager. Deleting `~/.config/dsh-electron/` removes every trace of the app.

## How it works

```
bin/dsh-electron ──► Electron ──► src/main.js
                                   │
             ┌─────────────────────┼──────────────────────┐
             ▼                     ▼                      ▼
        config.js             runtime.js              logger.js
     discovery + state   spawns & supervises      append-only log
                         `dsh web --no-open`
                                   │
                                   ▼
                    dsh web  http://127.0.0.1:PORT/?token=…
                                   │
                                   ▼
                          BrowserWindow (frame: true)
```

- **Adoption, not composition.** `dsh web` prints a URL carrying a per-process launch token; the shell parses that line rather than guessing a URL, then health-checks it until the server actually answers (a printed URL is a promise, not a proof).
- **Supervision.** An unexpected exit triggers a restart with exponential backoff (up to 5 attempts, then a clear "crash loop" report). Shutdown is graceful: `SIGTERM`, then `SIGKILL` after 6 s.
- **Security.** `contextIsolation` on, `nodeIntegration` off, navigation outside the harness handed to your browser, and exactly two IPC surfaces: the folder picker and enumerated shell actions.
- **Availability.** The harness is bound to loopback by default and the window is the only client; closing the window stops the server unless a tray keeps the app resident.

## The title bar story

Worth telling, because it is the difference between a desktop app and a browser tab wearing a hat.

An earlier revision drew a GTK-styled header bar in HTML inside a frameless window. It looked right in a screenshot and was wrong in every other way: it did not follow the system theme, did not behave like a title bar, and could not be trusted to.

The real question on Linux is **who draws the decoration**. Electron has two Ozone backends:

| Backend | Decoration |
|---|---|
| native Wayland | Chromium draws its own — a bare bar with a single close button, unthemed (libdecor is not loaded by Chromium in practice) |
| **X11 via XWayland** | **your window manager draws it** — the genuine system title bar, themed, with real minimize/maximize/close |

So on a Wayland session the launcher passes `--ozone-platform=x11`, and the window gets the same frame as every other app on your desktop. The choice is made in the shell script *before* Electron starts, because the backend is fixed during early startup — setting it from the main script would look like it worked while changing nothing. Prefer the native path? `DSH_ELECTRON_OZONE=wayland`.

## Troubleshooting

| Symptom | Fix |
|---|---|
| "The `dsh` command was missing" | `npm install -g @deepseek-ai/dsh`, or point at it with `DSH_BIN` |
| Window never appears | Read `~/.config/dsh-electron/dsh-electron.log`; try `DSH_ELECTRON_DISABLE_GPU=1` |
| Blank/garbled rendering under XWayland | `DSH_ELECTRON_OZONE=wayland` (you lose WM decorations but keep the app) |
| Port 3080 already used | Automatic fallback to a free port; `DSH_ELECTRON_PORT=0` always asks the OS |
| No tray icon | Your desktop lacks a StatusNotifier host (stock GNOME does). Everything remains reachable via shortcuts and right-click |
| Something else | `DSH_ELECTRON_DEBUG=1 ./bin/dsh-electron`, then open an issue with the log tail |

## Development

```bash
npm install          # local Electron for `npm start`
npm run check        # syntax-check every JS file and shell script
npm run start:debug  # verbose logging against a system Electron
```

Layout — one concern per file, no framework, no build step:

```
bin/dsh-electron      launcher: finds Electron, picks the Ozone backend
src/main.js           window, menus, shortcuts, tray, IPC, lifecycle
src/runtime.js        spawns and supervises `dsh web`
src/config.js         discovery and environment settings
src/logger.js         append-only log with a tail() for the error screen
src/preload.js        the entire renderer↔main surface (two namespaces, no fs)
src/renderer/         loading + error screens (plain HTML)
scripts/install.sh    desktop entry, icons, launcher
```

## License

MIT — see [LICENSE](LICENSE).
