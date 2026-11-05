// ── New project: what starts on Create, and what the banner says after ──────
//
// Run: npm test --prefix client
//
// The form named only Competitor Research and said crawls "run weekly once
// scheduled", while Create started a crawl, two audits and an AI Visibility
// measurement. Its price also ignored the 4-competitor run cap (5 typed ->
// "11,730 units" for a run that stops at 9,775).

import { test } from 'node:test';
import assert from 'node:assert';

import { competitorEstimate, startsOnCreate, createdBanner } from '../projectCreated.js';

test('the estimate never exceeds the 4-competitor run and names the skipped ones', () => {
  const est = competitorEstimate(['a1.com', 'a2.com', 'a3.com', 'a4.com', 'a5.com']);
  assert.strictEqual(est.compared, 4);
  assert.strictEqual(est.units, 9775);
  assert.deepStrictEqual(est.skipped, ['a5.com']);
  assert.strictEqual(competitorEstimate(['x.com']).units, 3910);
});

test('auto-discovery includes the competitor search in the estimate', () => {
  const est = competitorEstimate([]);
  assert.strictEqual(est.autoDiscovers, true);
  assert.strictEqual(est.units, 4 * 1955 + 200);
});

test('the form lists every job that starts on Create, with the crawl cap', () => {
  const lines = startsOnCreate({ maxUrls: 500, competitors: [] }).join('\n');
  assert.match(lines, /First site crawl, up to 500 pages/);
  assert.match(lines, /Agent Readiness/);
  assert.match(lines, /AI Visibility/);
  assert.match(lines, /Competitor Research/);
});

test('the banner names what started and what did not', () => {
  const text = createdBanner({
    project: { name: 'Acme', crawlOptions: { maxUrls: 300 } },
    initialCrawl: { scheduled: true },
    homepageAudits: { scheduled: true },
    aiVisibilityLite: { scheduled: false },
    competitorResearch: { scheduled: true, note: 'Competitor Research is queued.' },
  });
  assert.match(text, /^Acme created\./);
  assert.match(text, /Started: the first crawl \(up to 300 pages\), the homepage SEO & GEO and Agent Readiness audits and Competitor Research\./);
  assert.match(text, /Not started: AI Visibility setup and first measurement\./);
  assert.match(text, /Competitor Research is queued\.$/);
  assert.doesNotMatch(text, /schedule is off until/);
});
