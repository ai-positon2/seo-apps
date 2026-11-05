// ── Per-page runs agree with their pages; a refused site says so everywhere ──
//
// UX-138: Soteri Skin's SEO & GEO card read "0 error · 0 warning · 0 notice"
// over five pages carrying 25 errors — an "Analyze another page" refresh read
// the pages without their findings and wrote zeros back onto the run.
// UX-205: the card said "Mean of 5" and "5 pages audited" over a mean of 4.
// UX-145: Hub and Spoke kept its 51 and ranked as the weakest area after its
// analysis was gone. UX-036: AI Visibility read "Never run" after its setup
// failed on HTTP 429, and SEO & GEO kept 73 findings and an AI verdict built
// from the 429 page.
//
// Run: node modules/projects/__tests__/pageRollup.test.js

const assert = require('node:assert/strict');
const { test } = require('node:test');

const moduleEvidence = require('../moduleEvidence');
const overview = require('../overview');

const {
  rollupBand, rollupBasis, basisTail, reconcilePageRun, hubSpokeReportMissing,
  aiVisibilitySetupFailure, allPagesRefused, siteRefusedLine, aggregatePages,
} = moduleEvidence;

const SEO = { key: 'seo_geo', label: 'SEO & GEO' };

// Soteri Skin's run as stored: zeros on the parent, the real counts on its pages.
const soteri = () => ({
  id: 'run-1', module_key: 'seo_geo', status: 'completed', target_url: null,
  score: 75, score_max: 100,
  score_basis: 'Mean of 5 page score(s) from the SEO & GEO audit',
  band: '5 pages audited',
  counts: { error: 0, warning: 0, notice: 0, info: 0 },
  findings: [],
  payload: {
    pages: [
      { url: '/', score: 84, counts: { error: 6, warning: 30, notice: 29 } },
      { url: '/products/eczema-cream', score: 65, counts: { error: 8, warning: 26, notice: 31 } },
      { url: '/pages/shop', score: 85, counts: { error: 2, warning: 32, notice: 32 } },
      { url: '/blogs/skin-ph/skin-barrier-repair', score: null, band: 'HTTP 429 — not scored', counts: {} },
      { url: '/pages/contact-us', score: 65, counts: { error: 5, warning: 26, notice: 29 } },
    ],
  },
});

test('a stored run with zero counts over pages that have them shows the pages’ sums', () => {
  const row = reconcilePageRun(soteri());
  assert.deepEqual(row.counts, { error: 21, warning: 114, notice: 121, info: 0 });
  const card = overview.evidenceCard(SEO, { terminal: row, inFlight: null });
  assert.match(card.detail, /21 error · 114 warning · 121 notice/);
  assert.equal(card.status, 'completed_with_errors');
});

test('the basis and band count the pages that scored, not every page', () => {
  const row = reconcilePageRun(soteri());
  assert.equal(row.band, '4 of 5 pages scored');
  assert.match(row.score_basis, /^Mean of 4 page score\(s\) from the SEO & GEO audit; 1 page not scored/);
  const card = overview.evidenceCard(SEO, { terminal: row, inFlight: null });
  assert.equal(card.headline, '75/100 · 4 of 5 pages scored');
});

test('the SQL page summary latestByModule projects reconciles the same way', () => {
  const { payload, ...withoutPayload } = soteri();
  const row = reconcilePageRun(withoutPayload, { total: 5, scored: 4, error: 21, warning: 114, notice: 121, info: 0 });
  assert.equal(row.counts.error, 21);
  assert.equal(row.band, '4 of 5 pages scored');
});

test('a run whose own counts are right, and a homepage band, are left alone', () => {
  const right = { ...soteri(), counts: { error: 3, warning: 1, notice: 0 }, band: 'Homepage audited' };
  const row = reconcilePageRun(right);
  assert.deepEqual(row.counts, right.counts);
  assert.equal(row.band, 'Homepage audited');
  // Site-level modules are not touched at all.
  const hub = { module_key: 'hub_spoke', counts: {} };
  assert.equal(reconcilePageRun(hub), hub);
});

