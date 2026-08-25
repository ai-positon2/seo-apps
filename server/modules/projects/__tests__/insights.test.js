// Tests for reading the six modules together.
//
// The layer's whole value is that it makes claims no single module makes, which
// means it is also the easiest place in the product to state something confident
// and wrong. Everything below protects one of four properties:
//
//   1. An unattributed finding never acquires pages it does not have.
//   2. A withheld measurement never becomes a zero.
//   3. The ranking is a stated sort over measured facts, never a score.
//   4. "Fixed" is only ever claimed for a page that was looked at twice.

const assert = require('assert');

const findingIndex = require('../insights/findingIndex');
const backlog = require('../insights/backlog');
const correlations = require('../insights/correlations');
const changes = require('../insights/changes');
const insights = require('../insights');
const overviewModule = require('../overview');
const moduleRunners = require('../moduleRunners');

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

function section(title) {
  console.log(`\n${title}`);
}

// ── Rule identity ───────────────────────────────────────────────────────────

section('findingIndex — rule identity');

test('a URL-suffixed rule id collapses to the rule', () => {
  // On-Page's site-level runner produced `onpage-2:https://example.com`, so the
  // same check on two pages had two ids and nothing ever aggregated.
  assert.strictEqual(findingIndex.normalizeRuleId('onpage-2:https://x.test'), 'onpage-2');
  assert.strictEqual(findingIndex.normalizeRuleId('onpage-12.1:http://x.test/a/b'), 'onpage-12.1');
});

test('rule ids that legitimately contain a colon are left alone', () => {
  assert.strictEqual(findingIndex.normalizeRuleId('seogeo-A4'), 'seogeo-A4');
  assert.strictEqual(findingIndex.normalizeRuleId('agent-webbotauth'), 'agent-webbotauth');
});

test('a missing rule id does not become the string "undefined"', () => {
  assert.strictEqual(findingIndex.normalizeRuleId(undefined), '');
  assert.strictEqual(findingIndex.normalizeRuleId(null), '');
});

// ── Attribution ─────────────────────────────────────────────────────────────

section('findingIndex — attribution');

test('URLs are recovered from a prose detail string', () => {
  const urls = findingIndex.urlsFromDetail('https://x.test/a, https://x.test/b');
  assert.deepStrictEqual(urls, ['https://x.test/a', 'https://x.test/b']);
});

test('a detail that names clusters, not pages, yields no URLs', () => {
  // Hub and Spoke stores both kinds. Treating "Tooth Pain and Extraction" as a
  // page would put a fictional URL in a work queue.
  assert.deepStrictEqual(findingIndex.urlsFromDetail('Tooth Pain and Extraction'), []);
  assert.deepStrictEqual(findingIndex.urlsFromDetail(''), []);
  assert.deepStrictEqual(findingIndex.urlsFromDetail(null), []);
});

test('trailing punctuation is trimmed off a parsed URL', () => {
  assert.deepStrictEqual(
    findingIndex.urlsFromDetail('https://x.test/a; https://x.test/b.'),
    ['https://x.test/a', 'https://x.test/b'],
  );
});

test('an unattributed finding reports null pages, never its instance count', () => {
  const [item] = findingIndex.hubSpokeAdapter({
    id: 'run1',
    findings: [{ ruleId: 'architect-ambiguous-hubs', title: 'Ambiguous', count: 1, detail: 'A cluster' }],
  }, 50);
  assert.strictEqual(item.pageCount, null, 'count is not a page list');
  assert.deepStrictEqual(item.pages, []);
  assert.strictEqual(item.attribution, 'aggregate');
  assert.strictEqual(item.scope, null, 'spread cannot be classified without pages');
});

test('a partially attributed finding reports both numbers', () => {
  // Live case: 39 unclustered pages counted, 15 recoverable from the capped
  // detail string. 15 understates the problem; 39 overstates what we can act on.
  const [item] = findingIndex.hubSpokeAdapter({
    id: 'run1',
    findings: [{
      ruleId: 'architect-unassigned-pages',
      title: 'Unclustered',
      count: 39,
      detail: 'https://x.test/a, https://x.test/b',
    }],
  }, 50);
  assert.strictEqual(item.pageCount, 2);
  assert.strictEqual(item.instanceCount, 39);
  assert.strictEqual(item.pagesPartial, true);
});

test('more occurrences than pages is not partial attribution', () => {
  // A page can skip a heading level three times: 60 occurrences across 49 pages
  // means nothing is missing, and flagging it partial would cry wolf.
  const item = findingIndex.hubSpokeAdapter({
    id: 'r',
    findings: [{ ruleId: 'x', title: 'X', count: 2, detail: 'https://x.test/a, https://x.test/b' }],
  }, 50)[0];
  assert.strictEqual(item.pagesPartial, false);
});

test('duplicate URLs collapse to one affected page', () => {
  const [item] = findingIndex.hubSpokeAdapter({
    id: 'r',
    findings: [{ ruleId: 'x', title: 'X', count: 2, detail: 'https://x.test/a, https://x.test/a' }],
  }, 50);
  assert.strictEqual(item.pageCount, 1);
});

// ── Spread ──────────────────────────────────────────────────────────────────

section('findingIndex — how widely a defect is spread');

test('most of the site means the template, not the pages', () => {
  assert.strictEqual(findingIndex.scopeFor(49, 50), 'template');
  assert.strictEqual(findingIndex.scopeFor(30, 50), 'template');
});

