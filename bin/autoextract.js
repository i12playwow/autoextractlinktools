#!/usr/bin/env node
//
// bin/autoextract.js
//
// CLI entrypoint for autoextractlinktools.
//
// Commands:
//   autoextract extract <url>...   Headless-extract video/audio links from one
//                                  or more pages and print them; with --send,
//                                  every payload is forwarded to the desktop
//                                  bridge (one browser launch for the batch).
//   autoextract start              Launch the Electron desktop app (bridge +
//                                  link-list window).
//
// Exit codes (single URL / batch):
//   0 - success: links found on at least the required set
//       (batch: all URLs with links unless --allow-empty relaxes empty ones;
//        failed URLs always force 1)
//   1 - general failure (launch, navigation, extraction, any failed URL)
//   2 - no Chromium-based browser found
//   3 - no links found (single URL, or every batch URL empty) without --allow-empty
//
// Note: puppeteer-core ships no browser; the CLI looks for Chrome, Edge, or
// Brave (or use --browser <path>).

'use strict';

const path = require('path');
const { Command } = require('commander');
const {
  resolveBrowser,
  launchAndExtract,
  launchAndExtractBatch,
  sendToBridge,
  DEFAULT_DESKTOP_URL
} = require('../lib/headless-extract');

const program = new Command();

program
  .name('autoextract')
  .description('AutoExtract Link Tools CLI')
  .version('1.0.0');

function printLinkList(links, indent) {
  const pad = indent || '  ';
  links.forEach(function (link, index) {
    const meta = [];
    if (link.quality) { meta.push(link.quality); }
    if (link.container) { meta.push(link.container); }
    if (link.itag) { meta.push('itag ' + link.itag); }
    const label = [link.type, link.server].filter(Boolean).join('/');
    const metaSuffix = meta.length > 0 ? ' (' + meta.join(', ') + ')' : '';
    console.log(pad + '[' + (index + 1) + '] ' + label + metaSuffix);
    console.log(pad + '    ' + link.url);
  });
}

// Batch exit semantics:
//   - any failed URL -> 1 (a requested extraction did not happen)
//   - otherwise, all URLs empty -> 3 (or 0 with --allow-empty)
//   - otherwise 0
function computeBatchExitCode(results, allowEmpty) {
  const failed = results.some(function (entry) { return !entry.ok; });
  if (failed) {
    return 1;
  }
  const anyLinks = results.some(function (entry) {
    return entry.ok && entry.payload && entry.payload.links && entry.payload.links.length > 0;
  });
  return anyLinks ? 0 : (allowEmpty ? 0 : 3);
}

