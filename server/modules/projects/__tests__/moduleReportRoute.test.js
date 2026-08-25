// Tests for where a dashboard card's Open button goes.
//
// The rule being protected: pressing Open on a card lands on that module's own
// report, with no intermediate page to click through. Three modules keep their
// report on a route; three render it from page state, where the destination is
// the tool page and its project panel hydrates the report on arrival.
//
// The helper lives in the client (it owns routing) and is plain ES module code,
// so it is loaded here by stripping the export keywords rather than adding a
// build step to the server's test run.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const SOURCE = path.join(__dirname, '../../../../client/src/lib/moduleReportRoute.js');

function loadHelper() {
  const src = fs.readFileSync(SOURCE, 'utf8')
    .replace(/export function/g, 'function')
    .replace(/^export default.*$/gm, '')
    .replace(/^export .*$/gm, '');
  // eslint-disable-next-line no-new-func
  return new Function(`${src}; return moduleReportRoute;`)();
}

const moduleReportRoute = loadHelper();

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

console.log('\nOpen goes straight to the report — route-based modules');

test('Site Crawler goes to its crawl run, not to the crawler page', () => {
  const r = moduleReportRoute({ key: 'technical', runId: 'run-1', toolPath: '/crawl-scope', evidence: {} });
  assert.strictEqual(r.path, '/crawl-scope/runs/run-1');
  assert.strictEqual(r.isReport, true);
});

test('Content Architect goes to its project report', () => {
  const r = moduleReportRoute({ key: 'hub_spoke', reportRef: 'proj_x', toolPath: '/content-architect', evidence: {} });
  assert.strictEqual(r.path, '/content-architect/proj_x');
  assert.strictEqual(r.isReport, true);
});

test('Competitor Research goes to its dashboard with the client selected', () => {
  // Without the id it would land on whichever client happens to be first, which
  // is not this project's comparison.
  const r = moduleReportRoute({ key: 'competitor', reportRef: 'client_y', toolPath: '/competitor-analysis', evidence: {} });
  assert.strictEqual(r.path, '/competitor-analysis?client=client_y');
});

test('a route-based module with no stored ref falls back to its tool page', () => {
  // A run recorded before the ref was stored. Better the tool than a link to a
  // report that does not exist.
  const r = moduleReportRoute({ key: 'hub_spoke', reportRef: null, toolPath: '/content-architect', evidence: null, status: 'insufficient_data' });
  assert.strictEqual(r.path, '/content-architect');
  assert.strictEqual(r.isReport, false);
});

console.log('\nOpen goes straight to the report — in-page modules');

test('the three in-page modules go to their tool page, which hydrates on arrival', () => {
  for (const [key, toolPath] of [
    ['seo_geo', '/seo-geo-audit'],
    ['on_page', '/on-page-audit'],
    ['agent_readiness', '/agent-readiness-audit'],
  ]) {
    const r = moduleReportRoute({ key, toolPath, evidence: {} });
    assert.strictEqual(r.path, toolPath, `${key} should open its own page`);
    assert.strictEqual(r.isReport, true, `${key} has evidence, so the page shows a report`);
    assert.strictEqual(r.label, 'View report');
  }
});

test('a module with no evidence says Open, not View report', () => {
  // There is nothing to view yet, and promising a report would be the same
  // overstatement the cards avoid elsewhere.
  const r = moduleReportRoute({ key: 'on_page', toolPath: '/on-page-audit', evidence: null, status: 'not_run' });
  assert.strictEqual(r.label, 'Open');
  assert.strictEqual(r.isReport, false);
});

console.log('\nOne answer, in one place');

test('the dashboard card gets its destination from the helper', () => {
  const card = fs.readFileSync(
    path.join(__dirname, '../../../../client/src/components/home/ModuleCard.jsx'), 'utf8',
  );
  assert.ok(card.includes('moduleReportRoute'), 'the card must use the shared helper');
  // A second copy of a route drifts the moment one of these modules moves.
  for (const composed of ['/crawl-scope/runs/${', '/content-architect/${', '?client=${']) {
    assert.ok(!card.includes(composed), `the card composes ${composed}… itself`);
  }
});

test('the module pages show their own report and nothing above it', () => {
  // A summary panel used to sit above each report repeating its numbers. The
  // three pages whose report renders from page state mount the report bar
  // instead, which hands one page's report over and offers the switcher for the
  // rest; the three whose report is a route mount nothing, because the card
  // links straight there.
  const page = (f) => fs.readFileSync(
    path.join(__dirname, '../../../../client/src/pages/', f), 'utf8',
  );

  for (const f of ['SeoGeoAuditPage.jsx', 'AgentReadinessAuditPage.jsx']) {
    assert.ok(page(f).includes('ProjectReportBar'), `${f} must load the stored run`);
    assert.ok(!page(f).includes('ModuleDetailPanel'), `${f} must not show a summary panel`);
  }

  for (const f of ['CompetitorAnalysisDashboardPage.jsx', 'CrawlScopePage.jsx', 'ContentArchitectPage.jsx']) {
    assert.ok(!page(f).includes('ModuleDetailPanel'), `${f} must show only its own report`);
    assert.ok(!page(f).includes('ProjectReportBar'), `${f} renders no report to load into`);
  }
});

test('the bar renders nothing when there is no project or no stored run', () => {
  // A tool page with no project context must be exactly the tool it was before.
  const bar = fs.readFileSync(
    path.join(__dirname, '../../../../client/src/components/project/ProjectReportBar.jsx'), 'utf8',
  );
  assert.ok(bar.includes('if (!project || !detail) return null;'),
    'no project or no detail means nothing rendered');
});

// The page-switcher placement test went with OnPageAuditPage.jsx.
//
// It asserted that page mounted <ProjectReportBar> ABOVE its input/report view
// switch, because with the bar inside the input branch it unmounted the moment a
// report opened and changing page became impossible after the first one. That
// page has been removed along with the on_page module, and the two pages that
// remain have no such view switch — the loop above already checks they mount the
// bar at all.
test('the competitor dashboard honours the client id the link carries', () => {
  const page = fs.readFileSync(
    path.join(__dirname, '../../../../client/src/pages/CompetitorAnalysisDashboardPage.jsx'), 'utf8',
  );
  assert.ok(page.includes("searchParams.get('client')"), 'it must read the id from the URL');
  assert.ok(
    page.includes('list.find((c) => c.id === selectId)'),
    'and validate it, so a stale link falls back instead of showing an empty dashboard',
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
