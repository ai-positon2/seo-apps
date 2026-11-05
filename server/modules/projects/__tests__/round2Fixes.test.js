// ── UX sweep, round 2: the Overview's summary, fix list and module panel ─────
//
//   • UX-036: when the site refused our requests, the executive summary leads
//     with that and how to unblock it, not "critical issues / weakest area";
//   • UX-054: when the crawl's costing is still being worked out, the summary
//     says so instead of calling every crawl error critical;
//   • UX-108: the AI Visibility panel on a profile built for the previous site
//     shows none of that site's findings and no 0/100.
//
// Offline. A dummy DATABASE_URL is set so the builders run, and every read
// they make is stubbed below; nothing connects to anything.
//
// Run: node --test modules/projects/__tests__/round2Fixes.test.js

process.env.DATABASE_URL = 'postgres://offline.invalid/none';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const executive = require('../insights/executive');
const backlog = require('../insights/backlog');
const moduleEvidence = require('../moduleEvidence');
const overview = require('../overview');
const moduleDetail = require('../moduleDetail');

const card = (fields) => ({ card: true, status: 'completed', updatedAt: '2026-11-01T00:00:00Z', ...fields });

test('a site that refused our requests leads the summary with how to unblock it', () => {
  const modules = [
    card({ key: 'hub_spoke', label: 'Hub and Spoke', status: 'failed', error: moduleEvidence.siteRefusedLine(429) }),
    card({ key: 'seo_geo', label: 'SEO & GEO', scored: true, score: 45, detail: `${moduleEvidence.siteRefusedLine(429)} Not scored.` }),
    card({ key: 'technical', label: 'Tech Audit', scored: false, headline: 'No error or warning findings' }),
  ];
  const out = executive.buildExecutiveSummary({
    overview: { modules, composite: { value: 45, scoredModules: 1 } },
    backlog: { totals: { actions: 2, criticalCosting: 2, bySeverity: { error: 2 } }, actions: [] },
  });
  assert.equal(out.verdict.state, 'blocked');
  assert.match(out.verdict.sentence, /^Our checks were blocked by the site \(HTTP 429\)\. Allow our crawler, then re-run\./);
  assert.doesNotMatch(out.verdict.sentence, /critical issue|weakest area/);
  assert.match(out.verdict.sentence, /Hub and Spoke, SEO & GEO/);
});

test('no refusal anywhere leaves the verdict exactly as before', () => {
  const modules = [card({ key: 'seo_geo', label: 'SEO & GEO', scored: true, score: 45, headline: '45/100' })];
  assert.equal(executive.siteBlocked(modules), null);
  const totals = { actions: 2, criticalCosting: 2, bySeverity: { error: 2 }, pagesWithCostingErrors: 3 };
  const out = executive.buildExecutiveSummary({
    overview: { modules, composite: { value: 45, scoredModules: 1 } },
    backlog: { totals, actions: [] },
  });
  assert.equal(out.verdict.state, 'at_risk');
  assert.deepEqual(out.verdict, executive.buildVerdict({ composite: 45, totals, everRun: true, areas: executive.buildAreas(modules) }));
  // A module that has not run, or a card hidden from the dashboard, is not a refusal.
  assert.equal(executive.siteBlocked([card({ key: 'x', status: 'not_run', detail: moduleEvidence.siteRefusedLine(403) })]), null);
  assert.equal(executive.siteBlocked([card({ key: 'x', card: false, detail: moduleEvidence.siteRefusedLine(403) })]), null);
});

test('a refusal with no recorded status still says so, without a code', () => {
  const blocked = executive.siteBlocked([card({ key: 'technical', label: 'Tech Audit', headline: moduleEvidence.siteRefusedLine(null) })]);
  assert.deepEqual(blocked, { status: null, modules: ['Tech Audit'] });
  const verdict = executive.buildVerdict({ totals: {}, everRun: true, blocked });
  assert.match(verdict.sentence, /^Our checks were blocked by the site\. Allow our crawler/);
});

test('costing still being worked out is said, not counted as critical (UX-054)', () => {
  const index = {
    crawl: { internalPages: 10, healthPending: true },
    items: [{ key: 'technical:r', moduleKey: 'technical', ruleId: 'r', severity: 'error', costsPoints: null, pages: ['https://x.test/a'], pageCount: 1, attribution: 'per-instance' }],
  };
  const built = backlog.buildBacklog(index);
  assert.equal(built.totals.costingPending, true);
  assert.equal(built.totals.criticalCosting, 1);
  const verdict = executive.buildVerdict({ composite: 70, totals: built.totals, everRun: true });
  assert.equal(verdict.state, 'pending');
  assert.match(verdict.sentence, /still being worked out/);
  // Not pending: the same backlog reads as before.
  const ready = backlog.buildBacklog({ ...index, crawl: { internalPages: 10, healthPending: false } });
  assert.equal(ready.totals.costingPending, false);
  assert.equal(executive.buildVerdict({ composite: 70, totals: ready.totals, everRun: true }).state, 'at_risk');
});

test('the pending verdict and the pending Tech Audit card say the same reload time', () => {
  const verdict = executive.buildVerdict({
    composite: 70, everRun: true, totals: { bySeverity: { error: 1 }, criticalCosting: 1, costingPending: true },
  });
  assert.ok(verdict.sentence.includes(overview.HEALTH_PENDING_RELOAD));
  assert.doesNotMatch(verdict.sentence, /a few minutes/);
  const pendingCard = overview.healthPendingCard({ key: 'technical', status: 'completed', runId: 'r1', detail: '' });
  assert.ok(pendingCard.detail.includes(overview.HEALTH_PENDING_RELOAD));
});

