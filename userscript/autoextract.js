// ==UserScript==
// @name         AutoExtract Link Tools
// @namespace    https://github.com/autoextractlinktools
// @version      1.2.0
// @description  Detect video players and media links on the page, extract links,
//               and forward them to the local desktop app at http://localhost:3456/
// @match        https://www.youtube.com/*
// @match        https://www.bilibili.com/*
// @match        https://vimeo.com/*
// @match        http://localhost:*/*
// @match        https://localhost/*
// @grant        none
// @run-at       document_idle
// ==/UserScript==

// userscript/autoextract.js
//
// AutoExtract Link Tools userscript.
//
// This is an alternative page-injection path alongside the Chrome extension.
// It reuses the same shared detection and extraction logic as the extension so
// site/player-specific parsing is not duplicated across runtimes.
//
// Shared logic note:
//   - This userscript inlines the shared detect/extract behavior so it can run
//     without a separate build output or hosted @require URL.
//   - The authoritative shared source is still repo root shared/index.js.
//   - If the shared module changes, update this inlined copy from shared/index.js
//     rather than evolving these two independently.
//
// Current behavior:
//   - Runs on page load after the DOM is ready.
//   - Detection modes (matching shared/index.js):
//       1. Stub contract: [data-autoextract] markers are fake link sources
//          (data-autoextract-url/-type/-server attributes) for testing.
//       2. YouTube: parses the inline ytInitialPlayerResponse script for
//          streamingData formats and HLS/DASH manifests. signatureCipher-
//          gated formats are counted but never emitted (no deciphering).
//       3. Bilibili: parses the inline window.__playinfo__ script for DASH
//          video/audio entries (plus dolby/flac extras) and legacy durl
//          files, with quality labels, codecs, and bitrates.
//       4. Generic media scan: <video>/<audio> elements and their <source>
//          children, standalone <source> elements, and anchors whose href
//          points at a known media file extension. blob:/http(s) URLs are
//          included; data: URLs are skipped. On YouTube and Bilibili, blob:
//          URLs are excluded because MSE blob URLs are unusable outside the
//          page.
//   - Shows a small in-page status indicator so behavior is observable without
//     devtools.
//   - Forwards results to the desktop app over localhost if it is reachable.
//   - Degrades predictably if the desktop app is not reachable.
//
// TODO:
//   - Replace the inlined shared logic with a proper shared import path once a
//     userscript build or hosted @require URL exists.
//   - Add site/player-specific rules (YouTube, Bilibili, Vimeo) on top of the
//     generic scan.

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Shared detection/extraction interface (inlined from shared/index.js).
  // ---------------------------------------------------------------------------

  var MEDIA_EXTENSIONS = {
    // video
    mp4: 'video', m4v: 'video', webm: 'video', mov: 'video', mkv: 'video',
    avi: 'video', ogv: 'video', '3gp': 'video', flv: 'video', ts: 'video',
    m3u8: 'video', mpd: 'video',
    // audio
    m4a: 'audio', mp3: 'audio', aac: 'audio', ogg: 'audio', oga: 'audio',
    wav: 'audio', flac: 'audio', opus: 'audio'
  };

  function safeParseUrl(raw, base) {
    if (typeof raw !== 'string' || raw.length === 0) {
      return null;
    }
    try {
      return new URL(raw, base || undefined);
    } catch (error) {
      return null;
    }
  }

  function classifyUrl(urlObj) {
    var match = urlObj.pathname.match(/\.([a-z0-9]+)$/i);
    if (!match) {
      return null;
    }
    return MEDIA_EXTENSIONS[match[1].toLowerCase()] || null;
  }

  function shouldIncludeUrl(urlObj) {
    return (
      urlObj.protocol === 'http:' ||
      urlObj.protocol === 'https:' ||
      urlObj.protocol === 'blob:'
    );
  }

  function getAttr(el, name) {
    if (el && typeof el.getAttribute === 'function') {
      var value = el.getAttribute(name);
      return typeof value === 'string' && value.length > 0 ? value : null;
    }
    return null;
  }

  function tagName(el) {
    return el && el.tagName ? String(el.tagName).toLowerCase() : 'unknown';
  }

  function attributeNames(el) {
    if (!el || !el.attributes) {
      return [];
    }
    return Array.prototype.map.call(el.attributes, function (attr) {
      return attr.name;
    });
  }

  function queryAll(doc, selector) {
    var result = doc.querySelectorAll(selector);
    return result ? Array.prototype.slice.call(result) : [];
  }

  function resolveBase(context) {
    if (context && context.location && context.location.href) {
      return context.location.href;
    }
    if (context && context.document && context.document.location && context.document.location.href) {
      return context.document.location.href;
    }
    return undefined;
  }

  function scanMedia(context) {
    var doc = context && context.document;
    if (!doc || typeof doc.querySelectorAll !== 'function') {
      return [];
    }

    var base = resolveBase(context);
    var items = [];

    queryAll(doc, 'video, audio').forEach(function (media) {
      var kind = tagName(media);
      var src = getAttr(media, 'src');
      if (src) {
        items.push({ kind: kind, el: media, raw: src, base: base });
      }
      queryAll(media, 'source').forEach(function (source) {
        var sourceSrc = getAttr(source, 'src');
        if (sourceSrc) {
          items.push({ kind: kind, el: source, raw: sourceSrc, base: base });
        }
      });
    });

    queryAll(doc, 'source').forEach(function (source) {
      var src = getAttr(source, 'src');
      if (src) {
        var parent = source.parentElement || source.parentNode;
        items.push({
          kind: parent && parent.tagName ? tagName(parent) : 'media',
          el: source,
          raw: src,
          base: base
        });
      }
    });

    queryAll(doc, 'a[href]').forEach(function (anchor) {
      var href = getAttr(anchor, 'href');
      var urlObj = safeParseUrl(href, base);
      if (!urlObj) {
        return;
      }
      var kind = classifyUrl(urlObj);
      if (kind) {
        items.push({ kind: kind, el: anchor, raw: href, base: base });
      }
    });

    return items;
  }

  function hasMarkers(context) {
    var doc = context && context.document;
    if (!doc || typeof doc.querySelectorAll !== 'function') {
      return false;
    }
    var markers = doc.querySelectorAll('[data-autoextract]');
    return !!(markers && markers.length > 0);
  }

  function extractStub(context) {
    var doc = context.document;
    var links = [];
    var sources = [];

    queryAll(doc, '[data-autoextract]').forEach(function (marker) {
      var url = marker.getAttribute('data-autoextract-url') || marker.getAttribute('href') || '';
      var type = marker.getAttribute('data-autoextract-type') || marker.getAttribute('data-autoextract') || 'link';
      var server = marker.getAttribute('data-autoextract-server') || 'stub';

      if (url) {
        links.push({
          server: server,
          type: type,
          url: url
        });
      }

      sources.push({
        element: tagName(marker),
        attributes: attributeNames(marker)
      });
    });

    return { links: links, sources: sources };
  }

  // ---------------------------------------------------------------------------
  // YouTube site-specific extraction (inlined from shared/index.js).
  // ---------------------------------------------------------------------------

  var YOUTUBE_HOST_PATTERN = /(^|\.)youtube\.com$/i;

  function isYouTubeHost(hostname) {
    return typeof hostname === 'string' && YOUTUBE_HOST_PATTERN.test(hostname);
  }

  function contextHost(context) {
    if (context && context.location && context.location.href) {
      var parsed = safeParseUrl(context.location.href);
      if (parsed) {
        return parsed.hostname;
      }
    }
    return null;
  }

  // Extracts the JSON object assigned to `marker` inside script text,
  // balancing braces while respecting string literals and escapes.
  function extractJsonAssignment(text, marker) {
    if (typeof text !== 'string') {
      return null;
    }
    var markerIndex = text.indexOf(marker);
    if (markerIndex === -1) {
      return null;
    }
    var start = text.indexOf('{', markerIndex);
    if (start === -1) {
      return null;
    }
    var depth = 0;
    var inString = false;
    var quote = '';
    var escaped = false;
    for (var i = start; i < text.length; i++) {
      var ch = text.charAt(i);
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (ch === '\\') {
          escaped = true;
        } else if (ch === quote) {
          inString = false;
        }
        continue;
      }
      if (ch === '"' || ch === "'") {
        inString = true;
        quote = ch;
        continue;
      }
      if (ch === '{') {
        depth++;
      } else if (ch === '}') {
        depth--;
        if (depth === 0) {
          return text.slice(start, i + 1);
        }
      }
    }
    return null;
  }

  function parsePlayerResponse(context) {
    var doc = context && context.document;
    if (!doc || typeof doc.querySelectorAll !== 'function') {
      return null;
    }
    var scripts = queryAll(doc, 'script');
    for (var i = 0; i < scripts.length; i++) {
      var el = scripts[i];
      var text = el && typeof el.textContent === 'string' ? el.textContent : '';
      if (text.indexOf('ytInitialPlayerResponse') === -1) {
        continue;
      }
      var json = extractJsonAssignment(text, 'ytInitialPlayerResponse');
      if (!json) {
        continue;
      }
      try {
        var parsed = JSON.parse(json);
        if (parsed && typeof parsed === 'object') {
          return parsed;
        }
      } catch (error) {
        // Malformed or truncated assignment: try the next script.
      }
    }
    return null;
  }

  function mimeContainer(mimeType) {
    var match = typeof mimeType === 'string' ? mimeType.match(/^(\w+)\/([\w0-9.-]+)/) : null;
    if (!match) {
      return null;
    }
    return { kind: match[1], container: match[2] };
  }

  function mimeCodecs(mimeType) {
    var match = typeof mimeType === 'string' ? mimeType.match(/codecs="?([^"]*)"?/) : null;
    return match ? match[1] : null;
  }

  // Converts one streamingData format entry into a link, or null when the
  // entry is unusable (ciphered, missing URL, or non-http transport).
  function youTubeLinkFromFormat(format) {
    if (!format || typeof format !== 'object') {
      return null;
    }
    if (typeof format.url !== 'string' || format.url.length === 0) {
      return null; // signatureCipher-gated or otherwise URL-less
    }
    var parsed = safeParseUrl(format.url);
    if (!parsed || !shouldIncludeUrl(parsed)) {
      return null;
    }

    var mime = mimeContainer(format.mimeType);
    var type = 'media';
    if (mime) {
      if (mime.kind === 'audio') {
        type = 'audio';
      } else if (mime.kind === 'video') {
        type = 'video';
      }
    }

    var link = {
      server: 'YouTube',
      type: type,
      url: parsed.href
    };

    if (format.itag !== undefined && format.itag !== null) {
      link.itag = String(format.itag);
    }
    if (mime) {
      link.container = mime.container;
    }
    var codecs = mimeCodecs(format.mimeType);
    if (codecs) {
      link.codecs = codecs;
    }
    if (typeof format.qualityLabel === 'string' && format.qualityLabel) {
      link.quality = format.qualityLabel;
    } else if (typeof format.quality === 'string' && format.quality) {
      link.quality = format.quality;
    }
    if (typeof format.bitrate === 'number' && format.bitrate > 0) {
      link.bitrate = format.bitrate;
    }
    if (typeof format.width === 'number' && typeof format.height === 'number') {
      link.size = format.width + 'x' + format.height;
    }
    if (typeof format.approxDurationMs === 'string' && format.approxDurationMs) {
      link.durationMs = format.approxDurationMs;
    }

    return link;
  }

  // Returns { links, sources, meta } or null when no YouTube player payload
  // can be extracted. meta carries counts for detection and diagnostics.
  function extractYouTube(context) {
    var playerResponse = parsePlayerResponse(context);
    if (!playerResponse) {
      return null;
    }

    var streamingData = playerResponse.streamingData;
    if (!streamingData || typeof streamingData !== 'object') {
      return null;
    }

    var links = [];
    var seen = {};
    var cipheredCount = 0;

    var formats = Array.isArray(streamingData.formats) ? streamingData.formats : [];
    var adaptive = Array.isArray(streamingData.adaptiveFormats) ? streamingData.adaptiveFormats : [];

    function addFormat(format) {
      var link = youTubeLinkFromFormat(format);
      if (link) {
        if (!seen[link.url]) {
          seen[link.url] = true;
          links.push(link);
        }
      } else if (format && typeof format === 'object' && !format.url &&
                 (format.signatureCipher || format.cipher)) {
        cipheredCount++;
      }
    }

    formats.forEach(addFormat);
    adaptive.forEach(addFormat);

    if (typeof streamingData.hlsManifestUrl === 'string' && streamingData.hlsManifestUrl) {
      var hls = safeParseUrl(streamingData.hlsManifestUrl);
      if (hls && shouldIncludeUrl(hls) && !seen[hls.href]) {
        seen[hls.href] = true;
        links.push({ server: 'YouTube', type: 'hls', url: hls.href });
      }
    }

    if (typeof streamingData.dashManifestUrl === 'string' && streamingData.dashManifestUrl) {
      var dash = safeParseUrl(streamingData.dashManifestUrl);
      if (dash && shouldIncludeUrl(dash) && !seen[dash.href]) {
        seen[dash.href] = true;
        links.push({ server: 'YouTube', type: 'dash', url: dash.href });
      }
    }

    if (links.length === 0) {
      return null;
    }

    var usedAttributes = [];
    if (formats.length > 0) {
      usedAttributes.push('streamingData.formats');
    }
    if (adaptive.length > 0) {
      usedAttributes.push('streamingData.adaptiveFormats');
    }
    if (typeof streamingData.hlsManifestUrl === 'string' && streamingData.hlsManifestUrl) {
      usedAttributes.push('streamingData.hlsManifestUrl');
    }
    if (typeof streamingData.dashManifestUrl === 'string' && streamingData.dashManifestUrl) {
      usedAttributes.push('streamingData.dashManifestUrl');
    }

    var videoId = playerResponse.videoDetails && playerResponse.videoDetails.videoId
      ? playerResponse.videoDetails.videoId
      : null;

    return {
      links: links,
      sources: [{ element: 'ytInitialPlayerResponse', attributes: usedAttributes }],
      meta: {
        videoId: videoId,
        formatCount: formats.length,
        adaptiveFormatCount: adaptive.length,
        cipheredCount: cipheredCount
      }
    };
  }

  // ---------------------------------------------------------------------------
  // Bilibili site-specific extraction (inlined from shared/index.js).
  // ---------------------------------------------------------------------------

  var BILIBILI_HOST_PATTERN = /(^|\.)bilibili\.com$/i;

  function isBilibiliHost(hostname) {
    return typeof hostname === 'string' && BILIBILI_HOST_PATTERN.test(hostname);
  }

  // Returns the first non-empty string property among `keys`.
  function pickString(obj, keys) {
    for (var i = 0; i < keys.length; i++) {
      var value = obj ? obj[keys[i]] : undefined;
      if (typeof value === 'string' && value.length > 0) {
        return value;
      }
    }
    return null;
  }

  function parseBilibiliPlayinfo(context) {
    var doc = context && context.document;
    if (!doc || typeof doc.querySelectorAll !== 'function') {
      return null;
    }
    var scripts = queryAll(doc, 'script');
    for (var i = 0; i < scripts.length; i++) {
      var el = scripts[i];
      var text = el && typeof el.textContent === 'string' ? el.textContent : '';
      if (text.indexOf('__playinfo__') === -1) {
        continue;
      }
      var json = extractJsonAssignment(text, '__playinfo__');
      if (!json) {
        continue;
      }
      try {
        var parsed = JSON.parse(json);
        if (parsed && typeof parsed === 'object') {
          return parsed;
        }
      } catch (error) {
        // Malformed or truncated assignment: try the next script.
      }
    }
    return null;
  }

  // DASH quality ids to human labels (the 2025 list; unknown ids fall back to
  // the raw id in qualityId).
  var BILIBILI_QUALITY_LABELS = {
    6: '240p', 16: '360p', 32: '480p', 64: '720p', 74: '720p60',
    80: '1080p', 112: '1080p+', 116: '1080p60', 120: '4K',
    125: 'HDR', 126: 'Dolby', 127: '8K'
  };

  // Converts one DASH entry (video or audio) into a link, or null when the
  // entry has no usable URL.
  function bilibiliLinkFromDash(dash, kind) {
    if (!dash || typeof dash !== 'object') {
      return null;
    }
    // Field naming varies across playinfo builds (camelCase and snake_case).
    var raw = pickString(dash, ['baseUrl', 'base_url', 'baseURL']);
    if (!raw) {
      return null;
    }
    var parsed = safeParseUrl(raw);
    if (!parsed || !shouldIncludeUrl(parsed)) {
      return null;
    }

    var link = {
      server: 'Bilibili',
      type: kind,
      url: parsed.href
    };

    if (dash.id !== undefined && dash.id !== null) {
      link.qualityId = String(dash.id);
      var label = BILIBILI_QUALITY_LABELS[dash.id];
      if (label) {
        link.quality = label;
      }
    }
    if (typeof dash.codecs === 'string' && dash.codecs) {
      link.codecs = dash.codecs;
    }
    if (typeof dash.bandwidth === 'number' && dash.bandwidth > 0) {
      link.bitrate = dash.bandwidth;
    }
    if (kind === 'video' && typeof dash.width === 'number' && typeof dash.height === 'number') {
      link.size = dash.width + 'x' + dash.height;
    }
    var container = null;
    var containerMatch = typeof dash.mimeType === 'string'
      ? dash.mimeType.match(/container="?(\w+)"?/)
      : null;
    if (containerMatch) {
      container = containerMatch[1];
    } else {
      // Bilibili mimeType is like 'video/mp4; codes="avc1.640028"' with no
      // container attribute; derive the container from the MIME subtype.
      var mime = mimeContainer(dash.mimeType);
      if (mime && (mime.kind === 'video' || mime.kind === 'audio')) {
        container = mime.container;
      }
    }
    if (container) {
      link.container = container;
    }

    return link;
  }

  // Converts a legacy durl entry (complete muxed file) into a link.
  function bilibiliLinkFromDurl(durl) {
    if (!durl || typeof durl !== 'object') {
      return null;
    }
    var raw = pickString(durl, ['url']);
    if (!raw) {
      return null;
    }
    var parsed = safeParseUrl(raw);
    if (!parsed || !shouldIncludeUrl(parsed)) {
      return null;
    }

    var link = {
      server: 'Bilibili',
      type: 'video',
      url: parsed.href
    };

    if (typeof durl.size === 'number' && durl.size > 0) {
      link.bytes = durl.size;
    }
    if (typeof durl.length === 'number' && durl.length > 0) {
      link.durationMs = String(durl.length);
    }

    return link;
  }

  // Returns { links, sources, meta } or null when no playinfo payload can be
  // extracted. meta carries counts for detection and diagnostics.
  function extractBilibili(context) {
    var playinfo = parseBilibiliPlayinfo(context);
    if (!playinfo || !playinfo.data || typeof playinfo.data !== 'object') {
      return null;
    }
    var data = playinfo.data;

    var links = [];
    var seen = {};

    function addLink(link) {
      if (link && !seen[link.url]) {
        seen[link.url] = true;
        links.push(link);
      }
    }

    var dash = data.dash && typeof data.dash === 'object' ? data.dash : null;
    if (dash) {
      var videos = Array.isArray(dash.video) ? dash.video : [];
      videos.forEach(function (entry) {
        addLink(bilibiliLinkFromDash(entry, 'video'));
      });

      var audios = Array.isArray(dash.audio) ? dash.audio : [];
      audios.forEach(function (entry) {
        addLink(bilibiliLinkFromDash(entry, 'audio'));
      });

      // Premium audio extras, present only on some pages; kept so the audio
      // list is complete when they are available.
      if (dash.dolby && Array.isArray(dash.dolby.audio)) {
        dash.dolby.audio.forEach(function (entry) {
          addLink(bilibiliLinkFromDash(entry, 'audio'));
        });
      }
      if (dash.flac && dash.flac.audio) {
        addLink(bilibiliLinkFromDash(dash.flac.audio, 'audio'));
      }
    }

    // Legacy single-file streams (older videos / fallback): each durl entry
    // is a complete muxed file.
    var durl = Array.isArray(data.durl) ? data.durl : [];
    durl.forEach(function (entry) {
      addLink(bilibiliLinkFromDurl(entry));
    });

    if (links.length === 0) {
      return null;
    }

    var usedAttributes = [];
    if (dash) {
      if (Array.isArray(dash.video) && dash.video.length > 0) {
        usedAttributes.push('data.dash.video');
      }
      if (Array.isArray(dash.audio) && dash.audio.length > 0) {
        usedAttributes.push('data.dash.audio');
      }
    }
    if (durl.length > 0) {
      usedAttributes.push('data.durl');
    }

    return {
      links: links,
      sources: [{ element: 'window.__playinfo__', attributes: usedAttributes }],
      meta: {
        dashVideoCount: dash && Array.isArray(dash.video) ? dash.video.length : 0,
        dashAudioCount: dash && Array.isArray(dash.audio) ? dash.audio.length : 0,
        durlCount: durl.length
      }
    };
  }

  function extractGeneric(context) {
    var items = scanMedia(context);
    var seen = {};
    var links = [];
    var sources = [];

    items.forEach(function (item) {
      var urlObj = safeParseUrl(item.raw, item.base);
      if (!urlObj || !shouldIncludeUrl(urlObj)) {
        return;
      }

      var resolved = urlObj.href;
      if (seen[resolved]) {
        return;
      }
      seen[resolved] = true;

      var type = classifyUrl(urlObj) || (item.kind === 'video' || item.kind === 'audio' ? item.kind : 'link');
      var server = urlObj.hostname ? urlObj.hostname.replace(/^www\./, '') : 'direct';

      links.push({
        server: server,
        type: type,
        url: resolved
      });

      sources.push({
        element: tagName(item.el),
        attributes: attributeNames(item.el)
      });
    });

    return { links: links, sources: sources };
  }

  var detect = function (context) {
    var doc = context && context.document;
    if (!doc || typeof doc.querySelectorAll !== 'function') {
      return null;
    }

    // Stub contract takes precedence so test pages behave exactly as before.
    var markers = doc.querySelectorAll('[data-autoextract]');
    if (markers.length > 0) {
      return {
        supported: true,
        type: 'stub',
        markerCount: markers.length
      };
    }

    // YouTube site-specific detection.
    var host = contextHost(context);
    if (isYouTubeHost(host || '')) {
      var ytResult = extractYouTube(context);
      if (ytResult && ytResult.links.length > 0) {
        return {
          supported: true,
          type: 'youtube',
          videoId: ytResult.meta.videoId,
          linkCount: ytResult.links.length,
          cipheredCount: ytResult.meta.cipheredCount
        };
      }
      // No player payload: fall through to the generic scan.
    }

    // Bilibili site-specific detection.
    if (isBilibiliHost(host || '')) {
      var biliResult = extractBilibili(context);
      if (biliResult && biliResult.links.length > 0) {
        return {
          supported: true,
          type: 'bilibili',
          linkCount: biliResult.links.length,
          dashVideoCount: biliResult.meta.dashVideoCount,
          dashAudioCount: biliResult.meta.dashAudioCount,
          durlCount: biliResult.meta.durlCount
        };
      }
      // No playinfo payload: fall through to the generic scan.
    }

    var items = scanMedia(context);
    if (items.length === 0) {
      return null;
    }

    var counts = {};
    items.forEach(function (item) {
      counts[item.kind] = (counts[item.kind] || 0) + 1;
    });

    return {
      supported: true,
      type: 'generic',
      counts: counts
    };
  };

  // Merges a site-specific result with the generic scan on the same page:
  // site links first, then generic-only links (dedup by resolved URL).
  // dropBlob excludes blob: URLs from the generic fallback: YouTube and
  // Bilibili players stream via MSE, and blob URLs only work inside the
  // originating page.
  function mergeSiteAndGeneric(context, siteResult, dropBlob) {
    var generic = extractGeneric(context);
    var genericLinks = [];
    var genericSources = [];
    generic.links.forEach(function (link, index) {
      if (!dropBlob || link.url.indexOf('blob:') !== 0) {
        genericLinks.push(link);
        genericSources.push(generic.sources[index]);
      }
    });

    if (!siteResult) {
      return { links: genericLinks, sources: genericSources };
    }

    var seen = {};
    siteResult.links.forEach(function (link) {
      seen[link.url] = true;
    });
    var extra = genericLinks.filter(function (link) {
      return !seen[link.url];
    });

    return {
      links: siteResult.links.concat(extra),
      sources: siteResult.sources,
      meta: siteResult.meta
    };
  }

  var extract = function (context) {
    if (!context || !context.document) {
      return { links: [], sources: [] };
    }

    if (hasMarkers(context)) {
      return extractStub(context);
    }

    var host = contextHost(context);
    if (isYouTubeHost(host || '')) {
      // On YouTube the player streams via MSE blob: URLs, which are only
      // valid inside the originating page, so the fallback drops them.
      return mergeSiteAndGeneric(context, extractYouTube(context), true);
    }

    if (isBilibiliHost(host || '')) {
      // Same MSE situation as YouTube: drop blob: URLs from the fallback.
      return mergeSiteAndGeneric(context, extractBilibili(context), true);
    }

    return extractGeneric(context);
  };

  // ---------------------------------------------------------------------------
  // Desktop bridge target.
  // ---------------------------------------------------------------------------

  var DEFAULT_DESKTOP_URL = 'http://localhost:3456/';
  var SENTINEL_CLASS = 'autoextract-userscript-status';

  // ---------------------------------------------------------------------------
  // Small in-page status indicator.
  // ---------------------------------------------------------------------------

  function createStatusElement() {
    var el = document.createElement('div');
    el.className = SENTINEL_CLASS;
    el.style.cssText = (
      'position:fixed;bottom:8px;right:8px;z-index:2147483647;' +
      'background:#1a1a2e;color:#e0e0e0;border:1px solid #0f3460;' +
      'border-radius:4px;padding:6px 8px;font-size:11px;font-family:monospace;' +
      'max-width:260px;word-break:break-all;'
    );
    el.textContent = 'AutoExtract: initializing...';
    document.body.appendChild(el);
    return el;
  }

  function setStatus(statusEl, message) {
    if (statusEl) {
      statusEl.textContent = message;
    }
  }

  // ---------------------------------------------------------------------------
  // Link forwarding.
  // ---------------------------------------------------------------------------

  function sendToDesktop(statusEl, results) {
    var links = results && results.links ? results.links : [];

    if (!links || links.length === 0) {
      setStatus(statusEl, 'AutoExtract: no links to send');
      return;
    }

    setStatus(statusEl, 'AutoExtract: sending to desktop...');

    var body = JSON.stringify({
      detected: results.detection || null,
      links: links,
      sources: results.sources || [],
      pageUrl: location.href,
      pageTitle: document.title || '',
      sentAt: new Date().toISOString()
    });

    fetch(DEFAULT_DESKTOP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body
    })
      .then(function (response) {
        if (!response.ok) {
          setStatus(statusEl, 'AutoExtract: send failed: ' + response.status);
          return;
        }
        setStatus(statusEl, 'AutoExtract: sent ' + links.length + ' link' + (links.length === 1 ? '' : 's') + ' to desktop');
      })
      .catch(function (error) {
        console.warn('AutoExtract userscript: desktop send failed.', error);
        setStatus(statusEl, 'AutoExtract: desktop not reachable');
      });
  }

  // ---------------------------------------------------------------------------
  // Main flow.
  // ---------------------------------------------------------------------------

  function run() {
    var detection = detect({ document: document, location: location });
    var results = detection ? extract({ document: document, location: location }) : { links: [], sources: [] };
    results.detection = detection;

    console.log('AutoExtract userscript: detection =', detection);
    console.log('AutoExtract userscript: links =', results.links.length);

    var statusEl = createStatusElement();
    setStatus(statusEl, 'AutoExtract: ' + results.links.length + ' link' + (results.links.length === 1 ? '' : 's') + ' found');

    if (results.links.length > 0) {
      sendToDesktop(statusEl, results);
    } else {
      setStatus(statusEl, 'AutoExtract: no supported links found on this page');
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run);
  } else {
    run();
  }
})();
