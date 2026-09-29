'use strict';

/**
 * Supervisor for the `dsh web` child process.
 *
 * The shell does not reimplement the harness: it boots the user's own `dsh`
 * with the `web` profile and adopts the URL line the harness prints. The
 * printed URL carries a per-process launch token, which the harness exchanges
 * for a signed session cookie on first navigation — so the shell must read the
 * URL rather than compose one from the port.
 *
 * A harness the shell started outlives nothing on its own: the shell records
 * the endpoint it was given (URL and launch token) in a small plain file, and
 * on the next launch it re-reads that record. When the recorded port is still
 * occupied and the saved token still authenticates, the window attaches to the
 * running instance instead of spawning a second harness — and an attached
 * harness is never killed when the shell quits.
 */

const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const http = require('node:http');
const net = require('node:net');

const { readEndpoint, writeEndpoint, clearEndpoint } = require('./endpoint.js');

/** The harness URL line, e.g. `dsh web: http://127.0.0.1:3080/?token=...`. */
const URL_LINE = /dsh web:\s+(https?:\/\/\S+)/;
const ANSI = /\u001B\[[0-9;]*m/g;

/** Strip terminal colour so log lines and the URL regex see plain text. */
function stripAnsi(text) {
  return text.replace(ANSI, '');
}

/**
 * Normalize a printed URL into the exact navigation target.
 *
 * The harness prints a clean URL for the model and an authenticated URL for
 * the operator. Both `?token=…` and (older shapes) `/?token=…` must work, and
 * the LAN suffix the harness appends must not leak into the target.
 */
function parseHarnessUrl(rawLine) {
  const match = URL_LINE.exec(stripAnsi(rawLine));
  if (!match) return null;
  // A bracketed LAN annotation follows the primary URL; drop it.
  const candidate = match[1].replace(/[)\],;]+$/, '');
  let url;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  return url.href;
}

/** Why a boot attempt gave up, so the caller can classify the failure. */
class RuntimeError extends Error {
  constructor(message, kind, detail) {
    super(message);
    this.name = 'RuntimeError';
    this.kind = kind;
    this.detail = detail ?? '';
  }
}

/** Whether nothing is listening on the loopback port already. */
function isPortFree(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, host);
  });
}

/**
 * Choose the port the harness should bind.
 *
 * A stable port matters beyond convenience: the browser origin (scheme, host,
 * and port) is the key for localStorage, so a random port would discard the
 * interface's stored preferences and shortcuts on every launch.
 *
 * A configured port is honoured whenever it is free. When it is taken — a
 * stray `dsh web`, or a second shell the single-instance lock did not catch —
 * the configured value is skipped rather than failing the boot, and the OS
 * picks a free port; the shell reads the real port back from the harness URL.
 *
 * @param {number} configured the user's port, or 0 for "no preference"
 * @returns {Promise<{port: number, requested: number, reused: boolean}>}
 */
async function choosePort(configured, host = '127.0.0.1') {
  if (!Number.isInteger(configured) || configured <= 0) {
    return { port: 0, requested: 0, reused: false };
  }
  if (await isPortFree(configured, host)) {
    return { port: configured, requested: configured, reused: false };
  }
  return { port: 0, requested: configured, reused: true };
}

/**
 * Fetch a URL once and report its HTTP status.
 *
 * Transport failure, timeout, or a non-response all resolve to `0` so callers
 * can tell "nothing answered" from "it answered with a status".
 */
function probeStatus(url, timeoutMs = 3000) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const request = http.get(url, { timeout: timeoutMs }, (response) => {
      response.resume();
      done(response.statusCode ?? 0);
    });
    request.on('timeout', () => {
      request.destroy();
      done(0);
    });
    request.on('error', () => done(0));
  });
}

/**
 * Wait until the harness answers on its own URL.
 *
 * A token-bearing index request returns either the page, a redirect to the
 * clean URL, or 401 when the token has already been exchanged. All three prove
 * the server is up; a transport error means it is not there yet.
 */
function probe(url, timeoutMs = 3000) {
  return probeStatus(url, timeoutMs).then((status) => status >= 200 && status < 500);
}

async function waitForServer(url, { attempts = 60, delayMs = 500, shouldAbort } = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (shouldAbort && shouldAbort()) return false;
    if (await probe(url)) return true;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return false;
}

/**
 * Owns exactly one `dsh web` process at a time.
 *
 * @fires RuntimeManager#ready with the authenticated URL
 * @fires RuntimeManager#exit with `{code, signal, expected}`
 * @fires RuntimeManager#failed with a {@link RuntimeError}
 * @fires RuntimeManager#log with each output line
 */
