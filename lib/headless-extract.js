// lib/headless-extract.js
//
// Headless extraction library used by the `autoextract extract` CLI command.
//
// Flow:
//   1. resolveBrowser() locates a Chromium-based browser (puppeteer-core has
//      no bundled browser; see channel list below).
//   2. launchAndExtract() opens the URL headless, injects the shared module
//      (shared/index.js, the same logic the extension and userscript use), and
//      calls window.AutoExtract.extract() in the page.
//   3. sendToBridge() optionally POSTs the payload to the desktop bridge
//      (default http://localhost:3456/), using the same contract as the
//      extension.
//
// Exit codes used by the CLI:
//   0 - links found (or none found with --allow-empty)
//   1 - general failure (launch, navigation, extraction)
//   2 - no browser found
//   3 - no links found (without --allow-empty)

'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');

const SHARED_PATH = path.join(__dirname, '..', 'shared', 'index.js');
const DEFAULT_DESKTOP_URL = 'http://localhost:3456/';

// Candidate browsers in priority order. Each entry: { channel, paths } where
// paths are checked per platform. First existing executable wins.
const BROWSER_CANDIDATES = [
  { channel: 'chrome', paths: {
    win32: [
      process.env['ProgramFiles'] + '\\Google\\Chrome\\Application\\chrome.exe',
      process.env['ProgramFiles(x86)'] + '\\Google\\Chrome\\Application\\chrome.exe',
      process.env['LocalAppData'] + '\\Google\\Chrome\\Application\\chrome.exe'
    ],
    darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
    linux: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser']
  } },
  { channel: 'msedge', paths: {
    win32: [
      process.env['ProgramFiles'] + '\\Microsoft\\Edge\\Application\\msedge.exe',
      process.env['ProgramFiles(x86)'] + '\\Microsoft\\Edge\\Application\\msedge.exe',
      process.env['LocalAppData'] + '\\Microsoft\\Edge\\Application\\msedge.exe'
    ],
    darwin: ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
    linux: ['/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable']
  } },
  { channel: 'brave', paths: {
    win32: [
      process.env['ProgramFiles'] + '\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
      process.env['ProgramFiles(x86)'] + '\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
      process.env['LocalAppData'] + '\\BraveSoftware\\Brave-Browser\\Application\\brave.exe'
    ],
    darwin: ['/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'],
    linux: ['/usr/bin/brave-browser', '/usr/bin/brave']
  } }
];

function fileExists(p) {
  if (!p) {
    return false;
  }
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch (error) {
    return false;
  }
}

// Returns { channel, executablePath } for the first available candidate, or
// null when none is found. An explicitPath always wins when it exists.
function resolveBrowser(explicitPath) {
  if (explicitPath) {
    if (fileExists(explicitPath)) {
      return { channel: 'custom', executablePath: explicitPath };
    }
    return null;
  }

  for (var i = 0; i < BROWSER_CANDIDATES.length; i++) {
    var candidate = BROWSER_CANDIDATES[i];
    var platformPaths = candidate.paths[process.platform] || [];
    for (var j = 0; j < platformPaths.length; j++) {
      if (fileExists(platformPaths[j])) {
        return { channel: candidate.channel, executablePath: platformPaths[j] };
      }
    }
  }
  return null;
}

function waitForTimeout(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

// Runs the extraction. options:
//   url - target page (required)
//   executablePath - browser executable (resolved via resolveBrowser when omitted)
//   timeoutMs - navigation timeout (default 30000)
//   settleMs - extra wait after load for dynamic players (default 1500)
//   onLog - optional progress logger (fn(message))
//
// Returns the payload: { detected, links, sources, pageUrl, pageTitle, sentAt }.
async function launchAndExtract(options) {
  const url = options && options.url;
  if (!url) {
    throw new Error('launchAndExtract: url is required');
  }

  const timeoutMs = (options && options.timeoutMs) || 30000;
  const settleMs = (options && typeof options.settleMs === 'number') ? options.settleMs : 1500;
  const onLog = (options && typeof options.onLog === 'function') ? options.onLog : function () {};

  let resolution = (options && options.executablePath)
    ? { channel: 'custom', executablePath: options.executablePath }
    : resolveBrowser(null);
  if (!resolution) {
    const error = new Error('no Chromium-based browser found');
    error.code = 'NO_BROWSER';
    throw error;
  }

  // Lazy-required so browsers without puppeteer-core installed can still use
  // the discovery helpers.
  const puppeteer = require('puppeteer-core');

  onLog('launching ' + resolution.channel + ' (' + resolution.executablePath + ')');
  const browser = await puppeteer.launch({
    executablePath: resolution.executablePath,
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--mute-audio'
    ]
  });

  try {
    return await extractOnPage(browser, url, { timeoutMs: timeoutMs, settleMs: settleMs, onLog: onLog });
  } finally {
    await browser.close().catch(function () {});
  }
}

