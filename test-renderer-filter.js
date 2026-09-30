#!/usr/bin/env node
//
// test-renderer-filter.js
//
// Hermetic tests for src/renderer/filter.js — the pure filtering logic used
// by the desktop window's search box and type-chip filters.
//
// The module under test is the exact file the renderer loads as a plain
// script (window.AutoExtractFilter); here it is required under plain Node
// through the same module.exports, so renderer behavior and tested behavior
// cannot drift.
//
// Coverage:
//   - normalizeQuery / canonicalState: trim, case-folding, non-string input
//   - canonicalTypes: invalid types dropped, all-selected collapses to null
//     (no filter), partial selection stays a subset, order follows TYPES
//   - hasActiveFilter: query only, types only, neither
//   - matchRecord, no filter active: passes with matchedLinkIndexes null
//   - link URL matching: case-insensitive substring, non-string URL excluded
//   - type filtering: only active types match; missing/unknown type counts
//     as 'other'; a type filter never matches via page text
//   - page text matching: pageTitle and pageUrl match the query, but only
//     when no type filter is active
//   - mixed cards: page-match-only cards show every link (no row hiding)
//     while link-matched cards expose exactly the matched row indexes
//   - typeCounts: per-type totals across records, unknown types -> 'other'
//   - countVisible: payload and link totals under query/type combinations
//   - robustness: null records, links missing entirely, null filter state
//
// No ports, no browser, no Electron, no DOM.
//
// Run: node test-renderer-filter.js  (also run by npm test and CI)
//

'use strict';

const path = require('path');

const filter = require(path.join(__dirname, 'src', 'renderer', 'filter.js'));

const PASS = [];
const FAIL = [];

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertDeepEqual(actual, expected, message) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) {
    throw new Error(message + ': expected ' + b + ', got ' + a);
  }
}

function makeRecord(links, pageTitle, pageUrl) {
  return {
    receivedAt: '2026-09-29T00:00:00.000Z',
    links: links,
    detected: null,
    sources: [],
    pageUrl: pageUrl || 'http://localhost:9999/test',
    pageTitle: pageTitle || 'Test Page'
  };
}

