'use strict';

/**
 * DeepSeek Harness desktop shell — main process.
 *
 * The shell owns one ordinary `BrowserWindow` with the system decoration left
 * on. The decoration is drawn by the window manager, not by this app: on a
 * Wayland session the launcher selects the X11 Ozone backend so the window is
 * an XWayland client and Mutter decorates it, which yields the real system
 * title bar — buttons, theme, behaviour. Nothing about it is imitated in HTML;
 * an earlier revision drew a GTK look-alike inside a frameless window, which
 * could never follow theme changes or behave like a real window.
 *
 * Consequently there is no application menu bar (the harness fills the window)
 * and no custom title bar. Shell actions live on the tray where a tray host
 * exists, on the right-click menu, and on the keyboard shortcuts installed by
 * `installShortcuts`.
 *
 * The shell adds no harness features of its own: every capability comes from
 * the user's installed `dsh`, so the desktop app and the CLI always agree.
 */

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const {
  app,
  BrowserWindow,
  Menu,
  Tray,
  shell,
  dialog,
  ipcMain,
  nativeImage,
  screen,
} = require('electron');

const { Logger } = require('./logger.js');
const configModule = require('./config.js');
const { RuntimeManager, RuntimeError } = require('./runtime.js');

const APP_NAME = 'DeepSeek Harness';

/** Resolved once, before any window exists. */
let config = null;
let logger = null;
let runtime = null;
let mainWindow = null;
let tray = null;
let quitting = false;
let lastFailure = null;

/** True on a Wayland session, where either backend is available. */
const onWaylandSession = typeof process.env.WAYLAND_DISPLAY === 'string' && process.env.WAYLAND_DISPLAY !== '';

/**
 * The Ozone backend actually in use.
 *
 * The two backends produce different window decorations on a Wayland session:
 * natively, Chromium draws a bare frame of its own (a plain bar with a single
 * close button, unrelated to the desktop theme), while under X11 — through
 * XWayland — the window manager decorates the window, which is the real system
 * title bar. The launcher therefore prefers X11 on Wayland sessions.
 *
 * The choice is made in `bin/dsh-electron` and read back here, because the
 * backend is fixed before this script runs: setting it from here would look
 * like it worked while changing nothing. The fallback covers a direct
 * `electron .` launch with no launcher involved. Override with
 * `DSH_ELECTRON_OZONE=wayland` to take the native path instead.
 */
const ozoneBackend = app.commandLine.getSwitchValue('ozone-platform')
  || (onWaylandSession ? 'wayland' : 'x11');

if (process.env.DSH_ELECTRON_DISABLE_GPU === '1') {
  app.disableHardwareAcceleration();
}

// Render at a 1:1 pixel scale unless the desktop is asked otherwise.
//
// Unlike the Ozone backend, this switch is honoured when appended from here:
// Chromium reads the scale factor when the first screen is measured, not during
// early process startup. Putting it here means `npm start` gets the same
// rendering as the launcher.
const scaleFactor = configModule.envScaleFactor();
if (scaleFactor !== null) {
  app.commandLine.appendSwitch('force-device-scale-factor', scaleFactor);
}

// ── Identity and storage location ─────────────────────────────────────────────
//
// Chromium keeps a profile of its own (cache, cookies, localStorage) and derives
// its location from the application name, which would scatter a second,
// unrelated directory next to the shell's. Redirecting it here means everything
// the app ever writes lives under one removable directory.
//
// This runs before the single-instance lock on purpose: the lock's socket and
// files live inside that profile directory, so a later `setPath` would leave
// them behind in the default location.
app.setName(APP_NAME);
app.setPath('userData', path.join(configModule.DATA_DIR, 'chromium'));
if (process.platform === 'linux') app.setAppUserModelId('dev.dsh.harness');

// ── Single instance ───────────────────────────────────────────────────────────
// A second launch must focus the running window rather than boot a second
// harness, which would contend for the same DSH home.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow === null) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    if (!mainWindow.isVisible()) mainWindow.show();
    mainWindow.focus();
  });
  bootstrap();
}