program
  .command('extract')
  .description('Extract video/audio links from one or more pages using a headless browser')
  .argument('<urls...>', 'page URL(s) to extract links from')
  .option('--json', 'output machine-readable JSON', false)
  .option('--send', 'also POST each payload to the desktop bridge', false)
  .option('--browser <path>', 'path to a Chromium-based browser executable')
  .option('--timeout <ms>', 'page load timeout in milliseconds', parseInt)
  .option('--settle <ms>', 'extra wait after page load for dynamic players', parseInt)
  .option('--concurrency <n>', 'max simultaneous tabs for multiple URLs', parseInt)
  .option('--desktop-url <url>', 'desktop bridge URL when using --send', DEFAULT_DESKTOP_URL)
  .option('--allow-empty', 'exit 0 even when no links are found', false)
  .action(async function (urls, options) {
    const jsonOut = !!options.json;
    const log = function (message) {
      // Progress goes to stderr in both modes so stdout stays parseable.
      if (typeof message === 'string') {
        console.error(message);
      }
    };

    const resolution = resolveBrowser(options.browser);
    if (!resolution) {
      if (jsonOut) {
        console.log(JSON.stringify({ ok: false, code: 'NO_BROWSER', error: 'no Chromium-based browser found (tried Chrome, Edge, Brave; use --browser <path>)' }));
      } else {
        console.error('AutoExtract: no Chromium-based browser found.');
        console.error('Tried Chrome, Edge, and Brave in their default locations.');
        console.error('Use --browser <path> to point at a specific executable.');
      }
      process.exitCode = 2;
      return;
    }

    const batch = urls.length > 1;
    const noLinksExit = options.allowEmpty ? 0 : 3;

    if (!batch) {
      // -------- single URL: per-URL contract --------
      let payload;
      try {
        payload = await launchAndExtract({
          url: urls[0],
          executablePath: resolution.executablePath,
          timeoutMs: options.timeout || undefined,
          settleMs: typeof options.settle === 'number' ? options.settle : undefined,
          onLog: log
        });
      } catch (error) {
        if (jsonOut) {
          console.log(JSON.stringify({ ok: false, code: 'EXTRACT_FAILED', error: error && error.message ? error.message : String(error) }));
        } else {
          console.error('AutoExtract: extraction failed.', error && error.message ? error.message : error);
        }
        process.exitCode = 1;
        return;
      }

      if (options.send) {
        log('AutoExtract: sending to desktop bridge at ' + options.desktopUrl + '...');
        const result = await sendToBridge(payload, options.desktopUrl);
        payload.bridgeResult = result;
        if (!result.ok && !jsonOut) {
          console.error('AutoExtract: bridge not reachable (' + (result.error || 'HTTP ' + result.status) + '); extraction results below.');
        }
        // Bridge failure downgrades to a warning, not an error: extraction
        // itself succeeded, so links are still printed and exit stays 0/3.
      }

      if (jsonOut) {
        // ok:true mirrors the error shape ({ ok:false, code, error }); exit
        // status conveys the no-links nuance (3 without --allow-empty).
        console.log(JSON.stringify(Object.assign({ ok: true }, payload), null, 2));
      } else if (payload.links.length === 0) {
        console.error('AutoExtract: no links found on ' + urls[0]);
        process.exitCode = noLinksExit;
        return;
      } else {
        console.log('Found ' + payload.links.length + ' link(s) on ' + payload.pageUrl + (payload.pageTitle ? ' — ' + payload.pageTitle : ''));
        printLinkList(payload.links);
        if (payload.bridgeResult) {
          console.log('');
          console.log('Forwarded to desktop bridge: ' + (payload.bridgeResult.ok ? 'ok' : 'FAILED'));
        }
      }
      process.exitCode = payload.links.length > 0 ? 0 : noLinksExit;
      return;
    }

    // -------- multiple URLs: one browser launch, per-URL isolation --------
    let batchOutcome;
    try {
      const pendingSends = [];

      batchOutcome = await launchAndExtractBatch({
        urls: urls,
        executablePath: resolution.executablePath,
        timeoutMs: options.timeout || undefined,
        settleMs: typeof options.settle === 'number' ? options.settle : undefined,
        concurrency: typeof options.concurrency === 'number' ? options.concurrency : undefined,
        onLog: log,
        onResult: options.send ? function (entry) {
          // Forward each payload as its tab finishes; failed URLs are
          // recorded, never sent.
          if (entry.ok) {
            pendingSends.push(
              sendToBridge(entry.payload, options.desktopUrl).then(function (bridgeResult) {
                entry.bridgeResult = bridgeResult;
              })
            );
          }
        } : undefined
      });

      if (pendingSends.length > 0) {
        await Promise.all(pendingSends);
      }
    } catch (error) {
      // Only pre-launch failures throw (missing urls / no browser).
      const isNoBrowser = !!(error && error.code === 'NO_BROWSER');
      if (jsonOut) {
        console.log(JSON.stringify({ ok: false, code: isNoBrowser ? 'NO_BROWSER' : 'EXTRACT_FAILED', error: error && error.message ? error.message : String(error) }));
      } else {
        console.error('AutoExtract: batch extraction failed.', error && error.message ? error.message : error);
      }
      process.exitCode = isNoBrowser ? 2 : 1;
      return;
    }

    const results = batchOutcome.results;
    const anyLinks = results.some(function (entry) {
      return entry.ok && entry.payload && entry.payload.links && entry.payload.links.length > 0;
    });

    if (jsonOut) {
      // ok mirrors "did we get anything"; per-URL detail is in results.
      console.log(JSON.stringify({ ok: anyLinks, results: results }, null, 2));
    } else {
      let found = 0;
      results.forEach(function (entry, index) {
        if (index > 0) {
          console.log('');
        }
        console.log('[' + (index + 1) + '] ' + entry.url);
        if (!entry.ok) {
          console.log('    FAILED: ' + entry.error);
          return;
        }
        if (entry.payload.links.length === 0) {
          console.log('    no links found');
          return;
        }
        found++;
        console.log('    Found ' + entry.payload.links.length + ' link(s)' + (entry.payload.pageTitle ? ' — ' + entry.payload.pageTitle : ''));
        printLinkList(entry.payload.links, '    ');
        if (entry.bridgeResult) {
          console.log('    Forwarded to desktop bridge: ' + (entry.bridgeResult.ok ? 'ok' : 'FAILED'));
        }
      });
      console.log('');
      console.log('Batch: ' + found + '/' + urls.length + ' url(s) with links');
    }

    process.exitCode = computeBatchExitCode(results, options.allowEmpty);
  });

program
  .command('start')
  .description('Start the Electron desktop app (bridge + link-list window)')
  .action(function () {
    const electronCli = path.join(__dirname, '..', 'node_modules', 'electron', 'cli.js');
    const { spawn } = require('child_process');
    const child = spawn(process.execPath, [electronCli, path.join(__dirname, '..', 'src', 'main.js')], {
      cwd: path.join(__dirname, '..'),
      stdio: 'inherit'
    });
    child.on('exit', function (code) {
      process.exitCode = code === null ? 1 : code;
    });
  });

program.parse();