const TESTS = [
  // ---- query normalization -------------------------------------------------
  ['normalizeQuery trims and lowercases', () => {
    assert(filter.normalizeQuery('  BiLiBili  ') === 'bilibili', 'trim + lowercase');
    assert(filter.normalizeQuery('') === '', 'empty stays empty');
    assert(filter.normalizeQuery(null) === '', 'null -> empty');
    assert(filter.normalizeQuery(42) === '', 'non-string -> empty');
  }],

  // ---- canonical types ------------------------------------------------------
  ['canonicalTypes drops invalid entries and dedupes', () => {
    assertDeepEqual(filter.canonicalTypes(['video', 'video', 'nope', 7, null]), ['video'],
      'only valid types kept');
    assertDeepEqual(filter.canonicalTypes(['dash', 'audio']), ['audio', 'dash'],
      'output follows TYPES order, not input order');
    assert(filter.canonicalTypes('video') === null, 'non-array -> null');
    assert(filter.canonicalTypes(['nope']) === null, 'all-invalid -> null');
    assert(filter.canonicalTypes([]) === null, 'empty -> null');
  }],

  ['canonicalTypes collapses all-selected to no filter', () => {
    assert(filter.canonicalTypes(filter.TYPES) === null, 'all TYPES -> null');
    assert(filter.canonicalTypes(['other', 'video', 'audio', 'hls', 'dash', 'other']) === null,
      'all TYPES with dupes -> null');
  }],

  ['canonicalState normalizes both halves', () => {
    assertDeepEqual(filter.canonicalState(' HD ', ['video']), { query: 'hd', types: ['video'] },
      'query trimmed, types canonicalized');
    assertDeepEqual(filter.canonicalState('  ', []), { query: '', types: null },
      'blank query + empty selection -> no filter');
  }],

  // ---- hasActiveFilter -------------------------------------------------------
  ['hasActiveFilter reflects query/type presence', () => {
    assert(filter.hasActiveFilter(null) === false, 'null state is inactive');
    assert(filter.hasActiveFilter({ query: '', types: null }) === false, 'empty state inactive');
    assert(filter.hasActiveFilter({ query: 'hd', types: null }) === true, 'query alone active');
    assert(filter.hasActiveFilter({ query: '', types: ['video'] }) === true, 'types alone active');
  }],

  // ---- no filter active ------------------------------------------------------
  ['matchRecord with no active filter passes everything', () => {
    const record = makeRecord([{ type: 'video', url: 'http://x/a.mp4' }]);
    const noState = filter.matchRecord(record, { query: '', types: null });
    assert(noState.passes === true, 'passes');
    assert(noState.matchedLinkIndexes === null, 'indexes null (renderer shows all rows)');
    assert(filter.matchRecord(record, null).passes === true, 'null state passes');
  }],

  // ---- link URL matching -----------------------------------------------------
  ['link matching is a case-insensitive substring of the URL', () => {
    const record = makeRecord([
      { type: 'video', url: 'http://x/BigBuckBunny_1080p.MP4' },
      { type: 'audio', url: 'http://x/audio.m4a' }
    ]);
    const m = filter.matchRecord(record, filter.canonicalState('bigbuck', null));
    assert(m.passes === true, 'card passes');
    assertDeepEqual(m.matchedLinkIndexes, [0], 'only the matching link index');
  }],

  ['links without usable URLs never match a query', () => {
    const record = makeRecord([{ type: 'video', url: null }, { type: 'audio' }]);
    const m = filter.matchRecord(record, filter.canonicalState('mp4', null));
    assert(m.passes === false, 'nothing matches');
    assertDeepEqual(m.matchedLinkIndexes, [], 'no matched indexes');
  }],

  // ---- type filtering --------------------------------------------------------
  ['type filter keeps only active types', () => {
    const record = makeRecord([
      { type: 'video', url: 'http://x/v.mp4' },
      { type: 'audio', url: 'http://x/a.m4a' },
      { type: 'hls', url: 'http://x/i.m3u8' },
      { type: 'dash', url: 'http://x/i.mpd' },
      { type: 'weird', url: 'http://x/w.bin' }
    ]);
    const m = filter.matchRecord(record, filter.canonicalState('', ['video', 'dash']));
    assertDeepEqual(m.matchedLinkIndexes, [0, 3], 'video + dash kept');
  }],

  ['missing or unknown link types count as other', () => {
    const record = makeRecord([
      { url: 'http://x/no-type.mp4' },
      { type: 'mystery', url: 'http://x/mystery.bin' }
    ]);
    const other = filter.matchRecord(record, filter.canonicalState('', ['other']));
    assertDeepEqual(other.matchedLinkIndexes, [0, 1], 'both treated as other');
    const video = filter.matchRecord(record, filter.canonicalState('', ['video']));
    assert(video.passes === false, 'not video');
  }],

  ['a type filter never passes via page text', () => {
    const record = makeRecord(
      [{ type: 'audio', url: 'http://x/a.m4a' }],
      'HD trailer page',
      'http://x/trailer'
    );
    const m = filter.matchRecord(record, filter.canonicalState('trailer', ['video']));
    assert(m.passes === false, 'page text has no type, so it cannot match');
  }],

  // ---- page text matching ----------------------------------------------------
  ['page title and page URL match the query', () => {
    const byTitle = makeRecord([{ type: 'audio', url: 'http://x/a.m4a' }], 'Big Buck Bunny 4K');
    const titleM = filter.matchRecord(byTitle, filter.canonicalState('buck bunny', null));
    assert(titleM.passes === true, 'title match passes');
    assertDeepEqual(titleM.matchedLinkIndexes, [], 'no link matched (all rows shown)');

    const byUrl = makeRecord([{ type: 'audio', url: 'http://x/a.m4a' }], 'Unt.itled',
      'http://x/watch/BunnyTrailer');
    assert(filter.matchRecord(byUrl, filter.canonicalState('bunnytrailer', null)).passes === true,
      'pageUrl match passes');
  }],

  ['page text matching is inactive without a query', () => {
    const record = makeRecord([{ type: 'audio', url: 'http://x/a.m4a' }], 'Big Buck Bunny');
    const m = filter.matchRecord(record, filter.canonicalState('', ['audio']));
    assert(m.passes === true, 'passes via the type filter, not page text');
    assertDeepEqual(m.matchedLinkIndexes, [0], 'audio row matched');
  }],

  // ---- mixed cards -----------------------------------------------------------
  ['a card matched by page text shows every link; a card matched by link shows some', () => {
    const records = [
      makeRecord(
        [
          { type: 'video', url: 'http://x/v1.mp4' },
          { type: 'audio', url: 'http://x/a1.m4a' }
        ],
        'Trailer collection'
      ),
      makeRecord(
        [
          { type: 'video', url: 'http://x/other.mp4' },
          { type: 'video', url: 'http://x/trailer.mp4' }
        ],
        'Unrelated title'
      )
    ];
    const state = filter.canonicalState('trailer', null);

    const byTitle = filter.matchRecord(records[0], state);
    assert(byTitle.passes === true && byTitle.matchedLinkIndexes.length === 0,
      'title-only card: passes with zero indexes (show all rows)');

    const byLink = filter.matchRecord(records[1], state);
    assertDeepEqual(byLink.matchedLinkIndexes, [1], 'link card: only the matching row');
  }],

  // ---- typeCounts -------------------------------------------------------------
  ['typeCounts totals links per type with unknown as other', () => {
    const counts = filter.typeCounts([
      makeRecord([
        { type: 'video', url: 'a' },
        { type: 'video', url: 'b' },
        { type: 'audio', url: 'c' },
        { type: 'manifest-ish', url: 'd' }
      ]),
      makeRecord([{ type: 'hls', url: 'e' }]),
      null
    ]);
    assertDeepEqual(counts, { video: 2, audio: 1, hls: 1, dash: 0, other: 1 }, 'totals');
    assertDeepEqual(filter.typeCounts(null), { video: 0, audio: 0, hls: 0, dash: 0, other: 0 },
      'null records -> zero counts');
  }],

  // ---- countVisible -----------------------------------------------------------
  ['countVisible reports payload and link totals per state', () => {
    const records = [
      makeRecord(
        [
          { type: 'video', url: 'http://x/v1.mp4' },
          { type: 'video', url: 'http://x/v2.mp4' }
        ],
        'Video page'
      ),
      makeRecord([{ type: 'audio', url: 'http://x/a.m4a' }], 'Audio page'),
      makeRecord([{ type: 'hls', url: 'http://x/i.m3u8' }], 'Stream page')
    ];

    assertDeepEqual(filter.countVisible(records, filter.canonicalState('', null)),
      { payloads: 3, links: 4 }, 'no filter: everything visible');

    assertDeepEqual(filter.countVisible(records, filter.canonicalState('mp4', null)),
      { payloads: 1, links: 2 }, 'query: only the mp4 card');

    assertDeepEqual(filter.countVisible(records, filter.canonicalState('', ['video'])),
      { payloads: 1, links: 2 }, 'type filter: video card');

    assertDeepEqual(filter.countVisible(records, filter.canonicalState('stream', ['hls'])),
      { payloads: 0, links: 0 }, 'query + type that never combine: nothing visible');

    assertDeepEqual(filter.countVisible(records, filter.canonicalState('stream', null)),
      { payloads: 1, links: 1 }, 'page-text match counts every row of the card as visible');
  }],

  // ---- robustness ---------------------------------------------------------------
  ['odd records never crash the filter', () => {
    const state = filter.canonicalState('mp4', null);
    assert(filter.matchRecord(null, state).passes === false, 'null record does not pass');
    assert(filter.matchRecord({}, state).passes === false, 'record without links does not pass');
    assert(filter.matchRecord({ links: 'nope' }, state).passes === false, 'links not an array');
    assert(filter.matchRecord({ links: [null, 'str', { url: 'http://x.mp4' }] }, state).passes === true,
      'junk link entries are skipped, good ones still match');
    assert(filter.countVisible([null, undefined], state).payloads === 0, 'countVisible tolerates junk');
  }]
];

// Sequential async runner, matching the repo's other suites.
async function runTests(tests) {
  for (const entry of tests) {
    const name = entry[0];
    const fn = entry[1];
    try {
      await fn();
      PASS.push(name);
      console.log('  PASS  ' + name);
    } catch (error) {
      FAIL.push({ name: name, error: error });
      console.log('  FAIL  ' + name);
      console.log('        ' + (error && error.message ? error.message : String(error)));
    }
  }
}

console.log('\n== renderer filter (src/renderer/filter.js) ==');

runTests(TESTS).then(() => {
  console.log('\nResults: ' + PASS.length + ' passed, ' + FAIL.length + ' failed');
  if (FAIL.length > 0) {
    process.exit(1);
  }
}).catch((error) => {
  console.error('test harness crashed:', error && error.stack ? error.stack : error);
  process.exit(1);
});