class RuntimeManager extends EventEmitter {
  /**
   * @param {object} config resolved shell configuration
   * @param {import('./logger.js').Logger} logger
   */
  constructor(config, logger) {
    super();
    this.config = config;
    this.logger = logger;
    this.child = null;
    this.url = null;
    // True when this instance adopted a running harness instead of spawning it.
    // An attached harness is somebody else's process: never signalled, never
    // restarted, and its endpoint record is left in place for the next launch.
    this.attached = false;
    // Set by the Restart action to skip the attach check for one start.
    this.forceFresh = false;
    this.starting = false;
    this.stopping = false;
    this.restarts = 0;
    this.restartTimer = null;
    this.maxRestarts = 5;
  }

  get running() {
    return this.attached || (this.child !== null && this.child.exitCode === null);
  }

  /**
   * Command line for the harness, as an argv array (never a shell string).
   *
   * `--no-open` is mandatory: the harness would otherwise hand the URL to the
   * default browser, so every launch would open a second, redundant browser
   * window next to this application's own window.
   * @param {number} port the port resolved for this boot
   * @returns {{command: string, args: string[]}}
   */
  buildCommand(port) {
    const { command, args } = this.config.command;
    const argv = [
      ...args,
      'web',
      '--host', this.config.host,
      '--port', String(port),
      '--no-open',
    ];
    argv.push(...this.config.extraArgs);
    return { command, args: argv };
  }

  /** Environment for the child: the operator's own, minus Electron-specific keys. */
  buildEnv() {
    const env = { ...process.env };
    // Electron leaks these into children and they confuse a plain Node runtime.
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.ELECTRON_NO_ATTACH_CONSOLE;
    if (this.config.dshHome) env.DSH_HOME = this.config.dshHome;
    return env;
  }

  /** Boot the harness once and resolve with its authenticated URL. */
  start() {
    if (this.starting) return this.startPromise;
    if (this.running && this.url) return Promise.resolve(this.url);
    if (this.config.command === null) {
      const error = new RuntimeError(
        'The `dsh` command was not found.',
        'missing-dsh',
        'Install it with `npm install -g @deepseek-ai/dsh`, or point the shell at it with DSH_BIN.',
      );
      this.emit('failed', error);
      return Promise.reject(error);
    }

    this.starting = true;
    this.startPromise = this.begin();
    return this.startPromise;
  }

  /**
   * Prefer attaching to a running harness from the endpoint record; otherwise
   * spawn a fresh one. `forceFresh` (set by the Restart action) skips attach
   * once, so "Restart Harness" always means "boot a new one".
   */
  async begin() {
    try {
      const url = await this.tryAttach();
      if (url !== null) return url;
    } catch (error) {
      this.logger.warn('runtime', `attach check failed: ${error.message}; spawning a new harness`);
    } finally {
      this.forceFresh = false;
    }
    return this.spawnHarness();
  }

  /**
   * Reopen the harness recorded on a previous launch, if it is still alive
   * and the saved launch token still authenticates against it.
   *
   * Resolves to the authenticated URL when attached, or null when there is
   * nothing to attach to. Only `dsh web` answers the token-bearing index URL
   * with 2xx/3xx; 401 means a different process owns the port, and any
   * transport error means the recorded harness is gone. Both cases fall
   * through to a fresh spawn below.
   */
  async tryAttach() {
    if (!this.config.attach || this.forceFresh) return null;
    const record = readEndpoint(this.config.endpointFile);
    if (record === null) return null;

    const status = await probeStatus(record.url, 2000);
    if (status >= 200 && status < 400) {
      this.attached = true;
      this.url = record.url;
      this.boundPort = record.port;
      this.logger.info('runtime', `attaching to running harness at port ${record.port}`);
      this.starting = false;
      this.emit('ready', record.url);
      return record.url;
    }
    if (status === 401) {
      this.logger.info('runtime', `port ${record.port} answers, but not to the saved token; starting a new harness`);
      return null;
    }
    this.logger.info('runtime', `recorded harness on port ${record.port} is gone; starting a new one`);
    clearEndpoint(this.config.endpointFile);
    return null;
  }

  /** Resolve the port, then own one harness process for it. */
  async spawnHarness() {
    let chosen;
    try {
      chosen = await choosePort(this.config.port, this.config.host);
    } catch {
      chosen = { port: this.config.port, requested: this.config.port, reused: false };
    }
    this.boundPort = chosen.port;
    if (chosen.reused) {
      this.logger.warn('runtime', `port ${chosen.requested} is already in use; asking the OS for a free port`);
    }

    const { command, args } = this.buildCommand(chosen.port);
    this.logger.info('runtime', `spawning: ${command} ${args.join(' ')}`);
    this.logger.info('runtime', `cwd: ${this.config.workingDirectory}`);

    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        this.starting = false;
        fn(value);
      };

      let child;
      try {
        child = spawn(command, args, {
          cwd: this.config.workingDirectory,
          env: this.buildEnv(),
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        });
      } catch (error) {
        const failure = new RuntimeError(`Could not start the harness: ${error.message}`, 'spawn', '');
        this.emit('failed', failure);
        finish(reject, failure);
        return;
      }

      this.child = child;
      let buffer = '';
      let stderrTail = '';
      let urlSeen = false;

