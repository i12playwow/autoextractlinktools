#!/usr/bin/env node
// package-extension-for-chrome.js
// Copies the chrome-extension/ directory and its shared build outputs into a
// separate unpacked-extension layout that Chrome can load directly.
'use strict';

const fs = require('fs');
const path = require('path');

const source = path.resolve(__dirname, 'chrome-extension');
const dest = path.resolve(__dirname, 'chrome-extension-packed');

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

if (fs.existsSync(dest)) {
  fs.rmSync(dest, { recursive: true, force: true });
}

copyDir(source, dest);

console.log('Packed unpacked extension ->', dest);
console.log('Manifest:', path.join(dest, 'manifest.json'));
