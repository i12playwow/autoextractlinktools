// chrome-extension/content.js
//
// Content script for the AutoExtract Link Tools Chrome extension.
//
// Responsibilities:
//   - Detect supported video player setups on the current page.
//   - Extract available links and expose them to the popup.
//   - Auto-forward extracted links to the desktop app via the background
//     service worker (which performs the actual POST to the bridge).
//
// Storage contract:
//   - Results are stored in chrome.storage.local under one key per active tab:
//       autoextract_results_<tabId>
//   - Each stored entry includes the page URL and title so the popup can tell
//     whether the stored results are still current.
//
// Communication:
//   - The shared module (shared/index.js) is loaded by the manifest before this
//     script, so window.AutoExtract is available directly. This script must not
//     be injected into the page world, and shared/index.js must not be loaded
//     via a dynamic script tag (MV3 would block it).
//   - Tab id: content scripts cannot reliably learn their own tab id. On
//     startup this script asks the background worker (which can see sender.tab)
//     to report it, then stores results under that key.
//   - Forwarding: POSTs to the desktop bridge go through the background worker
//     ('autoextract.sendToDesktop') because content scripts are subject to page
//     CORS in MV3, while extension contexts are exempt for host_permissions
//     hosts.
//
// TODO:
//   - Add site/player-specific detection rules on top of the generic scan.
//   - Re-run detection on dynamic player changes (MutationObserver) if needed.

'use strict';

(function () {
  var PENDING_STORAGE_KEY = 'autoextract_pending_tab_id';

  // ---------------------------------------------------------------
  // Tab identity
  // ---------------------------------------------------------------

  // The background worker sees sender.tab for messages from content scripts,
  // so it is the authority for "which tab am I in".
  function requestTabId() {
    return new Promise(function (resolve) {
      try {
        chrome.runtime.sendMessage({ type: 'autoextract.getTabId' }, function (response) {
          if (chrome.runtime.lastError) {
            console.warn('AutoExtract: tab id request failed.', chrome.runtime.lastError);
            resolve(null);
            return;
          }
          if (response && typeof response.tabId === 'number') {
            resolve(response.tabId);
          } else {
            resolve(null);
          }
        });
      } catch (error) {
        console.warn('AutoExtract: tab id request threw.', error);
        resolve(null);
      }
    });
  }

  // ---------------------------------------------------------------
  // Storage
  // ---------------------------------------------------------------

  function storeResults(tabId, results, pageUrl, pageTitle) {
    if (typeof tabId !== 'number') {
      console.warn('AutoExtract: no tab id available; results not stored.');
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

    var key = 'autoextract_results_' + tabId;
    var update = {};
    update[key] = entry;

    chrome.storage.local.set(update, function () {
      if (chrome.runtime.lastError) {
        console.warn('AutoExtract: failed to store results.', chrome.runtime.lastError);
        return;
      }
      console.log(
        'AutoExtract: stored results for tab', tabId,
        '(', entry.links.length, 'links,', entry.pageUrl, ')'
      );
    });
  }

  // ---------------------------------------------------------------
  // Forwarding (via background service worker)
  // ---------------------------------------------------------------

  function forwardToDesktop(results, pageUrl, pageTitle) {
    var links = results && results.links ? results.links : [];

    if (!links.length) {
      return;
    }

    try {
      chrome.runtime.sendMessage({
        type: 'autoextract.sendToDesktop',
        payload: {
          detected: results.detection || null,
          links: links,
          sources: results.sources || [],
          pageUrl: pageUrl || null,
          pageTitle: pageTitle || null
        }
      }, function (response) {
        if (chrome.runtime.lastError) {
          console.warn('AutoExtract: forward failed.', chrome.runtime.lastError);
          return;
        }
        if (response && response.ok) {
          console.log('AutoExtract: forwarded', response.sent, 'link(s) to desktop.');
        } else {
          console.warn('AutoExtract: forward rejected.', response && response.error);
        }
      });
    } catch (error) {
      console.warn('AutoExtract: forward threw.', error);
    }
  }

  // ---------------------------------------------------------------
  // Main flow
  // ---------------------------------------------------------------

  function run() {
    if (!window.AutoExtract) {
      console.warn('AutoExtract content script: shared module not loaded.');
      return;
    }

    var context = { document: document, location: location };
    var detection = window.AutoExtract.detect(context);
    var results = detection
      ? window.AutoExtract.extract(context)
      : { links: [], sources: [] };
    results.detection = detection;

    var pageUrl = location.href;
    var pageTitle = document.title || '';

    requestTabId().then(function (tabId) {
      storeResults(tabId, results, pageUrl, pageTitle);
      forwardToDesktop(results, pageUrl, pageTitle);
    });
  }

  // ---------------------------------------------------------------
  // Popup-triggered re-detection
  // ---------------------------------------------------------------

  // The popup asks the background worker, which pokes the active tab; this is
  // where the poke arrives. Keeps storage and forwarding in one code path.
  chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    if (message && message.type === 'autoextract.runDetection') {
      run();
      sendResponse({ ok: true });
    }
    return undefined;
  });

  // The manifest lists shared/index.js before content.js, so AutoExtract is
  // normally already present. Keep the load-event fallback for safety.
  if (window.AutoExtract) {
    run();
  } else {
    window.addEventListener('load', run);
  }
})();
