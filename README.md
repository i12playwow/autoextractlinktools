# autoextractlinktools

Extract video links from multi-tab video player interfaces via headless browser automation.

An Electron desktop app with a Chrome extension bridge, plus an optional userscript path, for extracting video player links and forwarding them to the local desktop app.

Project identity metadata lives in `.freebuff/project-id` and is intentionally left untracked in version control.

## Current components

- `src/main.js` — Electron desktop app; runs the localhost HTTP bridge (default `127.0.0.1:3456`) that accepts `POST /` JSON payloads of extracted links, keeps a bounded backlog backed by a JSON history file (`<userData>/autoextract-history.json`, override with `AUTOEXTRACT_DATA_DIR`), and broadcasts each payload to the renderer window.
- `src/renderer/` + `src/preload.js` — minimal window showing a live list of received links (page title/url, per-link type chips and metadata, Clear button). Context-isolated with a sandboxed preload; history that arrived before the window opened is shown via a backlog pull.
- `shared/index.js` — shared detection/extraction logic used by the extension and the userscript. Implements three modes in precedence order: the `[data-autoextract]` stub contract (for tests), a YouTube site rule (parses the inline `ytInitialPlayerResponse` for formats, adaptive formats, and HLS/DASH manifests), and a generic media scan (`<video>`/`<audio>`/`<source>` elements and media-file anchors) as fallback on any page.
- `chrome-extension/` — MV3 extension: `background.js` (service worker that forwards links to the desktop bridge and resolves tab ids), `content.js` (detection, per-tab storage, auto-forward), `popup.html`/`popup.js` (results UI with copy/send actions), `manifest.json`.
- `userscript/autoextract.js` — alternative page-injection path with the same detection logic inlined; forwards to the desktop bridge directly.
- `bin/autoextract.js` — CLI. `autoextract extract <url>` runs a headless Chromium-based browser (Chrome/Edge/Brave, or `--browser <path>`), injects the shared module into the page, and prints the found links; `--json` for machine-readable output, `--send` to forward to the desktop bridge. `autoextract start` launches the desktop app.
- `test-pages/` — local pages that exercise the `[data-autoextract]` stub contract.

## Development

```sh
npm install          # install dependencies (Electron included)
npm run desktop      # start the desktop app and its bridge
npm test             # contract + detection/YouTube + bridge edge-case suites
node run-desktop-bridge.js   # end-to-end smoke test of the real Electron bridge
```

Extension copies: `npm run build:extension` refreshes `chrome-extension/shared/`;
`node package-extension-for-chrome.js` regenerates `chrome-extension-packed/`.
`chrome-extension-unpacked/` and `chrome-extension-packed/` are loadable copies
of `chrome-extension/` for `chrome://extensions` → "Load unpacked".

### CLI extraction

```sh
node bin/autoextract.js extract https://example.com/video-page   # human-readable list
node bin/autoextract.js extract <url>... --json                  # machine-readable payload(s)
node bin/autoextract.js extract <url>... --send                  # also forward every payload to the desktop bridge
node bin/autoextract.js extract <url1> <url2> <url3> --send      # batch: one browser, per-URL results
node bin/autoextract.js extract <url> --browser "C:\path\to\chrome.exe"
node bin/autoextract.js start                                    # launch the desktop app
```

Batch mode opens each URL in its own tab of one headless browser (default
concurrency 3, tune with `--concurrency`), keeps results in input order, and
isolates failures: one dead URL never aborts the batch. `--json` emits
`{ ok, results: [{ url, ok, payload | error, bridgeResult? }] }`. `--send`
forwards every successful extraction to the bridge as its tab finishes.

Exit codes: `0` links found (batch: all URLs ok), `3` none found (unless
`--allow-empty`), `2` no browser found, `1` extraction failure (batch: any
failed URL).

See `ARCHITECTURE.md` for the bridge contract and design decisions.