function bootstrap() {
  config = configModule.loadConfig();
  logger = new Logger(config.logFile, { level: config.logLevel });
  logger.info('app', `${APP_NAME} shell starting (electron ${process.versions.electron}, node ${process.versions.node})`);
  logger.info('app', 'config: environment only (no config file)');
  logger.info('app', `dsh: ${config.dshBin ?? '(not found)'}`);
  logger.info('app', `ozone backend: ${ozoneBackend} (session: ${onWaylandSession ? 'wayland' : 'x11'})`);
  if (config.dshBin === null) {
    logger.error('app', 'no `dsh` executable was found');
  }

  app.whenReady().then(onReady).catch((error) => {
    logger.error('app', `startup failed: ${error.stack ?? error.message}`);
    dialog.showErrorBox(APP_NAME, String(error.message ?? error));
    app.quit();
  });
}

// ── Assets ────────────────────────────────────────────────────────────────────

function rendererFile(name) {
  return path.join(config.appRoot, 'src', 'renderer', name);
}

function preloadFile(name) {
  return path.join(config.appRoot, 'src', name);
}

function appIconPath() {
  const home = os.homedir();
  for (const candidate of [
    path.join(config.appRoot, 'build', 'icon.png'),
    path.join(home, '.local', 'share', 'dsh', 'dsh.png'),
    path.join(home, '.dsh', 'dsh.png'),
  ]) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

// ── Window ────────────────────────────────────────────────────────────────────

/**
 * Where the window lives when it starts.
 *
 * The shell keeps no window state on purpose: remembering geometry means
 * writing a file while the user drags the window, and a remembered position is
 * exactly the thing that strands a window off-screen after a monitor changes.
 * The compositor or window manager is the right owner of placement, and a fixed
 * starting size is the part worth guaranteeing.
 */
const WINDOW_DEFAULTS = {
  width: 1280,
  height: 860,
  minWidth: 640,
  minHeight: 480,
};

/**
 * Log where the window actually ended up.
 *
 * A window that is mapped off-screen is indistinguishable from one that never
 * appeared, so the geometry is recorded at the moment it matters.
 * @param {string} reason
 */
function logWindowGeometry(reason) {
  if (mainWindow === null || mainWindow.isDestroyed()) return;
  const display = screen.getPrimaryDisplay();
  logger.info('window', `${reason}: visible=${mainWindow.isVisible()} scale=${display.scaleFactor} bounds=${JSON.stringify(mainWindow.getBounds())} workArea=${JSON.stringify(display.workArea)}`);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    ...WINDOW_DEFAULTS,
    show: false,
    title: APP_NAME,
    backgroundColor: '#1f1f28',
    icon: appIconPath() ?? undefined,
    // The system decoration is the point of this window: under the X11 backend
    // the window manager draws it, themed and behaving like every other window.
    // `frame: true` is therefore deliberate and must not be switched to a
    // frameless style with a hand-drawn replacement.
    frame: true,
    autoHideMenuBar: true,
    webPreferences: {
      preload: preloadFile('preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: true,
    },
  });

  // Show on a first paint, but never depend on one: `ready-to-show` does not
  // fire if the compositor never delivers a frame (seen here under XWayland
  // when DRI3 is unavailable), and an app that is running but invisible is
  // indistinguishable from a crash. The timeout reveals it regardless.
  mainWindow.once('ready-to-show', () => {
    logger.debug('window', 'first frame painted');
    mainWindow.show();
    logWindowGeometry('ready-to-show');
  });
  const reveal = setTimeout(() => {
    if (mainWindow === null || mainWindow.isDestroyed() || mainWindow.isVisible()) return;
    logger.warn('window', 'no first frame within 3s; showing the window anyway');
    mainWindow.show();
    logWindowGeometry('reveal-timeout');
  }, 3000);
  reveal.unref?.();

  wireWindowEvents();
  installShortcuts();

  if (config.openDevTools) {
    logger.info('window', 'opening developer tools on start (config openDevTools)');
    mainWindow.webContents.once('did-finish-load', () => toggleDevTools());
  }

  return mainWindow;
}

