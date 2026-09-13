// shared/index.js
//
// Shared detection and extraction logic for the Chrome extension and the
// userscript. Both browser-side runtimes should use this instead of duplicating
// site/player-specific parsing.
//
// Design:
//   - detect(context): returns site/player metadata if the current page is
//     supported, otherwise null.
//   - extract(context): returns links/context for a supported page.
//
// This file is intentionally browser-compatible so it can be inlined into the
// extension scripts for now. The real extraction rules are still stubs.
//
// Stub behavior:
//   - If the page contains elements marked with [data-autoextract], the stubs
//     treat them as fake link sources for testing.
//   - data-autoextract-url, data-autoextract-type, and data-autoextract-server
//     attributes are used when present.
//   - Otherwise detect() returns null and extract() returns empty results.
//
// TODO:
//   - Define the "context" argument explicitly (window, document, player state).
//   - Replace stub detection with real site/player-specific rules.
//   - Decide whether extracted links should be normalized/validated here.

'use strict';

/**
 * Detect supported site/player context on the current page.
 *
 * @param {object} context
 * @returns {object|null}
 */
function detect(context) {
  // TODO: replace with real supported-site detection.
  if (!context || !context.document) {
    return null;
  }

  const markers = context.document.querySelectorAll('[data-autoextract]');
  if (markers.length > 0) {
    return {
      supported: true,
      type: 'stub',
      markerCount: markers.length
    };
  }

  return null;
}

/**
 * Extract links and related context for a supported page.
 *
 * @param {object} context
 * @returns {{ links: Array<object>, sources: Array<object> }}
 */
function extract(context) {
  // TODO: replace with real extraction once detection is implemented.
  const links = [];
  const sources = [];

  if (!context || !context.document) {
    return { links, sources };
  }

  const markers = context.document.querySelectorAll('[data-autoextract]');
  markers.forEach((marker) => {
    const url = marker.getAttribute('data-autoextract-url') || marker.getAttribute('href') || '';
    const type = marker.getAttribute('data-autoextract-type') || marker.getAttribute('data-autoextract') || 'link';
    const server = marker.getAttribute('data-autoextract-server') || 'stub';

    if (url) {
      links.push({
        server: server,
        type: type,
        url: url
      });
    }

    sources.push({
      element: marker.tagName.toLowerCase(),
      attributes: Array.from(marker.attributes).map((attr) => attr.name)
    });
  });

  return { links, sources };
}

// Browser-compatible export shape so the extension can inline this module.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { detect, extract };
}