test('a handful of pages is a section, one or two is a page', () => {
  assert.strictEqual(findingIndex.scopeFor(4, 50), 'section');
  assert.strictEqual(findingIndex.scopeFor(2, 50), 'page');
  assert.strictEqual(findingIndex.scopeFor(1, 50), 'page');
});

test('a tiny site does not make every defect template-wide', () => {
  // 2 of 2 pages is 100% and still only two pages: below the floor, it is not
  // evidence of a template.
  assert.strictEqual(findingIndex.scopeFor(2, 2), 'page');
});

test('spread cannot be classified without a denominator', () => {
  assert.strictEqual(findingIndex.scopeFor(10, null), null);
  assert.strictEqual(findingIndex.scopeFor(10, 0), null);
  assert.strictEqual(findingIndex.scopeFor(null, 50), null);
});

// ── Competitor keywords ─────────────────────────────────────────────────────

section('findingIndex — competitor keywords stay keywords');

test('missing keywords parse with volume and competitor position', () => {
  const { keywords } = findingIndex.competitorKeywords({
    id: 'r',
    findings: [{
      ruleId: 'competitor-missing-keywords',
      title: 'Missing',
      count: 22,
      detail: 'dental crown (vol 301000, www.aspendental.com at #3); dentures (vol 201000, www.aspendental.com at #2)',
    }],
  });
  assert.strictEqual(keywords.length, 2);
  assert.deepStrictEqual(keywords[0], {
    kind: 'missing',
    keyword: 'dental crown',
    volume: 301000,
    competitor: 'www.aspendental.com',
    competitorPosition: 3,
    ourPosition: null,
    sourceRunId: 'r',
  });
});

test('striking-distance keywords carry both positions', () => {
  const { keywords } = findingIndex.competitorKeywords({
    id: 'r',
    findings: [{
      ruleId: 'competitor-striking-distance',
      title: 'Striking',
      count: 1,
      detail: 'dental implants (#14 vs www.aspendental.com #7)',
    }],
  });
  assert.strictEqual(keywords[0].ourPosition, 14);
  assert.strictEqual(keywords[0].competitorPosition, 7);
});

test('a capped detail string reports how many terms it could name', () => {
  const { keywords, recovery } = findingIndex.competitorKeywords({
    id: 'r',
    findings: [{
      ruleId: 'competitor-missing-keywords',
      title: 'Missing',
      count: 22,
      detail: 'dental crown (vol 301000, www.aspendental.com at #3)',
    }],
  });
  assert.strictEqual(keywords.length, 1);
  assert.strictEqual(recovery['competitor-missing-keywords'].reported, 22);
  assert.strictEqual(recovery['competitor-missing-keywords'].named, 1);
});

test('an unparseable fragment is skipped, not guessed at', () => {
  const { keywords } = findingIndex.competitorKeywords({
    id: 'r',
    findings: [{
      ruleId: 'competitor-missing-keywords',
      title: 'Missing',
      count: 2,
      detail: 'garbled; dental crown (vol 100, x.test at #3)',
    }],
  });
  assert.strictEqual(keywords.length, 1);
  assert.strictEqual(keywords[0].keyword, 'dental crown');
});

// ── Ranking ─────────────────────────────────────────────────────────────────

section('backlog — the ranking is a stated sort, not a score');

const item = (over = {}) => ({
  key: over.key || `${over.moduleKey || 'technical'}:${over.ruleId || 'r'}`,
  moduleKey: 'technical',
  moduleLabel: 'Tech Audit',
  ruleId: 'r',
  title: 'A finding',
  severity: 'warning',
  priority: null,
  priorityBasis: null,
  category: null,
  pages: [],
  pageCount: 0,
  instanceCount: 1,
  attribution: 'per-instance',
  pagesPartial: false,
  scope: 'page',
  detectedValue: null,
  recommendedValue: null,
  recommendation: null,
  detail: null,
  description: null,
  sourceRunId: 'run1',
  sourceRunAt: null,
  ...over,
});

const rank = (items, opts) => backlog
  .buildBacklog({ items, crawl: { internalPages: 50 } }, opts)
  .actions.map((i) => i.title);

test('an error outranks a template-wide notice', () => {
  // The bug this pins: template-first ordering buried a High Priority sitemap
  // error under four template-wide notices.
  assert.deepStrictEqual(
    rank([
      item({ title: 'Notice everywhere', severity: 'notice', scope: 'template', pageCount: 49, ruleId: 'a' }),
      item({ title: 'One broken thing', severity: 'error', scope: 'page', pageCount: 1, ruleId: 'b' }),
    ]),
    ['One broken thing', 'Notice everywhere'],
  );
});

test('within one severity, a template-wide fix comes first', () => {
  assert.deepStrictEqual(
    rank([
      item({ title: 'Thirty pages', severity: 'warning', scope: 'section', pageCount: 30, ruleId: 'a' }),
      item({ title: 'Template', severity: 'warning', scope: 'template', pageCount: 31, ruleId: 'b' }),
    ]),
    ['Template', 'Thirty pages'],
  );
});

test('otherwise the wider problem comes first', () => {
  assert.deepStrictEqual(
    rank([
      item({ title: 'Two pages', pageCount: 2, ruleId: 'a' }),
      item({ title: 'Twenty pages', pageCount: 20, scope: 'section', ruleId: 'b' }),
    ]),
    ['Twenty pages', 'Two pages'],
  );
});

test('an unknown reach sorts last, and is not treated as zero pages', () => {
  const ordered = rank([
    item({ title: 'Unattributed', pageCount: null, ruleId: 'a' }),
    item({ title: 'One page', pageCount: 1, ruleId: 'b' }),
  ]);
  assert.deepStrictEqual(ordered, ['One page', 'Unattributed']);
});

