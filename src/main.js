// src/main.js
//
// Electron main process entrypoint for autoextractlinktools.
//
// This file adds a minimal localhost HTTP bridge so the Chrome extension and
// userscript can POST extracted links to the desktop app at
// http://localhost:3456/ by default.
//
// Current responsibilities:
//   - Bootstrap the Electron app.
//   - Start a tiny HTTP server on the configured port.
//   - Accept POST requests with JSON link payloads and log them.
//
// Not implemented yet:
//   - Persistent storage, UI, IPC channels, or a renderer window.
//   - Auth, request validation beyond basic JSON parsing, and graceful shutdown
//     beyond process exit.
//
// Default bridge target:
//   - http://localhost:3456/  (matches the extension manifest host_permissions)

'use strict';

const { app } = require('electron');
const http = require('http');

const BRIDGE_PORT = parseInt(process.env.AUTOEXTRACT_BRIDGE_PORT || '3456', 10);
const BRIDGE_HOST = '127.0.0.1';

let server = null;

function createBridgeServer() {
  return http.createServer((request, response) => {
    const url = request.url || '/';
    const method = request.method || 'GET';

    // Only expose a simple POST endpoint for link payloads.
    if (method !== 'POST' || url !== '/') {
      response.writeHead(404, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: 'not found' }));
      return;
    }

    let body = '';

    request.on('data', (chunk) => {
      body += chunk.toString();
    });

    request.on('end', () => {
      let payload = null;

      try {
        payload = JSON.parse(body);
      } catch (error) {
        response.writeHead(400, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: 'invalid json' }));
        return;
      }

      if (!payload || typeof payload !== 'object') {
        response.writeHead(400, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: 'invalid payload' }));
        return;
      }

      console.log('AutoExtract desktop received payload:', JSON.stringify(payload, null, 2));

      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ ok: true, received: true }));
    });
  });
}

function startBridge() {
  server = createBridgeServer();

  server.listen(BRIDGE_PORT, BRIDGE_HOST, () => {
    console.log('AutoExtract desktop bridge listening on http://' + BRIDGE_HOST + ':' + BRIDGE_PORT + '/');
  });

  server.on('error', (error) => {
    console.error('AutoExtract desktop bridge failed to start:', error.message);
  });
}

function stopBridge() {
  if (server) {
    server.close(() => {
      console.log('AutoExtract desktop bridge stopped.');
      server = null;
    });
  }
}

(function main() {
  app.whenReady().then(() => {
    console.log('autoextractlinktools desktop app ready.');

    startBridge();
  });

  app.on('window-all-closed', () => {
    // TODO: decide whether the app should quit when all windows are closed.
    if (process.platform !== 'darwin') {
      stopBridge();
      app.quit();
    }
  });

  app.on('activate', () => {
    // TODO: re-create windows if needed on macOS.
  });

  app.on('will-quit', () => {
    stopBridge();
  });
})();
