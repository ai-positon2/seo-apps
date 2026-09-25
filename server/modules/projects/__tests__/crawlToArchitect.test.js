// ── A crawl, as Content Architect input — informational pages only ───────────
//
// crawlToArchitect clusters only the crawl's informational pages, but some facts
// are about the whole site and must still come from every crawled page: inbound
// links (an article linked only from a service page is not an orphan), whether a
// link graph exists at all, and whether the crawl was complete. assembleInput is
// pure, so those rules are tested directly; buildFromCrawl is then driven through
// a stub database to check the order it does things in.
//
// Run: node modules/projects/__tests__/crawlToArchitect.test.js

const assert = require('node:assert/strict');
const { test } = require('node:test');

// A database stub that answers the two paged reads buildFromCrawl makes, and
// records whether the link graph was read at all.
const stubDb = {
  configured: true,
  results: [],
  links: [],
  linksRead: false,
  isDatabaseConfigured() { return this.configured; },
  async rows(sql, params) {
    // fetchAll appends "and id > $n order by id asc limit $m".
    const lastId = params[params.length - 2];
    const limit = params[params.length - 1];
    const source = /crawl_run_links/.test(sql) ? this.links : this.results;
    if (source === this.links) this.linksRead = true;
    return source.filter((r) => r.id > lastId).slice(0, limit);
  },
};
const dbPath = require.resolve('../../../services/db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: stubDb };

const c2a = require('../crawlToArchitect');

const ORIGIN = 'https://www.example-dental.com';
let nextId = 1;
const row = (path, data = {}) => {
  const url = `${ORIGIN}${path}`;
  return {
    id: nextId++,
    url,
    status: 200,
    data: {
      url, scope: 'Internal', status: 200, depth: 1, title: path, h1: path,
      indexability: 'Indexable', words: 800, ...data,
    },
  };
};
const edge = (from, to) => ({ id: nextId++, from_url: `${ORIGIN}${from}`, to_url: `${ORIGIN}${to}` });

// A selection result as informationalSelection returns one.
const selectionOf = (includedIdx, { aliasOf = new Map(), limitations = [] } = {}) => ({
  version: 1,
  method: 'rules',
  model: null,
  includedIdx,
  aliasOf,
  excluded: [],
  summary: { scope: 'informational', crawledPageCount: 0, analysedPageCount: includedIdx.length, excludedByReason: [], templates: [], limitations },
  verdicts: { version: 1, templates: {}, urls: {} },
});

test('every positional array lines up with the selected rows', () => {
  const rows = [row('/services/implants'), row('/blog/a'), row('/locations/x'), row('/blog/b'), row('/blog/c')];
  const selection = selectionOf([1, 3, 4]);
  const input = c2a.assembleInput({ runId: 'r1', rows, edges: [], selection });
  const { pages } = input.crawlResult;
  assert.equal(pages.length, 3);
  selection.includedIdx.forEach((rowIdx, k) => assert.equal(pages[k].url, rows[rowIdx].url));
  for (const arr of [input.linkGraph.graph, input.linkGraph.inboundCounts, input.linkGraph.depths]) {
    assert.equal(arr.length, pages.length);
  }
  assert.equal(input.meta.pageCount, 3);
  assert.equal(input.meta.crawledPageCount, 5);
});

test('an article linked only from a page that is not clustered still has an inbound link', () => {
  const rows = [row('/services/implants'), row('/blog/linked'), row('/blog/unlinked')];
  const edges = [edge('/services/implants', '/blog/linked')];
  const input = c2a.assembleInput({ runId: 'r1', rows, edges, selection: selectionOf([1, 2]) });
  assert.deepEqual(input.linkGraph.inboundCounts, [1, 0]);
});

test('a link to a duplicate spelling is credited to the page that was kept', () => {
  const rows = [row('/guide/kept'), row('/guide/kept/'), row('/guide/other')];
  // Row 1 is the trailing-slash duplicate of row 0.
  const selection = selectionOf([0, 2], { aliasOf: new Map([[1, 0]]) });
  const input = c2a.assembleInput({ runId: 'r1', rows, edges: [edge('/guide/other', '/guide/kept/')], selection });
  assert.deepEqual(input.linkGraph.inboundCounts, [1, 0]);
  assert.ok(input.linkGraph.graph[1].has(0), 'and the clustered graph has the link');
  assert.equal(input.crawlResult.pages[1].outboundLinks[0].href, `${ORIGIN}/guide/kept`);
});

test('a link through a redirect or another spelling reaches the page it lands on', () => {
  // Measured on a real site: pages linked to /resources/x/, which 301s to
  // http://…/user-resources/x/, and the page was reported as an orphan.
  const rows = [row('/blog/source-a'), row('/blog/source-b'), row('/user-resources/guide/')];
  const edges = [
    edge('/blog/source-a', '/resources/guide/'),                  // old path, redirects
    { id: nextId++, from_url: `${ORIGIN}/blog/source-b`, to_url: 'http://example-dental.com/user-resources/guide' }, // other spelling
  ];
  const redirects = new Map([[`${ORIGIN}/resources/guide/`, 'http://www.example-dental.com/user-resources/guide/']]);
  const input = c2a.assembleInput({ runId: 'r', rows, edges, selection: selectionOf([0, 1, 2]), redirects });
  assert.deepEqual(input.linkGraph.inboundCounts, [0, 0, 2]);
});

test('the redirect map is built from the 3xx rows the page filter drops', () => {
  const map = c2a.redirectMap([
    row('/old-path/', { status: 301, redirectUrl: `${ORIGIN}/new-path/` }),
    row('/fine'),
  ]);
  assert.equal(map.get(`${ORIGIN}/old-path/`), `${ORIGIN}/new-path/`);
  assert.equal(map.has(`${ORIGIN}/fine`), false);
});

test('a leftover layer of HTML entities is decoded, not clustered on', () => {
  const page = c2a.pageFromResult(row('/blog/x', {
    title: 'Gum Disease &amp; Alzheimer&#x27;s&nbsp;| Clinic', h2: 'Signs &amp; Symptoms | Care', metaDescription: '&quot;Quoted&quot;',
  }));
  assert.equal(page.title, "Gum Disease & Alzheimer's | Clinic");
  assert.deepEqual(page.h2s, ['Signs & Symptoms', 'Care']);
  assert.equal(page.metaDescription, '"Quoted"');
  assert.equal(c2a.decodeLeftoverEntities('R&D &unknown; ok'), 'R&D &unknown; ok');
});

test('a page the crawl gave no depth gets its shortest link path from the homepage', () => {
  const home = row('/', { depth: 0 });
  const listing = row('/blog', { depth: 1 });
  const post = row('/post-found-by-listing', { depth: undefined });
  const island = row('/unlinked-post', { depth: undefined });
  const rows = [post, island, home, listing];
  const edges = [edge('/', '/blog'), edge('/blog', '/post-found-by-listing')];
  const input = c2a.assembleInput({ runId: 'r', rows, edges, selection: selectionOf([0, 1]) });
  assert.equal(input.linkGraph.depths[0], 3, 'homepage 1, listing 2, post 3 — the crawl\'s own convention');
  assert.equal(input.linkGraph.depths[1], Infinity, 'unreachable stays unknown');
});

test('links only between unclustered pages still mean the crawl has a link graph', () => {
  const rows = [row('/locations/a'), row('/locations/b'), row('/blog/x'), row('/blog/y')];
  const edges = [edge('/locations/a', '/locations/b')];
  const input = c2a.assembleInput({ runId: 'r1', rows, edges, selection: selectionOf([2, 3]) });
  assert.equal(input.meta.hasLinkGraph, true);
  assert.equal(input.meta.edgeCount, 0, 'no link between the clustered pages');
  assert.equal(input.meta.fullEdgeCount, 1);
  assert.ok(!input.limitations.some((l) => /stored no internal link graph/.test(l)));
});

test('completeness is judged on the whole crawl, and each reason says why', () => {
  const rows = Array.from({ length: 10 }, (_, i) => row(`/p/${i}`));
  const onlyTwo = selectionOf([0, 1]);

  // Ten pages crawled against a ten-URL cap — even though only two are clustered.
  const capped = c2a.assembleInput({ runId: 'r', rows, edges: [], selection: onlyTwo, maxUrls: 10 });
  assert.equal(capped.meta.capped, true);
  assert.equal(capped.meta.incompleteReason, 'url_cap');
  assert.ok(capped.limitations.some((l) => /10-URL cap/.test(l) && /Orphan detection is withheld/.test(l)));

  const complete = c2a.assembleInput({ runId: 'r', rows, edges: [], selection: onlyTwo, maxUrls: 500 });
  assert.equal(complete.meta.capped, false);
  assert.equal(complete.meta.complete, true);

  const cases = [
    [{ crawlSummary: { budgetReached: true } }, 'url_cap'],
    [{ crawlStatus: 'stopped' }, 'stopped'],
    [{ crawlSummary: { depthLimited: true } }, 'depth_limit'],
    [{ crawlSummary: { edgesTruncated: true } }, 'links_truncated'],
  ];
  for (const [extra, reason] of cases) {
    const input = c2a.assembleInput({ runId: 'r', rows, edges: [], selection: onlyTwo, maxUrls: 500, ...extra });
    assert.equal(input.meta.capped, true, reason);
    assert.equal(input.meta.incompleteReason, reason);
    assert.ok(input.limitations.some((l) => /Orphan detection is withheld/.test(l)));
  }
});

test('the analysis says it covers informational pages, and carries the selection', () => {
  const rows = [row('/services/a'), row('/blog/x'), row('/blog/y')];
  const selection = selectionOf([1, 2], { limitations: ['The AI check was unavailable (no API key is configured)…'] });
  selection.excluded = [{ url: `${ORIGIN}/services/a`, code: 'service', reason: 'Service page', detail: null, source: 'rules' }];
  const input = c2a.assembleInput({ runId: 'r', rows, edges: [], selection });
  assert.ok(input.limitations[0].startsWith('Only informational pages'));
  assert.ok(input.limitations.some((l) => /AI check was unavailable/.test(l)));
  assert.deepEqual(input.crawlResult.excluded, selection.excluded);
  assert.equal(input.crawlResult.selection.summary.scope, 'informational');
  assert.ok(input.crawlResult.selection.verdicts, 'the verdict cache is stored for the next run');
  assert.equal(input.crawlResult.selection.aliasOf, undefined, 'internal index maps are not stored');
});

test('buildFromCrawl stops before reading the link graph when there is too little to cluster', async () => {
  stubDb.results = [
    row('/'),
    ...Array.from({ length: 10 }, (_, i) => row(`/locations/city-${i + 1}`)),
    row('/blog/one-post'),
  ];
  stubDb.links = [edge('/', '/blog/one-post')];
  stubDb.linksRead = false;
  const out = await c2a.buildFromCrawl('run-1', { classifier: null, maxUrls: 500 });
  assert.equal(out.tooFewInformational, true);
  assert.equal(out.pageCount, 1);
  assert.equal(out.crawledPageCount, 12);
  assert.equal(stubDb.linksRead, false);
  assert.ok(out.selection.summary.excludedByReason.length > 0);
});

test('buildFromCrawl reads the link graph and clusters only the informational pages', async () => {
  stubDb.results = [
    row('/'),
    ...Array.from({ length: 10 }, (_, i) => row(`/locations/city-${i + 1}`)),
    ...Array.from({ length: 10 }, (_, i) => row(`/blog/post-number-${i + 1}`)),
    row('/blog/broken', { status: 404 }),
    row('/logo.png', { isAsset: true }),
  ];
  stubDb.links = [edge('/locations/city-1', '/blog/post-number-1')];
  stubDb.linksRead = false;
  const out = await c2a.buildFromCrawl('run-2', { classifier: null, maxUrls: 500 });
  assert.equal(stubDb.linksRead, true);
  assert.equal(out.meta.pageCount, 10);
  assert.equal(out.meta.crawledPageCount, 21, 'the 404 and the asset were never candidates');
  assert.ok(out.crawlResult.pages.every((p) => p.url.includes('/blog/post-number-')));
  const first = out.crawlResult.pages.findIndex((p) => p.url.endsWith('/post-number-1'));
  assert.equal(out.linkGraph.inboundCounts[first], 1, 'linked from a location page, so not an orphan');
});

test('a crawl too small to consider is still reported as such, first', async () => {
  stubDb.results = [row('/'), row('/a')];
  stubDb.links = [];
  const out = await c2a.buildFromCrawl('run-3', { classifier: null });
  assert.equal(out.tooSmall, true);
});

test('on an incomplete crawl the analysis flags no orphans, and says it did not look', async () => {
  // The card withholds the orphan finding on a capped crawl; the analysis the
  // Content Architect screen and its export read must not then list orphans.
  const saved = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = ''; // mechanical naming, no network
  try {
    const { analyzeCrawledPages } = require('../../contentArchitect/fullAnalysis');
    const rows = Array.from({ length: 6 }, (_, i) => row(`/blog/whitening-guide-part-${i}`, {
      title: `Teeth whitening guide part ${i}`, h1: `Teeth whitening part ${i}`, h2: 'Whitening strips | Whitening cost',
    }));
    const input = c2a.assembleInput({ runId: 'r', rows, edges: [], selection: selectionOf([0, 1, 2, 3, 4, 5]) });
    const project = { domain: ORIGIN, vertical: null };
    const full = await analyzeCrawledPages(input.crawlResult, project, { linkGraph: input.linkGraph });
    assert.ok(full.pages.some((p) => p.flags.includes('orphan')), 'nothing links anywhere, so a complete crawl flags them');
    const withheld = await analyzeCrawledPages(input.crawlResult, project, { linkGraph: input.linkGraph, orphanDetection: false });
    assert.ok(withheld.pages.every((p) => !p.flags.includes('orphan')));
    assert.equal(withheld.orphanDetectionWithheld, true);
  } finally {
    process.env.ANTHROPIC_API_KEY = saved;
  }
});

test('the selection fields come from the stored row, not the pipeline page', () => {
  const candidate = c2a.candidateFromRow(row('/blog/x', {
    canonical: `${ORIGIN}/blog/y`, indexability: 'Non-indexable', indexabilityReason: 'Meta robots contains noindex', inlinks: 7,
  }));
  assert.deepEqual(candidate, {
    url: `${ORIGIN}/blog/x`,
    canonical: `${ORIGIN}/blog/y`,
    indexability: 'Non-indexable',
    indexabilityReason: 'Meta robots contains noindex',
    inlinks: 7,
  });
});
