// src/renderer/renderer.js
//
// Renderer for the AutoExtract desktop window.
//
// Behavior:
//   - Loads the backlog via window.autoextract.getBacklog() so history that
//     arrived before the window attached is visible.
//   - Subscribes to live payloads via window.autoextract.onPayload(). A
//     receivedAt guard drops duplicates if a payload arrives between the
//     backlog fetch and the subscription.
//   - Clear empties both the renderer view and the main-process backlog.
//   - If the preload API is missing (bridge not attached, e.g. the file opened
//     outside Electron), the UI degrades to a disabled state instead of
//     pretending to work.

'use strict';

const listEl = document.getElementById('list');
const emptyEl = document.getElementById('empty');
const clearBtn = document.getElementById('clear-btn');
const statusEl = document.getElementById('bridge-status');

const seenPayloads = new Set();

function updateEmptyState() {
  const hasItems = listEl.children.length > 0;
  emptyEl.classList.toggle('hidden', hasItems);
}

function makeChip(type) {
  const chip = document.createElement('span');
  chip.className = 'chip ' + (type || 'other');
  chip.textContent = type || 'other';
  return chip;
}

function makeLinkRow(link) {
  const row = document.createElement('div');
  row.className = 'link-row';

  row.appendChild(makeChip(link.type));

  const detail = document.createElement('div');
  detail.className = 'link-detail';

  const metaParts = [];
  if (link.quality) { metaParts.push(link.quality); }
  if (link.container) { metaParts.push(link.container); }
  if (link.size) { metaParts.push(link.size); }
  if (link.itag) { metaParts.push('itag ' + link.itag); }

  if (metaParts.length > 0) {
    const meta = document.createElement('span');
    meta.className = 'link-meta';
    meta.textContent = metaParts.join(' \u00b7 ');
    detail.appendChild(meta);
    detail.appendChild(document.createTextNode(' '));
  }

  // direction:rtl keeps long URLs ellipsized at the interesting end; wrap in a
  // bdo-neutral span so the text itself still renders left-to-right.
  const url = document.createElement('span');
  url.className = 'link-url';
  url.textContent = '\u200e' + link.url;
  url.title = link.url;
  detail.appendChild(url);

  row.appendChild(detail);
  return row;
}

function renderPayload(record) {
  const card = document.createElement('section');
  card.className = 'payload';

  const meta = document.createElement('div');
  meta.className = 'payload-meta';

  const title = document.createElement('span');
  title.className = 'payload-title';
  title.textContent = record.pageTitle || 'Untitled page';
  meta.appendChild(title);

  const time = document.createElement('span');
  time.className = 'payload-time';
  time.textContent = new Date(record.receivedAt).toLocaleTimeString();
  meta.appendChild(time);

  card.appendChild(meta);

  if (record.pageUrl) {
    const pageUrl = document.createElement('div');
    pageUrl.className = 'payload-url';
    pageUrl.textContent = record.pageUrl;
    pageUrl.title = record.pageUrl;
    card.appendChild(pageUrl);
  }

  (record.links || []).forEach(function (link) {
    card.appendChild(makeLinkRow(link));
  });

  listEl.appendChild(card);
}

function acceptPayload(record, isLive) {
  if (!record || typeof record !== 'object') {
    return;
  }
  // Dedup guard: a payload can arrive via both the backlog and the live
  // channel if it lands between the fetch and the subscription.
  const key = record.receivedAt + '|' + (record.links || []).length;
  if (seenPayloads.has(key)) {
    return;
  }
  seenPayloads.add(key);

  renderPayload(record);
  updateEmptyState();

  if (isLive) {
    // Consumed by run-desktop-bridge.js to verify the live IPC push path.
    console.log('AutoExtract renderer: showing payload from ' + (record.pageUrl || 'unknown'));
  }
}

function setStatus() {
  if (window.autoextract && statusEl) {
    statusEl.textContent = 'bridge connected';
    statusEl.classList.add('ok');
  } else if (statusEl) {
    statusEl.textContent = 'bridge not attached';
  }
}

function init() {
  setStatus();

  if (!window.autoextract) {
    if (clearBtn) { clearBtn.disabled = true; }
    updateEmptyState();
    return;
  }

  let unsubscribe = null;

  window.autoextract.getBacklog()
    .then(function (backlog) {
      (backlog || []).forEach(function (record) {
        acceptPayload(record, false);
      });
      // Subscribe only after the backlog is drained, so nothing is skipped.
      unsubscribe = window.autoextract.onPayload(function (record) {
        acceptPayload(record, true);
      });
      // Consumed by run-desktop-bridge.js to verify the pull path.
      console.log('AutoExtract renderer: ready with ' + (backlog || []).length + ' backlogged payload(s)');
      updateEmptyState();
    })
    .catch(function (error) {
      console.error('AutoExtract renderer: failed to load backlog.', error);
      updateEmptyState();
    });

  if (clearBtn) {
    clearBtn.addEventListener('click', function () {
      window.autoextract.clearBacklog().catch(function () {});
      listEl.innerHTML = '';
      seenPayloads.clear();
      updateEmptyState();
    });
  }

  window.addEventListener('beforeunload', function () {
    if (typeof unsubscribe === 'function') {
      unsubscribe();
    }
  });

  updateEmptyState();
}

init();
