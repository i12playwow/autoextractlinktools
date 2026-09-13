// shared/index.js
//
// Shared detection and extraction logic for the Chrome extension and the
// userscript. Both browser-side runtimes should use this instead of duplicating
// site/player-specific parsing.
//
// This file is the authoritative shared module. In the Chrome extension it is
// intended to be loaded as a script from the extension bundle via
// chrome.runtime.getURL('../shared/index.js') so content.js and popup.js do
// not duplicate the shared logic.
//
// Important deployment constraint:
//   For the current relative path to resolve inside the extension, the final
//   extension package must place this file next to content.js and popup.js
//   under the chrome-extension directory, or the relative path must be updated
//   when the build/packaging layout is defined.
//
// Browser API:
//   window.AutoExtract.detect(context)
//   window.AutoExtract.extract(context)
//
// Design:
//   - detect(context): returns site/player metadata if the current page is
//     supported, otherwise null.
//   - extract(context): returns links/context for a supported page.
//
// Stub behavior (temporary test contract):
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

(function () {
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

  if (typeof window !== 'undefined') {
    window.AutoExtract = {
      detect: detect,
      extract: extract
    };
  }
})();
