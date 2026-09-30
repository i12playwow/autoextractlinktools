#!/usr/bin/env node
//
// test-desktop-bridge-edge-cases.js
//
// Edge-case tests for the desktop bridge, going beyond the basic contract
// tests in test-desktop-contract.js.
//
// Two layers:
//
//   1. In-process: requires the real createBridgeServer() from src/main.js
//      and runs it on 127.0.0.1:3460. src/main.js guards its Electron
//      bootstrap, so requiring it under plain Node is safe. Covers routing
//      (method/path/query), malformed bodies, malformed payloads, type
//      confusion, unknown-field tolerance, content-type independence,
//      request sequencing, and the 503 shutdown path. Also verifies that
//      server.close() completes even when a client is destroyed mid-request
//      (regression guard for the bridge stop flow). Requests use fresh
//      connections (agent: false) so keep-alive pooling cannot leak sockets
//      between server lifetimes on the same port.
//
//   2. Real Electron: spawns the actual desktop app from src/main.js on
//      127.0.0.1:3461 (same pattern as run-desktop-bridge.js) and repeats a
//      representative subset of behaviors against the real process, including
//      empty-body rejection. Skipped gracefully (not a failure) when the
//      electron package is not installed/runnable — e.g. when the binary
//      download was skipped or failed, such as in minimal CI environments.
//
// Ports used: 3460-3462 (3462 for the isolated shutdown test). The other
// local harnesses use 3456-3459 and 3463, so there is no collision.
//
// Run: node test-desktop-bridge-edge-cases.js
//

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// ---------------------------------------------------------------------------
// Minimal test framework
// ---------------------------------------------------------------------------

const PASS = [];
const FAIL = [];
let SECTION = '';

function section(name) {
  SECTION = name;
  console.log('\n== ' + name + ' ==');
}

function pass(name) {
  PASS.push(name);
  console.log('  PASS  ' + name);
}

function fail(name, error) {
  FAIL.push({ name, error, section: SECTION });
  console.log('  FAIL  ' + name);
  console.log('        ' + (error && error.message ? error.message : String(error)));
}

function expect(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(message + ': expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
  }
}

// Substring match against the raw response body: response bodies are JSON,
// and asserting on substrings keeps these tests tolerant of extra fields.
function expectIncludes(haystack, needle, message) {
  if (typeof haystack !== 'string' || haystack.indexOf(needle) === -1) {
    throw new Error(message + ': expected body to include ' + JSON.stringify(needle) + ', got ' + JSON.stringify(haystack));
  }
}

// ---------------------------------------------------------------------------
// HTTP helper (raw, so bodies and headers can be fully controlled)
// ---------------------------------------------------------------------------

function request(port, method, requestPath, body, contentType) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: '127.0.0.1',
      port: port,
      path: requestPath || '/',
      method: method || 'POST',
      headers: {},
      // Fresh connection per request: the default global agent pools
      // keep-alive sockets, and reused sockets pointed at a previous test
      // server (same port, since closed) fail with ECONNRESET.
      agent: false
    };

    if (contentType !== null) {
      options.headers['Content-Type'] = contentType || 'application/json';
    }

    let raw = null;
    if (body !== undefined && body !== null) {
      raw = typeof body === 'string' ? body : JSON.stringify(body);
      options.headers['Content-Length'] = Buffer.byteLength(raw);
    }

    const timer = setTimeout(() => {
      req.destroy(new Error('request timed out after 5000ms'));
    }, 5000);

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk.toString(); });
      res.on('end', () => {
        clearTimeout(timer);
        resolve({ status: res.statusCode, body: data });
      });
    });

    req.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });

    if (raw !== null) {
      req.write(raw);
    }
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Layer 1: in-process tests against the real bridge logic
// ---------------------------------------------------------------------------

const APP_ROOT = __dirname;
const MAIN_PATH = path.join(APP_ROOT, 'src', 'main.js');
const mainModule = require(MAIN_PATH);
const createBridgeServer = mainModule.createBridgeServer;
const stopBridgeForTests = mainModule.stopBridgeForTests;

if (typeof createBridgeServer !== 'function') {
  console.error('FATAL: src/main.js did not export createBridgeServer().');
  console.error('The module export contract changed; update this test harness.');
  process.exit(1);
}

const PORT = 3460;
const SHUTDOWN_PORT = 3462;

async function withServer(port, fn) {
  const server = createBridgeServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  try {
    await fn();
  } finally {
    await new Promise((resolve) => {
      if (!server.listening) {
        resolve();
        return;
      }
      server.close(() => resolve());
    });
  }
}

