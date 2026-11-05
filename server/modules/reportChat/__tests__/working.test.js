// ── A report's working: what each item cost ─────────────────────────────────
//
// The per-item costs the assistant quotes when asked "how exactly". Where the
// server owns the constants (SEO & GEO tiers, Agent Readiness weights, the AI
// Visibility blend) these check the costs are computed with them.
//
// Run: node --test modules/reportChat/__tests__/working.test.js

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { buildWorking } = require('../working');
const { methodologyFor, BY_SCREEN } = require('../methodology');
const { SCREENS } = require('../screens');

test('Tech Audit: each rule carries its arithmetic and a score-if-fixed', () => {
  const w = buildWorking('tech', {
    score: 65,
    pagesScored: 1376,
    bands: [
      { severity: 'error', exactPoints: 4.92, barShows: 5, pages: 100 },
      { severity: 'warning', exactPoints: 22.11, barShows: 22, pages: 1300 },
      { severity: 'notice', exactPoints: 7.52, barShows: 8, pages: 1300 },
    ],
    rules: [
      { rule: 'Links to redirected pages', severity: 'warning', pagesAffected: 1290, pagesCapped: 0, points: 9.375 },
      { rule: 'Huge page', severity: 'error', pagesAffected: 10, pagesCapped: 4, points: 0.2 },
    ],
  });
  assert.equal(w.exactScoreBeforeRounding, 65.45);
  assert.equal(w.lossCalculation, 'errors 4.92 + warnings 22.11 + notices 7.52 = 34.55 points lost in all');
  assert.equal(w.rules[0].calculation, '10 × 1,290 pages ÷ 1,376 pages scored = 9.38');
  assert.equal(w.rules[0].scoreIfOnlyThisWereFixed, 75);
  assert.deepEqual(w.topByPointsLost, ['Links to redirected pages (warning): 9.38 points, 1,290 pages', 'Huge page (error): 0.2 points, 10 pages']);
  assert.match(w.rules[1].calculation, /4 of those pages hit the 100-point cap/);
  assert.equal(w.rulesTotalBySeverity.warning.points, 9.38);
});

test('Tech Audit: a rule found only on unscored URLs says why it costs nothing', () => {
  const w = buildWorking('tech', {
    score: 90,
    pagesScored: 100,
    bands: [{ severity: 'warning', exactPoints: 10, barShows: 10, pages: 100 }],
    rules: [
      { rule: 'Links to redirected pages', severity: 'warning', pagesAffected: 100, urlsListedInReport: 140, points: 10 },
      { rule: 'Redirect chain', severity: 'warning', pagesAffected: 0, urlsListedInReport: 213, points: 0 },
    ],
  });
  assert.match(w.rules[1].calculation, /^0 points: none of the 213 URLs it is listed on is a scored page/);
  assert.match(w.rules[0].calculation, /listed on 140 URLs; only the 100 scored pages count/);
  assert.deepEqual(
    { ...w.rulesTotalBySeverity.warning },
    { rulesListed: 2, rulesCostingPoints: 1, rulesCostingNothing: 1, points: 10, calculation: 'sum of its 2 rules: 10 + 0 = 10; 1 of them cost 0' },
  );
});

test('Tech Audit: a severity total sums the exact points, not the rounded parts', () => {
  const w = buildWorking('tech', {
    score: 95, pagesScored: 100,
    bands: [{ severity: 'error', exactPoints: 4.91, barShows: 5, pages: 10 }],
    rules: [
      { rule: 'A', severity: 'error', pagesAffected: 5, points: 3.5174 },
      { rule: 'B', severity: 'error', pagesAffected: 3, points: 1.3663 },
      { rule: 'C', severity: 'error', pagesAffected: 1, points: 0.0291 },
    ],
  });
  assert.equal(w.rulesTotalBySeverity.error.points, 4.91);
  assert.match(w.rulesTotalBySeverity.error.calculation, /add to 4\.92; the exact total is 4\.91/);
});

