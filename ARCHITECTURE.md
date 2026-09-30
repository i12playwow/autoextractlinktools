# Architecture

## Primary runtime model

This project is an **Electron desktop app with a Chrome extension bridge** and an **optional userscript path** that shares extraction logic with the extension.

The core job of the system is to detect supported video player setups on a page and surface the associated direct media/download links. The desktop app is the local hub; the extension and userscript are page-injection front ends that feed links into it.

## Components

### Desktop app (Electron)

- The local host process for the system.
- Owns the long-lived listener that the extension and userscript talk to.
- Provides whatever local UI, status, and persistence the product eventually needs.
- Should not be responsible for page scraping directly; page-level extraction happens in browser-side code.

### Chrome extension

- Runs in the browser as a content script and popup.
- Detects supported sites/players on the active tab.
- Extracts links from the page DOM and player state accessible to content scripts.
- Stores results in `chrome.storage.local` keyed by active tab id.
- Each stored entry includes the page URL and title so later reads can tell whether the stored results are still current.
- The popup reads those stored results and presents them to the user.
- If nothing has been stored yet for the active tab, the popup shows an explicit "not run yet" state instead of pretending links were found.
- If stored results belong to a different page URL, the popup treats them as stale and asks for re-detection.
- The popup forwards the currently loaded results to the desktop app when the user clicks send.

Current scaffold state:
  - `shared/index.js` is the authoritative shared module for the extension.
  - `content.js` and `popup.js` load it as a script via
    `chrome.runtime.getURL('../shared/index.js')` instead of duplicating it.
  - The extension build step copies that shared module into the extension
    package at `chrome-extension/shared/index.js` so the relative path becomes
    real at runtime.
  - The manifest now declares `shared/index.js` as part of the content script
    loading order.
  - The manifest restricts content script matches to a small explicit host
    list instead of `<all_urls>`.
  - The popup UI expects `#status`, `#no-data`, `#not-run`, `#links`, `#count-badge`,
    `#copy-btn`, `#idm-btn`, `#send-btn`, and `#detect-btn`.
  - The popup no longer runs extraction locally; it relies on results previously
    stored by the content script for the active tab.
  - IDM behavior is intentionally represented as an integration point but is not implemented yet.

### Userscript

- An alternative page-injection path for people who prefer a script manager or do not want the extension.
- Uses the same shared extraction logic as the extension where practical.
- Can forward links to the same desktop app when it is reachable.

### Shared extraction module

- A single shared package in the repo for detection and extraction behavior that both the extension and userscript should reuse.
- Keeps site/player-specific parsing in one place instead of copying it across injection runtimes.

## Responsibilities and boundaries

- **Browser-side code owns extraction.** Detection and parsing of page state and player links should live in the extension and/or userscript, using the shared module.
- **Desktop app owns the local service and coordination.** It hosts the bridge endpoint and any local state, queues, or downstream integrations the product wants.
- **Extension and userscript should remain thin wrappers around the shared module.** They should differ mainly in how they are deployed and how they communicate back to the desktop app.
- **Don’t mix deployment models.** The extension, userscript, and desktop app are separate runtimes. Shared logic is fine; duplicated copies of site-specific behavior are not.

## Build and packaging

### Shared module layout

- The authoritative shared source lives at the repo root in `shared/index.js`.
- The extension cannot load that file at runtime through a repo-root path.
- The extension build step `chrome-extension/build/make-shared.js` copies the
  shared module into the extension package so it becomes a real extension
  resource at `chrome-extension/shared/index.js`.
- After that copy, `content.js` and `popup.js` load the shared module with
  `chrome.runtime.getURL('../shared/index.js')`, which is correct because the
  build places the file beside the extension scripts.

### What is source and what is generated

- Source of truth: `shared/index.js`.
- Build step: `chrome-extension/build/make-shared.js`.
- Generated output: `chrome-extension/shared/index.js`.
- The generated output should be treated as build artifact, not hand-edited
  extension source. If the layout or path ever changes, update the build script
  and manifest together, not the generated file in isolation.

