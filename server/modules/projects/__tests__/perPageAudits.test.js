// Tests for auditing every page a crawl found.
//
// SEO & GEO, On-Page and Agent Readiness each audit ONE url, and a project has
// many, so a project run now stores a report per crawled page and reports the
// mean of the pages that scored. Three things in that arrangement are easy to
// break silently, and all three are the same mistake in different clothes:
// treating an absent measurement as a zero.
//
//   • aggregatePages averaging a failed page's null score as 0
//   • the picker sorting unscored pages to the top as if they were the worst
//   • the page budget quietly covering 10 of 50 pages and calling it the site
//
// The rest is ordering (audit the pages that matter first, because the budget
// truncates) and exclusion counting (say what was dropped, never drop silently).

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const crawledPages = require('../crawledPages');
const moduleEvidence = require('../moduleEvidence');
const moduleRunners = require('../moduleRunners');
const adminLimits = require('../../../services/adminLimits');

// The picker's rules live in the client (it owns its own presentation) and are
// plain ES module code, so they load here the same way moduleReportRoute does.
function loadPicker() {
  const src = fs.readFileSync(
    path.join(__dirname, '../../../../client/src/lib/pageReportPicker.js'),
    'utf8',
  )
    .replace(/export const/g, 'const')
    .replace(/export function/g, 'function');
  // eslint-disable-next-line no-new-func
  return new Function(`${src}; return { bandTone, orderWorstFirst, defaultPage, pathOf, isScored, BAND_TONE };`)();
}

const picker = loadPicker();

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

// ── Which pages get audited, and in what order ──────────────────────────────

section('crawledPages.auditOrder');

test('shallowest pages first — the budget truncates, so depth decides', () => {
  const ordered = crawledPages.auditOrder([
    { url: '/c', data: { depth: 3 } },
    { url: '/a', data: { depth: 0 } },
    { url: '/b', data: { depth: 1 } },
  ]);
  assert.deepStrictEqual(ordered.map((r) => r.url), ['/a', '/b', '/c']);
});

test('with no link graph it falls back to the count the crawl recorded', () => {
  const ordered = crawledPages.auditOrder([
    { url: '/quiet', data: { depth: 1, inlinks: 2 } },
    { url: '/hub', data: { depth: 1, inlinks: 40 } },
    { url: '/mid', data: { depth: 1, inlinks: 9 } },
  ]);
  assert.deepStrictEqual(ordered.map((r) => r.url), ['/hub', '/mid', '/quiet']);
});

test('the link graph decides which pages a budget covers', () => {
  // The crawl's own data.inlinks field is 0 on every row of every real crawl
  // measured — it is not populated — so ordering on it alone left a
  // sitemap-fed crawl (49 of 50 pages at depth 1) choosing by row id.
  const inbound = new Map([
    ['x.test/hub', 31],
    ['x.test/quiet', 1],
  ]);
  const ordered = crawledPages.auditOrder([
    { url: 'https://x.test/quiet', data: { depth: 1, inlinks: 0 } },
    { url: 'https://x.test/hub', data: { depth: 1, inlinks: 0 } },
  ], inbound);
  assert.deepStrictEqual(
    ordered.map((r) => r.url),
    ['https://x.test/hub', 'https://x.test/quiet'],
  );
});

test('the graph outranks the crawl field where both exist', () => {
  const inbound = new Map([['x.test/real', 20]]);
  const ordered = crawledPages.auditOrder([
    { url: 'https://x.test/claims', data: { depth: 1, inlinks: 99 } },
    { url: 'https://x.test/real', data: { depth: 1, inlinks: 0 } },
  ], inbound);
  assert.strictEqual(ordered[0].url, 'https://x.test/real');
});

test('depth still comes first — a hub three clicks deep is not the homepage', () => {
  const inbound = new Map([['x.test/hub', 40], ['x.test/', 2]]);
  const ordered = crawledPages.auditOrder([
    { url: 'https://x.test/a/b/hub', data: { depth: 3 } },
    { url: 'https://x.test/', data: { depth: 0 } },
  ], inbound);
  assert.strictEqual(ordered[0].url, 'https://x.test/');
});