async function expectResponse(name, port, method, requestPath, body, expectedStatus, expectedSubstring) {
  try {
    const res = await request(port, method, requestPath, body);
    expect(res.status, expectedStatus, name + ' status');
    if (expectedSubstring !== undefined) {
      expectIncludes(res.body, expectedSubstring, name + ' body');
    }
    pass(name);
  } catch (error) {
    fail(name, error);
  }
}

async function runInProcessTests() {
  section('in-process: routing edge cases');

  await withServer(PORT, async () => {
    await expectResponse('POST /?query=1 is rejected as not found', PORT, 'POST', '/?query=1',
      { links: [{ url: 'http://example.com/v.mp4' }] }, 404, 'not found');

    await expectResponse('POST /subpath is rejected as not found', PORT, 'POST', '/subpath',
      { links: [{ url: 'http://example.com/v.mp4' }] }, 404, 'not found');

    await expectResponse('GET / is rejected as not found (method hint included)', PORT, 'GET', '/', null, 404, 'POST / required');

    await expectResponse('PUT / is rejected as not found', PORT, 'PUT', '/',
      { links: [{ url: 'http://example.com/v.mp4' }] }, 404, 'not found');
  });

  section('in-process: malformed JSON bodies');

  await withServer(PORT, async () => {
    await expectResponse('empty body is rejected as invalid json', PORT, 'POST', '/', '', 400, 'invalid json');
    await expectResponse('whitespace-only body is rejected as invalid json', PORT, 'POST', '/', '   \n  ', 400, 'invalid json');
    await expectResponse('truncated JSON is rejected as invalid json', PORT, 'POST', '/',
      '{"links": [', 400, 'invalid json');
    await expectResponse('JSON with trailing garbage is rejected as invalid json', PORT, 'POST', '/',
      '{"links": []} oops', 400, 'invalid json');
    await expectResponse('single-quoted pseudo-JSON is rejected as invalid json', PORT, 'POST', '/',
      "{'links': []}", 400, 'invalid json');
  });

  section('in-process: payload type confusion and shape errors');

  await withServer(PORT, async () => {
    await expectResponse('JSON array payload is rejected', PORT, 'POST', '/', [], 400, 'invalid payload');
    await expectResponse('JSON string payload is rejected', PORT, 'POST', '/', '"just a string"', 400, 'invalid payload');
    await expectResponse('JSON number payload is rejected', PORT, 'POST', '/', '42', 400, 'invalid payload');
    await expectResponse('JSON null payload is rejected', PORT, 'POST', '/', 'null', 400, 'invalid payload');
    await expectResponse('links as object is rejected', PORT, 'POST', '/',
      { links: { 0: { url: 'http://example.com/v.mp4' } } }, 400, 'invalid payload');
    await expectResponse('links entry null is rejected', PORT, 'POST', '/',
      { links: [null] }, 400, 'invalid payload');
    await expectResponse('links entry array is rejected', PORT, 'POST', '/',
      { links: [['http://example.com/v.mp4']] }, 400, 'invalid payload');
    await expectResponse('links entry with number url is rejected', PORT, 'POST', '/',
      { links: [{ url: 12345 }] }, 400, 'invalid payload');
    await expectResponse('valid link followed by invalid link is rejected', PORT, 'POST', '/',
      { links: [{ url: 'http://example.com/good.mp4' }, { nope: true }] }, 400, 'invalid payload');
  });

  section('in-process: tolerance edge cases (must still be accepted)');

  await withServer(PORT, async () => {
    await expectResponse('link url of only whitespace is accepted (non-empty string contract)', PORT, 'POST', '/',
      { links: [{ url: '   ' }] }, 200, '"ok":true');

    await expectResponse('unknown payload fields are ignored', PORT, 'POST', '/',
      {
        links: [{ server: 'stub', type: 'video', url: 'http://example.com/v.mp4', extra: 1 }],
        unknownTopLevel: { arbitrary: true },
        pageUrl: 'http://localhost:9999/test',
        pageTitle: 'Test Page'
      }, 200, '"ok":true');

    await expectResponse('empty links array is accepted', PORT, 'POST', '/', { links: [] }, 200, '"ok":true');
  });

  section('in-process: isSafeExternalUrl (renderer open-in-browser guard)');

  // shell.openExternal hands URLs to the operating system, so the renderer's
  // "open" action is re-validated in main before it can reach it. These tests
  // pin the allowlist behavior exported by src/main.js.
  {
    const safeCases = [
      ['https://example.com/video.mp4', 'https://example.com/video.mp4'],
      ['http://example.com/v.mp4', 'http://example.com/v.mp4'],
      ['https://Example.com/Path', 'https://example.com/Path'],
      ['https://example.com:443/x', 'https://example.com/x']
    ];
    const safeErrors = [];
    safeCases.forEach(([raw, expected]) => {
      const got = mainModule.isSafeExternalUrl(raw);
      if (got !== expected) {
        safeErrors.push({ raw, expected, got });
      }
    });
    expect(safeErrors.length, 0, 'safe http/https URLs accepted and normalized: ' + JSON.stringify(safeErrors));
    pass('http/https URLs are accepted and normalized');

    const unsafe = [
      'file:///C:/Windows/notepad.exe',
      'javascript:alert(1)',
      'data:text/html,<b>x</b>',
      'ftp://example.com/file',
      'chrome://settings',
      'vimeo://app',
      '//example.com/protocol-relative',
      'not a url at all',
      '',
      '   ',
      null,
      undefined,
      42,
      {}
    ];
    const rejected = unsafe.filter((raw) => mainModule.isSafeExternalUrl(raw) !== null);
    expect(rejected.length, 0, 'unsafe inputs must all be rejected, got ' + JSON.stringify(rejected));
    pass('non-http(s), unparsable, and non-string inputs are rejected');
  }

  section('in-process: protocol and sequencing');

  await withServer(PORT, async () => {
    // Content-Type independence: the bridge never inspects it, so a plain-text
    // request carrying valid JSON must still be processed normally.
    await expectResponse('non-JSON Content-Type with valid JSON body is accepted', PORT, 'POST', '/',
      { links: [{ url: 'http://example.com/v.mp4' }] }, 200, '"ok":true');

    // Sequential requests: state must not leak between requests.
    const first = await request(PORT, 'POST', '/', { links: [{ url: 'http://example.com/first.mp4' }] });
    expect(first.status, 200, 'first sequential request status');
    const second = await request(PORT, 'POST', '/', { links: 'still-not-an-array' });
    expect(second.status, 400, 'second sequential request must be rejected');
    const third = await request(PORT, 'POST', '/', { links: [{ url: 'http://example.com/third.mp4' }] });
    expect(third.status, 200, 'third sequential request status');
    pass('sequential requests handled independently (accept, reject, accept)');
  });

  section('in-process: shutdown and close behavior');

  // Isolated require-cache entry so the module-global shuttingDown flag set
  // by stopBridgeForTests cannot leak into other tests.
  const shutdownCacheKey = require.resolve(MAIN_PATH);
  const shutdownEntry = require.cache[shutdownCacheKey];
  delete require.cache[shutdownCacheKey];
  try {
    // eslint-disable-next-line global-require
    const freshMain = require(MAIN_PATH);

    // Test A: a destroyed client socket must not prevent server.close()
    // from completing the stop flow (regression guard).
    const serverA = freshMain.createBridgeServer();
    await new Promise((resolve, reject) => {
      serverA.once('error', reject);
      serverA.listen(SHUTDOWN_PORT, '127.0.0.1', resolve);
    });

    const stalled = await request(SHUTDOWN_PORT, 'POST', '/', { links: [{ url: 'http://example.com/stalled.mp4' }] });
    expect(stalled.status, 200, 'request before destroy status');
    await new Promise((resolve) => {
      const sock = http.request({ hostname: '127.0.0.1', port: SHUTDOWN_PORT, method: 'POST', agent: false }, () => {});
      sock.on('error', () => resolve());
      sock.end();
      setTimeout(() => { sock.destroy(); resolve(); }, 50);
    });
    const closed = await Promise.race([
      new Promise((resolve) => serverA.close(() => resolve(true))),
      new Promise((resolve) => setTimeout(() => resolve(false), 3000))
    ]);
    expect(closed, true, 'server.close() must complete even with a destroyed client');
    pass('server.close() completes with a destroyed client socket');

    // Test B: with the bridge shutting down but still listening, arriving
    // requests must get 503, not be accepted.
    const serverB = freshMain.createBridgeServer();
    await new Promise((resolve, reject) => {
      serverB.once('error', reject);
      serverB.listen(SHUTDOWN_PORT, '127.0.0.1', resolve);
    });
    freshMain.stopBridgeForTests();
    const afterStop = await request(SHUTDOWN_PORT, 'POST', '/', { links: [{ url: 'http://example.com/late.mp4' }] });
    expect(afterStop.status, 503, 'request after stopBridge status');
    expectIncludes(afterStop.body, 'shutting down', 'request after stopBridge body');
    pass('requests after shutdown get 503 "shutting down"');
    await new Promise((resolve) => serverB.close(() => resolve()));
  } catch (error) {
    fail('shutdown path (close with destroyed client, 503 after stop)', error);
  } finally {
    require.cache[shutdownCacheKey] = shutdownEntry;
  }
}

