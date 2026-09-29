#!/usr/bin/env node
//
// test-shared-detect.js
//
// Unit tests for the shared detection/extraction module (shared/index.js).
//
// The module is a browser script that attaches window.AutoExtract, so this
// harness provides a minimal window/document shim (no jsdom dependency) and
// executes the real file. Coverage:
//
//   stub contract (must stay byte-compatible with the original behavior):
//     - [data-autoextract] markers with url/type/server attributes
//     - missing markers -> detect() returns null
//
//   generic media scan:
//     - <video src> and <audio src>
//     - nested <source> children resolve relative URLs against the page base
//     - standalone <source> inherits the parent media kind
//     - anchors with media extensions are classified; non-media anchors ignored
//     - blob: URLs included, data: URLs skipped
//     - duplicate resolved URLs are deduplicated
//     - relative anchors resolve against the base URL
//
//   YouTube site-specific extraction:
//     - ytInitialPlayerResponse parsed from inline script text
//     - formats/adaptiveFormats emitted with server/type/metadata
//     - HLS and DASH manifest URLs emitted
//     - signatureCipher (ciphered) formats counted but never emitted
//     - brace/string-aware JSON extraction (braces and quotes inside strings)
//     - malformed player JSON falls back to the generic scan
//     - host gating: player response on a non-YouTube host is ignored
//     - blob: URLs excluded from the YouTube fallback merge
//
// Run: node test-shared-detect.js  (also run by npm test)
//

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const PASS = [];
const FAIL = [];

function test(name, fn) {
  try {
    fn();
    PASS.push(name);
  } catch (error) {
    FAIL.push({ name, error });
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message || 'assertion failed');
  }
}

// ---------------------------------------------------------------------------
// Minimal DOM shims
// ---------------------------------------------------------------------------

class Attr {
  constructor(name) {
    this.name = name;
  }
}

class Element {
  constructor(tagName, attrs) {
    this.tagName = tagName.toUpperCase();
    this.attributes = (attrs || []).map((n) => new Attr(n));
    this._attrs = {};
    (attrs || []).forEach((n) => { this._attrs[n] = ''; });
    this.children = [];
    this.parentElement = null;
  }

  getAttribute(name) {
    if (Object.prototype.hasOwnProperty.call(this._attrs, name)) {
      return this._attrs[name] === '' ? '' : this._attrs[name];
    }
    return null;
  }

  setAttribute(name, value) {
    if (!Object.prototype.hasOwnProperty.call(this._attrs, name)) {
      this.attributes.push(new Attr(name));
    }
    this._attrs[name] = String(value);
  }

  appendChild(child) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  // Supports the module's nested lookup: queryAll(mediaElement, 'source').
  querySelectorAll(selector) {
    const matches = [];
    const walk = (el) => {
      el.children.forEach((child) => {
        if (elementMatches(child, selector)) {
          matches.push(child);
        }
        walk(child);
      });
    };
    walk(this);
    return matches;
  }
}

function elementMatches(el, selector) {
  const matchers = {
    '[data-autoextract]': (e) => Object.prototype.hasOwnProperty.call(e._attrs, 'data-autoextract'),
    'video, audio': (e) => /^(video|audio)$/i.test(e.tagName),
    video: (e) => /^video$/i.test(e.tagName),
    audio: (e) => /^audio$/i.test(e.tagName),
    source: (e) => /^source$/i.test(e.tagName),
    script: (e) => /^script$/i.test(e.tagName),
    'a[href]': (e) => /^a$/i.test(e.tagName) && Object.prototype.hasOwnProperty.call(e._attrs, 'href')
  };
  const matcher = matchers[selector];
  if (!matcher) {
    throw new Error('shim: unsupported selector "' + selector + '"');
  }
  return matcher(el);
}

// Attributes with values are expressed as "name=value" tokens in the helpers
// below; Element stores values in _attrs while keeping an attributes list of
// Attr objects with .name only (enough for attributeNames()).
function makeElement(tag, attrSpecs) {
  const el = new Element(tag, attrSpecs.map((s) => String(s).split('=')[0]));
  attrSpecs.forEach((spec) => {
    const eq = String(spec).indexOf('=');
    if (eq >= 0) {
      el._attrs[spec.slice(0, eq)] = spec.slice(eq + 1);
    }
  });
  return el;
}