test('pages the graph does not mention rank below pages it does', () => {
  const inbound = new Map([['x.test/linked', 1]]);
  const ordered = crawledPages.auditOrder([
    { url: 'https://x.test/unmentioned', data: { depth: 1 } },
    { url: 'https://x.test/linked', data: { depth: 1 } },
  ], inbound);
  assert.deepStrictEqual(
    ordered.map((r) => r.url),
    ['https://x.test/linked', 'https://x.test/unmentioned'],
  );
});

test('a tie resolves to the page nearer the root, then alphabetically', () => {
  // The last resort has to be deterministic: the same crawl must always produce
  // the same audit set, or two runs are not comparable.
  const ordered = crawledPages.auditOrder([
    { url: 'https://x.test/a/b/c/deep', data: { depth: 1 } },
    { url: 'https://x.test/zebra', data: { depth: 1 } },
    { url: 'https://x.test/apple', data: { depth: 1 } },
  ], new Map());
  assert.deepStrictEqual(
    ordered.map((r) => r.url),
    ['https://x.test/apple', 'https://x.test/zebra', 'https://x.test/a/b/c/deep'],
  );
});

test('the same input always yields the same order', () => {
  const rows = [
    { url: 'https://x.test/one', data: { depth: 1 } },
    { url: 'https://x.test/two', data: { depth: 1 } },
    { url: 'https://x.test/three', data: { depth: 1 } },
  ];
  const a = crawledPages.auditOrder(rows, new Map()).map((r) => r.url);
  const b = crawledPages.auditOrder([...rows].reverse(), new Map()).map((r) => r.url);
  assert.deepStrictEqual(a, b, 'row order must not change the audit set');
});

section('crawledPages.canonicalKey');

test('one spelling per page, or the graph joins to nothing', () => {
  const root = crawledPages.canonicalKey('https://x.test/');
  assert.strictEqual(crawledPages.canonicalKey('https://x.test'), root);
  assert.strictEqual(crawledPages.canonicalKey('https://x.test/#main'), root);
  assert.strictEqual(
    crawledPages.canonicalKey('https://x.test/services/'),
    crawledPages.canonicalKey('https://x.test/services'),
  );
  assert.strictEqual(
    crawledPages.canonicalKey('https://X.TEST/services'),
    crawledPages.canonicalKey('https://x.test/services'),
  );
});

test('a query string is part of the page identity', () => {
  assert.notStrictEqual(
    crawledPages.canonicalKey('https://x.test/search?q=a'),
    crawledPages.canonicalKey('https://x.test/search?q=b'),
  );
});

test('an unparseable url still gets a key rather than throwing', () => {
  assert.strictEqual(crawledPages.canonicalKey('nonsense'), 'nonsense');
  assert.strictEqual(crawledPages.canonicalKey(null), null);
});

test('a page with no recorded depth sorts last, not first', () => {
  // Number(undefined) is NaN, and a NaN comparison would leave the order to
  // chance. An unknown depth must not outrank the homepage.
  const ordered = crawledPages.auditOrder([
    { url: '/unknown', data: {} },
    { url: '/home', data: { depth: 0 } },
  ]);
  assert.deepStrictEqual(ordered.map((r) => r.url), ['/home', '/unknown']);
});

test('depth 0 is a depth, not a missing value', () => {
  const ordered = crawledPages.auditOrder([
    { url: '/deep', data: { depth: 2 } },
    { url: '/home', data: { depth: 0 } },
  ]);
  assert.strictEqual(ordered[0].url, '/home');
});

test('inlinks 0 does not throw the comparison', () => {
  const ordered = crawledPages.auditOrder([
    { url: '/orphan', data: { depth: 1, inlinks: 0 } },
    { url: '/linked', data: { depth: 1, inlinks: 5 } },
  ]);
  assert.deepStrictEqual(ordered.map((r) => r.url), ['/linked', '/orphan']);
});

test('the input array is not mutated', () => {
  const rows = [{ url: '/b', data: { depth: 2 } }, { url: '/a', data: { depth: 1 } }];
  crawledPages.auditOrder(rows);
  assert.strictEqual(rows[0].url, '/b');
});

