// src/main.js
//
// Electron main process entrypoint for autoextractlinktools.
//
// This file is intentionally a minimal scaffold. The current responsibilities are:
//   - Bootstrap the Electron app.
//   - Document where the localhost bridge and any local state/messaging
//     should live.
//
// What is NOT implemented yet:
//   - The localhost HTTP bridge that the extension and userscript can POST
//     extracted links to.
//   - Any renderer process UI or IPC channels.
//   - Any persistence, logging, or crash handling beyond a basic bootstrap.
//
// Default bridge target for now:
//   - http://localhost:3456/  (matches the extension manifest host_permissions)
//
// TODO:
//   - Decide whether the bridge is an HTTP server, native messaging host,
//     or IPC-based channel.
//   - Decide renderer vs main process responsibilities.
//   - Add error handling, graceful shutdown, and any app-specific lifecycle.

const { app } = require('electron');

(function main() {
  app.whenReady().then(() => {
    // TODO: initialize bridge, windows, and any local services here.
    console.log('autoextractlinktools desktop app ready (scaffold).');
  });

  app.on('window-all-closed', () => {
    // TODO: decide whether the app should quit when all windows are closed.
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  app.on('activate', () => {
    // TODO: re-create windows if needed on macOS.
  });
})();
