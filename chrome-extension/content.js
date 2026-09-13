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
// Inlined shared module.
//
// In a real build this would come from shared/index.js through a bundler.
// For now it is inlined here so the extension is loadable immediately.
// ---------------------------------------------------------------------------

function detect(context) {
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
      attributes: Array.from(marker.attributes).map(function (attr) {
        return attr.name;
      })
    });
  });

  return { links, sources };
}

// ---------------------------------------------------------------------------
// Content script behavior.
//
// Responsibilities:
//   - Detect supported video player setups on the current page.
//   - Extract available links.
//   - Store results in chrome.storage.local keyed by the active tab ID so the
//     popup can read them later.
// ---------------------------------------------------------------------------

(function () {
  var context = {
    document: document
  };

  var detection = detect(context);
  var results = detection ? extract(context) : { links: [], sources: [] };

  results.detection = detection;

  // Only store if we have an active tab ID.
  chrome.tabs && chrome.tabs.query && chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
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
})();
