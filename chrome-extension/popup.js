// chrome-extension/popup.js
//
// Popup controller for the AutoExtract Link Tools Chrome extension.
//
// This script is wired to the existing popup UI:
//   - #status
//   - #no-data
//   - #not-run
//   - #links
//   - #count-badge
//   - #copy-btn, #idm-btn, #send-btn, #detect-btn
//
// Current behavior:
//   - Reads the active tab.
//   - Loads stored extraction results from chrome.storage.local keyed by tab id.
//   - If nothing has been stored yet, it shows an explicit "not run yet" state
//     and offers a detect action.
//   - If results were stored but the current page URL does not match the stored
//     page URL, it treats the stored results as stale and prompts re-detection.
//   - Wires copy, IDM, and send-to-desktop buttons against real stored results.
//
// Defaults:
//   - The desktop bridge target is http://localhost:3456/ by default. This
//     matches the Electron desktop app bridge added in src/main.js.
//
// TODO:
//   - Replace stub detection with real site/player-specific extraction.
//   - Decide whether the IDM button should open a download helper, generate a
//     download URL, or be removed from scope.

'use strict';

const STATUS_EL = document.getElementById('status');
const NO_DATA_EL = document.getElementById('no-data');
const NOT_RUN_EL = document.getElementById('not-run');
const LINKS_EL = document.getElementById('links');
const COUNT_BADGE_EL = document.getElementById('count-badge');
const COPY_BTN = document.getElementById('copy-btn');
const IDM_BTN = document.getElementById('idm-btn');
const SEND_BTN = document.getElementById('send-btn');
const DETECT_BTN = document.getElementById('detect-btn');

const DEFAULT_DESKTOP_URL = 'http://localhost:3456/';
const PAGE_URL_TOLERANCE = 1; // URL must match exactly for stored results to count as current.

let currentResults = null;

function setStatus(message) {
  if (STATUS_EL) STATUS_EL.textContent = message;
}

function clearResults() {
  if (NO_DATA_EL) NO_DATA_EL.style.display = 'none';
  if (NOT_RUN_EL) NOT_RUN_EL.style.display = 'none';
  if (LINKS_EL) LINKS_EL.innerHTML = '';
  if (COUNT_BADGE_EL) COUNT_BADGE_EL.textContent = '';
}

function showNoData() {
  if (NO_DATA_EL) NO_DATA_EL.style.display = '';
  clearResults();
}