test('reads a page at a time in PostgREST-sized pages', () => {
  // PostgREST caps a response at 1,000 rows whatever .limit() says. A page size
  // above that would silently read a fraction of a large crawl.
  assert.ok(crawledPages.PAGE_SIZE <= 1000, `PAGE_SIZE=${crawledPages.PAGE_SIZE} exceeds the PostgREST cap`);
});

// ── The page budget ─────────────────────────────────────────────────────────

section('page budget');

test('maxPagesPerModuleAudit is a real limit key with a direction', () => {
  assert.ok(
    Object.prototype.hasOwnProperty.call(adminLimits.DEFAULT_LIMITS, 'maxPagesPerModuleAudit'),
    'the limit must be an admin-visible policy, not a constant buried in a runner',
  );
  assert.strictEqual(adminLimits.DIRECTION.maxPagesPerModuleAudit, 'min');
});

test('the default budget is bounded — a full pass is hours of work', () => {
  const budget = adminLimits.DEFAULT_LIMITS.maxPagesPerModuleAudit;
  assert.ok(budget >= 1, 'a budget below 1 would audit nothing');
  assert.ok(budget <= 50, `a budget of ${budget} pages across three modules runs for hours`);
});

// ── Rolling per-page scores into one number ─────────────────────────────────

section('moduleEvidence.aggregatePages');

test('the mean counts only the pages that scored', () => {
  const rollup = moduleEvidence.aggregatePages([
    { status: 'completed', score: 90, findings: [] },
    { status: 'completed', score: 70, findings: [] },
    { status: 'failed', score: null, findings: [] },
  ]);
  // Number(null) is 0, so the naive mean here is 53 — a failed page dragging the
  // site average down as if it had been measured and found terrible.
  assert.strictEqual(rollup.mean, 80);
  assert.strictEqual(rollup.scoredPages, 2);
  assert.strictEqual(rollup.failedPages, 1);
  assert.strictEqual(rollup.totalPages, 3);
});

test('no page scored means no score — not zero', () => {
  const rollup = moduleEvidence.aggregatePages([
    { status: 'completed', score: null, findings: [] },
    { status: 'failed', score: null, findings: [] },
  ]);
  assert.strictEqual(rollup.mean, null);
  assert.strictEqual(rollup.scoredPages, 0);
});

test('a genuine 0 is a measurement and counts', () => {
  const rollup = moduleEvidence.aggregatePages([
    { status: 'completed', score: 0, findings: [] },
    { status: 'completed', score: 50, findings: [] },
  ]);
  assert.strictEqual(rollup.mean, 25);
  assert.strictEqual(rollup.scoredPages, 2);
});

test('undefined is as absent as null', () => {
  const rollup = moduleEvidence.aggregatePages([
    { status: 'completed', score: 40, findings: [] },
    { status: 'completed', findings: [] },
  ]);
  assert.strictEqual(rollup.mean, 40);
  assert.strictEqual(rollup.scoredPages, 1);
});

test('no pages at all is not a zero either', () => {
  const rollup = moduleEvidence.aggregatePages([]);
  assert.strictEqual(rollup.mean, null);
  assert.strictEqual(rollup.totalPages, 0);
  assert.deepStrictEqual(rollup.findings, []);
});

test('the same defect on many pages is one finding carrying its page count', () => {
  const rollup = moduleEvidence.aggregatePages([
    {
      status: 'completed',
      score: 60,
      url: 'https://x.test/a',
      findings: [{ ruleId: 'seogeo-A1', title: 'No title', severity: 'error', count: 1 }],
    },
    {
      status: 'completed',
      score: 60,
      url: 'https://x.test/b',
      findings: [{ ruleId: 'seogeo-A1', title: 'No title', severity: 'error', count: 1 }],
    },
  ]);
  assert.strictEqual(rollup.findings.length, 1, 'one rule, not one row per page');
  assert.strictEqual(rollup.findings[0].pageCount, 2);
  assert.deepStrictEqual(rollup.findings[0].pages, ['https://x.test/a', 'https://x.test/b']);
});