### Current commands

- `npm run build:extension` — copies the shared module into the extension package.
- `npm run clean:extension` — removes the generated `chrome-extension/shared/` layout.

## Communication path

- Browser-side code sends extracted links to the desktop app over localhost HTTP when the app is reachable.
- The desktop app is the intended recipient for forwarded links from both the extension and the userscript.
- If the desktop app is not reachable, browser-side code should degrade predictably instead of failing silently or pretending the send succeeded.

## Desktop bridge contract

- The bridge listens on `127.0.0.1:3456` by default.
- It accepts `POST /` with a JSON payload.
- Payloads must be objects with a `links` array, where each link has a non-empty
  string `url`. That validates the shape important to the core feature without
  being overly strict about optional metadata.
- Error responses are kept minimal and consistent: `404` for wrong method/path,
  `400` for invalid JSON or invalid payload shape, and `503` once shutdown has
  started.
- The bridge logs only a summarized view of the payload by default, not the full
  raw body, so noisy metadata does not inflate logs.
- Shutdown is handled once, in the `will-quit` handler. `window-all-closed` is
  kept only as an explicit lifecycle note for non-macOS.
- The desktop window (`src/renderer/`, loaded via a sandboxed, context-isolated
  preload) shows a live list of received payloads. Valid payloads are recorded
  into a bounded backlog (last 200) and broadcast over IPC on the
  `autoextract:payload` channel; the renderer pulls the backlog on load so
  history that predates the window is visible, dedupes by `receivedAt`, and can
  clear the backlog over `autoextract:clearBacklog`.
- Link rows are actionable: each row has Copy and Open buttons (Copy is also
  available by clicking the URL). Copy uses the DOM Clipboard API with an
  `execCommand` fallback. Open asks the main process over
  `autoextract:openExternal`, where the URL is re-validated by an http/https
  allowlist (`isSafeExternalUrl`) before `shell.openExternal` is called, so no
  other scheme can reach the operating system; the renderer cannot bypass this
  because the sandboxed preload is the only IPC surface.
- Per-row link verification: each row has a check button that asks the main
  process over `autoextract:verifyUrl` to probe the URL with a HEAD request
  (one-shot GET fallback for servers that answer HEAD with a transport error
  or 405/501, bounded redirect chain with every hop re-validated through
  `isSafeExternalUrl`, cycle detection, 15s timeout). The renderer never
  touches the network. Only successes are stored — HTTP >= 400 and transport
  failures render a transient `dead` badge plus a note that the next
  re-render clears, so a transient blip can never permanently brand a row —
  while a success marks the row `alive` with a last-verified age ("verified
  4 mins ago") in the badge title. The display rules (canonicalization, the
  60s recheck lock, label buckets, staleness) are pure functions in
  `src/renderer/verify.js`, loaded as a CSP-safe script and unit-tested
  under Node by `test-renderer-verify.js`; the probe itself is unit-tested
  with scripted fetches plus one real loopback-server round trip in the
  bridge edge-case suite.
- Verification persistence and auto-verify: every successful probe is
  reported over `autoextract:recordVerify` and stored — alive-only and
  canonicalized through the shared pure module — in a bounded verify map
  inside the same encrypted history document (cleared with the history,
  absent for legacy v1 files, re-validated on load). The renderer pulls the
  map over `autoextract:getVerifyHistory` before the backlog drains, so
  restored rows show their last-verified badges immediately after a restart
  without re-probing. Live payloads also schedule a silent background pass
  (4s out, staggered) through the same guards; background failures change
  nothing on screen — only the explicit check button can mark a row dead.