function wireWindowEvents() {
  const contents = mainWindow.webContents;

  contents.setWindowOpenHandler(({ url }) => {
    if (isHarnessUrl(url)) return { action: 'allow' };
    openExternal(url);
    return { action: 'deny' };
  });

  contents.on('will-navigate', (event, url) => {
    if (isHarnessUrl(url) || url.startsWith('file://')) return;
    event.preventDefault();
    openExternal(url);
  });

  contents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
    // -3 is ABORTED, which our own navigation swaps produce routinely.
    if (errorCode === -3) return;
    logger.warn('window', `load failed (${errorCode} ${errorDescription}) for ${validatedURL}`);
  });

  contents.on('render-process-gone', (event, details) => {
    logger.error('window', `renderer gone: ${details.reason} (exitCode=${details.exitCode})`);
    if (!quitting) {
      showError({
        title: 'The interface stopped responding',
        message: `The window process exited (${details.reason}).`,
        detail: '',
        kind: 'renderer',
      });
    }
  });

  // Shell actions need a home inside the window itself: this desktop exposes no
  // tray host, and the harness owns the whole client area, so the title bar
  // cannot carry a menu. A right-click menu reaches everything either way.
  mainWindow.webContents.on('context-menu', (event, params) => {
    if (params.isEditable || params.selectionText !== '') return; // let the harness handle its own
    Menu.buildFromTemplate([
      ...buildActionMenuTemplate(),
      { type: 'separator' },
      {
        label: 'Copy',
        enabled: params.editFlags.canCopy,
        click: () => mainWindow?.webContents.copy(),
      },
    ]).popup({ window: mainWindow });
  });

  mainWindow.on('close', (event) => {
    // Closing the window quits the app unless a tray icon keeps it resident.
    if (!quitting && config.showTray && tray !== null) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function isHarnessUrl(url) {
  if (runtime === null || runtime.url === null) return false;
  try {
    const target = new URL(url);
    const harness = new URL(runtime.url);
    return target.port === harness.port
      && (target.hostname === '127.0.0.1' || target.hostname === 'localhost');
  } catch {
    return false;
  }
}

function openExternal(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:' || parsed.protocol === 'mailto:') {
      logger.info('shell', `opening externally: ${url}`);
      shell.openExternal(url).catch(() => { /* the desktop may have no handler */ });
    }
  } catch {
    /* not a URL we can hand off */
  }
}

// ── Screens ───────────────────────────────────────────────────────────────────

function showLoading() {
  if (mainWindow === null) return;
  mainWindow.loadFile(rendererFile('loading.html')).catch(() => { /* replaced below */ });
}

/**
 * Render the failure screen with a tail of the log, so a boot problem can be
 * understood without hunting for the log file.
 * @param {{title: string, message: string, detail?: string, kind: string}} failure
 */
function showError(failure) {
  lastFailure = failure;
  if (mainWindow === null || mainWindow.isDestroyed()) return;
  logger.error('app', `showing error screen: ${failure.title} — ${failure.message}`);
  // The screen reads `dsh:last-failure` over IPC rather than receiving query
  // parameters, so harness output never has to survive URL encoding.
  mainWindow.loadFile(rendererFile('error.html')).catch((error) => {
    logger.error('app', `could not load error screen: ${error.message}`);
  });
  refreshTrayMenu();
}

// ── Runtime wiring ────────────────────────────────────────────────────────────

async function startRuntime() {
  if (runtime === null) {
    runtime = new RuntimeManager(config, logger);
    runtime.on('exit', ({ expected }) => {
      if (expected || quitting) return;
      logger.warn('app', 'harness exited unexpectedly; waiting for restart');
    });
  }

  showLoading();

  try {
    const url = await runtime.start();
    if (mainWindow === null || mainWindow.isDestroyed()) return;
    logger.info('app', `loading ${url}`);
    await mainWindow.loadURL(url);
    refreshTrayMenu();
  } catch (error) {
    const failure = error instanceof RuntimeError
      ? { title: describeKind(error.kind), message: error.message, detail: error.detail, kind: error.kind }
      : { title: 'The harness could not start', message: String(error.message ?? error), detail: '', kind: 'unknown' };
    showError(failure);
  }
}

