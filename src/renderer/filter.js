// src/renderer/filter.js
//
// Pure filtering logic for the desktop link-history window.
//
// This module intentionally has zero dependencies (no DOM, no Electron, no
// Node built-ins) so the exact code the renderer runs is unit-testable under
// plain Node (test-renderer-filter.js):
//   - Browser: loaded via <script src> before renderer.js; attaches
//     window.AutoExtractFilter. CSP-safe: no eval, no inline script.
//   - Node: exported through module.exports for the test harness.
//
// Filtering model (mirrored in ARCHITECTURE.md):
//   - A filter state is { query, types }: `query` is a lowercased, trimmed
//     substring ('' = no search); `types` is null (no type filter) or a
//     subset of TYPES. canonicalState treats "all types selected" as no
//     filter, so all-on and all-off behave identically.
//   - A link matches when its URL contains the query (case-insensitive) and
//     its type is active. Links with a missing/unknown type count as 'other',
//     matching the renderer chip fallback.
//   - A payload passes when any of its links matches, or — only when no type
//     filter is active — the page title or page URL matches the query. The
//     page-text path is suppressed under a type filter because page text has
//     no link type; this keeps "video only" meaning "only video links".
//   - matchRecord returns matchedLinkIndexes: null when no filter is active
//     (the renderer then shows every row), otherwise the ascending indexes of
//     the matching links (the renderer hides the other rows in that card).

(function (root) {
  'use strict';

  var TYPES = ['video', 'audio', 'hls', 'dash', 'other'];

  function normalizeQuery(query) {
    return typeof query === 'string' ? query.trim().toLowerCase() : '';
  }

  // null means "no type filter": nothing selected, everything selected, or
  // only invalid entries. Otherwise a deduped subset of TYPES in TYPES order.
  function canonicalTypes(types) {
    if (!Array.isArray(types)) {
      return null;
    }
    var wanted = {};
    for (var i = 0; i < types.length; i++) {
      var t = types[i];
      if (typeof t === 'string' && TYPES.indexOf(t) !== -1) {
        wanted[t] = true;
      }
    }
    var picked = TYPES.filter(function (t) { return wanted[t]; });
    return picked.length === 0 || picked.length === TYPES.length ? null : picked;
  }

  function canonicalState(query, types) {
    return { query: normalizeQuery(query), types: canonicalTypes(types) };
  }

  function hasActiveFilter(state) {
    return Boolean(state && (state.query !== '' || state.types !== null));
  }

  function linkTypeOf(link) {
    var t = link && typeof link.type === 'string' ? link.type : '';
    return TYPES.indexOf(t) !== -1 ? t : 'other';
  }

  function linkMatches(link, state) {
    if (!state || !link || typeof link !== 'object') {
      return false;
    }
    if (state.types !== null && state.types.indexOf(linkTypeOf(link)) === -1) {
      return false;
    }
    if (state.query === '') {
      return true;
    }
    return typeof link.url === 'string' && link.url.toLowerCase().indexOf(state.query) !== -1;
  }

  // Page-level text match: page title or page URL contains the query. Only
  // consulted when no type filter is active (page text has no type).
  function pageTextMatches(record, state) {
    if (!state || state.types !== null || state.query === '' || !record) {
      return false;
    }
    if (typeof record.pageTitle === 'string' &&
        record.pageTitle.toLowerCase().indexOf(state.query) !== -1) {
      return true;
    }
    return typeof record.pageUrl === 'string' &&
      record.pageUrl.toLowerCase().indexOf(state.query) !== -1;
  }

  // Null/odd records never crash: they simply have no links.
  function matchRecord(record, state) {
    if (!hasActiveFilter(state)) {
      return { passes: true, matchedLinkIndexes: null };
    }
    var links = record && Array.isArray(record.links) ? record.links : [];
    var matched = [];
    for (var i = 0; i < links.length; i++) {
      if (linkMatches(links[i], state)) {
        matched.push(i);
      }
    }
    if (matched.length > 0 || pageTextMatches(record, state)) {
      return { passes: true, matchedLinkIndexes: matched };
    }
    return { passes: false, matchedLinkIndexes: matched };
  }

  // Link totals per type across all records; chips show these as badges.
  function typeCounts(records) {
    var counts = { video: 0, audio: 0, hls: 0, dash: 0, other: 0 };
    (Array.isArray(records) ? records : []).forEach(function (record) {
      var links = record && Array.isArray(record.links) ? record.links : [];
      links.forEach(function (link) {
        counts[linkTypeOf(link)] += 1;
      });
    });
    return counts;
  }

  // How many payloads and links are visible under `state`? Drives the
  // renderer's "Showing X of Y" line and its no-match empty state. A card
  // that passed through page text shows every row, so all of its links count
  // as visible (matchedLinkIndexes is empty exactly in that case, while a
  // link-matched card always carries at least one index).
  function countVisible(records, state) {
    var payloads = 0;
    var links = 0;
    (Array.isArray(records) ? records : []).forEach(function (record) {
      var m = matchRecord(record, state);
      if (!m.passes) {
        return;
      }
      payloads += 1;
      var total = record && Array.isArray(record.links) ? record.links.length : 0;
      links += (m.matchedLinkIndexes === null || m.matchedLinkIndexes.length === 0)
        ? total
        : m.matchedLinkIndexes.length;
    });
    return { payloads: payloads, links: links };
  }

  var api = {
    TYPES: TYPES,
    normalizeQuery: normalizeQuery,
    canonicalTypes: canonicalTypes,
    canonicalState: canonicalState,
    hasActiveFilter: hasActiveFilter,
    linkTypeOf: linkTypeOf,
    linkMatches: linkMatches,
    pageTextMatches: pageTextMatches,
    matchRecord: matchRecord,
    typeCounts: typeCounts,
    countVisible: countVisible
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  root.AutoExtractFilter = api;
})(typeof window !== 'undefined' ? window : globalThis);
