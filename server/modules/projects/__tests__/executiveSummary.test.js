// ── Tests for the executive answer ───────────────────────────────────────────
//
// This layer says things in English to the person who signs off on the work, so
// it is the easiest place in the product to say something confident and wrong.
// Everything below protects one of five properties:
//
//   1. An absent measurement is never reported as good news (§16.11).
//   2. No number is invented that no measurement produced (§6.2) — in
//      particular, nothing here is ever denominated in money or traffic.
//   3. A serious defect outranks a flattering average.
//   4. What was NOT looked at is stated, every time (§30).
//   5. "Improved" is only ever claimed over pages that were audited twice.

const assert = require('assert');

const executive = require('../insights/executive');
const backlogModule = require('../insights/backlog');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed += 1;
  } catch (e) {
    console.log(`  ✗ ${name}`);
    console.log(`      ${e.message}`);
    failed += 1;
  }
}

function section(title) { console.log(`\n${title}`); }

// ── Fixtures ────────────────────────────────────────────────────────────────

const MODULE_KEYS = ['technical', 'hub_spoke', 'competitor', 'seo_geo', 'on_page', 'ai_visibility'];

/** Six module cards, all measured, scoring `score` unless overridden. */
function modules(overrides = {}) {
  return MODULE_KEYS.map((key) => ({
    key,
    label: key,
    status: 'completed',
    scored: true,
    score: 80,
    updatedAt: new Date().toISOString(),
    ...(overrides[key] || {}),
  }));
}

function overview({ mods = modules(), value = 80, scoredModules = 6, status = 'complete' } = {}) {
  return { modules: mods, composite: { value, scoredModules, totalModules: mods.length, status } };
}

/** Build a real backlog from real items, so `totals` is the shipped shape. */
function backlogOf(items, crawledPages = 100) {
  const built = backlogModule.buildBacklog({
    crawl: { internalPages: crawledPages },
    items: items.map((i, n) => ({
      key: i.key || `m:rule${n}`,
      moduleKey: 'seo_geo',
      moduleLabel: 'SEO & GEO',
      title: i.title || `Finding ${n}`,
      severity: i.severity,
      scope: i.scope || 'page',
      priority: null,
      pages: i.pages || [],
      pageCount: (i.pages || []).length,
      instanceCount: (i.pages || []).length,
      detail: null,
    })),
  });
  return { actions: built.actions, totals: built.totals };
}

const page = (n) => `https://example.com/p${n}`;
const somePages = (n, from = 0) => Array.from({ length: n }, (_, i) => page(i + from));

// ── 1. Nothing measured is never good news ──────────────────────────────────

section('An absent measurement is not a clean bill of health');

test('a project nothing has run against says so, and claims nothing else', () => {
  const mods = modules(Object.fromEntries(
    MODULE_KEYS.map((k) => [k, { status: 'not_run', scored: false, score: null, updatedAt: null }]),
  ));
  const s = executive.buildExecutiveSummary({
    overview: overview({ mods, value: null, scoredModules: 0, status: 'insufficient_data' }),
    backlog: backlogOf([]),
  });
  assert.strictEqual(s.verdict.state, 'not_measured');
  assert.match(s.verdict.sentence, /nothing to report/i);
  // The three words that would be a lie here.
  assert.doesNotMatch(s.verdict.sentence, /healthy|good shape|no issues/i);
  assert.strictEqual(s.standing.score, null);
  assert.strictEqual(s.confidence.level, 'none');
});

test('a module that has produced findings but no score is still "audited"', () => {
  // Hub and Spoke reports findings and has no rubric. Calling that project
  // "not audited yet" is wrong in the direction that loses trust fastest.
  const mods = modules(Object.fromEntries(
    MODULE_KEYS.map((k) => [k, { status: k === 'hub_spoke' ? 'completed' : 'not_run', scored: false, score: null }]),
  ));
  const s = executive.buildExecutiveSummary({
    overview: overview({ mods, value: null, scoredModules: 0, status: 'insufficient_data' }),
    backlog: backlogOf([{ severity: 'warning', pages: somePages(2) }]),
  });
  assert.notStrictEqual(s.verdict.state, 'not_measured');
  assert.strictEqual(s.standing.score, null);
  assert.match(s.standing.basis, /no module has produced a score/i);
});

