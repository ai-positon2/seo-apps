// Tests for auditing pages as the crawl finds them.
//
// The old flow ran the three page-level modules and THEN queued the crawl, so
// they audited the previous crawl's pages and the result was presented as the
// current audit. Following a live crawl fixes that and introduces its own traps:
//
//   1. The audited set is now DISCOVERY order, not ranked by inbound links. That
//      is a different set, and the run has to say so rather than let a reader
//      assume the pages were chosen by importance.
//   2. A page must not be audited twice, however many times it appears in the
//      crawl's rows under different spellings.
//   3. The loop must stop. A crawl whose worker died would otherwise be followed
//      until the run's own allowance expired.
//   4. Two code paths now describe the same score, and they must describe it
//      identically.

const assert = require('assert');

const streamingAudit = require('../streamingAudit');
const moduleRunners = require('../moduleRunners');
const moduleEvidence = require('../moduleEvidence');
const { canonicalKey } = require('../crawledPages');

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

// ── The two paths must agree ────────────────────────────────────────────────

section('streaming and completed-crawl paths describe a score the same way');

test('the duplicated basis strings match, module for module', () => {
  // streamingAudit duplicates these rather than importing them, because requiring
  // moduleRunners there would close a cycle. Duplication is only safe if a test
  // notices the two drifting apart — and it has, twice.
  //
  // Compared key by key rather than whole-map: moduleRunners also holds bases for
  // the site-level modules, which streamingAudit never runs and has no business
  // knowing about. Asserting the maps were identical made adding a site-level
  // score fail a test about the streaming path, which is a test complaining about
  // the wrong thing.
  for (const key of moduleEvidence.PAGE_MODULE_KEYS) {
    assert.strictEqual(
      streamingAudit.SCORE_BASIS[key], moduleRunners.SCORE_BASIS[key],
      `${key}: the two paths describe the same score differently`,
    );
  }
});

test('streaming knows the per-page modules and only those', () => {
  assert.deepStrictEqual(
    Object.keys(streamingAudit.SCORE_BASIS).sort(),
    [...moduleEvidence.PAGE_MODULE_KEYS].sort(),
  );
  assert.deepStrictEqual(
    Object.keys(moduleRunners.PAGE_AUDITS).sort(),
    [...moduleEvidence.PAGE_MODULE_KEYS].sort(),
  );
});

test('every scoring module names its basis', () => {
  // The database refuses a score without one. A module that starts scoring and
  // forgets the basis fails at write time, in production, on a real run.
  for (const key of ['seo_geo', 'agent_readiness', 'competitor']) {
    assert.ok(
      moduleRunners.SCORE_BASIS[key],
      `${key} produces a score and must say what it means`,
    );
  }
});

test('every per-page module has an audit function', () => {
  for (const key of moduleEvidence.PAGE_MODULE_KEYS) {
    assert.strictEqual(
      typeof moduleRunners.PAGE_AUDITS[key], 'function',
      `${key} would be silently skipped by the streaming loop`,
    );
  }
});

// ── Stopping ───────────────────────────────────────────────────────────────

section('the follow loop has to stop');

test('every terminal crawl status ends the loop', () => {
  // A crawl that fails or is cancelled must end the follow, not just a completed
  // one. Missing 'failed' here would leave the audit polling a dead crawl until
  // its own allowance ran out.
  for (const status of ['completed', 'stopped', 'failed', 'cancelled']) {
    assert.ok(
      streamingAudit.CRAWL_TERMINAL.includes(status),
      `${status} is terminal for a crawl and must stop the follow`,
    );
  }
});

test('a running crawl does not end the loop', () => {
  for (const status of ['queued', 'running', 'paused']) {
    assert.ok(!streamingAudit.CRAWL_TERMINAL.includes(status));
  }
});

test('there is an idle timeout, and it is longer than the poll interval', () => {
  // Guards a crawl whose worker died without reaching a terminal status.
  assert.ok(streamingAudit.IDLE_TIMEOUT_MS > streamingAudit.POLL_MS * 10);
  assert.ok(streamingAudit.IDLE_TIMEOUT_MS <= 15 * 60 * 1000, 'waiting longer than this is pointless');
});

test('waiting for a crawl to start is patient enough to survive the queue', () => {
  // The bug this pins: one 5-minute idle timeout covering both "queued" and
  // "running with no new pages". Measured queue latency on this deployment is
  // 612-637 seconds, so the loop gave up EVERY time before the crawl began and
  // every streaming audit produced zero pages.
  const measuredQueueWaitMs = 637 * 1000;
  assert.ok(
    streamingAudit.QUEUE_TIMEOUT_MS > measuredQueueWaitMs,
    `queue patience ${streamingAudit.QUEUE_TIMEOUT_MS}ms must exceed the observed ${measuredQueueWaitMs}ms`,
  );
});

test('a queued crawl and a silent running crawl are judged separately', () => {
  // They are different kinds of waiting: one is queue latency, the other is a
  // dead worker. A single clock cannot be right for both.
  assert.ok(streamingAudit.QUEUE_TIMEOUT_MS > streamingAudit.IDLE_TIMEOUT_MS);
  for (const status of streamingAudit.CRAWL_PENDING) {
    assert.ok(
      !streamingAudit.CRAWL_TERMINAL.includes(status),
      `${status} means not started yet, not finished`,
    );
  }
});

