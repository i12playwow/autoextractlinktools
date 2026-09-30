// src/storage.js
//
// JSON file persistence for the desktop bridge's received-payload history.
//
// On-disk shapes:
//
//   v2 (encrypted, current):
//   {
//     "version": 2,
//     "savedAt": "<ISO timestamp>",
//     "encryption": "aes-256-gcm",
//     "nonce": "<hex, 96-bit random per flush>",
//     "ciphertext": "<base64: encrypted JSON { savedAt, payloads }>"
//   }
//
//   v1 (legacy plaintext, read-only):
//   {
//     "version": 1,
//     "savedAt": "...",
//     "payloads": [ { receivedAt, links, detected, sources, pageUrl, pageTitle }, ... ]
//   }
//
// Encryption:
//   - A crypto adapter must provide encrypt(plaintextString) -> { data, nonce }
//     and decrypt({ data, nonce }) -> plaintextString, throwing on tamper.
//   - The app wires Electron's safeStorage adapter (OS keystore: DPAPI /
//     Keychain / libsecret; see src/main.js). When no OS keystore is
//     available, useKeyfileAdapter() provides a fallback: a random 32-byte
//     key stored in <file>.key with 0600 permissions (best-effort on
//     Windows, where POSIX modes are advisory).
//   - Legacy v1 plaintext files load normally and are re-written encrypted on
//     the next flush: the upgrade is transparent, nothing is lost.
//   - Every flush generates a fresh 96-bit nonce; the nonce is stored beside
//     the ciphertext. With safeStorage the key is OS-managed; with the keyfile
//     adapter the key lives in a separate 0600 file, never in the history.
//   - Tamper detection: AES-GCM auth tags fail the decrypt with a thrown
//     error, which load() treats as "no history" (same policy as corruption).
//
// Unchanged invariants:
//   - Atomic writes (tmp + rename, with retry/copy fallback on Windows), so a
//     crash mid-write cannot corrupt the previous history.
//   - Debounced flush: bursts coalesce into one write.
//   - Tolerant load: anything unusable means "no history"; the store never
//     throws because of a bad file.
//   - Injectable file path and injectable crypto adapter (tests).
//
// Plain Node safety: no Electron imports; the built-in adapter uses only
// node:crypto. Safe to require anywhere.

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_MAX_PAYLOADS = 200;
const FLUSH_DEBOUNCE_MS = 500;
const KEYFILE_MODE = 0o600;

// ---------------------------------------------------------------------------
// Built-in adapter: AES-256-GCM with a key stored in a 0600 sidecar keyfile
// ---------------------------------------------------------------------------

