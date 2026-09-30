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
//   - Per-row verification: the check button asks the main process to probe
//     the URL (HEAD with a GET fallback) over autoextract:verifyUrl; the
//     pure display rules live in verify.js (window.AutoExtractVerify,
//     unit-tested by test-renderer-verify.js). Only successes are stored, so
//     a transient failure can never permanently brand a row dead. Newly
//     received links are also verified in the background a few seconds after
//     they arrive (scheduleAutoVerify); background results are silent — a
//     success paints the alive badge, a failure changes nothing, so only
//     the explicit check button can ever mark a row dead.
//   - A footer status bar shows the bridge endpoint, the history file path,
//     and a payload count with a live per-type link breakdown (e.g.
//     "2 payloads · 12 video · 3 hls", zero types omitted); main reports the
//     paths over autoextract:getAppInfo once, and the count updates on every
//     payload and Clear. Clicking the history path asks main (over the
//     argument-less revealHistoryFolder channel) to open the file's folder
//     with the file selected.
//   - Verify results persist: every successful probe is reported over
//     autoextract:recordVerify (alive-only; main canonicalizes before it
//     reaches the encrypted history file), and the stored map is pulled over
//     autoextract:getVerifyHistory before the backlog drains, so restored
//     rows show their last-verified badges immediately after a restart.

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
const verifyApi = window.AutoExtractVerify || null;

// Footer status bar elements; all optional so a stale HTML variant cannot
// crash the renderer.
const sbBridgeEl = document.getElementById('sb-bridge');
const sbHistoryEl = document.getElementById('sb-history');
const sbCountEl = document.getElementById('sb-count');

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

// { bridgeHost, historyFile } from main once at startup; null when the
// preload API is missing.
let appInfo = null;

// Footer status bar: bridge endpoint + history path arrive once from main
// (nulls under plain Node / missing preload); the payload count tracks the
// records source of truth.
function updateStatusBar() {
  if (appInfo && sbBridgeEl) {
    sbBridgeEl.textContent = 'bridge ' + appInfo.bridgeHost;
  }
  if (appInfo && sbHistoryEl) {
    sbHistoryEl.textContent = appInfo.historyFile;
  }
  if (sbCountEl) {
    // Payload count plus a live per-type breakdown from the same pure
    // source the chips use; without filter.js the count stands alone.
    const breakdown = filterApi
      ? filterApi.formatTypeCounts(filterApi.typeCounts(records))
      : '';
    sbCountEl.textContent = records.length +
      (records.length === 1 ? ' payload' : ' payloads') +
      (breakdown ? ' \u00b7 ' + breakdown : '');
  }
}

// Makes the footer's history slot clickable: one click asks main to reveal
// the history file in the OS file manager. Wired once after getAppInfo
// resolves, so the slot is only clickable when there is a real path behind
// it. The renderer sends no path argument — main reveals its own.
function initHistoryReveal() {
  if (!sbHistoryEl || !appInfo || !appInfo.historyFile) {
    return;
  }
  if (!window.autoextract || typeof window.autoextract.revealHistoryFolder !== 'function') {
    return;
  }
  sbHistoryEl.classList.add('clickable');
  sbHistoryEl.title = appInfo.historyFile + ' (click to reveal)';
  sbHistoryEl.addEventListener('click', function () {
    window.autoextract.revealHistoryFolder().catch(function () {});
  });
}

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

// ---- Link verification (per-row "check" action) ----
//
// verifyState maps URL -> the last success answer from main, through the
// pure helpers in verify.js. Failures are never stored: they render as a
// transient badge + status note that the next re-render clears.

const verifyState = new Map();

function formatVerifiedAt(iso) {
  try {
    return 'last verified ' + new Date(iso).toLocaleString();
  } catch (error) {
    return '';
  }
}

// The badge span for a row, created on first use so both the live answer
// path and the re-render restore path share one idempotent helper.
function ensureBadge(row) {
  let badge = row.querySelector('.verify-badge');
  if (!badge) {
    badge = document.createElement('span');
    row.appendChild(badge);
  }
  return badge;
}

function showVerifiedBadge(row, iso) {
  if (!row || !verifyApi) { return; }
  const badge = ensureBadge(row);
  badge.textContent = 'alive';
  badge.className = 'verify-badge alive';
  badge.hidden = false;
  const label = verifyApi.statusLabel({ state: 'alive', checkedAt: Date.parse(iso) || 0 });
  badge.title = (label || 'verified') + ' \u00b7 ' + formatVerifiedAt(iso);
}

