// Tests for the expanded per-module view (moduleDetail.js).
//
// The property worth protecting here is that the panel and the dashboard cannot
// disagree. Both render the `card` object this builder returns, so these tests
// assert the card comes from the same functions the dashboard uses — and that
// the things the card had to omit (all the findings, the module's payload, the
// run history) survive the trip.

const assert = require('assert');
const moduleDetail = require('../moduleDetail');
const moduleRunners = require('../moduleRunners');
const overview = require('../overview');

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

console.log('\nModule detail — the module vocabulary');

test('every dashboard module has an expanded view', () => {
  for (const module of overview.MODULES) {
    assert.doesNotThrow(
      () => moduleDetail.moduleFor(module.key),
      `${module.key} is on the dashboard but has no detail view`,
    );
  }
});

test('an unknown module is a 404, not an empty panel', () => {
  // Silently returning "nothing yet" for a typo would look identical to a module
  // that has genuinely never run.
  assert.throws(
    () => moduleDetail.moduleFor('nonsense'),
    (e) => e.status === 404 && /Unknown module/.test(e.message),
  );
});

console.log('\nModule detail — the run view');

test('a stored run keeps its score, basis and note', () => {
  const view = moduleDetail.runView({
    id: 'r1', status: 'completed', trigger: 'manual', target_url: 'https://x.com',
    score: 88, score_max: 100, score_basis: 'rule-based bucket scores', band: 'Good',
    counts: { error: 2, warning: 26 },
    payload: { note: 'Audited the primary page.' },
    started_at: '2026-08-22T10:00:00Z', finished_at: '2026-08-22T10:00:04Z',
  });
  assert.strictEqual(view.score, 88);
  assert.strictEqual(view.scoreBasis, 'rule-based bucket scores');
  assert.strictEqual(view.note, 'Audited the primary page.');
  assert.strictEqual(view.counts.error, 2);
});

test('an unscored run reports null, never zero', () => {
  const view = moduleDetail.runView({
    id: 'r2', status: 'completed', score: null, score_max: null, counts: {},
  });
  assert.strictEqual(view.score, null);
  assert.notStrictEqual(view.score, 0);
  assert.strictEqual(view.scoreBasis, null);
});

test('a run with no payload has no note rather than throwing', () => {
  const view = moduleDetail.runView({ id: 'r3', status: 'failed', counts: {} });
  assert.strictEqual(view.note, null);
});

test('runView(null) is null — a module that never ran has no run', () => {
  assert.strictEqual(moduleDetail.runView(null), null);
});

console.log('\nModule detail — history');

test('history is capped and keeps a null score as null', () => {
  const rows = Array.from({ length: 25 }, (_, i) => ({
    id: `r${i}`, status: 'completed', trigger: 'manual',
    score: i === 0 ? null : 50, findings: [{}, {}],
    started_at: '2026-08-22T10:00:00Z', finished_at: '2026-08-22T10:00:01Z',
  }));
  const history = moduleDetail.historyView(rows);
  assert.strictEqual(history.length, moduleDetail.HISTORY_LIMIT);
  assert.strictEqual(history[0].score, null);
  assert.strictEqual(history[0].findingCount, 2);
});

test('history counts findings without assuming the field is an array', () => {
  const history = moduleDetail.historyView([
    { id: 'a', status: 'failed', findings: null, score: null },
  ]);
  assert.strictEqual(history[0].findingCount, 0);
});

console.log('\nModule detail — cost');

test('only the metered module carries a cost, and it counts the client domain', () => {
  for (const module of overview.MODULES) {
    const cost = moduleRunners.estimateCost(module.key, { competitorCount: 1 });
    if (module.key === 'competitor') {
      assert.strictEqual(cost.domains, 2, 'the client domain is billed too');
      assert.strictEqual(cost.estimate, 3910);
    } else {
      assert.strictEqual(cost, null, `${module.key} does not bill and must quote no price`);
    }
  }
});

console.log('\nModule detail — the card is the dashboard’s card');

test('the detail builder reuses the dashboard card builders, not its own', () => {
  // If this file ever grew its own card logic, a headline could read 88/100 on
  // one screen and something else on the other. The reuse is the guarantee.
  const source = require('fs').readFileSync(
    require('path').join(__dirname, '../moduleDetail.js'), 'utf8',
  );
  assert.match(source, /overview\.evidenceCard/, 'five modules must use the dashboard card builder');
  assert.match(source, /overview\.technicalCard/, 'and CrawlScope must use its own');
  assert.ok(
    !/headline:/.test(source),
    'a headline composed here would be a second source of truth',
  );
});

