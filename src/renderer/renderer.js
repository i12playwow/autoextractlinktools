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
//   - Search + type filtering: the search box matches link URLs and page
//     titles/URLs case-insensitively; the type chips (video/audio/hls/dash/
//     other, with per-type counts) narrow which link rows are shown. Cards
//     that match only through page text show all their rows; cards matched
//     through a link show only the matching rows. The pure matching rules
//     live in filter.js (window.AutoExtractFilter) and are unit-tested by
//     test-renderer-filter.js; this file only applies their verdicts.
//   - Clear empties both the renderer view and the main-process backlog.
//   - Link rows are actionable: Copy (button or URL click) uses the DOM
//     Clipboard API with an execCommand fallback; Open asks the main process
//     over autoextract:openExternal, where the URL is re-validated to http/https
//     before shell.openExternal. The Open button only renders when the preload
//     exposes the API.
//   - If the preload API is missing (bridge not attached, e.g. the file opened
//     outside Electron), the UI degrades to a disabled state instead of
//     pretending to work. If filter.js failed to load, the filter bar hides
//     and the window behaves exactly as before filters existed.

'use strict';

const listEl = document.getElementById('list');
const emptyEl = document.getElementById('empty');
const noMatchEl = document.getElementById('no-match');
const clearBtn = document.getElementById('clear-btn');
const statusEl = document.getElementById('bridge-status');
const filterBarEl = document.getElementById('filter-bar');
const searchInput = document.getElementById('search-input');
const typeChipsEl = document.getElementById('type-chips');
const filterStatusEl = document.getElementById('filter-status');

const filterApi = window.AutoExtractFilter || null;

// Every payload accepted so far, oldest first. This is the single source of
// truth for re-renders; the DOM is a projection of records + filterState.
const records = [];

// Filter state: { query, types } in canonical form (see filter.js). types is
// null when no type filter is active.
let filterState = { query: '', types: null };

// Selected types in click order; canonicalized into filterState.types. Kept
// separately so re-clicking cycles a chip cleanly.
const selectedTypes = [];

const seenPayloads = new Set();

function updateEmptyState() {
  const hasItems = listEl.children.length > 0;
  const hasHistory = records.length > 0;
  const filtered = Boolean(filterApi && filterApi.hasActiveFilter(filterState));
  // "No links received yet" until history exists; "no match" only once there
  // is history that the active filter hides entirely (e.g. right after Clear
  // with a chip still active, the empty panel is the honest one).
  if (emptyEl) { emptyEl.classList.toggle('hidden', hasItems || (filtered && hasHistory)); }
  if (noMatchEl) { noMatchEl.classList.toggle('hidden', hasItems || !filtered || !hasHistory); }
}

function updateFilterStatus() {
  if (!filterStatusEl || !filterApi) {
    return;
  }
  if (records.length === 0) {
    filterStatusEl.textContent = '';
    return;
  }
  const totals = filterApi.countVisible(records, filterApi.canonicalState('', null));
  if (!filterApi.hasActiveFilter(filterState)) {
    filterStatusEl.textContent = totals.payloads + (totals.payloads === 1 ? ' payload \u00b7 ' : ' payloads \u00b7 ') +
      totals.links + (totals.links === 1 ? ' link' : ' links');
    return;
  }
  const visible = filterApi.countVisible(records, filterState);
  filterStatusEl.textContent = 'Showing ' + visible.payloads + ' of ' + totals.payloads +
    (totals.payloads === 1 ? ' payload' : ' payloads') + ' \u00b7 ' +
    visible.links + ' of ' + totals.links + (totals.links === 1 ? ' link' : ' links');
}

function applyFilter() {
  if (!filterApi) {
    return;
  }
  renderAll();
}

function makeChip(type) {
  const chip = document.createElement('span');
  chip.className = 'chip ' + (type || 'other');
  chip.textContent = type || 'other';
  return chip;
}