test('rollup wording: equal counts read "audited", unequal ones "scored"; the methodology survives a rebuild', () => {
  assert.equal(rollupBand({ scoredPages: 5, totalPages: 5 }), '5 pages audited');
  assert.equal(rollupBand({ scoredPages: 1, totalPages: 1 }), '1 page audited');
  assert.equal(rollupBand({ scoredPages: 4, totalPages: 5 }), '4 of 5 pages scored');
  const basis = rollupBasis({ scoredPages: 4, totalPages: 5 }, 'the SEO & GEO audit');
  assert.equal(basisTail(basis), 'the SEO & GEO audit');
  assert.equal(basisTail('Mean of 5 page score(s) from the agent readiness audit'), 'the agent readiness audit');
  assert.equal(basisTail('Mean of 5 page score(s)'), null);
  assert.equal(basisTail('Something else entirely'), null);
});

test('summed counts are the pages’ own counts, which completeRun now stores', () => {
  const rollup = aggregatePages([
    { url: 'a', score: 80, counts: { error: 3 }, findings: [{ ruleId: 'r1', severity: 'error' }] },
    { url: 'b', score: 70, counts: { error: 2 }, findings: [{ ruleId: 'r1', severity: 'error' }] },
  ]);
  assert.equal(rollup.counts.error, 5, '3 + 2, not one merged rule');
  assert.equal(rollup.findings.length, 1);
});

test('a Hub and Spoke run whose analysis is gone is "re-run needed", unscored, and not the weakest area', () => {
  const row = hubSpokeReportMissing({
    id: 'h1', module_key: 'hub_spoke', status: 'completed', score: 51, score_max: 100,
    score_basis: 'the mean of every cluster’s health', band: '3 clusters', counts: { error: 2 },
    findings: [{ ruleId: 'x', severity: 'error', title: 'Gap', count: 1 }], reportRef: null,
  });
  assert.equal(row.score, null);
  assert.equal(row.reportMissing, true);
  const card = overview.evidenceCard({ key: 'hub_spoke', label: 'Hub and Spoke' }, { terminal: row, inFlight: null });
  assert.equal(card.scored, false);
  assert.equal(card.headline, 'Re-run needed');
  assert.equal(card.needsRerun, true);
  assert.equal(card.evidence, null);
  assert.match(card.detail, /no longer stored/);
  // With its analysis stored, nothing changes.
  const live = { module_key: 'hub_spoke', status: 'completed', score: 51, reportRef: 'proj_1' };
  assert.equal(hubSpokeReportMissing(live), live);
});

test('a failed AI Visibility setup is the card’s run, with the shared refusal wording', () => {
  const row = aiVisibilitySetupFailure({
    id: 's1', module_key: 'ai_visibility_lite_setup', status: 'failed',
    error: 'Could not read https://www.8x8.com (HTTP 429)', created_at: '2026-10-01T00:00:00Z',
  });
  assert.equal(row.module_key, 'ai_visibility_lite');
  const card = overview.evidenceCard({ key: 'ai_visibility_lite', label: 'AI Visibility' }, { terminal: row, inFlight: null });
  assert.equal(card.status, 'failed');
  assert.equal(card.headline, 'Setup failed');
  assert.match(card.detail, /The site refused our requests \(HTTP 429\)/);
  assert.equal(aiVisibilitySetupFailure({ status: 'completed' }), null, 'a finished setup is not a failure');
});

test('a run where every page was refused is recognised, one real page is enough to not be', () => {
  assert.deepEqual(allPagesRefused([{ score: null, band: 'HTTP 429 — not scored' }]), { status: 429 });
  assert.deepEqual(allPagesRefused([{ score: null, band: 'Blocked — not measured' }]), { status: null });
  assert.equal(allPagesRefused([{ score: null, band: 'HTTP 429 — not scored' }, { score: 70, band: 'Good' }]), null);
  assert.equal(allPagesRefused([{ score: null, band: null, status: 'failed' }]), null, 'a crash is not a refusal');
  assert.equal(allPagesRefused([{ score: null, band: 'HTTP 404 — not scored' }]), null, 'nor is a missing page');
  assert.equal(siteRefusedLine(429), 'The site refused our requests (HTTP 429) — nothing could be read.');
  assert.equal(siteRefusedLine(null), 'The site refused our requests — nothing could be read.');
});

