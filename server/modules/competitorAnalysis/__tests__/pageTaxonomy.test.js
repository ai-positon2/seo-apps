// Every precedence rule, each with a fixture that would be misclassified if the
// rule were removed. The model verdict in each case is the plausible WRONG
// answer — that is the point: these tests fail if a rule stops constraining.
const assert = require('assert');
const tax = require('../contentAnalysis/pageTaxonomy');
const rules = require('../contentAnalysis/pageRules');

let passed = 0;
const test = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); passed += 1; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); process.exitCode = 1; }
};
const section = (t) => console.log(`\n${t}`);

const page = (url, title) => ({ fullUrl: url, url: new URL(url).pathname, title });
const verdict = (subtype, confidence = 0.9, extra = {}) => ({ subtype, confidence, ...extra });
const firedRules = (r) => r.signals.map((s) => s.rule);

// ── The taxonomy itself ────────────────────────────────────────────────────
section('taxonomy — one source of truth');

test('every subtype belongs to exactly one family', () => {
  const seen = new Map();
  for (const [family, subs] of Object.entries(tax.FAMILIES)) {
    for (const s of subs) {
      assert.ok(!seen.has(s), `${s} appears in both ${seen.get(s)} and ${family}`);
      seen.set(s, family);
    }
  }
  assert.strictEqual(seen.size, tax.SUBTYPES.length);
});

test('every subtype has a definition the model can read', () => {
  const missing = tax.SUBTYPES.filter((s) => !tax.SUBTYPE_HINTS[s]);
  assert.deepStrictEqual(missing, [], `undefined: ${missing.join(', ')}`);
});

test('utility and index lists reference real subtypes', () => {
  for (const s of [...tax.UTILITY_SUBTYPES, ...tax.INDEX_SUBTYPES]) {
    assert.ok(tax.isValidSubtype(s), `${s} is not a subtype`);
  }
});

test('familyOf resolves every subtype', () => {
  for (const s of tax.SUBTYPES) assert.ok(tax.familyOf(s), `${s} has no family`);
});

// ── Rule 1 ─────────────────────────────────────────────────────────────────
section('rule 1 — utility overrides everything');

test('a cart page titled like a product listing is still a cart', () => {
  const r = rules.classifyPage(page('https://shop.test/cart', 'Shop Dental Supplies — Your Basket'), verdict('product_category'));
  assert.strictEqual(r.subtype, 'cart');
  assert.strictEqual(r.type, 'commerce');
  assert.ok(firedRules(r).includes('utility_override'));
});

test('a privacy policy that reads like a guide is legal', () => {
  const r = rules.classifyPage(page('https://x.test/legal-notices/privacy', 'Privacy Policy — A Complete Guide to Your Data'), verdict('guide'));
  assert.strictEqual(r.subtype, 'legal');
  assert.strictEqual(r.type, 'system');
});

test('"my-account-manager" is not an account page', () => {
  const r = rules.classifyPage(page('https://x.test/services/my-account-manager', 'Your Dedicated Account Manager'), verdict('service'));
  assert.strictEqual(r.subtype, 'service', 'whole-segment match only');
});

// ── Rule 2 ─────────────────────────────────────────────────────────────────
section('rule 2 — the most specific intersection wins');

test('a service under a geo path is location_service, not service', () => {
  const r = rules.classifyPage(page('https://x.test/locations/tx/austin/services/emergency-dentist', 'Emergency Dentist in Austin'), verdict('service'));
  assert.strictEqual(r.subtype, 'location_service');
  assert.ok(firedRules(r).includes('intersection'));
});

test('location_service outranks geo_landing on the same evidence', () => {
  const r = rules.classifyPage(page('https://x.test/tx/services/ac-repair', 'AC Repair in Texas'), verdict('geo_landing'));
  assert.strictEqual(r.subtype, 'location_service');
});

test('an individual posting under a careers path outranks the hub', () => {
  const r = rules.classifyPage(page('https://x.test/careers/senior-backend-engineer', 'Senior Backend Engineer — Careers'), verdict('careers_hub'));
  assert.strictEqual(r.subtype, 'job_posting');
});

test('the careers hub itself is left alone', () => {
  const r = rules.classifyPage(page('https://x.test/careers', 'Careers'), verdict('careers_hub'));
  assert.strictEqual(r.subtype, 'careers_hub');
});

// ── Rule 3 ─────────────────────────────────────────────────────────────────
section('rule 3 — one subject vs a list of siblings');

test('a listing subtype sets is_index_page', () => {
  const r = rules.classifyPage(page('https://x.test/blog', 'The Blog'), verdict('blog_index'));
  assert.strictEqual(r.facets.is_index_page, true);
});

test('a detail subtype does not', () => {
  const r = rules.classifyPage(page('https://x.test/blog/2026/05/a-post', 'A Post'), verdict('blog_post'));
  assert.strictEqual(r.facets.is_index_page, false);
});

test('pagination makes a page an index even when the subtype does not', () => {
  const r = rules.classifyPage(page('https://x.test/resources/page/3', 'Resources — Page 3'), verdict('guide'));
  assert.strictEqual(r.facets.is_paginated, true);
  assert.strictEqual(r.facets.page_number, 3);
  assert.strictEqual(r.facets.is_index_page, true);
});

test('?page=2 counts as pagination too', () => {
  const r = rules.classifyPage(page('https://x.test/resources?page=2', 'Resources'), verdict('hub'));
  assert.strictEqual(r.facets.page_number, 2);
});

// ── Rule 4 ─────────────────────────────────────────────────────────────────
section('rule 4 — converting well is not enough to be a landing page');

