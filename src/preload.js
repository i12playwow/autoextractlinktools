// src/preload.js
//
// Preload script for the AutoExtract desktop window.
//
// Runs in a sandboxed, context-isolated bridge between the main process and
// the renderer. Exposes a minimal, explicit API on window.autoextract:
//   - getBacklog(): Promise<PayloadRecord[]>  -> everything received so far
//   - onPayload(callback)                     -> live payloads (returns unsubscribe)
//   - clearBacklog(): Promise<void>           -> clear the main-process backlog
//   - openExternal(url): Promise<{ok, error?}> -> open an http/https URL in
//     the system browser (main re-validates before shell.openExternal)
//   - verifyUrl(url): Promise<result>         -> reachability check for one
//     http/https URL, performed by main (HEAD with GET fallback; see
//     src/main.js). The renderer gets a plain result object, never a raw
//     response or socket. Only main touches the network.
//   - getAppInfo(): Promise<{bridgeHost, historyFile}> -> display facts for
//     the footer status bar (endpoint and history file path). Read-only and
//     resolved once at startup.
//   - revealHistoryFolder(): Promise<{ok, error?}> -> open the history
//     file's folder in the OS file manager (file selected). Takes no
//     argument: main reveals its own stored path, so no file: URL is ever
//     passed over IPC.
//
// The renderer has no Node, no direct ipcRenderer, and no way to invoke any
// other channel: this file is the entire attack surface.

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('autoextract', {
  getBacklog: function () {
    return ipcRenderer.invoke('autoextract:getBacklog');
  },

  onPayload: function (callback) {
    if (typeof callback !== 'function') {
      return function () {};
    }
    var listener = function (_event, record) {
      try {
        callback(record);
      } catch (error) {
        console.error('AutoExtract renderer: payload listener failed.', error);
      }
    };
    ipcRenderer.on('autoextract:payload', listener);
    return function () {
      ipcRenderer.removeListener('autoextract:payload', listener);
    };
  },

  clearBacklog: function () {
    return ipcRenderer.invoke('autoextract:clearBacklog');
  },

  openExternal: function (url) {
    return ipcRenderer.invoke('autoextract:openExternal', url);
  },

  verifyUrl: function (url) {
    return ipcRenderer.invoke('autoextract:verifyUrl', url);
  },

  getAppInfo: function () {
    return ipcRenderer.invoke('autoextract:getAppInfo');
  },

  revealHistoryFolder: function () {
    return ipcRenderer.invoke('autoextract:revealHistoryFolder');
  }
});
