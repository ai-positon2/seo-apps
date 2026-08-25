// ── Which pages get audited ─────────────────────────────────────────────────
//
// The default sample for SEO & GEO, On-Page and Agent Readiness. The model half
// is not exercised here (it needs an API key and it is allowed to be
// unavailable); what is tested is everything that has to hold whether or not the
// model answers: the homepage is found, the fallback spreads across the site,
// and a URL that was not in the crawl can never be returned.
//
// Run: node modules/projects/__tests__/pageSelection.test.js

const assert = require('assert');
const sel = require('../pageSelection');

// Queued rather than run inline: two of these are async, and a synchronous
// runner would count a rejected promise as a pass.
let passed = 0, failed = 0;
const queue = [];
const test = (name, fn) => queue.push({ name, fn });
const section = (name) => queue.push({ section: name });

async function run() {
  for (const item of queue) {
    if (item.section) { console.log(`
${item.section}`); continue; }
    try {
      await item.fn();
      passed++;
      console.log(`  ✓ ${item.name}`);
    } catch (e) {
      failed++;
      console.error(`  ✗ ${item.name}
    ${e.message}`);
    }
  }
  console.log(`
${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

const page = (url, title = '') => ({ url, title });

const SITE = [
  page('https://x.test/', 'Home'),
  page('https://x.test/services/implants', 'Implants'),
  page('https://x.test/services/whitening', 'Whitening'),
  page('https://x.test/locations/boston', 'Boston'),
  page('https://x.test/locations/belmont', 'Belmont'),
  page('https://x.test/locations/quincy', 'Quincy'),
  page('https://x.test/resources/articles/abscess', 'Abscess'),
  page('https://x.test/about', 'About'),
];

// ── The homepage ────────────────────────────────────────────────────────────

section('finding the homepage');

test('an exact root wins', () => {
  assert.strictEqual(sel.pickHomepage(SITE, 'https://x.test').url, 'https://x.test/');
});

test('a root on another host is not this site\'s homepage', () => {
  const pages = [page('https://other.test/'), page('https://x.test/en/', 'EN')];
  assert.strictEqual(sel.pickHomepage(pages, 'https://x.test').url, 'https://x.test/en/');
});

test('with no root at all, the shallowest page stands in', () => {
  const pages = [
    page('https://x.test/a/b/c'),
    page('https://x.test/en/'),
    page('https://x.test/a/b'),
  ];
  assert.strictEqual(sel.pickHomepage(pages, null).url, 'https://x.test/en/');
});

test('the stand-in is deterministic, not first-seen', () => {
  const a = [page('https://x.test/zeta'), page('https://x.test/alpha')];
  const b = [page('https://x.test/alpha'), page('https://x.test/zeta')];
  assert.strictEqual(sel.pickHomepage(a, null).url, sel.pickHomepage(b, null).url);
});

test('nothing to choose from is null, not a throw', () => {
  assert.strictEqual(sel.pickHomepage([], 'https://x.test'), null);
  assert.strictEqual(sel.pickHomepage(null, null), null);
});

test('an unparseable url is not a candidate', () => {
  const pages = [page('not a url'), page('https://x.test/')];
  assert.strictEqual(sel.pickHomepage(pages, null).url, 'https://x.test/');
});

// ── The fallback ────────────────────────────────────────────────────────────

section('choosing without a model');

test('four pages come from four different sections', () => {
  const picks = sel.heuristicSelection(SITE, {
    exclude: new Set(['https://x.test/']),
    count: 4,
  });
  assert.strictEqual(picks.length, 4);
  const sections = new Set(picks.map((p) => sel.sectionOf(p.url)));
  assert.strictEqual(sections.size, 4, `expected 4 sections, got ${[...sections].join(', ')}`);
});

test('it never returns a page it was told to exclude', () => {
  const exclude = new Set(['https://x.test/', 'https://x.test/services/implants']);
  const picks = sel.heuristicSelection(SITE, { exclude, count: 8 });
  assert.ok(picks.every((p) => !exclude.has(p.url)));
});

test('a site with one section still yields pages rather than none', () => {
  const flat = [
    page('https://x.test/blog/a'), page('https://x.test/blog/b'),
    page('https://x.test/blog/c'), page('https://x.test/blog/d'),
  ];
  assert.strictEqual(sel.heuristicSelection(flat, { count: 4 }).length, 4);
});

test('asking for more than exists returns what exists', () => {
  const picks = sel.heuristicSelection([page('https://x.test/only')], { count: 4 });
  assert.strictEqual(picks.length, 1);
});

test('the biggest section is represented first', () => {
  // /locations has three pages to /services' two, so it leads.
  const picks = sel.heuristicSelection(SITE, {
    exclude: new Set(['https://x.test/']),
    count: 1,
  });
  assert.strictEqual(sel.sectionOf(picks[0].url), 'locations');
});

// ── Never invent a page ─────────────────────────────────────────────────────

section('a selection can only contain pages the crawl found');

test('selectKeyPages returns nothing when there is nothing to choose from', async () => {
  const out = await sel.selectKeyPages([], { exclude: new Set(), count: 4 });
  assert.deepStrictEqual(out.picks, []);
});

test('every returned url came from the candidate list', async () => {
  // With no API key configured the model call fails and the heuristic answers;
  // either way the invariant is the same one, which is why it is asserted here
  // rather than inside the model branch.
  const out = await sel.selectKeyPages(SITE, {
    exclude: new Set(['https://x.test/']),
    count: 4,
  });
  const allowed = new Set(SITE.map((p) => p.url));
  assert.ok(out.picks.every((p) => allowed.has(p.url)), 'no invented URLs');
  assert.ok(!out.picks.some((p) => p.url === 'https://x.test/'), 'excluded page stayed out');
});

test('the basis sentence says when the model did not choose', () => {
  const line = sel.selectionBasis({
    method: 'heuristic', model: null, error: 'no api key', count: 4,
  });
  assert.ok(/section coverage/.test(line));
  assert.ok(/unavailable/.test(line), 'and admits the model was not used');
});

test('the basis sentence names the model when it did', () => {
  const line = sel.selectionBasis({
    method: 'model', model: 'claude-sonnet-5', error: null, count: 4,
  });
  assert.ok(/claude-sonnet-5/.test(line));
  assert.ok(!/unavailable/.test(line));
});

// ── Section labelling ───────────────────────────────────────────────────────

section('page types are read off the path');

test('a top-level page is its own type, not the root', () => {
  assert.strictEqual(sel.sectionOf('https://x.test/'), '(root)');
  assert.notStrictEqual(sel.sectionOf('https://x.test/about'), '(root)');
});

test('depth counts path segments', () => {
  assert.strictEqual(sel.depthOf('https://x.test/'), 0);
  assert.strictEqual(sel.depthOf('https://x.test/a'), 1);
  assert.strictEqual(sel.depthOf('https://x.test/a/b/'), 2);
});

run();
