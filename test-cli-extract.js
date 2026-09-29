#!/usr/bin/env node
//
// test-cli-extract.js
//
// Tests for the headless extraction library (lib/headless-extract.js) and the
// `autoextract extract` CLI wiring (bin/autoextract.js).
//
// Layers:
//   1. Pure Node, no browser (hermetic, always runs):
//      - resolveBrowser: explicit nonexistent path rejected; an existing
//        executable accepted as 'custom'; candidate table sane per platform.
//      - launchAndExtract / launchAndExtractBatch argument validation.
//      - sendToBridge against a local stub bridge: 200 accepted, 400
//        reported, connection refused reported, invalid URL reported.
//   2. CLI end-to-end via `node bin/autoextract.js` (child process):
//      - NO_BROWSER path is hermetic: --browser with a nonexistent path must
//        exit 2 with a machine-readable JSON error.
//      - Live extraction against a local page server serving
//        test-pages/index.html (the stub-contract page, 2 links), single and
//        batch (multi-URL, one browser launch), including --send forwarding
//        into a stub bridge and partial-failure isolation. Skipped with a
//        note when no Chromium-based browser is installed (mirrors the bridge
//        suite's skip style).
//
// Ports used: 3464 (stub bridge), 3465 (nothing listening, refused test),
// 3466 (test page server: / serves the stub page, /empty serves a page with
// no media). Other harnesses use 3456-3463.
//
// Run: node test-cli-extract.js  (also run by npm test)
//

'use strict';

const http = require('http');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

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

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const APP_ROOT = __dirname;
const LIB = require(path.join(APP_ROOT, 'lib', 'headless-extract.js'));

// ---------------------------------------------------------------------------
// Local stub servers
// ---------------------------------------------------------------------------

function startStubBridge(port) {
  const received = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk.toString(); });
    req.on('end', () => {
      let payload = null;
      try { payload = JSON.parse(body); } catch (error) { payload = null; }
      // Mirrors the real bridge contract in src/main.js: links must be an
      // array of objects with non-empty string urls; an EMPTY array is valid.
      const valid = payload && Array.isArray(payload.links) &&
        payload.links.every((l) => l && typeof l.url === 'string' && l.url.length > 0);
      received.push(payload);
      res.writeHead(valid ? 200 : 400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(valid ? { ok: true, received: true } : { error: 'invalid payload' }));
    });
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve({ server, received }));
  });
}

const EMPTY_PAGE_HTML = '<!doctype html><html><head><meta charset="utf-8"><title>AutoExtract empty page</title></head><body><p>no media here</p></body></html>';

function startPageServer(port) {
  const pageHtml = fs.readFileSync(path.join(APP_ROOT, 'test-pages', 'index.html'));
  const server = http.createServer((req, res) => {
    if (req.url && req.url.indexOf('/empty') === 0) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(EMPTY_PAGE_HTML);
      return;
    }
    if (req.url && req.url !== '/') {
      // Unknown paths 404 so batch tests can exercise per-URL failures.
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(pageHtml);
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve({ server }));
  });
}

function stopServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

// ---------------------------------------------------------------------------
// CLI child-process helper
// ---------------------------------------------------------------------------

function runCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(APP_ROOT, 'bin', 'autoextract.js')].concat(args), {
      cwd: APP_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: Object.assign({}, process.env, { NODE_OPTIONS: '' })
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('CLI run timed out after 120s'));
    }, 120000);
    child.stdout.on('data', (c) => { stdout += c.toString(); });
    child.stderr.on('data', (c) => { stderr += c.toString(); });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function parseJsonOutput(stdout) {
  return JSON.parse(stdout);
}

// ---------------------------------------------------------------------------
// Layer 1: library units (hermetic)
// ---------------------------------------------------------------------------