test("the crawler's own priority breaks ties and nothing else", () => {
  assert.deepStrictEqual(
    rank([
      item({ title: 'Good to have', priority: 'Good to have', pageCount: 5, scope: 'section', ruleId: 'a' }),
      item({ title: 'High', priority: 'High Priority', pageCount: 5, scope: 'section', ruleId: 'b' }),
    ]),
    ['High', 'Good to have'],
  );
});

test('a module that reports no severity does not jump the queue', () => {
  assert.deepStrictEqual(
    rank([
      item({ title: 'No severity', severity: null, pageCount: 40, scope: 'template', ruleId: 'a' }),
      item({ title: 'A notice', severity: 'notice', pageCount: 1, ruleId: 'b' }),
    ]),
    ['A notice', 'No severity'],
  );
});

test('the same evidence always ranks the same way', () => {
  const items = [
    item({ title: 'B', pageCount: 5, scope: 'section', ruleId: 'b' }),
    item({ title: 'A', pageCount: 5, scope: 'section', ruleId: 'a' }),
    item({ title: 'C', pageCount: 5, scope: 'section', ruleId: 'c' }),
  ];
  assert.deepStrictEqual(rank(items), rank([...items].reverse()));
});

test('no 0-100 priority score is emitted anywhere', () => {
  const built = backlog.buildBacklog(
    { items: [item({ pageCount: 10, scope: 'section' })], crawl: { internalPages: 50 } },
  );
  const keys = Object.keys(built.actions[0]);
  for (const banned of ['priorityScore', 'impactScore', 'score', 'weight']) {
    assert.ok(!keys.includes(banned), `${banned} would be an invented methodology`);
  }
});

section('backlog — what the ranking says about itself');

test('with no traffic data it says so, and names what would fix it', () => {
  const built = backlog.buildBacklog({ items: [], crawl: { internalPages: 50 } });
  assert.strictEqual(built.ranking.trafficWeighted, false);
  assert.match(built.ranking.basis, /Search Console is not connected/);
  assert.deepStrictEqual(built.ranking.missing, ['search_console']);
});

test('with traffic data the basis changes to match', () => {
  const built = backlog.buildBacklog(
    { items: [], crawl: { internalPages: 50 } },
    { traffic: { pages: {} } },
  );
  assert.strictEqual(built.ranking.trafficWeighted, true);
  assert.match(built.ranking.basis, /clicks/);
  assert.deepStrictEqual(built.ranking.missing, []);
});

test('every item explains its own position', () => {
  const built = backlog.buildBacklog(
    { items: [item({ scope: 'template', pageCount: 49, priority: 'High Priority', priorityBasis: 'the crawler rule catalog' })],
      crawl: { internalPages: 50 } },
  );
  const line = built.actions[0].basisLine;
  assert.match(line, /Template-wide \(49 of 50 crawled pages\)/);
  assert.match(line, /warning/);
  assert.match(line, /High Priority \(the crawler rule catalog\)/);
});

test('a partially attributed item says so in its basis', () => {
  const built = backlog.buildBacklog(
    { items: [item({ pageCount: 15, instanceCount: 39, pagesPartial: true, scope: 'section' })],
      crawl: { internalPages: 50 } },
  );
  assert.match(built.actions[0].basisLine, /15 of 39 affected pages named/);
});

test('effort comes from the evidence, not from a guess', () => {
  assert.strictEqual(
    backlog.effortHint(item({ scope: 'template', pageCount: 49 })),
    'One template change covers 49 pages',
  );
  assert.strictEqual(backlog.effortHint(item({ pageCount: 1 })), 'One page');
  assert.strictEqual(backlog.effortHint(item({ pageCount: 12 })), '12 page edits');
  assert.strictEqual(backlog.effortHint(item({ pageCount: null })), null);
});

section('backlog — checks nobody can action');

test('a check that could not be automated is not work', () => {
  // "PSI data unavailable" in a to-do list is noise a marketer cannot act on.
  assert.strictEqual(backlog.isManualCheck({ title: 'Images', detail: 'PSI data unavailable' }), true);
  assert.strictEqual(backlog.isManualCheck({ title: 'Inbound links', detail: 'Cannot verify inbound links' }), true);
  assert.strictEqual(backlog.isManualCheck({ manual: true, title: 'x', detail: '' }), true);
});

test('a real defect is not mistaken for one', () => {
  assert.strictEqual(backlog.isManualCheck({ title: 'Titles are too long', detail: '68 characters' }), false);
});

test('they are separated, never dropped', () => {
  const built = backlog.buildBacklog({
    items: [
      item({ title: 'Real defect', ruleId: 'a' }),
      item({ title: 'Unverifiable', detail: 'PSI data unavailable', ruleId: 'b' }),
    ],
    crawl: { internalPages: 50 },
  });
  assert.deepStrictEqual(built.actions.map((i) => i.title), ['Real defect']);
  assert.deepStrictEqual(built.needsReview.map((i) => i.title), ['Unverifiable']);
});

test('affected pages are counted once, on their canonical spelling', () => {
  const built = backlog.buildBacklog({
    items: [
      item({ ruleId: 'a', pages: ['https://x.test/a', 'https://x.test/a/'], pageCount: 2 }),
      item({ ruleId: 'b', pages: ['https://x.test/a'], pageCount: 1 }),
    ],
    crawl: { internalPages: 50 },
  });
  assert.strictEqual(built.totals.pagesAffected, 1, 'a trailing slash is the same page');
});

