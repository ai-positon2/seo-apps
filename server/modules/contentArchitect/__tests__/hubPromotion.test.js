// ── An existing page before a new one ───────────────────────────────────────
//
// A cluster whose broad page already exists must not be reported as needing a
// new hub. The fixture is the Gentle Dental whitening cluster that prompted
// this: "Teeth Whitening: What You Need to Know" was surrounded by seven
// narrower whitening articles and the cluster was still called a gap.
//
// Run: node --test modules/contentArchitect/__tests__/hubPromotion.test.js

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { selectHub, promotableHub, slugWords } = require('../hubSelection');

const page = (slug, title, wordCount = 2000) => ({
  url: `https://www.example.com/resources/articles/${slug}`,
  title,
  wordCount,
  h2s: [],
});

const WHITENING = [
  page('best-teeth-whitening-products', 'Best Teeth Whitening Products 2026: A Guide', 4694),
  page('teeth-whitening-products', 'Teeth Whitening Products: How to Choose the Right Option', 6030),
  page('teeth-whitening-cost', 'Teeth Whitening Cost: Professional vs. At-Home Options', 4312),
  page('teeth-whitening', 'Teeth Whitening: What You Need to Know', 4521),
  page('does-insurance-cover-teeth-whitening', 'Does Insurance Cover Teeth Whitening?', 1871),
  page('how-long-professional-teeth-whitening-last', 'How Long Will Teeth Whitening Last?', 1432),
  page('is-teeth-whitening-safe-and-how-does-it-impact-your-teeth', 'Is Teeth Whitening Safe?', 1709),
  page('hydrogen-peroxide-teeth-whitening', 'Is Hydrogen Peroxide Safe for Teeth Whitening?', 4567),
];

/** Scores as selectHub builds them, with every page under the threshold. */
function lowScores(pages) {
  return new Map(pages.map((p, i) => [i, {
    score: 0.4,
    breakdown: { titlePenalty: /\?|\bvs\.?\b|^how to\b|\b(19|20)\d{2}\b/i.test(p.title) ? 1 : 0, locationPenalty: 0, legalUtilityPenalty: 0 },
  }]));
}

const all = (pages) => pages.map((_, i) => i);

test('the page that names the whole topic is suggested instead of a new page', () => {
  const r = promotableHub(all(WHITENING), WHITENING, lowScores(WHITENING), null);
  assert.ok(r, 'a broad page exists, so this is not a gap');
  assert.equal(WHITENING[r.pageIndex].title, 'Teeth Whitening: What You Need to Know');
  assert.deepEqual(r.coreTerms.sort(), ['tooth', 'whitening']);
  assert.match(r.reason, /“teeth whitening”/, 'the topic is quoted in the page’s own words');
  assert.match(r.reason, /instead of|rather than creating a new page/i);
});

test('a page with an angle of its own is never the broad page', () => {
  // Without the broad page, every candidate narrows the topic (cost, products…).
  const narrow = WHITENING.filter((p) => !p.url.endsWith('/teeth-whitening'));
  assert.equal(promotableHub(all(narrow), narrow, lowScores(narrow), null), null);
});

test('a question, a thin page or a location page cannot be promoted', () => {
  const pages = [
    page('teeth-whitening', 'Teeth Whitening?', 4000),
    page('teeth-whitening-cost', 'Teeth Whitening Cost', 3000),
    page('teeth-whitening-safety', 'Teeth Whitening Safety', 3000),
  ];
  assert.equal(promotableHub(all(pages), pages, lowScores(pages), null), null, 'a question title reads as a spoke');

  const thin = [{ ...pages[0], title: 'Teeth Whitening', wordCount: 300 }, pages[1], pages[2]];
  assert.equal(promotableHub(all(thin), thin, lowScores(thin), null), null, 'a thin page cannot be a hub');
});

test('plurals count as the same word', () => {
  assert.deepEqual(slugWords('https://x.test/a/dental-implants'), ['dental', 'implant']);
  const pages = [
    page('dental-implants', 'Dental Implants: Types, Procedure & Costs', 4607),
    page('how-long-dental-implants-last', 'How long do dental implants last', 1487),
    page('what-expect-during-your-dental-implant-procedure', 'What to Expect During Your Dental Implant Procedure', 1871),
    page('dental-crowns-tooth-bridges-guide', 'Dental crowns and tooth bridges', 1965),
    page('dental-bridge-vs-implant', 'Dental Bridge vs. Implant: Which Is Right for You?', 3439),
  ];
  const r = promotableHub(all(pages), pages, lowScores(pages), null);
  assert.ok(r);
  assert.equal(pages[r.pageIndex].url.endsWith('/dental-implants'), true);
});

test('selectHub reports a suggested hub, not a gap, and keeps gaps that are real', () => {
  const profiles = WHITENING.map(() => new Map([['teeth whitening', 1]]));
  const graph = WHITENING.map(() => new Set());
  const cluster = { memberIndices: all(WHITENING), name: 'Whitening & Teeth' };
  const r = selectHub(cluster, WHITENING, profiles, graph, null);
  if (r.hubConfidence === 'suggested') {
    assert.equal(r.isGap, false);
    assert.equal(r.gapSuggestion, null);
    assert.ok(r.hubSuggestion?.reason);
  } else {
    // The weighted score cleared the bar on its own: still not a gap.
    assert.equal(r.isGap, false);
  }
});

// The score picked a page about one angle of the topic while the page about the
// whole of it sat in the cluster as a spoke: "Wisdom Tooth Removal Cost" was the
// hub and "Wisdom Teeth Removal: A Complete Guide" a spoke beneath it.
function strongScores(pages, topSlug) {
  return new Map(pages.map((p, i) => [i, {
    score: p.url.endsWith(`/${topSlug}`) ? 0.9 : 0.6,
    breakdown: { titlePenalty: /\?/.test(p.title) ? 1 : 0, locationPenalty: 0, legalUtilityPenalty: 0 },
  }]));
}

const WISDOM = [
  page('wisdom-tooth-removal-cost', 'Wisdom Tooth Removal Cost: Price Factors | Gentle Dental', 3545),
  page('what-to-expect-on-your-wisdom-teeth-removal', 'What to Expect During Your Wisdom Tooth Removal', 1546),
  page('wisdom-teeth-removal', 'Wisdom Teeth Removal: A Complete Guide | Gentle Dental of New England', 2547),
];

test('teeth and tooth are one word', () => {
  assert.deepEqual(slugWords('https://x.test/a/wisdom-teeth-removal'), ['wisdom', 'tooth', 'removal']);
});

test('the broad page replaces a hub that covers one angle of the same topic', () => {
  const r = promotableHub(all(WISDOM), WISDOM, strongScores(WISDOM, 'wisdom-tooth-removal-cost'), null, { replacing: 0 });
  assert.equal(r.pageIndex, 2);
  assert.ok(!r.eligible.includes(0), 'the cost page is an angle, not the whole topic');
  assert.match(r.reason, /instead of “Wisdom Tooth Removal Cost: Price Factors”/);
});

test('a "What is X?" title on the topic’s own page can be the hub', () => {
  const pages = [
    page('root-canal-cost', 'Root Canal Cost: Average Prices & Factors', 3887),
    page('root-canal', 'What Is a Root Canal? Causes, Symptoms and Treatment', 2902),
    page('root-canal-infection-symptoms', 'What Are Symptoms of a Root Canal Infection?', 2280),
  ];
  const r = promotableHub(all(pages), pages, strongScores(pages, 'root-canal-cost'), null, { replacing: 0 });
  assert.equal(r.pageIndex, 1);
});
