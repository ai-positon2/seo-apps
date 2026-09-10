// ── Tests for the run-tracking registry ─────────────────────────────────────
// Guards the one failure mode the middleware itself can't catch: a matcher in
// server/config/runTracking.js whose path doesn't correspond to any route the
// module actually declares. That matcher would never fire, and the module would
// silently record nothing — which looks exactly like "no runs yet".
//
// The route tables are read out of the route files by pattern, so adding or
// renaming a route surfaces here rather than in production silence.
// Run: node config/__tests__/registry.test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { RUN_TRACKING, TRACKED_TOOL_IDS } = require('../runTracking');
const { findMatcher } = require('../../middleware/runTracking');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}

// Which route file backs each mount in the registry.
const ROUTE_FILES = {
  'keyword-research': 'routes/keywordResearch.js',
  'article-recommendation': 'routes/articleRecommendation.js',
  'content-research': 'routes/analyze.js',
  'content-research-export': 'routes/export.js',
  'market-potential': 'modules/marketPotential/routes.js',
  'competitor-tracker': 'modules/competitorAnalysis/routes.js',
  'competitor-analysis-report': 'routes/competitorAnalysis.js',
  'article-enhancement': 'routes/articleEnhancement.js',
  'article-enhancement-lite': 'routes/articleEnhancementLite.js',
  'on-page-audit': 'modules/onPageAudit/routes.js',
  'seo-geo-audit': 'routes/seoGeoAudit.js',
  'agent-readiness-audit': 'routes/agentReadinessAudit.js',
  'image-alt-audit': 'routes/imageAltAudit.js',
  'content-enhancement': 'routes/contentEnhancement.js',
  'location-page-builder': 'routes/locationPageBuilder.js',
  'content-architect': 'modules/contentArchitect/routes.js',
  'crawl-scope': 'modules/crawlScope/api/routes.js',
  'knowledge-base': 'routes/kb.js',
  'robots-monitor': 'modules/robotsMonitor/routes.js',
};

const SERVER_DIR = path.join(__dirname, '../..');

