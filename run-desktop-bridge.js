#!/usr/bin/env node
// run-desktop-bridge.js
//
// Starts the real Electron desktop bridge from src/main.js using the Electron
// runtime installed in node_modules, then validates that it accepts a POST and
// replies {ok:true,received:true}.
//
// Also verifies the renderer window path and persistence end-to-end:
//   - DESKTOP_WINDOW_READY marker on window load
//   - renderer reports the backlog pull ('AutoExtract renderer: ready with N')
//   - a POST made after the window is up arrives live in the renderer via IPC
//     ('AutoExtract renderer: showing payload from ...')
//   - persistence: the app runs TWICE against the same AUTOEXTRACT_DATA_DIR;
//     the second run must restore the first run's payloads into the renderer
//     backlog (history survived the restart).
//
// This is a concrete end-to-end check of the Electron desktop process, the
// localhost POST contract, the renderer link list, and the JSON persistence
// layer, using the actual repo entrypoint rather than a mirror.
//
// Caveats:
//   - This does not load the Chrome extension.
//   - It assumes node_modules/electron is installed and runnable.
//   - It is meant as a desktop process smoke test, not a full extension test.

'use strict';

const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

const APP_ROOT = path.resolve(__dirname);
const SRC_MAIN = path.resolve(APP_ROOT, 'src', 'main.js');
const ELECTRON_CLI = path.resolve(APP_ROOT, 'node_modules', 'electron', 'cli.js');

const PORT = parseInt(process.env.AUTOEXTRACT_DESKTOP_TEST_PORT || '3459', 10);
const HOST = '127.0.0.1';
const BRIDGE_URL = 'http://' + HOST + ':' + PORT + '/';

function makePayload(links) {
  return {
    detected: { supported: true, type: 'stub', markerCount: links.length },
    links: links,
    sources: [{ element: 'div', attributes: ['data-autoextract', 'data-autoextract-url'] }],
    pageUrl: 'http://localhost:9999/test',
    pageTitle: 'Test Page',
    sentAt: new Date().toISOString()
  };
}

function requestJSON(method, pathName, body) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: HOST,
      port: PORT,
      path: pathName,
      method: method,
      headers: {
        'Content-Type': 'application/json'
      }
    };

    if (body !== undefined && body !== null) {
      const raw = typeof body === 'string' ? body : JSON.stringify(body);
      options.headers['Content-Length'] = Buffer.byteLength(raw);
    }

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk.toString();
      });
      res.on('end', () => {
        let parsed = null;
        try {
          parsed = JSON.parse(data);
        } catch (error) {
          parsed = data;
        }
        resolve({
          status: res.statusCode,
          body: parsed
        });
      });
    });

    req.on('error', reject);

    if (body !== undefined && body !== null) {
      req.write(typeof body === 'string' ? body : JSON.stringify(body));
    }

    req.end();
  });
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function startElectron(dataDir) {
  return new Promise((resolve, reject) => {
    console.log('Starting Electron desktop bridge from', SRC_MAIN);
    console.log('Bridge target:', BRIDGE_URL, '| data dir:', dataDir || '(default)');

    const electron = spawn(process.execPath, [ELECTRON_CLI, SRC_MAIN], {
      cwd: APP_ROOT,
      env: Object.assign({}, process.env, {
        AUTOEXTRACT_BRIDGE_PORT: String(PORT),
        AUTOEXTRACT_DATA_DIR: dataDir || '',
        // CI runners cannot chown the SUID chrome-sandbox helper, and
        // Chromium aborts with SIGTRAP without this opt-out. Windows (where
        // the sandbox works differently) ignores it.
        ELECTRON_DISABLE_SANDBOX: '1'
      }),
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    electron.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      process.stdout.write(text);
    });

    electron.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      process.stderr.write(chunk.toString());
    });

    electron.on('error', (error) => {
      reject(new Error('Failed to start Electron: ' + error.message));
    });

    electron.on('exit', (code, signal) => {
      if (code !== 0 && code !== undefined) {
        console.log('Electron exited with code', code, 'signal', signal);
      }
      if (! resolved) {
        resolved = true;
        reject(new Error(
          'Electron exited before the bridge became reachable.\n' +
          'stdout:\n' + stdout + '\n' +
          'stderr:\n' + stderr
        ));
      }
    });

    let resolved = false;

    resolve({
      electron,
      dispose() {
        if (! resolved) {
          resolved = true;
        }
        electron.kill('SIGTERM');
        setTimeout(() => {
          if (electron.exitCode === undefined) {
            electron.kill('SIGKILL');
          }
        }, 2000);
      }
    });
  });
}