// Copies text via the async Clipboard API with a document.execCommand
// fallback for environments where the async API is unavailable or the
// document is not focused. Returns a promise resolving to true on success.
function copyTextToClipboard(text) {
  if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    return navigator.clipboard.writeText(text).then(function () {
      return true;
    }).catch(function () {
      return legacyCopy(text);
    });
  }
  return Promise.resolve(legacyCopy(text));
}

function legacyCopy(text) {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch (error) {
    return false;
  }
}

// Brief visual confirmation on an action button. The timeout is not tracked:
// rows are cheap DOM and a stale timer on a removed node is harmless.
function flashCopied(button) {
  button.classList.add('copied');
  const previous = button.textContent;
  button.textContent = 'copied';
  setTimeout(function () {
    button.classList.remove('copied');
    button.textContent = previous;
  }, 1200);
}

// Builds the Copy / Open action cluster for one link row.
function makeRowActions(url) {
  const actions = document.createElement('div');
  actions.className = 'row-actions';

  const copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.className = 'row-btn';
  copyBtn.textContent = 'copy';
  copyBtn.title = 'Copy URL to clipboard';
  copyBtn.addEventListener('click', function (event) {
    event.stopPropagation();
    copyTextToClipboard(url).then(function (ok) {
      if (ok) {
        flashCopied(copyBtn);
      } else {
        copyBtn.title = 'Copy failed; the URL may be selected manually';
      }
    });
  });
  actions.appendChild(copyBtn);

  if (window.autoextract && typeof window.autoextract.openExternal === 'function') {
    const openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.className = 'row-btn';
    openBtn.textContent = 'open';
    openBtn.title = 'Open in the default browser';
    openBtn.addEventListener('click', function (event) {
      event.stopPropagation();
      window.autoextract.openExternal(url).catch(function () {});
    });
    actions.appendChild(openBtn);
  }

  return actions;
}

function makeLinkRow(link, isVisible) {
  const row = document.createElement('div');
  row.className = 'link-row';
  // Author CSS sets display on .link-row, which would beat the UA's [hidden]
  // rule, so the hidden state gets an explicit rule in styles.css.
  row.hidden = isVisible === false;

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
  // bdo-neutral span so the text itself still renders left-to-right. Clicking
  // the URL is a shortcut for Copy.
  const url = document.createElement('span');
  url.className = 'link-url clickable';
  url.textContent = '\u200e' + link.url;
  url.title = link.url + ' (click to copy)';
  url.addEventListener('click', function () {
    copyTextToClipboard(link.url).then(function (ok) {
      if (ok) { url.title = link.url + ' (copied)'; }
    });
  });
  detail.appendChild(url);

  row.appendChild(detail);

  if (typeof link.url === 'string' && link.url) {
    row.appendChild(makeRowActions(link.url));
  }
  return row;
}

// recordLinksVisibility(record) -> null (show every row) or boolean[] (per
// link row visibility), computed from the active filter. A card that passed
// only through page text has zero matched indexes by design; like the no-
// filter case, it shows every row (mirrors countVisible's rule).
function recordLinksVisibility(record) {
  if (!filterApi) {
    return null;
  }
  const m = filterApi.matchRecord(record, filterState);
  if (!m.passes || m.matchedLinkIndexes === null || m.matchedLinkIndexes.length === 0) {
    return null;
  }
  const links = Array.isArray(record.links) ? record.links : [];
  const visible = new Array(links.length).fill(false);
  m.matchedLinkIndexes.forEach(function (i) {
    if (i >= 0 && i < visible.length) {
      visible[i] = true;
    }
  });
  return visible;
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

  const visibility = recordLinksVisibility(record);
  (record.links || []).forEach(function (link, index) {
    card.appendChild(makeLinkRow(link, visibility === null ? true : visibility[index]));
  });

  listEl.appendChild(card);
}

