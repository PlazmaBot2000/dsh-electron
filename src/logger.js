'use strict';

/**
 * Minimal dependency-free logger.
 *
 * Everything the shell writes goes to one file so a failed boot can be
 * diagnosed after the window is gone. The file is capped: when it grows past
 * `maxBytes` it is rotated once to `<file>.1`, so the directory never holds
 * more than two generations.
 */

const fs = require('node:fs');
const path = require('node:path');

const LEVELS = ['debug', 'info', 'warn', 'error'];

function timestamp() {
  return new Date().toISOString();
}

class Logger {
  /**
   * @param {string} file absolute log file path
   * @param {{maxBytes?: number, console?: boolean, level?: string}} [options]
   */
  constructor(file, options = {}) {
    this.file = file;
    this.maxBytes = options.maxBytes ?? 4 * 1024 * 1024;
    this.toConsole = options.console ?? true;
    this.level = LEVELS.includes(options.level) ? options.level : 'debug';

    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
    } catch {
      /* A missing directory is reported by the first write instead. */
    }
  }

  /** Append one raw line, rotating first when the cap is exceeded. */
  write(line) {
    try {
      this.rotateIfNeeded();
      fs.appendFileSync(this.file, line + '\n', 'utf8');
    } catch {
      /* Logging must never take the application down. */
    }
    if (this.toConsole) process.stdout.write(line + '\n');
  }

  rotateIfNeeded() {
    let size = 0;
    try {
      size = fs.statSync(this.file).size;
    } catch {
      return; // No file yet: nothing to rotate.
    }
    if (size < this.maxBytes) return;
    try {
      fs.rmSync(this.file + '.1', { force: true });
      fs.renameSync(this.file, this.file + '.1');
    } catch {
      /* A failed rotation leaves the oversized file in place; writes continue. */
    }
  }

  log(level, scope, message) {
    if (LEVELS.indexOf(level) < LEVELS.indexOf(this.level)) return;
    const text = typeof message === 'string' ? message : String(message);
    const suffix = text.endsWith('\n') ? '' : '';
    this.write(`${timestamp()} [${level}] [${scope}] ${text}${suffix}`);
  }

  debug(scope, message) {
    this.log('debug', scope, message);
  }

  info(scope, message) {
    this.log('info', scope, message);
  }

  warn(scope, message) {
    this.log('warn', scope, message);
  }

  error(scope, message) {
    this.log('error', scope, message);
  }

  /** Last `lines` lines of the log, oldest first — used by the error screen. */
  tail(lines = 40) {
    try {
      const text = fs.readFileSync(this.file, 'utf8');
      const all = text.split('\n').filter((line) => line !== '');
      return all.slice(-lines).join('\n');
    } catch {
      return '(no log yet)';
    }
  }
}

module.exports = { Logger };