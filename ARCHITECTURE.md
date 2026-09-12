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
- Presents results in the popup and forwards selected links to the desktop app.

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

## Communication path

- Browser-side code sends extracted links to the desktop app over localhost HTTP when the app is reachable.
- The desktop app is the intended recipient for forwarded links from both the extension and the userscript.
- If the desktop app is not reachable, browser-side code should degrade predictably instead of failing silently or pretending the send succeeded.

## Out of scope for now

- Site-by-site extraction rule implementation.
- Any specific download manager integration, including IDM-style behavior, until that is explicitly in scope.
- End-to-end automation flows beyond what is necessary to demonstrate detection and link forwarding.

## Notes and open decisions

- The popup UI already assumes link results, copy JSON, and a “send to desktop” action, so the extension surface is partially defined even though the implementation is not present yet.
- Extension resources like content scripts and popup scripts still need to exist and be wired up.
- The extension manifest currently scopes communication to `http://localhost:3456/*`. If the desktop app uses a different port or scheme, update both the manifest and the desktop app together.
