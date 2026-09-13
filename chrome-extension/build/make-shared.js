#!/usr/bin/env node
//
// chrome-extension/build/make-shared.js
//
// Copies the repo-level shared module into the extension package so the
// extension scripts can load it with a real relative path at runtime.
//
// Current extension script contract:
//   chrome.runtime.getURL('../shared/index.js')
//
// That path is correct when the final extension package contains this file at:
//   chrome-extension/shared/index.js
//
// This build step exists because the authoritative shared source lives in the
// repo root (shared/index.js), while the extension bundle is chrome-extension/.
// Without this copy, the relative path in content.js and popup.js would point
// at a file that is not inside the extension package.

'use strict';

const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..', '..');
const src = path.resolve(repoRoot, 'shared', 'index.js');
const destDir = path.resolve(__dirname, '..', 'shared');
const dest = path.resolve(destDir, 'index.js');

function copyFile(src, dest) {
  if (!fs.existsSync(src)) {
    console.error('AutoExtract build: shared source not found at', src);
    process.exitCode = 1;
    return;
  }

  fs.mkdirSync(destDir, { recursive: true });
  fs.copyFileSync(src, dest);
  console.log('AutoExtract build: copied shared/index.js ->', dest);
}

copyFile(src, dest);
