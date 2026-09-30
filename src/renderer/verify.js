// src/renderer/verify.js
//
// Pure link-verification display logic for the desktop link-history window.
//
// The desktop main process owns the network (it HEADs — with a GET fallback —
// the URL behind a row over the autoextract:verifyUrl channel). This module
// holds everything the renderer does with the answer EXCEPT the DOM: result
// canonicalization, the per-URL verify-state store, "last verified" labels,
// staleness, and failure-to-message mapping. Zero dependencies (no DOM, no
// Electron, no Node built-ins), so the exact code the renderer runs is
// unit-testable under plain Node (test-renderer-verify.js):
//   - Browser: loaded via <script src> before renderer.js; attaches
//     window.AutoExtractVerify. CSP-safe: no eval, no inline script.
//   - Node: exported through module.exports for the test harness.
//
// Model (mirrored in ARCHITECTURE.md):
//   - Only success answers are stored. main never returns a bare "dead":
//     HTTP >= 400 and transport failures are {ok:false} results the renderer
//     surfaces as a transient badge title/message instead of a sticky mark,
//     so a transient network blip cannot permanently brand a row dead. The
//     same alive-only rule governs persistence: the main process canonicalizes
//     the renderer's success reports through canonicalEntry/canonicalMap
//     before they reach the encrypted history file.
//   - applyResult enforces a recheck lock: a second success for the same URL
//     inside MIN_MS_BETWEEN_CHECKS is treated as a duplicate answer for the
//     same check and rejected, so overlapping answers cannot flicker the
//     badge twice.

