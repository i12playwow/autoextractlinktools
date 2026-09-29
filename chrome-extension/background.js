// chrome-extension/background.js
//
// MV3 background service worker for the AutoExtract Link Tools extension.
//
// Responsibilities:
//   - Forward extraction payloads to the desktop bridge at
//     http://localhost:3456/ on behalf of content scripts and the popup.
//
// Why a service worker does the sending:
//   - MV3 content scripts run with the page's CORS rules; a cross-origin POST
//     from the page context to localhost would fail without CORS headers.
//   - Extension contexts (background service worker, popup) bypass page CORS
//     for hosts listed in host_permissions, and http://localhost:3456/* is
//     already listed in the manifest.
//   - Centralizing the POST here keeps the URL and payload shape in one place.
//
// Messages accepted (chrome.runtime.sendMessage from popup or content scripts):
//   { type: 'autoextract.sendToDesktop', payload: { detected, links, sources, pageUrl, pageTitle } }
//     -> responds { ok: true, sent: <linkCount>, status: 200 } on success
//     -> responds { ok: false, error: <message> } on failure
//
//   { type: 'autoextract.getTabId' }  (content scripts only)
//     -> responds { ok: true, tabId: <sender.tab.id> }
//     Content scripts cannot reliably learn their own tab id; the background
//     worker can, because sender.tab is populated for content-script messages.
//
//   { type: 'autoextract.runDetection' }  (popup only)
//     -> forwards a runDetection message to the active tab's content script
//     -> responds { ok: true } or { ok: false, error: <message> }
//
//   { type: 'autoextract.ping' }
//     -> responds { ok: true, pong: true } so callers can detect the worker.
//
// The service worker is event-driven and may be woken by any of these messages;
// no persistent state is required.

'use strict';

const DEFAULT_DESKTOP_URL = 'http://localhost:3456/';

function buildPayload(message) {
  var source = message && message.payload ? message.payload : {};
  var links = Array.isArray(source.links) ? source.links : [];

  return {
    detected: source.detected || null,
    links: links,
    sources: Array.isArray(source.sources) ? source.sources : [],
    pageUrl: source.pageUrl || null,
    pageTitle: source.pageTitle || null,
    sentAt: new Date().toISOString()
  };
}

function sendToDesktop(payload) {
  return fetch(DEFAULT_DESKTOP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  }).then(function (response) {
    if (!response.ok) {
      throw new Error('desktop bridge responded ' + response.status);
    }
    return response.status;
  });
}

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (!message || typeof message.type !== 'string') {
    return undefined;
  }

  if (message.type === 'autoextract.ping') {
    sendResponse({ ok: true, pong: true });
    return undefined;
  }

  if (message.type === 'autoextract.getTabId') {
    if (sender && sender.tab && typeof sender.tab.id === 'number') {
      sendResponse({ ok: true, tabId: sender.tab.id });
    } else {
      sendResponse({ ok: false, error: 'no tab id available for sender' });
    }
    return undefined;
  }

  if (message.type === 'autoextract.runDetection') {
    // Popup-originated re-detection: poke the active tab's content script.
    if (!chrome.tabs || !chrome.tabs.query) {
      sendResponse({ ok: false, error: 'tabs API not available' });
      return undefined;
    }

    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      if (!tabs || !tabs.length || typeof tabs[0].id !== 'number') {
        sendResponse({ ok: false, error: 'no active tab' });
        return;
      }
      chrome.tabs.sendMessage(tabs[0].id, { type: 'autoextract.runDetection' }, function () {
        if (chrome.runtime.lastError) {
          // No content script on this page (or the tab is not ready).
          sendResponse({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        sendResponse({ ok: true });
      });
    });

    // Keep the message channel open for the async sendResponse above.
    return true;
  }

  if (message.type === 'autoextract.sendToDesktop') {
    var payload = buildPayload(message);
    var linkCount = payload.links.length;

    if (linkCount === 0) {
      sendResponse({ ok: false, error: 'no links to send' });
      return undefined;
    }

    sendToDesktop(payload)
      .then(function (status) {
        sendResponse({ ok: true, sent: linkCount, status: status });
      })
      .catch(function (error) {
        sendResponse({
          ok: false,
          error: error && error.message ? error.message : 'desktop send failed'
        });
      });

    // Keep the message channel open for the async sendResponse above.
    return true;
  }

  return undefined;
});
