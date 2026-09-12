// chrome-extension/content.js
//
// Content script for the AutoExtract Link Tools Chrome extension.
//
// Responsibilities:
//   - Detect supported video player setups on the current page.
//   - Extract available links and expose them to the popup or other extension UI.
//
// This file is a scaffold. It uses the shared detection/extraction interface
// where practical, but the real extraction logic is not implemented yet.
//
// Communication:
//   - Actual forwarding to the desktop app should happen from popup.js or
//     another orchestration layer, not directly from this content script by
//     default. Keep the content script focused on detection/extraction and
//     page interaction.
//
// TODO:
//   - Import and use shared/index.js from the extension build.
//   - Decide how detected links are stored/shown to the popup.
//   - Handle page changes, navigation, and dynamic players if needed.

'use strict';

// Placeholder context object. In a real build this would be derived from the
// page and any accessible player state.
const context = {
  // TODO: populate from document, player APIs, and page metadata.
};

// The shared module should be imported from the extension bundle.
// const { detect, extract } = require('../shared');
//
// For now this content script is a stub.
(function () {
  console.log('AutoExtract content script loaded (scaffold).');
})();
