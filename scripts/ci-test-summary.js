#!/usr/bin/env node
//
// scripts/ci-test-summary.js
//
// CI runner used by the workflow: executes every test suite (plus the desktop
// smoke test and the extension E2E), parses each suite's "Results: N passed,
// M failed" line, and writes a per-suite table to $GITHUB_STEP_SUMMARY so the
// run page shows per-suite results at a glance. Locally (no
// GITHUB_STEP_SUMMARY set) it just runs everything and prints the same table
// to stdout, so it doubles as a full-project test runner.
//
// Modes:
//   node scripts/ci-test-summary.js          full run (all suites + E2Es)
//   node scripts/ci-test-summary.js --light  light run: only the pure-Node
//     suites — no Electron binary, no display, no headless browser. This is
//     what the workflow's Light job runs: it needs nothing beyond `npm ci
//     --ignore-scripts`, gives every push fast automated signal, and keeps
//     working when Electron/browser-dependent layers cannot (runner image
//     changes, browser availability, billing-limited slow lanes).
//   node scripts/ci-test-summary.js --check-mirror  verify the suite lists
//     have not drifted apart: every counted suite must appear in `npm test`
//     in the same order, every suite script must exist, the workflow must
//     run both modes, and the pinned CI surface is intact — ubuntu-24.04
//     runners (no floating ubuntu-latest that could jump images
//     mid-migration), node24-runtime action majors (@v5 checkout,
//     setup-node, cache), one explicit node-version across jobs, and an
//     ELECTRON_VERSION cache-key env matching package-lock.json's electron.
//     Exits non-zero on any drift; runs as a step in the Light job so drift
//     breaks CI instead of silently skipping suites.
//
// Exit code: 0 only if every suite passed (or skipped). Skipped suites
// (e.g. no browser installed) count as neutral and are labeled SKIP.
//
// Full-mode per-suite plan (mirrors `npm test` plus the two E2E flows):
//   test-desktop-contract.js          contract
//   test-shared-detect.js             detection (stub/generic/YouTube/Bilibili)
//   test-storage.js                   storage (encrypted persistence)
//   test-renderer-filter.js           renderer filter (search + type chips)
//   test-renderer-verify.js           renderer verify (last-verified badges)
//   test-desktop-bridge-edge-cases.js bridge edge cases (in-process + real app)
//   test-cli-extract.js               CLI (browser discovery, batch, live)
//   run-desktop-bridge.js             desktop smoke (window + persistence)
//   test-extension-e2e.js             extension E2E (headless browser)
//
// Each child's live output streams through to stdout so CI logs stay
// readable; the Results line is matched out of the same stream.
//
// Run: node scripts/ci-test-summary.js [--light] [--check-mirror]
//

'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const APP_ROOT = path.resolve(__dirname, '..');

// --light: pure-Node suites only. The bridge edge-case suite is included:
// its in-process sections carry the bulk of the behavioral checks, and its
// real-Electron section SKIPs by itself when node_modules/electron/dist is
// absent (which `npm ci --ignore-scripts` guarantees on the Light job).
const LIGHT_MODE = process.argv.includes('--light');

const FULL_SUITES = [
  { name: 'Contract', script: 'test-desktop-contract.js', countsResults: true },
  { name: 'Detection', script: 'test-shared-detect.js', countsResults: true },
  { name: 'Storage', script: 'test-storage.js', countsResults: true },
  { name: 'Renderer filter', script: 'test-renderer-filter.js', countsResults: true },
  { name: 'Renderer verify', script: 'test-renderer-verify.js', countsResults: true },
  { name: 'Bridge edge cases', script: 'test-desktop-bridge-edge-cases.js', countsResults: true },
  { name: 'CLI extract', script: 'test-cli-extract.js', countsResults: true },
  // The smoke and E2E harnesses are pass/fail scripts without a "Results:"
  // line; exit code 0 (and, for the E2E, at least one PASS marker) decides.
  { name: 'Desktop smoke', script: 'run-desktop-bridge.js', countsResults: false },
  { name: 'Extension E2E', script: 'test-extension-e2e.js', countsResults: false }
];