function describeKind(kind) {
  switch (kind) {
    case 'missing-dsh':
      return 'The DeepSeek Harness command is missing';
    case 'timeout':
      return 'The harness did not finish starting';
    case 'unreachable':
      return 'The harness started but is not answering';
    case 'early-exit':
      return 'The harness stopped during startup';
    case 'crash-loop':
      return 'The harness keeps crashing';
    case 'spawn':
      return 'The harness process could not be created';
    default:
      return 'The harness could not start';
  }
}

/** Stop then start, used by the tray, shortcuts and error screen. */
async function restartRuntime() {
  if (runtime === null) return startRuntime();
  await runtime.stop('restart');
  runtime.stopping = false;
  runtime.restarts = 0;
  runtime.url = null;
  lastFailure = null;
  return startRuntime();
}

/** Reload the harness page without restarting the process. */
function reloadWindow() {
  if (mainWindow === null || mainWindow.isDestroyed()) return;
  logger.info('app', 'reloading window');
  mainWindow.webContents.reload();
}

// ── Shortcuts ─────────────────────────────────────────────────────────────────
// There is deliberately no application menu: Electron would draw a menu bar
// inside the window, which is exactly what the harness window should not have.
// These shortcuts keep every shell action reachable from the keyboard.

/**
 * Install shell shortcuts without stealing keys the harness needs.
 *
 * `before-input-event` fires only while this window has focus (nothing is
 * captured system-wide), and unhandled keys fall straight through to the page.
 */
function installShortcuts() {
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const mod = input.control || input.meta;
    const key = (input.key || '').toLowerCase();
    const claim = () => {
      event.preventDefault();
      return true;
    };

    if (mod && input.shift && key === 'r') return void (claim(), restartRuntime());
    if (mod && input.shift && key === 'b') {
      claim();
      if (runtime?.url) openExternal(runtime.url);
      return;
    }
    if (mod && input.shift && key === 'l') return void (claim(), shell.showItemInFolder(config.logFile));
    if (mod && input.shift && key === 'i') return void (claim(), toggleDevTools());
    if (key === 'f12') return void (claim(), toggleDevTools());
    if (key === 'f11') return void (claim(), toggleFullScreen());
    if (key === 'f5') return void (claim(), reloadWindow());
    if (mod && !input.shift && key === 'q') {
      claim();
      quitting = true;
      app.quit();
      return;
    }
    // Plain Ctrl+R reloads, matching a browser, and is claimed last.
    if (mod && !input.shift && key === 'r') return void (claim(), reloadWindow());
  });
}

function toggleDevTools() {
  const contents = mainWindow?.webContents;
  if (contents === undefined || contents.isDestroyed()) return;
  if (contents.isDevToolsOpened()) contents.closeDevTools();
  else contents.openDevTools({ mode: 'detach' });
}

function toggleFullScreen() {
  if (mainWindow === null) return;
  mainWindow.setFullScreen(!mainWindow.isFullScreen());
}

// ── Dialogs ───────────────────────────────────────────────────────────────────

function showStatus() {
  const running = runtime !== null && runtime.running;
  dialog.showMessageBox({
    type: 'info',
    title: `${APP_NAME} — Status`,
    message: running ? 'Harness is running' : 'Harness is not running',
    detail: [
      `Endpoint: ${runtime?.url ?? '(none)'}`,
      `Command: ${config.dshBin ?? '(not found)'}`,
      `Working directory: ${config.workingDirectory}`,
      `Log file: ${config.logFile}`,
    ].join('\n'),
    buttons: ['OK'],
  });
}

function showAbout() {
  dialog.showMessageBox({
    type: 'info',
    title: `About ${APP_NAME}`,
    message: `${APP_NAME} desktop shell`,
    detail: [
      `Electron ${process.versions.electron}`,
      `Chromium ${process.versions.chrome}`,
      `Node ${process.versions.node}`,
    ].join('\n'),
    buttons: ['OK'],
  });
}

