'use strict';

/**
 * Path resolution and configuration.
 *
 * The shell deliberately owns no configuration file: it finds the user's
 * installed `dsh` CLI and boots that CLI's own web profile, so profiles,
 * plugins, sessions, and credentials stay exactly where the CLI keeps them.
 * The handful of knobs that remain are read from the environment, which keeps
 * the shell stateless — nothing is written except the log and the one endpoint
 * record it re-reads on the next start to attach to a running harness.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const APP_ROOT = path.join(__dirname, '..');

/** The one directory the shell owns, honouring XDG_CONFIG_HOME. */
function dataDir() {
  const base = process.env.XDG_CONFIG_HOME && process.env.XDG_CONFIG_HOME !== ''
    ? process.env.XDG_CONFIG_HOME
    : path.join(os.homedir(), '.config');
  return path.join(base, 'dsh-electron');
}

const DATA_DIR = dataDir();
const LOG_FILE = path.join(DATA_DIR, 'dsh-electron.log');

/**
 * Where the shell remembers the endpoint of the harness it last started:
 * the URL and its plain launch token, written unencrypted. On the next
 * start the shell re-reads it and, if that harness is still answering,
 * attaches to it instead of spawning a second one.
 */
const ENDPOINT_FILE = path.join(DATA_DIR, 'harness-endpoint.json');

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

/** A positive integer from the environment, or the fallback. */
function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

/**
 * Device scale factor to force on Chromium, as a string, or null to let the
 * desktop decide.
 *
 * The default is 1: the harness is a text-dense interface, and a 1:1 pixel
 * mapping is what makes it read crisply on a scaled panel rather than being
 * blown up by the compositor. `DSH_ELECTRON_SCALE=auto` hands the choice back
 * to the desktop, and any positive number sets the scale directly.
 */
function envScaleFactor() {
  const raw = (process.env.DSH_ELECTRON_SCALE ?? '1').trim().toLowerCase();
  if (raw === '' || raw === 'auto') return null;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? String(value) : null;
}

/**
 * Effective configuration, read entirely from the environment.
 *
 * @returns {{dshBin: string|null, nodeBin: string|null, command: object|null,
 *   dshHome: string|null, workingDirectory: string, host: string, port: number,
 *   extraArgs: string[], openDevTools: boolean, showTray: boolean,
 *   logLevel: string, scaleFactor: string|null}}
 */
function loadConfig() {
  const dshBin = findDshBin(process.env.DSH_BIN ?? null);
  const nodeBin = findNodeBin();

  const extraArgs = (process.env.DSH_ELECTRON_ARGS ?? '')
    .split(' ')
    .map((value) => value.trim())
    .filter((value) => value !== '');

  return {
    logFile: LOG_FILE,
    endpointFile: ENDPOINT_FILE,
    appRoot: APP_ROOT,
    dshBin,
    nodeBin,
    command: resolveDshCommand(dshBin, nodeBin),
    dshHome: process.env.DSH_HOME ?? null,
    workingDirectory: process.env.DSH_ELECTRON_CWD ?? defaultWorkingDirectory(),
    host: process.env.DSH_ELECTRON_HOST ?? '127.0.0.1',
    // A stable port keeps the browser origin constant, which is what
    // localStorage is keyed on; `choosePort` falls back to an OS-assigned free
    // port only when this one is already taken. Port 0 always asks the OS.
    port: envInt('DSH_ELECTRON_PORT', 3080),
    // When off (`DSH_ELECTRON_ATTACH=0`) the shell never re-attaches to a
    // running harness and always stops the one it spawned on quit.
    attach: process.env.DSH_ELECTRON_ATTACH !== '0',
    extraArgs,
    openDevTools: process.env.DSH_ELECTRON_DEVTOOLS === '1',
    showTray: process.env.DSH_ELECTRON_TRAY !== '0',
    logLevel: process.env.DSH_ELECTRON_DEBUG === '1' ? 'debug' : 'info',
    scaleFactor: envScaleFactor(),
  };
}

module.exports = {
  APP_ROOT,
  DATA_DIR,
  LOG_FILE,
  loadConfig,
  envScaleFactor,
  findDshBin,
  findNodeBin,
  defaultWorkingDirectory,
};