function waitForBridge() {
  return new Promise((resolve, reject) => {
    let waited = 0;
    const maxWait = 20000;
    const interval = 200;

    function tryConnect() {
      waited += interval;

      requestJSON('POST', '/', makePayload([{ server: 'stub', type: 'video', url: 'http://example.com/video.mp4' }]))
        .then((response) => {
          if (response.status === 200 && response.body && response.body.ok === true) {
            console.log('Electron bridge responded ok');
            resolve();
          } else if (waited < maxWait) {
            setTimeout(tryConnect, interval);
          } else {
            reject(new Error('Electron bridge did not respond in time: ' + JSON.stringify(response)));
          }
        })
        .catch((error) => {
          if (waited < maxWait) {
            setTimeout(tryConnect, interval);
          } else {
            reject(new Error('Electron bridge connection failed: ' + error.message));
          }
        });
    }

    tryConnect();
  });
}

function waitForWindowReady() {
  // Resolves once the smoke has captured the DESKTOP_WINDOW_READY marker and
  // the renderer's backlog line; rejects on timeout.
  return new Promise((resolve, reject) => {
    let waited = 0;
    const interval = 200;
    const maxWait = 20000;
    function check() {
      if (
        smokeStdout.indexOf('DESKTOP_WINDOW_READY') !== -1 &&
        smokeStdout.indexOf('AutoExtract renderer: ready with') !== -1
      ) {
        resolve();
        return;
      }
      if (waited >= maxWait) {
        reject(new Error('window did not become ready in time'));
        return;
      }
      waited += interval;
      setTimeout(check, interval);
    }
    check();
  });
}

let smokeStdout = '';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Waits until the history file exists and parses as a stable v2 envelope:
// flushes are atomic renames, so two identical reads 200ms apart imply the
// debounced write landed and nothing is mid-write. Replaces the previous
// blind sleep, which raced the flush on slow CI machines; the envelope's
// ciphertext hides the payload count, so phase 2's renderer-count assertion
// remains the content check.
function waitForPersistedHistory(filePath) {
  const fsMod = require('fs');
  return new Promise((resolve, reject) => {
    let waited = 0;
    let lastState = 'missing';
    const interval = 200;
    const maxWait = 10000;
    function readEnvelope() {
      try {
        const parsed = JSON.parse(fsMod.readFileSync(filePath, 'utf8'));
        if (parsed && parsed.version === 2 && typeof parsed.ciphertext === 'string' &&
            parsed.ciphertext.length > 0) {
          return parsed;
        }
        lastState = 'unrecognized shape (version ' + (parsed && parsed.version) + ')';
      } catch (error) {
        lastState = 'unreadable: ' + error.message;
      }
      return null;
    }
    (function check() {
      const envelope = readEnvelope();
      if (envelope) {
        const again = readEnvelope();
        if (again && JSON.stringify(again) === JSON.stringify(envelope)) {
          resolve(envelope.savedAt || '');
          return;
        }
      }
      if (waited >= maxWait) {
        reject(new Error('history file never reached a stable v2 envelope (last state: ' + lastState + ')'));
        return;
      }
      waited += interval;
      setTimeout(check, interval);
    })();
  });
}

