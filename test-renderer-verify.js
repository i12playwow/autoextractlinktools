#!/usr/bin/env node
//
// test-renderer-verify.js
//
// Hermetic tests for src/renderer/verify.js — the pure link-verification
// display logic used by the desktop window's per-row check action.
//
// The module under test is the exact file the renderer loads as a plain
// script (window.AutoExtractVerify); here it is required under plain Node
// through the same module.exports, so renderer behavior and tested behavior
// cannot drift.
//
// Coverage:
//   - canonicalResult: 2xx/3xx successes, {ok:false}, malformed input,
//     4xx/5xx statuses are never storable successes
//   - applyResult: stores successes, rejects failures, recheck lock rejects
//     a second success inside MIN_MS_BETWEEN_CHECKS regardless of the stored
//     entry's shape, injectable clock, null-map safety
//   - statusOf / statusLabel: unknown rows, just-now / mins / hours / days
//     buckets, clock skew clamping, pluralization boundaries
//   - isStale: fresh entries, stale entries, non-alive states, clock skew
//   - failureMessage: timeout/unreachable/unsafe-url/HTTP-code/error-string
//     mapping and the generic fallback
//   - activityLabel: footer background-verify indicator wording
//   - canonicalEntry / canonicalMap: persistence sanitization (plain values
//     only, timestamp clamping, key bounds, newest-kept bounding, Map and
//     plain-object inputs)
//
// No ports, no browser, no Electron, no DOM.

'use strict';

const verify = require('./src/renderer/verify.js');

const PASS = [];
const FAIL = [];

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(message + ': expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
  }
}