test('findings are not truncated to the four the card shows', () => {
  // evidenceCard slices its topFindings to 4; the expanded view must not inherit
  // that — the whole point of the page is the rest of them.
  const source = require('fs').readFileSync(
    require('path').join(__dirname, '../moduleDetail.js'), 'utf8',
  );
  assert.match(
    source, /findings: Array\.isArray\(terminal\?\.findings\) \? terminal\.findings : \[\]/,
    'the full findings array must be passed through',
  );
  assert.ok(!/\.slice\(0, 4\)/.test(source), 'no four-finding cap in the expanded view');
});

test('the technical view reshapes crawl findings into the shared shape', () => {
  // One findings table renders either source, so crawl_run_findings rows have to
  // arrive with the same keys the other five modules use.
  const source = require('fs').readFileSync(
    require('path').join(__dirname, '../moduleDetail.js'), 'utf8',
  );
  for (const key of ['ruleId:', 'severity:', 'category:', 'count:', 'recommendation:']) {
    assert.ok(source.includes(key), `the technical mapping is missing ${key}`);
  }
});

console.log('\nOpening a module shows the module’s own report');

const readFile = (rel) => require('fs').readFileSync(
  require('path').join(__dirname, rel), 'utf8',
);

test('the runners keep each module’s native result, not a summary of it', () => {
  const source = readFile('../moduleRunners.js');
  // Two modules render their report from page state, so the whole native
  // result is stored and handed back to that page. on_page was a third until
  // the standalone page was removed and it stopped being a project module.
  assert.ok(
    source.includes('native: { findings: result.findings, ai: result.ai || null }'),
    'seo_geo must store its findings AND its ai analysis',
  );
  assert.ok(source.includes('native: result,'), 'agent_readiness must store its whole result');
});

test('each per-page audit stores that page’s own report under payload.native', () => {
  // The per-page modules audit one url each. What gets stored per page has
  // to be the module’s own report for that url, because the page switcher hands
  // it straight to the report view an individual run renders.
  const source = readFile('../moduleRunners.js');
  for (const fn of ['auditPageSeoGeo', 'auditPageAgentReadiness']) {
    assert.ok(source.includes(`async function ${fn}(`), `${fn} must exist`);
  }
  assert.ok(
    source.includes('runAcrossCrawledPages'),
    'and a driver must run them across the pages the crawl found',
  );
  // The driver stores one child row per page rather than one report per run.
  assert.ok(source.includes('moduleEvidence.startPageRun'), 'each page needs its own run row');
  assert.ok(source.includes('moduleEvidence.completePageRun'), 'and its own completion');
});

test('a page that fails does not fail the audit', () => {
  // Ten pages, one 500: the other nine still produce reports and the run still
  // has a score. Letting one page throw out of the loop would lose all of them.
  const source = readFile('../moduleRunners.js');
  const driver = source.slice(source.indexOf('async function runAcrossCrawledPages'));
  assert.ok(driver.includes('catch'), 'the per-page loop must catch');
  assert.ok(
    driver.includes("status: 'failed'"),
    'and record the failure as that page’s status',
  );
});

test('the run says how much of the site it covered', () => {
  // A 10-page budget over a 50-page crawl is not "the site", and a score that
  // does not say so invites reading it as one.
  const source = readFile('../moduleRunners.js');
  assert.ok(source.includes('pagesCrawled'), 'the payload must carry the crawl size');
  assert.ok(source.includes('pageBudget'), 'and the budget that bounded the work');
  assert.ok(source.includes('pagesSkipped'), 'and what fell outside it');
  assert.ok(
    source.includes('Mean of ${rollup.scoredPages} page score(s) from ${scoreBasis}'),
    'and the score basis must say the number is a mean, and of what',
  );
});

test('the LLM layers the report renders are no longer skipped', () => {
  // Skipping them stored a measurement but produced a report visibly missing
  // sections that an individual run has.
  const source = readFile('../moduleRunners.js');
  assert.ok(source.includes('skipAi: false'), 'seo_geo must run its analysis layer');
  assert.ok(source.includes('skipBrief: false'), 'agent_readiness must write its brief');
});

test('the analysis budget clears the measured range with room to spare', () => {
  // Observed 12,960 and 14,471 completion tokens on two runs of the same URL. A
  // budget just above that truncated on a longer answer and lost the analysis.
  const source = readFile('../../../routes/seoGeoAudit.js');
  const match = /const ANALYSIS_MAX_TOKENS = (\d+);/.exec(source);
  assert.ok(match, 'the budget must be a named constant');
  assert.ok(Number(match[1]) >= 20000, `${match[1]} leaves too little headroom above 14,471`);
});

test('extended thinking is disabled for the structured-JSON calls', () => {
  // With it on, Sonnet spent a 32,000-token budget reasoning and returned
  // truncated JSON after 318 seconds.
  const source = readFile('../../../routes/seoGeoAudit.js');
  const count = (source.match(/thinking: \{ type: 'disabled' \}/g) || []).length;
  assert.strictEqual(count, 2, 'both the analysis and page-classification calls need it');
});