// Resolves when the renderer reports at least `minCount` backlogged payloads.
// A minimum (not exact) because the smoke's own bridge-readiness probe can
// land before or after the window attaches depending on timing.
function waitForRendererReadyWithCount(minCount) {
  return new Promise((resolve, reject) => {
    let waited = 0;
    const interval = 200;
    const maxWait = 20000;
    function check() {
      const match = smokeStdout.match(/AutoExtract renderer: ready with (\d+) backlogged payload/);
      if (match && parseInt(match[1], 10) >= minCount) {
        resolve(parseInt(match[1], 10));
        return;
      }
      if (waited >= maxWait) {
        const restoredMatch = smokeStdout.match(/AutoExtract desktop restored (\d+) persisted payload/);
        const restoreInfo = restoredMatch
          ? 'main restored ' + restoredMatch[1]
          : 'no restore line in main output';
        const decryptWarn = (smokeStdout.match(/history file failed to decrypt \([^)]*\)/) || [null])[0];
        reject(new Error('renderer never reported >= ' + minCount + ' backlogged payload(s) (' +
          restoreInfo + (decryptWarn ? '; ' + decryptWarn : '') + ')'));
        return;
      }
      waited += interval;
      setTimeout(check, interval);
    }
    check();
  });
}

function stopAndWait(runner) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('electron did not exit in time')), 10000);
    runner.electron.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
    runner.dispose();
  });
}

async function runDesktopApp(dataDir) {
  const runner = await startElectron(dataDir);
  smokeStdout = '';
  runner.electron.stdout.on('data', (chunk) => {
    smokeStdout += chunk.toString();
  });
  try {
    await waitForBridge();
    await waitForWindowReady();
    return runner;
  } catch (error) {
    runner.dispose();
    throw error;
  }
}

async function run() {
  const os = require('os');
  const fs = require('fs');
  const smokeDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoextract-smoke-data-'));
  let runner = null;

  try {
    // ---- Phase 1: first app run ----
    console.log('Phase 1: first app run.');
    runner = await runDesktopApp(smokeDataDir);

    const liveResponse = await requestJSON('POST', '/', makePayload([
      { server: 'live-check', type: 'video', url: 'http://example.com/live-check.mp4' }
    ]));
    if (!liveResponse.body || liveResponse.body.ok !== true) {
      throw new Error('live-check POST not accepted: ' + JSON.stringify(liveResponse.body));
    }

    await new Promise((resolve, reject) => {
      let waited = 0;
      const interval = 200;
      const maxWait = 10000;
      (function check() {
        if (smokeStdout.indexOf('AutoExtract renderer: showing payload from') !== -1) {
          resolve();
          return;
        }
        if (waited >= maxWait) {
          reject(new Error('renderer never received the live payload via IPC'));
          return;
        }
        waited += interval;
        setTimeout(check, interval);
      })();
    });
    console.log('Phase 1 passed: bridge + window + live IPC.');

    // The store flushes on a 500ms debounce, and dispose() hard-kills the app
    // (SIGTERM = TerminateProcess on Windows, so will-quit never runs). Wait
    // for a stable on-disk envelope instead of sleeping blindly.
    await waitForPersistedHistory(path.join(smokeDataDir, 'autoextract-history.json'));

    await stopAndWait(runner);
    runner = null;

    // ---- Phase 2: restart with the same data dir ----
    console.log('Phase 2: restarting the app with the same data dir.');
    runner = await runDesktopApp(smokeDataDir);

    // History from run 1 (probe + live-check = 2 payloads) must be restored
    // into the renderer backlog; the run-2 readiness probe may land before or
    // after the window attaches, hence the >= check.
    const restoredCount = await waitForRendererReadyWithCount(2);
    console.log('Phase 2 passed: persisted history restored across restart (renderer reports ' + restoredCount + ').');

    console.log('Desktop bridge smoke test passed (bridge + window + live IPC + persistence).');
  } finally {
    if (runner) {
      runner.dispose();
    }
    try {
      fs.rmSync(smokeDataDir, { recursive: true, force: true });
    } catch (cleanupError) {
      // Best-effort cleanup of the temp data dir.
    }
  }
}

run()
  .then(() => {
    console.log('Desktop bridge smoke test passed.');
    process.exit(0);
  })
  .catch((error) => {
    console.log('Desktop bridge smoke test failed:', error && error.message);
    process.exit(1);
  });
