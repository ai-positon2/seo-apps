// ── The health score and the panel that shows its working ────────────────────
//
// Run: npm test --prefix client   (or node --test client/src/**/__tests__)
//
// These are pure functions over plain data, which is why they are testable at
// all: healthMetrics takes crawl results and findings, and the two presenters
// take its output. Nothing here renders a component.
//
// The property that matters is in `the parts add up to the whole`. The panel in
// components/crawlScope/report/OverviewPanel.jsx exists to show the formula
// behind a score a client is asked to trust — and it printed a total that
// disagreed with the score, because `health` rounds once at the end and the
// breakdown used to round each band separately. A score of 78 sat beside the
// words "How the 23 points were lost".

import { test } from 'node:test';
import assert from 'node:assert';

import {
  healthMetrics, healthScoreBreakdown, healthScoreExplanation,
} from '../crawlHelpers.js';

/** `html` internal HTML pages, the first N of each severity carrying an issue. */
function pages(html, { errors = 0, warnings = 0, notices = 0 } = {}) {
  return Array.from({ length: html }, (_, i) => {
    const issues = [];
    if (i < errors) issues.push({ severity: 'error' });
    if (i < warnings) issues.push({ severity: 'warning' });
    if (i < notices) issues.push({ severity: 'notice' });
    return { url: `https://example.com/${i}`, scope: 'Internal', contentType: 'text/html', issues };
  });
}

const totalLost = (metrics) => healthScoreBreakdown(metrics).reduce((sum, b) => sum + b.points, 0);

test('the parts add up to the whole, for every shape of crawl', () => {
  // Exhaustive over a range wide enough to cover every rounding boundary the
  // three weights can produce. A sampled version of this passed before the fix.
  let checked = 0;
  for (let html = 1; html <= 40; html += 1) {
    for (let errors = 0; errors <= html; errors += 1) {
      for (let warnings = 0; warnings <= html; warnings += 1) {
        for (let notices = 0; notices <= html; notices += 1) {
          const metrics = healthMetrics(pages(html, { errors, warnings, notices }), []);
          assert.strictEqual(
            totalLost(metrics), 100 - metrics.health,
            `${html} pages / ${errors}e ${warnings}w ${notices}n: score ${metrics.health} `
            + `but the breakdown says ${totalLost(metrics)} points were lost`,
          );
          checked += 1;
        }
      }
    }
  }
  assert.ok(checked > 10000, `only ${checked} combinations were checked`);
});

test('the case that shipped broken: two pages, one in error', () => {
  const metrics = healthMetrics(pages(2, { errors: 1 }), []);
  assert.strictEqual(metrics.health, 78);
  // Was 23. Half the site being in error is 22.5 points of a 45-point weight,
  // and the score kept the 22.
  assert.strictEqual(totalLost(metrics), 22);
});

test('no band is ever credited with a negative deduction', () => {
  for (let html = 1; html <= 12; html += 1) {
    for (let errors = 0; errors <= html; errors += 1) {
      const metrics = healthMetrics(pages(html, { errors, warnings: html, notices: html }), []);
      for (const band of healthScoreBreakdown(metrics)) {
        assert.ok(band.points >= 0, `${band.label} deducted ${band.points}`);
      }
    }
  }
});

test('a band with no affected pages deducts nothing', () => {
  const metrics = healthMetrics(pages(10, { errors: 3 }), []);
  const byLabel = Object.fromEntries(healthScoreBreakdown(metrics).map((b) => [b.label, b]));
  assert.strictEqual(byLabel.Warnings.points, 0);
  assert.strictEqual(byLabel.Notices.points, 0);
  // Every band is listed even at zero: the panel is meant to read as the whole
  // formula, not only the parts that hurt.
  assert.strictEqual(healthScoreBreakdown(metrics).length, 3);
});

test('a clean crawl scores 100 and deducts nothing', () => {
  const metrics = healthMetrics(pages(25), []);
  assert.strictEqual(metrics.health, 100);
  assert.strictEqual(totalLost(metrics), 0);
  assert.match(healthScoreExplanation(metrics), /clean 100/);
});

test('no HTML pages is not scored, rather than scored zero', () => {
  // §16.11: an absent measurement must never be reported as a bad one. A crawl
  // that fetched only redirects and images has nothing to score.
  const metrics = healthMetrics([{ url: 'https://example.com/a.png', scope: 'Internal', contentType: 'image/png', issues: [] }], []);
  assert.strictEqual(metrics.health, null);
  assert.deepStrictEqual(healthScoreBreakdown(metrics), []);
  assert.match(healthScoreExplanation(metrics), /Run a crawl/);
});

test('external results are outside the score entirely', () => {
  const internal = pages(4, { errors: 2 });
  const withExternal = [
    ...internal,
    { url: 'https://other.example/', scope: 'External', contentType: 'text/html', issues: [{ severity: 'error' }] },
  ];
  assert.strictEqual(
    healthMetrics(withExternal, []).health,
    healthMetrics(internal, []).health,
    'a broken link on somebody else\'s site must not move this site\'s score',
  );
});

test('the explanation quotes the same deductions the panel draws', () => {
  // These were two independent computations of one number and could disagree.
  const metrics = healthMetrics(pages(7, { errors: 3, warnings: 5, notices: 2 }), []);
  const sentence = healthScoreExplanation(metrics);
  for (const band of healthScoreBreakdown(metrics)) {
    if (!band.pages) continue;
    assert.ok(
      sentence.includes(`−${band.points} from ${band.pages} page(s)`),
      `the panel deducts ${band.points} for ${band.label}, the sentence says "${sentence}"`,
    );
  }
  assert.ok(sentence.includes(`${metrics.health} out of 100`), sentence);
});

test('only page-scoped findings count towards the per-page bands', () => {
  // A sitewide misconfiguration is one problem, not one per page, and inflating
  // the page tally with it would deduct up to 45 points for a single robots.txt.
  const results = pages(10);
  const findings = [
    { url: 'https://example.com/0', severity: 'error', scope: 'page' },
    { url: 'https://example.com/', severity: 'error', scope: 'site' },
    { url: 'https://example.com/app.css', severity: 'error', scope: 'resource' },
  ];
  assert.strictEqual(healthMetrics(results, findings).affectedErrorPages, 1);
});
