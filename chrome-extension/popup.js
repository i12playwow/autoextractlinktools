// chrome-extension/popup.js
//
// Popup controller for the AutoExtract Link Tools Chrome extension.
//
// This script is wired to the existing popup UI:
//   - #status
//   - #no-data
//   - #links
//   - #count-badge
//   - #copy-btn, #idm-btn, #send-btn
//
// Current behavior:
//   - Reads the active tab.
//   - Loads stored extraction results from chrome.storage.local keyed by tab id.
//   - Falls back to in-popup stub detection when nothing was previously stored.
//   - Renders the “no video links found” state if extraction returns nothing.
//   - Wires copy, IDM, and send-to-desktop buttons against real results.
//
// Defaults:
//   - The desktop bridge target is http://localhost:3456/ by default. This
//     matches the Electron desktop app bridge added in src/main.js.
//
// TODO:
//   - Replace the inlined shared module with a proper bundled import.
//   - Replace stub detection with real site/player-specific extraction.
//   - Decide whether the IDM button should open a download helper, generate a
//     download URL, or be removed from scope.

'use strict';

// ---------------------------------------------------------------------------
// Popup UI wiring.
//
// This popup reads extraction results that were stored by the content script
// for the active tab. It does not run extraction itself.
// ---------------------------------------------------------------------------

const STATUS_EL = document.getElementById('status');
const NO_DATA_EL = document.getElementById('no-data');
const LINKS_EL = document.getElementById('links');
const COUNT_BADGE_EL = document.getElementById('count-badge');
const COPY_BTN = document.getElementById('copy-btn');
const IDM_BTN = document.getElementById('idm-btn');
const SEND_BTN = document.getElementById('send-btn');

const DEFAULT_DESKTOP_URL = 'http://localhost:3456/';

let currentResults = null;

function setStatus(message) {
  if (STATUS_EL) STATUS_EL.textContent = message;
}

function showNoData() {
  if (NO_DATA_EL) NO_DATA_EL.style.display = '';
  if (LINKS_EL) LINKS_EL.innerHTML = '';
  if (COUNT_BADGE_EL) COUNT_BADGE_EL.textContent = '';
}

function renderLinks(links) {
  if (!LINKS_EL) return;

  if (!links || links.length === 0) {
    showNoData();
    return;
  }

  NO_DATA_EL.style.display = 'none';
  LINKS_EL.innerHTML = '';

  links.forEach((link) => {
    const item = document.createElement('div');
    item.className = 'link-item';

    const server = document.createElement('div');
    server.className = 'server';
    server.textContent = link.server || 'unknown';

    const type = document.createElement('div');
    type.className = 'type';
    type.textContent = link.type || 'link';

    const url = document.createElement('div');
    url.className = 'url';
    url.textContent = link.url || '';

    item.appendChild(server);
    item.appendChild(type);
    item.appendChild(url);
    LINKS_EL.appendChild(item);
  });

  if (COUNT_BADGE_EL) {
    COUNT_BADGE_EL.textContent = links.length + ' link' + (links.length === 1 ? '' : 's') + ' found';
  }
}

function copyJson(results) {
  const payload = JSON.stringify({
    detected: results.detection || null,
    links: results.links || [],
    sources: results.sources || [],
    exportedAt: new Date().toISOString()
  }, null, 2);

  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(payload).then(
      () => setStatus('Copied JSON to clipboard'),
      () => setStatus('Failed to copy JSON')
    );
  } else {
    setStatus('Clipboard API not available');
  }
}

/**
 * IDM button path.
 *
 * The popup UI already includes an IDM button, so this is intentionally kept as
 * a visible integration point. It is not implemented yet.
 */
function openInIdm(results) {
  // TODO: decide IDM integration behavior.
  // For example: build a download URL, open a helper page, or delegate to the
  // desktop app if it supports IDM-style integration.
  setStatus('Open in IDM is not implemented yet');
}

