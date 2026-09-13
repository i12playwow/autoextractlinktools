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

## Extension scope and storage

- Content scripts run only on the explicit host matches defined in the manifest.
- Storage is scoped per active tab id.
- Stored entries carry `pageUrl` and `pageTitle` so the popup can identify stale
  results from other pages.

## Out of scope for now

- Site-by-site extraction rule implementation.
- Any specific download manager integration, including IDM-style behavior, until that is explicitly in scope.
- End-to-end automation flows beyond what is necessary to demonstrate detection and link forwarding.

## Notes and open decisions

- The popup UI already assumes link results, copy JSON, and a “send to desktop” action, so the extension surface is partially defined even though the implementation is not present yet.
- Extension resources like content scripts and popup scripts still need to exist and be wired up.
- The extension manifest currently scopes communication to `http://localhost:3456/*`. If the desktop app uses a different port or scheme, update both the manifest and the desktop app together.
- The shared module is currently copied into the extension package rather than bundled. If more shared files are added later, revisit whether a real bundler or packaging step is warranted.