async function runLibraryTests() {
  section('library: resolveBrowser');

  try {
    const missing = LIB.resolveBrowser(path.join(APP_ROOT, 'definitely-not-a-browser.exe'));
    expect(missing, null, 'nonexistent explicit path should resolve to null');
    pass('nonexistent explicit path rejected');
  } catch (error) { fail('nonexistent explicit path rejected', error); }

  try {
    const custom = LIB.resolveBrowser(process.execPath);
    assert(custom && custom.channel === 'custom', 'existing executable should resolve as custom, got ' + JSON.stringify(custom));
    assert(custom.executablePath === process.execPath, 'custom path should be echoed');
    pass('existing executable accepted as custom browser');
  } catch (error) { fail('existing executable accepted as custom browser', error); }

  try {
    assert(Array.isArray(LIB.BROWSER_CANDIDATES) && LIB.BROWSER_CANDIDATES.length >= 3, 'candidate table should list several browsers');
    LIB.BROWSER_CANDIDATES.forEach((candidate) => {
      assert(candidate.channel && candidate.paths, 'candidate needs channel+paths: ' + candidate.channel);
      const platformPaths = candidate.paths[process.platform];
      assert(Array.isArray(platformPaths), 'candidate ' + candidate.channel + ' missing ' + process.platform + ' paths');
    });
    pass('candidate table covers the current platform');
  } catch (error) { fail('candidate table covers the current platform', error); }

  section('library: argument validation');

  try {
    let rejected = false;
    try {
      await LIB.launchAndExtract({});
    } catch (error) {
      rejected = true;
    }
    assert(rejected, 'launchAndExtract missing url must reject');
    pass('launchAndExtract missing url rejects');
  } catch (error) { fail('launchAndExtract missing url rejects', error); }

  try {
    let rejectedEmpty = false;
    let rejectedNonArray = false;
    try {
      await LIB.launchAndExtractBatch({ urls: [] });
    } catch (error) {
      rejectedEmpty = true;
    }
    try {
      await LIB.launchAndExtractBatch({ urls: 'not-an-array' });
    } catch (error) {
      rejectedNonArray = true;
    }
    assert(rejectedEmpty && rejectedNonArray, 'launchAndExtractBatch must reject empty/non-array urls');
    pass('launchAndExtractBatch rejects empty and non-array urls');
  } catch (error) { fail('launchAndExtractBatch rejects empty and non-array urls', error); }

  section('library: sendToBridge against a stub bridge');

  const bridgePort = 3464;
  const refusedPort = 3465;
  const { server: bridgeServer, received } = await startStubBridge(bridgePort);

  try {
    const good = await LIB.sendToBridge({ links: [{ url: 'http://example.com/v.mp4' }] }, 'http://127.0.0.1:' + bridgePort + '/');
    expect(good.ok, true, 'valid payload should be accepted');
    expect(good.status, 200, 'valid payload status');
    pass('valid payload accepted (200, ok)');
  } catch (error) { fail('valid payload accepted (200, ok)', error); }

  try {
    const bad = await LIB.sendToBridge({ links: 'not-an-array' }, 'http://127.0.0.1:' + bridgePort + '/');
    expect(bad.ok, false, 'invalid payload should not be ok');
    expect(bad.status, 400, 'invalid payload status');
    pass('invalid payload reported (400)');
  } catch (error) { fail('invalid payload reported (400)', error); }

  try {
    const refused = await LIB.sendToBridge({ links: [{ url: 'http://example.com/v.mp4' }] }, 'http://127.0.0.1:' + refusedPort + '/');
    expect(refused.ok, false, 'connection refused should not be ok');
    expect(refused.status, 0, 'connection refused should report status 0');
    assert(refused.error, 'connection refused should carry an error message');
    pass('connection refused reported without throwing');
  } catch (error) { fail('connection refused reported without throwing', error); }

  try {
    const invalid = await LIB.sendToBridge({ links: [] }, 'not a url at all');
    expect(invalid.ok, false, 'invalid desktop url should not be ok');
    pass('invalid desktop url reported without throwing');
  } catch (error) { fail('invalid desktop url reported without throwing', error); }

  try {
    assert(received.length >= 2, 'stub bridge should have received the direct sends');
    pass('stub bridge observed direct sends');
  } catch (error) { fail('stub bridge observed direct sends', error); }

  await stopServer(bridgeServer);
}

// ---------------------------------------------------------------------------
// Layer 2: CLI end-to-end
// ---------------------------------------------------------------------------