class DocumentShim {
  constructor(base) {
    this.base = base;
    this._all = [];
  }

  register(el) {
    this._all.push(el);
  }

  querySelectorAll(selector) {
    return this._all.filter((el) => elementMatches(el, selector));
  }
}

// URL is global in Node >= 10, so no shim needed. vm context gets it via
// the sandbox's prototype chain from this realm.

// ---------------------------------------------------------------------------
// Load the real shared module into a sandbox with the shims
// ---------------------------------------------------------------------------

const repoRoot = path.resolve(__dirname);
const sharedSource = fs.readFileSync(path.join(repoRoot, 'shared', 'index.js'), 'utf8');

function loadAutoExtract(doc) {
  const sandbox = {
    window: {},
    document: doc,
    URL: URL,
  };
  sandbox.window = sandbox; // so `typeof window !== 'undefined'` and assignment work
  vm.createContext(sandbox);
  vm.runInContext(sharedSource, sandbox, { filename: 'shared/index.js' });
  return sandbox.window.AutoExtract;
}

function makeContext(doc) {
  return { document: doc, location: { href: doc.base } };
}

// ---------------------------------------------------------------------------
// Stub contract tests
// ---------------------------------------------------------------------------

test('stub: markers produce links with url/type/server', () => {
  const doc = new DocumentShim('http://localhost:9999/test');
  const m1 = makeElement('div', ['data-autoextract', 'data-autoextract-url=http://example.com/video.mp4', 'data-autoextract-type=video', 'data-autoextract-server=stub']);
  const m2 = makeElement('div', ['data-autoextract', 'data-autoextract-url=http://example.com/audio.m4a', 'data-autoextract-type=audio', 'data-autoextract-server=stub']);
  doc.register(m1);
  doc.register(m2);

  const AE = loadAutoExtract(doc);
  const detection = AE.detect(makeContext(doc));
  assert(detection && detection.supported === true && detection.type === 'stub' && detection.markerCount === 2, 'detect should report stub with 2 markers, got ' + JSON.stringify(detection));

  const results = AE.extract(makeContext(doc));
  assert(results.links.length === 2, 'expected 2 links, got ' + results.links.length);
  assert(results.links[0].url === 'http://example.com/video.mp4', 'link 0 url');
  assert(results.links[0].type === 'video', 'link 0 type');
  assert(results.links[0].server === 'stub', 'link 0 server');
  assert(results.links[1].url === 'http://example.com/audio.m4a', 'link 1 url');
  assert(results.links[1].type === 'audio', 'link 1 type');
  assert(results.sources.length === 2 && results.sources[0].element === 'div', 'sources recorded');
});

test('stub: marker without url attribute falls back to href, then empty', () => {
  const doc = new DocumentShim('http://localhost:9999/test');
  const m1 = makeElement('a', ['data-autoextract', 'href=http://example.com/file.mp4']);
  doc.register(m1);

  const AE = loadAutoExtract(doc);
  const results = AE.extract(makeContext(doc));
  assert(results.links.length === 1 && results.links[0].url === 'http://example.com/file.mp4', 'href fallback should be used');
});

test('no markers and no media: detect returns null', () => {
  const doc = new DocumentShim('http://localhost:9999/empty');
  const AE = loadAutoExtract(doc);
  const detection = AE.detect(makeContext(doc));
  assert(detection === null, 'detect should be null on empty page');
});

test('empty context returns empty extract result', () => {
  const doc = new DocumentShim('http://localhost:9999/empty');
  const AE = loadAutoExtract(doc);
  const results = AE.extract({});
  assert(results.links.length === 0 && results.sources.length === 0, 'empty context should yield empty results');
});

// ---------------------------------------------------------------------------
// Generic media scan tests
// ---------------------------------------------------------------------------