// ---------------------------------------------------------------------------
// Layer 2: real Electron process tests
// ---------------------------------------------------------------------------

const E2E_PORT = 3461;
const ELECTRON_CLI = path.join(APP_ROOT, 'node_modules', 'electron', 'cli.js');

function electronAvailable() {
  try {
    require('electron/package.json');
  } catch (error) {
    return false;
  }
  // The npm package can be present while its postinstall (binary download)
  // failed or was skipped; spawning would then fail confusingly. Only claim
  // availability when the dist binary actually exists.
  const distBinary = process.platform === 'win32'
    ? path.join(APP_ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
    : path.join(APP_ROOT, 'node_modules', 'electron', 'dist', 'electron');
  return fs.existsSync(distBinary);
}

function startElectron() {
  const electron = spawn(process.execPath, [ELECTRON_CLI, MAIN_PATH], {
    cwd: APP_ROOT,
    env: Object.assign({}, process.env, { AUTOEXTRACT_BRIDGE_PORT: String(E2E_PORT) }),
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let stdout = '';
  let stderr = '';
  electron.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  electron.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

  return { electron, getStdout: () => stdout, getStderr: () => stderr };
}

function disposeElectron(runner) {
  runner.electron.kill('SIGTERM');
  setTimeout(() => {
    if (runner.electron.exitCode === undefined) {
      runner.electron.kill('SIGKILL');
    }
  }, 2000);
}

function waitForElectronBridge() {
  let waited = 0;
  const maxWait = 20000;
  return new Promise((resolve, reject) => {
    function tryConnect() {
      request(E2E_PORT, 'POST', '/', { links: [{ url: 'http://example.com/probe.mp4' }] })
        .then((res) => {
          if (res.status === 200) {
            resolve();
          } else if (waited < maxWait) {
            waited += 250;
            setTimeout(tryConnect, 250);
          } else {
            reject(new Error('bridge did not become ready: ' + JSON.stringify(res)));
          }
        })
        .catch(() => {
          if (waited < maxWait) {
            waited += 250;
            setTimeout(tryConnect, 250);
          } else {
            reject(new Error('bridge connection failed while waiting for readiness'));
          }
        });
    }
    tryConnect();
  });
}

async function runElectronTests() {
  section('real Electron app (spawns src/main.js)');

  if (!electronAvailable()) {
    console.log('  SKIP  electron package not installed or unreadable; real-app tests skipped');
    return;
  }

  const runner = startElectron();
  try {
    await waitForElectronBridge();

    await expectResponse('valid payload accepted by real app', E2E_PORT, 'POST', '/',
      {
        detected: { supported: true, type: 'stub', markerCount: 1 },
        links: [{ server: 'stub', type: 'video', url: 'http://example.com/video.mp4' }],
        sources: [{ element: 'div', attributes: ['data-autoextract'] }],
        pageUrl: 'http://localhost:9999/test',
        pageTitle: 'Test Page',
        sentAt: new Date().toISOString()
      }, 200, '"received":true');

    await expectResponse('invalid payload rejected by real app', E2E_PORT, 'POST', '/',
      { links: [{ type: 'video' }] }, 400, 'invalid payload');

    await expectResponse('GET rejected by real app', E2E_PORT, 'GET', '/', null, 404, 'not found');

    await expectResponse('empty body rejected as invalid json by real app', E2E_PORT, 'POST', '/', '', 400, 'invalid json');
  } catch (error) {
    fail('real Electron app suite', error);
    console.log('  ---- electron stdout ----\n' + runner.getStdout());
    console.log('  ---- electron stderr ----\n' + runner.getStderr());
  } finally {
    disposeElectron(runner);
    // Give the port a moment to free up before the process exits.
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

// ---------------------------------------------------------------------------

async function run() {
  await runInProcessTests();
  await runElectronTests();

  console.log('\nResults: ' + PASS.length + ' passed, ' + FAIL.length + ' failed');
  if (FAIL.length > 0) {
    process.exit(1);
  }
}

run().catch((error) => {
  console.error('test harness crashed:', error && error.stack ? error.stack : error);
  process.exit(1);
});