test('a score is never minted here — the composite is echoed', () => {
  const s = executive.buildExecutiveSummary({
    overview: overview({ value: 73, scoredModules: 4, status: 'partial' }),
    backlog: backlogOf([{ severity: 'warning', pages: somePages(3) }]),
  });
  assert.strictEqual(s.standing.score, 73);
  assert.strictEqual(s.standing.scoredModules, 4);
  assert.strictEqual(s.standing.status, 'partial');
});

// ── 2. Nothing is denominated in money or traffic ───────────────────────────

section('No invented economics');

test('no block quotes money, traffic or a conversion figure', () => {
  const s = executive.buildExecutiveSummary({
    overview: overview({ value: 42 }),
    backlog: backlogOf([
      { severity: 'error', scope: 'template', pages: somePages(60) },
      { severity: 'warning', pages: somePages(8, 60) },
    ]),
  });
  const text = JSON.stringify(s);
  // §6.2: this product has no traffic or revenue data unless Search Console is
  // connected, and the backlog states that it is not. A currency figure in front
  // of the person who approves budget is the most expensive thing it could say.
  assert.doesNotMatch(text, /\$|revenue|USD|conversion rate|sessions lost|clicks lost/i);
  // Reach is stated in pages, and the layer says the two are not the same.
  assert.match(s.leverage.basis, /pages, not traffic/i);
});

test('reach is counted in pages and labelled as such', () => {
  const s = executive.buildExecutiveSummary({
    overview: overview(),
    backlog: backlogOf([{ severity: 'warning', scope: 'template', pages: somePages(40) }], 100),
  });
  assert.strictEqual(s.leverage.pagesAffected, 40);
  assert.strictEqual(s.leverage.crawledPages, 100);
  assert.strictEqual(s.leverage.siteShare, 40);
});

// ── 3. A serious defect outranks a flattering average ───────────────────────

section('An error outranks a good mean');

test('a high composite does not become "healthy" while errors are open', () => {
  // A mean hides a broken thing. 84 out of 100 with eleven pages returning 5xx
  // is not a healthy site, and saying so would be worse than saying nothing.
  const s = executive.buildExecutiveSummary({
    overview: overview({ value: 84 }),
    backlog: backlogOf([{ severity: 'error', pages: somePages(11) }]),
  });
  assert.strictEqual(s.verdict.state, 'at_risk');
  assert.match(s.verdict.headline, /action needed/i);
  // The flattering number is still reported — suppressed would be its own lie.
  assert.match(s.verdict.sentence, /84 out of 100/);
});

test('"in good shape" requires both a high score and no errors', () => {
  const s = executive.buildExecutiveSummary({
    overview: overview({ value: 88 }),
    backlog: backlogOf([{ severity: 'warning', pages: somePages(2) }]),
  });
  assert.strictEqual(s.verdict.state, 'healthy');
  assert.match(s.verdict.sentence, /88 out of 100/);
});

test('a low score with no errors reads as below par, not as broken', () => {
  const s = executive.buildExecutiveSummary({
    overview: overview({ value: 41 }),
    backlog: backlogOf([{ severity: 'notice', pages: somePages(5) }]),
  });
  assert.strictEqual(s.verdict.state, 'needs_attention');
  assert.doesNotMatch(s.verdict.sentence, /costing this site search visibility/i);
});

test('the bands match the ones the dashboard already colours by', () => {
  const band = (value) => executive.buildExecutiveSummary({
    overview: overview({ value }),
    backlog: backlogOf([]),
  }).standing.band;
  assert.strictEqual(band(80), 'good');
  assert.strictEqual(band(79), 'fair');
  assert.strictEqual(band(60), 'fair');
  assert.strictEqual(band(59), 'poor');
});

// ── 4. Leverage ─────────────────────────────────────────────────────────────

section('The leverage argument');

test('template-wide work is reported as a count AND a share', () => {
  const items = [
    ...Array.from({ length: 3 }, () => ({ severity: 'error', scope: 'template', pages: somePages(90) })),
    ...Array.from({ length: 7 }, (_, i) => ({ severity: 'warning', scope: 'page', pages: [page(i)] })),
  ];
  const s = executive.buildExecutiveSummary({ overview: overview(), backlog: backlogOf(items, 100) });
  assert.strictEqual(s.leverage.actions, 10);
  assert.strictEqual(s.leverage.templateWide, 3);
  assert.strictEqual(s.leverage.templateShare, 30);
  assert.match(s.leverage.sentence, /single template change/i);
});

