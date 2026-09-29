// src/storage.js
//
// JSON file persistence for the desktop bridge's received-payload history.
//
// Storage shape:
//   {
//     "version": 1,
//     "savedAt": "<ISO timestamp of last flush>",
//     "payloads": [ { receivedAt, links, detected, sources, pageUrl, pageTitle }, ... ]
//   }
//
// Design notes:
//   - Atomic writes: the JSON is written to <file>.tmp and renamed over the
//     target, so a crash mid-write cannot corrupt the previous history. On
//     Windows, fs.renameSync replaces an existing destination file.
//   - Debounced flush: appendPayload() marks the store dirty and schedules a
//     single flush after FLUSH_DEBOUNCE_MS; rapid bursts coalesce into one
//     write instead of one write per payload.
//   - Tolerant load: anything unusable (missing file, invalid JSON, wrong
//     shape, payloads not an array) is treated as "no history" and a fresh
//     file is created on the next flush. The store never throws because of a
//     corrupted file.
//   - Injectable path: storagePath is a constructor option (tests use a temp
//     directory; the app uses the Electron userData directory).
//
// Plain Node safety: no Electron imports; safe to require anywhere.

'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_MAX_PAYLOADS = 200;
const FLUSH_DEBOUNCE_MS = 500;

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

  this.payloads = [];
  this.dirty = false;
  this.flushTimer = null;

  // Error sink (injectable so tests can silence expected failures).
  this.onError = typeof options.onError === 'function' ? options.onError : function (error) {
    console.error('AutoExtract storage: flush failed.', error && error.message ? error.message : error);
  };
}

// Loads history from disk. Resolves to an array of payloads (possibly empty)
// and never rejects: an unreadable or corrupt file means "no history".
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

      if (parsed && typeof parsed === 'object' &&
          parsed.version === 1 &&
          Array.isArray(parsed.payloads)) {
        self.payloads = parsed.payloads.filter(function (p) {
          return p && typeof p === 'object';
        });
      } else {
        self.payloads = [];
      }

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

// Writes the current history to disk atomically (tmp file + rename).
// Synchronous by design: will-quit has no reliable way to await async work.
// Never throws; write failures are logged and retried on the next flush.
PayloadStore.prototype.flushNow = function () {
  try {
    var dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    var body = JSON.stringify({
      version: 1,
      savedAt: new Date().toISOString(),
      payloads: this.payloads
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
  PayloadStore: PayloadStore
};