test('distinct defects stay distinct', () => {
  const rollup = moduleEvidence.aggregatePages([
    {
      status: 'completed',
      score: 60,
      url: 'https://x.test/a',
      findings: [
        { ruleId: 'seogeo-A1', title: 'No title', severity: 'error', count: 1 },
        { ruleId: 'seogeo-F2', title: 'Thin content', severity: 'warning', count: 1 },
      ],
    },
  ]);
  assert.strictEqual(rollup.findings.length, 2);
});

test('a run-wide finding list cannot grow without bound', () => {
  // 50 pages × ~40 findings each would put 2,000 rows in one jsonb column.
  const pages = Array.from({ length: 30 }, (_, i) => ({
    status: 'completed',
    score: 50,
    url: `https://x.test/p${i}`,
    findings: [{ ruleId: 'seogeo-A1', title: 'No title', severity: 'error', count: 1 }],
  }));
  const rollup = moduleEvidence.aggregatePages(pages);
  assert.strictEqual(rollup.findings[0].pageCount, 30, 'the count is all 30');
  assert.ok(rollup.findings[0].pages.length <= 25, 'the example list is capped');
});

test('errors sort above warnings in the rolled-up list', () => {
  const rollup = moduleEvidence.aggregatePages([
    {
      status: 'completed',
      score: 50,
      url: 'https://x.test/a',
      findings: [
        { ruleId: 'w', title: 'Warn', severity: 'warning', count: 1 },
        { ruleId: 'e', title: 'Err', severity: 'error', count: 1 },
      ],
    },
  ]);
  assert.strictEqual(rollup.findings[0].severity, 'error');
});

// ── Which modules audit pages ───────────────────────────────────────────────

section('per-page module set');

test('exactly the two single-url modules audit per page', () => {
  // on_page was a third until the standalone /on-page-audit page was removed.
  // The On-Page report is a tab inside the SEO & GEO Audit now, running ad-hoc
  // audits through /api/on-page-audit rather than storing project runs.
  assert.deepStrictEqual(
    [...moduleEvidence.PAGE_MODULE_KEYS].sort(),
    ['agent_readiness', 'seo_geo'],
  );
});

test('the site-level modules are not in it', () => {
  for (const key of ['technical', 'competitor', 'hub_spoke']) {
    assert.ok(
      !moduleEvidence.PAGE_MODULE_KEYS.includes(key),
      `${key} measures a site, not a page`,
    );
  }
});

test('every per-page module is runnable and has a runner', () => {
  for (const key of moduleEvidence.PAGE_MODULE_KEYS) {
    assert.ok(moduleRunners.RUNNABLE.includes(key), `${key} missing from RUNNABLE`);
    assert.strictEqual(typeof moduleRunners.RUNNERS[key], 'function', `${key} has no runner`);
  }
});

test('none of them is metered — a crawl-wide pass must not spend units per page', () => {
  for (const key of moduleEvidence.PAGE_MODULE_KEYS) {
    assert.ok(
      !moduleRunners.METERED[key],
      `${key} is metered; running it across every crawled page would multiply the bill`,
    );
    assert.strictEqual(moduleRunners.estimateCost(key, { competitorCount: 3 }), null);
  }
});

test('all three run in the default full audit', () => {
  for (const key of moduleEvidence.PAGE_MODULE_KEYS) {
    assert.ok(moduleRunners.DEFAULT_AUDIT_MODULES.includes(key), `${key} missing from a full audit`);
  }
});

// ── The report picker ───────────────────────────────────────────────────────

section('pageReportPicker');

test('a module\'s own band decides the colour', () => {
  assert.strictEqual(picker.bandTone('Excellent'), 'pos');
  assert.strictEqual(picker.bandTone('Needs work'), 'warn');
  assert.strictEqual(picker.bandTone('Critical'), 'neg');
});

test('agent readiness levels are matched inside their label', () => {
  assert.strictEqual(picker.bandTone('Level 4 — Agent Native'), 'pos');
  assert.strictEqual(picker.bandTone('Level 2 — AI Aware'), 'warn');
  assert.strictEqual(picker.bandTone('Level 0 — Not Indexed'), 'neg');
});

test('an unrecognised band gets no colour rather than a guessed one', () => {
  // If a module changes its vocabulary the UI must go quiet, not invent a verdict.
  assert.strictEqual(picker.bandTone('Tremendous'), null);
  assert.strictEqual(picker.bandTone(''), null);
  assert.strictEqual(picker.bandTone(null), null);
  assert.strictEqual(picker.bandTone(undefined), null);
});

