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
//     so a transient network blip cannot permanently brand a row dead.
//   - applyResult enforces a recheck lock: a second success for the same URL
//     inside MIN_MS_BETWEEN_CHECKS is treated as a duplicate answer for the
//     same check and rejected, so overlapping answers cannot flicker the
//     badge twice.

(function (root) {
  'use strict';

  // Same-URL checks closer together than this are treated as one check.
  var MIN_MS_BETWEEN_CHECKS = 60 * 1000;

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

  var api = {
    MIN_MS_BETWEEN_CHECKS: MIN_MS_BETWEEN_CHECKS,
    canonicalResult: canonicalResult,
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