test('an empty backlog produces no leverage sentence rather than a zero one', () => {
  const s = executive.buildExecutiveSummary({ overview: overview(), backlog: backlogOf([]) });
  assert.strictEqual(s.leverage.sentence, null);
  assert.strictEqual(s.leverage.actions, 0);
});

// ── 5. Priorities ───────────────────────────────────────────────────────────

section('What to do');

test('exactly three priorities, in the backlog\'s own order, never re-ranked', () => {
  const items = [
    { severity: 'notice', title: 'C', pages: somePages(1) },
    { severity: 'error', title: 'A', pages: somePages(2) },
    { severity: 'warning', title: 'B', pages: somePages(9) },
    { severity: 'notice', title: 'D', pages: somePages(50) },
    { severity: 'info', title: 'E', pages: somePages(1) },
  ];
  const built = backlogOf(items);
  const s = executive.buildExecutiveSummary({ overview: overview(), backlog: built });
  assert.strictEqual(s.priorities.length, 3);
  assert.deepStrictEqual(
    s.priorities.map((p) => p.title),
    built.actions.slice(0, 3).map((a) => a.title),
    'the executive view must not impose an ordering of its own',
  );
  assert.deepStrictEqual(s.priorities.map((p) => p.rank), [1, 2, 3]);
});

test('every priority carries the key that promotes it, and its own basis', () => {
  const s = executive.buildExecutiveSummary({
    overview: overview(),
    backlog: backlogOf([{ severity: 'error', scope: 'template', pages: somePages(30) }]),
  });
  const [top] = s.priorities;
  // Without the key the row cannot reach POST /insights/promote, which is the
  // path that turns it into a recommendation draft.
  assert.ok(top.key, 'a priority with no key is a dead end');
  assert.ok(top.basis, 'a rank with no stated basis is an ordering nobody can check');
  assert.ok(top.reach, 'a priority with no effort hint is a decision with half its inputs');
});

test('fewer than three findings yields fewer than three priorities', () => {
  const s = executive.buildExecutiveSummary({
    overview: overview(),
    backlog: backlogOf([{ severity: 'error', pages: somePages(1) }]),
  });
  assert.strictEqual(s.priorities.length, 1);
});

// ── 6. What was not looked at ───────────────────────────────────────────────

section('Confidence, and what is missing from it');

test('a module that never ran is named in the caveats', () => {
  const mods = modules({ ai_visibility: { status: 'not_run', scored: false, score: null, label: 'AI Visibility' } });
  const s = executive.buildExecutiveSummary({
    overview: overview({ mods, scoredModules: 5, status: 'partial' }),
    backlog: backlogOf([{ severity: 'warning', pages: somePages(2) }]),
  });
  assert.strictEqual(s.confidence.modulesCovered, 5);
  assert.ok(s.confidence.caveats.some((c) => c.includes('AI Visibility')),
    `AI Visibility is unmeasured and unnamed: ${JSON.stringify(s.confidence.caveats)}`);
});

test('a failed module is reported as failed, not as covered', () => {
  const mods = modules({ on_page: { status: 'failed', scored: false, score: null, label: 'On-Page' } });
  const s = executive.buildExecutiveSummary({
    overview: overview({ mods, scoredModules: 5, status: 'partial' }),
    backlog: backlogOf([]),
  });
  assert.ok(s.confidence.failed.some((m) => m.label === 'On-Page'));
  assert.notStrictEqual(s.confidence.level, 'high', 'a failed audit must cost confidence');
});

test('month-old evidence is described as dated', () => {
  const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
  const mods = modules(Object.fromEntries(MODULE_KEYS.map((k) => [k, { updatedAt: old }])));
  const s = executive.buildExecutiveSummary({
    overview: overview({ mods }),
    backlog: backlogOf([{ severity: 'warning', pages: somePages(1) }]),
  });
  assert.strictEqual(s.confidence.stale, true);
  assert.ok(s.confidence.caveats.some((c) => /month old/i.test(c)));
});

test('freshness is the newest evidence, not the oldest', () => {
  // One module not re-run must not make the whole audit read as stale.
  const old = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString();
  const now = new Date().toISOString();
  assert.strictEqual(
    executive.lastEvidenceAt([{ updatedAt: old }, { updatedAt: now }]),
    now,
  );
  assert.strictEqual(executive.lastEvidenceAt([{ updatedAt: null }]), null);
});

