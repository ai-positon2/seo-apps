// ── The page chooser ──────────────────────────────────────────────────────
//
// Run: node modules/aiVisibility/__tests__/promptTopics.test.js
//
// deriveTopics and its topic×intent axis were removed along with the slot
// generator. What is pinned here is the half a person actually uses: turning
// a crawl into a list of choosable rows, each labelled with what the page is
// about rather than its raw title.

const assert = require('assert');
const {
  topicPerUrl, labelFromTitle, normaliseUrl, groupFor,
} = require('../promptTopics');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (e) { failed += 1; console.error(`  ✗ ${name}\n    ${e.message}`); }
}
const section = (name) => console.log(`\n${name}`);

const BRAND = 'Gentle Dental';

section('labelFromTitle');

test('strips the brand and boilerplate off a page title', () => {
  assert.strictEqual(
    labelFromTitle('Dental Implants | Gentle Dental — Boston, MA', BRAND),
    'Dental Implants',
  );
});

test('a title with no brand still trims separators', () => {
  assert.strictEqual(labelFromTitle('Invisalign: Clear Aligners', null), 'Invisalign');
});

test('an UNSPACED hyphen is part of the word, not a separator', () => {
  // "What is Pain-Free Dentistry" must not become "What is Pain".
  assert.strictEqual(
    labelFromTitle('What is Pain-Free Dentistry', null),
    'What is Pain-Free Dentistry',
  );
});

section('topicPerUrl');

const PAGES = [
  { url: 'https://x.com/', title: 'Gentle Dental — Boston', inlinks: 40, depth: 0 },
  { url: 'https://x.com/articles/dental-implants', title: 'Dental Implants Cost | Gentle Dental', inlinks: 9, depth: 2 },
  { url: 'https://x.com/about-us', title: 'About Us | Gentle Dental', inlinks: 3, depth: 1 },
];

test('one row per URL, and every row is choosable', () => {
  const rows = topicPerUrl({ pages: PAGES }, { brandName: BRAND });
  assert.strictEqual(rows.length, 3);
  assert.strictEqual(new Set(rows.map((r) => r.targetUrl)).size, 3);
  for (const r of rows) {
    assert.ok(r.label && r.label.trim(), `every row needs a name, got ${JSON.stringify(r.label)}`);
    assert.ok(r.targetUrl, 'every row needs a URL');
  }
});

test('a page whose title is ONLY the brand still gets a name', () => {
  // Stripping the brand off "Gentle Dental — Boston" leaves nothing. That page
  // is almost always the homepage, and dropping it silently made the chooser
  // look like it had missed a page.
  const rows = topicPerUrl({ pages: PAGES }, { brandName: BRAND });
  const home = rows.find((r) => r.targetUrl === 'https://x.com/');
  assert.ok(home, 'the homepage must appear in the chooser');
  assert.strictEqual(home.label, 'Homepage');
});

test('a title-less page falls back to a readable path', () => {
  const rows = topicPerUrl(
    { pages: [{ url: 'https://x.com/services/root-canal-therapy', title: 'Gentle Dental' }] },
    { brandName: BRAND },
  );
  assert.strictEqual(rows[0].label, 'Root Canal Therapy');
});

test('service pages rank above the rest', () => {
  // Ranking is what makes a 50-row chooser usable: the pages that can win a
  // buyer question come first, not whatever the crawler happened to emit.
  const rows = topicPerUrl({ pages: PAGES }, { brandName: BRAND });
  assert.strictEqual(rows[0].label, 'Dental Implants Cost');
});

test('duplicate URLs collapse to one row', () => {
  const rows = topicPerUrl({ pages: [PAGES[1], { ...PAGES[1], url: 'https://x.com/articles/dental-implants/' }] });
  assert.strictEqual(rows.length, 1, 'a trailing slash is the same page');
});

test('no pages is an empty list, not a throw', () => {
  assert.deepStrictEqual(topicPerUrl({}), []);
  assert.deepStrictEqual(topicPerUrl({ pages: [] }), []);
});

test('ordering is deterministic', () => {
  const a = topicPerUrl({ pages: PAGES }, { brandName: BRAND }).map((r) => r.label);
  const b = topicPerUrl({ pages: PAGES }, { brandName: BRAND }).map((r) => r.label);
  assert.deepStrictEqual(a, b);
});

section('normaliseUrl');

test('host case, trailing slash and hash all collapse', () => {
  assert.strictEqual(normaliseUrl('https://X.com/a/'), normaliseUrl('https://x.com/a'));
  assert.strictEqual(normaliseUrl('https://x.com/a#top'), 'x.com/a');
});

test('the root path survives as /', () => {
  assert.strictEqual(normaliseUrl('https://x.com/'), 'x.com/');
});

test('a string that is not a URL does not throw', () => {
  assert.strictEqual(normaliseUrl('not a url'), 'not a url');
  assert.strictEqual(normaliseUrl(null), null);
});

section('groupFor — presentation only, never a metric');

test('buckets by path before title', () => {
  assert.strictEqual(groupFor({ url: 'https://x.com/', title: 'anything' }), 'Homepage');
  assert.strictEqual(groupFor({ url: 'https://x.com/about-us', title: '' }), 'About & press');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