test('On-Page has no band, so its pages are never tinted', () => {
  // Its band field carries a page type ("Service page"), not a judgement.
  assert.strictEqual(picker.bandTone('Service page'), null);
  assert.strictEqual(picker.bandTone('Article · YMYL'), null);
});

test('worst-scoring page comes first', () => {
  const ordered = picker.orderWorstFirst([
    { pageRunId: 'a', score: 88, ordinal: 0 },
    { pageRunId: 'b', score: 41, ordinal: 1 },
    { pageRunId: 'c', score: 62, ordinal: 2 },
  ]);
  assert.deepStrictEqual(ordered.map((p) => p.pageRunId), ['b', 'c', 'a']);
});

test('unscored and failed pages sort last, not first', () => {
  const ordered = picker.orderWorstFirst([
    { pageRunId: 'failed', score: null, status: 'failed', ordinal: 0 },
    { pageRunId: 'worst', score: 30, ordinal: 1 },
    { pageRunId: 'best', score: 95, ordinal: 2 },
  ]);
  assert.deepStrictEqual(
    ordered.map((p) => p.pageRunId),
    ['worst', 'best', 'failed'],
    'a page nobody could audit is not the worst page',
  );
});

test('a page that genuinely scored 0 is the worst page', () => {
  const ordered = picker.orderWorstFirst([
    { pageRunId: 'ok', score: 50, ordinal: 0 },
    { pageRunId: 'zero', score: 0, ordinal: 1 },
    { pageRunId: 'unscored', score: null, ordinal: 2 },
  ]);
  assert.deepStrictEqual(ordered.map((p) => p.pageRunId), ['zero', 'ok', 'unscored']);
});

test('equal scores keep crawl order', () => {
  const ordered = picker.orderWorstFirst([
    { pageRunId: 'deep', score: 70, ordinal: 5 },
    { pageRunId: 'home', score: 70, ordinal: 0 },
  ]);
  assert.deepStrictEqual(ordered.map((p) => p.pageRunId), ['home', 'deep']);
});

test('an unscored module (On-Page) keeps every page in crawl order', () => {
  const ordered = picker.orderWorstFirst([
    { pageRunId: 'c', score: null, ordinal: 2 },
    { pageRunId: 'a', score: null, ordinal: 0 },
    { pageRunId: 'b', score: null, ordinal: 1 },
  ]);
  assert.deepStrictEqual(ordered.map((p) => p.pageRunId), ['a', 'b', 'c']);
});

test('ordering does not mutate its input', () => {
  const pages = [{ pageRunId: 'a', score: 90, ordinal: 0 }, { pageRunId: 'b', score: 10, ordinal: 1 }];
  picker.orderWorstFirst(pages);
  assert.strictEqual(pages[0].pageRunId, 'a');
});

test('the report opens on the first page audited, not the worst', () => {
  const first = picker.defaultPage([
    { pageRunId: 'deep', score: 12, ordinal: 7 },
    { pageRunId: 'home', score: 88, ordinal: 0 },
  ]);
  assert.strictEqual(first.pageRunId, 'home', 'landing several levels deep is disorienting');
});

test('no pages means no default', () => {
  assert.strictEqual(picker.defaultPage([]), null);
  assert.strictEqual(picker.defaultPage(null), null);
});

test('the picker labels a page by its path', () => {
  assert.strictEqual(picker.pathOf('https://x.test/services/implants'), '/services/implants');
  assert.strictEqual(picker.pathOf('https://x.test/'), '/ (home)');
  assert.strictEqual(picker.pathOf('https://x.test'), '/ (home)');
});

test('a query string is part of what tells two pages apart', () => {
  assert.strictEqual(picker.pathOf('https://x.test/search?q=crowns'), '/search?q=crowns');
});

test('an unparseable url shows itself rather than vanishing', () => {
  assert.strictEqual(picker.pathOf('not a url'), 'not a url');
  assert.strictEqual(picker.pathOf(null), null);
});