// Every `router.<method>('<path>')` declared in a route file, with :params
// filled in so the declarations can be matched as concrete request paths.
function declaredRoutes(file, prefix = '') {
  const source = fs.readFileSync(path.join(SERVER_DIR, file), 'utf8');
  const routes = [];
  const join = p => `${prefix}${p}`.replace(/\/{2,}/g, '/');
  // Both quote styles: this app writes route paths in single quotes, but the
  // ported CrawlScope module keeps its original double-quoted style. A
  // single-quote-only pattern found none of its routes, which failed loudly
  // (every matcher looked orphaned) rather than silently — but it failed for
  // the wrong reason.
  const re = /router\.(get|post|put|patch|delete)\(\s*['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    const declared = join(m[2]);
    routes.push({
      method: m[1].toUpperCase(),
      declared,
      concrete: declared.replace(/:[A-Za-z0-9_]+/g, 'sample-value'),
    });
  }

  // Follow sub-routers: `router.use('/ls', require('./lsPages'))`. A module
  // large enough to split its routes across files was invisible to this scan,
  // so its matchers all looked orphaned — and, worse, the reverse case (a
  // sub-router route that nothing tracks) went unguarded entirely. The prefix
  // is carried down so the paths compare as the request paths they really are.
  const mountRe = /router\.use\(\s*['"]([^'"]+)['"]\s*,\s*require\(\s*['"](\.[^'"]+)['"]\s*\)/g;
  while ((m = mountRe.exec(source)) !== null) {
    const target = path.join(path.dirname(file), m[2]).replace(/\\/g, '/');
    const resolved = target.endsWith('.js') ? target : `${target}.js`;
    if (!fs.existsSync(path.join(SERVER_DIR, resolved))) continue;
    routes.push(...declaredRoutes(resolved, join(m[1])));
  }

  return routes;
}

console.log('Run-tracking registry');

test('every mount in the registry has a known route file', () => {
  const missing = Object.keys(RUN_TRACKING).filter(k => !ROUTE_FILES[k]);
  assert.deepStrictEqual(missing, [], `mounts with no route file mapped: ${missing.join(', ')}`);
});

test('every matcher matches a route its module actually declares', () => {
  const orphans = [];
  for (const [mount, config] of Object.entries(RUN_TRACKING)) {
    const routes = declaredRoutes(ROUTE_FILES[mount]);
    for (const matcher of config.matchers) {
      const hit = routes.some(r =>
        r.method === matcher.method &&
        findMatcher([matcher], r.method, r.concrete) !== null);
      if (!hit) orphans.push(`${mount}: ${matcher.method} ${matcher.path} (action ${matcher.action})`);
    }
  }
  assert.deepStrictEqual(orphans, [], `matchers that match no real route:\n    ${orphans.join('\n    ')}`);
});

test('every /init matcher has a /stream matcher to hand its input to', () => {
  for (const [mount, config] of Object.entries(RUN_TRACKING)) {
    const inits = config.matchers.filter(m => m.bridge === 'init');
    const streams = config.matchers.filter(m => m.bridge === 'stream');
    if (inits.length) {
      assert.ok(streams.length, `${mount} has ${inits.length} init matcher(s) but no stream matcher`);
    }
    if (streams.length) {
      assert.ok(inits.length, `${mount} has a stream matcher but nothing stashes its input`);
    }
  }
});

test('the modules whose work outlives the response are marked deferred', () => {
  // These endpoints answer before the work finishes; without `deferred` the run
  // would be recorded as completed the instant the job id was handed back.
  const expected = [
    ['on-page-audit', 'POST', '/run'],
    ['robots-monitor', 'POST', '/run'],
    ['competitor-analysis-report', 'POST', '/run'],
    ['competitor-analysis-report', 'POST', '/run-manual'],
    ['competitor-tracker', 'POST', '/clients/c1/run'],
    ['competitor-tracker', 'POST', '/clients/c1/run-pagespeed'],
    ['competitor-tracker', 'POST', '/clients/c1/content-analysis/run'],
  ];
  for (const [mount, method, reqPath] of expected) {
    const found = findMatcher(RUN_TRACKING[mount].matchers, method, reqPath);
    assert.ok(found, `${mount} ${method} ${reqPath} matches no matcher`);
    assert.strictEqual(found.matcher.deferred, true, `${mount} ${method} ${reqPath} should be deferred`);
  }
});

test('the deferred modules actually close their own runs', () => {
  // A deferred matcher with no req.run.finish()/fail() in the module would
  // leave every run at 'running' until the sweeper gave up on it.
  const closers = [
    'modules/onPageAudit/routes.js',
    'modules/robotsMonitor/routes.js',
    'modules/competitorAnalysis/routes.js',
    'services/jobStore.js', // closes the competitor report pipeline's runs
  ];
  for (const file of closers) {
    const source = fs.readFileSync(path.join(SERVER_DIR, file), 'utf8');
    assert.ok(/run\??\.finish\(/.test(source), `${file} never calls run.finish()`);
    assert.ok(/run\??\.fail\(/.test(source), `${file} never calls run.fail()`);
  }
});

test('reads and settings are not tracked as runs', () => {
  // Status polls and result fetches fire constantly; recording them would bury
  // the real runs. Spot-check the ones the UI polls hardest.
  const notRuns = [
    ['on-page-audit', 'GET', '/status/job1'],
    ['on-page-audit', 'GET', '/list'],
    ['competitor-tracker', 'GET', '/clients/c1/run/status'],
    ['competitor-tracker', 'GET', '/clients/c1/dashboard'],
    ['robots-monitor', 'GET', '/run/status'],
    ['robots-monitor', 'GET', '/history'],
    ['knowledge-base', 'GET', '/some-kb'],
    ['market-potential', 'GET', '/usage'],
    ['seo-geo-audit', 'GET', '/run'],
  ];
  for (const [mount, method, reqPath] of notRuns) {
    const found = findMatcher(RUN_TRACKING[mount].matchers, method, reqPath);
    assert.strictEqual(found, null, `${mount} ${method} ${reqPath} should not be tracked`);
  }
});

test('every tracked tool id is unique per tool, not per endpoint', () => {
  assert.ok(TRACKED_TOOL_IDS.length >= 15, `expected the full tool set, got ${TRACKED_TOOL_IDS.length}`);
  assert.strictEqual(new Set(TRACKED_TOOL_IDS).size, TRACKED_TOOL_IDS.length, 'tool ids must be unique');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
