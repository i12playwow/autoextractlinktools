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
// Exit code: 0 only if every suite passed (or skipped). Skipped suites
// (e.g. no browser installed) count as neutral and are labeled SKIP.
//
// Per-suite plan (mirrors `npm test` plus the two E2E flows):
//   test-desktop-contract.js          contract
//   test-shared-detect.js             detection (stub/generic/YouTube/Bilibili)
//   test-storage.js                   storage (encrypted persistence)
//   test-renderer-filter.js           renderer filter (search + type chips)
//   test-desktop-bridge-edge-cases.js bridge edge cases (in-process + real app)
//   test-cli-extract.js               CLI (browser discovery, batch, live)
//   run-desktop-bridge.js             desktop smoke (window + persistence)
//   test-extension-e2e.js             extension E2E (headless browser)
//
// Each child's live output streams through to stdout so CI logs stay
// readable; the Results line is matched out of the same stream.
//
// Run: node scripts/ci-test-summary.js
//

'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const APP_ROOT = path.resolve(__dirname, '..');

const SUITES = [
  { name: 'Contract', script: 'test-desktop-contract.js', countsResults: true },
  { name: 'Detection', script: 'test-shared-detect.js', countsResults: true },
  { name: 'Storage', script: 'test-storage.js', countsResults: true },
  { name: 'Renderer filter', script: 'test-renderer-filter.js', countsResults: true },
  { name: 'Bridge edge cases', script: 'test-desktop-bridge-edge-cases.js', countsResults: true },
  { name: 'CLI extract', script: 'test-cli-extract.js', countsResults: true },
  // The smoke and E2E harnesses are pass/fail scripts without a "Results:"
  // line; exit code 0 (and, for the E2E, at least one PASS marker) decides.
  { name: 'Desktop smoke', script: 'run-desktop-bridge.js', countsResults: false },
  { name: 'Extension E2E', script: 'test-extension-e2e.js', countsResults: false }
];

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
  lines.push('### Test results');
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
  console.log('AutoExtract CI: running ' + SUITES.length + ' suites\n');

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