test('isScored treats 0 as measured and null as not', () => {
  assert.strictEqual(picker.isScored({ score: 0 }), true);
  assert.strictEqual(picker.isScored({ score: null }), false);
  assert.strictEqual(picker.isScored({}), false);
  assert.strictEqual(picker.isScored(null), false);
});

section('how long a run is allowed to take');

test('the allowance scales with the page budget', () => {
  // The bug this replaces: one global 30-minute cutoff, justified by a comment
  // saying "the slowest module measured is under a minute". True when every
  // module audited a single page; false the moment three of them started
  // auditing the whole crawl. A healthy 10-page SEO & GEO run takes ~22 minutes
  // at the measured ~130s/page, so the old cutoff had eight minutes of headroom
  // and a budget of 20 would have had the sweeper killing healthy runs.
  const ten = moduleEvidence.allowanceMinutes('seo_geo', { pageBudget: 10 });
  const twenty = moduleEvidence.allowanceMinutes('seo_geo', { pageBudget: 20 });
  assert.ok(ten > 22, `${ten} min must exceed the ~22 min a 10-page run really takes`);
  assert.ok(twenty > ten, 'doubling the budget must raise the allowance');
});

test('a bigger budget can never be given less time', () => {
  let previous = 0;
  for (const pageBudget of [1, 5, 10, 25, 50]) {
    const allowance = moduleEvidence.allowanceMinutes('seo_geo', { pageBudget });
    assert.ok(allowance >= previous, `budget ${pageBudget} got less time than the one below it`);
    previous = allowance;
  }
});

test('site-level modules do not scale with pages', () => {
  // Hub and Spoke reads stored rows; the page budget is irrelevant to it, and
  // making its allowance grow with a number it never reads would be noise.
  assert.strictEqual(
    moduleEvidence.allowanceMinutes('hub_spoke', { pageBudget: 10 }),
    moduleEvidence.allowanceMinutes('hub_spoke', { pageBudget: 50 }),
  );
});

test('every allowance includes grace for a slow start', () => {
  // Queueing, a cold start, an origin having a bad day. Without it the allowance
  // is exactly the happy path and any friction reads as death.
  assert.strictEqual(
    moduleEvidence.allowanceMinutes('hub_spoke'),
    moduleEvidence.FLAT_MINUTES.hub_spoke + moduleEvidence.GRACE_MINUTES,
  );
});

test('a nonsense budget falls back rather than producing a tiny allowance', () => {
  // 0 or a negative would otherwise yield an allowance of just the grace period,
  // and the sweeper would kill every run of that module ten minutes in.
  for (const bad of [0, -5, null, undefined, 'ten', NaN]) {
    const allowance = moduleEvidence.allowanceMinutes('seo_geo', { pageBudget: bad });
    assert.ok(allowance > moduleEvidence.GRACE_MINUTES, `budget ${bad} produced ${allowance} min`);
  }
});

test('an unknown module still gets a finite, generous allowance', () => {
  // A module added later must not default to zero and be swept instantly.
  const allowance = moduleEvidence.allowanceMinutes('something_new');
  assert.ok(Number.isFinite(allowance) && allowance >= 30);
});

test('every runnable module has an allowance defined for it', () => {
  for (const key of moduleRunners.RUNNABLE) {
    const perPage = moduleEvidence.MINUTES_PER_PAGE[key];
    const flat = moduleEvidence.FLAT_MINUTES[key];
    assert.ok(
      perPage || flat,
      `${key} has no allowance, so it silently inherits the unknown-module default`,
    );
  }
});

test('the per-page modules are the ones that scale', () => {
  // If these two lists ever disagree, a module that audits the whole crawl gets
  // a flat allowance and gets swept mid-run.
  assert.deepStrictEqual(
    Object.keys(moduleEvidence.MINUTES_PER_PAGE).sort(),
    [...moduleEvidence.PAGE_MODULE_KEYS].sort(),
  );
});

test('an unset sweep override is not an allowance of zero minutes', () => {
  // Number(null) is 0 and Number.isFinite(0) is true, so the default argument
  // read as "zero minutes allowed" and every open run was failed instantly.
  const olderThanMinutes = null;
  const hasOverride = olderThanMinutes !== null
    && olderThanMinutes !== undefined
    && Number.isFinite(Number(olderThanMinutes));
  assert.strictEqual(hasOverride, false, 'null must not be read as a numeric override');
  assert.strictEqual(Number.isFinite(Number(null)), true, 'this is why the naive check failed');
});

