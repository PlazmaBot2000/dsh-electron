'use strict';

/**
 * Path resolution, user configuration, and persisted window state.
 *
 * The shell deliberately owns almost no configuration: it finds the user's
 * installed `dsh` CLI and boots that CLI's own web profile, so profiles,
 * plugins, sessions, and credentials stay exactly where the CLI keeps them.
 * The few knobs here exist to point the shell at a non-default install.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const APP_ROOT = path.join(__dirname, '..');

/** Directory holding user configuration and state, honouring XDG. */
function configDir() {
  const base = process.env.XDG_CONFIG_HOME && process.env.XDG_CONFIG_HOME !== ''
    ? process.env.XDG_CONFIG_HOME
    : path.join(os.homedir(), '.config');
  return path.join(base, 'dsh-electron');
}

const CONFIG_FILE = path.join(configDir(), 'config.json');
const STATE_FILE = path.join(configDir(), 'window-state.json');
const LOG_FILE = path.join(configDir(), 'dsh-electron.log');

/** Candidate `dsh` executables, in the order a user would expect them found. */
function dshCandidates() {
  const home = os.homedir();
  const candidates = [];
  if (process.env.DSH_BIN) candidates.push(process.env.DSH_BIN);
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (dir !== '') candidates.push(path.join(dir, 'dsh'));
  }
  candidates.push(
    path.join(home, '.npm-global', 'bin', 'dsh'),
    path.join(home, '.local', 'bin', 'dsh'),
    '/usr/local/bin/dsh',
    '/usr/bin/dsh',
  );
  return candidates;
}

function isExecutableFile(candidate) {
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/** Absolute path of the user's `dsh`, or null when none is installed. */
function findDshBin(explicit) {
  if (explicit) {
    const resolved = path.resolve(explicit.replace(/^~(?=\/|$)/, os.homedir()));
    return isExecutableFile(resolved) ? resolved : null;
  }
  for (const candidate of dshCandidates()) {
    if (isExecutableFile(candidate)) return fs.realpathSync(candidate);
  }
  return null;
}

/** A real Node.js binary — never Electron itself, whose runtime differs. */
function findNodeBin() {
  const candidates = [];
  if (process.env.DSH_NODE_BIN) candidates.push(process.env.DSH_NODE_BIN);
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (dir !== '' && !dir.includes('electron')) candidates.push(path.join(dir, 'node'));
  }
  candidates.push('/usr/bin/node', '/usr/local/bin/node');
  for (const candidate of candidates) {
    try {
      if (!isExecutableFile(candidate)) continue;
      // Electron-based "node" shims would not behave like a plain runtime.
      if (candidate.toLowerCase().includes('electron')) continue;
      return candidate;
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

/**
 * Turn the located `dsh` entry into something spawn() can run.
 *
 * npm installs `dsh` as a small script carrying a `#!/usr/bin/env node`
 * shebang. Executing it through the located Node binary avoids depending on
 * the launcher honouring shebangs (and on `env node` resolving on PATH).
 */
function resolveDshCommand(dshBin, nodeBin) {
  if (dshBin === null) return null;
  const isScript = /\.(?:c?js|mjs)$/i.test(dshBin);
  if (isScript) {
    if (nodeBin === null) return { command: dshBin, args: [], kind: 'script' };
    return { command: nodeBin, args: [dshBin], kind: 'node-script' };
  }
  return { command: dshBin, args: [], kind: 'executable' };
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  } catch {
    /* State persistence is best-effort by design. */
  }
}

/** Default working directory for the runtime, matching a normal CLI launch. */
function defaultWorkingDirectory() {
  const home = os.homedir();
  const workspace = path.join(home, 'AI_workspace');
  try {
    if (fs.statSync(workspace).isDirectory()) return workspace;
  } catch {
    /* fall through to the home directory */
  }
  return home;
}

/**
 * Effective configuration: defaults, then the user's config.json.
 * @returns {{dshBin: string|null, nodeBin: string|null, command: object|null,
 *   workingDirectory: string, host: string, port: number, extraArgs: string[],
 *   openDevTools: boolean, showTray: boolean, logLevel: string}}
 */
function loadConfig() {
  const user = readJson(CONFIG_FILE, {});
  const dshBin = findDshBin(user.dshBin ?? process.env.DSH_BIN ?? null);
  const nodeBin = findNodeBin();

  const envArgs = (process.env.DSH_ELECTRON_ARGS ?? '')
    .split(' ')
    .map((value) => value.trim())
    .filter((value) => value !== '');

  return {
    configFile: CONFIG_FILE,
    stateFile: STATE_FILE,
    logFile: LOG_FILE,
    appRoot: APP_ROOT,
    dshBin,
    nodeBin,
    command: resolveDshCommand(dshBin, nodeBin),
    dshHome: user.dshHome ?? process.env.DSH_HOME ?? null,
    workingDirectory: user.workingDirectory ?? defaultWorkingDirectory(),
    host: user.host ?? '127.0.0.1',
    // A stable port keeps the browser origin constant, which is what
    // localStorage is keyed on; `choosePort` falls back to an OS-assigned free
    // port only when this one is already taken.
    port: Number.isInteger(user.port) ? user.port : 3080,
    extraArgs: Array.isArray(user.extraArgs) ? user.extraArgs : envArgs,
    openDevTools: user.openDevTools === true,
    showTray: user.showTray !== false,
    logLevel: user.logLevel ?? (process.env.DSH_ELECTRON_DEBUG === '1' ? 'debug' : 'info'),
  };
}

/** Persisted window geometry, validated enough to be safe to apply. */
function loadWindowState() {
  const state = readJson(STATE_FILE, {});
  const bounds = state.bounds ?? {};
  const usable = ['x', 'y', 'width', 'height'].every((key) => Number.isFinite(bounds[key]));
  return {
    bounds: usable ? bounds : null,
    maximized: state.maximized === true,
  };
}

function saveWindowState(value) {
  writeJson(STATE_FILE, value);
}

module.exports = {
  APP_ROOT,
  LOG_FILE,
  CONFIG_FILE,
  STATE_FILE,
  loadConfig,
  loadWindowState,
  saveWindowState,
  findDshBin,
  findNodeBin,
  defaultWorkingDirectory,
};