// Transient dead marking: a red badge with the human failure text plus an
// unobtrusive note under the row. Nothing is stored, so a filter keystroke
// or the next payload clears it.
function showDeadBadge(row, message) {
  if (!row) { return; }
  const badge = ensureBadge(row);
  badge.textContent = 'dead';
  badge.className = 'verify-badge dead';
  badge.hidden = false;
  badge.title = message;
  const previous = row.querySelector('.verify-note');
  if (previous) { previous.remove(); }
  const note = document.createElement('div');
  note.className = 'verify-note';
  note.textContent = message + ' \u00b7 checked just now';
  row.appendChild(note);
  row.classList.add('verify-dead');
}

// Restores the stored alive mark for a URL, if any. Runs on every re-render
// so badges and last-verified labels survive filter typing.
function attachVerifyStatus(row, url) {
  if (!verifyApi || !row) { return; }
  const note = row.querySelector('.verify-note');
  if (note) { note.remove(); }
  row.classList.remove('verify-dead');
  const status = verifyApi.statusOf(verifyState, url);
  if (status.state === 'alive') {
    showVerifiedBadge(row, new Date(status.checkedAt).toISOString());
  }
}

// Probes one row's URL over the preload channel. The button is disabled for
// the duration; the pure module's recheck lock absorbs overlapping answers.
// ---- Background auto-verify (newly received links) ----
//
// A few seconds after a live payload arrives, its links are verified in the
// background: staggered per link, skipped for URLs already verified (or
// being verified) recently, and silent on failure. Guarded at every level
// so a test harness or a page without verify.js degrades to manual-only.

// Delay before the first probe of a fresh payload; stagger between links.
var AUTO_VERIFY_DELAY_MS = 4 * 1000;
var AUTO_VERIFY_STAGGER_MS = 300;
// One in-flight probe per URL at a time, shared with manual checks.
var inFlightVerifies = new Set();
var autoVerifyTimers = [];

function clearAutoVerifyTimers() {
  autoVerifyTimers.forEach(function (timer) {
    clearTimeout(timer);
  });
  autoVerifyTimers.length = 0;
}

// Shared probe core for the manual button and the background pass: runs the
// request only when neither the recheck lock nor an in-flight probe of the
// same URL rejects it, and lets the caller decide how to paint the answer.
// Reports a stored success to main so it survives restarts. Fire-and-forget:
// persistence is best-effort and failures are silent (the badge already
// shows the state for this session). Guarded for preload variants without
// the channel.
function persistVerify(url) {
  if (!window.autoextract || typeof window.autoextract.recordVerify !== 'function') {
    return;
  }
  const status = verifyApi.statusOf(verifyState, url);
  window.autoextract.recordVerify(url, {
    ok: true,
    status: status.code === 3 ? 3 : 2,
    code: status.code
  }).catch(function () {});
}

function requestVerify(url, at) {
  if (!window.autoextract || typeof window.autoextract.verifyUrl !== 'function' || !verifyApi) {
    return Promise.resolve(false);
  }
  if (inFlightVerifies.has(url)) {
    return Promise.resolve(false);
  }
  const status = verifyApi.statusOf(verifyState, url);
  if (status.state === 'alive' && at - (status.checkedAt || 0) < verifyApi.MIN_MS_BETWEEN_CHECKS) {
    return Promise.resolve(false);
  }
  inFlightVerifies.add(url);
  return window.autoextract.verifyUrl(url).then(function (raw) {
    const stored = verifyApi.applyResult(verifyState, url, raw, at);
    // true: success stored. raw: the probe ran but the answer was not a
    // storable success (failure shape). null: the probe ran and the invoke
    // itself rejected. false: skipped without probing.
    return stored ? true : (raw || null);
  }).catch(function () {
    return null;
  }).then(function (outcome) {
    inFlightVerifies.delete(url);
    return outcome;
  });
}

// Background pass for one fresh payload. Successes refresh the alive badge
// on the URL's row (whichever row now shows that URL); failures stay silent.
function scheduleAutoVerify(record) {
  if (!verifyApi || !window.autoextract || typeof window.autoextract.verifyUrl !== 'function') {
    return;
  }
  const links = record && Array.isArray(record.links) ? record.links : [];
  links.forEach(function (link, index) {
    if (!link || typeof link.url !== 'string' || !link.url) {
      return;
    }
    const timer = setTimeout(function () {
      const url = link.url;
      const at = Date.now();
      requestVerify(url, at).then(function (outcome) {
        if (outcome !== true) {
          // Silent pass: failures, skips, and declines change nothing here.
          return;
        }
        persistVerify(url);
        const status = verifyApi.statusOf(verifyState, url);
        listEl.querySelectorAll('.link-row').forEach(function (row) {
          const urlSpan = row.querySelector('.link-url');
          if (urlSpan && urlSpan.dataset.autoextractUrl === url) {
            row.classList.remove('verify-dead');
            showVerifiedBadge(row, new Date(status.checkedAt || at).toISOString());
          }
        });
      });
    }, AUTO_VERIFY_DELAY_MS + index * AUTO_VERIFY_STAGGER_MS);
    autoVerifyTimers.push(timer);
  });
}