test('SEO & GEO: a check is priced with the scorer\'s own tier and points', () => {
  const w = buildWorking('seogeo', {
    pageIntent: 'informational',
    overall: 70,
    composite: 70,
    areas: [{ key: 'title_meta', label: 'Title & Meta', axis: 'seo', score: 60, weight: 0.14, effective_weight: 0.2, points_lost: 8 }],
    checks: [
      { id: 'A1', category: 'Title Tag', name: 'Title present', status: 'fail', severity: 'error' }, // tier 3, 0 points
      { id: 'A6', category: 'Title Tag', name: 'Title brand', status: 'warning' }, // tier 1, 50 points
      { id: 'B1', category: 'Meta Description', name: 'Meta present', status: 'pass' }, // tier 2, 100
      { id: 'X1', category: 'Title Tag', name: 'Skipped', status: 'skipped' },
    ],
  });
  // Σ tier × 100 = (3 + 1 + 2) × 100 = 600.
  const a1 = w.checksCostingPoints.find((c) => c.id === 'A1');
  assert.equal(a1.tier, 3);
  assert.equal(a1.areaPointsLost, 50); // 3 × 100 ÷ 600 × 100
  assert.equal(a1.headlinePointsLost, 10); // × 0.2
  assert.match(a1.calculation, /tier 3 × \(100 − 0\) ÷ 600 × 100 = 50/);
  const a6 = w.checksCostingPoints.find((c) => c.id === 'A6');
  assert.equal(a6.areaPointsLost, 8.3); // 1 × 50 ÷ 600 × 100
  assert.ok(!w.checksCostingPoints.some((c) => c.id === 'B1' || c.id === 'X1'), 'passes and skipped checks cost nothing');
});

test('Agent Readiness: a failed check costs its weight over 100 + on-page points', () => {
  const w = buildWorking('agent', {
    site: { score: 40, onPageMax: 20 },
    httpChecks: [{ id: 'aibots', label: 'AI bots', cat: 'botaccess', status: 'fail' }, { id: 'robots', label: 'robots.txt', status: 'pass' }],
    onPageChecks: [{ id: 'form_labels', label: 'Form labels', status: 'fail', maxScore: 10, score: 0 }],
  });
  assert.equal(w.denominator, 120);
  const aibots = w.checks.find((c) => c.id === 'aibots');
  assert.equal(aibots.pointsLost, 11);
  assert.equal(aibots.totalScoreEffect, 9.2); // 11 ÷ 120 × 100
  assert.equal(w.checks.find((c) => c.id === 'robots').pointsLost, 0);
  assert.equal(w.checks.find((c) => c.id === 'form_labels').pointsLost, 10);
});

test('Agent Readiness: what-ifs start from HTTP + on-page points, not HTTP alone', () => {
  // The real Soteri Skin shape: 36 HTTP points + 14 on-page of 119 = 42.
  const w = buildWorking('agent', {
    site: { score: 42, httpScore: 36, onPageMax: 19 },
    httpChecks: [{ id: 'aibots', status: 'fail' }, { id: 'markdown', status: 'fail' }],
    onPageChecks: [{ id: 'form_labels', status: 'pass', maxScore: 10, score: 10 }, { id: 'captcha', status: 'fail', maxScore: 9, score: 4 }],
  });
  assert.equal(w.totalPointsEarned, 50);
  assert.equal(w.totalCalculation, 'round((36 HTTP + 14 on-page) ÷ 119 × 100) = 42');
  assert.equal(w.checks.find((c) => c.id === 'aibots').scoreIfOnlyThisWereFixed, 51); // (50 + 11) ÷ 119
});

test('SEO & GEO: the overall comes from the areas, spelled out', () => {
  const w = buildWorking('seogeo', {
    overall: 84,
    composite: 84,
    areas: [
      { key: 'geo_signals', label: 'GEO Signals', axis: 'geo', score: 54, weight: 0.13 },
      { key: 'indexability', label: 'Indexability', axis: 'seo', score: 100, weight: 0.14 },
    ],
    checks: [],
  });
  assert.equal(w.exactCompositeBeforeRounding, 77.85); // (7.02 + 14) ÷ 0.27
  assert.match(w.compositeCalculation, /^\(0\.13 × 54 \+ 0\.14 × 100\) ÷ 0\.27 = 77\.85, rounded to 78$/);
  assert.match(w.howOverallRelatesToSides, /NOT a blend/);
});

test('AI Visibility: readings reweight when one is missing', () => {
  const w = buildWorking('aivisLite', {
    score: 40,
    scoreBreakdown: [
      { key: 'named', weight: 40, included: true, value: 30 },
      { key: 'rank', weight: 25, included: true, value: 50 },
      { key: 'perception', weight: 20, included: false, value: null },
      { key: 'cited', weight: 15, included: true, value: 20 },
    ],
  });
  const named = w.readings.find((r) => r.reading === 'named');
  assert.equal(named.effectiveWeight, 0.5); // 40 ÷ 80
  assert.equal(named.contribution, 15);
  assert.equal(w.readings.find((r) => r.reading === 'perception').contribution, 0);
});

