#!/usr/bin/env node
//
// test-storage.js
//
// Hermetic tests for src/storage.js (the bridge's JSON persistence layer).
//
// Coverage:
//   - missing file -> empty history, no throw
//   - valid file -> payloads restored, order preserved (oldest first)
//   - corrupt JSON -> treated as no history, no throw
//   - wrong shape (version mismatch, payloads not an array, non-object
//     entries) -> ignored or filtered, no throw
//   - append -> debounced flush -> file content correct, no .tmp leftover
//   - bursts coalesce into a single flush
//   - bounding: only the newest maxPayloads entries are kept
//   - clear: empties memory and the file on the next flush
//   - injectable path: a custom filePath is honored
//   - flush failure: never throws, store stays dirty
//
// Uses a fresh temp directory per test (os.tmpdir + mkdtemp); no ports, no
// browser, no Electron.
//
// Run: node test-storage.js  (also run by npm test)
//

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { PayloadStore } = require(path.join(__dirname, 'src', 'storage.js'));

const PASS = [];
const FAIL = [];

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

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'autoextract-storage-test-'));
}

function readStore(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'autoextract-history.json'), 'utf8'));
}

function makeRecord(n) {
  return {
    receivedAt: new Date(2026, 0, 1, 12, 0, n).toISOString(),
    links: [{ server: 'stub', type: 'video', url: 'http://example.com/video-' + n + '.mp4' }],
    detected: null,
    sources: [],
    pageUrl: 'http://localhost:9999/page-' + n,
    pageTitle: 'Page ' + n
  };
}