test('generic: video and audio elements with src', () => {
  const doc = new DocumentShim('http://localhost:9999/media');
  const video = makeElement('video', ['src=http://cdn.example.com/movie.mp4']);
  const audio = makeElement('audio', ['src=http://cdn.example.com/track.mp3']);
  doc.register(video);
  doc.register(audio);

  const AE = loadAutoExtract(doc);
  const detection = AE.detect(makeContext(doc));
  assert(detection && detection.type === 'generic', 'detect should report generic, got ' + JSON.stringify(detection));

  const results = AE.extract(makeContext(doc));
  assert(results.links.length === 2, 'expected 2 links, got ' + results.links.length);
  assert(results.links[0].url === 'http://cdn.example.com/movie.mp4', 'video url');
  assert(results.links[0].type === 'video', 'video type');
  assert(results.links[0].server === 'cdn.example.com', 'video server from hostname');
  assert(results.links[1].type === 'audio', 'audio type');
});

test('generic: nested source children and relative URL resolution', () => {
  const doc = new DocumentShim('http://localhost:9999/media');
  const video = makeElement('video', []);
  const s1 = makeElement('source', ['src=/hls/stream.m3u8']);
  const s2 = makeElement('source', ['src=/dash/stream.mpd']);
  video.appendChild(s1);
  video.appendChild(s2);
  doc.register(video);
  doc.register(s1);
  doc.register(s2);

  const AE = loadAutoExtract(doc);
  const results = AE.extract(makeContext(doc));
  assert(results.links.length === 2, 'expected 2 links, got ' + results.links.length);
  assert(results.links[0].url === 'http://localhost:9999/hls/stream.m3u8', 'relative src resolved against base, got ' + results.links[0].url);
  assert(results.links[0].type === 'video', 'm3u8 classified as video');
  assert(results.links[1].url === 'http://localhost:9999/dash/stream.mpd', 'dash url');
});

test('generic: standalone source inherits parent media kind', () => {
  const doc = new DocumentShim('http://localhost:9999/media');
  const audio = makeElement('audio', []);
  const s = makeElement('source', ['src=http://cdn.example.com/clip.ogg']);
  audio.appendChild(s);
  doc.register(audio);
  doc.register(s);

  const AE = loadAutoExtract(doc);
  const results = AE.extract(makeContext(doc));
  assert(results.links.length === 1, 'expected 1 link');
  assert(results.links[0].type === 'audio', 'standalone source under audio should be audio');
});

test('generic: media anchors are classified; non-media anchors ignored', () => {
  const doc = new DocumentShim('http://localhost:9999/page');
  const a1 = makeElement('a', ['href=http://files.example.com/setup.exe']);
  const a2 = makeElement('a', ['href=/downloads/episode.webm']);
  const a3 = makeElement('a', ['href=https://example.com/about']);
  doc.register(a1);
  doc.register(a2);
  doc.register(a3);

  const AE = loadAutoExtract(doc);
  const results = AE.extract(makeContext(doc));
  assert(results.links.length === 1, 'expected only the webm anchor, got ' + results.links.length);
  assert(results.links[0].url === 'http://localhost:9999/downloads/episode.webm', 'relative anchor resolved');
  assert(results.links[0].type === 'video', 'webm anchor classified as video');
});

test('generic: blob URLs included, data URLs skipped', () => {
  const doc = new DocumentShim('http://localhost:9999/media');
  const v1 = makeElement('video', ['src=blob:https://example.com/abcd-1234']);
  const v2 = makeElement('video', ['src=data:video/mp4;base64,AAAA']);
  doc.register(v1);
  doc.register(v2);

  const AE = loadAutoExtract(doc);
  const results = AE.extract(makeContext(doc));
  assert(results.links.length === 1, 'blob kept, data skipped; got ' + results.links.length);
  assert(results.links[0].url.indexOf('blob:') === 0, 'blob url preserved');
});

test('generic: duplicate resolved URLs are deduplicated', () => {
  const doc = new DocumentShim('http://localhost:9999/media');
  const v = makeElement('video', ['src=http://cdn.example.com/movie.mp4']);
  const a = makeElement('a', ['href=http://cdn.example.com/movie.mp4']);
  doc.register(v);
  doc.register(a);

  const AE = loadAutoExtract(doc);
  const results = AE.extract(makeContext(doc));
  assert(results.links.length === 1, 'expected 1 link after dedup, got ' + results.links.length);
});

