> [!WARNING]
> ```text
> __     _____ ____  _____ ____ ___  ____  _____ ____  
> \ \   / /_ _| __ )| ____/ ___/ _ \|  _ \| ____|  _ \ 
>  \ \ / / | ||  _ \|  _|| |  | | | | | | |  _| | | | |
>   \ V /  | || |_) | |__| |__| |_| | |_| | |___| |_| |
>    \_/  |___|____/|_____\____\___/|____/|_____|____/ ,
> use at your own risk.
> ```


# DeepSeek Harness — Desktop Shell

A native desktop application for [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh) (`dsh`). It opens the harness in a window, supervises the local `dsh web` runtime for you.

---

## Contents

- [Requirements](#requirements)
- [Install](#install)
- [Keyboard & menus](#keyboard--menus)
- [Configuration](#configuration)
- [License](#license)

---
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

### Install as a desktop application

```bash
./scripts/install.sh
```

This writes a `dsh-electron` launcher into `~/.local/bin`, icons into the hicolor theme, and a proper `.desktop` entry, so **DeepSeek Harness** appears in your application menu and dock. Undo everything with `./scripts/uninstall.sh` (your config is kept).

## Keyboard & menus
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

## License

MIT — see [LICENSE](LICENSE).