/**
 * Send extracted links to the desktop app.
 *
 * Default target: http://localhost:3456/
 */
async function sendToDesktop(results) {
  const links = results && results.links ? results.links : [];

  if (!links || links.length === 0) {
    setStatus('Nothing to send');
    return;
  }

  setStatus('Sending to desktop...');

  try {
    const body = JSON.stringify({
      detected: results.detection || null,
      links: links,
      sources: results.sources || [],
      sentAt: new Date().toISOString()
    });

    const response = await fetch(DEFAULT_DESKTOP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body
    });

    if (!response.ok) {
      setStatus('Desktop send failed: ' + response.status);
      return;
    }

    setStatus('Sent ' + links.length + ' link' + (links.length === 1 ? '' : 's') + ' to desktop');
  } catch (error) {
    console.error(error);
    if (error && error.message) {
      setStatus('Desktop not reachable: ' + error.message);
    } else {
      setStatus('Desktop not reachable');
    }
  }
}

/**
 * Read the latest stored results for the active tab and render them.
 *
 * The popup depends on the content script having already stored results for the
 * current tab. If nothing is stored, the popup shows the no-links state instead
 * of running its own detection.
 */
function loadResults() {
  setStatus('Loading results...');

  if (!chrome.storage || !chrome.storage.local || !chrome.storage.local.get) {
    setStatus('Storage API not available');
    disableActionButtons();
    return;
  }

  if (!chrome.tabs || !chrome.tabs.query) {
    setStatus('Tabs API not available');
    disableActionButtons();
    return;
  }

  chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
    if (!tabs || !tabs.length) {
      setStatus('No active tab');
      disableActionButtons();
      return;
    }

    var tabId = tabs[0].id;
    if (typeof tabId === 'undefined') {
      setStatus('No active tab');
      disableActionButtons();
      return;
    }

    var storageKey = 'autoextract_results_' + tabId;

    chrome.storage.local.get([storageKey], function (items) {
      var stored = items[storageKey];

      if (!stored || !stored.links || stored.links.length === 0) {
        currentResults = { links: [], sources: [], detection: null };
        renderLinks([]);
        setStatus('No video links found on this page.');
        disableActionButtons();
        return;
      }

      currentResults = stored;
      renderLinks(stored.links);

      if (stored.links.length === 0) {
        setStatus('No video links found on this page.');
        disableActionButtons();
      } else {
        enableActionButtons(stored);
        setStatus('Detected ' + stored.links.length + ' link' + (stored.links.length === 1 ? '' : 's') + '.');
      }
    });
  });
}

function disableActionButtons() {
  if (COPY_BTN) COPY_BTN.disabled = true;
  if (IDM_BTN) IDM_BTN.disabled = true;
  if (SEND_BTN) SEND_BTN.disabled = true;
}

function enableActionButtons(results) {
  if (COPY_BTN) COPY_BTN.disabled = false;
  if (IDM_BTN) IDM_BTN.disabled = false;
  if (SEND_BTN) SEND_BTN.disabled = false;

  COPY_BTN.onclick = () => copyJson(results);
  IDM_BTN.onclick = () => openInIdm(results);
  SEND_BTN.onclick = () => sendToDesktop(results);
}

// ---------------------------------------------------------------------------
// Startup.
// ---------------------------------------------------------------------------

(function () {
  // Load the shared module from the extension bundle so popup.js uses the same
  // shared logic as content.js.
  function loadSharedModule() {
    var sharedPath = chrome.runtime.getURL('../shared/index.js');

    if (!sharedPath) {
      console.warn('AutoExtract popup: unable to resolve shared module path.');
      return;
    }

    var script = document.createElement('script');
    script.src = sharedPath;
    script.async = false;
    (document.head || document.documentElement).appendChild(script);
  }

  loadSharedModule();
  loadResults().catch(function (error) {
    console.error(error);
    setStatus('Error loading results.');
  });
})();