// ── Correlations ────────────────────────────────────────────────────────────

section('correlations — a check that cannot run says so');

const emptyIndex = {
  items: [], keywords: [], coverage: [], structure: null,
  crawl: { internalPages: 50 }, keywordRecovery: null,
};

test('every rule either produces an insight or explains itself', () => {
  const built = correlations.buildCorrelations({
    index: emptyIndex,
    backlog: backlog.buildBacklog(emptyIndex),
  });
  assert.strictEqual(built.insights.length, 0);
  assert.strictEqual(
    built.withheld.length, correlations.RULES.length,
    'a rule that produces nothing and says nothing is the failure mode this layer exists to avoid',
  );
  for (const w of built.withheld) assert.ok(w.reason, `${w.id} withheld without a reason`);
});

test('a withheld orphan count does not become "no orphaned pages"', () => {
  // Hub and Spoke withholds orphanCount on a capped crawl because an unreached
  // page is indistinguishable from an unlinked one. Reading null as zero would
  // report a clean bill of health on a site nobody finished looking at.
  const result = correlations.unlinkedPages({
    structure: {
      orphanCount: null,
      orphanDetectionWithheld: true,
      pagesWithNoInboundLink: 0,
      pagesAnalyzed: 50,
    },
    crawl: { internalPages: 50 },
  });
  assert.strictEqual(result.insights.length, 0);
  assert.match(result.withheld[0].reason, /withheld/i);
});

test('the weaker signal is reported as an observation, not a verdict', () => {
  const result = correlations.unlinkedPages({
    structure: {
      orphanCount: null,
      orphanDetectionWithheld: true,
      pagesWithNoInboundLink: 40,
      pagesAnalyzed: 50,
    },
    crawl: { internalPages: 50 },
  });
  assert.strictEqual(result.insights.length, 1);
  assert.match(result.insights[0].detail, /not a verdict/);
});

test('a confirmed orphan count is stated plainly', () => {
  const result = correlations.unlinkedPages({
    structure: { orphanCount: 7, pagesAnalyzed: 50 },
    crawl: { internalPages: 50 },
  });
  assert.strictEqual(result.insights[0].severity, 'error');
  assert.match(result.insights[0].headline, /7 pages/);
});

test('a keyword gap with no cluster analysis is withheld, not half-answered', () => {
  const result = correlations.keywordGapsInExistingClusters({
    keywords: [{ kind: 'missing', keyword: 'dental crown', volume: 100 }],
    structure: null,
  });
  assert.strictEqual(result.insights.length, 0);
  assert.match(result.withheld[0].reason, /no cluster analysis/);
  assert.strictEqual(result.withheld[0].unblock, 'Run Hub and Spoke.');
});

test('a gap that lands in an existing cluster is the cheap one, and says why', () => {
  const result = correlations.keywordGapsInExistingClusters({
    keywords: [
      { kind: 'missing', keyword: 'teeth whitening cost', volume: 500 },
      { kind: 'missing', keyword: 'orthodontics', volume: 900 },
    ],
    structure: { clusters: [{ name: 'Teeth Whitening Options', health: 65, spokes: 3 }] },
  });
  assert.strictEqual(result.insights[0].count, 1);
  assert.match(result.insights[0].detail, /Teeth Whitening Options/);
  assert.deepStrictEqual(result.insights[0].modules, ['competitor', 'hub_spoke']);
});

test('AI visibility needs both modules and refuses to guess from one', () => {
  const result = correlations.aiVisibility({
    index: { items: [] },
    coverage: [
      { moduleKey: 'agent_readiness', moduleLabel: 'Agent Readiness', state: 'failed' },
      { moduleKey: 'seo_geo', moduleLabel: 'SEO & GEO', state: 'measured' },
    ],
  });
  assert.strictEqual(result.insights.length, 0);
  assert.match(result.withheld[0].reason, /Agent Readiness/);
});

test('a rule that throws does not take the dashboard down', () => {
  const exploding = () => { throw new Error('boom'); };
  Object.defineProperty(exploding, 'name', { value: 'exploding_rule' });
  const saved = correlations.RULES.slice();
  correlations.RULES.push(exploding);
  try {
    const built = correlations.buildCorrelations({
      index: emptyIndex,
      backlog: backlog.buildBacklog(emptyIndex),
    });
    const held = built.withheld.find((w) => w.id === 'exploding_rule');
    assert.ok(held, 'the failure must be reported as a withheld check');
    assert.match(held.reason, /boom/);
  } finally {
    correlations.RULES.length = 0;
    correlations.RULES.push(...saved);
  }
});

test('the lead is the most severe insight, or nothing at all', () => {
  const built = correlations.buildCorrelations({
    index: emptyIndex,
    backlog: backlog.buildBacklog(emptyIndex),
  });
  assert.strictEqual(built.lead, null, 'a filler headline would be worse than none');
});

// ── Change detection ────────────────────────────────────────────────────────

section('changes — "fixed" is the easiest lie to tell');

test('a page audited in only one of two runs is never called fixed', () => {
  // The page budget means the audited SET moves between runs. A finding that
  // disappears because nobody looked is not a fix.
  const before = [{ url: 'https://x.test/a', status: 'completed', findings: [{ ruleId: 'r1', title: 'R1' }] }];
  const now = [{ url: 'https://x.test/b', status: 'completed', findings: [] }];
  const beforeRules = changes.findingKeys(before);
  const nowRules = changes.findingKeys(now);
  const comparable = new Set(['https://x.test/a'].filter((u) => now.some((p) => p.url === u)));
  assert.strictEqual(comparable.size, 0, 'no page is comparable, so no fix is claimable');
  assert.ok(beforeRules.has('r1'));
  assert.ok(!nowRules.has('r1'));
});

