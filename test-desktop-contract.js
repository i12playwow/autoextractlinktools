#!/usr/bin/env node
//
// test-desktop-contract.js
//
// Validates the desktop bridge contract that the popup and userscript rely on.
//
// This starts a temporary bridge that mirrors src/main.js behavior, sends
// representative payloads, and reports whether the contract holds.
//
// Contract under test:
//   - only POST / is accepted
//   - body must be valid JSON
//   - payload must have a links array of objects with non-empty string url
//   - valid payload: 200 { ok: true, received: true }
//   - invalid json: 400 { error: 'invalid json' }
//   - invalid payload: 400 { error: 'invalid payload' }
//   - wrong method/path: 404 { error: 'not found' }

'use strict';

const http = require('http');

const PORT = 3458;
const HOST = '127.0.0.1';
const BRIDGE_URL = 'http://' + HOST + ':' + PORT + '/';

function isValidLinkPayload(payload) {
  if (!payload || typeof payload !== 'object') {
    return false;
  }

  const links = payload.links;
  if (!Array.isArray(links)) {
    return false;
  }

  for (let i = 0; i < links.length; i++) {
    const link = links[i];
    if (!link || typeof link !== 'object') {
      return false;
    }
    if (typeof link.url !== 'string' || link.url.length === 0) {
      return false;
    }
  }

  return true;
}

function createBridgeServer() {
  return http.createServer((request, response) => {
    const url = request.url || '/';
    const method = request.method || 'GET';

    if (method !== 'POST' || url !== '/') {
      response.writeHead(404, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: 'not found', method: 'POST / required' }));
      return;
    }

    let body = '';

    request.on('data', (chunk) => {
      body += chunk.toString();
    });

    request.on('end', () => {
      let payload = null;

      try {
        payload = JSON.parse(body);
      } catch (error) {
        response.writeHead(400, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: 'invalid json' }));
        return;
      }

      if (!isValidLinkPayload(payload)) {
        response.writeHead(400, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: 'invalid payload' }));
        return;
      }

      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ ok: true, received: true }));
    });
  });
}

function postJSON(path, payload, rawBody) {
  return new Promise((resolve, reject) => {
    const body = rawBody !== undefined ? rawBody : JSON.stringify(payload);

    console.log('POST', path, '->', body);

    const request = http.request(
      {
        hostname: HOST,
        port: PORT,
        path: path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body)
        }
      },
      (response) => {
        let data = '';
        response.on('data', (chunk) => {
          data += chunk.toString();
        });
        response.on('end', () => {
          let parsed = null;
          try {
            parsed = JSON.parse(data);
          } catch (error) {
            parsed = data;
          }
          resolve({
            status: response.statusCode,
            headers: response.headers,
            body: parsed,
            rawBody: data
          });
        });
      }
    );

    request.on('error', reject);
    request.write(body);
    request.end();
  });
}

