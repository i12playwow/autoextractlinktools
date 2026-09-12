// shared/index.js
//
// Shared detection and extraction logic for the Chrome extension and the
// userscript. Both browser-side runtimes should import from here instead of
// duplicating site/player-specific parsing.
//
// Design:
//   - detect(context): returns site/player metadata if the current page is
//     supported, otherwise null.
//   - extract(context): returns links/context for a supported page.
//
// Both functions are intentionally stubs right now. The interface exists so
// the extension and userscript can be wired up before the real extraction
// rules are implemented.
//
// TODO:
//   - Define the "context" argument explicitly (for example: window, document,
//     and any player-specific state we can access).
//   - Add site/player-specific detection and extraction rules.
//   - Decide whether extracted links should be normalized/validated here.

'use strict';

/**
 * @param {object} context
 * @returns {object|null}
 */
function detect(context) {
  // TODO: implement supported site/player detection.
  return null;
}

/**
 * @param {object} context
 * @returns {object}
 */
function extract(context) {
  // TODO: implement extraction once a supported page is detected.
  return {
    links: [],
    sources: []
  };
}

module.exports = {
  detect,
  extract
};