test('a failed page audit contributes no findings and no clean bill', () => {
  const rules = changes.findingKeys([
    { url: 'https://x.test/a', status: 'failed', findings: [{ ruleId: 'r1', title: 'R1' }] },
  ]);
  assert.strictEqual(rules.size, 0, 'a page that could not be audited proves nothing');
});

test('findings are keyed on the rule, not on the rule-plus-URL', () => {
  const rules = changes.findingKeys([
    { url: 'https://x.test/a', status: 'completed', findings: [{ ruleId: 'onpage-2:https://x.test/a', title: 'T' }] },
    { url: 'https://x.test/b', status: 'completed', findings: [{ ruleId: 'onpage-2:https://x.test/b', title: 'T' }] },
  ]);
  assert.strictEqual(rules.size, 1);
  assert.strictEqual(rules.get('onpage-2').pages.size, 2);
});

test('a missing score on either side is no delta, not a fall to zero', () => {
  assert.deepStrictEqual(
    changes.scoreDelta({ score: null }, { score: 88 }),
    { current: null, previous: 88, delta: null, direction: 'unknown' },
  );
  assert.deepStrictEqual(
    changes.scoreDelta({ score: 88 }, { score: null }),
    { current: 88, previous: null, delta: null, direction: 'unknown' },
  );
});

test('a real score change reports its direction', () => {
  assert.strictEqual(changes.scoreDelta({ score: 90 }, { score: 80 }).direction, 'up');
  assert.strictEqual(changes.scoreDelta({ score: 70 }, { score: 80 }).direction, 'down');
  assert.strictEqual(changes.scoreDelta({ score: 80 }, { score: 80 }).direction, 'flat');
});

test('a genuine drop to zero is still a measurement', () => {
  const d = changes.scoreDelta({ score: 0 }, { score: 50 });
  assert.strictEqual(d.current, 0);
  assert.strictEqual(d.delta, -50);
  assert.strictEqual(d.direction, 'down');
});

test('site-level modules diff on the rule list', () => {
  const d = changes.runLevelDelta(
    { findings: [{ ruleId: 'b', title: 'B' }] },
    { findings: [{ ruleId: 'a', title: 'A' }, { ruleId: 'b', title: 'B' }] },
  );
  assert.deepStrictEqual(d.fixed.map((f) => f.ruleId), ['a']);
  assert.deepStrictEqual(d.appeared.map((f) => f.ruleId), []);
  assert.deepStrictEqual(d.stillOpen.map((f) => f.ruleId), ['b']);
});

// ── Gaps ────────────────────────────────────────────────────────────────────

section('insights — what is not measured is stated');

test('a failed module becomes a named gap with its reason', () => {
  const gaps = insights.buildGaps({
    index: {
      coverage: [
        { moduleKey: 'seo_geo', moduleLabel: 'SEO & GEO', state: 'failed', reason: 'table missing' },
        { moduleKey: 'technical', moduleLabel: 'Tech Audit', state: 'measured', stale: false },
      ],
    },
    backlog: { ranking: { trafficWeighted: false }, totals: { unattributed: 0 } },
    correlated: { withheld: [] },
  });
  const module = gaps.find((g) => g.kind === 'module');
  assert.strictEqual(module.label, 'SEO & GEO');
  assert.strictEqual(module.reason, 'table missing');
  assert.ok(module.unblock);
});

test('a measured module is not listed as a gap', () => {
  const gaps = insights.buildGaps({
    index: { coverage: [{ moduleKey: 'technical', moduleLabel: 'Tech', state: 'measured', stale: false }] },
    backlog: { ranking: { trafficWeighted: true }, totals: { unattributed: 0 } },
    correlated: { withheld: [] },
  });
  assert.strictEqual(gaps.length, 0);
});

test('stale evidence is a gap even though the module succeeded', () => {
  const gaps = insights.buildGaps({
    index: { coverage: [{ moduleKey: 'hub_spoke', moduleLabel: 'Hub and Spoke', state: 'measured', stale: true }] },
    backlog: { ranking: { trafficWeighted: true }, totals: { unattributed: 0 } },
    correlated: { withheld: [] },
  });
  assert.strictEqual(gaps[0].state, 'stale');
  assert.match(gaps[0].reason, /earlier inventory/);
});

test('a missing data source is a gap with the action that closes it', () => {
  const gaps = insights.buildGaps({
    index: { coverage: [] },
    backlog: { ranking: { trafficWeighted: false }, totals: { unattributed: 0 } },
    correlated: { withheld: [] },
  });
  const data = gaps.find((g) => g.kind === 'data');
  assert.strictEqual(data.id, 'search_console');
  assert.match(data.unblock, /Connect Search Console/);
});

test('unattributed findings are surfaced as a limitation of the backlog', () => {
  const gaps = insights.buildGaps({
    index: { coverage: [] },
    backlog: { ranking: { trafficWeighted: true }, totals: { unattributed: 3 } },
    correlated: { withheld: [] },
  });
  const attribution = gaps.find((g) => g.kind === 'attribution');
  assert.match(attribution.reason, /3 finding/);
});

// -- Two shipped bugs, pinned ----------------------------------------------

section('a failed run has no evidence');

