// Tests for the "Hub and Spoke" card and the unwired clustering module.
//
// Two things are covered here, and it is worth being explicit about which:
//
//   1. The card itself is served by the Content Architect module — the runner
//      READS contentArchitect's stored analysis rather than computing anything.
//      Those tests assert it never runs that workflow and never invents a score.
//
//   2. projects/hubSpoke.js is the structural clustering that used to serve the
//      card, computed from crawl_run_links. It is no longer wired in. Its tests
//      stay because they document the approach and it is still correct code;
//      they are NOT asserting live behaviour.

const assert = require('assert');
const hubSpoke = require('../hubSpoke');
const moduleRunners = require('../moduleRunners');
const moduleEvidence = require('../moduleEvidence');

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

const edge = (from, to, anchor = null) => ({
  from_url: `https://x.com${from}`, to_url: `https://x.com${to}`, anchor, nofollow: false,
});
const page = (path) => `https://x.com${path}`;

console.log('\nHub and spoke — URL keys');

test('a trailing slash is not a different page', () => {
  assert.strictEqual(hubSpoke.pathKey('https://x.com/a/'), hubSpoke.pathKey('https://x.com/a'));
});

test('the root path keeps an identity of its own', () => {
  assert.strictEqual(hubSpoke.pathKey('https://x.com/'), 'x.com/');
});

test('a query string does not fork a page', () => {
  assert.strictEqual(hubSpoke.pathKey('https://x.com/a?utm=1'), 'x.com/a');
});

console.log('\nHub and spoke — structure');

test('a page linking to enough others becomes a topic hub', () => {
  const spokes = ['/s1', '/s2', '/s3', '/s4', '/s5'];
  const pages = [page('/hub'), ...spokes.map(page), page('/other1'), page('/other2'), page('/other3')];
  const edges = [
    ...spokes.map((s) => edge('/hub', s)),
    edge('/other1', '/hub'),   // the hub is reachable
  ];

  const out = hubSpoke.analyze(edges, pages);
  assert.strictEqual(out.structure.hubCount, 1);
  assert.strictEqual(out.clusters.length, 1);
  assert.strictEqual(out.clusters[0].spokes.length, 5);
});

test('a page linking to almost everything is navigation, not a topic hub', () => {
  // The footer links to every page. Counting it as a topic hub would put the
  // whole site in one meaningless cluster.
  const pages = Array.from({ length: 10 }, (_, i) => page(`/p${i}`));
  const edges = pages.map((_, i) => edge('/footer', `/p${i}`));

  const out = hubSpoke.analyze(edges, [...pages, page('/footer')]);
  assert.strictEqual(out.structure.hubCount, 0, 'no topic hubs');
  assert.strictEqual(out.structure.navigationHubCount, 1);
  assert.ok(
    out.findings.some((f) => f.ruleId === 'hubspoke-no-topic-hubs'),
    'and it says the linking is navigation only',
  );
});

test('a spoke is claimed by the most specific hub that links to it', () => {
  // /services links widely; /services/implants links to a focused set. A page in
  // both belongs to the narrower one.
  const broad = ['/a', '/b', '/c', '/d', '/e', '/shared'];
  const narrow = ['/shared', '/n1', '/n2', '/n3', '/n4'];
  const pages = [...new Set([...broad, ...narrow, '/services', '/services/implants'])].map(page);
  const edges = [
    ...broad.map((s) => edge('/services', s)),
    ...narrow.map((s) => edge('/services/implants', s)),
    edge('/home', '/services'),
    edge('/home', '/services/implants'),
  ];

  const out = hubSpoke.analyze(edges, pages);
  const owner = out.clusters.find((c) => c.spokes.includes('x.com/shared'));
  assert.strictEqual(owner.hub, 'x.com/services/implants');
});