test('an empty model response is a failure, not an empty analysis', () => {
  // `content || '{}'` turned an empty reply into an object that parsed, rendered
  // and said nothing, so the report looked finished with no advice in it.
  const source = readFile('../../../routes/seoGeoAudit.js');
  // Only the code, not the comment that explains why it went.
  const code = source.split(/\r?\n/).filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.ok(!code.includes("content || '{}'"), 'the silent empty-object fallback must stay gone');
  assert.ok(source.includes('output budget without answering'), 'and it must name the cause');
});

test('a missing analysis layer is distinguishable from no recommendations', () => {
  const source = readFile('../moduleRunners.js');
  assert.ok(source.includes('aiAnalysisPresent'), 'the run must record whether the layer completed');
});

const BAR = '../../../../client/src/components/project/ProjectReportBar.jsx';

test('a run with no stored report is reported, not left blank', () => {
  // A run recorded before native reports were kept has findings but nothing to
  // open. The bar says so in one line and offers to re-run.
  const source = readFile(BAR);
  assert.ok(source.includes('No stored'), 'the bar must say when there is no report');
  assert.ok(source.includes('Run it now'), 'and offer the way to get one');
});

test('the detail endpoint is what the bar reads', () => {
  // The bar fetches the stored run and hands a report to the page. If it stopped
  // calling this, the pages would silently show an empty tool instead of the
  // project's report.
  const source = readFile(BAR);
  assert.ok(source.includes('projectsApi.moduleDetail'), 'the bar must read the detail endpoint');
  assert.ok(source.includes('payload?.native'), 'and hand over the module’s own report');
});

test('per-page reports are fetched one page at a time', () => {
  // A 50-page run holds several megabytes of stored reports and the view shows
  // one url. Shipping them all in the detail response would make every page load
  // pay for 49 reports nobody is looking at.
  const source = readFile(BAR);
  assert.ok(source.includes('projectsApi.modulePageReport'), 'the bar must fetch a page at a time');
  const detail = readFile('../moduleDetail.js');
  assert.ok(
    detail.includes('pageRunsForRun'),
    'the detail response carries the page list',
  );
  assert.ok(
    !detail.includes('payload: p.payload'),
    'but not the reports themselves',
  );
});

test('the site figure is labelled as an average, not as a score', () => {
  // One number over ten pages is a different claim from a number about one page,
  // and the report below the bar is about one page.
  const source = readFile(BAR);
  assert.ok(source.includes('Site average'), 'the bar must name it an average');
  assert.ok(source.includes('mean of'), 'and say how many pages it averages');
});

test('the switcher does not invent its own score bands', () => {
  // Colouring 62 amber asserts "62 is mediocre", which no module said. The
  // modules publish their own bands; the UI reads those or stays neutral.
  const picker = readFile('../../../../client/src/lib/pageReportPicker.js');
  assert.ok(!/score >= \d+/.test(picker), 'no threshold may be invented in the UI');
  assert.ok(picker.includes('BAND_TONE'), 'it must map the modules’ own band vocabulary');
  const source = readFile(BAR);
  assert.ok(!/score >= \d+/.test(source), 'and none in the bar either');
});

test('a technical finding carries its rule’s description and fix, not an em dash', () => {
  // The per-rule rollup (crawl_run_findings.detail) only ever stored the title,
  // so "Detail" and "What to do" read "—" on every row of every crawl. They
  // come from the rule catalog, which also covers crawls stored before now.
  const row = moduleDetail.technicalFindingRow({
    rule_id: 'page-4xx', severity: 'error', category: 'Technical', count: '3', detail: { title: 'Pages returning 4XX errors' },
  });
  assert.strictEqual(row.count, 3);
  assert.match(row.detail, /client-side errors/);
  assert.match(row.recommendation, /Restore the page/);
  const unknown = moduleDetail.technicalFindingRow({ rule_id: 'retired-rule', severity: 'notice', count: 1, detail: {} });
  assert.strictEqual(unknown.title, 'retired-rule');
  assert.strictEqual(unknown.detail, null);
});

console.log('\nThe shared ScoreRing cannot render a missing score as zero');

test('ui/ScoreRing treats a non-finite score as unscored', () => {
  const source = require('fs').readFileSync(
    require('path').join(__dirname, '../../../../client/src/ui/ScoreRing.jsx'), 'utf8',
  );
  assert.ok(!/score = 0/.test(source), 'a zero default renders a catastrophic-looking ring');
  assert.match(source, /Number\.isFinite\(Number\(score\)\)/, 'it must test for a real number');
  assert.match(source, /scored \? Math\.round\(value\) : '—'/, 'and show an em dash otherwise');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