const LIGHT_SUITES = [
  { name: 'Contract', script: 'test-desktop-contract.js', countsResults: true },
  { name: 'Detection', script: 'test-shared-detect.js', countsResults: true },
  { name: 'Storage', script: 'test-storage.js', countsResults: true },
  { name: 'Renderer filter', script: 'test-renderer-filter.js', countsResults: true },
  { name: 'Renderer verify', script: 'test-renderer-verify.js', countsResults: true },
  { name: 'Bridge edge cases (in-process)', script: 'test-desktop-bridge-edge-cases.js', countsResults: true }
];

const SUITES = LIGHT_MODE ? LIGHT_SUITES : FULL_SUITES;

// --check-mirror: verify this runner still mirrors the two other places that
// name suites — the `npm test` chain in package.json and the workflow's
// invocations of this script — so the lists cannot drift apart silently when
// a suite is added or renamed. Pure file reading; no suites are executed.
function checkMirror() {
  const problems = [];

  // 1. Every full-mode suite script exists on disk.
  FULL_SUITES.forEach((suite) => {
    if (!fs.existsSync(path.join(APP_ROOT, suite.script))) {
      problems.push('missing suite script: ' + suite.script);
    }
  });

  // 2. `npm test` names exactly the counted full-mode suites, in the same
  //    order. (The smoke and E2E harnesses are CI-only by design and are
  //    not part of the npm chain.)
  const pkg = JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8'));
  const chain = [];
  String(pkg.scripts && pkg.scripts.test || '').split('&&').forEach((cmd) => {
    const m = cmd.match(/node\s+([\w./-]+\.js)/);
    if (m) {
      chain.push(m[1]);
    }
  });
  const counted = FULL_SUITES.filter((s) => s.countsResults).map((s) => s.script);
  if (JSON.stringify(chain) !== JSON.stringify(counted)) {
    problems.push('npm test chain ' + JSON.stringify(chain) +
      ' does not mirror the runner suite list ' + JSON.stringify(counted));
  }

  // 3. The workflow runs both modes: the Light job installs without the
  //    Electron postinstall and invokes --light; the full list runs on both
  //    matrix OSes.
  const workflow = fs.readFileSync(path.join(APP_ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
  if (workflow.indexOf('npm ci --ignore-scripts') === -1) {
    problems.push('workflow light job does not install with --ignore-scripts');
  }
  if (!/ci-test-summary\.js\s+--light/.test(workflow)) {
    problems.push('workflow does not run the light suite list (--light)');
  }
  const fullUses = (workflow.match(/node scripts\/ci-test-summary\.js(?!\s+--light)/g) || []).length;
  if (fullUses < 2) {
    problems.push('workflow runs the full suite list ' + fullUses +
      ' time(s), expected at least 2 (Linux + Windows)');
  }

  // 4. Ubuntu runners are pinned: ubuntu-latest migrates to Ubuntu 26 on
  //    Oct 19, 2026 (actions/runner-images#14748), and an image swap must
  //    never be the reason a push goes red. The light job pins via
  //    runs-on; the matrix job pins via its os list.
  if (/runs-on:\s*ubuntu-latest/m.test(workflow)) {
    problems.push('workflow still uses floating ubuntu-latest; pin to ubuntu-24.04');
  }
  if (!/runs-on:\s*ubuntu-24\.04/.test(workflow)) {
    problems.push('no job pins runs-on to ubuntu-24.04 (light job expected to)');
  }
  if (!/os:\s*\[[^\]]*ubuntu-24\.04/.test(workflow)) {
    problems.push('the test matrix does not pin ubuntu-24.04 in its os list');
  }

  // 5. Actions stay on node24-runtime majors: node20 was removed from the
  //    hosted runners on Sep 23, 2026, so any @v4 checkout/setup-node/cache
  //    is a deprecation warning (and a future hard failure).
  ['checkout', 'setup-node', 'cache'].forEach((action) => {
    const uses = workflow.match(new RegExp('uses:\\s*actions/' + action + '@(\\S+)')) || [];
    const found = uses[1] || 'missing';
    if (found.indexOf('v5') !== 0) {
      problems.push('actions/' + action + ' is @' + found + '; expected @v5 (node24 runtime)');
    }
  });

  // 6. The Node version in both setup-node steps is an explicit LTS pin, and
  //    the Electron cache key is derived from an ELECTRON_VERSION env that
  //    matches the lockfile — a lockfile bump without the workflow update
  //    would silently cache-miss forever.
  const nodeVersions = (workflow.match(/node-version:\s*\S+/g) || []).sort();
  if (nodeVersions.length < 2 || nodeVersions[0] !== nodeVersions[nodeVersions.length - 1]) {
    problems.push('setup-node node-version values differ across jobs: ' + JSON.stringify(nodeVersions));
  }
  if (nodeVersions[0] !== 'node-version: 22') {
    problems.push('node-version is ' + nodeVersions[0] + '; expected "node-version: 22" (change the mirror check too if you meant it)');
  }
  const lock = JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'package-lock.json'), 'utf8'));
  const lockElectron = String(lock.packages && lock.packages['node_modules/electron'] &&
    lock.packages['node_modules/electron'].version || '');
  const envMatch = workflow.match(/ELECTRON_VERSION:\s*"([^"]+)"/);
  const envElectron = envMatch ? envMatch[1] : null;
  if (!envElectron) {
    problems.push('workflow does not define an ELECTRON_VERSION env for the electron cache key');
  } else if (lockElectron && envElectron !== lockElectron) {
    problems.push('workflow ELECTRON_VERSION ' + envElectron + ' does not match package-lock.json electron ' + lockElectron);
  }
  if (!/~\/\.cache\/electron/.test(workflow) || !/AppData\/Local\/electron\/Cache/.test(workflow)) {
    problems.push('electron cache path must list both the Linux (~/.cache/electron) and Windows (%LOCALAPPDATA%\\electron\\Cache) roots');
  }

  if (problems.length > 0) {
    console.log('AutoExtract CI mirror check FAILED:');
    problems.forEach((p) => console.log('  - ' + p));
    process.exit(1);
  }
  console.log('AutoExtract CI mirror check OK: ' + counted.length +
    ' counted suites mirror `npm test` in order, every suite script exists,' +
    ' and the workflow runs both the light and full lists.');
}