test('an orphan page is found even though it has no edges', () => {
  const pages = [page('/hub'), page('/s1'), page('/s2'), page('/s3'), page('/s4'), page('/s5'), page('/lonely')];
  const edges = ['/s1', '/s2', '/s3', '/s4', '/s5'].map((s) => edge('/hub', s));

  const out = hubSpoke.analyze(edges, pages);
  assert.ok(out.orphans.includes('x.com/lonely'));
  const finding = out.findings.find((f) => f.ruleId === 'hubspoke-orphan-pages');
  assert.ok(finding, 'orphans are an error-level finding');
  assert.strictEqual(finding.severity, 'error');
});

test('a link to a page the crawl never reached does not invent a node', () => {
  // maxUrls cuts a crawl short; edges pointing past the cut must not appear as
  // pages that exist.
  const pages = [page('/a'), page('/b')];
  const out = hubSpoke.analyze([edge('/a', '/b'), edge('/a', '/never-crawled')], pages);
  assert.strictEqual(out.structure.pagesAnalyzed, 2);
  assert.ok(!out.orphans.includes('x.com/never-crawled'));
});

test('a self-link is ignored rather than counted as structure', () => {
  const out = hubSpoke.analyze([edge('/a', '/a')], [page('/a')]);
  assert.strictEqual(out.structure.hubCount, 0);
});

test('a hub nothing links to is reported', () => {
  const spokes = ['/s1', '/s2', '/s3', '/s4', '/s5'];
  const out = hubSpoke.analyze(
    spokes.map((s) => edge('/hub', s)),
    [page('/hub'), ...spokes.map(page)],
  );
  assert.ok(out.findings.some((f) => f.ruleId === 'hubspoke-hub-not-linked'));
});

test('an empty graph yields no findings and no invented structure', () => {
  const out = hubSpoke.analyze([], []);
  assert.strictEqual(out.structure.hubCount, 0);
  assert.strictEqual(out.structure.pagesAnalyzed, 0);
  assert.deepStrictEqual(out.findings, []);
});

console.log('\nHub and spoke — the honesty rules');

test('the analysis never produces a score', () => {
  const spokes = ['/s1', '/s2', '/s3', '/s4', '/s5'];
  const out = hubSpoke.analyze(spokes.map((s) => edge('/hub', s)), [page('/hub'), ...spokes.map(page)]);
  assert.ok(!('score' in out), 'internal-linking quality has no rubric — §6.2');
});

test('every finding it produces survives evidence normalisation', () => {
  const spokes = ['/s1', '/s2', '/s3', '/s4', '/s5'];
  const out = hubSpoke.analyze(
    [...spokes.map((s) => edge('/hub', s))],
    [page('/hub'), ...spokes.map(page), page('/orphan')],
  );
  for (const f of out.findings) {
    const normalized = moduleEvidence.normalizeFinding(f, 0);
    assert.ok(normalized.ruleId, 'a finding keeps its rule id');
    assert.ok(
      moduleEvidence.SEVERITIES.includes(normalized.severity),
      `${f.severity} is not in the shared severity vocabulary`,
    );
    assert.ok(normalized.count >= 1);
  }
});

test('hub_spoke is runnable and storable', () => {
  assert.ok(moduleRunners.RUNNABLE.includes('hub_spoke'));
  assert.ok(moduleEvidence.MODULE_KEYS.includes('hub_spoke'));
});

console.log('\nCrawl -> Content Architect adapter');

test('a crawl result becomes a page in Content Architect field names', () => {
  const c2a = require('../crawlToArchitect');
  const page = c2a.pageFromResult({
    url: 'https://x.com/a',
    data: {
      url: 'https://x.com/a', status: 200, title: 'A Title', h1: 'An H1',
      h2: 'First | Second | Third', metaDescription: 'Desc', words: 900,
      contentSample: 'Opening copy…', canonical: 'https://x.com/a',
      indexability: 'Indexable', depth: 2,
    },
  });
  assert.strictEqual(page.title, 'A Title');
  assert.strictEqual(page.h1, 'An H1');
  // The crawler stores headings joined with ' | '; the pipeline wants an array,
  // and its h2h3 term weight (1.5) applies per heading.
  assert.deepStrictEqual(page.h2s, ['First', 'Second', 'Third']);
  assert.strictEqual(page.wordCount, 900);
  assert.strictEqual(page.noindex, false);
  assert.deepStrictEqual(page.outboundLinks, []);
});

