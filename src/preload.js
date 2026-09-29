'use strict';

/**
 * Preload: the only bridge between the harness page and the desktop shell.
 *
 * The harness already ships a client plugin for native directory selection.
 * It calls `globalThis.__DSH_DIRECTORY_PICKER__.pick()` when a desktop host
 * exposes that global, so the shell exposes exactly that shape and nothing
 * more — no filesystem, no shell, no unbounded IPC surface.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('__DSH_DIRECTORY_PICKER__', {
  /**
   * Open the operating system's directory chooser.
   * @returns {Promise<string|null>} the chosen absolute path, or null on cancel.
   */
  pick: () => ipcRenderer.invoke('dsh:pick-directory'),
});

// A small, explicitly enumerated surface for shell-owned actions. The harness
// page never needs these, but keeping them namespaced avoids collisions.
contextBridge.exposeInMainWorld('__DSH_DESKTOP__', {
  isDesktop: true,
  platform: process.platform,
  restartRuntime: () => ipcRenderer.invoke('dsh:restart-runtime'),
  openLog: () => ipcRenderer.invoke('dsh:open-log'),
  quit: () => ipcRenderer.invoke('dsh:quit'),
  info: () => ipcRenderer.invoke('dsh:info'),
  lastFailure: () => ipcRenderer.invoke('dsh:last-failure'),
});