function renderAll() {
  listEl.innerHTML = '';
  records.forEach(function (record) {
    // Cards that fail the filter are left out entirely; cards that pass get
    // per-row visibility applied inside renderPayload.
    if (filterApi && !filterApi.matchRecord(record, filterState).passes) {
      return;
    }
    renderPayload(record);
  });
  updateEmptyState();
  updateFilterStatus();
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

  records.push(record);

  if (!filterApi || filterApi.matchRecord(record, filterState).passes) {
    renderPayload(record);
    updateEmptyState();
    updateFilterStatus();
  } else {
    // Hidden by the active filter: totals still grow, and the no-match panel
    // may need to appear (or disappear) even though the list did not change.
    updateEmptyState();
    updateFilterStatus();
  }

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

// Builds the type chips from filterApi.TYPES with live per-type counts.
function buildTypeChips() {
  if (!typeChipsEl || !filterApi) {
    return;
  }
  typeChipsEl.innerHTML = '';
  filterApi.TYPES.forEach(function (type) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip-toggle';
    chip.dataset.type = type;
    chip.setAttribute('aria-pressed', String(selectedTypes.indexOf(type) !== -1));
    chip.title = 'Toggle ' + type + ' links';

    const name = document.createElement('span');
    name.className = 'chip-name';
    name.textContent = type;
    chip.appendChild(name);

    const count = document.createElement('span');
    count.className = 'chip-count';
    count.dataset.countFor = type;
    count.textContent = '0';
    chip.appendChild(count);

    chip.addEventListener('click', function () {
      const at = selectedTypes.indexOf(type);
      if (at === -1) {
        selectedTypes.push(type);
      } else {
        selectedTypes.splice(at, 1);
      }
      chip.setAttribute('aria-pressed', String(at === -1));
      filterState = filterApi.canonicalState(searchInput ? searchInput.value : '', selectedTypes);
      applyFilter();
    });

    typeChipsEl.appendChild(chip);
  });
}

function refreshChipCounts() {
  if (!filterApi) {
    return;
  }
  const counts = filterApi.typeCounts(records);
  Object.keys(counts).forEach(function (type) {
    const el = typeChipsEl.querySelector('[data-count-for="' + type + '"]');
    if (el) {
      el.textContent = String(counts[type]);
    }
  });
}

function initFilterBar() {
  if (!filterApi || !filterBarEl) {
    // filter.js failed to load (or the bar is absent): hide the bar and run
    // the legacy always-show-everything behavior.
    if (filterBarEl) {
      filterBarEl.hidden = true;
    }
    return;
  }

  buildTypeChips();

  if (searchInput) {
    searchInput.addEventListener('input', function () {
      filterState = filterApi.canonicalState(searchInput.value, selectedTypes);
      applyFilter();
    });
  }
}

function init() {
  setStatus();

  if (!window.autoextract) {
    if (clearBtn) { clearBtn.disabled = true; }
    updateEmptyState();
    return;
  }

  initFilterBar();

  let unsubscribe = null;

  window.autoextract.getBacklog()
    .then(function (backlog) {
      (backlog || []).forEach(function (record) {
        acceptPayload(record, false);
      });
      refreshChipCounts();
      // Subscribe only after the backlog is drained, so nothing is skipped.
      unsubscribe = window.autoextract.onPayload(function (record) {
        acceptPayload(record, true);
        refreshChipCounts();
      });
      // Consumed by run-desktop-bridge.js to verify the pull path.
      console.log('AutoExtract renderer: ready with ' + (backlog || []).length + ' backlogged payload(s)');
      updateEmptyState();
      updateFilterStatus();
    })
    .catch(function (error) {
      console.error('AutoExtract renderer: failed to load backlog.', error);
      updateEmptyState();
    });

  if (clearBtn) {
    clearBtn.addEventListener('click', function () {
      window.autoextract.clearBacklog().catch(function () {});
      listEl.innerHTML = '';
      records.length = 0;
      seenPayloads.clear();
      refreshChipCounts();
      updateEmptyState();
      updateFilterStatus();
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
