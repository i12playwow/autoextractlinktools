// src/main.js
//
// Electron main process entrypoint for autoextractlinktools.
//
// This file runs a minimal localhost HTTP bridge so the Chrome extension and
// userscript can POST extracted links to the desktop app at
// http://localhost:3456/ by default.
//
// Current responsibilities:
//   - Bootstrap the Electron app and open a renderer window (src/renderer/)
//     that shows a live list of links received by the bridge.
//   - Start a tiny HTTP server on the configured port.
//   - Accept POST requests with JSON link payloads, validate them, keep a
//     bounded backlog, and broadcast each payload to the window via IPC so
//     the UI updates live.
//   - Persist received payloads to a JSON file in the app's userData
//     directory (override with AUTOEXTRACT_DATA_DIR) so history survives app
//     restarts. Writes are atomic (tmp + rename) and debounced; see
//     src/storage.js.
//   - Stop the bridge exactly once before the app quits.
//
// Not implemented yet:
//   - Auth, rate limiting, or request validation beyond basic payload checks.
//
// Plain Node safety:
//   - Requiring this module without the Electron runtime is safe and inert:
//     the bootstrap is skipped, and the window/IPC helpers no-op when the
//     Electron objects are absent. This is what makes the in-process bridge
//     tests possible.
//
// Default bridge target:
//   - http://localhost:3456/  (matches the extension manifest host_permissions)
//
// Shutdown note:
//   - The bridge is stopped once in the will-quit handler.
//   - window-all-closed is left as an explicit app lifecycle note, not a second
//     informal stop path.
//
// Exports (test-only):
//   - createBridgeServer: exposed so test-desktop-bridge-edge-cases.js can run
//     the real bridge logic in-process without spawning Electron.
//   - stopBridgeForTests: flips the internal shuttingDown flag so tests can
//     exercise the 503 shutdown response path. It never touches the app-level
//     server reference, so requiring this module under plain Node is inert.

'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const http = require('http');
const path = require('path');

const { PayloadStore } = require('./storage');

const BRIDGE_PORT = parseInt(process.env.AUTOEXTRACT_BRIDGE_PORT || '3456', 10);
const BRIDGE_HOST = '127.0.0.1';

// Backlog + persistence limit (newest kept). The renderer pulls this on load
// so the window shows history, including anything that arrived before it
// attached; afterwards it receives payloads live over IPC.
const PAYLOAD_BACKLOG_LIMIT = 200;
let payloadBacklog = [];

// Persistent history store. Created in main() once the data directory is
// known; null under plain Node (tests) where persistence is not wired.
let payloadStore = null;

let server = null;
let shuttingDown = false;
let mainWindow = null;

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

      handleValidPayload(payload);

      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ ok: true, received: true }));
    });
  });
}

function respondBad(request, response, status, message) {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ error: message }));
}

// Broadcast a payload to every live renderer window. No-op without Electron.
function broadcastToWindows(channel, data) {
  if (!BrowserWindow || typeof BrowserWindow.getAllWindows !== 'function') {
    return;
  }
  BrowserWindow.getAllWindows().forEach(function (win) {
    if (win && !win.isDestroyed()) {
      win.webContents.send(channel, data);
    }
  });
}