function showWorkspaceInfo() {
  dialog.showMessageBox({
    type: 'info',
    title: 'Working Directory',
    message: config.workingDirectory,
    detail: 'Set DSH_ELECTRON_CWD to change it.',
    buttons: ['OK'],
  });
}

/**
 * Run one named shell action. Shortcuts, the tray menu and the popup all route
 * through here, so the surfaces can never drift apart.
 * @param {string} action
 */
function runAction(action) {
  switch (action) {
    case 'restart': return void restartRuntime();
    case 'browser':
      if (runtime?.url) openExternal(runtime.url);
      return;
    case 'reload': return void reloadWindow();
    case 'log': return void shell.showItemInFolder(config.logFile);
    case 'workspace': return void showWorkspaceInfo();
    case 'status': return void showStatus();
    case 'about': return void showAbout();
    case 'devtools': return void toggleDevTools();
    case 'fullscreen': return void toggleFullScreen();
    case 'quit':
      quitting = true;
      app.quit();
      return;
    default:
      logger.warn('app', `unknown action: ${action}`);
  }
}

// ── Tray ──────────────────────────────────────────────────────────────────────

/**
 * The shell's action menu, shared by the tray and the window's context menu.
 * Built fresh each time so readiness-dependent items are never stale.
 */
function buildActionMenuTemplate() {
  return [
    { label: 'Restart Harness', accelerator: 'Ctrl+Shift+R', click: () => runAction('restart') },
    {
      label: 'Open in Browser',
      accelerator: 'Ctrl+Shift+B',
      enabled: runtime !== null && runtime.url !== null,
      click: () => runAction('browser'),
    },
    { label: 'Reload Window', accelerator: 'F5', click: () => runAction('reload') },
    { type: 'separator' },
    { label: 'Show Log File', accelerator: 'Ctrl+Shift+L', click: () => runAction('log') },
    { label: 'Working Directory…', click: () => runAction('workspace') },
    { label: 'Status…', click: () => runAction('status') },
    { label: 'About', click: () => runAction('about') },
    { type: 'separator' },
    { label: 'Toggle Developer Tools', accelerator: 'F12', click: () => runAction('devtools') },
    { label: 'Toggle Full Screen', accelerator: 'F11', click: () => runAction('fullscreen') },
    { type: 'separator' },
    { label: 'Quit', accelerator: 'Ctrl+Q', click: () => runAction('quit') },
  ];
}

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    {
      label: 'Show Window',
      click: () => {
        if (mainWindow === null) createWindowAndLoad();
        else {
          mainWindow.show();
          mainWindow.focus();
        }
      },
    },
    { type: 'separator' },
    ...buildActionMenuTemplate(),
  ]);
}

/**
 * Whether this desktop will actually show a tray icon.
 *
 * On Linux a tray icon needs a StatusNotifier host (an AppIndicator/KStatusNotifier
 * implementation). Creating a `Tray` without one does not throw — it merely
 * displays nothing — which would be dangerous here, because the window hides
 * instead of closing whenever a tray exists. So the host is probed directly and
 * an absent host is treated as "no tray", keeping the close button truthful.
 */
