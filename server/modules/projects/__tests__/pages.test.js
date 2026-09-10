// Tests for the page inventory.
//
// Before project_pages, a URL lived only inside a crawl run. This table makes a
// page the product's central noun, and two of its rules are the kind that look
// harmless and destroy data:
//
//   1. **Absence is only evidence when the crawl was not capped.** A capped crawl
//      stopped before it ran out of pages, so a page missing from it may simply
//      never have been reached. Retiring on that basis marks most of a site gone
//      the first time somebody lowers the crawl limit.
//   2. **first_seen_at is written once.** An upsert that carries it would
//      overwrite the original date with today's on every crawl, quietly
//      destroying the one fact the table exists to remember.
//
// Plus the exclusion accounting: honouring "stop auditing this page" silently
// would make the backlog shrink for no visible reason.

const assert = require('assert');

const pages = require('../pages');
const backlog = require('../insights/backlog');
const crawledPages = require('../crawledPages');
const auditEvents = require('../../../services/auditEvents');

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

async function testAsync(name, fn) {
  try {
    await fn();
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

// ── Identity ────────────────────────────────────────────────────────────────

section('pages — one row per page, not per spelling');

test('the identity is the canonical key, shared with the link graph', () => {
  // If these two ever disagree, the inventory and the link graph stop joining and
  // every page looks unlinked.
  const a = crawledPages.canonicalKey('https://x.test/services/');
  const b = crawledPages.canonicalKey('https://x.test/services');
  const c = crawledPages.canonicalKey('https://X.TEST/services#top');
  assert.strictEqual(a, b);
  assert.strictEqual(b, c);
});

test('a scheme change is not a new page', () => {
  // A site moving to https must not orphan its own history.
  assert.strictEqual(
    crawledPages.canonicalKey('http://x.test/a'),
    crawledPages.canonicalKey('https://x.test/a'),
  );
});

test('www and non-www are different pages', () => {
  // Usually a real redirect bug, so it must stay visible rather than being
  // normalised away.
  assert.notStrictEqual(
    crawledPages.canonicalKey('https://x.test/a'),
    crawledPages.canonicalKey('https://www.x.test/a'),
  );
});

section('pages — the view never turns an absence into a value');

test('unobserved crawl facts stay null', () => {
  const v = pages.view({
    id: 'p1', project_id: 'proj', canonical_key: 'x.test/a', url: 'https://x.test/a',
  });
  assert.strictEqual(v.depth, null);
  assert.strictEqual(v.inboundLinks, null);
  assert.strictEqual(v.statusCode, null);
  assert.strictEqual(v.isIndexable, null, 'unknown indexability is not "not indexable"');
});

test('a genuine zero survives', () => {
  const v = pages.view({
    id: 'p1', project_id: 'p', canonical_key: 'k', url: 'u',
    depth: 0, inbound_links: 0, is_indexable: false,
  });
  assert.strictEqual(v.depth, 0, 'the homepage is at depth 0');
  assert.strictEqual(v.inboundLinks, 0, 'an orphan has 0 inbound links, which is a measurement');
  assert.strictEqual(v.isIndexable, false);
});

test('excluded and retired are booleans derived from their timestamps', () => {
  const plain = pages.view({ id: 'p', project_id: 'p', canonical_key: 'k', url: 'u' });
  assert.strictEqual(plain.excluded, false);
  assert.strictEqual(plain.retired, false);

  const marked = pages.view({
    id: 'p', project_id: 'p', canonical_key: 'k', url: 'u',
    excluded_at: '2026-08-01T00:00:00Z', excluded_reason: 'Legal page',
    retired_at: '2026-08-02T00:00:00Z',
  });
  assert.strictEqual(marked.excluded, true);
  assert.strictEqual(marked.excludedReason, 'Legal page');
  assert.strictEqual(marked.retired, true);
});

section('pages — a missing table degrades, it does not explode');

test('the missing-table check is narrow', () => {
  // 42P01 undefined_table, 42703 undefined_column — what Postgres itself
  // raises. The old "Could not find the table 'public.project_pages'" spelling
  // came from PostgREST answering out of its own schema cache before the query
  // reached the database, and cannot occur over a direct connection.
  assert.strictEqual(pages.isMissingTable({ code: '42P01' }), true);
  assert.strictEqual(pages.isMissingTable({ code: '42703' }), true);
  assert.strictEqual(
    pages.isMissingTable({ message: 'relation "project_pages" does not exist' }),
    true,
  );
  // A unique-violation is a real error and must not be swallowed as "no table".
  assert.strictEqual(
    pages.isMissingTable({ code: '23505', message: 'duplicate key value' }),
    false,
  );
});

testAsync('excludedKeys returns an empty set rather than throwing', async () => {
  // Called on every insight build. If it threw before migration 0015, the whole
  // dashboard would break on a deploy that had not run migrations yet.
  const result = await pages.excludedKeys('no-such-project');
  assert.ok(result instanceof Set);
});

section('pages — a reason is required to stop auditing something');

testAsync('excluding without a reason is refused', async () => {
  await assert.rejects(
    () => pages.excludePage('proj', 'page', { reason: '   ' }),
    (e) => e.code === 'reason_required',
    'an exclusion nobody explained is indistinguishable from a mistake later',
  );
});

testAsync('an empty patch is refused rather than silently doing nothing', async () => {
  await assert.rejects(
    () => pages.updatePage('proj', 'page', {}),
    (e) => e.code === 'empty_patch',
  );
});

section('pages — the audit trail knows about page state');

test('the three page actions are in the vocabulary', () => {
  assert.strictEqual(auditEvents.ACTIONS.PAGES_SYNCED, 'project_pages.synced');
  assert.strictEqual(auditEvents.ACTIONS.PAGE_EXCLUDED, 'project_page.excluded');
  assert.strictEqual(auditEvents.ACTIONS.PAGE_INCLUDED, 'project_page.included');
});

// ── Exclusions changing the backlog ─────────────────────────────────────────

section('exclusions — subtracted from the backlog, and counted');

const item = (over = {}) => ({
  key: over.key || 'technical:r',
  moduleKey: 'technical',
  moduleLabel: 'Tech Audit',
  ruleId: 'r',
  title: 'A finding',
  severity: 'warning',
  priority: null,
  pages: [],
  pageCount: 0,
  instanceCount: 1,
  attribution: 'per-instance',
  pagesPartial: false,
  scope: 'page',
  ...over,
});

test('with nothing excluded the items are untouched', () => {
  const items = [item({ pages: ['https://x.test/a'], pageCount: 1 })];
  const r = backlog.applyExclusions(items, new Set(), 50);
  assert.strictEqual(r.items, items, 'the same array, not a copy');
  assert.strictEqual(r.droppedPages, 0);
});

test('an excluded page is removed from an item that has others', () => {
  const r = backlog.applyExclusions(
    [item({ pages: ['https://x.test/a', 'https://x.test/b'], pageCount: 2 })],
    new Set(['x.test/a']),
    50,
  );
  assert.strictEqual(r.items.length, 1);
  assert.deepStrictEqual(r.items[0].pages, ['https://x.test/b']);
  assert.strictEqual(r.items[0].pageCount, 1);
  assert.strictEqual(r.items[0].excludedPageCount, 1);
  assert.strictEqual(r.droppedItems, 0);
});

test('an item whose every page is excluded leaves the list', () => {
  const r = backlog.applyExclusions(
    [item({ pages: ['https://x.test/a'], pageCount: 1 })],
    new Set(['x.test/a']),
    50,
  );
  assert.strictEqual(r.items.length, 0);
  assert.strictEqual(r.droppedItems, 1);
});

test('exclusion matches on the canonical spelling', () => {
  // The finding stores a trailing slash, the exclusion does not. They are one page.
  const r = backlog.applyExclusions(
    [item({ pages: ['https://x.test/a/'], pageCount: 1 })],
    new Set([crawledPages.canonicalKey('https://x.test/a')]),
    50,
  );
  assert.strictEqual(r.droppedItems, 1);
});

test('excluding most of a site stops a defect being template-wide', () => {
  // 40 of 50 pages is a template problem. With 38 of them excluded it is not, and
  // carrying the old classification would put a two-page fix at the top of the
  // list claiming it covered the whole template.
  const affected = Array.from({ length: 40 }, (_, i) => `https://x.test/p${i}`);
  const excluded = new Set(affected.slice(0, 38).map((u) => crawledPages.canonicalKey(u)));
  const r = backlog.applyExclusions(
    [item({ pages: affected, pageCount: 40, scope: 'template' })],
    excluded,
    50,
  );
  assert.strictEqual(r.items[0].pageCount, 2);
  assert.strictEqual(r.items[0].scope, 'page', 'the classification is recomputed, not inherited');
});

test('an unattributed item is never touched by an exclusion', () => {
  // It names no pages, so no exclusion can apply to it. Dropping it would delete
  // a real finding on the strength of nothing.
  const r = backlog.applyExclusions(
    [item({ pages: [], pageCount: null, attribution: 'aggregate' })],
    new Set(['x.test/a']),
    50,
  );
  assert.strictEqual(r.items.length, 1);
});

test('the backlog states what an exclusion removed', () => {
  const built = backlog.buildBacklog(
    {
      items: [
        item({ key: 'a', ruleId: 'a', title: 'Survives', pages: ['https://x.test/keep'], pageCount: 1 }),
        item({ key: 'b', ruleId: 'b', title: 'Gone', pages: ['https://x.test/drop'], pageCount: 1 }),
      ],
      crawl: { internalPages: 50 },
    },
    { excludedKeys: new Set([crawledPages.canonicalKey('https://x.test/drop')]) },
  );
  assert.deepStrictEqual(built.actions.map((i) => i.title), ['Survives']);
  assert.strictEqual(built.totals.excludedPages, 1);
  assert.strictEqual(built.totals.itemsFullyExcluded, 1);
  assert.match(built.totals.exclusionNote, /1 page\(s\) are excluded/);
  assert.match(built.totals.exclusionNote, /removed 1 finding/);
});

test('no exclusions means no exclusion note to explain', () => {
  const built = backlog.buildBacklog({
    items: [item({ pages: ['https://x.test/a'], pageCount: 1 })],
    crawl: { internalPages: 50 },
  });
  assert.strictEqual(built.totals.excludedPages, 0);
  assert.strictEqual(built.totals.exclusionNote, null);
});

// ── When a missing page may be retired ────────────────────────────────────────

console.log('');
console.log('Retirement — absence is only evidence when the crawl looked everywhere');

test('a complete crawl lets a missing page retire', () => {
  assert.strictEqual(pages.retirementAllowed({ capped: false, crawlCapped: false }), true);
});

test('a crawl that stopped at its own URL ceiling does not', () => {
  // The bug this replaced: syncFromCrawl guarded on `capped`, which is budget
  // truncation, while asking for an unlimited budget — so the guard was false by
  // construction and retirement ran on every capped crawl. On the live project
  // that is a 50-URL cap against a site of unknown size.
  assert.strictEqual(pages.retirementAllowed({ capped: false, crawlCapped: true }), false);
});

test('"cannot tell" is not permission', () => {
  // A run with no usable options.maxUrls cannot answer the question. Treating
  // that as "not capped" is how the guard inverts.
  assert.strictEqual(pages.retirementAllowed({ capped: false, crawlCapped: null }), false);
});

test('budget truncation also blocks it', () => {
  assert.strictEqual(pages.retirementAllowed({ capped: true, crawlCapped: false }), false);
});

test('no crawl at all retires nothing', () => {
  assert.strictEqual(pages.retirementAllowed(null), false);
  assert.strictEqual(pages.retirementAllowed(undefined), false);
});

(async () => {
  // The async assertions above are queued; give them a tick to settle before the
  // tally is printed.
  await new Promise((r) => setTimeout(r, 50));
  
console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