// Creates (or reuses) the keyfile adapter for a given history file. The key
// file lives next to the history file: <historyPath>.key. Injectable for
// tests via options.keyFilePath / options.fs.
function useKeyfileAdapter(options) {
  options = options || {};
  var fsApi = options.fs || fs;

  var keyPath = options.keyFilePath || (options.filePath + '.key');
  var key = null;

  function loadOrCreateKey() {
    if (key) {
      return key;
    }
    try {
      var existing = fsApi.readFileSync(keyPath);
      if (existing && existing.length === 32) {
        key = existing;
        return key;
      }
    } catch (error) {
      // Fall through to creation.
    }

    key = crypto.randomBytes(32);
    try {
      fsApi.writeFileSync(keyPath, key, { mode: KEYFILE_MODE });
      try {
        fsApi.chmodSync(keyPath, KEYFILE_MODE);
      } catch (chmodError) {
        // Best effort: Windows ignores POSIX modes; rely on the profile dir's
        // own ACLs.
      }
    } catch (writeError) {
      key = null;
      throw writeError;
    }
    return key;
  }

  function encrypt(plaintext) {
    var keyBytes = loadOrCreateKey();
    var nonce = crypto.randomBytes(12);
    var cipher = crypto.createCipheriv('aes-256-gcm', keyBytes, nonce);
    var ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    var tag = cipher.getAuthTag();
    // data layout: tag (16) || ciphertext
    return {
      data: Buffer.concat([tag, ciphertext]).toString('base64'),
      nonce: nonce.toString('hex')
    };
  }

  function decrypt(envelope) {
    var keyBytes = loadOrCreateKey();
    var packed = Buffer.from(envelope.data, 'base64');
    if (packed.length < 16) {
      throw new Error('ciphertext too short');
    }
    var tag = packed.subarray(0, 16);
    var ciphertext = packed.subarray(16);
    var decipher = crypto.createDecipheriv('aes-256-gcm', keyBytes, Buffer.from(envelope.nonce, 'hex'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  }

  return { encrypt: encrypt, decrypt: decrypt, keyPath: keyPath };
}

// ---------------------------------------------------------------------------
// Verify-map sanitization
// ---------------------------------------------------------------------------

// Upper bound for the persisted verify map (newest kept), matching the
// renderer-side default in src/renderer/verify.js.
var VERIFY_MAX_ENTRIES = 500;

// Validates a verify map of URL -> {code, checkedAt} into a bounded plain
// object. Main canonicalizes entries before storing them (through the shared
// pure module), so this is a defensive re-check on load and on setVerifyMap:
// only string keys (<= 2048 chars) with finite positive timestamps survive,
// values keep only the known fields, and the newest entries win when the map
// exceeds the bound. Never throws.
function sanitizeVerifyMap(raw) {
  var out = {};
  if (!raw || typeof raw !== 'object') {
    return out;
  }
  var keys = [];
  Object.keys(raw).forEach(function (key) {
    var entry = raw[key];
    if (typeof key !== 'string' || key.length === 0 || key.length > 2048 ||
        !entry || typeof entry !== 'object') {
      return;
    }
    var checkedAt = typeof entry.checkedAt === 'number' && isFinite(entry.checkedAt) && entry.checkedAt > 0
      ? Math.floor(entry.checkedAt)
      : null;
    if (checkedAt === null) {
      return;
    }
    out[key] = {
      code: entry.code === 2 || entry.code === 3 ? entry.code : null,
      checkedAt: checkedAt
    };
    keys.push(key);
  });
  if (keys.length > VERIFY_MAX_ENTRIES) {
    keys.sort(function (a, b) { return out[a].checkedAt - out[b].checkedAt; });
    while (keys.length > VERIFY_MAX_ENTRIES) {
      delete out[keys.shift()];
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

function PayloadStore(options) {
  options = options || {};

  this.filePath = options.filePath;
  if (!this.filePath) {
    throw new Error('PayloadStore: filePath is required');
  }

  this.maxPayloads = (typeof options.maxPayloads === 'number' && options.maxPayloads > 0)
    ? options.maxPayloads
    : DEFAULT_MAX_PAYLOADS;
  this.flushDebounceMs = (typeof options.flushDebounceMs === 'number' && options.flushDebounceMs >= 0)
    ? options.flushDebounceMs
    : FLUSH_DEBOUNCE_MS;

  // Crypto adapter: required for v2 writes. When omitted, the keyfile
  // adapter is used so the store is secure-by-default under plain Node too.
  this.cryptoAdapter = options.cryptoAdapter || useKeyfileAdapter({ filePath: this.filePath });

  this.payloads = [];
  // Link-verification results (URL -> {code, checkedAt}), persisted inside
  // the same encrypted document. Alive-only by construction: main canonicalizes
  // every entry through verify.canonicalEntry before it lands here, and the
  // map is bounded so long-lived installs cannot grow the file without limit.
  this.verify = {};
  this.dirty = false;
  this.flushTimer = null;

  // Error sink (injectable so tests can silence expected failures).
  this.onError = typeof options.onError === 'function' ? options.onError : function (error) {
    console.error('AutoExtract storage: flush failed.', error && error.message ? error.message : error);
  };
}

// Loads history from disk. Resolves to an array of payloads (possibly empty)
// and never rejects: an unreadable, corrupt, or undecryptable file means "no
// history". Legacy v1 plaintext files load and upgrade on next flush.
PayloadStore.prototype.load = function () {
  var self = this;
  return new Promise(function (resolve) {
    fs.readFile(self.filePath, 'utf8', function (error, raw) {
      if (error) {
        // Missing file (or unreadable) -> fresh history.
        self.payloads = [];
        resolve(self.payloads);
        return;
      }

      var parsed = null;
      try {
        parsed = JSON.parse(raw);
      } catch (parseError) {
        parsed = null;
      }

      if (parsed && typeof parsed === 'object' && parsed.version === 2 &&
          typeof parsed.ciphertext === 'string' && typeof parsed.nonce === 'string') {
        // v2: decrypt, then validate the inner document.
        var plaintext = null;
        try {
          plaintext = self.cryptoAdapter.decrypt({ data: parsed.ciphertext, nonce: parsed.nonce });
        } catch (decryptError) {
          // Wrong key or tampered file: same policy as corruption.
          self.payloads = [];
          resolve(self.payloads);
          return;
        }

        var inner = null;
        try {
          inner = JSON.parse(plaintext);
        } catch (innerError) {
          inner = null;
        }

        if (inner && typeof inner === 'object' && Array.isArray(inner.payloads)) {
          self.payloads = inner.payloads.filter(function (p) {
            return p && typeof p === 'object';
          });
          // Verify map: optional and validated; entries were canonicalized
          // before being stored, but re-validate on load anyway so a
          // hand-edited (still authenticated) document cannot inject junk.
          self.verify = sanitizeVerifyMap(inner.verify);
        } else {
          self.payloads = [];
          self.verify = {};
        }
        resolve(self.payloads);
        return;
      }

      if (parsed && typeof parsed === 'object' &&
          parsed.version === 1 &&
          Array.isArray(parsed.payloads)) {
        // Legacy plaintext: keep the payloads; the next flush upgrades the
        // file to v2. Mark dirty so the upgrade actually happens even if the
        // history never changes afterwards.
        self.payloads = parsed.payloads.filter(function (p) {
          return p && typeof p === 'object';
        });
        self.verify = {};
        self.dirty = true;
        self.scheduleFlush();
        resolve(self.payloads);
        return;
      }

      self.payloads = [];
      self.verify = {};
      resolve(self.payloads);
    });
  });
};

// Appends a payload to the in-memory history (bounded) and schedules a flush.
PayloadStore.prototype.appendPayload = function (record) {
  if (!record || typeof record !== 'object') {
    return;
  }

  this.payloads.push(record);
  if (this.payloads.length > this.maxPayloads) {
    this.payloads.splice(0, this.payloads.length - this.maxPayloads);
  }

  this.dirty = true;
  this.scheduleFlush();
};

PayloadStore.prototype.clear = function () {
  this.payloads = [];
  this.verify = {};
  this.dirty = true;
  this.scheduleFlush();
};

// Replaces the in-memory verify map (used by main after canonicalizing the
// renderer's reports) and schedules a flush.
PayloadStore.prototype.setVerifyMap = function (map) {
  this.verify = sanitizeVerifyMap(map);
  this.dirty = true;
  this.scheduleFlush();
};

PayloadStore.prototype.scheduleFlush = function () {
  var self = this;
  if (this.flushTimer) {
    // Already pending: the debounce coalesces further changes.
    return;
  }

  this.flushTimer = setTimeout(function () {
    self.flushTimer = null;
    self.flushNow();
  }, this.flushDebounceMs);

  // Do not hold the process open just for a pending flush (matters for tests
  // and for Electron quit timing; will-quit calls flushNow synchronously).
  if (typeof this.flushTimer.unref === 'function') {
    this.flushTimer.unref();
  }
};

// Synchronous sleep used between rename retries (flushNow is synchronous by
// design, so it cannot await). Atomics.wait is allowed on the Node main
// thread; the spin fallback covers restricted environments.
function busySleep(ms) {
  try {
    var buffer = new SharedArrayBuffer(4);
    Atomics.wait(new Int32Array(buffer), 0, 0, ms);
  } catch (error) {
    var end = Date.now() + ms;
    while (Date.now() < end) { /* busy */ }
  }
}

// Writes the current history to disk as an encrypted v2 envelope, atomically
// (tmp file + rename). Synchronous by design: will-quit has no reliable way
// to await async work.
//
// Windows note: rename-over-an-existing-file can fail transiently with EPERM
// (antivirus/indexer briefly holding the destination open). Retry a few times
// with short waits; if it still refuses, fall back to a copy+unlink so the
// flush lands non-atomically instead of being lost. Never throws.
PayloadStore.prototype.flushNow = function () {
  try {
    var dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    var savedAt = new Date().toISOString();
    var inner = JSON.stringify({ savedAt: savedAt, payloads: this.payloads, verify: this.verify });
    var encrypted = this.cryptoAdapter.encrypt(inner);

    var body = JSON.stringify({
      version: 2,
      savedAt: savedAt,
      encryption: 'aes-256-gcm',
      nonce: encrypted.nonce,
      ciphertext: encrypted.data
    }, null, 2);

    var tmpPath = this.filePath + '.tmp';
    fs.writeFileSync(tmpPath, body, 'utf8');

    // Windows note: rename-over-an-existing-file can fail transiently with
    // EPERM (antivirus/indexer briefly holding the destination open). Retry a
    // few times with short waits; if it still refuses, fall back to a
    // copy+unlink so the flush lands non-atomically instead of being lost.
    var renamed = false;
    var lastRenameError = null;
    for (var attempt = 0; attempt < 3 && !renamed; attempt++) {
      try {
        fs.renameSync(tmpPath, this.filePath);
        renamed = true;
      } catch (renameError) {
        lastRenameError = renameError;
        if (attempt < 2) {
          busySleep(50);
        }
      }
    }

    if (!renamed) {
      fs.copyFileSync(tmpPath, this.filePath);
      fs.rmSync(tmpPath, { force: true });
      this.onError(lastRenameError);
    }

    this.dirty = false;
  } catch (error) {
    // Keep dirty=true so the next scheduled flush retries.
    this.onError(error);
  }
};

// Cancels any pending debounced flush (used by tests and app shutdown).
PayloadStore.prototype.dispose = function () {
  if (this.flushTimer) {
    clearTimeout(this.flushTimer);
    this.flushTimer = null;
  }
};

module.exports = {
  PayloadStore: PayloadStore,
  useKeyfileAdapter: useKeyfileAdapter
};