function trayHostAvailable() {
  if (process.platform !== 'linux') return true;
  try {
    const { execFileSync } = require('node:child_process');
    const output = execFileSync('gdbus', [
      'call', '--session',
      '--dest', 'org.freedesktop.DBus',
      '--object-path', '/org/freedesktop/DBus',
      '--method', 'org.freedesktop.DBus.NameHasOwner',
      'org.kde.StatusNotifierWatcher',
    ], { timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    return output.includes('true');
  } catch {
    // No gdbus, or no session bus at all: assume no tray rather than risk
    // trapping the window in an invisible tray.
    return false;
  }
}

function createTray() {
  if (!config.showTray) return;
  if (!trayHostAvailable()) {
    logger.info('tray', 'no StatusNotifier host on this desktop; running without a tray');
    return;
  }
  const iconPath = appIconPath();
  if (iconPath === null) return;
  try {
    const image = nativeImage.createFromPath(iconPath);
    if (image.isEmpty()) return;
    tray = new Tray(image.resize({ width: 22, height: 22 }));
    tray.setToolTip(APP_NAME);
    tray.setContextMenu(buildTrayMenu());
    tray.on('click', () => {
      if (mainWindow === null) return;
      if (mainWindow.isVisible()) mainWindow.hide();
      else mainWindow.show();
    });
    logger.info('tray', 'tray icon created');
  } catch (error) {
    logger.warn('tray', `tray unavailable: ${error.message}`);
    tray = null;
  }
}

/** Rebuild the tray menu so readiness-dependent items reflect current state. */
function refreshTrayMenu() {
  if (tray === null) return;
  try {
    tray.setContextMenu(buildTrayMenu());
  } catch {
    /* the tray may be gone between the check and the call */
  }
}

// ── IPC ───────────────────────────────────────────────────────────────────────

function registerIpc() {
  // Native directory chooser for the harness's directory-picker seam. The
  // renderer-side client plugin prefers `globalThis.__DSH_DIRECTORY_PICKER__`
  // when a desktop host exposes it (see src/preload.js).
  ipcMain.handle('dsh:pick-directory', async () => {
    if (mainWindow === null) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose a working directory',
      defaultPath: config.workingDirectory,
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: 'Use this folder',
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  // Retry / diagnostic actions from the error screen.
  ipcMain.handle('dsh:restart-runtime', async () => {
    await restartRuntime();
    return true;
  });

  ipcMain.handle('dsh:open-log', async () => {
    await shell.openPath(config.logFile);
    return true;
  });

  ipcMain.handle('dsh:quit', async () => {
    quitting = true;
    app.quit();
    return true;
  });

  ipcMain.handle('dsh:info', async () => ({
    appVersion: app.getVersion(),
    electron: process.versions.electron,
    dshBin: config.dshBin,
    workingDirectory: config.workingDirectory,
    logFile: config.logFile,
  }));

  ipcMain.handle('dsh:last-failure', async () => ({
    failure: lastFailure,
    logTail: logger.tail(40),
    logFile: config.logFile,
    dshBin: config.dshBin,
    workingDirectory: config.workingDirectory,
  }));

  ipcMain.on('dsh:run-action', (event, action) => {
    if (typeof action === 'string') runAction(action);
  });
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

async function createWindowAndLoad() {
  createWindow();
  await startRuntime();
}

function onReady() {
  registerIpc();
  // No application menu: Electron draws one inside the window, and the harness
  // should keep the whole client area. Shortcuts and the tray replace it.
  Menu.setApplicationMenu(null);
  createTray();
  createWindowAndLoad().catch((error) => {
    logger.error('app', `fatal: ${error.stack ?? error.message}`);
  });
}

app.on('activate', () => {
  // macOS: re-create the window when the dock icon is clicked.
  if (mainWindow === null && config !== null) {
    createWindowAndLoad().catch(() => { /* reported by the error screen */ });
  } else if (mainWindow !== null) {
    mainWindow.show();
  }
});

app.on('window-all-closed', () => {
  // With a tray the app stays resident; otherwise quitting is expected.
  if (process.platform !== 'darwin' && (!config?.showTray || tray === null)) {
    quitting = true;
    app.quit();
  }
});

app.on('before-quit', () => {
  quitting = true;
});

app.on('will-quit', (event) => {
  if (runtime === null || !runtime.running) return;
  // Give the harness a chance to shut down cleanly before the process ends.
  event.preventDefault();
  const done = () => {
    runtime = null;
    app.quit();
  };
  runtime.stop('app-quit').then(done, done);
});

process.on('uncaughtException', (error) => {
  logger?.error('app', `uncaught exception: ${error.stack ?? error.message}`);
  if (mainWindow !== null && !mainWindow.isDestroyed()) {
    showError({
      title: 'An unexpected error occurred',
      message: String(error.message ?? error),
      detail: String(error.stack ?? ''),
      kind: 'uncaught',
    });
  }
});

process.on('unhandledRejection', (reason) => {
  logger?.error('app', `unhandled rejection: ${reason instanceof Error ? reason.stack : String(reason)}`);
});