// Record a validated payload for the UI: bounded backlog + live broadcast +
// persisted history. Safe to call under plain Node (no Electron): the backlog
// still records so tests share one code path, and the broadcast no-ops.
function handleValidPayload(payload) {
  var record = {
    receivedAt: new Date().toISOString(),
    links: payload.links,
    detected: payload.detected || null,
    sources: Array.isArray(payload.sources) ? payload.sources : [],
    pageUrl: payload.pageUrl || null,
    pageTitle: payload.pageTitle || null
  };

  payloadBacklog.push(record);
  if (payloadBacklog.length > PAYLOAD_BACKLOG_LIMIT) {
    payloadBacklog.shift();
  }

  if (payloadStore) {
    payloadStore.appendPayload(record);
  }

  broadcastToWindows('autoextract:payload', record);
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

// Test-only hook: flips the shuttingDown flag so the 503 shutdown path can be
// exercised in-process. Does not stop or reference the app-level server.
function stopBridgeForTests() {
  shuttingDown = true;
}

// ---------------------------------------------------------------------------
// Renderer window + IPC
// ---------------------------------------------------------------------------

function registerIpc() {
  // Renderer asks for everything received so far (history that predates the
  // window). Returns a copy so the renderer cannot mutate the backlog.
  ipcMain.handle('autoextract:getBacklog', function () {
    return payloadBacklog.slice();
  });

  // Renderer clear button: empty the backlog AND the persisted history file.
  // The renderer also clears its own view; live payloads keep flowing
  // afterwards.
  ipcMain.handle('autoextract:clearBacklog', function () {
    payloadBacklog.length = 0;
    if (payloadStore) {
      payloadStore.clear();
      payloadStore.flushNow();
    }
  });
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 780,
    height: 540,
    minWidth: 440,
    minHeight: 340,
    title: 'AutoExtract Link Tools',
    backgroundColor: '#11151c',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.setMenuBarVisibility(false);

  mainWindow.webContents.on('did-finish-load', function () {
    // Marker consumed by run-desktop-bridge.js to verify window load.
    console.log('DESKTOP_WINDOW_READY');
  });

  // Forward renderer console output to stdout: warnings/errors always, plus
  // the renderer's AutoExtract-prefixed lifecycle lines that the smoke test
  // greps for.
  mainWindow.webContents.on('console-message', function (event, level, message, line, sourceId) {
    if (level >= 2) {
      console.log('[renderer:' + level + ']', message, '(' + sourceId + ':' + line + ')');
    } else if (typeof message === 'string' && message.indexOf('AutoExtract renderer:') === 0) {
      console.log('[renderer]', message);
    }
  });

  mainWindow.on('closed', function () {
    mainWindow = null;
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

(function main() {
  // Under plain Node (no Electron runtime), require('electron') does not
  // provide an app object. Skip the bootstrap so the module can be required
  // safely by tests; behavior under Electron is unchanged.
  if (!app || typeof app.whenReady !== 'function') {
    return;
  }

  registerIpc();

  app.whenReady().then(function () {
    console.log('autoextractlinktools desktop app ready.');

    // Persistent history: <userData>/autoextract-history.json by default,
    // overridable for tests/portable installs via AUTOEXTRACT_DATA_DIR.
    var dataDir = process.env.AUTOEXTRACT_DATA_DIR || app.getPath('userData');
    payloadStore = new PayloadStore({
      filePath: path.join(dataDir, 'autoextract-history.json')
    });
    // The bridge and window start only after history is loaded, so an early
    // POST can never be recorded and then clobbered by the file contents.
    payloadStore.load().then(function (restored) {
      payloadBacklog = restored.slice(-PAYLOAD_BACKLOG_LIMIT);
      console.log('AutoExtract desktop restored ' + payloadBacklog.length + ' persisted payload(s).');
      startBridge();
      createMainWindow();
    });
  });

  app.on('window-all-closed', function () {
    // Explicit lifecycle note: on non-macOS we quit when all windows are closed.
    // The actual bridge stop happens once in will-quit.
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  app.on('activate', function () {
    // macOS: re-create the window when the dock icon is clicked.
    if (mainWindow === null) {
      createMainWindow();
    }
  });

  app.on('will-quit', function () {
    stopBridge();
    if (payloadStore) {
      // Synchronous, atomic final flush so nothing received since the last
      // debounce window is lost on quit.
      payloadStore.dispose();
      payloadStore.flushNow();
      payloadStore = null;
    }
  });
})();

module.exports = {
  createBridgeServer: createBridgeServer,
  stopBridgeForTests: stopBridgeForTests
};
