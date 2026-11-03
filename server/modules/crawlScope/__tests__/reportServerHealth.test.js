// ── The report and the dashboard show one health score ──────────────────────
//
// The report scored the first 50,000 findings it could read; the dashboard
// scored them all. Eventgroove read 86 in its report and 58 on the dashboard.
// A capped findings response now carries the dashboard's own score, and the
// report shows it.
//
// Run: node --test modules/crawlScope/__tests__/reportServerHealth.test.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const routes = fs.readFileSync(path.join(__dirname, '../api/routes.js'), 'utf8');
const page = fs.readFileSync(path.join(__dirname, '../../../../client/src/pages/CrawlScopeRunPage.jsx'), 'utf8');

test('a capped findings response carries the score computed over every finding', () => {
  assert.match(routes, /if \(capped\) \{/);
  assert.match(routes, /overview\.siteHealth\(run, htmlPages, \[\], affected\)/);
  assert.match(routes, /serverHealth,\n/);
});

test('the report uses that score instead of scoring the partial list', () => {
  assert.match(page, /setServerHealth\(response\?\.capped \? response\.serverHealth \|\| null : null\)/);
  assert.match(page, /health: serverHealth\.score/);
});