test('an explicit zero override is still honoured', () => {
  // Distinguishing "unset" from "zero" both ways: an operator forcing an
  // immediate sweep must still be able to.
  const olderThanMinutes = 0;
  const hasOverride = olderThanMinutes !== null
    && olderThanMinutes !== undefined
    && Number.isFinite(Number(olderThanMinutes));
  assert.strictEqual(hasOverride, true);
});

test('adminLimits is imported where the runner reads a limit', () => {
  // It was used and never required: a ReferenceError, so every Re-run returned
  // 500 with "Something went wrong handling that project request."
  const src = require('fs').readFileSync(
    require('path').join(__dirname, '../moduleRunners.js'), 'utf8',
  );
  if (/adminLimits\./.test(src)) {
    assert.ok(
      /require\(['"]\.\.\/\.\.\/services\/adminLimits['"]\)/.test(src),
      'moduleRunners uses adminLimits and must require it',
    );
  }
});

section('an interrupted run keeps the pages it finished');

test('salvage is offered only to per-page modules', () => {
  // A site-level module has no page rows to keep, so there is nothing to salvage
  // and it should be failed as before.
  const src = require('fs').readFileSync(
    require('path').join(__dirname, '../moduleEvidence.js'), 'utf8',
  );
  assert.ok(
    /if \(!PAGE_MODULE_KEYS\.includes\(row\.moduleKey\)\) return false/.test(src),
    'salvage must decline site-level modules',
  );
});

test('a run with no completed page is still a failure', () => {
  // Salvage must not turn "died before finishing anything" into a completed run
  // with a null score. That would put an empty result on a card as if it had
  // measured something.
  const src = require('fs').readFileSync(
    require('path').join(__dirname, '../moduleEvidence.js'), 'utf8',
  );
  assert.ok(
    /if \(!usable\.length\) return false/.test(src),
    'no completed pages means the run genuinely failed',
  );
});

test('salvage reads only completed pages into the rollup', () => {
  // A page that was mid-audit when the process stopped has no findings and no
  // score. Including it would drag the mean down and count as a measured page.
  const src = require('fs').readFileSync(
    require('path').join(__dirname, '../moduleEvidence.js'), 'utf8',
  );
  const fn = src.slice(src.indexOf('async function salvageInterruptedRun'));
  assert.match(
    fn, /where run_id = \$1 and status = 'completed'/,
    'the rollup must be built from completed pages only',
  );
});

test('a salvaged run is labelled interrupted and says what it covered', () => {
  const src = require('fs').readFileSync(
    require('path').join(__dirname, '../moduleEvidence.js'), 'utf8',
  );
  const fn = src.slice(src.indexOf('async function salvageInterruptedRun'));
  assert.ok(fn.includes('interrupted: true'), 'the payload must flag it');
  assert.ok(/was interrupted after/.test(fn), 'and the note must say so in words');
  assert.ok(/Re-run it for full coverage/.test(fn), 'and name the remedy');
  assert.ok(
    fn.includes('pagesAbandonedMidAudit'),
    'pages that were mid-audit are counted separately from pages that finished',
  );
});

test('a forced sweep does not claim the run had a zero allowance', () => {
  // Passing olderThanMinutes: 0 to close runs by hand produced "past the
  // 0-minute allowance this run was given", which is not what happened: the run
  // had a real allowance and a person closed it early.
  const src = require('fs').readFileSync(
    require('path').join(__dirname, '../moduleEvidence.js'), 'utf8',
  );
  assert.ok(src.includes('forced: hasOverride'), 'the sweep must record that it was forced');
  assert.ok(/Closed by hand after/.test(src), 'and say so rather than quoting the override');
});

test('salvage cannot overwrite a run that finished on its own', () => {
  // The guard that stops a race between the sweeper and a run completing
  // normally in the same second.
  const src = require('fs').readFileSync(
    require('path').join(__dirname, '../moduleEvidence.js'), 'utf8',
  );
  const fn = src.slice(src.indexOf('async function salvageInterruptedRun'));
  assert.match(
    fn, /where id = \$\$\{params\.length\} and status = 'running'/,
    'the update must be conditional on the run still being open',
  );
});

section("On-Page reports the module's own pass rate");

const { passRate } = require('../../onPageAudit/auditor');
const checks = (counts) => ({
  sections: [{
    checks: Object.entries(counts).flatMap(([status, n]) => Array(n).fill({ status })),
  }],
});

test('the score matches what the report has always shown', () => {
  // The exact page from the report: 37 pass, 8 fail, 8 warning, 13 manual, 12 na,
  // displayed as 70%. The project card must not disagree with the report it links
  // to — two screens showing different numbers for one audit is the fastest way
  // to lose a client's trust in both.
  assert.strictEqual(passRate(checks({ pass: 37, fail: 8, warning: 8, manual: 13, na: 12 })).score, 70);
});

test('the server and the report compute it identically', () => {
  // The report computes this inline, so both formulas are asserted here — a
  // change to one is caught rather than discovered on a client call.
  //
  // This used to read one hardcoded path (pages/OnPageAuditPage.jsx). main's
  // On-Page tab refactor moved the scorecard into
  // components/onPageAudit/OnPageReport.jsx and the test broke without anything
  // actually regressing. Pinning a path tests the file layout, not the
  // methodology, so it now searches for wherever the formula lives.
  const fs = require('fs');
  const path = require('path');
  const clientSrc = path.join(__dirname, '../../../../client/src');

  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return walk(full);
    return /\.(jsx?|tsx?)$/.test(e.name) ? [full] : [];
  });

  const carriers = walk(clientSrc).filter((f) => {
    const src = fs.readFileSync(f, 'utf8');
    return src.includes('counts.pass + counts.fail + counts.warning');
  });

  assert.ok(
    carriers.length > 0,
    'no client file computes the on-page score — the report must still exclude '
    + 'manual and na from the denominator',
  );

  for (const f of carriers) {
    const src = fs.readFileSync(f, 'utf8');
    assert.ok(
      src.includes('Math.round((counts.pass / scored) * 100)'),
      `${path.relative(clientSrc, f)} counts the same denominator but computes a `
      + 'different percentage from the server',
    );
  }
});
test('manual and na are excluded from the denominator', () => {
  // The substance of the methodology. A page whose keyword checks stood down
  // because nobody set a keyword must not be scored down for them.
  const withNa = passRate(checks({ pass: 5, fail: 5, na: 90 }));
  const without = passRate(checks({ pass: 5, fail: 5 }));
  assert.strictEqual(withNa.score, without.score, '90 inapplicable checks must not move the score');
  assert.strictEqual(withNa.score, 50);
});

