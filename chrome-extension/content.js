// chrome-extension/content.js
//
// Content script for the AutoExtract Link Tools Chrome extension.
//
// Responsibilities:
//   - Detect supported video player setups on the current page.
//   - Extract available links and expose them to the popup.
//
// Storage contract:
//   - Results are stored in chrome.storage.local under one key per active tab.
//   - Each stored entry includes the page URL and title so the popup can tell
//     whether the stored results are still current.
//
// Communication:
//   - Detection/extraction runs here.
//   - Actual forwarding to the desktop app should happen from popup.js or
//     another orchestration layer, not by default from this content script.
//
// TODO:
//   - Replace stub detection with real site/player-specific rules.
//   - Handle navigation and dynamic players if needed.
//   - Decide whether stored results should be invalidated on page changes.

'use strict';

(function () {
  function storeForActiveTab(results, pageUrl, pageTitle) {
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

      var entry = {
        detection: results.detection || null,
        links: results.links || [],
        sources: results.sources || [],
        pageUrl: pageUrl || '',
        pageTitle: pageTitle || '',
        storedAt: new Date().toISOString()
      };

      chrome.storage.local.set({
        ['autoextract_results_' + tabId]: entry
      }, function () {
        if (chrome.runtime.lastError) {
          console.warn('AutoExtract: failed to store results.', chrome.runtime.lastError);
          return;
        }
        console.log(
          'AutoExtract: stored results for tab',
          tabId,
          '(',
          entry.links.length,
          'links,',
          entry.pageUrl,
          ')'
        );
      });
    });
  }

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

    storeForActiveTab(
      results,
      location.href,
      document.title || ''
    );
  }

  if (window.AutoExtract) {
    run();
  } else {
    window.addEventListener('load', run);
  }
})();

// Load the shared module from the extension bundle.
(function () {
  var sharedPath = chrome.runtime.getURL('../shared/index.js');

  if (!sharedPath) {
    console.warn('AutoExtract content script: unable to resolve shared module path.');
    return;
  }

  var script = document.createElement('script');
  script.src = sharedPath;
  script.async = false;
  (document.head || document.documentElement).appendChild(script);
})();