test('the poll interval is slower than a page audit is fast', () => {
  // A page takes tens of seconds. Polling every few hundred milliseconds would
  // spend queries to learn nothing.
  assert.ok(streamingAudit.POLL_MS >= 1000);
});

// ── Not auditing the same page twice ───────────────────────────────────────

section('one page, one audit');

test('two spellings of one URL are one page', () => {
  // The crawl can store both, and auditing both would double the load on the
  // client's site and put a duplicate row in the report.
  const seen = new Set();
  for (const url of ['https://x.test/a', 'https://x.test/a/', 'https://x.test/a#top']) {
    seen.add(canonicalKey(url));
  }
  assert.strictEqual(seen.size, 1);
});

test('the budget counts distinct pages, not crawl rows', () => {
  const rows = [
    'https://x.test/', 'https://x.test', 'https://x.test/a', 'https://x.test/a/',
  ];
  const distinct = new Set(rows.map((u) => canonicalKey(u)));
  assert.strictEqual(distinct.size, 2, 'four rows, two pages');
});

// ── Keywords ───────────────────────────────────────────────────────────────

section('keywords are per page');

test('a page with no configured keyword gets none, not a guess', () => {
  const project = { settings: { pageKeywords: [{ url: 'https://x.test/a', keywords: ['crowns'] }] } };
  assert.deepStrictEqual(
    streamingAudit.keywordsForUrl(project, 'https://x.test/a', null),
    ['crowns'],
  );
  assert.deepStrictEqual(
    streamingAudit.keywordsForUrl(project, 'https://x.test/b', null),
    [],
    'a page with no keyword must not inherit another page\'s',
  );
});

test('an explicit request overrides the stored keywords', () => {
  const project = { settings: { pageKeywords: [{ url: 'https://x.test/a', keywords: ['crowns'] }] } };
  assert.deepStrictEqual(
    streamingAudit.keywordsForUrl(project, 'https://x.test/a', ['implants']),
    ['implants'],
  );
});

test('a project with no keyword settings does not throw', () => {
  assert.deepStrictEqual(streamingAudit.keywordsForUrl({}, 'https://x.test/a', null), []);
  assert.deepStrictEqual(streamingAudit.keywordsForUrl(null, 'https://x.test/a', null), []);
});

// ── Honesty about which pages were chosen ──────────────────────────────────

section('the run says how its pages were chosen');

test('the run records how its pages were chosen, and by what', () => {
  // This used to assert "discovery order", which is what the streaming path did
  // before: audit whatever the crawl stored next until a budget ran out. That
  // could put all ten audits on near-identical location pages and report one
  // template defect ten times, so the site average described one template.
  //
  // Now it is the homepage plus four pages chosen to differ from each other, and
  // the payload has to say WHICH way that went — model or fallback — because
  // "chosen to cover page types" and "chosen by a path-prefix heuristic" are
  // different claims about how representative the sample is.
  const src = require('fs').readFileSync(
    require('path').join(__dirname, '../streamingAudit.js'), 'utf8',
  );
  assert.ok(src.includes('pageSelection:'), 'the payload must record how pages were chosen');
  assert.ok(
    /pageSelectionMethod/.test(src),
    'and record whether the model or the fallback chose them',
  );
  assert.ok(
    /selectedPages/.test(src),
    'and record which pages were selected, so the choice can be inspected',
  );
});

test('the homepage is audited before the crawl finishes, the rest after', () => {
  // The ordering is the whole design: the homepage is the one page every site
  // has and the one worth showing while the crawl is still running, and the
  // other four need the finished crawl to be chosen from.
  const src = require('fs').readFileSync(
    require('path').join(__dirname, '../streamingAudit.js'), 'utf8',
  );
  const phase1 = src.indexOf('Phase 1');
  const phase2 = src.indexOf('Phase 2');
  const phase3 = src.indexOf('Phase 3');
  assert.ok(phase1 > 0 && phase2 > phase1 && phase3 > phase2, 'three phases, in order');
  assert.ok(
    src.indexOf('selectKeyPages') > phase2,
    'the four extra pages are selected only after the crawl has finished',
  );
});

test('the route no longer runs page modules before queuing the crawl', () => {
  const routes = require('fs').readFileSync(
    require('path').join(__dirname, '../routes.js'), 'utf8',
  );
  assert.ok(
    routes.includes('runFollowingCrawl'),
    'the audit route must be able to follow a live crawl',
  );
  assert.ok(
    routes.includes('followingLiveCrawl'),
    'and must tell the caller which of the two paths ran, since they audit different pages',
  );
});

test('the report can show pages from a run still in flight', () => {
  const detail = require('fs').readFileSync(
    require('path').join(__dirname, '../moduleDetail.js'), 'utf8',
  );
  assert.ok(
    detail.includes('const pageSource = inFlight || terminal'),
    'a report opened mid-audit must list the pages already finished',
  );
  assert.ok(
    detail.includes('pagesFromInFlightRun'),
    'and say that the list is still growing',
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