test('costing known but its URL lists not ready: a verdict, never "pending", and no guessed page count', () => {
  const index = {
    crawl: { internalPages: 10, healthPending: false, costingPagesPending: true },
    items: [{
      key: 'technical:r', moduleKey: 'technical', ruleId: 'r', severity: 'error', costsPoints: true,
      costingPages: null, pages: ['https://x.test/a', 'https://x.test/refused'], pageCount: 2, attribution: 'per-instance',
    }],
  };
  const built = backlog.buildBacklog(index);
  assert.equal(built.totals.costingPending, false);
  assert.equal(built.totals.pagesWithCostingErrors, null);
  const verdict = executive.buildVerdict({ composite: 70, totals: built.totals, everRun: true });
  assert.equal(verdict.state, 'at_risk');
  assert.match(verdict.sentence, /1 critical issue is lowering this site's scores right now\./);
  assert.doesNotMatch(verdict.sentence, /audited page/);
  // Once the lists are in, the count is exactly as before.
  const ready = backlog.buildBacklog({
    crawl: { internalPages: 10, healthPending: false, costingPagesPending: false },
    items: [{ ...index.items[0], costingPages: ['https://x.test/a'] }],
  });
  assert.equal(ready.totals.pagesWithCostingErrors, 1);
  assert.match(executive.buildVerdict({ composite: 70, totals: ready.totals, everRun: true }).sentence, /across 1 audited page/);
});

test('the AI Visibility panel leaves out results measured for the previous site (UX-108)', async () => {
  const stale = {
    id: 'aiv1', module_key: 'ai_visibility_lite', status: 'completed', score: 0,
    counts: { error: 1, notice: 1 }, created_at: '2026-10-01T00:00:00Z', finished_at: '2026-10-01T00:10:00Z',
    findings: [{ ruleId: 'aiv-absent', title: 'Not named in 30 of 30 measured prompts', severity: 'error', count: 30 }],
    payload: { prompts: ['best marketing agency'] },
  };
  const saved = {
    listRuns: moduleEvidence.listRuns,
    withPageFindings: moduleEvidence.withPageFindings,
    live: overview.liveAiVisibilityTerminal,
  };
  moduleEvidence.listRuns = async () => [stale];
  moduleEvidence.withPageFindings = async (rows) => new Map(rows.map((r) => [r.id, r]));
  overview.liveAiVisibilityTerminal = async (_project, terminal) => ({
    ...terminal, score: null, profileStale: { builtFor: 'position2.com' },
    metric: { value: null, display: '—', unit: 'profile built for position2.com — rebuild it', tag: 'Profile out of date' },
  });
  try {
    const detail = await moduleDetail.buildModuleDetail({
      access: { project: { id: 'p1', name: 'Soteri' }, capabilities: {} },
      moduleKey: 'ai_visibility_lite',
    });
    assert.deepEqual(detail.findings, []);
    assert.equal(detail.payload, null);
    assert.equal(detail.card.score, null);
    assert.equal(detail.card.profileStale.builtFor, 'position2.com');
    assert.equal(detail.card.metric.tag, 'Profile out of date');
    assert.equal(detail.card.evidence, null);
    assert.doesNotMatch(String(detail.card.headline || ''), /\d+\/100|finding/);
    assert.deepEqual(detail.run.counts, {});
    assert.equal(detail.run.score, null);
  } finally {
    moduleEvidence.listRuns = saved.listRuns;
    moduleEvidence.withPageFindings = saved.withPageFindings;
    overview.liveAiVisibilityTerminal = saved.live;
  }
});

test('a current AI Visibility profile keeps its findings in the panel', async () => {
  const run = {
    id: 'aiv2', module_key: 'ai_visibility_lite', status: 'completed', score: 40, counts: { error: 1 },
    created_at: '2026-10-01T00:00:00Z', finished_at: '2026-10-01T00:10:00Z',
    findings: [{ ruleId: 'aiv-absent', title: 'Not named', severity: 'error', count: 3 }], payload: { note: 'x' },
  };
  const saved = { listRuns: moduleEvidence.listRuns, withPageFindings: moduleEvidence.withPageFindings, live: overview.liveAiVisibilityTerminal };
  moduleEvidence.listRuns = async () => [run];
  moduleEvidence.withPageFindings = async (rows) => new Map(rows.map((r) => [r.id, r]));
  overview.liveAiVisibilityTerminal = async (_p, terminal) => terminal;
  try {
    const detail = await moduleDetail.buildModuleDetail({
      access: { project: { id: 'p1', name: 'X' }, capabilities: {} }, moduleKey: 'ai_visibility_lite',
    });
    assert.equal(detail.findings.length, 1);
    assert.deepEqual(detail.payload, { note: 'x' });
    assert.equal(detail.card.profileStale, undefined);
  } finally {
    moduleEvidence.listRuns = saved.listRuns;
    moduleEvidence.withPageFindings = saved.withPageFindings;
    overview.liveAiVisibilityTerminal = saved.live;
  }
});

test('the fix list takes no findings from AI Visibility, stale or not', () => {
  // findingIndex builds items only for the crawl, the page audits, Hub and
  // Spoke and Competitor; an AI Visibility run (current or stale-profile)
  // contributes coverage only, so no old-site finding can reach the backlog.
  assert.ok(!moduleEvidence.PAGE_MODULE_KEYS.includes('ai_visibility_lite'));
  assert.ok(!moduleEvidence.PAGE_MODULE_KEYS.includes('ai_visibility'));
  const src = require('fs').readFileSync(require.resolve('../insights/findingIndex'), 'utf8');
  // The only adapters that produce items, by module key.
  const keyed = [...src.matchAll(/module\.key === '([a-z_]+)'/g)].map((m) => m[1]);
  assert.ok(keyed.length > 0);
  assert.ok(keyed.every((k) => !k.startsWith('ai_visibility')));
});