const RESULTS_RE = /Results:\s*(\d+)\s+passed(?:,\s*(\d+)\s+failed)?/;

function runSuite(suite) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(APP_ROOT, suite.script)], {
      cwd: APP_ROOT,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let passed = null;
    let failed = null;
    let skipped = false;
    let tail = '';

    const handleChunk = (chunk) => {
      const text = chunk.toString();
      process.stdout.write(text);
      tail = (tail + text).slice(-8000);

      const match = tail.match(RESULTS_RE);
      if (match) {
        passed = parseInt(match[1], 10);
        failed = match[2] !== undefined ? parseInt(match[2], 10) : 0;
      }
      if (text.indexOf('SKIP') !== -1) {
        skipped = true;
      }
    };

    child.stdout.on('data', handleChunk);
    child.stderr.on('data', handleChunk);

    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ suite, status: 'failed', passed, failed, note: 'timed out after 10 minutes' });
    }, 600000);

    child.on('error', (error) => {
      clearTimeout(timeout);
      resolve({ suite, status: 'failed', passed, failed, note: 'spawn failed: ' + error.message });
    });

    child.on('exit', (code) => {
      clearTimeout(timeout);
      if (skipped && (passed === null || passed === 0)) {
        resolve({ suite, status: 'skipped', passed, failed, note: 'suite reported SKIP' });
        return;
      }

      if (suite.countsResults) {
        if (code === 0 && failed === 0 && passed !== null) {
          resolve({ suite, status: 'passed', passed, failed });
        } else {
          resolve({
            suite,
            status: 'failed',
            passed,
            failed,
            note: code === 0 ? 'no Results line parsed' : 'exit code ' + code
          });
        }
        return;
      }

      // Pass/fail harness without a Results line.
      if (code === 0) {
        resolve({ suite, status: 'passed', passed: null, failed: null });
      } else {
        resolve({ suite, status: 'failed', passed, failed, note: 'exit code ' + code });
      }
    });
  });
}