test('a persuasive page with no campaign evidence is NOT a landing page', () => {
  const r = rules.classifyPage(page('https://x.test/solutions/zero-trust-demo', 'See Zero Trust in Action — Book Your Demo'), verdict('landing'));
  assert.notStrictEqual(r.subtype, 'landing');
  assert.ok(firedRules(r).includes('landing_demoted'));
});

test('a paid entry parameter is campaign evidence, and confirms it', () => {
  const r = rules.classifyPage(page('https://x.test/offer?utm_source=google&gclid=abc', 'Spring Offer'), verdict('landing'));
  assert.strictEqual(r.subtype, 'landing');
  assert.strictEqual(r.facets.is_campaign_scoped, true);
  assert.ok(firedRules(r).includes('landing_confirmed'));
});

// ── Rule 5 ─────────────────────────────────────────────────────────────────
section('rule 5 — dated and bylined beats evergreen');

test('a dated post under /blog/ is a blog_post, not a guide', () => {
  const r = rules.classifyPage(page('https://x.test/blog/2026/05/ai-security-trends', 'AI Security Trends'), verdict('guide'));
  assert.strictEqual(r.subtype, 'blog_post');
  assert.ok(firedRules(r).includes('dated_post'));
});

test('an undated evergreen page stays a guide', () => {
  const r = rules.classifyPage(page('https://x.test/resources/zero-trust-guide', 'The Complete Guide to Zero Trust'), verdict('guide'));
  assert.strictEqual(r.subtype, 'guide');
});

// ── Rule 7 ─────────────────────────────────────────────────────────────────
section('rule 7 — a close runner-up is kept, a clear loser is not');

test('candidates within 0.15 store both', () => {
  const r = rules.classifyPage(page('https://x.test/resources/report', 'State of Security 2026'),
    verdict('whitepaper', 0.55, { secondary: 'data_study', secondaryConfidence: 0.45 }));
  assert.strictEqual(r.subtype, 'whitepaper');
  assert.strictEqual(r.subtype_secondary, 'data_study');
  assert.strictEqual(r.type_secondary, 'informational');
});

test('a distant runner-up is dropped', () => {
  const r = rules.classifyPage(page('https://x.test/resources/report', 'State of Security 2026'),
    verdict('whitepaper', 0.95, { secondary: 'data_study', secondaryConfidence: 0.2 }));
  assert.strictEqual(r.subtype_secondary, null);
  assert.strictEqual(r.type_secondary, null);
});

// ── Rule 8 ─────────────────────────────────────────────────────────────────
section('rule 8 — unclassified carries a reason, and is never used above the floor');

test('a weak verdict becomes unclassified WITH a reason', () => {
  const r = rules.classifyPage(page('https://x.test/xyzzy', 'Untitled'), verdict('portfolio_project', 0.2));
  assert.strictEqual(r.subtype, 'unclassified');
  assert.ok(r.reason && r.reason.length > 0, 'must carry a reason');
  assert.ok(firedRules(r).includes('below_threshold'));
});

test('a confident verdict is never downgraded to unclassified', () => {
  const r = rules.classifyPage(page('https://x.test/pricing', 'Pricing'), verdict('pricing', 0.95));
  assert.strictEqual(r.subtype, 'pricing');
  assert.strictEqual(r.reason, null);
});

test('a subtype outside the taxonomy is rejected, not stored', () => {
  const r = rules.classifyPage(page('https://x.test/a', 'A'), verdict('made_up_type', 0.99));
  assert.strictEqual(r.subtype, 'unclassified');
  assert.ok(firedRules(r).includes('invalid_subtype'));
});

// ── Explainability + facets ────────────────────────────────────────────────
section('every verdict explains itself');

test('signals record each rule that fired, in order', () => {
  const r = rules.classifyPage(page('https://x.test/cart', 'Basket'), verdict('product_category'));
  assert.ok(Array.isArray(r.signals) && r.signals.length >= 2);
  for (const s of r.signals) {
    assert.ok(s.rule && s.detail && s.from, 'each signal names its rule, detail and source');
  }
  assert.strictEqual(r.signals[0].rule, 'model', 'the model verdict is recorded first');
});

section('facets are measured or null, never guessed');

test('facets needing the page body are null, not invented', () => {
  const r = rules.classifyPage(page('https://x.test/blog/2026/05/post', 'A Post'), verdict('blog_post'));
  for (const k of ['word_count', 'has_form', 'has_price', 'primary_schema_type', 'indexable', 'in_sitemap', 'orphan', 'template_fingerprint']) {
    assert.strictEqual(r.facets[k], null, `${k} must be null without page data`);
  }
});

test('every taxonomy facet key is present on the result', () => {
  const r = rules.classifyPage(page('https://x.test/', 'Home'), verdict('home'));
  for (const k of tax.FACET_KEYS) assert.ok(k in r.facets, `missing facet ${k}`);
});

test('locale is read from the path, and section names are not mistaken for one', () => {
  assert.strictEqual(rules.detectLocale('https://x.test/uk/pricing'), 'uk');
  assert.strictEqual(rules.detectLocale('https://x.test/en-us/pricing'), 'en-US');
  assert.strictEqual(rules.detectLocale('https://x.test/ai/pricing'), null, '"ai" is a section, not a language');
  assert.strictEqual(rules.detectLocale('https://x.test/pricing'), null);
});

test('funnel stage and content format come from the subtype', () => {
  assert.strictEqual(tax.funnelStageOf('pricing'), 'decision');
  assert.strictEqual(tax.funnelStageOf('blog_post'), 'awareness');
  assert.strictEqual(tax.contentFormatOf('podcast_episode'), 'audio');
  assert.strictEqual(tax.contentFormatOf('tool'), 'interactive');
  assert.strictEqual(tax.contentFormatOf('guide'), 'text');
});

console.log(`\n${passed} passed, ${process.exitCode ? 'FAILURES' : '0 failed'}`);