test('a non-indexable page is marked noindex, not dropped', () => {
  const c2a = require('../crawlToArchitect');
  const page = c2a.pageFromResult({ data: { url: 'https://x.com/n', indexability: 'Non-indexable' } });
  assert.strictEqual(page.noindex, true);
});

test('missing headings yield an empty array, never a one-element blank', () => {
  const c2a = require('../crawlToArchitect');
  assert.deepStrictEqual(c2a.pageFromResult({ data: { url: 'https://x.com/x' } }).h2s, []);
  assert.deepStrictEqual(c2a.pageFromResult({ data: { url: 'https://x.com/x', h2: '' } }).h2s, []);
});

test('dates the crawler does not record are null, not guessed', () => {
  // A guessed date would make the stale diagnostic fire on invented evidence.
  const c2a = require('../crawlToArchitect');
  const page = c2a.pageFromResult({ data: { url: 'https://x.com/a', words: 10 } });
  assert.strictEqual(page.publishedAt, null);
  assert.strictEqual(page.modifiedAt, null);
  assert.strictEqual(page.schemaType, null);
});

test('bulk reads are paginated, not single-shot', () => {
  // A single-shot read of the link graph saw 4 usable edges where 316 existed:
  // PostgREST capped a response at 1,000 rows whatever .limit() said, so any
  // crawl over 1,000 URLs was clustered from a fraction of its pages.
  //
  // Talking to Postgres directly there is no transport cap, but these reads are
  // still paged — a 750,000-edge link graph should not arrive as one result set.
  // Paged by a keyset cursor (id > lastSeenId), not OFFSET: OFFSET's cost grows
  // with how deep into the table a page is, and a 272k-row crawl's link graph
  // started failing past the halfway point even paginated that way.
  const fs = require('fs');
  const path = require('path');
  const source = fs.readFileSync(path.join(__dirname, '../crawlToArchitect.js'), 'utf8');
  assert.match(source, /async function fetchAll/, 'a paging helper must exist');
  assert.match(source, /and id > \$\$\{cursorIdx\}/, 'and it must page with a keyset cursor (id > lastSeenId), not OFFSET');
  // Every bulk read goes through the helper rather than issuing its own
  // unbounded select.
  assert.ok(
    !/from crawl_run_links[\s\S]{0,120}?order by id asc`,\s*\[runId\],\s*\{ label/.test(source)
    || /fetchAll\(\s*`select id, from_url, to_url from crawl_run_links/.test(source),
    'the link-graph read must go through fetchAll',
  );
});

test('the pipeline is fed, not reimplemented', () => {
  const fs = require('fs');
  const path = require('path');
  const source = fs.readFileSync(path.join(__dirname, '../moduleRunners.js'), 'utf8');
  assert.match(
    source, /analyzeCrawledPages/,
    "the card runs Content Architect's own pipeline over the crawl's pages",
  );
  // Still forbidden: anything that would make it crawl again.
  for (const forbidden of ['runFullAnalysis', 'discoverUrls', 'crawlFallback', 'crawlSite']) {
    assert.ok(!source.includes(forbidden), `${forbidden} would re-crawl the site`);
  }
});

console.log('\nAnalysis LLM calls run on Claude Sonnet');