function emojiFor(status) {
  if (status === 'passed') { return '✅'; }
  if (status === 'skipped') { return '⏭️'; }
  return '❌';
}

function buildSummaryTable(results) {
  const lines = [];
  lines.push(LIGHT_MODE ? '### Test results (light — pure-Node suites)' : '### Test results');
  lines.push('');
  lines.push('| Suite | Status | Passed | Failed |');
  lines.push('|-------|--------|-------:|-------:|');

  let totalPassed = 0;
  let totalFailed = 0;
  let anyFailed = false;
  let anySkipped = false;

  results.forEach((r) => {
    const status = emojiFor(r.status) + ' ' + r.status;
    const passed = r.passed === null ? '—' : String(r.passed);
    const failed = r.failed === null ? '—' : String(r.failed);
    lines.push('| ' + r.suite.name + ' | ' + status + ' | ' + passed + ' | ' + failed + ' |');

    if (r.status === 'passed') {
      totalPassed += r.passed;
      totalFailed += r.failed;
    } else if (r.status === 'failed') {
      anyFailed = true;
      totalFailed += (r.failed || 0);
    } else {
      anySkipped = true;
    }
  });

  lines.push('| **Total** | ' + (anyFailed ? '❌ failing' : '✅ passing') + ' | **' + totalPassed + '** | **' + totalFailed + '** |');
  lines.push('');

  const failing = results.filter((r) => r.status === 'failed');
  if (failing.length > 0) {
    lines.push('#### Failing suites');
    lines.push('');
    failing.forEach((r) => {
      lines.push('- **' + r.suite.name + '** (' + r.suite.script + ')' + (r.note ? ': ' + r.note : ''));
    });
    lines.push('');
  }

  if (anySkipped) {
    const skipped = results.filter((r) => r.status === 'skipped');
    lines.push('> Skipped (environment-dependent, not a failure): ' +
      skipped.map((r) => r.suite.name).join(', '));
    lines.push('');
  }

  return lines.join('\n');
}

async function main() {
  if (process.argv.includes('--check-mirror')) {
    checkMirror();
    return;
  }

  console.log('AutoExtract CI: running ' + SUITES.length + ' suites' +
    (LIGHT_MODE ? ' (light mode: pure Node, no Electron/browser flows)' : '') + '\n');

  const results = [];
  for (const suite of SUITES) {
    console.log('\n========== ' + suite.name + ' (' + suite.script + ') ==========');
    const result = await runSuite(suite);
    results.push(result);
  }

  const table = buildSummaryTable(results);
  console.log('\n' + table);

  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    try {
      fs.appendFileSync(summaryPath, table + '\n', 'utf8');
      console.log('(summary appended to $GITHUB_STEP_SUMMARY)');
    } catch (error) {
      console.error('failed to write step summary:', error.message);
    }
  }

  const anyFailed = results.some((r) => r.status === 'failed');
  process.exit(anyFailed ? 1 : 0);
}

main().catch((error) => {
  console.error('ci-test-summary crashed:', error && error.stack ? error.stack : error);
  process.exit(1);
});
