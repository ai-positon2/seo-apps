// ── Every tool fetcher goes through the egress guard ─────────────────────────
//
// services/safeEgress.js is only as good as its call sites. Each fetcher below
// takes a URL a signed-in user typed (or a page that URL linked to), and each
// used to call axios or Chromium directly — some behind a first-hop hostname
// check, some behind nothing. A live server on 127.0.0.1 stands in for the
// internal network: any hit on it is a request the guard should have refused.
//
// Run: node routes/__tests__/egressWiring.test.js

const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');
const http = require('node:http');

const contentEnhancement = require('../contentEnhancement');
const seoGeoAudit = require('../seoGeoAudit');
const imageAltAudit = require('../imageAltAudit');
const articleEnhancement = require('../articleEnhancement');
const agentReadiness = require('../agentReadinessAudit');
const onpage = require('../../checks/onpage');
const { discoverLinks } = require('../../utils/linkDiscovery');
const scraper = require('../../services/scraper');

let server;
let hits = [];
let internalUrl;

before(async () => {
  server = http.createServer((req, res) => { hits.push(req.url); res.end('<html><body>internal</body></html>'); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  internalUrl = `http://127.0.0.1:${server.address().port}/`;
});
after(() => new Promise((resolve) => server.close(resolve)));

const quiet = async (fn) => {
  const { error, warn, log } = console;
  console.error = console.warn = console.log = () => {};
  try { return await fn(); } finally { Object.assign(console, { error, warn, log }); }
};

// Takes the function itself rather than a closure, so a fetcher that is not
// exported fails here instead of throwing a TypeError that reads as "blocked".
async function neverReaches(label, fn, ...args) {
  assert.equal(typeof fn, 'function', `${label} is not exported for this test`);
  hits = [];
  await quiet(() => Promise.resolve().then(() => fn(...args)).catch(() => {}));
  assert.deepEqual(hits, [], `${label} fetched an internal address`);
}

test('content enhancement: the page fetch and evidence fetch', async () => {
  const { fetchHtml, enrichEvidenceResult } = contentEnhancement._private;
  await neverReaches('fetchHtml', fetchHtml, internalUrl);
  await neverReaches('enrichEvidenceResult', enrichEvidenceResult, { url: internalUrl }, 'statistics');
});

test('SEO & GEO audit: the page fetch', async () => {
  await neverReaches('seoGeoAudit.fetchUrl', seoGeoAudit._private?.fetchUrl, internalUrl);
});

test('image alt audit: the page fetch', async () => {
  await neverReaches('imageAltAudit.processUrl', imageAltAudit._private?.processUrl, internalUrl, {}, null);
});

test('article enhancement: the article fetch (also used by the Lite route)', async () => {
  await neverReaches('articleEnhancement.fetchArticle', articleEnhancement._private?.fetchArticle, internalUrl);
});

test('agent readiness: HTTP checks and link discovery', async () => {
  await neverReaches('agentReadiness.safeFetch', agentReadiness._private?.safeFetch, internalUrl);
  await neverReaches('discoverLinks', discoverLinks, internalUrl);
  await neverReaches('onpage.checkJsRendering', onpage._private?.checkJsRendering, internalUrl, { evaluate: async () => '' });
});

// ── Headless browser ────────────────────────────────────────────────────────

function fakeBrowser() {
  const pages = [];
  return {
    pages,
    newPage: async () => {
      const page = {
        gotos: [],
        handlers: [],
        setUserAgent: async () => {},
        setDefaultNavigationTimeout: () => {},
        setDefaultTimeout: () => {},
        setRequestInterception: async () => {},
        on: (event, fn) => { if (event === 'request') page.handlers.push(fn); },
        goto: async (url) => { page.gotos.push(url); },
        evaluate: async () => ({}),
        close: async () => {},
      };
      pages.push(page);
      return page;
    },
  };
}

async function decide(page, url) {
  let result;
  const req = {
    url: () => url,
    resourceType: () => 'document',
    abort: () => { result = 'aborted'; },
    continue: () => { result = 'continued'; },
  };
  for (const fn of page.handlers) await fn(req);
  return result;
}

for (const name of ['scrapeSinglePage', 'scrapeSinglePageDetailed']) {
  test(`scraper ${name}: a local file is never opened`, async () => {
    assert.equal(typeof scraper.__testables?.[name], 'function', `${name} is not exported for this test`);
    const browser = fakeBrowser();
    const result = await quiet(() => scraper.__testables[name](browser, 'file:///proc/self/environ'));
    assert.equal(result.success, false);
    assert.deepEqual(browser.pages.flatMap((p) => p.gotos), [], 'Chromium must not navigate to file://');
  });

  test(`scraper ${name}: every request the page makes is checked`, async () => {
    const browser = fakeBrowser();
    await quiet(() => scraper.__testables[name](browser, 'https://93.184.215.14/'));
    const [page] = browser.pages;
    assert.ok(page, 'a page was opened for a public URL');
    assert.equal(page.handlers.length, 1, 'one interception handler, so no request is resolved twice');
    assert.equal(await decide(page, 'http://169.254.169.254/latest/meta-data/'), 'aborted');
    assert.equal(await decide(page, 'https://93.184.215.14/article'), 'continued');
  });
}

// ── Routes that minted work before checking the host ────────────────────────
// The full Article Enhancement /init and agent readiness POST / refuse a
// private host with a 400 before any work starts. These three did not, so the
// work started and the guard above was the only thing in the way.

const articleEnhancementLite = require('../articleEnhancementLite');

function handlerFor(router, method, path) {
  const layer = router.stack.find((l) => l.route?.path === path && l.route.methods[method]);
  assert.ok(layer, `${method.toUpperCase()} ${path} exists`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function fakeRes() {
  const res = { statusCode: 200, body: undefined, headersFlushed: false };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  res.set = () => res;
  res.flushHeaders = () => { res.headersFlushed = true; };
  res.write = () => true;
  res.end = () => {};
  return res;
}

const fakeReq = (props) => ({ on: () => {}, user: { userId: 'u1', username: 'a@position2.com' }, ...props });

test('article enhancement lite /init refuses a private host', async () => {
  const res = fakeRes();
  await quiet(() => handlerFor(articleEnhancementLite, 'post', '/init')(fakeReq({ body: { url: internalUrl } }), res));
  assert.equal(res.statusCode, 400);
  assert.equal(res.body?.token, undefined, 'no stream token for a private host');
});

test('agent readiness /stream refuses a private host before streaming', async () => {
  const res = fakeRes();
  hits = [];
  await quiet(() => handlerFor(agentReadiness, 'post', '/stream')(fakeReq({ body: { url_homepage: internalUrl } }), res));
  assert.equal(res.statusCode, 400);
  assert.equal(res.headersFlushed, false, 'the stream never opened');
  assert.deepEqual(hits, []);
});

test('agent readiness /discover-links refuses a private host', async () => {
  const res = fakeRes();
  hits = [];
  await quiet(() => handlerFor(agentReadiness, 'get', '/discover-links')(fakeReq({ query: { url: internalUrl } }), res));
  assert.equal(res.statusCode, 400);
  assert.deepEqual(hits, []);
});

test('agent readiness on-page checks: a local file is never opened', async () => {
  const open = onpage._private?.openSlotPage;
  assert.equal(typeof open, 'function', 'openSlotPage is not exported for this test');
  const browser = fakeBrowser();
  await assert.rejects(quiet(() => open(browser, 'file:///proc/self/environ')));
  assert.deepEqual(browser.pages.flatMap((p) => p.gotos), []);
});

test('agent readiness on-page checks: every request the page makes is checked', async () => {
  const browser = fakeBrowser();
  await quiet(() => onpage._private.openSlotPage(browser, 'https://93.184.215.14/'));
  const [page] = browser.pages;
  assert.equal(page.handlers.length, 1);
  assert.equal(await decide(page, 'http://10.0.0.8/admin'), 'aborted');
  assert.equal(await decide(page, 'https://93.184.215.14/contact'), 'continued');
});
