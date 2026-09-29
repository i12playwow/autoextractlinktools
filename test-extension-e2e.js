#!/usr/bin/env node
//
// test-extension-e2e.js
//
// End-to-end test of the Chrome extension: loads the packed unpacked
// extension (chrome-extension-packed/) in a real headless Chromium-based
// browser, opens the stub test page (served on http://localhost so the
// manifest's content-script matches apply), and asserts that the full
// pipeline fires:
//
//   content script (shared detect/extract, stub contract)
//     -> chrome.storage results
//     -> background service worker POST
//     -> desktop bridge contract (localhost:3456, the extension's fixed
//        target from manifest host_permissions / background.js)
//
// The bridge stub binds 127.0.0.1:3456 exactly, because the extension
// hardcodes that port (background.js DEFAULT_DESKTOP_URL).
//
// Robustness notes:
//   - Browsers are tried in order (Chromium first, then Chrome/Edge/Brave):
//     recent branded Chrome builds restrict --load-extension, so the harness
//     moves to the next candidate if the extension does not come up. Skipped
//     with a note when no Chromium-based browser exists (e.g. minimal CI).
//   - The packed extension is (re)built at test start from chrome-extension/
//     plus the generated shared copy, so the test never runs against a stale
//     or missing loadable copy (that directory is not git-tracked).
//
// Run: node test-extension-e2e.js  (also run by npm test)
//

'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const PASS = [];
const FAIL = [];

function pass(name) {
  PASS.push(name);
  console.log('  PASS  ' + name);
}

function fail(name, error) {
  FAIL.push({ name, error });
  console.log('  FAIL  ' + name);
  console.log('        ' + (error && error.message ? error.message : String(error)));
}

function expect(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(message + ': expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const APP_ROOT = __dirname;
const LIB = require(path.join(APP_ROOT, 'lib', 'headless-extract.js'));

const BRIDGE_PORT = 3456; // fixed: the extension's hardcoded bridge target
const PAGE_PORT = 3467;   // free; content scripts match http://localhost:*/*
const PAGE_URL = 'http://localhost:' + PAGE_PORT + '/';
const EXTENSION_DIR = path.join(APP_ROOT, 'chrome-extension-packed');

// ---------------------------------------------------------------------------
// Stub servers
// ---------------------------------------------------------------------------

function startStubBridge(port) {
  const received = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk.toString(); });
    req.on('end', () => {
      let payload = null;
      try { payload = JSON.parse(body); } catch (error) { payload = null; }
      const valid = payload && Array.isArray(payload.links) &&
        payload.links.every((l) => l && typeof l.url === 'string' && l.url.length > 0);
      if (valid) {
        received.push(payload);
      }
      res.writeHead(valid ? 200 : 400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(valid ? { ok: true, received: true } : { error: 'invalid payload' }));
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve({ server, received }));
  });
}

function startPageServer(port) {
  const pageHtml = fs.readFileSync(path.join(APP_ROOT, 'test-pages', 'index.html'));
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(pageHtml);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve({ server }));
  });
}

function stopServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

// ---------------------------------------------------------------------------
// Extension build (packed copy must exist; not git-tracked)
// ---------------------------------------------------------------------------

function buildPackedExtension() {
  // Order matters: shared/index.js -> chrome-extension/shared/, then the
  // full directory copy into chrome-extension-packed/.
  const buildShared = spawnSync(process.execPath, [path.join(APP_ROOT, 'chrome-extension', 'build', 'make-shared.js')], {
    cwd: APP_ROOT,
    encoding: 'utf8'
  });
  if (buildShared.status !== 0) {
    throw new Error('build:extension failed: ' + (buildShared.stderr || buildShared.stdout || 'exit ' + buildShared.status));
  }

  const pack = spawnSync(process.execPath, [path.join(APP_ROOT, 'package-extension-for-chrome.js')], {
    cwd: APP_ROOT,
    encoding: 'utf8'
  });
  if (pack.status !== 0) {
    throw new Error('extension packing failed: ' + (pack.stderr || pack.stdout || 'exit ' + pack.status));
  }

  assert(fs.existsSync(path.join(EXTENSION_DIR, 'manifest.json')), 'packed manifest missing after build');
  assert(fs.existsSync(path.join(EXTENSION_DIR, 'shared', 'index.js')), 'packed shared module missing after build');
  assert(fs.existsSync(path.join(EXTENSION_DIR, 'background.js')), 'packed background worker missing after build');
}

// ---------------------------------------------------------------------------
// Browser candidates: every Chromium-family executable that might support
// --load-extension. Chromium (unbranded) keeps supporting it; branded builds
// started restricting it in 2025, so we try them all until one works.
// ---------------------------------------------------------------------------