const TESTS = [
  ['canonicalResult: 2xx and 3xx become alive entries', () => {
    assertDeepEqual(verify.canonicalResult({ ok: true, status: 2, note: 'HEAD 200' }),
      { state: 'alive', code: 2, note: 'HEAD 200' }, '2xx');
    assertDeepEqual(verify.canonicalResult({ ok: true, status: 3 }),
      { state: 'alive', code: 3, note: null }, '3xx');
  }],

  ['canonicalResult: non-success input yields null', () => {
    assertEqual(verify.canonicalResult({ ok: false, error: 'timeout' }), null, 'failure');
    assertEqual(verify.canonicalResult({ ok: true, status: 4 }), null, '4xx');
    assertEqual(verify.canonicalResult({ ok: true, status: 5 }), null, '5xx');
    assertEqual(verify.canonicalResult({ ok: true }), null, 'missing status');
    assertEqual(verify.canonicalResult(null), null, 'null');
    assertEqual(verify.canonicalResult('yes'), null, 'string');
    assertEqual(verify.canonicalResult(200), null, 'number');
  }],

  ['applyResult: stores a success with checkedAt from the injected clock', () => {
    const state = new Map();
    const ok = verify.applyResult(state, 'http://x/v.mp4', { ok: true, status: 2 }, 5_000);
    assertEqual(ok, true, 'applied');
    const s = state.get('http://x/v.mp4');
    assertEqual(s.state, 'alive', 'state');
    assertEqual(s.code, 2, 'code');
    assertEqual(s.checkedAt, 5_000, 'checkedAt');
  }],

  ['applyResult: rejects failures and malformed input without writing', () => {
    const state = new Map();
    assertEqual(verify.applyResult(state, 'k', { ok: false, error: 'timeout' }, 1_000), false, 'failure rejected');
    assertEqual(verify.applyResult(state, 'k', { ok: true, status: 5 }, 1_000), false, '5xx rejected');
    assertEqual(verify.applyResult(state, 'k', null, 1_000), false, 'null rejected');
    assertEqual(state.size, 0, 'map untouched');
  }],

  ['applyResult: recheck lock rejects an overlapping answer within the window', () => {
    const state = new Map();
    assertEqual(verify.applyResult(state, 'k', { ok: true, status: 2 }, 10_000), true, 'first applied');
    assertEqual(state.get('k').checkedAt, 10_000, 'first timestamp kept');
    assertEqual(verify.applyResult(state, 'k', { ok: true, status: 2 }, 10_000 + 30_000), false, 'overlapping rejected');
    assertEqual(state.get('k').checkedAt, 10_000, 'original timestamp kept');
  }],

  ['applyResult: accepts a re-answer after the recheck window elapses', () => {
    const state = new Map();
    verify.applyResult(state, 'k', { ok: true, status: 2 }, 10_000);
    assertEqual(verify.applyResult(state, 'k', { ok: true, status: 3 }, 10_000 + verify.MIN_MS_BETWEEN_CHECKS + 1), true, 'later answer applied');
    assertEqual(state.get('k').checkedAt, 10_000 + verify.MIN_MS_BETWEEN_CHECKS + 1, 'timestamp refreshed');
    assertEqual(state.get('k').code, 3, 'code refreshed');
  }],

  ['applyResult: recheck lock is time-based regardless of entry shape', () => {
    const state = new Map();
    state.set('k', { state: 'alive', code: 2, note: null, checkedAt: 0 });
    assertEqual(verify.applyResult(state, 'k', { ok: true, status: 2 }, 30_000), false, 'inside window rejected');
    assertEqual(state.get('k').checkedAt, 0, 'original entry kept');
    assertEqual(verify.applyResult(state, 'k', { ok: true, status: 2 }, 30_000 + verify.MIN_MS_BETWEEN_CHECKS + 1), true, 'outside window accepted');
  }],

  ['applyResult: tolerates a null map without throwing', () => {
    assertEqual(verify.applyResult(null, 'k', { ok: true, status: 2 }, 1_000), false, 'null map');
  }],

  ['statusOf: unknown keys report the unknown state', () => {
    assertEqual(verify.statusOf(new Map(), 'nope').state, 'unknown', 'missing key');
    assertEqual(verify.statusOf(null, 'k').state, 'unknown', 'null map');
  }],

  ['statusLabel: bucket boundaries render as expected', () => {
    const base = { state: 'alive', code: 2, note: null, checkedAt: 0, checking: false };
    assertEqual(verify.statusLabel(base, 0), 'verified just now', 'age zero');
    assertEqual(verify.statusLabel(base, 44_000), 'verified just now', '44s');
    assertEqual(verify.statusLabel(base, 46_000), 'verified 1 min ago', '46s');
    assertEqual(verify.statusLabel(base, 10 * 60_000), 'verified 10 mins ago', '10 mins');
    assertEqual(verify.statusLabel(base, 2 * 3_600_000), 'verified 2 h ago', '2 h');
    assertEqual(verify.statusLabel(base, 3 * 86_400_000), 'verified 3 d ago', '3 d');
  }],

  ['statusLabel: negative ages (clock skew) clamp to just now', () => {
    const base = { state: 'alive', code: 2, note: null, checkedAt: 10_000, checking: false };
    assertEqual(verify.statusLabel(base, 5_000), 'verified just now', 'clamped');
  }],

  ['statusLabel: non-alive and missing statuses produce no label', () => {
    assertEqual(verify.statusLabel(null, 0), '', 'null status');
    assertEqual(verify.statusLabel({ state: 'unknown' }, 0), '', 'unknown state');
  }],

  ['isStale: only old alive entries are stale', () => {
    const base = { state: 'alive', code: 2, note: null, checkedAt: 0, checking: false };
    assertEqual(verify.isStale(base, 10_000), false, 'fresh');
    assertEqual(verify.isStale(base, verify.MIN_MS_BETWEEN_CHECKS + 1), true, 'stale');
    assertEqual(verify.isStale({ state: 'unknown' }, 10 ** 9), false, 'unknown never stale');
    assertEqual(verify.isStale(null, 10 ** 9), false, 'null never stale');
  }],

  ['activityLabel: singular, plural, and hidden states', () => {
    assertEqual(verify.activityLabel(1), 'verifying 1 link\u2026', 'singular');
    assertEqual(verify.activityLabel(3), 'verifying 3 links\u2026', 'plural');
    assertEqual(verify.activityLabel(12), 'verifying 12 links\u2026', 'teens stay plural');
    assertEqual(verify.activityLabel(0), '', 'zero hidden');
    assertEqual(verify.activityLabel(-2), '', 'negative hidden');
    assertEqual(verify.activityLabel(2.9), 'verifying 2 links\u2026', 'fractional floored');
    assertEqual(verify.activityLabel(NaN), '', 'NaN hidden');
    assertEqual(verify.activityLabel('3'), '', 'non-number hidden');
  }],

  ['failureMessage: maps every failure shape to human text', () => {
    assertEqual(verify.failureMessage({ ok: false, error: 'timeout' }), 'Unreachable', 'timeout');
    assertEqual(verify.failureMessage({ ok: false, error: 'unreachable' }), 'Unreachable', 'unreachable');
    assertEqual(verify.failureMessage({ ok: false, error: 'unsafe url' }), 'Not a verifiable http(s) URL', 'unsafe url');
    assertEqual(verify.failureMessage({ ok: false, code: 404 }), 'HTTP 404', 'http code');
    assertEqual(verify.failureMessage({ ok: false, error: 'redirect loop' }), 'redirect loop', 'error string');
    assertEqual(verify.failureMessage({ ok: false }), 'Check failed', 'bare failure');
    assertEqual(verify.failureMessage(null), 'Check failed', 'null');
  }],

  ['canonicalEntry: keeps conforming entries, clamps code, drops the rest', () => {
    assertDeepEqual(verify.canonicalEntry({ code: 200, checkedAt: 1234.7, extra: 'x' }),
      { code: null, checkedAt: 1234 }, 'code clamped to null, timestamp floored, extras dropped');
    assertDeepEqual(verify.canonicalEntry({ code: 3, checkedAt: 99 }),
      { code: 3, checkedAt: 99 }, 'status class 3 kept');
    assertEqual(verify.canonicalEntry({ checkedAt: 0 }), null, 'zero timestamp rejected');
    assertEqual(verify.canonicalEntry({ checkedAt: -5 }), null, 'negative timestamp rejected');
    assertEqual(verify.canonicalEntry({ checkedAt: 'x' }), null, 'non-numeric timestamp rejected');
    assertEqual(verify.canonicalEntry({ checkedAt: Infinity }), null, 'infinite timestamp rejected');
    assertEqual(verify.canonicalEntry(null), null, 'null rejected');
    assertEqual(verify.canonicalEntry('x'), null, 'string rejected');
  }],

  ['canonicalMap: sanitizes Maps and plain objects, bounded newest-kept', () => {
    const m = new Map();
    m.set('http://a/1', { code: 2, checkedAt: 300 });
    m.set('http://a/2', { code: 3, checkedAt: 100 });
    m.set('http://a/3', { checkedAt: 200 });
    m.set(42, { code: 2, checkedAt: 400 });
    m.set('http://a/bad', { checkedAt: 'nope' });
    m.set('x'.repeat(3000), { code: 2, checkedAt: 500 });
    const out = verify.canonicalMap(m, 10);
    assertDeepEqual(Object.keys(out).sort(), ['http://a/1', 'http://a/2', 'http://a/3'], 'only valid string keys survive');
    assertDeepEqual(out['http://a/1'], { code: 2, checkedAt: 300 }, 'entry values canonicalized');
    assertDeepEqual(out['http://a/3'], { code: null, checkedAt: 200 }, 'missing code clamps to null');

    const bounded = verify.canonicalMap({
      'http://old/1': { code: 2, checkedAt: 1 },
      'http://old/2': { code: 2, checkedAt: 2 },
      'http://old/3': { code: 2, checkedAt: 3 }
    }, 2);
    assertDeepEqual(Object.keys(bounded), ['http://old/2', 'http://old/3'], 'oldest dropped, survivors in ascending checkedAt order');

    assertDeepEqual(verify.canonicalMap(null), {}, 'null map -> empty');
    assertDeepEqual(verify.canonicalMap({ a: null, b: 'x' }), {}, 'non-conforming values -> empty');
  }],
];

function assertDeepEqual(actual, expected, message) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) {
    throw new Error(message + ': expected ' + b + ', got ' + a);
  }
}

async function runTests(tests) {
  for (const entry of tests) {
    const name = entry[0];
    const fn = entry[1];
    try {
      await fn();
      PASS.push(name);
      console.log('  PASS  ' + name);
    } catch (error) {
      FAIL.push({ name: name, error: error });
      console.log('  FAIL  ' + name);
      console.log('        ' + (error && error.message ? error.message : String(error)));
    }
  }
}

console.log('\n== renderer verify (src/renderer/verify.js) ==');

runTests(TESTS).then(() => {
  console.log('\nResults: ' + PASS.length + ' passed, ' + FAIL.length + ' failed');
  if (FAIL.length > 0) {
    process.exit(1);
  }
}).catch((error) => {
  console.error('test harness crashed:', error && error.stack ? error.stack : error);
  process.exit(1);
});
