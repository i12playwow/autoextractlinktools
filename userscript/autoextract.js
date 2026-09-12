// userscript/autoextract.js
//
// AutoExtract Link Tools userscript.
//
// This is an alternative page-injection path alongside the Chrome extension.
// It reuses the same shared detection and extraction logic where practical so
// site/player-specific parsing is not duplicated across runtimes.
//
// Current behavior (scaffold):
//   - Runs on page load.
//   - Calls the shared detect/extract interface.
//   - Logs results to the console.
//
// Communication:
//   - By default this should be able to forward links to the same desktop app
//     over localhost when it is reachable (http://localhost:3456/ by default).
//   - If the desktop app is not reachable, the userscript should degrade
//     predictably instead of pretending the send succeeded.
//
// TODO:
//   - Import the shared module in the userscript build.
//   - Implement forwarding to the desktop app or another destination.
//   - Decide whether to expose a UI, copy links, or only log them.

'use strict';

// TODO: import shared detection/extraction from the shared build output.
// const { detect, extract } = require('../shared');

(function () {
  console.log('AutoExtract userscript loaded (scaffold).');

  // The shared interface is intentionally called with a placeholder context
  // until the real page/player context is defined.
  const context = {
    // TODO: populate from window, document, and any accessible player state.
  };

  // const detection = detect(context);
  // const links = detection ? extract(context) : { links: [], sources: [] };

  console.log('AutoExtract userscript finished (scaffold).');
})();