test('unattributed findings are excluded from the page figures and said to be', () => {
  const built = backlogModule.buildBacklog({
    crawl: { internalPages: 50 },
    items: [{
      key: 'm:aggregate', moduleKey: 'seo_geo', moduleLabel: 'SEO & GEO', title: 'Aggregate',
      severity: 'warning', scope: null, priority: null,
      pages: [], pageCount: null, instanceCount: 12, detail: null,
    }],
  });
  const s = executive.buildExecutiveSummary({
    overview: overview(),
    backlog: { actions: built.actions, totals: built.totals },
  });
  assert.strictEqual(s.leverage.pagesAffected, 0);
  assert.ok(s.confidence.caveats.some((c) => /not which pages/i.test(c)),
    `an unattributed finding must be declared: ${JSON.stringify(s.confidence.caveats)}`);
});

// ── 7. The trend ────────────────────────────────────────────────────────────

section('Direction of travel');

test('a first run is "nothing to compare", not "no change"', () => {
  const t = executive.summariseTrend({ modules: [{ state: 'first_run' }] });
  assert.strictEqual(t.state, 'first_run');
  assert.doesNotMatch(t.sentence, /no change|held steady|stable/i);
});

test('runs sharing no audited pages are not comparable, not flat', () => {
  const t = executive.summariseTrend({ modules: [{ state: 'not_comparable' }] });
  assert.strictEqual(t.state, 'not_comparable');
  assert.doesNotMatch(t.sentence, /no change|held steady/i);
});

test('pages that were not re-audited are declared beside the fix count', () => {
  const t = executive.summariseTrend({
    modules: [{
      state: 'compared',
      fixed: [{ ruleId: 'a' }, { ruleId: 'b' }],
      appeared: [],
      notRechecked: ['https://example.com/x', 'https://example.com/y', 'https://example.com/z'],
      score: { delta: 4 },
    }],
  });
  assert.strictEqual(t.fixed, 2);
  assert.strictEqual(t.direction, 'better');
  assert.ok(t.caveat && /3 pages/.test(t.caveat),
    'claiming fixes without saying what was not re-checked is the lie changes.js exists to prevent');
});

test('more new findings than fixes reads as worse, whatever the scores did', () => {
  const t = executive.summariseTrend({
    modules: [{
      state: 'compared',
      fixed: [{ ruleId: 'a' }],
      appeared: [{ ruleId: 'b' }, { ruleId: 'c' }],
      notRechecked: [],
      score: { delta: 2 },
    }],
  });
  assert.strictEqual(t.direction, 'worse');
});

test('score movement is counted by direction, never averaged across modules', () => {
  // The six scores are on six different scales — the dashboard's own caption
  // says so — so a mean of their deltas is a number about nothing.
  const t = executive.summariseTrend({
    modules: [
      { state: 'compared', fixed: [], appeared: [], notRechecked: [], score: { delta: 30 } },
      { state: 'compared', fixed: [], appeared: [], notRechecked: [], score: { delta: -1 } },
      { state: 'compared', fixed: [], appeared: [], notRechecked: [], score: { delta: -2 } },
    ],
  });
  assert.strictEqual(t.scoresUp, 1);
  assert.strictEqual(t.scoresDown, 2);
  assert.strictEqual(t.direction, 'worse', 'two modules down outweighs one big rise on another scale');
  assert.doesNotMatch(JSON.stringify(t), /"average"|"mean"/);
});

test('a null delta is not counted as flat', () => {
  const t = executive.summariseTrend({
    modules: [{ state: 'compared', fixed: [], appeared: [], notRechecked: [], score: { delta: null, direction: 'unknown' } }],
  });
  assert.strictEqual(t.scoresUp, 0);
  assert.strictEqual(t.scoresDown, 0);
});

// ── 8. Shape ────────────────────────────────────────────────────────────────

section('Contract');

test('every block states what it was built from', () => {
  const s = executive.buildExecutiveSummary({
    overview: overview({ value: 70 }),
    backlog: backlogOf([{ severity: 'warning', pages: somePages(4) }]),
  });
  for (const block of ['verdict', 'standing', 'leverage']) {
    assert.ok(s[block].basis, `${block} has no stated basis`);
  }
  assert.ok(s.generatedAt);
});

test('it survives a completely empty input rather than throwing', () => {
  // The dashboard must not go blank because a project has no rows yet.
  const s = executive.buildExecutiveSummary({ overview: null, backlog: null });
  assert.strictEqual(s.verdict.state, 'not_measured');
  assert.strictEqual(s.priorities.length, 0);
  assert.strictEqual(s.confidence.modulesTotal, 0);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
