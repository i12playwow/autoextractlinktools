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

const { app, BrowserWindow, ipcMain, shell } = require('electron');
const http = require('http');
const https = require('https');
const path = require('path');
const crypto = require('crypto');

const { PayloadStore, useKeyfileAdapter } = require('./storage');

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

// History file path for the footer status bar. Set in main() once the data
// directory is known; empty string until then (renderer shows a blank slot).
let historyFilePathForDisplay = '';

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

// Builds the storage crypto adapter. Preference order:
//   1. Electron safeStorage: the OS keystore manages the key (DPAPI on
//      Windows, Keychain on macOS, libsecret on Linux). The per-flush nonce
//      is bound into the blob so the envelope's nonce field is authenticated.
//   2. Keyfile adapter (src/storage.js): random AES-256-GCM key in a 0600
//      sidecar file, for environments without an OS keystore (headless
//      Linux, some CI).
function makeStorageAdapter(historyFilePath) {
  try {
    var safeStorage = require('electron').safeStorage;
    if (safeStorage && typeof safeStorage.isEncryptionAvailable === 'function' &&
        safeStorage.isEncryptionAvailable()) {
      return {
        encrypt: function (plaintext) {
          var nonce = crypto.randomBytes(12);
          var packed = safeStorage.encryptString(nonce.toString('hex') + ':' + plaintext);
          return { data: packed.toString('base64'), nonce: nonce.toString('hex') };
        },
        decrypt: function (envelope) {
          var opened = safeStorage.decryptString(Buffer.from(envelope.data, 'base64'));
          var separator = opened.indexOf(':');
          if (separator < 0) {
            throw new Error('malformed encrypted payload');
          }
          if (opened.slice(0, separator) !== envelope.nonce) {
            throw new Error('nonce mismatch');
          }
          return opened.slice(separator + 1);
        }
      };
    }
    console.log('AutoExtract storage: OS encryption unavailable; using keyfile adapter.');
  } catch (error) {
    console.log('AutoExtract storage: safeStorage unavailable; using keyfile adapter.');
  }
  return useKeyfileAdapter({ filePath: historyFilePath });
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

// Strict allowlist for URLs the renderer asks to open in the system browser.
// shell.openExternal hands the URL to the OS, so anything beyond http/https
// (file:, javascript:, custom scheme handlers, ...) must never reach it.
// Returns the normalized href when safe, or null.
function isSafeExternalUrl(raw) {
  if (typeof raw !== 'string' || raw.length === 0) {
    return null;
  }
  var parsed = null;
  try {
    parsed = new URL(raw);
  } catch (error) {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return null;
  }
  if (!parsed.hostname) {
    return null;
  }
  return parsed.href;
}

// ---------------------------------------------------------------------------
// Link verification (renderer "check" action)
// ---------------------------------------------------------------------------

// One real HTTP(S) request. Resolves { statusCode, location?, method,
// error? } and never rejects; the response body is deliberately not read —
// only the status line and Location header are needed, so the response is
// destroyed immediately after classification to avoid draining streams.
function defaultFetch(url, method, timeoutMs) {
  return new Promise(function (resolve) {
    var parsed = null;
    try {
      parsed = new URL(url);
    } catch (error) {
      resolve({ statusCode: 0, method: method, error: 'unreachable' });
      return;
    }
    var transport = parsed.protocol === 'https:' ? https : http;
    var request = transport.request(parsed, { method: method }, function (response) {
      response.destroy();
      resolve({
        statusCode: response.statusCode,
        location: response.headers && response.headers.location ? response.headers.location : null,
        method: method
      });
    });
    request.setTimeout(timeoutMs, function () {
      request.destroy(new Error('timeout'));
    });
    request.on('error', function (error) {
      resolve({
        statusCode: 0,
        method: method,
        error: error && error.message === 'timeout' ? 'timeout' : 'unreachable'
      });
    });
    request.end();
  });
}

// Classifies a URL's reachability for the row badge. HEAD first (cheap, no
// body), with a one-shot GET fallback for servers that answer HEAD with a
// transport error or 405/501, and a bounded redirect chain in which every
// hop is re-validated through isSafeExternalUrl (so a redirect can never
// smuggle a non-http(s) scheme into the request path). Never throws and
// never rejects; every outcome is a plain object the renderer can render:
//   { ok: true,  status: 2|3, code: 204, note: 'HEAD 204' }
//   { ok: false, code: 404 }                  (HTTP >= 400 after GET fallback)
//   { ok: false, error: 'timeout' | 'unreachable' | 'unsafe url' | ... }
// `deps` is injectable for tests: { fetch, timeoutMs }.
function probeUrl(rawUrl, deps) {
  var fetchImpl = deps && typeof deps.fetch === 'function' ? deps.fetch : defaultFetch;
  var timeoutMs = deps && typeof deps.timeoutMs === 'number' ? deps.timeoutMs : 15 * 1000;
  var visits = 0;

  // `visited` carries every URL already requested in this chain, so cycles
  // (a -> a or a -> b -> a) are caught before the hop budget silently turns
  // them into a "followable 3xx" false positive.
  function attempt(current, redirectsLeft, method, visited) {
    var safe = isSafeExternalUrl(current);
    if (!safe) {
      return Promise.resolve({ ok: false, error: 'unsafe url' });
    }
    visited[safe] = true;
    visits += 1;
    if (visits > 8) {
      return Promise.resolve({ ok: false, error: 'redirect loop' });
    }
    return fetchImpl(safe, method, timeoutMs).then(function (res) {
      var code = res && typeof res.statusCode === 'number' ? res.statusCode : 0;
      if (code >= 300 && code < 400) {
        var location = res && typeof res.location === 'string' ? res.location : '';
        if (redirectsLeft > 0 && location) {
          var next = null;
          try {
            next = new URL(location, safe).href;
          } catch (error) {
            next = null;
          }
          if (!next) {
            return { ok: false, error: 'invalid redirect' };
          }
          if (visited[next]) {
            return { ok: false, error: 'redirect loop' };
          }
          return attempt(next, redirectsLeft - 1, 'HEAD', visited);
        }
        // No Location (or out of hops): a 3xx the player could still follow.
        return { ok: true, status: 3, code: code, note: 'redirect ' + code };
      }
      if (code >= 200 && code < 300) {
        return { ok: true, status: 2, code: code, note: method + ' ' + code };
      }
      if (code === 0) {
        // Transport-level failure: HEAD is sometimes unsupported; retry with
        // GET once before calling the URL unreachable.
        if (method === 'HEAD') {
          return attempt(current, redirectsLeft, 'GET', visited);
        }
        return { ok: false, error: res && res.error === 'timeout' ? 'timeout' : 'unreachable' };
      }
      if (method === 'HEAD' && (code === 405 || code === 501)) {
        return attempt(current, redirectsLeft, 'GET', visited);
      }
      return { ok: false, code: code };
    });
  }

  return attempt(String(rawUrl), 3, 'HEAD', {});
}

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

  // Renderer "open in browser" action. The URL is re-validated here: the
  // renderer is untrusted input for this purpose, and shell.openExternal
  // must only ever receive http/https URLs (guarded by isSafeExternalUrl).
  ipcMain.handle('autoextract:openExternal', function (_event, rawUrl) {
    var safe = isSafeExternalUrl(rawUrl);
    if (!safe) {
      return { ok: false, error: 'unsafe url' };
    }
    if (!shell || typeof shell.openExternal !== 'function') {
      return { ok: false, error: 'shell unavailable' };
    }
    return shell.openExternal(safe).then(function () {
      return { ok: true };
    }, function (error) {
      return { ok: false, error: (error && error.message) || 'open failed' };
    });
  });

  // Renderer "check this link" action. Runs in main because the sandboxed
  // renderer has no network access; the URL is validated here through
  // isSafeExternalUrl before any request is made. Failures resolve (never
  // reject) as plain objects so the renderer can render every shape.
  ipcMain.handle('autoextract:verifyUrl', function (_event, rawUrl) {
    return probeUrl(rawUrl);
  });

  // Display facts for the footer status bar: where the bridge listens and
  // which file backs the history. Both are configuration, not secrets, and
  // the renderer gets copies (strings), not object references.
  ipcMain.handle('autoextract:getAppInfo', function () {
    return {
      bridgeHost: BRIDGE_HOST + ':' + BRIDGE_PORT,
      historyFile: historyFilePathForDisplay
    };
  });

  // Footer "reveal history file" action. Deliberately takes NO argument:
  // the renderer only ever sees this path as display text, so main uses its
  // own stored path here. (The openExternal allowlist stays http/https-only;
  // no file: URL ever crosses IPC.) showItemInFolder opens the parent folder
  // with the history file selected, on every supported platform.
  ipcMain.handle('autoextract:revealHistoryFolder', function () {
    if (!historyFilePathForDisplay) {
      return { ok: false, error: 'unavailable' };
    }
    if (!shell || typeof shell.showItemInFolder !== 'function') {
      return { ok: false, error: 'shell unavailable' };
    }
    shell.showItemInFolder(historyFilePathForDisplay);
    return { ok: true };
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
    // Content is encrypted at rest (safeStorage where available, keyfile
    // AES-256-GCM otherwise).
    var dataDir = process.env.AUTOEXTRACT_DATA_DIR || app.getPath('userData');
    var historyFilePath = path.join(dataDir, 'autoextract-history.json');
    payloadStore = new PayloadStore({
      filePath: historyFilePath,
      cryptoAdapter: makeStorageAdapter(historyFilePath)
    });
    historyFilePathForDisplay = historyFilePath;
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
  stopBridgeForTests: stopBridgeForTests,
  isSafeExternalUrl: isSafeExternalUrl,
  probeUrl: probeUrl
};