function runVerify(row, url, button) {
  if (!window.autoextract || typeof window.autoextract.verifyUrl !== 'function' || !verifyApi) {
    return;
  }
  if (button) {
    button.disabled = true;
    button.textContent = 'checking';
  }
  const at = Date.now();
  requestVerify(url, at).then(function (outcome) {
    if (outcome === true) {
      row.classList.remove('verify-dead');
      const status = verifyApi.statusOf(verifyState, url);
      showVerifiedBadge(row, new Date(status.checkedAt || at).toISOString());
      persistVerify(url);
    } else if (outcome === null) {
      showDeadBadge(row, 'Check failed');
    } else if (outcome) {
      // The probe ran and the URL is not alive (HTTP >= 400, timeout,
      // unsafe, or another failure shape).
      showDeadBadge(row, verifyApi.failureMessage(outcome));
    }
    // outcome === false: skipped (in-flight or recently verified) — leave
    // the row exactly as it is.
  }).then(function () {
    if (button) {
      button.disabled = false;
      button.textContent = 'check';
    }
  });
}

// Builds the Copy / Open / Check action cluster for one link row.
function makeRowActions(url, row) {
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

  if (window.autoextract && typeof window.autoextract.verifyUrl === 'function' && verifyApi) {
    const checkBtn = document.createElement('button');
    checkBtn.type = 'button';
    checkBtn.className = 'row-btn verify-btn';
    checkBtn.textContent = 'check';
    checkBtn.title = 'Verify this link now (HEAD request from the desktop app)';
    checkBtn.addEventListener('click', function (event) {
      event.stopPropagation();
      runVerify(row, url, checkBtn);
    });
    actions.appendChild(checkBtn);
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
  url.dataset.autoextractUrl = String(link.url);
  url.addEventListener('click', function () {
    copyTextToClipboard(link.url).then(function (ok) {
      if (ok) { url.title = link.url + ' (copied)'; }
    });
  });
  detail.appendChild(url);

  row.appendChild(detail);

  attachVerifyStatus(row, String(link.url));

  if (typeof link.url === 'string' && link.url) {
    row.appendChild(makeRowActions(link.url, row));
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
  // Re-attach stored verification state; the DOM was just rebuilt, so every
  // row starts without its alive badge.
  listEl.querySelectorAll('.link-row').forEach(function (row) {
    const urlSpan = row.querySelector('.link-url');
    if (urlSpan && urlSpan.dataset.autoextractUrl) {
      attachVerifyStatus(row, urlSpan.dataset.autoextractUrl);
    }
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
  } else {
    // Hidden by the active filter: totals still grow, and the no-match panel
    // may need to appear (or disappear) even though the list did not change.
  }
  updateEmptyState();
  updateFilterStatus();
  // Counted even when the card is hidden by the filter: the footer reports
  // the backlog size, not the visible subset.
  updateStatusBar();

  if (isLive) {
    // Consumed by run-desktop-bridge.js to verify the live IPC push path.
    console.log('AutoExtract renderer: showing payload from ' + (record.pageUrl || 'unknown'));
    scheduleAutoVerify(record);
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
  updateStatusBar();

  if (!window.autoextract) {
    if (clearBtn) { clearBtn.disabled = true; }
    updateEmptyState();
    return;
  }

  if (typeof window.autoextract.getAppInfo === 'function') {
    window.autoextract.getAppInfo().then(function (info) {
      appInfo = info || null;
      updateStatusBar();
      initHistoryReveal();
    }).catch(function () {});
  }

  initFilterBar();

  let unsubscribe = null;

  // Seed the verify state from the encrypted history before the backlog
  // drains, so restored rows render their alive badges on the first pass.
  // If the preload predates the channel, the window simply starts with no
  // stored verification (same as today).
  const seedPromise = (typeof window.autoextract.getVerifyHistory === 'function'
    ? window.autoextract.getVerifyHistory()
    : Promise.resolve(null)
  ).then(function (stored) {
    if (stored && typeof stored === 'object') {
      Object.keys(stored).forEach(function (url) {
        const entry = stored[url];
        if (entry && typeof entry.checkedAt === 'number') {
          verifyState.set(url, {
            state: 'alive',
            code: entry.code === 2 || entry.code === 3 ? entry.code : null,
            checkedAt: entry.checkedAt
          });
        }
      });
    }
  }).catch(function () {});

  seedPromise.then(function () {
    return window.autoextract.getBacklog();
  })
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
      updateStatusBar();
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
      verifyState.clear();
      clearAutoVerifyTimers();
      // The persisted verify map is wiped by the same clearBacklog call
      // above: main's clear handler empties the payload store, verify map
      // included.
      refreshChipCounts();
      updateStatusBar();
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
