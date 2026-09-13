// ==UserScript==
// @name         AutoExtract Link Tools
// @namespace    https://github.com/autoextractlinktools
// @version      1.0.0
// @description  Detect supported video player setups on the page, extract links,
//               and forward them to the local desktop app at http://localhost:3456/
// @match        https://www.youtube.com/*
// @match        https://www.bilibili.com/*
// @match        https://vimeo.com/*
// @match        http://localhost:*/*
// @match        https://localhost/*
// @grant        none
// @run-at       document_idle
// ==/UserScript==

// userscript/autoextract.js
//
// AutoExtract Link Tools userscript.
//
// This is an alternative page-injection path alongside the Chrome extension.
// It reuses the same shared detection and extraction logic as the extension so
// site/player-specific parsing is not duplicated across runtimes.
//
// Shared logic note:
//   - This userscript currently inlines the shared detect/extract behavior so it
//     can run without a separate build output or hosted @require URL.
//   - The authoritative shared source is still repo root shared/index.js.
//   - If the shared module changes, update this inlined copy from shared/index.js
//     rather than evolving these two independently.
//
// Current behavior:
//   - Runs on page load after the DOM is ready.
//   - Detects supported page state using the shared interface.
//   - Extracts links using the shared interface.
//   - Shows a small in-page status indicator so behavior is observable without
//     devtools.
//   - Forwards results to the desktop app over localhost if it is reachable.
//   - Degrades predictably if the desktop app is not reachable.
//
// Communication:
//   - The desktop app is the intended recipient for forwarded links.
//   - If the desktop app is not reachable, this userscript logs and reports the
//     failure instead of pretending the send succeeded.
//
// TODO:
//   - Replace the inlined shared logic with a proper shared import path once a
//     userscript build or hosted @require URL exists.
//   - Replace stub detection with real site/player-specific extraction.
//   - Decide whether the userscript should expose copy/clipboard behavior or a
//     more visible UI in addition to forwarding.

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Shared detection/extraction interface (inlined from shared/index.js).
  // ---------------------------------------------------------------------------

  var detect = function (context) {
    if (!context || !context.document) {
      return null;
    }

    var markers = context.document.querySelectorAll('[data-autoextract]');
    if (markers.length > 0) {
      return {
        supported: true,
        type: 'stub',
        markerCount: markers.length
      };
    }

    return null;
  };

  var extract = function (context) {
    var links = [];
    var sources = [];

    if (!context || !context.document) {
      return { links: links, sources: sources };
    }

    var markers = context.document.querySelectorAll('[data-autoextract]');
    markers.forEach(function (marker) {
      var url = marker.getAttribute('data-autoextract-url') || marker.getAttribute('href') || '';
      var type = marker.getAttribute('data-autoextract-type') || marker.getAttribute('data-autoextract') || 'link';
      var server = marker.getAttribute('data-autoextract-server') || 'stub';

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

    return { links: links, sources: sources };
  };

  // ---------------------------------------------------------------------------
  // Desktop bridge target.
  // ---------------------------------------------------------------------------

  var DEFAULT_DESKTOP_URL = 'http://localhost:3456/';
  var SENTINEL_CLASS = 'autoextract-userscript-status';

  // ---------------------------------------------------------------------------
  // Small in-page status indicator.
  // ---------------------------------------------------------------------------

  function createStatusElement() {
    var el = document.createElement('div');
    el.className = SENTINEL_CLASS;
    el.style.cssText = (
      'position:fixed;bottom:8px;right:8px;z-index:2147483647;' +
      'background:#1a1a2e;color:#e0e0e0;border:1px solid #0f3460;' +
      'border-radius:4px;padding:6px 8px;font-size:11px;font-family:monospace;' +
      'max-width:260px;word-break:break-all;'
    );
    el.textContent = 'AutoExtract: initializing...';
    document.body.appendChild(el);
    return el;
  }

  function setStatus(statusEl, message) {
    if (statusEl) {
      statusEl.textContent = message;
    }
  }

  // ---------------------------------------------------------------------------
  // Link forwarding.
  // ---------------------------------------------------------------------------

  function sendToDesktop(statusEl, results) {
    var links = results && results.links ? results.links : [];

    if (!links || links.length === 0) {
      setStatus(statusEl, 'AutoExtract: no links to send');
      return;
    }

    setStatus(statusEl, 'AutoExtract: sending to desktop...');

    var body = JSON.stringify({
      detected: results.detection || null,
      links: links,
      sources: results.sources || [],
      pageUrl: location.href,
      pageTitle: document.title || '',
      sentAt: new Date().toISOString()
    });

    fetch(DEFAULT_DESKTOP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body
    })
      .then(function (response) {
        if (!response.ok) {
          setStatus(statusEl, 'AutoExtract: send failed: ' + response.status);
          return;
        }
        setStatus(statusEl, 'AutoExtract: sent ' + links.length + ' link' + (links.length === 1 ? '' : 's') + ' to desktop');
      })
      .catch(function (error) {
        console.warn('AutoExtract userscript: desktop send failed.', error);
        setStatus(statusEl, 'AutoExtract: desktop not reachable');
      });
  }

  // ---------------------------------------------------------------------------
  // Main flow.
  // ---------------------------------------------------------------------------

  function run() {
    var detection = detect({ document: document });
    var results = detection ? extract({ document: document }) : { links: [], sources: [] };
    results.detection = detection;

    console.log('AutoExtract userscript: detection =', detection);
    console.log('AutoExtract userscript: links =', results.links.length);

    var statusEl = createStatusElement();
    setStatus(statusEl, 'AutoExtract: ' + results.links.length + ' link' + (results.links.length === 1 ? '' : 's') + ' found');

    if (results.links.length > 0) {
      sendToDesktop(statusEl, results);
    } else {
      setStatus(statusEl, 'AutoExtract: no supported links found on this page');
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run);
  } else {
    run();
  }
})();