async function runCliTests() {
  const pagePort = 3466;
  const { server: pageServer } = await startPageServer(pagePort);
  const pageUrl = 'http://127.0.0.1:' + pagePort + '/';
  const emptyUrl = 'http://127.0.0.1:' + pagePort + '/empty';
  // A URL with nothing listening: page.goto throws on connection failure,
  // which is what the per-URL error isolation tests need (HTTP 404 pages are
  // navigated and extracted like any other page, not treated as failures).
  const deadUrl = 'http://127.0.0.1:3465/dead';
  const liveBrowser = LIB.resolveBrowser(null);

  try {
    section('cli: NO_BROWSER path (hermetic)');

    try {
      const result = await runCli(['extract', pageUrl, '--json', '--browser', path.join(APP_ROOT, 'no-such-browser.exe')]);
      expect(result.code, 2, 'exit code for missing browser');
      const parsed = parseJsonOutput(result.stdout);
      expect(parsed.ok, false, 'JSON ok flag');
      expect(parsed.code, 'NO_BROWSER', 'JSON error code');
      pass('--browser nonexistent path exits 2 with NO_BROWSER JSON');
    } catch (error) { fail('--browser nonexistent path exits 2 with NO_BROWSER JSON', error); }

    if (!liveBrowser) {
      section('cli: live extraction');
      console.log('  SKIP  no Chromium-based browser found; live extraction tests skipped');
      return;
    }

    section('library: launchAndExtractBatch (live)');

    try {
      const outcome = await LIB.launchAndExtractBatch({
        urls: [pageUrl, pageUrl, deadUrl],
        settleMs: 0
      });
      assert(Array.isArray(outcome.results) && outcome.results.length === 3, 'batch should return 3 results in order');
      expect(outcome.results[0].url, pageUrl, 'result order [0]');
      expect(outcome.results[2].url, deadUrl, 'result order [2]');
      assert(outcome.results[0].ok && outcome.results[1].ok, 'the two good URLs should succeed');
      assert(!outcome.results[2].ok, 'the connection-refused URL should fail');
      assert(outcome.results[2].error, 'failed entry should carry an error message');
      expect(outcome.results[0].payload.links.length, 2, 'good URL link count');
      pass('batch returns per-URL results in input order, failures isolated');
    } catch (error) { fail('batch returns per-URL results in input order, failures isolated', error); }

    section('cli: live headless extraction (found: ' + liveBrowser.channel + ')');

    try {
      const result = await runCli(['extract', pageUrl, '--json']);
      expect(result.code, 0, 'exit code with links found');
      const parsed = parseJsonOutput(result.stdout);
      expect(parsed.ok, true, 'JSON ok flag');
      assert(Array.isArray(parsed.links) && parsed.links.length === 2, 'expected 2 stub links, got ' + JSON.stringify(parsed.links && parsed.links.length));
      assert(parsed.detected && parsed.detected.type === 'stub', 'detection should report the stub contract');
      assert(typeof parsed.pageUrl === 'string' && parsed.pageUrl.indexOf('127.0.0.1:' + pagePort) !== -1, 'pageUrl should echo the served page');
      pass('--json extraction returns the stub-contract links with exit 0');
    } catch (error) { fail('--json extraction returns the stub-contract links with exit 0', error); }

    try {
      const result = await runCli(['extract', pageUrl]);
      expect(result.code, 0, 'human-readable exit code');
      assert(result.stdout.indexOf('Found 2 link(s)') !== -1, 'human output should count links, got: ' + JSON.stringify(result.stdout.slice(0, 200)));
      pass('human-readable output lists found links');
    } catch (error) { fail('human-readable output lists found links', error); }

    try {
      const result = await runCli(['extract', emptyUrl, '--json']);
      expect(result.code, 3, 'single empty page should exit 3 without --allow-empty');
      const parsed = parseJsonOutput(result.stdout);
      expect(parsed.ok, true, 'extraction itself succeeded');
      expect(parsed.links.length, 0, 'empty page should have no links');
      pass('single URL with no links exits 3');
    } catch (error) { fail('single URL with no links exits 3', error); }

    try {
      const result = await runCli(['extract', emptyUrl, '--json', '--allow-empty']);
      expect(result.code, 0, '--allow-empty should relax exit 3');
      pass('--allow-empty exits 0 on an empty page');
    } catch (error) { fail('--allow-empty exits 0 on an empty page', error); }

    const { server: bridgeServer, received: bridgeReceived } = await startStubBridge(3464);
    try {
      const result = await runCli(['extract', pageUrl, '--json', '--send', '--desktop-url', 'http://127.0.0.1:3464/']);
      expect(result.code, 0, '--send exit code');
      const parsed = parseJsonOutput(result.stdout);
      assert(parsed.bridgeResult && parsed.bridgeResult.ok === true, 'bridgeResult should be ok, got ' + JSON.stringify(parsed.bridgeResult));
      assert(bridgeReceived.length >= 1, 'stub bridge should have received the forwarded payload');
      const forwarded = bridgeReceived[bridgeReceived.length - 1];
      assert(Array.isArray(forwarded.links) && forwarded.links.length === 2, 'forwarded payload should carry both links');
      pass('--send forwards the payload to the desktop bridge');
    } catch (error) { fail('--send forwards the payload to the desktop bridge', error); }
    await stopServer(bridgeServer);

    section('cli: live batch extraction (multiple URLs)');

    try {
      const result = await runCli(['extract', pageUrl, pageUrl, '--json']);
      expect(result.code, 0, 'batch success exit code');
      const parsed = parseJsonOutput(result.stdout);
      expect(parsed.ok, true, 'batch JSON ok flag');
      assert(Array.isArray(parsed.results) && parsed.results.length === 2, 'batch results array in envelope');
      parsed.results.forEach((entry, i) => {
        assert(entry.ok === true, 'result ' + i + ' should be ok');
        assert(entry.url === pageUrl, 'result ' + i + ' url');
        assert(Array.isArray(entry.payload.links) && entry.payload.links.length === 2, 'result ' + i + ' link count');
      });
      pass('--json batch envelope carries per-URL results in order');
    } catch (error) { fail('--json batch envelope carries per-URL results in order', error); }

    try {
      const result = await runCli(['extract', pageUrl, pageUrl, deadUrl, '--json']);
      expect(result.code, 1, 'partial batch failure should exit 1');
      const parsed = parseJsonOutput(result.stdout);
      assert(parsed.results.length === 3, 'three results returned');
      assert(parsed.results[0].ok && parsed.results[1].ok, 'good URLs still succeed');
      assert(parsed.results[2].ok === false && parsed.results[2].error, 'failed URL recorded with error');
      pass('partial batch failure exits 1 with failures isolated per URL');
    } catch (error) { fail('partial batch failure exits 1 with failures isolated per URL', error); }

    try {
      const result = await runCli(['extract', emptyUrl, emptyUrl, '--json']);
      expect(result.code, 3, 'all-empty batch should exit 3 without --allow-empty');
      const parsed = parseJsonOutput(result.stdout);
      expect(parsed.ok, false, 'all-empty batch ok flag');
      pass('all-empty batch exits 3');
    } catch (error) { fail('all-empty batch exits 3', error); }

    try {
      const result = await runCli(['extract', pageUrl, pageUrl]);
      expect(result.code, 0, 'human batch exit code');
      assert(result.stdout.indexOf('Batch: 2/2 url(s) with links') !== -1, 'human batch summary missing, got: ' + JSON.stringify(result.stdout.slice(-300)));
      pass('human batch output lists each URL and a summary');
    } catch (error) { fail('human batch output lists each URL and a summary', error); }

    const { server: batchBridgeServer, received: batchBridgeReceived } = await startStubBridge(3464);
    try {
      const result = await runCli(['extract', pageUrl, pageUrl, emptyUrl, '--json', '--send', '--desktop-url', 'http://127.0.0.1:3464/']);
      expect(result.code, 0, 'batch --send exit code');
      const parsed = parseJsonOutput(result.stdout);
      // Every successful extraction is forwarded (including 0-link pages,
      // matching single-URL --send behavior); failed URLs are never sent.
      parsed.results.forEach((entry) => {
        assert(entry.ok === true, 'all three URLs should succeed in this batch');
        assert(entry.bridgeResult && entry.bridgeResult.ok === true, 'each entry should have a successful bridgeResult, got ' + JSON.stringify(entry.bridgeResult));
      });
      expect(batchBridgeReceived.length, 3, 'stub bridge should receive all three payloads');
      pass('batch --send forwards every successful payload to the desktop bridge');
    } catch (error) { fail('batch --send forwards every successful payload to the desktop bridge', error); }
    await stopServer(batchBridgeServer);
  } finally {
    await stopServer(pageServer);
  }
}

// ---------------------------------------------------------------------------

async function run() {
  await runLibraryTests();
  await runCliTests();

  console.log('\nResults: ' + PASS.length + ' passed, ' + FAIL.length + ' failed');
  if (FAIL.length > 0) {
    process.exit(1);
  }
}

run().catch((error) => {
  console.error('test harness crashed:', error && error.stack ? error.stack : error);
  process.exit(1);
});