(function (root) {
  'use strict';

  // Same-URL checks closer together than this are treated as one check.
  var MIN_MS_BETWEEN_CHECKS = 60 * 1000;

  // Upper bound for the persisted verify map (newest kept). Entries are tiny
  // ({code, checkedAt}); this bounds the history file even for long-lived
  // installs with rotating URLs.
  var VERIFY_MAX_ENTRIES = 500;

  // {ok:true, status:2xx|3xx} -> {state:'alive', code, note}; anything else
  // is not a storable success and yields null.
  function canonicalResult(raw) {
    if (!raw || typeof raw !== 'object' || raw.ok !== true) {
      return null;
    }
    if (raw.status !== 2 && raw.status !== 3) {
      return null;
    }
    return {
      state: 'alive',
      code: typeof raw.status === 'number' ? raw.status : null,
      note: typeof raw.note === 'string' && raw.note ? raw.note : null
    };
  }

  // Records a success answer for `key` in the shared Map. Returns true when
  // an entry was actually written, false when the input was not a success,
  // the map is missing, or the recheck lock rejected it (a previous entry
  // younger than MIN_MS_BETWEEN_CHECKS counts as the same check). `now` is
  // injectable for deterministic tests.
  function applyResult(state, key, raw, now) {
    var result = canonicalResult(raw);
    if (!result || !state) {
      return false;
    }
    var t = typeof now === 'number' ? now : Date.now();
    var previous = state.get(key);
    if (previous && t - (previous.checkedAt || 0) < MIN_MS_BETWEEN_CHECKS) {
      return false;
    }
    state.set(key, {
      state: 'alive',
      code: result.code,
      note: result.note,
      checkedAt: t
    });
    return true;
  }

  // The row badge reads this; unknown rows render no badge at all.
  function statusOf(state, key) {
    if (!state) {
      return { state: 'unknown' };
    }
    return state.get(key) || { state: 'unknown' };
  }

  // '' for unknown rows; otherwise "verified <n> <unit>s ago" for the badge
  // title. Ages under a minute read "just now"; negative ages (clock skew)
  // clamp to zero.
  function statusLabel(status, now) {
    if (!status || status.state !== 'alive') {
      return '';
    }
    var t = typeof now === 'number' ? now : Date.now();
    var age = Math.max(0, t - (status.checkedAt || 0));
    if (age < 45 * 1000) {
      return 'verified just now';
    }
    if (age < 90 * 1000) {
      return 'verified 1 min ago';
    }
    if (age < 60 * 60 * 1000) {
      return 'verified ' + Math.round(age / 60000) + ' mins ago';
    }
    if (age < 24 * 60 * 60 * 1000) {
      return 'verified ' + Math.round(age / 3600000) + ' h ago';
    }
    return 'verified ' + Math.round(age / 86400000) + ' d ago';
  }

  // True when a stored success is old enough to deserve a re-check hint.
  function isStale(status, now) {
    if (!status || status.state !== 'alive') {
      return false;
    }
    var t = typeof now === 'number' ? now : Date.now();
    return t - (status.checkedAt || 0) > MIN_MS_BETWEEN_CHECKS;
  }

  // Human text for a failed {ok:false} answer (badge title + status line).
  // Failures are intentionally NOT stored by the renderer.
  function failureMessage(raw) {
    if (raw && typeof raw === 'object' && raw.ok === false) {
      if (raw.error === 'unsafe url') {
        return 'Not a verifiable http(s) URL';
      }
      if (raw.error === 'unreachable' || raw.error === 'timeout') {
        return 'Unreachable';
      }
      if (typeof raw.code === 'number') {
        return 'HTTP ' + raw.code;
      }
      if (typeof raw.error === 'string' && raw.error) {
        return raw.error;
      }
    }
    return 'Check failed';
  }

  // Sanitizes one URL -> {code, checkedAt} entry for persistence. Main uses
  // this to canonicalize the renderer's report before anything reaches the
  // encrypted history file: only plain-string keys and finite timestamps
  // survive, values are clamped to the known-good shapes, and the result is
  // a plain JSON-safe object (no prototypes, no extra fields). Non-conforming
  // input yields null, and an all-null map means "nothing to store".
  function canonicalEntry(entry) {
    if (!entry || typeof entry !== 'object') {
      return null;
    }
    var checkedAt = typeof entry.checkedAt === 'number' && isFinite(entry.checkedAt) && entry.checkedAt > 0
      ? Math.floor(entry.checkedAt)
      : null;
    var code = entry.code === 2 || entry.code === 3 ? entry.code : null;
    if (checkedAt === null) {
      return null;
    }
    return { code: code, checkedAt: checkedAt };
  }

  // Canonicalizes a whole map (any object or Map shape) into a sorted,
  // plain-object subset suitable for the history file, bounded to `limit`
  // entries (newest checkedAt wins). Returns {} when nothing conforms.
  function canonicalMap(map, limit) {
    var max = typeof limit === 'number' && limit > 0 ? Math.floor(limit) : VERIFY_MAX_ENTRIES;
    var out = {};
    var keys = [];
    function push(key, value) {
      if (typeof key !== 'string' || key.length === 0 || key.length > 2048) {
        return;
      }
      var entry = canonicalEntry(value);
      if (entry) {
        out[key] = entry;
        keys.push(key);
      }
    }
    if (map && typeof map.forEach === 'function') {
      map.forEach(function (value, key) { push(key, value); });
    } else if (map && typeof map === 'object') {
      Object.keys(map).forEach(function (key) { push(key, map[key]); });
    }
    keys.sort(function (a, b) { return out[a].checkedAt - out[b].checkedAt; });
    while (keys.length > max) {
      delete out[keys.shift()];
    }
    return out;
  }

  // Human text for the footer's background-activity slot: '' hides it
  // entirely, and any positive count reads "verifying N link(s)…". Pure so
  // the renderer cannot drift from the tested wording.
  function activityLabel(count) {
    if (typeof count !== 'number' || !isFinite(count) || count <= 0) {
      return '';
    }
    return 'verifying ' + Math.floor(count) +
      (Math.floor(count) === 1 ? ' link\u2026' : ' links\u2026');
  }

  var api = {
    MIN_MS_BETWEEN_CHECKS: MIN_MS_BETWEEN_CHECKS,
    VERIFY_MAX_ENTRIES: VERIFY_MAX_ENTRIES,
    canonicalResult: canonicalResult,
    canonicalEntry: canonicalEntry,
    canonicalMap: canonicalMap,
    activityLabel: activityLabel,
    applyResult: applyResult,
    statusOf: statusOf,
    statusLabel: statusLabel,
    isStale: isStale,
    failureMessage: failureMessage
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  root.AutoExtractVerify = api;
})(typeof window !== 'undefined' ? window : globalThis);