// Runs the shared-module extraction on one tab of an already-open browser.
// Closes its tab when done. Shared by the single-URL and batch paths.
async function extractOnPage(browser, url, pageOptions) {
  const timeoutMs = (pageOptions && pageOptions.timeoutMs) || 30000;
  const settleMs = (pageOptions && typeof pageOptions.settleMs === 'number') ? pageOptions.settleMs : 1500;
  const onLog = (pageOptions && typeof pageOptions.onLog === 'function') ? pageOptions.onLog : function () {};

  const page = await browser.newPage();
  try {
    onLog('navigating to ' + url);
    await page.goto(url, { waitUntil: 'networkidle2', timeout: timeoutMs });
    if (settleMs > 0) {
      await waitForTimeout(settleMs);
    }

    // Inject the shared module (same logic as the extension/userscript) and
    // run it in the page context. Evaluating the source via CDP Runtime
    // bypasses page CSP, so strict sites do not block the injection. The
    // shared file is an IIFE that attaches window.AutoExtract.
    const sharedSource = fs.readFileSync(SHARED_PATH, 'utf8');
    await page.evaluate(sharedSource);
    const result = await page.evaluate(function () {
      var AE = window.AutoExtract;
      if (!AE) {
        throw new Error('shared module did not attach window.AutoExtract');
      }
      var context = { document: document, location: window.location };
      var detection = AE.detect(context);
      var extraction = detection ? AE.extract(context) : { links: [], sources: [] };
      extraction.detection = detection;
      return extraction;
    });

    return {
      detected: result.detection || null,
      links: result.links || [],
      sources: result.sources || [],
      pageUrl: page.url(),
      pageTitle: await page.title(),
      sentAt: new Date().toISOString()
    };
  } finally {
    await page.close().catch(function () {});
  }
}

// Batch extraction over several URLs with ONE browser launch. Options:
//   urls - array of target URLs (required, non-empty)
//   executablePath, timeoutMs, settleMs - as in launchAndExtract
//   concurrency - max simultaneous tabs (default 3, clamped to >= 1)
//   onLog - progress logger (fn(message))
//   onResult - per-URL completion callback (fn(entry)) as each finishes
//
// Resolves { results } where results is in the SAME ORDER as the input urls:
//   { url, ok: true, payload }  on success
//   { url, ok: false, error }   on navigation/extraction failure for that URL
// A failing URL never aborts the batch. Throws only before launch (missing
// urls, no browser). sentAt is per-payload, set when each page finishes.
async function launchAndExtractBatch(options) {
  const urls = options && options.urls;
  if (!Array.isArray(urls) || urls.length === 0) {
    throw new Error('launchAndExtractBatch: urls array is required');
  }

  const concurrency = Math.max(1, Math.min(
    (options && typeof options.concurrency === 'number' && options.concurrency > 0) ? options.concurrency : 3,
    urls.length
  ));
  const onLog = (options && typeof options.onLog === 'function') ? options.onLog : function () {};
  const onResult = (options && typeof options.onResult === 'function') ? options.onResult : function () {};

  let resolution = (options && options.executablePath)
    ? { channel: 'custom', executablePath: options.executablePath }
    : resolveBrowser(null);
  if (!resolution) {
    const error = new Error('no Chromium-based browser found');
    error.code = 'NO_BROWSER';
    throw error;
  }

  const puppeteer = require('puppeteer-core');

  onLog('launching ' + resolution.channel + ' (' + resolution.executablePath + ') for ' + urls.length + ' url(s), concurrency ' + concurrency);
  const browser = await puppeteer.launch({
    executablePath: resolution.executablePath,
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--mute-audio'
    ]
  });

  const results = new Array(urls.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const current = nextIndex;
      nextIndex++;
      if (current >= urls.length) {
        return;
      }
      const url = urls[current];
      try {
        const payload = await extractOnPage(browser, url, {
          timeoutMs: options.timeoutMs,
          settleMs: options.settleMs,
          onLog: onLog
        });
        results[current] = { url: url, ok: true, payload: payload };
      } catch (error) {
        results[current] = {
          url: url,
          ok: false,
          error: error && error.message ? error.message : String(error)
        };
      }
      onResult(results[current]);
    }
  }

  try {
    const workers = [];
    for (let i = 0; i < concurrency; i++) {
      workers.push(worker());
    }
    await Promise.all(workers);
  } finally {
    await browser.close().catch(function () {});
  }

  return { results: results };
}

// POSTs the payload to the desktop bridge using the same contract as the
// extension. Resolves { ok, status, body } and never throws for non-2xx.
function sendToBridge(payload, desktopUrl) {
  return new Promise(function (resolve) {
    var target;
    try {
      target = new URL(desktopUrl || DEFAULT_DESKTOP_URL);
    } catch (error) {
      resolve({ ok: false, status: 0, error: 'invalid desktop url' });
      return;
    }

    var body = JSON.stringify(payload);
    var request = http.request({
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      path: target.pathname + (target.search || ''),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      },
      timeout: 5000
    }, function (response) {
      var data = '';
      response.on('data', function (chunk) { data += chunk.toString(); });
      response.on('end', function () {
        var parsed = null;
        try { parsed = JSON.parse(data); } catch (error) { parsed = null; }
        resolve({ ok: response.statusCode >= 200 && response.statusCode < 300, status: response.statusCode, body: parsed });
      });
    });

    request.on('timeout', function () {
      request.destroy(new Error('bridge request timed out'));
    });
    request.on('error', function (error) {
      resolve({ ok: false, status: 0, error: error.message });
    });

    request.write(body);
    request.end();
  });
}

module.exports = {
  resolveBrowser: resolveBrowser,
  launchAndExtract: launchAndExtract,
  launchAndExtractBatch: launchAndExtractBatch,
  sendToBridge: sendToBridge,
  BROWSER_CANDIDATES: BROWSER_CANDIDATES,
  DEFAULT_DESKTOP_URL: DEFAULT_DESKTOP_URL
};