test('cluster naming and relevance both use claude-sonnet-5 via the shared factory', () => {
  const fs = require('fs');
  const path = require('path');
  for (const file of ['llmNaming.js', 'contentRelevance.js']) {
    const source = fs.readFileSync(
      path.join(__dirname, '../../contentArchitect/', file), 'utf8',
    );
    assert.match(source, /claude-sonnet-5/, `${file} should name the Sonnet model`);
    assert.match(source, /createLlmClient/, `${file} should use the shared provider factory`);
    assert.ok(!/gpt-4o-mini/.test(source), `${file} still pins the old model`);
  }
});

test('claude-sonnet-5 is a model the factory knows', () => {
  const { MODEL_OPTIONS, providerForModel } = require('../../../services/llmProviders');
  assert.ok(MODEL_OPTIONS.some((m) => m.id === 'claude-sonnet-5'));
  assert.strictEqual(providerForModel('claude-sonnet-5'), 'anthropic');
});

test('temperature is stripped for Anthropic but kept for Google', () => {
  // Anthropic's current models answer 400 "temperature is deprecated for this
  // model", which silently pushed cluster naming onto its mechanical fallback.
  const fs = require('fs');
  const path = require('path');
  const source = fs.readFileSync(
    path.join(__dirname, '../../../services/llmProviders.js'), 'utf8',
  );
  assert.match(source, /provider === 'anthropic' \? \{\} : \{ temperature \}/);
});

console.log('\nA capped crawl cannot claim a page is an orphan');

test('the adapter records whether the crawl saw the whole site', () => {
  const fs = require('fs');
  const path = require('path');
  const source = fs.readFileSync(path.join(__dirname, '../crawlToArchitect.js'), 'utf8');
  assert.match(source, /capped/, 'completeness must be recorded');
  assert.match(source, /orphan detection is withheld/i, 'and its consequence stated');
});

test('the orphan finding is gated on a complete crawl', () => {
  const fs = require('fs');
  const path = require('path');
  const source = fs.readFileSync(path.join(__dirname, '../moduleRunners.js'), 'utf8');
  assert.match(
    source, /orphans\.length && !input\.meta\.capped/,
    'measured: 40 of 50 pages had no in-set inbound link and none was an orphan',
  );
  assert.match(
    source, /input\.meta\.capped \? null : orphans\.length/,
    'orphanCount must be null, not 0, when it could not be determined',
  );
});

console.log('\nThe card is served by Content Architect, not by this file');

test('the runner reads the Content Architect module, not the crawl link graph', () => {
  const fs = require('fs');
  const path = require('path');
  const source = fs.readFileSync(
    path.join(__dirname, '../moduleRunners.js'), 'utf8',
  );
  assert.match(source, /contentArchitect\/store/, 'it reads that module\'s store');
  assert.ok(
    !/require\('\.\/hubSpoke'\)/.test(source),
    'the unwired clustering module must not creep back in as a second implementation',
  );
});

test('the runner never triggers the Content Architect workflow', () => {
  // That workflow needs a person to confirm the URL pattern table, and it crawls
  // the site itself — which §32 forbids inside an audit module. Reading its
  // stored result is the whole contract.
  const fs = require('fs');
  const path = require('path');
  const source = fs.readFileSync(
    path.join(__dirname, '../moduleRunners.js'), 'utf8',
  );
  for (const forbidden of ['runFullAnalysis', 'discoverUrls', 'crawlFallback', 'buildDraftClusters']) {
    assert.ok(
      !source.includes(forbidden),
      `${forbidden} would run Content Architect's workflow instead of reading it`,
    );
  }
});

test('the score is the module\'s own mean cluster health, and its weights sum to 100', () => {
  // The card reports contentArchitect's number unrescaled. If those weights ever
  // stop summing to 100, a score out of 100 would be wrong and the DB's
  // score <= score_max check would start rejecting rows.
  const { CLUSTER_HEALTH_WEIGHTS } = require('../../contentArchitect/config');
  const total = Object.values(CLUSTER_HEALTH_WEIGHTS).reduce((a, b) => a + b, 0);
  assert.strictEqual(total, 100, `cluster health weights sum to ${total}, not 100`);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
