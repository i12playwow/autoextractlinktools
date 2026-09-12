#!/usr/bin/env node
//
// bin/autoextract.js
//
// CLI entrypoint for autoextractlinktools.
//
// This file is intentionally a minimal scaffold. It gives the repo a usable
// binary entry point before any real CLI behavior is implemented.
//
// Current behavior:
//   - Exposes a small command skeleton via Commander.
//   - Prints usage and exits unless a command is implemented.
//
// TODO:
//   - Implement actual commands (for example: run a headless extraction,
//     start the desktop app, or invoke a specific extraction flow).
//   - Decide how this CLI relates to the Electron desktop app. If the desktop
//     app is the main target, keep CLI commands narrowly focused and documented.

'use strict';

const { Command } = require('commander');

const program = new Command();

program
  .name('autoextract')
  .description('AutoExtract Link Tools CLI (scaffold)')
  .version('1.0.0');

program
  .command('extract')
  .description('Extract video links from a target (not implemented)')
  .action(() => {
    console.error('The "extract" command is not implemented yet.');
    process.exit(1);
  });

program
  .command('start')
  .description('Start the desktop app (not implemented)')
  .action(() => {
    console.error('The "start" command is not implemented yet.');
    process.exit(1);
  });

program.parse();

if (!process.argv.slice(2).length) {
  program.outputHelp();
}