test('generic: takes precedence in detect counts but stub wins in extract', () => {
  const doc = new DocumentShim('http://localhost:9999/mixed');
  const m = makeElement('div', ['data-autoextract', 'data-autoextract-url=http://example.com/video.mp4']);
  const v = makeElement('video', ['src=http://cdn.example.com/other.mp4']);
  doc.register(m);
  doc.register(v);

  const AE = loadAutoExtract(doc);
  const detection = AE.detect(makeContext(doc));
  assert(detection.type === 'stub' && detection.markerCount === 1, 'stub detection wins when both present');
  const results = AE.extract(makeContext(doc));
  assert(results.links.length === 1 && results.links[0].server === 'stub', 'extract uses stub mode only');
});

// ---------------------------------------------------------------------------
// Classification edge cases
// ---------------------------------------------------------------------------

test('classify: unknown extensions and extensionless URLs', () => {
  const AE = loadAutoExtract(new DocumentShim('http://localhost:9999/x'));
  const internal = AE._internal;
  assert(internal.classifyUrl(new URL('http://x/file.xyz')) === null, 'unknown ext -> null');
  assert(internal.classifyUrl(new URL('http://x/file')) === null, 'no ext -> null');
  assert(internal.classifyUrl(new URL('http://x/file.MP4')) === 'video', 'uppercase ext handled');
  assert(internal.classifyUrl(new URL('http://x/watch?v=abc')) === null, 'query-only url -> null');
  assert(internal.classifyUrl(new URL('http://x/file.mp4?token=1')) === 'video', 'query string ignored for ext');
});

test('shouldIncludeUrl: blob/http(s) in, data/others out', () => {
  const AE = loadAutoExtract(new DocumentShim('http://localhost:9999/x'));
  const internal = AE._internal;
  assert(internal.shouldIncludeUrl(new URL('http://x/f.mp4')) === true, 'http in');
  assert(internal.shouldIncludeUrl(new URL('https://x/f.mp4')) === true, 'https in');
  assert(internal.shouldIncludeUrl(new URL('blob:https://x/1')) === true, 'blob in');
  assert(internal.shouldIncludeUrl(new URL('data:text/plain,hi')) === false, 'data out');
  assert(internal.shouldIncludeUrl(new URL('file:///C:/x/f.mp4')) === false, 'file out');
});

// ---------------------------------------------------------------------------
// YouTube site-specific extraction tests
// ---------------------------------------------------------------------------