const TESTS = [
  ['missing file -> empty history, no throw', () => {
    const dir = makeTempDir();
    const store = new PayloadStore({ filePath: path.join(dir, 'autoextract-history.json') });
    return store.load().then((payloads) => {
      expect(payloads.length, 0, 'restored payloads');
      store.dispose();
    });
  }],

  ['valid file -> payloads restored in order (oldest first)', () => {
    const dir = makeTempDir();
    const store = new PayloadStore({ filePath: path.join(dir, 'autoextract-history.json'), flushDebounceMs: 0 });
    store.appendPayload(makeRecord(1));
    store.appendPayload(makeRecord(2));
    store.flushNow();

    const store2 = new PayloadStore({ filePath: path.join(dir, 'autoextract-history.json') });
    return store2.load().then((payloads) => {
      expect(payloads.length, 2, 'restored count');
      expect(payloads[0].pageUrl, 'http://localhost:9999/page-1', 'first restored pageUrl');
      expect(payloads[1].pageUrl, 'http://localhost:9999/page-2', 'second restored pageUrl');
      store2.dispose();
    });
  }],

  ['corrupt JSON -> treated as no history, no throw', () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, 'autoextract-history.json'), '{ this is not json', 'utf8');
    const store = new PayloadStore({ filePath: path.join(dir, 'autoextract-history.json') });
    return store.load().then((payloads) => {
      expect(payloads.length, 0, 'restored payloads from corrupt file');
      store.dispose();
    });
  }],

  ['wrong shape -> ignored or filtered, no throw', () => {
    const dir = makeTempDir();
    const filePath = path.join(dir, 'autoextract-history.json');

    fs.writeFileSync(filePath, JSON.stringify({ version: 999, payloads: [makeRecord(1)] }), 'utf8');
    const s1 = new PayloadStore({ filePath });
    return s1.load().then((p1) => {
      expect(p1.length, 0, 'version mismatch should yield no history');

      fs.writeFileSync(filePath, JSON.stringify({ version: 1, payloads: 'not-an-array' }), 'utf8');
      const s2 = new PayloadStore({ filePath });
      return s2.load().then((p2) => {
        expect(p2.length, 0, 'non-array payloads should yield no history');

        fs.writeFileSync(filePath, JSON.stringify({ version: 1, payloads: [makeRecord(1), null, 'junk', 42] }), 'utf8');
        const s3 = new PayloadStore({ filePath });
        return s3.load().then((p3) => {
          expect(p3.length, 1, 'non-object entries should be filtered out');
          s1.dispose(); s2.dispose(); s3.dispose();
        });
      });
    });
  }],

  ['append -> debounced flush -> file written, no .tmp leftover', () => {
    const dir = makeTempDir();
    const store = new PayloadStore({ filePath: path.join(dir, 'autoextract-history.json'), flushDebounceMs: 30 });
    store.appendPayload(makeRecord(1));
    store.appendPayload(makeRecord(2));

    return new Promise((resolve) => setTimeout(resolve, 150)).then(() => {
      const onDisk = readStore(dir);
      expect(onDisk.version, 1, 'file version');
      expect(onDisk.payloads.length, 2, 'file payload count');
      expect(onDisk.payloads[1].pageUrl, 'http://localhost:9999/page-2', 'order on disk');
      assert(!fs.existsSync(path.join(dir, 'autoextract-history.json.tmp')), 'no .tmp leftover after successful flush');
      assert(store.dirty === false, 'store should not be dirty after flush');
      store.dispose();
    });
  }],

  ['bursts coalesce into one flush (debounce)', () => {
    const dir = makeTempDir();
    let flushCount = 0;
    const store = new PayloadStore({ filePath: path.join(dir, 'autoextract-history.json'), flushDebounceMs: 60 });
    const originalFlush = store.flushNow.bind(store);
    store.flushNow = function () { flushCount++; originalFlush(); };

    for (let i = 0; i < 20; i++) {
      store.appendPayload(makeRecord(i));
    }

    return new Promise((resolve) => setTimeout(resolve, 220)).then(() => {
      expect(flushCount, 1, 'flush calls for a 20-append burst');
      expect(readStore(dir).payloads.length, 20, 'all payloads on disk');
      store.dispose();
    });
  }],

  ['bounding: only the newest maxPayloads entries are kept', () => {
    const dir = makeTempDir();
    const store = new PayloadStore({ filePath: path.join(dir, 'autoextract-history.json'), maxPayloads: 5, flushDebounceMs: 0 });
    for (let i = 0; i < 8; i++) {
      store.appendPayload(makeRecord(i));
    }
    store.flushNow();

    const onDisk = readStore(dir);
    expect(onDisk.payloads.length, 5, 'bounded count');
    expect(onDisk.payloads[0].pageUrl, 'http://localhost:9999/page-3', 'oldest kept is page-3');
    expect(onDisk.payloads[4].pageUrl, 'http://localhost:9999/page-7', 'newest kept is page-7');
    store.dispose();
  }],

  ['clear empties memory and the file on the next flush', () => {
    const dir = makeTempDir();
    const store = new PayloadStore({ filePath: path.join(dir, 'autoextract-history.json'), flushDebounceMs: 0 });
    store.appendPayload(makeRecord(1));
    store.flushNow();
    expect(readStore(dir).payloads.length, 1, 'pre-clear count');

    store.clear();
    store.flushNow();

    const onDisk = readStore(dir);
    expect(onDisk.payloads.length, 0, 'file payloads after clear');
    assert(Array.isArray(onDisk.payloads), 'payloads stays an array after clear');
    store.dispose();
  }],

  ['injectable path: custom filePath is honored', () => {
    const dir = makeTempDir();
    const customPath = path.join(dir, 'nested', 'custom-name.json');
    const store = new PayloadStore({ filePath: customPath, flushDebounceMs: 0 });
    store.appendPayload(makeRecord(9));
    store.flushNow();

    const onDisk = JSON.parse(fs.readFileSync(customPath, 'utf8'));
    expect(onDisk.payloads.length, 1, 'custom-path payload count');
    expect(onDisk.payloads[0].pageUrl, 'http://localhost:9999/page-9', 'custom-path content');
    store.dispose();
  }],

  ['flush failure keeps dirty state and does not throw', () => {
    const dir = makeTempDir();
    // A directory where the history file should be makes writeFileSync fail.
    const filePath = path.join(dir, 'autoextract-history.json');
    fs.mkdirSync(filePath); // a directory at the file path -> write fails
    const store = new PayloadStore({
      filePath: filePath,
      flushDebounceMs: 0,
      onError: function () {} // expected failure; keep test output clean
    });
    store.appendPayload(makeRecord(1));

    let threw = false;
    try {
      store.flushNow();
    } catch (error) {
      threw = true;
    }
    assert(!threw, 'flushNow must not throw on write failure');
    assert(store.dirty === true, 'store stays dirty after failed flush');
    store.dispose();
  }]
];

// Sequential async runner: each test body may return a promise; failures are
// caught per test and reported at the end.
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

console.log('\n== payload store (src/storage.js) ==');

runTests(TESTS).then(() => {
  console.log('\nResults: ' + PASS.length + ' passed, ' + FAIL.length + ' failed');
  if (FAIL.length > 0) {
    process.exit(1);
  }
}).catch((error) => {
  console.error('test harness crashed:', error && error.stack ? error.stack : error);
  process.exit(1);
});