function chromiumCandidates() {
  const list = [];
  const push = (p) => { if (p && list.indexOf(p) === -1) { list.push(p); } };

  if (process.platform === 'win32') {
    push(process.env['ProgramFiles'] + '\\Chromium\\Application\\chrome.exe');
    push(process.env['LocalAppData'] + '\\Chromium\\Application\\chrome.exe');
  } else if (process.platform === 'darwin') {
    push('/Applications/Chromium.app/Contents/MacOS/Chromium');
  } else {
    push('/usr/bin/chromium');
    push('/usr/bin/chromium-browser');
    push('/usr/bin/google-chrome-unstable');
  }

  LIB.BROWSER_CANDIDATES.forEach((candidate) => {
    (candidate.paths[process.platform] || []).forEach(push);
  });

  return list.filter((p) => {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return true;
    } catch (error) {
      return false;
    }
  });
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Launches one candidate with the extension loaded and the test page open.
// Resolves { ok, diagnostics } — ok means the extension pipeline delivered a
// payload to the stub bridge before the deadline. A fresh profile directory
// is used per attempt: reusing a profile across attempts (or across the CLI
// suite's browser runs on the same machine) can leave extension state that
// blocks a clean --load-extension.
function tryBrowser(executablePath, received) {
  return new Promise((resolve) => {
    const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoextract-ext-e2e-profile-'));
    const args = [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--mute-audio',
      '--no-first-run',
      '--no-default-browser-check',
      '--user-data-dir=' + profileDir,
      '--load-extension=' + EXTENSION_DIR,
      PAGE_URL
    ];

    const chrome = spawn(executablePath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderrTail = '';

    const timer = setTimeout(() => finish(false, 'deadline (40s) reached without a bridge delivery'), 40000);

    function finish(ok, note) {
      clearTimeout(timer);
      try { chrome.kill('SIGKILL'); } catch (error) { /* already gone */ }
      // Best-effort profile cleanup; browser teardown may lag the kill.
      setTimeout(() => {
        try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch (error) { /* best effort */ }
      }, 500);
      resolve({ ok, note, diagnostics: stderrTail.slice(-4000) });
    }

    chrome.stderr.on('data', (chunk) => {
      if (stderrTail.length < 20000) {
        stderrTail += chunk.toString();
      }
      // The content script logs through the page console, which Chrome
      // forwards to stderr with --enable-logging defaults in headless mode.
      // Any AutoExtract line proves the content script ran.
      if (stderrTail.indexOf('AutoExtract') !== -1) {
        // Content script is alive; give the background worker a moment to
        // deliver, but don't wait the full deadline if the bridge got it.
        const pollDeadline = Date.now() + 8000;
        (function pollBridge() {
          if (received.length > 0) {
            finish(true, 'bridge received payload');
          } else if (Date.now() < pollDeadline) {
            setTimeout(pollBridge, 250);
          } else {
            finish(false, 'content script ran but the bridge never received a payload');
          }
        })();
      }
    });

    chrome.on('error', (error) => finish(false, 'spawn failed: ' + error.message));

    // Bridge delivery can beat the stderr line (log flushing varies).
    const bridgePoll = setInterval(() => {
      if (received.length > 0) {
        clearInterval(bridgePoll);
        finish(true, 'bridge received payload');
      }
    }, 250);
    setTimeout(() => clearInterval(bridgePoll), 25100);
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function run() {
  console.log('\n== extension end-to-end (headless browser, stub bridge on 3456) ==');

  const candidates = chromiumCandidates();
  if (candidates.length === 0) {
    console.log('  SKIP  no Chromium-based browser found; extension E2E skipped');
    return;
  }

  let bridge;
  let page;
  try {
    try {
      buildPackedExtension();
    } catch (error) {
      fail('extension build (make-shared + pack)', error);
      return;
    }
    pass('packed extension built (manifest, shared module, background worker present)');

    bridge = await startStubBridge(BRIDGE_PORT);
    page = await startPageServer(PAGE_PORT);

    let succeeded = null;
    const attempted = [];
    for (const candidate of candidates) {
      attempted.push(path.basename(path.dirname(path.dirname(candidate))));
      console.log('  ... trying browser: ' + candidate);
      const outcome = await tryBrowser(candidate, bridge.received);
      if (outcome.ok) {
        succeeded = { candidate, outcome };
        break;
      }
      console.log('        no delivery (' + outcome.note + '); trying next candidate');
    }

    if (!succeeded) {
      fail('extension pipeline delivers to bridge', new Error(
        'no candidate browser loaded the extension successfully (tried: ' + attempted.join(', ') + '). ' +
        'Note: recent branded Chrome builds restrict --load-extension; Edge or Chromium are known to work.'
      ));
      return;
    }
    pass('extension pipeline delivered to the bridge via ' + path.basename(succeeded.candidate));

    const payload = bridge.received[0];
    assert(Array.isArray(payload.links) && payload.links.length === 2,
      'expected the 2 stub links, got ' + JSON.stringify(payload.links && payload.links.length));
    expect(payload.links[0].url, 'http://example.com/video.mp4', 'first link url');
    expect(payload.links[1].type, 'audio', 'second link type');
    assert(payload.detected && payload.detected.type === 'stub' && payload.detected.markerCount === 2,
      'detection should report the stub contract, got ' + JSON.stringify(payload.detected));
    assert(typeof payload.pageUrl === 'string' && payload.pageUrl.indexOf('http://localhost:' + PAGE_PORT) === 0,
      'pageUrl should be the served test page, got ' + JSON.stringify(payload.pageUrl));
    assert(payload.pageTitle === 'AutoExtract test page', 'pageTitle should come from the page');
    pass('payload carries stub links, detection, pageUrl, and pageTitle');

    expect(bridge.received.length, 1, 'exactly one bridge POST for one page load');
    pass('exactly one forwarding POST (no duplicate sends)');
  } catch (error) {
    fail('extension end-to-end', error);
  } finally {
    if (bridge) { await stopServer(bridge.server); }
    if (page) { await stopServer(page.server); }
  }
}

run().then(() => {
  console.log('\nResults: ' + PASS.length + ' passed, ' + FAIL.length + ' failed');
  if (FAIL.length > 0) {
    process.exit(1);
  }
}).catch((error) => {
  console.error('test harness crashed:', error && error.stack ? error.stack : error);
  process.exit(1);
});