test('Competitor: ratio, cap and rank from the domains', () => {
  const w = buildWorking('comp', {
    trafficScore: { score: 50 },
    domains: [
      { domain: 'you.com', isClient: true, traffic: 5000 },
      { domain: 'big.com', traffic: 10000 },
      { domain: 'small.com', traffic: 1000 },
    ],
  });
  assert.equal(w.ratio, 0.5);
  assert.equal(w.rank, 2);
  assert.equal(w.of, 3);
  assert.match(w.calculation, /5000 ÷ 10000 × 100\)\) = min\(100, round\(50\)\) = 50/);
  assert.equal(w.exactPercentBeforeRounding, 50);
  const big = w.domains.find((d) => d.domain === 'big.com');
  assert.equal(big.trafficGapVsYou, 5000);
  assert.equal(big.gapCalculation, '10000 − 5000 = 5000 estimated monthly visits: they are ahead of you');
  assert.equal(w.domains.find((d) => d.domain === 'small.com').gapCalculation, '5000 − 1000 = 4000 estimated monthly visits: you are ahead of them');
});

test('Hub and Spoke: the health parts follow the v2 formula, with no size part', () => {
  const w = buildWorking('hub', { clusters: [{ name: 'Whitening', health: 62, isGap: false, members: 8, meanDepth: 2 }] });
  const parts = w.clusters[0].healthParts;
  assert.deepEqual(parts.hubPresent, { points: 30, max: 30 });
  assert.deepEqual(parts.clickDepth, { points: 15, max: 20 });
  assert.deepEqual(parts.vocabularyBreadthPlusHubSpokeLinking, { points: 17, max: 50 });
  assert.equal(w.clusters[0].calculation, '30 hub (of 30) + 15 click depth (of 20) + 17 hub vocabulary breadth and hub ↔ spoke linking together (of 50) = 62');
  assert.ok(!/size/i.test(JSON.stringify(parts)));
  assert.deepEqual(w.formula.parts.map((p) => p.max), [30, 20, 30, 20]);
  assert.equal(w.formula.total, 100);
});

test('Hub and Spoke: a suggested hub earns half the hub points; a missing one none', () => {
  const w = buildWorking('hub', { clusters: [
    { name: 'A', health: 40, hubConfidence: 'suggested', meanDepth: 4 },
    { name: 'B', health: 10, isGap: true, meanDepth: 4 },
  ] });
  const a = w.clusters.find((c) => c.name === 'A');
  const b = w.clusters.find((c) => c.name === 'B');
  assert.equal(a.healthParts.hubPresent.points, 15);
  assert.equal(a.healthParts.vocabularyBreadthPlusHubSpokeLinking.points, 15);
  assert.equal(b.healthParts.hubPresent.points, 0);
  assert.equal(b.healthParts.vocabularyBreadthPlusHubSpokeLinking.points, 0);
});

test('Hub and Spoke: clusters come weakest first', () => {
  const w = buildWorking('hub', { clusters: [{ name: 'A', health: 65 }, { name: 'B', health: 64 }, { name: 'C', health: 90 }] });
  assert.deepEqual(w.clusters.map((c) => c.name), ['B', 'A', 'C']);
});

test('junk input is reduced, never trusted', () => {
  assert.equal(buildWorking('tech', null), null);
  assert.equal(buildWorking('nope', { a: 1 }), null);
  const w = buildWorking('tech', { rules: [{ rule: 'x'.repeat(5000), severity: 'warning', points: 'lots' }] });
  assert.equal(w.rules[0].rule.length, 300);
  assert.equal(w.rules[0].points, null);
});

test('every screen has a scoring method', () => {
  for (const screen of Object.keys(SCREENS)) assert.ok(BY_SCREEN[screen], screen);
  assert.match(methodologyFor(null), /PROJECT OVERVIEW/);
  assert.match(methodologyFor('overview'), /TECH AUDIT[\s\S]*SEO & GEO[\s\S]*AGENT READINESS/);
});

test('reach a target: fewest fixes, costliest first, rounded only at the end', () => {
  const w = buildWorking('tech', {
    score: 65, pagesScored: 100,
    bands: [{ severity: 'warning', exactPoints: 34.54, barShows: 35, pages: 100 }],
    rules: [
      { rule: 'Small', severity: 'warning', pagesAffected: 3, points: 3.52 },
      { rule: 'Big', severity: 'warning', pagesAffected: 90, points: 9.38 },
      { rule: 'Mid', severity: 'warning', pagesAffected: 40, points: 4.34 },
    ],
  });
  // 65.46 + 9.38 + 4.34 = 79.18 → 79, so 80 needs the third.
  assert.equal(w.fewestFixesToReach[80], '3 fixes (the fewest that reach 80): Big, Mid, Small → the score becomes 83 (exact 82.7)');
  assert.equal(w.fewestFixesToReach[70], '1 fix (the fewest that reach 70): Big → the score becomes 75 (exact 74.84)');
  assert.equal(w.fewestFixesToReach[90], 'not reachable by fixing listed items alone');
  assert.equal(w.fewestFixesToReach[60], undefined, 'targets already met are left out');
});

