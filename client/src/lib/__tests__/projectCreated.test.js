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

import {
  competitorEstimate, startsOnCreate, createdBanner, autostartOn, reviewPrompt,
} from '../projectCreated.js';

test('the estimate never exceeds the 4-competitor run and names the skipped ones', () => {
  const est = competitorEstimate(['a1.com', 'a2.com', 'a3.com', 'a4.com', 'a5.com']);
  assert.strictEqual(est.compared, 4);
  assert.strictEqual(est.units, 9775);
  assert.deepStrictEqual(est.skipped, ['a5.com']);
  assert.strictEqual(competitorEstimate(['x.com']).units, 3910);
});

test('with none typed, only the competitor search is spent; the comparison waits for acceptance', () => {
  const est = competitorEstimate([]);
  assert.strictEqual(est.autoDiscovers, true);
  assert.strictEqual(est.units, 200);
  assert.strictEqual(est.compared, 0);
  assert.strictEqual(est.suggests, 3);
  assert.strictEqual(est.unitsIfAccepted, 4 * 1955);
  assert.match(startsOnCreate({ maxUrls: 500, competitors: [] }).join('\n'), /suggest.*only after you accept/);
});

test('the form lists only the autostarts this deployment has on', () => {
  const lines = startsOnCreate({
    maxUrls: 500, competitors: ['x.com'],
    autostarts: { crawl: false, homepageAudits: true, aiVisibilityLite: false, competitorResearch: true },
  }).join('\n');
  assert.doesNotMatch(lines, /First site crawl/);
  assert.doesNotMatch(lines, /AI Visibility/);
  assert.match(lines, /Agent Readiness/);
  assert.match(lines, /Competitor Research against 1 competitor/);
  assert.strictEqual(autostartOn(null, 'crawl'), true, 'an older server that does not say runs everything');
  assert.strictEqual(autostartOn({ crawl: false }, 'crawl'), false);
});

test('review prompt: AI suggestions vs contributor proposals', () => {
  assert.strictEqual(reviewPrompt([]), '');
  assert.strictEqual(reviewPrompt([{ source: 'accepted' }, { source: 'accepted' }]), 'Review 2 suggested competitors');
  assert.strictEqual(reviewPrompt([{ source: 'user_entered' }]), '1 proposed competitor awaiting a decision');
});

test('the banner takes a top-level per-module homepage shape too', () => {
  const text = createdBanner({
    project: { name: 'Acme' },
    homepageAudits: { seo_geo: { scheduled: true }, agent_readiness: { scheduled: false } },
  });
  assert.match(text, /Started: the homepage SEO & GEO audit\./);
  assert.match(text, /Agent Readiness audit/);
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

test('the banner names the one homepage audit that started when the other did not', () => {
  const base = { project: { name: 'Acme' }, initialCrawl: { scheduled: true }, aiVisibilityLite: { scheduled: true }, competitorResearch: { scheduled: true } };
  const partial = createdBanner({
    ...base,
    homepageAudits: { scheduled: false, modules: { seo_geo: { scheduled: false }, agent_readiness: { scheduled: true, runId: 'r1' } } },
  });
  assert.match(partial, /Started: .*the homepage Agent Readiness audit/);
  assert.match(partial, /Not started: the homepage SEO & GEO audit\./);
  assert.doesNotMatch(partial, /SEO & GEO and Agent Readiness/);

  const none = createdBanner({ ...base, homepageAudits: { scheduled: false, modules: { seo_geo: { scheduled: false }, agent_readiness: { scheduled: false } } } });
  assert.match(none, /Not started: the homepage SEO & GEO audit and the homepage Agent Readiness audit\./);

  // An older server without `modules` keeps the combined line.
  assert.match(createdBanner({ ...base, homepageAudits: { scheduled: false } }), /Not started: the homepage SEO & GEO and Agent Readiness audits\./);
});
