// ── "Critical" means it lowers a score ──────────────────────────────────────
//
// 17 of 19 projects read "Action needed — N critical issues are costing this
// site search visibility", triggered by findings that cost nothing. Centered
// Health (Tech 84, SEO & GEO 89) was told cleaner competitors would out-rank
// it, because the overall figure included Competitor and AI Visibility.
//
// Run: node --test modules/projects/__tests__/verdictCosting.test.js

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { buildVerdict, buildPriorities } = require('../insights/executive');
const { buildComposite } = require('../overview');

test('errors that cost no points do not make a site "at risk"', () => {
  const v = buildVerdict({
    composite: 82,
    everRun: true,
    totals: { bySeverity: { error: 4, warning: 2 }, criticalCosting: 0, errorsNotCosting: 4, pagesWithErrors: 7850 },
  });
  assert.notEqual(v.state, 'at_risk');
  assert.match(v.sentence, /4 other error-level findings are listed but do not affect any score/);
});

test('costing errors are counted on audited pages only', () => {
  const v = buildVerdict({
    composite: 60,
    everRun: true,
    totals: { bySeverity: { error: 6 }, criticalCosting: 2, pagesWithCostingErrors: 9, pagesWithErrors: 7850 },
  });
  assert.equal(v.state, 'at_risk');
  assert.match(v.sentence, /2 critical issues are lowering this site's scores right now, across 9 audited pages/);
  assert.doesNotMatch(v.sentence, /7,850/);
});

test('the overall figure averages the site-quality modules only', () => {
  const m = (key, score) => ({ key, scored: true, score });
  const composite = buildComposite([
    m('technical', 84), m('seo_geo', 89), m('agent_readiness', 30), m('hub_spoke', 60),
    m('competitor', 0), m('ai_visibility_lite', 0),
  ]);
  assert.equal(composite.value, Math.round((84 + 89 + 30 + 60) / 4));
  assert.equal(composite.totalModules, 4);
});

test('Agent Readiness is never named the weakest area to raise', () => {
  const areas = [
    { key: 'agent_readiness', label: 'Agent Readiness', score: 22, band: 'poor' },
    { key: 'hub_spoke', label: 'Hub and Spoke', score: 51, band: 'poor' },
  ];
  const v = buildVerdict({ composite: 55, everRun: true, totals: { bySeverity: {}, criticalCosting: 0 }, areas });
  assert.doesNotMatch(v.sentence, /Agent Readiness is the weakest/);
  assert.match(v.sentence, /Hub and Spoke is the weakest area, at 51\/100/);
  const priorities = buildPriorities([], areas);
  assert.ok(!priorities.some((p) => /Agent Readiness/.test(p.title)));
});

test('one fresh run does not hide that the scores are old', () => {
  // SoundHound: every score from 30 Sep; a failed AI Visibility run on 13 Oct
  // suppressed the "over a month old" caveat.
  const { buildConfidence } = require('../insights/executive');
  const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
  const fresh = new Date(Date.now() - 86_400_000).toISOString();
  const c = buildConfidence({
    modules: [
      { key: 'technical', label: 'Tech Audit', scored: true, score: 26, status: 'completed', updatedAt: old },
      { key: 'ai_visibility_lite', label: 'AI Visibility', scored: false, score: null, status: 'failed', updatedAt: fresh },
    ],
    totals: {},
    lastAt: fresh,
  });
  assert.equal(c.stale, true);
  assert.ok(c.caveats.some((line) => /^Tech Audit \(\d+ \w+\) is over a month old/.test(line)), c.caveats.join(' | '));
});