test('Agent Readiness: points to earn for a target, not score points', () => {
  const w = buildWorking('agent', {
    site: { score: 42, httpScore: 36, onPageMax: 19 },
    httpChecks: [{ id: 'aibots', label: 'AI bot rules', status: 'fail' }, { id: 'markdown', label: 'Markdown', status: 'fail' }],
    onPageChecks: [{ id: 'form_labels', status: 'pass', maxScore: 10, score: 10 }, { id: 'captcha', status: 'fail', maxScore: 9, score: 4 }],
  });
  assert.equal(w.pointsToEarnToReach[60], 'earn 21 more points (50 + 21 = 71 of 119 → round(59.66) = 60)');
  assert.equal(w.fewestFixesToReach[60], '2 fixes (the fewest that reach 60): AI bot rules, Markdown → the score becomes 60 (exact 59.66)');
});

test('AI Visibility: brand comparison names ties as ties', () => {
  const w = buildWorking('aivisLite', {
    score: 0,
    scoreBreakdown: [],
    brands: [
      { name: 'cottonique', you: false, answersMeasured: 60, answersNamingIt: 0 },
      { name: 'Acme', you: true, answersMeasured: 60, answersNamingIt: 0 },
      { name: 'ducray', you: false, answersMeasured: 60, answersNamingIt: 6 },
    ],
  });
  assert.equal(w.brandComparison, 'ducray named in 6 of 60 answers (10%); cottonique named in 0 of 60 answers (0%); Acme (you) named in 0 of 60 answers (0%). Versus tracked brands: 1 ahead of you, 1 level with you, 0 behind you.');
});

test('SEO & GEO: the caps this page actually has, or none', () => {
  const none = buildWorking('seogeo', { overall: 84, composite: 84, areas: [], checks: [], sides: { seo: { score: 89, cap: null }, geo: { score: 75, cap: null } } });
  assert.equal(none.capsOnThisPage, 'none: no blocking cap applies to this page or either side.');
  const geo = buildWorking('seogeo', { overall: 84, composite: 84, areas: [], checks: [], sides: { geo: { score: 55, cap: { applied: true, value: 55, reasons: ['Answerability is 0/10'] } } } });
  assert.equal(geo.capsOnThisPage, 'GEO side held at 55 (Answerability is 0/10). No other cap applies to this page.');
});

test('Tech Audit (3.6): on capped pages the what-if uses the exact gain, and site rules are their own bar', () => {
  const w = buildWorking('tech', {
    score: 0,
    pagesScored: 1,
    bands: [{ severity: 'error', exactPoints: 100, barShows: 95, pages: 1 }, { severity: 'site', exactPoints: 5, barShows: 5, pages: 0 }],
    rules: [
      // One page with three error rules: 120 points, capped at 100, so each
      // rule's share is 33.3 — but fixing one leaves 80, a gain of 20.
      { rule: 'a', severity: 'error', pagesAffected: 1, pagesCapped: 1, points: 33.33, gainIfFixed: 20 },
      { rule: 'b', severity: 'error', pagesAffected: 1, pagesCapped: 1, points: 33.33, gainIfFixed: 20 },
      { rule: 'c', severity: 'error', pagesAffected: 1, pagesCapped: 1, points: 33.33, gainIfFixed: 20 },
      { rule: 'crawl-blocked', severity: 'error', pagesAffected: 0, points: 5, gainIfFixed: 5, siteLevel: 'site' },
    ],
    fewestFixesToReach: { 50: '3 fixes (the fewest that reach 50): a, b, c → the score becomes 95 (exact 95)' },
  });
  const a = w.rules.find((r) => r.rule === 'a');
  assert.equal(a.scoreIfOnlyThisWereFixed, Math.round(100 - 105 + 20), 'not 100 − 105 + 33.33');
  assert.equal(a.gainIfFixed, 20);
  const site = w.rules.find((r) => r.rule === 'crawl-blocked');
  assert.match(site.calculation, /charged once for the site/);
  assert.equal(w.rulesTotalBySeverity.site.points, 5);
  assert.equal(w.rulesTotalBySeverity.error.points, 99.99);
  assert.match(w.fewestFixesToReach[50], /a, b, c/, 'the report\'s exact plan is used as sent');
});
