// src/main.js
//
// Electron main process entrypoint for autoextractlinktools.
//
// This file runs a minimal localhost HTTP bridge so the Chrome extension and
// userscript can POST extracted links to the desktop app at
// http://localhost:3456/ by default.
//
// Current responsibilities:
//   - Bootstrap the Electron app.
//   - Start a tiny HTTP server on the configured port.
//   - Accept POST requests with JSON link payloads and log them.
//   - Stop the bridge exactly once before the app quits.
//
// Not implemented yet:
//   - Persistent storage, UI, IPC channels, or a renderer window.
//   - Auth, rate limiting, or request validation beyond basic payload checks.
//
// Default bridge target:
//   - http://localhost:3456/  (matches the extension manifest host_permissions)
//
// Shutdown note:
//   - The bridge is stopped once in the will-quit handler.
//   - window-all-closed is left as an explicit app lifecycle note, not a second
//     informal stop path.

'use strict';

const { app } = require('electron');
const http = require('http');

const BRIDGE_PORT = parseInt(process.env.AUTOEXTRACT_BRIDGE_PORT || '3456', 10);
const BRIDGE_HOST = '127.0.0.1';

let server = null;
let shuttingDown = false;

function isValidLinkPayload(payload) {
  if (!payload || typeof payload !== 'object') {
    return false;
  }

  var links = payload.links;
  if (!Array.isArray(links)) {
    return false;
  }

  for (var i = 0; i < links.length; i++) {
    var link = links[i];
    if (!link || typeof link !== 'object') {
      return false;
    }
    if (typeof link.url !== 'string' || link.url.length === 0) {
      return false;
    }
  }

  return true;
}

function createBridgeServer() {
  return http.createServer(function (request, response) {
    var url = request.url || '/';
    var method = request.method || 'GET';

    if (method !== 'POST' || url !== '/') {
      response.writeHead(404, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: 'not found', method: 'POST / required' }));
      return;
    }

    var body = '';

    request.on('data', function (chunk) {
      body += chunk.toString();
    });

    request.on('end', function () {
      if (shuttingDown) {
        respondBad(request, response, 503, 'bridge shutting down');
        return;
      }

      var payload = null;

      try {
        payload = JSON.parse(body);
      } catch (error) {
        respondBad(request, response, 400, 'invalid json');
        return;
      }

      if (!isValidLinkPayload(payload)) {
        respondBad(request, response, 400, 'invalid payload');
        return;
      }

      console.log(
        'AutoExtract desktop received payload:',
        JSON.stringify({
          links: payload.links.length,
          detected: payload.detected || null,
          pageUrl: payload.pageUrl || null,
          pageTitle: payload.pageTitle || null
        })
      );

      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ ok: true, received: true }));
    });
  });
}

function respondBad(request, response, status, message) {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ error: message }));
}

function startBridge() {
  server = createBridgeServer();

  server.listen(BRIDGE_PORT, BRIDGE_HOST, function () {
    console.log('AutoExtract desktop bridge listening on http://' + BRIDGE_HOST + ':' + BRIDGE_PORT + '/');
  });

  server.on('error', function (error) {
    console.error('AutoExtract desktop bridge failed to start:', error.message);
  });
}

function stopBridge() {
  if (!server) {
    return;
  }

  shuttingDown = true;

  server.close(function () {
    console.log('AutoExtract desktop bridge stopped.');
    server = null;
  });

  // Forcefully close lingering connections if the server does not close fast
  // enough during shutdown.
  if (server) {
    server.getConnections(function (error, count) {
      if (error) {
        return;
      }
      if (count > 0) {
        console.log('AutoExtract desktop bridge had', count, 'open connection(s) during shutdown.');
      }
    });
  }
}

(function main() {
  app.whenReady().then(function () {
    console.log('autoextractlinktools desktop app ready.');
    startBridge();
  });

  app.on('window-all-closed', function () {
    // Explicit lifecycle note: on non-macOS we quit when all windows are closed.
    // The actual bridge stop happens once in will-quit.
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  app.on('activate', function () {
    // TODO: re-create windows if needed on macOS.
  });

  app.on('will-quit', function () {
    stopBridge();
  });
})();
