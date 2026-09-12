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
// Current behavior (scaffold):
//   - Reads the active tab.
//   - Runs a placeholder extraction flow.
//   - Renders the “no video links found” state if extraction returns nothing.
//   - Wires copy and send-to-desktop buttons with stubbed behavior.
//   - Includes an explicit placeholder for the IDM button path.
//
// Defaults:
//   - The desktop bridge target is http://localhost:3456/ by default. This
//     should match the Electron desktop app once the bridge is implemented.
//
// TODO:
//   - Replace the placeholder extraction with real detection/extraction using
//     shared/index.js from the extension bundle.
//   - Implement link copying as a real JSON payload.
//   - Implement sending links to the desktop app.
//   - Decide whether the IDM button should open a download helper, generate a
//     download URL, or be removed from scope.

'use strict';

const STATUS_EL = document.getElementById('status');
const NO_DATA_EL = document.getElementById('no-data');
const LINKS_EL = document.getElementById('links');
const COUNT_BADGE_EL = document.getElementById('count-badge');
const COPY_BTN = document.getElementById('copy-btn');
const IDM_BTN = document.getElementById('idm-btn');
const SEND_BTN = document.getElementById('send-btn');

const DEFAULT_DESKTOP_URL = 'http://localhost:3456/';

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

function copyJson(links) {
  // TODO: use real extracted data here.
  const payload = JSON.stringify({ links: links || [], exportedAt: new Date().toISOString() }, null, 2);
  navigator.clipboard.writeText(payload).then(
    () => setStatus('Copied JSON to clipboard'),
    () => setStatus('Failed to copy JSON')
  );
}

/**
 * Placeholder IDM path.
 *
 * The popup UI already has an IDM button, so this is intentionally represented
 * as an integration point rather than being removed. The actual IDM behavior is
 * not implemented yet and may be out of scope.
 */
function openInIdm(links) {
  // TODO: decide IDM integration behavior.
  // For example: build a download URL, open a helper page, or delegate to the
  // desktop app if it supports IDM-style integration.
  setStatus('Open in IDM is not implemented yet');
}

/**
 * Send extracted links to the desktop app.
 *
 * Default target: http://localhost:3456/
 *
 * TODO: implement the actual HTTP request and error handling. Failures should
 * be communicated to the user instead of silently ignored.
 */
async function sendToDesktop(links) {
  // TODO: implement the request.
  setStatus('Send to Desktop is not implemented yet');
}

async function run() {
  setStatus('Detecting page...');

  // TODO: replace with real extraction.
  const links = [];

  if (links.length === 0) {
    setStatus('No video links found on this page.');
    renderLinks([]);
    disableActionButtons();
    return;
  }

  renderLinks(links);
  enableActionButtons(links);
  setStatus('Detected ' + links.length + ' link' + (links.length === 1 ? '' : 's') + '.');
}

function disableActionButtons() {
  if (COPY_BTN) COPY_BTN.disabled = true;
  if (IDM_BTN) IDM_BTN.disabled = true;
  if (SEND_BTN) SEND_BTN.disabled = true;
}

function enableActionButtons(links) {
  if (COPY_BTN) COPY_BTN.disabled = false;
  if (IDM_BTN) IDM_BTN.disabled = false;
  if (SEND_BTN) SEND_BTN.disabled = false;

  COPY_BTN.onclick = () => copyJson(links);
  IDM_BTN.onclick = () => openInIdm(links);
  SEND_BTN.onclick = () => sendToDesktop(links);
}

// Basic startup.
run().catch((error) => {
  setStatus('Error detecting page.');
  console.error(error);
});