test('nothing judgeable is null, not zero', () => {
  // A page where every check needed a human or did not apply has no pass rate.
  // Zero would read as a page that failed everything.
  assert.strictEqual(passRate(checks({ manual: 5, na: 5 })).score, null);
  assert.strictEqual(passRate({ sections: [] }).score, null);
  assert.strictEqual(passRate(null).score, null);
});

test('a genuine zero survives', () => {
  assert.strictEqual(passRate(checks({ fail: 10 })).score, 0);
});

test('an unknown status is ignored rather than counted', () => {
  const r = passRate({ sections: [{ checks: [{ status: 'pass' }, { status: 'something_new' }] }] });
  assert.strictEqual(r.score, 100);
  assert.strictEqual(r.scored, 1);
});

test('every scoring module names its methodology', () => {
  // The DB refuses a score without one, and "70" with no explanation is a number
  // nobody can argue with or trust.
  //
  // This used to assert on_page's basis specifically. Asserting the invariant
  // across whatever modules score is the better test anyway — it survives a
  // module being added or removed, which is exactly what just happened.
  const bases = Object.entries(moduleRunners.SCORE_BASIS);
  assert.ok(bases.length > 0, 'at least one module must score');
  for (const [key, basis] of bases) {
    assert.strictEqual(typeof basis, 'string', `${key} must carry a basis`);
    assert.ok(basis.length > 20, `${key}'s basis must actually explain something`);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