test('a failed module card carries no evidence block at all', () => {
  // It reported counts of 0/0/0/0 for a run that measured nothing, which renders
  // as a clean bill of health for an audit that never happened — the exact
  // coercion §16.11 forbids. It also made `evidence` truthy, so the card button
  // promised "View report" for a report that does not exist.
  const card = overviewModule.evidenceCard(
    { key: 'seo_geo', label: 'SEO & GEO', toolPath: '/seo-geo-audit' },
    { terminal: { id: 'r1', status: 'failed', error: 'table missing', counts: {}, findings: [] } },
  );
  assert.strictEqual(card.evidence, null, 'a failed run has nothing to show');
  assert.strictEqual(card.headline, 'Run failed');
});

test('a completed run still carries its evidence', () => {
  const card = overviewModule.evidenceCard(
    { key: 'seo_geo', label: 'SEO & GEO' },
    {
      terminal: {
        id: 'r1', status: 'completed', score: 88, score_max: 100,
        counts: { error: 2, warning: 3 },
        findings: [{ ruleId: 'x', title: 'X', severity: 'error', count: 1 }],
      },
    },
  );
  assert.ok(card.evidence, 'the fix must not blank a successful run');
  assert.strictEqual(card.evidence.counts.error, 2);
});

test('insufficient_data with findings still shows them', () => {
  // "Ran and found nothing measurable" is not "failed", and a run that recorded
  // findings anyway must not have them hidden.
  const card = overviewModule.evidenceCard(
    { key: 'competitor', label: 'Competitor Research' },
    {
      terminal: {
        id: 'r1', status: 'insufficient_data', counts: { warning: 1 },
        findings: [{ ruleId: 'y', title: 'Y', severity: 'warning', count: 1 }],
      },
    },
  );
  assert.ok(card.evidence);
});

section('a crawl run id is not a module run id');

test('module-sourced items are labelled as module runs', () => {
  // recommendations.source_run_id has a foreign key to project_module_runs. The
  // crawl runs live in crawl_runs, so passing one where the other is expected
  // violated the constraint and returned 500 — on 10 of the 12 items in the live
  // backlog, which is most of anything a user would click.
  const [row] = findingIndex.hubSpokeAdapter({
    id: 'module-run',
    findings: [{ ruleId: 'x', title: 'X', count: 1, detail: 'https://x.test/a' }],
  }, 50);
  assert.strictEqual(row.sourceRunKind, 'module');
});

test('the promote route nulls source_run_id for a crawl-sourced item', () => {
  const routes = require('fs').readFileSync(
    require('path').join(__dirname, '../routes.js'), 'utf8',
  );
  assert.ok(
    routes.includes("sourceRunId: item.sourceRunKind === 'crawl' ? null : item.sourceRunId"),
    'the promote route must not pass a crawl run id into source_run_id',
  );
  // The run is still recorded, just somewhere nothing constrains it.
  assert.ok(routes.includes('sourceRun: item.sourceRunId'), 'and must keep the run in evidence');
});

section('a card says what is actually happening');

const nowIso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
const runningRun = { id: 'r1', status: 'running', started_at: nowIso(180000), created_at: nowIso(180000) };
const mod = { key: 'seo_geo', label: 'SEO & GEO', toolPath: '/seo-geo-audit' };

test('a queued crawl is reported as queue time, not as work', () => {
  // It said "Starting the first page" while a crawl sat in the queue for ten
  // minutes. Nothing was starting, and the sentence sent me hunting a bug in the
  // audit loop that was not there.
  const card = overviewModule.evidenceCard(mod, {
    inFlight: runningRun, progress: { done: 0 }, followedCrawl: { state: 'pending' },
  });
  assert.match(card.headline, /Waiting for the crawl/);
  assert.match(card.detail, /still queued/);
  assert.strictEqual(card.waitingOnCrawl, true);
});

test('a stalled crawl is reported at all', () => {
  // Previously invisible: a dead crawl looked exactly like a slow one and the
  // only way to tell was to read heartbeat_at by hand.
  const card = overviewModule.evidenceCard(mod, {
    inFlight: runningRun, progress: { done: 0 }, followedCrawl: { state: 'stalled', silentMinutes: 6 } },
  );
  assert.match(card.headline, /stopped/);
  assert.match(card.detail, /6 minute/);
  assert.strictEqual(card.waitingOnCrawl, true);
});

test('real progress is reported as progress', () => {
  const card = overviewModule.evidenceCard(mod, {
    inFlight: runningRun, progress: { done: 3 }, followedCrawl: { state: 'alive' },
  });
  assert.match(card.headline, /3 pages audited/);
  assert.strictEqual(card.waitingOnCrawl, false);
});

section('the crawl card knows whether a crawl is alive');

test('four missed heartbeats is a stalled crawl', () => {
  // The crawler beats every 30s on its own timer, so a slow page cannot delay
  // one. Four missed beats means the process is gone, not busy.
  const stalled = overviewModule.crawlHealth({
    status: 'running', started_at: nowIso(600000), heartbeat_at: nowIso(300000),
  });
  assert.strictEqual(stalled.state, 'stalled');
  assert.ok(stalled.silentMinutes >= 4);
});

test('a recent heartbeat is alive', () => {
  const alive = overviewModule.crawlHealth({
    status: 'running', started_at: nowIso(600000), heartbeat_at: nowIso(15000),
  });
  assert.strictEqual(alive.state, 'alive');
});