      const consume = (chunk, isError) => {
        const text = stripAnsi(chunk.toString('utf8'));
        buffer += text;
        if (isError) stderrTail = (stderrTail + text).slice(-4000);
        this.emit('log', { text, isError });

        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (line.trim() === '') continue;
          this.logger.info(isError ? 'harness:err' : 'harness', line);
          if (urlSeen) continue;
          const url = parseHarnessUrl(line);
          if (url === null) continue;
          urlSeen = true;
          this.attached = false;
          this.url = url;
          this.logger.info('runtime', `harness endpoint: ${url}`);
          // Save the endpoint so the next launch can reopen this very
          // instance instead of booting a second harness.
          writeEndpoint(this.config.endpointFile, { url });
          waitForServer(url, { shouldAbort: () => this.stopping })
            .then((alive) => {
              if (!alive && !this.stopping) {
                const failure = new RuntimeError(
                  'The harness printed a URL but never answered on it.',
                  'unreachable',
                  stderrTail,
                );
                this.emit('failed', failure);
                finish(reject, failure);
                return;
              }
              if (this.stopping) return;
              this.restarts = 0;
              this.emit('ready', url);
              finish(resolve, url);
            })
            .catch((error) => finish(reject, error));
        }
      };

      child.stdout?.on('data', (chunk) => consume(chunk, false));
      child.stderr?.on('data', (chunk) => consume(chunk, true));

      child.on('error', (error) => {
        this.logger.error('runtime', `spawn error: ${error.message}`);
        const failure = new RuntimeError(`Could not start the harness: ${error.message}`, 'spawn', '');
        this.emit('failed', failure);
        finish(reject, failure);
      });

      const bootTimer = setTimeout(() => {
        if (settled || this.stopping) return;
        const failure = new RuntimeError(
          'The harness did not report an endpoint within 120 seconds.',
          'timeout',
          stderrTail,
        );
        this.logger.error('runtime', failure.message);
        this.emit('failed', failure);
        finish(reject, failure);
        this.stop('boot-timeout');
      }, 120_000);
      bootTimer.unref?.();

      child.on('exit', (code, signal) => {
        clearTimeout(bootTimer);
        const expected = this.stopping;
        this.logger.warn('runtime', `harness exited (code=${code ?? 'null'} signal=${signal ?? 'null'} expected=${expected})`);
        this.child = null;
        this.url = null;
        this.starting = false;
        // The record names this child; once it is gone the record is stale.
        clearEndpoint(this.config.endpointFile);

        if (!settled) {
          const failure = new RuntimeError(
            `The harness exited before it was ready (code ${code ?? 'null'}).`,
            'early-exit',
            stderrTail,
          );
          this.emit('failed', failure);
          finish(reject, failure);
        }
        this.emit('exit', { code, signal, expected });
        if (!expected) this.scheduleRestart();
      });
    });
  }

  /** Restart after an unexpected crash, with a bounded, backing-off schedule. */
  scheduleRestart() {
    if (this.stopping || this.restartTimer !== null) return;
    if (this.restarts >= this.maxRestarts) {
      this.logger.error('runtime', `giving up after ${this.restarts} restarts`);
      this.emit('failed', new RuntimeError(
        `The harness crashed ${this.restarts} times in a row and was not restarted again.`,
        'crash-loop',
        '',
      ));
      return;
    }
    this.restarts += 1;
    const delay = Math.min(1000 * 2 ** (this.restarts - 1), 15_000);
    this.logger.warn('runtime', `restarting in ${delay}ms (attempt ${this.restarts}/${this.maxRestarts})`);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.start().catch(() => {
        /* A failed restart schedules its own next attempt through `exit`. */
      });
    }, delay);
    this.restartTimer.unref?.();
  }

  /** Terminate the child: SIGTERM, then SIGKILL when it ignores the first. */
  stop(reason = 'shutdown') {
    this.stopping = true;
    if (this.restartTimer !== null) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    // An attached harness belongs to someone else: detach, never kill it, and
    // keep its record so the next launch can find it again.
    if (this.attached) {
      this.logger.info('runtime', `detaching from foreign harness (${reason}); leaving it running`);
      this.attached = false;
      this.url = null;
      this.stopping = false;
      return Promise.resolve();
    }
    const child = this.child;
    if (child === null || child.exitCode !== null) return Promise.resolve();

    this.logger.info('runtime', `stopping harness (${reason})`);
    return new Promise((resolve) => {
      const force = setTimeout(() => {
        this.logger.warn('runtime', 'harness ignored SIGTERM; sending SIGKILL');
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }, 6000);
      force.unref?.();
      child.once('exit', () => {
        clearTimeout(force);
        resolve();
      });
      try {
        child.kill('SIGTERM');
      } catch {
        clearTimeout(force);
        resolve();
      }
    });
  }
}

module.exports = {
  RuntimeManager,
  RuntimeError,
  parseHarnessUrl,
  stripAnsi,
  waitForServer,
  probe,
  probeStatus,
};