test('an SEO & GEO page that answered 429 keeps no findings and no AI text, and says why', async () => {
  const routePath = require.resolve('../../../routes/seoGeoAudit');
  const previous = require.cache[routePath];
  require.cache[routePath] = {
    id: routePath, filename: routePath, loaded: true,
    exports: {
      runSeoGeoAudit: async () => ({
        findings: {
          meta: { http_status: 429, url: 'https://www.8x8.com/' },
          scores: { overall: 45 },
          checks: [{ id: 'H1', severity: 'error', title: 'No usable H1' }],
        },
        ai: { verdict: 'Content is critically thin' },
      }),
    },
  };
  try {
    const { auditPageSeoGeo } = require('../moduleRunners');
    const page = await auditPageSeoGeo({ url: 'https://www.8x8.com/' });
    assert.equal(page.score, null);
    assert.deepEqual(page.findings, []);
    assert.equal(page.payload.native.ai, null);
    assert.deepEqual(page.payload.native.findings.checks, []);
    assert.equal(page.band, 'HTTP 429 — not scored');
    assert.match(page.error, /The site refused our requests \(HTTP 429\)/);
  } finally {
    if (previous) require.cache[routePath] = previous; else delete require.cache[routePath];
  }
});

// UX-138 residual: the parent's top findings were empty "until re-run".
test('a stored parent with no findings takes its top findings from its pages on read', async () => {
  const { findingsFromPages, withPageFindings } = moduleEvidence;
  const pages = [
    { run_id: 'run-1', url: '/', status: 'completed', findings: [
      { ruleId: 'meta', title: 'Missing meta description', severity: 'warning', count: 1 },
      { ruleId: 'h1', title: 'No usable H1', severity: 'error', count: 1 },
    ] },
    { run_id: 'run-1', url: '/pages/shop', status: 'completed', findings: [
      { ruleId: 'h1', title: 'No usable H1', severity: 'error', count: 2 },
    ] },
    { run_id: 'run-1', url: '/blogs/x', status: 'failed', findings: [] },
  ];
  const row = findingsFromPages(reconcilePageRun(soteri()), pages);
  assert.deepEqual(row.findings.map((f) => [f.ruleId, f.severity, f.count]), [['h1', 'error', 3], ['meta', 'warning', 1]]);
  const card = overview.evidenceCard(SEO, { terminal: row, inFlight: null });
  assert.equal(card.evidence.topFindings[0].title, 'No usable H1', 'the card leads with the error');
  assert.match(card.detail, /21 error/, 'counts still come from the page sums');

  // Left alone: a parent that has findings, a site-level module, pages with none.
  const has = { ...soteri(), findings: [{ ruleId: 'x', title: 'X', severity: 'notice', count: 1 }] };
  assert.equal(findingsFromPages(has, pages), has);
  const hub = { id: 'h', module_key: 'hub_spoke', findings: [] };
  assert.equal(findingsFromPages(hub, pages), hub);
  const bare = soteri();
  assert.equal(findingsFromPages(bare, [{ url: '/', findings: [] }]), bare);

  // The batch read asks only for the rows that need it, and a failed read changes nothing.
  const db = require('../../../services/db');
  const saved = { rows: db.rows, configured: db.isDatabaseConfigured };
  const asked = [];
  db.isDatabaseConfigured = () => true;
  db.rows = async (sql, params) => { asked.push(params[0]); return pages; };
  try {
    const out = await withPageFindings([soteri(), has, hub]);
    assert.deepEqual(asked, [['run-1']]);
    assert.equal(out.get('run-1').findings.length, 2);
    assert.equal(out.size, 1);
    db.rows = async () => { throw new Error('relation does not exist'); };
    const warn = console.warn;
    console.warn = () => {};
    try { assert.equal((await withPageFindings([soteri()])).size, 0); } finally { console.warn = warn; }
  } finally {
    db.rows = saved.rows;
    db.isDatabaseConfigured = saved.configured;
  }
});