function showNotRun() {
  if (NOT_RUN_EL) NOT_RUN_EL.style.display = '';
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
  NOT_RUN_EL.style.display = 'none';
  LINKS_EL.innerHTML = '';

  links.forEach(function (link) {
    var item = document.createElement('div');
    item.className = 'link-item';

    var server = document.createElement('div');
    server.className = 'server';
    server.textContent = link.server || 'unknown';

    var type = document.createElement('div');
    type.className = 'type';
    type.textContent = link.type || 'link';

    var url = document.createElement('div');
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
  var payload = JSON.stringify({
    detected: results.detection || null,
    links: results.links || [],
    sources: results.sources || [],
    exportedAt: new Date().toISOString()
  }, null, 2);

  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(payload).then(
      function () { setStatus('Copied JSON to clipboard'); },
      function () { setStatus('Failed to copy JSON'); }
    );
  } else {
    setStatus('Clipboard API not available');
  }
}

function openInIdm(results) {
  // TODO: decide IDM integration behavior.
  setStatus('Open in IDM is not implemented yet');
}

async function sendToDesktop(results) {
  var links = results && results.links ? results.links : [];

  if (!links || links.length === 0) {
    setStatus('Nothing to send');
    return;
  }

  setStatus('Sending to desktop...');

  try {
    var body = JSON.stringify({
      detected: results.detection || null,
      links: links,
      sources: results.sources || [],
      pageUrl: results.pageUrl || null,
      pageTitle: results.pageTitle || null,
      sentAt: new Date().toISOString()
    });

    var response = await fetch(DEFAULT_DESKTOP_URL, {
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
    setStatus('Desktop not reachable' + (error && error.message ? ': ' + error.message : ''));
  }
}

function disableActionButtons() {
  if (COPY_BTN) COPY_BTN.disabled = true;
  if (IDM_BTN) IDM_BTN.disabled = true;
  if (SEND_BTN) SEND_BTN.disabled = true;
  if (DETECT_BTN) DETECT_BTN.disabled = true;
}

function enableResultActionButtons(results) {
  if (COPY_BTN) COPY_BTN.disabled = false;
  if (IDM_BTN) IDM_BTN.disabled = false;
  if (SEND_BTN) SEND_BTN.disabled = false;
  if (DETECT_BTN) DETECT_BTN.disabled = true;

  COPY_BTN.onclick = function () { copyJson(results); };
  IDM_BTN.onclick = function () { openInIdm(results); };
  SEND_BTN.onclick = function () { sendToDesktop(results); };
}

function enableDetectButton() {
  if (DETECT_BTN) {
    DETECT_BTN.disabled = false;
    DETECT_BTN.onclick = function () {
      DETECT_BTN.disabled = true;
      setStatus('Detecting...');
      chrome.runtime.sendMessage({ type: 'autoextract.runDetection' }, function (response) {
        if (chrome.runtime.lastError) {
          setStatus('Detection request failed.');
          DETECT_BTN.disabled = false;
          return;
        }
        if (response && response.ok) {
          setStatus('Detection triggered. Refresh the popup to see results.');
        } else {
          setStatus('Detection request returned no confirmation.');
          DETECT_BTN.disabled = false;
        }
      });
    };
  }
}

function isActivePageMatch(stored) {
  if (!stored) {
    return false;
  }
  if (!stored.pageUrl) {
    return false;
  }
  return stored.pageUrl === location.href;
}

function loadResults() {
  setStatus('Loading results...');
  clearResults();
  disableActionButtons();

  if (!chrome.storage || !chrome.storage.local || !chrome.storage.local.get) {
    setStatus('Storage API not available');
    return;
  }

  if (!chrome.tabs || !chrome.tabs.query) {
    setStatus('Tabs API not available');
    return;
  }

  chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
    if (!tabs || !tabs.length) {
      setStatus('No active tab');
      return;
    }

    var tabId = tabs[0].id;
    if (typeof tabId === 'undefined') {
      setStatus('No active tab');
      return;
    }

    var storageKey = 'autoextract_results_' + tabId;

    chrome.storage.local.get([storageKey], function (items) {
      var stored = items[storageKey];

      if (!stored) {
        currentResults = {
          links: [],
          sources: [],
          detection: null,
          pageUrl: location.href,
          pageTitle: document.title || ''
        };
        showNotRun();
        setStatus('Detection has not run on this page yet.');
        enableDetectButton();
        return;
      }

      if (!isActivePageMatch(stored)) {
        currentResults = {
          links: [],
          sources: [],
          detection: stored.detection || null,
          pageUrl: location.href,
          pageTitle: document.title || ''
        };
        showNotRun();
        setStatus('Results are from a different page. Run detection again.');
        enableDetectButton();
        return;
      }

      if (!stored.links || stored.links.length === 0) {
        currentResults = stored;
        renderLinks([]);
        setStatus('No video links found on this page.');
        disableActionButtons();
        return;
      }

      currentResults = stored;
      renderLinks(stored.links);
      enableResultActionButtons(stored);
      setStatus('Detected ' + stored.links.length + ' link' + (stored.links.length === 1 ? '' : 's') + '.');
    });
  });
}

(function () {
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

  // Support a manual re-detection request triggered from the popup.
  chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    if (message && message.type === 'autoextract.runDetection') {
      sendResponse({ ok: true });
    }
  });

  loadResults();
})();
