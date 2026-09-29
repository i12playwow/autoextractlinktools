// shared/index.js
//
// Shared detection and extraction logic for the Chrome extension and the
// userscript. Both browser-side runtimes should use this instead of duplicating
// site/player-specific parsing.
//
// Browser API:
//   window.AutoExtract.detect(context)
//   window.AutoExtract.extract(context)
//
// Build/packaging path:
//   The authoritative shared source lives at the repo root:
//     shared/index.js
//
//   The extension build step copies it into the extension package so it can be
//   loaded as an extension resource:
//     chrome-extension/build/make-shared.js
//     -> chrome-extension/shared/index.js
//
//   In the extension, the manifest lists shared/index.js before content.js (and
//   before popup.js's loader), so window.AutoExtract is available directly in
//   the content-script isolated world. Do not inject this file into the page:
//   page-world copies are invisible to the content script and MV3 blocks
//   chrome-extension:// script tags without web_accessible_resources.
//
// Detection modes (in precedence order):
//   1. Stub contract (temporary, for tests):
//      If the page contains elements marked with [data-autoextract], they are
//      treated as explicit fake link sources:
//        - data-autoextract-url, data-autoextract-type, and
//          data-autoextract-server attributes are used when present.
//      This mode is unchanged so test-pages/_bridge_expected.json stays valid.
//   2. YouTube (site-specific):
//      On *.youtube.com pages, the inline script assigning
//      ytInitialPlayerResponse is located in the DOM and parsed (content
//      scripts cannot read page JS globals, but they can read inline script
//      text). streamingData.formats, streamingData.adaptiveFormats, and the
//      HLS/DASH manifest URLs are emitted as links. Formats gated behind
//      signatureCipher are counted but never emitted: forwarding them without
//      deciphering would produce dead 403 URLs.
//   3. Bilibili (site-specific):
//      On *.bilibili.com pages, the inline script assigning
//      window.__playinfo__ is located and parsed. data.dash.video/audio
//      entries (plus dolby/flac extras when present) are emitted with quality
//      labels, codecs, bitrate, and resolution; legacy data.durl entries
//      (complete muxed files on older videos) are emitted as video links.
//      The player streams via MSE, so blob: URLs are excluded from the
//      generic fallback on Bilibili pages, same as YouTube.
//   4. Generic media scan (fallback on every page):
//      The module scans for media on any page:
//        - <video>/<audio> elements (src attribute, or nested <source> children)
//        - standalone <source> elements
//        - anchors (<a href>) pointing at media file extensions
//      blob: and http(s) URLs are included; data: URLs are skipped because they
//      are not forwardable links. On YouTube specifically, blob: URLs are
//      excluded even in the fallback, because the player streams via MSE and
//      blob URLs are unusable outside the page.
//
// TODO:
//   - Add more site/player-specific rules (Vimeo) on top of the generic scan.
//   - Optional: implement signatureCipher deciphering (requires fetching and
//     evaluating YouTube player code; deliberately out of scope for now).

'use strict';

(function () {
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

  // Scan the document for generic media candidates. Returns a list of
  // { kind, el, raw, base } where kind is 'video', 'audio', or a classified
  // media type for anchors.
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

  // Stub contract extraction: [data-autoextract] markers are explicit fake
  // link sources. Behavior is intentionally identical to the original stub.
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
  // YouTube site-specific extraction
  // ---------------------------------------------------------------------------
  //
  // Watch pages embed the player payload as an inline script assigning
  // ytInitialPlayerResponse. Content scripts cannot see page-world JS globals,
  // but they can read inline script text from the DOM, so the assignment is
  // located and the JSON object is extracted with a string-and-brace-aware
  // scan, then JSON.parse'd.
  //
  // Ciphered formats (signatureCipher) are counted but never emitted: turning
  // them into links would require the player's deciphering algorithm, which
  // changes across player releases and needs fetching/evaluating player code.

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
  // Bilibili site-specific extraction
  // ---------------------------------------------------------------------------
  //
  // Video pages embed the streaming payload as an inline script assigning
  // window.__playinfo__ (a JSON object; newer builds under .data). DASH
  // entries carry relative-or-absolute CDN URLs that are directly fetchable
  // with the right Referer header, so they are emitted as-is. Legacy pages
  // (older videos) expose data.durl: a list of complete muxed files.

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

  // Generic extraction: real media elements and media anchors, deduplicated
  // by fully-resolved URL.
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

  function detect(context) {
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
  }

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

  function extract(context) {
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
  }

  if (typeof window !== 'undefined') {
    window.AutoExtract = {
      detect: detect,
      extract: extract,
      // Exposed for unit tests and tooling; not part of the public contract.
      _internal: {
        safeParseUrl: safeParseUrl,
        classifyUrl: classifyUrl,
        shouldIncludeUrl: shouldIncludeUrl,
        MEDIA_EXTENSIONS: MEDIA_EXTENSIONS,
        isYouTubeHost: isYouTubeHost,
        isBilibiliHost: isBilibiliHost,
        contextHost: contextHost,
        extractJsonAssignment: extractJsonAssignment,
        parsePlayerResponse: parsePlayerResponse,
        extractYouTube: extractYouTube,
        extractBilibili: extractBilibili,
        mergeSiteAndGeneric: mergeSiteAndGeneric
      }
    };
  }
})();