async function runTests() {
  const results = [];

  function record(name, outcome) {
    results.push({ name, outcome });
  }

  function assert(name, condition, detail) {
    record(name, condition ? 'PASS' : 'FAIL');
    if (!condition) {
      console.log('FAIL:', name, detail || '');
    }
  }

  await new Promise((resolve) => {
    const server = createBridgeServer();

    server.listen(PORT, HOST, async () => {
      console.log('AutoExtract test bridge ready on ' + BRIDGE_URL);

      try {
        // 1. Valid payload matching the popup/userscript contract.
        const validPayload = {
          detected: { supported: true, type: 'stub', markerCount: 2 },
          links: [
            { server: 'stub', type: 'video', url: 'http://example.com/video.mp4' },
            { server: 'stub', type: 'audio', url: 'http://example.com/audio.m4a' }
          ],
          sources: [{ element: 'div', attributes: ['data-autoextract', 'data-autoextract-url'] }],
          pageUrl: 'http://localhost:9999/test',
          pageTitle: 'Test Page',
          sentAt: new Date().toISOString()
        };

        const validResponse = await postJSON('/', validPayload);
        assert(
          'Valid payload is accepted',
          validResponse.status === 200 && validResponse.body && validResponse.body.ok === true && validResponse.body.received === true,
          JSON.stringify(validResponse)
        );

        // 2. Empty links array is valid as long as it is well-formed.
        const emptyLinksPayload = {
          detected: null,
          links: [],
          pageUrl: 'http://localhost:9999/test'
        };

        const emptyLinksResponse = await postJSON('/', emptyLinksPayload);
        assert(
          'Empty links array is accepted',
          emptyLinksResponse.status === 200 && emptyLinksResponse.body && emptyLinksResponse.body.ok === true,
          JSON.stringify(emptyLinksResponse)
        );

        // 3. Non-array links should be rejected.
        const badLinksPayload = {
          links: 'not-an-array',
          pageUrl: 'http://localhost:9999/test'
        };

        const badLinksResponse = await postJSON('/', badLinksPayload);
        assert(
          'Non-array links is rejected',
          badLinksResponse.status === 400,
          JSON.stringify(badLinksResponse)
        );

        // 4. Link with missing url should be rejected.
        const badLinkPayload = {
          links: [{ server: 'stub', type: 'video' }],
          pageUrl: 'http://localhost:9999/test'
        };

        const badLinkResponse = await postJSON('/', badLinkPayload);
        assert(
          'Link with missing url is rejected',
          badLinkResponse.status === 400,
          JSON.stringify(badLinkResponse)
        );

        // 5. Link with empty url should be rejected.
        const emptyUrlPayload = {
          links: [{ server: 'stub', type: 'video', url: '' }],
          pageUrl: 'http://localhost:9999/test'
        };

        const emptyUrlResponse = await postJSON('/', emptyUrlPayload);
        assert(
          'Link with empty url is rejected',
          emptyUrlResponse.status === 400,
          JSON.stringify(emptyUrlResponse)
        );

        // 6. Not an object payload should be rejected.
        const nonObjectPayload = 'hello';
        const nonObjectResponse = await postJSON('/', nonObjectPayload);
        assert(
          'Non-object payload is rejected',
          nonObjectResponse.status === 400,
          JSON.stringify(nonObjectResponse)
        );

        // 7. Bad JSON should be rejected.
        const badJSONResponse = await postJSON('/', 'not json{{{', 'not json{{{');
        assert(
          'Bad JSON is rejected',
          badJSONResponse.status === 400 && badJSONResponse.rawBody && badJSONResponse.rawBody.indexOf('invalid json') !== -1,
          JSON.stringify({ status: badJSONResponse.status, rawBody: badJSONResponse.rawBody, body: badJSONResponse.body })
        );

        // 8. Wrong method should return 404.
        const getReq = http.get({
          hostname: HOST,
          port: PORT,
          path: '/'
        }, (res) => {
          let data = '';
          res.on('data', (chunk) => {
            data += chunk.toString();
          });
          res.on('end', () => {
            let parsed = null;
            try {
              parsed = JSON.parse(data);
            } catch (error) {
              parsed = data;
            }
            assert(
              'Wrong method/path returns 404',
              res.statusCode === 404 && parsed && parsed.error === 'not found',
              JSON.stringify({ status: res.statusCode, body: parsed })
            );
            server.close(() => {
              console.log('AutoExtract test bridge stopped.');
              finish();
            });
          });
        });
        getReq.on('error', (error) => {
          assert('Wrong method/path returns 404', false, error.message);
          server.close(() => {
            console.log('AutoExtract test bridge stopped.');
            finish();
          });
        });
      } catch (error) {
        console.log('Test harness error:', error);
        server.close(() => {
          console.log('AutoExtract test bridge stopped.');
          finish();
        });
      }
    });
  });

  function finish() {
    const passed = results.filter((r) => r.outcome === 'PASS').length;
    const failed = results.filter((r) => r.outcome === 'FAIL').length;
    console.log('');
    console.log('Results: ' + passed + ' passed, ' + failed + ' failed');
    results.forEach((r) => {
      console.log('  ' + r.outcome + '  ' + r.name);
    });
    process.exit(failed === 0 ? 0 : 1);
  }
}

runTests().catch((error) => {
  console.log('Unhandled test harness error:', error);
  process.exit(1);
});
