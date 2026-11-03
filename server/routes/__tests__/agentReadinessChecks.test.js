// ── Agent Readiness: a real file, and a refused audit ───────────────────────
//
// Cabinet's site answers every address with its HTML page, so the protocol
// checks (API catalog, OAuth, MCP card, agent skills…) all "passed" and it
// scored 58 instead of about 20. And a site that rate-limited the audit was
// scored as failing every check: Eventgroove 0, 8x8 12.
//
// Run: node --test routes/__tests__/agentReadinessChecks.test.js

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { isJsonDocument, isSitemapDocument, auditBlocked, allowsEveryCrawler, agentLinkRels, siteOnce } = require('../agentReadinessAudit')._private;
const { WEIGHTS } = require('../agentReadinessAudit');

const reply = (status, type, data) => ({ status, headers: type ? { 'content-type': type } : {}, data });

test('an HTML page answering a protocol address is not the file', () => {
  assert.equal(isJsonDocument(reply(200, 'text/html; charset=utf-8', '<!doctype html><html>…')), false);
  assert.equal(isJsonDocument(reply(200, null, '<html><body>Not found</body></html>')), false);
});

test('a JSON document passes, parsed or as text', () => {
  assert.equal(isJsonDocument(reply(200, 'application/json', { issuer: 'https://x.test' })), true);
  assert.equal(isJsonDocument(reply(200, 'application/linkset+json', '{"linkset":[]}')), true);
  assert.equal(isJsonDocument(reply(200, 'text/plain', '{"name":"skills"}')), true);
});

test('a redirect or a missing file does not pass', () => {
  assert.equal(isJsonDocument(reply(301, 'text/html', '')), false);
  assert.equal(isJsonDocument(reply(404, 'application/json', {})), false);
  assert.equal(isJsonDocument(reply(200, 'text/plain', 'not json')), false);
});

test('a sitemap must be an XML sitemap, not a web page', () => {
  assert.equal(isSitemapDocument(reply(200, 'application/xml', '<?xml version="1.0"?><urlset>')), true);
  assert.equal(isSitemapDocument(reply(200, 'text/html', '<html><body>Home</body></html>')), false);
  assert.equal(isSitemapDocument(reply(200, 'text/html', '<?xml version="1.0"?><sitemapindex>')), true);
});

test('robots.txt and the page both refused is "not measured", not a fail', () => {
  assert.match(auditBlocked(reply(429), reply(429)), /refused the audit/);
  assert.match(auditBlocked({ status: null }, reply(403)), /refused the audit/);
  assert.match(auditBlocked(reply(503), reply(500)), /refused the audit/);
});

test('one answered request means the site was measured', () => {
  assert.equal(auditBlocked(reply(404), reply(429)), null, 'no robots.txt is a real answer');
  assert.equal(auditBlocked(reply(429), reply(200)), null);
});

// ── Fix 4.2: checks that could not pass, or passed for the wrong reason ──────

test('a robots.txt that lets every crawler in counts as an AI bot decision', () => {
  assert.equal(allowsEveryCrawler('User-agent: *\nAllow: /\n'), true);
  assert.equal(allowsEveryCrawler('User-agent: *\nDisallow: /admin\n'), true);
  assert.equal(allowsEveryCrawler(''), true);
  assert.equal(allowsEveryCrawler('User-agent: *\nDisallow: /\n'), false);
  // A root block for one named bot is not a block for everyone.
  assert.equal(allowsEveryCrawler('User-agent: Baiduspider\nDisallow: /\n\nUser-agent: *\nDisallow:\n'), true);
});

test('only Link headers that point an agent somewhere count', () => {
  assert.deepEqual(agentLinkRels('</app.css>; rel=preload; as=style, <https://cdn.x>; rel="preconnect"'), []);
  assert.deepEqual(agentLinkRels('</.well-known/api-catalog>; rel="api-catalog"'), ['api-catalog']);
  assert.deepEqual(agentLinkRels('</index.md>; rel="alternate"; type="text/markdown"'), ['alternate']);
});

test('the emerging protocols keep their weight (D3: future readiness)', () => {
  assert.equal(WEIGHTS.webmcp, 6);
  assert.equal(Object.values(WEIGHTS).reduce((a, b) => a + b, 0), 100);
});

test('a site file is fetched once for every page of a run', async () => {
  let calls = 0;
  async function fakeFetch() { calls += 1; return { status: 200 }; }
  await Promise.all([siteOnce(fakeFetch, 'https://once.test/robots.txt'), siteOnce(fakeFetch, 'https://once.test/robots.txt')]);
  await siteOnce(fakeFetch, 'https://once.test/robots.txt');
  assert.equal(calls, 1);
});
