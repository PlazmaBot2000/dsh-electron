'use strict';

/**
 * Plain store for the harness endpoint: the URL and its launch token.
 *
 * The token is what authenticates the window against `dsh web`, so saving it
 * lets a later launch re-open the same instance instead of booting a second
 * harness. The record is written verbatim, without encryption — it is the same
 * secret the harness prints to stdout and the shell already keeps in its log.
 * The file therefore carries mode 0600: readable only by its owner.
 */

const fs = require('node:fs');
const path = require('node:path');

/**
 * Read the saved endpoint record.
 *
 * @param {string} file absolute path of the record
 * @returns {{url: string, token: string, port: number} | null} null when there
 *   is no record or it cannot be trusted (unreadable, malformed, missing token)
 */
function readEndpoint(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null; // No record yet — the common case on a fresh install.
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return null; // A torn write; treated as absent and replaced on next boot.
  }
  if (
    data === null ||
    typeof data !== 'object' ||
    typeof data.url !== 'string' ||
    typeof data.token !== 'string' ||
    data.token === ''
  ) {
    return null;
  }
  let url;
  try {
    url = new URL(data.url);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  return { url: data.url, token: data.token, port: Number(data.port) || 0 };
}

/**
 * Write the endpoint record atomically with owner-only permissions.
 *
 * A temp file plus rename means a crash mid-write leaves the previous record
 * intact rather than a half-written one.
 *
 * @param {string} file absolute path of the record
 * @param {{url: string}} endpoint the authenticated harness URL
 */
function writeEndpoint(file, endpoint) {
  let url;
  try {
    url = new URL(endpoint.url);
  } catch {
    return;
  }
  const token = url.searchParams.get('token');
  if (!token) return; // A URL without a token cannot authenticate anything.
  const record = {
    url: url.href,
    token,
    port: Number(url.port) || 80,
    savedAt: new Date().toISOString(),
  };
  const tmp = `${file}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch {
    /* A failed write only costs the attach chance on the next launch. */
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* nothing left to clean */
    }
  }
}

/** Remove the record — the endpoint it names no longer exists. */
function clearEndpoint(file) {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    /* An already-absent record is the desired state. */
  }
}

module.exports = { readEndpoint, writeEndpoint, clearEndpoint };