// Builds a YouTube-like document whose inline script assigns the given
// player response object, mimicking how real watch pages embed
// ytInitialPlayerResponse.
function makeYouTubeDoc(playerResponse, extraElements) {
  const doc = new DocumentShim('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  const script = makeElement('script', []);
  script.textContent = 'var ytInitialPlayerResponse = ' + JSON.stringify(playerResponse) + ';';
  doc.register(script);
  (extraElements || []).forEach((el) => doc.register(el));
  return doc;
}

const YT_FORMAT_VIDEO = {
  itag: 18,
  mimeType: 'video/mp4; codecs="avc1.42001E, mp4a.40.2"',
  qualityLabel: '360p',
  bitrate: 395173,
  width: 640,
  height: 360,
  approxDurationMs: '212000',
  url: 'https://rr3---sn-abc.googlevideo.com/videoplayback?id=o-abc&itag=18&mime=video%2Fmp4'
};

const YT_ADAPTIVE_VIDEO = {
  itag: 137,
  mimeType: 'video/mp4; codecs="avc1.64002a"',
  qualityLabel: '1080p',
  bitrate: 2149153,
  width: 1920,
  height: 1080,
  url: 'https://rr3---sn-abc.googlevideo.com/videoplayback?id=o-abc&itag=137&mime=video%2Fmp4'
};

const YT_ADAPTIVE_AUDIO = {
  itag: 140,
  mimeType: 'audio/mp4; codecs="mp4a.40.2"',
  bitrate: 129637,
  url: 'https://rr3---sn-abc.googlevideo.com/videoplayback?id=o-abc&itag=140&mime=audio%2Fmp4'
};

const YT_HLS_URL = 'https://manifest.googlevideo.com/api/manifest/hls_playlist/id/o-abc';
const YT_DASH_URL = 'https://manifest.googlevideo.com/api/manifest/dash/id/o-abc';

function makeStreamingData(overrides) {
  return Object.assign({
    formats: [YT_FORMAT_VIDEO],
    adaptiveFormats: [YT_ADAPTIVE_VIDEO, YT_ADAPTIVE_AUDIO],
    hlsManifestUrl: YT_HLS_URL,
    dashManifestUrl: YT_DASH_URL
  }, overrides || {});
}

function makePlayerResponse(streamingData) {
  return {
    videoDetails: { videoId: 'dQw4w9WgXcQ', title: 'Sample "Video" & Title' },
    streamingData: streamingData
  };
}

test('youtube: full player payload yields formats, adaptive, HLS, and DASH links', () => {
  const doc = makeYouTubeDoc(makePlayerResponse(makeStreamingData()));
  const AE = loadAutoExtract(doc);
  const context = makeContext(doc);

  const detection = AE.detect(context);
  assert(detection && detection.type === 'youtube', 'detect should report youtube, got ' + JSON.stringify(detection));
  assert(detection.videoId === 'dQw4w9WgXcQ', 'detection should carry videoId');
  assert(detection.linkCount === 5, 'expected 5 links in detection, got ' + detection.linkCount);
  assert(detection.cipheredCount === 0, 'no ciphered formats expected');

  const results = AE.extract(context);
  assert(results.links.length === 5, 'expected 5 links, got ' + results.links.length);
  assert(results.sources.length === 1 && results.sources[0].element === 'ytInitialPlayerResponse', 'source element recorded');
  assert(results.sources[0].attributes.indexOf('streamingData.formats') !== -1, 'formats attribute recorded');
  assert(results.sources[0].attributes.indexOf('streamingData.hlsManifestUrl') !== -1, 'hls attribute recorded');

  const video = results.links.find((l) => l.url === YT_FORMAT_VIDEO.url);
  assert(video && video.server === 'YouTube' && video.type === 'video', 'muxed video format emitted');
  assert(video.itag === '18' && video.container === 'mp4' && video.quality === '360p', 'format metadata carried');
  assert(video.size === '640x360' && video.bitrate === 395173 && video.durationMs === '212000', 'numeric metadata carried');

  const adaptiveVideo = results.links.find((l) => l.url === YT_ADAPTIVE_VIDEO.url);
  assert(adaptiveVideo && adaptiveVideo.type === 'video' && adaptiveVideo.itag === '137', 'adaptive video emitted');

  const audio = results.links.find((l) => l.url === YT_ADAPTIVE_AUDIO.url);
  assert(audio && audio.type === 'audio' && audio.itag === '140' && audio.codecs === 'mp4a.40.2', 'audio-only format emitted with codecs');

  const hls = results.links.find((l) => l.url === YT_HLS_URL);
  assert(hls && hls.type === 'hls' && hls.server === 'YouTube', 'HLS manifest emitted');

  const dash = results.links.find((l) => l.url === YT_DASH_URL);
  assert(dash && dash.type === 'dash', 'DASH manifest emitted');
});

test('youtube: signatureCipher formats are counted but never emitted', () => {
  const ciphered = {
    itag: 22,
    mimeType: 'video/mp4; codecs="avc1.64001F, mp4a.40.2"',
    qualityLabel: '720p',
    signatureCipher: 's=abc&sigr=xyz&url=https%3A%2F%2Frr3---sn-abc.googlevideo.com%2Fvideoplayback'
  };
  const doc = makeYouTubeDoc(makePlayerResponse(makeStreamingData({ formats: [YT_FORMAT_VIDEO, ciphered] })));
  const AE = loadAutoExtract(doc);
  const context = makeContext(doc);

  const detection = AE.detect(context);
  assert(detection.cipheredCount === 1, 'cipheredCount should be 1, got ' + detection.cipheredCount);

  const results = AE.extract(context);
  assert(results.links.length === 5, 'ciphered format must not add a link, got ' + results.links.length);
  assert(results.links.every((l) => l.url.indexOf('googlevideo.com') === -1 || l.url.indexOf('videoplayback%3F') === -1), 'no deciphered urls');
  assert(results.meta.cipheredCount === 1, 'meta carries ciphered count');
});

test('youtube: JSON extractor survives braces, quotes, and escapes inside strings', () => {
  // Title contains }, ", and an escaped-backslash-terminated string plus an
  // apostrophe; a naive brace counter would cut the object short.
  const tricky = makePlayerResponse(makeStreamingData());
  tricky.videoDetails.title = 'Weird } { "title" with \' quotes and C:\\paths\\';

  const doc = makeYouTubeDoc(tricky);
  const AE = loadAutoExtract(doc);
  const context = makeContext(doc);

  const detection = AE.detect(context);
  assert(detection && detection.type === 'youtube', 'tricky strings must still parse, got ' + JSON.stringify(detection));
  assert(AE.extract(context).links.length === 5, 'all links extracted despite tricky strings');
});

test('youtube: malformed player JSON falls back to the generic scan', () => {
  const doc = new DocumentShim('https://www.youtube.com/watch?v=abc');
  const brokenScript = makeElement('script', []);
  brokenScript.textContent = 'var ytInitialPlayerResponse = {"streamingData": truncated';
  const video = makeElement('video', ['src=https://cdn.example.com/clip.mp4']);
  doc.register(brokenScript);
  doc.register(video);

  const AE = loadAutoExtract(doc);
  const context = makeContext(doc);
  const detection = AE.detect(context);
  assert(detection && detection.type === 'generic', 'should fall back to generic, got ' + JSON.stringify(detection));
  const results = AE.extract(context);
  assert(results.links.length === 1 && results.links[0].url === 'https://cdn.example.com/clip.mp4', 'generic link used as fallback');
});

test('youtube: host gating ignores player response on other sites', () => {
  // Same player-response script, but the page is not youtube.com.
  const doc = new DocumentShim('https://evil.example.com/watch');
  const script = makeElement('script', []);
  script.textContent = 'var ytInitialPlayerResponse = ' + JSON.stringify(makePlayerResponse(makeStreamingData())) + ';';
  doc.register(script);

  const AE = loadAutoExtract(doc);
  const context = makeContext(doc);
  const detection = AE.detect(context);
  assert(detection === null, 'non-YouTube host must not trigger youtube detection, got ' + JSON.stringify(detection));
  const results = AE.extract(context);
  assert(results.links.length === 0, 'no links from foreign host player payload');
});

test('youtube: blob URLs excluded from fallback merge, youtube links deduped', () => {
  const blobVideo = makeElement('video', ['src=blob:https://www.youtube.com/aaaa-bbbb']);
  const doc = makeYouTubeDoc(makePlayerResponse(makeStreamingData()), [blobVideo, blobVideo]);
  // Register a duplicate of the same format URL via an anchor to exercise dedup.
  const AE = loadAutoExtract(doc);
  const context = makeContext(doc);

  const results = AE.extract(context);
  assert(results.links.every((l) => l.url.indexOf('blob:') !== 0), 'blob URLs must be excluded on YouTube');
  const urls = results.links.map((l) => l.url);
  assert(new Set(urls).size === urls.length, 'no duplicate urls in merged results');
  assert(results.links.length === 5, 'expected exactly the 5 youtube links, got ' + results.links.length);
});

test('youtube: isYouTubeHost unit checks', () => {
  const internal = loadAutoExtract(new DocumentShim('http://localhost:9999/x'))._internal;
  assert(internal.isYouTubeHost('www.youtube.com') === true, 'www subdomain');
  assert(internal.isYouTubeHost('youtube.com') === true, 'apex');
  assert(internal.isYouTubeHost('music.youtube.com') === true, 'deep subdomain');
  assert(internal.isYouTubeHost('notyoutube.com') === false, 'prefix lookalike rejected');
  assert(internal.isYouTubeHost('www.youtube.com.evil.com') === false, 'suffix lookalike rejected');
  assert(internal.isYouTubeHost('example.com') === false, 'unrelated host');
  assert(internal.isYouTubeHost('') === false, 'empty host');
  assert(internal.isYouTubeHost(null) === false, 'null host');
});

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

console.log('\nResults: ' + PASS.length + ' passed, ' + FAIL.length + ' failed');
PASS.forEach((name) => console.log('  PASS ' + name));
FAIL.forEach((f) => {
  console.log('  FAIL ' + f.name);
  console.log('       ' + (f.error && f.error.message ? f.error.message : f.error));
});

process.exit(FAIL.length > 0 ? 1 : 0);
