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
// Encryption coverage (v2):
//   - default (keyfile) adapter: file on disk is ciphertext, no plaintext
//     leak, round-trip restore works
//   - every flush uses a fresh nonce (same content, different envelope)
//   - custom adapter round-trip (fake safeStorage shape)
//   - tampered ciphertext is rejected (no history, not a crash)
//   - corrupt keyfile is treated as no history (keys must match) — simulated
//     by loading with a different key
//   - legacy v1 plaintext file loads and is upgraded to v2 on flush
//

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { PayloadStore, useKeyfileAdapter } = require(path.join(__dirname, 'src', 'storage.js'));

// Fake adapter mimicking the app's safeStorage shape: decryptable only with
// the same secret, no real crypto (tests only).
function makeFakeAdapter(secret) {
  return {
    encrypt: function (plaintext) {
      return { data: Buffer.from(secret + ':' + plaintext, 'utf8').toString('base64'), nonce: 'fakenonce' };
    },
    decrypt: function (envelope) {
      var opened = Buffer.from(envelope.data, 'base64').toString('utf8');
      if (opened.indexOf(secret + ':') !== 0) {
        throw new Error('wrong secret');
      }
      return opened.slice(secret.length + 1);
    }
  };
}

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

// Loads the history through the store API (the on-disk shape is an encrypted
// envelope, so raw parsing can only inspect envelope fields).
function loadViaStore(filePath) {
  const loader = new PayloadStore({ filePath });
  return loader.load().then((payloads) => {
    loader.dispose();
    return payloads;
  });
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
      const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'autoextract-history.json'), 'utf8'));
      expect(onDisk.version, 2, 'on-disk envelope version');
      assert(onDisk.ciphertext && onDisk.nonce, 'envelope carries ciphertext + nonce');
      assert(!fs.existsSync(path.join(dir, 'autoextract-history.json.tmp')), 'no .tmp leftover after successful flush');
      assert(store.dirty === false, 'store should not be dirty after flush');
      store.dispose();

      return loadViaStore(path.join(dir, 'autoextract-history.json')).then((payloads) => {
        expect(payloads.length, 2, 'payload count after reload');
        expect(payloads[1].pageUrl, 'http://localhost:9999/page-2', 'order after reload');
      });
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
      return loadViaStore(path.join(dir, 'autoextract-history.json')).then((payloads) => {
        expect(payloads.length, 20, 'all payloads on disk');
      });
    });
  }],

  ['bounding: only the newest maxPayloads entries are kept', () => {
    const dir = makeTempDir();
    const store = new PayloadStore({ filePath: path.join(dir, 'autoextract-history.json'), maxPayloads: 5, flushDebounceMs: 0 });
    for (let i = 0; i < 8; i++) {
      store.appendPayload(makeRecord(i));
    }
    store.flushNow();
    store.dispose(); // cancel the pending 0ms re-flush

    return loadViaStore(path.join(dir, 'autoextract-history.json')).then((payloads) => {
      expect(payloads.length, 5, 'bounded count');
      expect(payloads[0].pageUrl, 'http://localhost:9999/page-3', 'oldest kept is page-3');
      expect(payloads[4].pageUrl, 'http://localhost:9999/page-7', 'newest kept is page-7');
    });
  }],

  ['clear empties memory and the file on the next flush', () => {
    const dir = makeTempDir();
    const store = new PayloadStore({ filePath: path.join(dir, 'autoextract-history.json'), flushDebounceMs: 0 });
    store.appendPayload(makeRecord(1));
    store.flushNow();
    store.dispose(); // cancel the pending 0ms re-flush

    return loadViaStore(path.join(dir, 'autoextract-history.json')).then((payloadsBefore) => {
      expect(payloadsBefore.length, 1, 'pre-clear count');

      store.clear();
      store.flushNow();
      store.dispose();

      return loadViaStore(path.join(dir, 'autoextract-history.json')).then((payloads) => {
        expect(payloads.length, 0, 'file payloads after clear');
      });
    });
  }],

  ['injectable path: custom filePath is honored', () => {
    const dir = makeTempDir();
    const customPath = path.join(dir, 'nested', 'custom-name.json');
    const store = new PayloadStore({ filePath: customPath, flushDebounceMs: 0 });
    store.appendPayload(makeRecord(9));
    store.flushNow();

    const onDisk = JSON.parse(fs.readFileSync(customPath, 'utf8'));
    expect(onDisk.version, 2, 'custom-path envelope version');
    assert(onDisk.ciphertext, 'custom-path ciphertext present');
    store.dispose();

    return loadViaStore(customPath).then((payloads) => {
      expect(payloads.length, 1, 'custom-path payload count');
      expect(payloads[0].pageUrl, 'http://localhost:9999/page-9', 'custom-path content');
    });
  }],

  ['encrypted v2 (default keyfile adapter): ciphertext at rest, no plaintext leak, restores', () => {
    const dir = makeTempDir();
    const filePath = path.join(dir, 'autoextract-history.json');
    const store = new PayloadStore({ filePath, flushDebounceMs: 0 });
    store.appendPayload(makeRecord(1));
    store.flushNow();

    const raw = fs.readFileSync(filePath, 'utf8');
    const onDisk = JSON.parse(raw);
    expect(onDisk.version, 2, 'on-disk version');
    expect(onDisk.encryption, 'aes-256-gcm', 'encryption label');
    assert(onDisk.ciphertext && typeof onDisk.ciphertext === 'string', 'ciphertext present');
    assert(onDisk.nonce && onDisk.nonce.length === 24, '96-bit nonce present as hex');
    assert(raw.indexOf('http://localhost:9999/page-1') === -1, 'pageUrl must not appear in plaintext');
    assert(raw.indexOf('Page 1') === -1, 'pageTitle must not appear in plaintext');
    assert(fs.existsSync(path.join(dir, 'autoextract-history.json.key')), 'keyfile created next to history');

    const store2 = new PayloadStore({ filePath });
    return store2.load().then((payloads) => {
      expect(payloads.length, 1, 'restored count');
      expect(payloads[0].pageUrl, 'http://localhost:9999/page-1', 'restored pageUrl');
      store2.dispose();
    });
  }],

  ['every flush uses a fresh nonce', () => {
    const dir = makeTempDir();
    const filePath = path.join(dir, 'autoextract-history.json');
    const store = new PayloadStore({ filePath, flushDebounceMs: 0 });
    store.appendPayload(makeRecord(1));
    store.flushNow();
    const nonce1 = JSON.parse(fs.readFileSync(filePath, 'utf8')).nonce;
    store.flushNow();
    const nonce2 = JSON.parse(fs.readFileSync(filePath, 'utf8')).nonce;
    assert(nonce1 !== nonce2, 'nonce must change between flushes, got ' + nonce1 + ' both times');
    store.dispose();
  }],

  ['custom adapter round-trip (fake safeStorage shape)', () => {
    const dir = makeTempDir();
    const filePath = path.join(dir, 'autoextract-history.json');
    const adapter = makeFakeAdapter('unit-test-secret');
    const store = new PayloadStore({ filePath, cryptoAdapter: adapter, flushDebounceMs: 0 });
    store.appendPayload(makeRecord(2));
    store.flushNow();

    const store2 = new PayloadStore({ filePath, cryptoAdapter: adapter });
    return store2.load().then((payloads) => {
      expect(payloads.length, 1, 'restored count');
      expect(payloads[0].pageUrl, 'http://localhost:9999/page-2', 'restored pageUrl');

      // A store with a different secret must see nothing (wrong key).
      const store3 = new PayloadStore({ filePath, cryptoAdapter: makeFakeAdapter('other-secret') });
      return store3.load().then((payloads3) => {
        expect(payloads3.length, 0, 'wrong-key store must see no history');
        store2.dispose(); store3.dispose();
      });
    });
  }],

  ['tampered ciphertext is rejected without crashing', () => {
    const dir = makeTempDir();
    const filePath = path.join(dir, 'autoextract-history.json');
    const store = new PayloadStore({ filePath, flushDebounceMs: 0 });
    store.appendPayload(makeRecord(3));
    store.flushNow();
    store.dispose(); // CRITICAL: cancel the pending 0ms re-flush, which would
    // otherwise re-encrypt the live payloads over the tampered file.

    const onDisk = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const packed = Buffer.from(onDisk.ciphertext, 'base64');
    packed[packed.length - 1] ^= 0xff; // flip one bit
    onDisk.ciphertext = packed.toString('base64');
    fs.writeFileSync(filePath, JSON.stringify(onDisk), 'utf8');

    const store2 = new PayloadStore({ filePath });
    return store2.load().then((payloads) => {
      expect(payloads.length, 0, 'tampered file must yield no history');
      store2.dispose();
    });
  }],

  ['legacy v1 plaintext file loads and upgrades to encrypted v2 on flush', () => {
    const dir = makeTempDir();
    const filePath = path.join(dir, 'autoextract-history.json');
    fs.writeFileSync(filePath, JSON.stringify({
      version: 1,
      savedAt: '2026-01-01T00:00:00.000Z',
      payloads: [makeRecord(4), makeRecord(5)]
    }), 'utf8');

    const store = new PayloadStore({ filePath, flushDebounceMs: 0 });
    return store.load().then((payloads) => {
      expect(payloads.length, 2, 'legacy payloads restored');
      expect(payloads[1].pageUrl, 'http://localhost:9999/page-5', 'legacy order preserved');
      assert(store.dirty, 'legacy load should mark the store dirty for upgrade');

      store.flushNow();
      store.dispose();
      const onDisk = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      expect(onDisk.version, 2, 'file upgraded to v2');
      assert(JSON.parse(JSON.stringify(onDisk)).ciphertext, 'ciphertext present after upgrade');
      const rawAfter = fs.readFileSync(filePath, 'utf8');
      assert(rawAfter.indexOf('page-5') === -1, 'plaintext gone after upgrade');
      store.dispose();
    });
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
