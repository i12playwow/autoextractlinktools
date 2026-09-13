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

// ---------------------------------------------------------------------------
// Shared module.
//
// Loaded from the extension bundle so content.js and popup.js use the same
// shared logic without duplicating it.
// ---------------------------------------------------------------------------

(function () {
  // Wait for the shared module to be available, then run detection/extraction.
  function run() {
    if (!window.AutoExtract) {
      console.warn('AutoExtract content script: shared module not loaded.');
      return;
    }

    var context = {
      document: document
    };

    var detection = window.AutoExtract.detect(context);
    var results = detection ? window.AutoExtract.extract(context) : { links: [], sources: [] };

    results.detection = detection;

    if (!chrome.tabs || !chrome.tabs.query) {
      console.warn('AutoExtract content script: tabs API not available.');
      return;
    }

    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      if (!tabs || !tabs.length) {
        console.warn('AutoExtract: no active tab found for storage.');
        return;
      }

      var tabId = tabs[0].id;
      if (typeof tabId === 'undefined') {
        console.warn('AutoExtract: active tab has no id.');
        return;
      }

      chrome.storage.local.set({
        ['autoextract_results_' + tabId]: results
      }, function () {
        if (chrome.runtime.lastError) {
          console.warn('AutoExtract: failed to store results.', chrome.runtime.lastError);
          return;
        }
        console.log('AutoExtract: stored results for tab', tabId, '(', results.links.length, 'links)');
      });
    });
  }

  if (window.AutoExtract) {
    run();
  } else {
    // The shared script may still be loading.
    window.addEventListener('load', run);
  }
})();

// Load the shared module from the extension bundle.
(function () {
  var sharedPath = chrome.runtime.getURL('../shared/index.js');

  // Guard against environments where the extension path is not available.
  if (!sharedPath) {
    console.warn('AutoExtract content script: unable to resolve shared module path.');
    return;
  }

  var script = document.createElement('script');
  script.src = sharedPath;
  script.async = false;
  (document.head || document.documentElement).appendChild(script);
})();