- Footer status bar: a monospace strip along the bottom of the window shows
  the bridge endpoint (`host:port`), the history file path (both supplied by
  the main process over `autoextract:getAppInfo`, read-only strings), and
  the current payload count with a live per-type link breakdown ("2 payloads
  · 12 video · 3 hls", zero types omitted, formatted by the pure
  `formatTypeCounts` in `src/renderer/filter.js` so the chips and the footer
  share one source of truth), which the renderer tracks from its own records
  and updates on every payload and on Clear. Clicking the history path asks
  main over the argument-less `autoextract:revealHistoryFolder` channel to
  `shell.showItemInFolder` the file — main uses its own stored path, so no
  `file:` URL ever crosses IPC and the http/https-only `openExternal`
  allowlist stays untouched.
- Filtering in the window: a search box matches link URLs and page titles/URLs
  case-insensitively, and type chips (video/audio/hls/dash/other, with live
  per-type counts) narrow which link rows are shown. The matching rules are
  pure functions in `src/renderer/filter.js` — a card matched through a link
  shows only the matching rows, a card matched through page text shows all its
  rows, and a type filter never lets page text pass. The logic is loaded as a
  plain CSP-safe script (`window.AutoExtractFilter`) and unit-tested under
  Node by `test-renderer-filter.js`; if it ever fails to load, the renderer
  falls back to showing everything (legacy behavior).
- Persistence: the same backlog is mirrored to a JSON file
  (`<userData>/autoextract-history.json`, override with `AUTOEXTRACT_DATA_DIR`)
  via `src/storage.js`. The file is **encrypted at rest**: v2 envelopes carry
  AES-256-GCM ciphertext with a fresh 96-bit nonce per flush. The key is
  managed by Electron `safeStorage` (OS keystore: DPAPI/Keychain/libsecret)
  when available, falling back to a random key in a 0600 sidecar keyfile
  otherwise. Legacy v1 plaintext files load and upgrade to encrypted v2 on
  the next flush. Tampered ciphertext is rejected as "no history" (same
  policy as corruption). Writes are debounced and atomic (tmp file + rename,
  with a bounded rename retry and copy fallback for Windows file-locking
  flakes); loads are tolerant. The bridge and window start only after history
  is loaded, so an early POST cannot be clobbered by the file contents; a
  final synchronous flush runs in `will-quit`. Clearing the list also clears
  the file. The bound (200) applies to both memory and disk.

## Extension scope and storage

- Content scripts run only on the explicit host matches defined in the manifest.
- Storage is scoped per active tab id.
- Stored entries carry `pageUrl` and `pageTitle` so the popup can identify stale
  results from other pages.

## Out of scope for now

- Site-by-site extraction rules beyond YouTube, Bilibili, and Vimeo. The shared
  module implements a YouTube rule (inline `ytInitialPlayerResponse` parsing,
  formats, adaptiveFormats, HLS/DASH manifests; ciphered formats are counted
  but never emitted), a Bilibili rule (inline `window.__playinfo__` parsing,
  DASH video/audio plus dolby/flac extras and legacy durl files, quality
  labels, codecs, bitrates), a Vimeo rule (inline `window.playerConfig`
  parsing: progressive files with quality/container/size metadata and HLS/DASH
  manifest bundles emitted via their default CDN — other CDNs are counted as
  alternates, not listed; works on both vimeo.com and player.vimeo.com), plus
  a generic fallback scan.
- YouTube signatureCipher deciphering, which would require fetching and
  evaluating player code that changes across player releases.
- Any specific download manager integration, including IDM-style behavior, until that is explicitly in scope.
- End-to-end automation flows beyond what is necessary to demonstrate detection and link forwarding.

## Notes and open decisions

- The popup UI already assumes link results, copy JSON, and a “send to desktop” action, so the extension surface is partially defined even though the implementation is not present yet.
- Extension resources like content scripts and popup scripts still need to exist and be wired up.
- The extension manifest currently scopes communication to `http://localhost:3456/*`. If the desktop app uses a different port or scheme, update both the manifest and the desktop app together.
- The shared module is currently copied into the extension package rather than bundled. If more shared files are added later, revisit whether a real bundler or packaging step is warranted.