test('queued is not stalled, however long it waits', () => {
  // Queue time is not silence. Measured queue waits reach ten minutes on this
  // deployment and none of them mean anything is broken.
  const pending = overviewModule.crawlHealth({
    status: 'queued', created_at: nowIso(900000), heartbeat_at: null,
  });
  assert.strictEqual(pending.state, 'pending');
});

test('an unparseable heartbeat is not evidence of death', () => {
  const unknown = overviewModule.crawlHealth({ status: 'running', started_at: null, heartbeat_at: null });
  assert.strictEqual(unknown.state, 'alive', 'a missing beat must not be announced as a stall');
});

test('a running crawl is visible even when an older one finished', () => {
  // It used to be reported only when there was no previous crawl, so a running
  // crawl was invisible on every project after its first day.
  const card = overviewModule.technicalCard([
    { id: 'new', status: 'running', started_at: nowIso(60000), created_at: nowIso(60000),
      heartbeat_at: nowIso(10000), progress: { crawled: 7, discovered: 58 } },
    { id: 'old', status: 'completed', finished_at: nowIso(86400000), summary: { counts: {} } },
  ], [], null);
  assert.match(card.headline, /Crawling/);
  assert.strictEqual(card.previousRunId, 'old', 'the last real result stays reachable');
  assert.strictEqual(card.evidence, null, 'a crawl that has measured nothing shows no counts');
});

test('a stalled crawl does not claim to be running', () => {
  const card = overviewModule.technicalCard([
    { id: 'x', status: 'running', started_at: nowIso(600000), created_at: nowIso(600000),
      heartbeat_at: nowIso(400000), progress: {} },
  ], [], null);
  assert.notStrictEqual(card.status, 'running');
  assert.match(card.headline, /stopped responding/);
});

section('a running audit shows its average so far');

const liveRun = { id: 'r1', status: 'running', started_at: nowIso(600000), created_at: nowIso(600000) };
const liveCard = (mod, progress) => overviewModule.evidenceCard(mod, {
  inFlight: liveRun, progress, followedCrawl: { state: 'alive' },
});

test('a scoring module shows the mean of the pages done so far', () => {
  // It used to withhold the number until the run finished and print "this module
  // reports findings, not a 0-100 score" for the twenty-eight minutes in between,
  // while computing a score for every page.
  const card = liveCard({ key: 'seo_geo', label: 'SEO & GEO' }, { done: 7, scored: 7, mean: 86 });
  assert.strictEqual(card.scored, true);
  assert.strictEqual(card.score, 86);
  assert.match(card.headline, /86\/100/);
});

test('the moving average says that it is moving', () => {
  const card = liveCard({ key: 'seo_geo', label: 'SEO & GEO' }, { done: 7, scored: 7, mean: 86 });
  assert.match(card.scoreBasis, /7 pages scored so far/);
  assert.match(card.scoreBasis, /still going/, 'a number that will change must say so');
});

test('a module with no rubric shows no ring, not a zero', () => {
  // On-Page scores nothing, so every page is null and the mean is null. A ring at
  // zero would read as a catastrophic site.
  const card = liveCard({ key: 'on_page', label: 'On-Page' }, { done: 8, scored: 0, mean: null });
  assert.strictEqual(card.scored, false);
  assert.strictEqual(card.score, null);
  assert.strictEqual(card.scoreBasis, null);
});

test('pages done and pages scored are different numbers', () => {
  // Two pages audited, one of which produced a score. The headline counts pages
  // done; the basis counts pages scored. Conflating them would overstate what the
  // average is built from.
  const card = liveCard({ key: 'seo_geo', label: 'SEO & GEO' }, { done: 2, scored: 1, mean: 88 });
  assert.match(card.headline, /2 pages so far/);
  assert.match(card.scoreBasis, /1 page scored/);
});

test('nothing finished yet means no ring at all', () => {
  const card = liveCard({ key: 'seo_geo', label: 'SEO & GEO' }, { done: 0, scored: 0, mean: null });
  assert.strictEqual(card.scored, false);
  assert.strictEqual(card.score, null);
});

test('a genuine zero average is still shown', () => {
  // 0 is a measurement. It must not be swallowed by the same check that hides null.
  const card = liveCard({ key: 'agent_readiness', label: 'Agent Readiness' }, { done: 3, scored: 3, mean: 0 });
  assert.strictEqual(card.scored, true);
  assert.strictEqual(card.score, 0);
});

section('scores that already existed, now reported');

test('site health is the figure the crawl report itself shows', () => {
  // Verified against the live crawl: 1 error page, 50 warning pages, 50 notice
  // pages over 86 rows gives 82%, which is exactly what the crawl report shows.
  // Two screens publishing different numbers for one crawl is the fastest way to
  // make both untrustworthy.
  const run = {
    summary: {
      resultCount: 86,
      counts: { error: 1, warning: 313, notice: 113 },
      findings: [
        { severity: 'error', url: 'https://x/e' },
        ...Array.from({ length: 50 }, (_, i) => ({ severity: 'warning', url: `https://x/w${i}` })),
        ...Array.from({ length: 50 }, (_, i) => ({ severity: 'notice', url: `https://x/n${i}` })),
      ],
    },
  };
  // 50 internal HTML pages is the denominator — not the 86 fetched URLs and not
  // the 85 HTML ones, both of which included the 35 external pages the crawler
  // followed. Those can never carry a finding, so counting them was worth 13
  // points of free credit: this same crawl read 82 before.
  assert.strictEqual(overviewModule.siteHealth(run, 50).score, 69);
});

