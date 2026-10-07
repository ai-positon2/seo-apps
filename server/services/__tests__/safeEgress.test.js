// ── Outbound fetches to user-supplied URLs ───────────────────────────────────
//
// The tool routes (content enhancement, SEO & GEO, image alt, article
// enhancement, agent readiness) and the headless scraper fetch whatever URL a
// signed-in user types. Checking only the first hostname is not enough: a
// public page that answers "302 Location: http://169.254.169.254/" sent axios
// straight into this server's own network, and a file:// URL handed to
// Chromium read the local disk. These tests pin that every hop is checked.
//
// The local servers below listen on 127.0.0.1, which the guard itself refuses.
// That is the point of each test: a request that reaches the second server is
// a request that got past the guard.
//
// Run: node services/__tests__/safeEgress.test.js

const assert = require('node:assert/strict');
const { test } = require('node:test');
const http = require('node:http');
const axios = require('axios');

const {
  safeGet,
  safeAxiosConfig,
  assertRedirectAllowed,
  isBrowserRequestAllowed,
  guardPage,
} = require('../safeEgress');

function listen(handler) {
  return new Promise((resolve) => {
    const hits = [];
    const server = http.createServer((req, res) => {
      hits.push(req.url);
      handler(req, res);
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, hits, port: server.address().port, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

test('a URL on this machine is refused before any request is sent', async () => {
  const target = await listen((req, res) => res.end('internal'));
  try {
    await assert.rejects(safeGet(`http://127.0.0.1:${target.port}/`));
    assert.deepEqual(target.hits, [], 'the internal server must never be contacted');
  } finally { await target.close(); }
});

test('non-http schemes are refused', async () => {
  await assert.rejects(safeGet('file:///etc/passwd'));
  await assert.rejects(safeGet('ftp://example.com/'));
});

test('a redirect to a private IP literal is not followed', async () => {
  // First hop is allowed through by calling axios with the guarded config
  // directly (the pre-flight would refuse 127.0.0.1 before the redirect is
  // ever seen). The second hop is the one under test.
  // The target is a live server on a literal address, so a request that got
  // through would succeed rather than fail for some unrelated network reason.
  const internal = await listen((req, res) => res.end('secret'));
  const hop = await listen((req, res) => {
    res.writeHead(302, { Location: `http://127.0.0.1:${internal.port}/latest/meta-data/` });
    res.end();
  });
  try {
    await assert.rejects(
      axios.get(`http://127.0.0.1:${hop.port}/`, safeAxiosConfig({ timeout: 3000 })),
      /non-public address/,
    );
    assert.deepEqual(internal.hits, [], 'the redirect target must never be contacted');
  } finally {
    await hop.close();
    await internal.close();
  }
});

test('a redirect to a hostname that resolves privately is not followed', async () => {
  const internal = await listen((req, res) => res.end('secret'));
  const hop = await listen((req, res) => {
    res.writeHead(302, { Location: `http://localhost:${internal.port}/secret` });
    res.end();
  });
  try {
    await assert.rejects(axios.get(`http://127.0.0.1:${hop.port}/`, safeAxiosConfig({ timeout: 3000 })));
    assert.deepEqual(internal.hits, [], 'the redirect target must never be contacted');
  } finally {
    await hop.close();
    await internal.close();
  }
});

test('the guarded config keeps the caller\'s own options', () => {
  const config = safeAxiosConfig({ timeout: 1234, maxRedirects: 3, headers: { 'X-Test': '1' } });
  assert.equal(config.timeout, 1234);
  assert.equal(config.maxRedirects, 3);
  assert.equal(config.headers['X-Test'], '1');
  assert.equal(typeof config.lookup, 'function');
  assert.equal(typeof config.beforeRedirect, 'function');
  assert.equal(config.proxy, false, 'an environment proxy would resolve hosts the guard never sees');
});

test('redirect hops: private literals and odd schemes throw, public ones pass', () => {
  assert.throws(() => assertRedirectAllowed({ protocol: 'http:', hostname: '169.254.169.254' }));
  assert.throws(() => assertRedirectAllowed({ protocol: 'http:', hostname: '10.0.0.5' }));
  assert.throws(() => assertRedirectAllowed({ protocol: 'http:', hostname: '[::1]' }));
  assert.throws(() => assertRedirectAllowed({ protocol: 'file:', hostname: '' }));
  assert.doesNotThrow(() => assertRedirectAllowed({ protocol: 'https:', hostname: '93.184.215.14' }));
  // A hostname is resolved at connect time by the guarded lookup, not here.
  assert.doesNotThrow(() => assertRedirectAllowed({ protocol: 'https:', hostname: 'example.com' }));
});

test('browser requests: local files and private addresses are blocked', async () => {
  const cache = new Map();
  assert.equal(await isBrowserRequestAllowed('file:///proc/self/environ', cache), false);
  assert.equal(await isBrowserRequestAllowed('http://169.254.169.254/latest/', cache), false);
  assert.equal(await isBrowserRequestAllowed('http://127.0.0.1:5000/api/health', cache), false);
  assert.equal(await isBrowserRequestAllowed('http://localhost/', cache), false);
  assert.equal(await isBrowserRequestAllowed('chrome://settings', cache), false);
  assert.equal(await isBrowserRequestAllowed('not a url', cache), false);
});

test('browser requests: inline and public resources are allowed', async () => {
  const cache = new Map();
  assert.equal(await isBrowserRequestAllowed('data:image/png;base64,iVBORw0KGgo=', cache), true);
  assert.equal(await isBrowserRequestAllowed('about:blank', cache), true);
  assert.equal(await isBrowserRequestAllowed('https://93.184.215.14/', cache), true);
});

test('browser requests: each host is resolved once per page', async () => {
  const cache = new Map();
  await isBrowserRequestAllowed('http://localhost/a', cache);
  await isBrowserRequestAllowed('http://localhost/b', cache);
  assert.equal(cache.size, 1);
});

// A stand-in for a puppeteer page: records what the guard decided for each
// request, so the decision can be asserted without launching Chromium.
function fakePage() {
  const page = { intercepting: false, handlers: [] };
  page.setRequestInterception = async (on) => { page.intercepting = on; };
  page.on = (event, fn) => { if (event === 'request') page.handlers.push(fn); };
  page.send = async (url, type = 'document') => {
    const outcome = {};
    const req = {
      url: () => url,
      resourceType: () => type,
      abort: () => { outcome.result = 'aborted'; },
      continue: () => { outcome.result = 'continued'; },
    };
    for (const fn of page.handlers) await fn(req);
    return outcome.result;
  };
  return page;
}

test('a guarded page aborts requests for local files and private hosts', async () => {
  const page = fakePage();
  await guardPage(page);
  assert.equal(page.intercepting, true);
  assert.equal(page.handlers.length, 1, 'exactly one handler, so no request is resolved twice');
  assert.equal(await page.send('file:///proc/self/environ'), 'aborted');
  assert.equal(await page.send('http://169.254.169.254/latest/', 'xhr'), 'aborted');
  assert.equal(await page.send('https://93.184.215.14/'), 'continued');
});

test('a guarded page still applies the caller\'s own resource blocking', async () => {
  const page = fakePage();
  await guardPage(page, { block: (req) => req.resourceType() === 'image' });
  assert.equal(await page.send('https://93.184.215.14/logo.png', 'image'), 'aborted');
  assert.equal(await page.send('https://93.184.215.14/', 'document'), 'continued');
});