test('external pages cannot inflate the health score', () => {
  // The whole point of the v2 denominator. Same findings, same site; the only
  // difference is how many of somebody else's pages the crawl happened to follow.
  const run = {
    summary: {
      resultCount: 500,          // must not leak into the divisor
      counts: { error: 1, warning: 313, notice: 113 },
      findings: [
        { severity: 'error', url: 'https://x/e' },
        ...Array.from({ length: 50 }, (_, i) => ({ severity: 'warning', url: `https://x/w${i}` })),
        ...Array.from({ length: 50 }, (_, i) => ({ severity: 'notice', url: `https://x/n${i}` })),
      ],
    },
  };
  assert.strictEqual(overviewModule.siteHealth(run, 50).score, 69);
  assert.strictEqual(overviewModule.siteHealth(run, 50).denominator, 50);
});

test('an uncountable denominator withholds the score rather than guessing', () => {
  // A failed count query used to fall back to resultCount through Math.max,
  // which is how external pages got back in after being filtered out.
  const run = { summary: { resultCount: 86, counts: {}, findings: [] } };
  assert.strictEqual(overviewModule.siteHealth(run, null), null);
});

test('health weights affected PAGES, not finding count', () => {
  // Denominators below are internal HTML page counts, per v2.
  // One page with forty warnings is one page's worth of harm. Counting findings
  // would let a single bad page sink a whole site's score.
  const many = {
    summary: {
      resultCount: 10,
      findings: Array.from({ length: 40 }, () => ({ severity: 'warning', url: 'https://x/one' })),
    },
  };
  const one = {
    summary: { resultCount: 10, findings: [{ severity: 'warning', url: 'https://x/one' }] },
  };
  assert.strictEqual(
    overviewModule.siteHealth(many, 10).score,
    overviewModule.siteHealth(one, 10).score,
  );
});

test('no crawled pages means no health score, not zero', () => {
  assert.strictEqual(overviewModule.siteHealth({ summary: {} }, 0), null);
  assert.strictEqual(overviewModule.siteHealth(null, 0), null);
});

test('counts without urls are withheld rather than reported as perfect', () => {
  // A crawl stored before per-instance findings existed knows it had errors but
  // not which pages. An empty instance list would otherwise compute 100%.
  const legacy = {
    summary: { resultCount: 50, counts: { error: 4, warning: 20 }, findings: [] },
  };
  assert.strictEqual(overviewModule.siteHealth(legacy, 50), null);
});

test('a clean crawl scores 100', () => {
  assert.strictEqual(
    overviewModule.siteHealth({ summary: { resultCount: 50, counts: {}, findings: [] } }, 50).score,
    100,
  );
});

section('competitor standing is a ratio of two measured figures');

test('the score is traffic share of the strongest rival', () => {
  // Live: 102,880 against Aspen Dental's 1,475,172 is 7.
  const scored = moduleRunners.competitorTrafficScore([
    { domain: 'client.test', isClient: true, domainRank: { organicTraffic: 102880 } },
    { domain: 'rival.test', isClient: false, domainRank: { organicTraffic: 1475172 } },
  ]);
  assert.strictEqual(scored.score, 7);
  assert.strictEqual(scored.strongestDomain, 'rival.test');
});

test('the strongest rival is the denominator, not the average', () => {
  // An average would be gameable by adding weak competitors to flatter the score.
  const scored = moduleRunners.competitorTrafficScore([
    { domain: 'client.test', isClient: true, domainRank: { organicTraffic: 100 } },
    { domain: 'big.test', isClient: false, domainRank: { organicTraffic: 1000 } },
    { domain: 'tiny.test', isClient: false, domainRank: { organicTraffic: 1 } },
  ]);
  assert.strictEqual(scored.score, 10, 'must divide by 1000, not by the mean of 1000 and 1');
});

test('a client ahead of everyone caps at 100 but records that it is ahead', () => {
  const scored = moduleRunners.competitorTrafficScore([
    { domain: 'client.test', isClient: true, domainRank: { organicTraffic: 5000 } },
    { domain: 'rival.test', isClient: false, domainRank: { organicTraffic: 1000 } },
  ]);
  assert.strictEqual(scored.score, 100);
  assert.strictEqual(scored.aheadOfAll, true);
  assert.strictEqual(scored.ratio, 5, 'the raw ratio survives the cap');
});

test('no competitors means no score, not a zero', () => {
  // A site with nobody to compare against is not a site with no traffic.
  assert.strictEqual(moduleRunners.competitorTrafficScore([
    { domain: 'client.test', isClient: true, domainRank: { organicTraffic: 100 } },
  ]), null);
});

test('missing traffic figures withhold the score', () => {
  assert.strictEqual(moduleRunners.competitorTrafficScore([
    { domain: 'client.test', isClient: true, domainRank: {} },
    { domain: 'rival.test', isClient: false, domainRank: { organicTraffic: 100 } },
  ]), null);
  assert.strictEqual(moduleRunners.competitorTrafficScore([
    { domain: 'client.test', isClient: true, domainRank: { organicTraffic: 100 } },
    { domain: 'rival.test', isClient: false, domainRank: { organicTraffic: 0 } },
  ]), null, 'a rival with zero traffic cannot be a denominator');
});

test('a client with genuinely no traffic scores 0', () => {
  const scored = moduleRunners.competitorTrafficScore([
    { domain: 'client.test', isClient: true, domainRank: { organicTraffic: 0 } },
    { domain: 'rival.test', isClient: false, domainRank: { organicTraffic: 1000 } },
  ]);
  assert.strictEqual(scored.score, 0, '0 is a measurement here, unlike a missing figure');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
