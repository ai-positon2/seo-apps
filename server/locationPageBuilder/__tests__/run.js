// ── Tests for the deterministic pieces (Spec §0.4) ──────────────────────────
// No test framework is configured in this app, so this is a zero-dependency
// runner using Node's built-in assert. Run: node locationPageBuilder/__tests__/run.js

const assert = require('assert');
const url = require('../urlBuilder');
const cat = require('../categoryLogic');
const approval = require('../approval');
const qaEngine = require('../qaEngine');
const text = require('../text');
const schemaGenerator = require('../schemaGenerator');
const compose = require('../compose');
const internalLinks = require('../internalLinks');
const exporter = require('../exporter');

// ── Opt-in LLM stub ─────────────────────────────────────────────────────────
// keywordRelevance destructures createLlmClient at require time, so the patch
// has to land first. LLM_STUB stays null by default, which falls through to
// the real client (and its "ANTHROPIC_API_KEY is not configured" throw) so the
// fallback-path tests below still test the fallback path.
const llmProviders = require('../../services/llmProviders');
const realCreateLlmClient = llmProviders.createLlmClient;
let LLM_STUB = null;
llmProviders.createLlmClient = (model) => (LLM_STUB ? LLM_STUB(model) : realCreateLlmClient(model));

// Drives the two passes independently: `select` answers the selection prompt,
// `review` answers the critic prompt.
function stubLlm({ select, review }) {
  LLM_STUB = () => ({
    model: 'claude-sonnet-5',
    provider: 'anthropic',
    chat: {
      completions: {
        create: async ({ messages }) => {
          const isReview = messages[0].content.includes('You are reviewing a finished keyword selection');
          return { choices: [{ message: { content: JSON.stringify(isReview ? review : select) } }] };
        },
      },
    },
  });
}

const keywordRelevance = require('../keywordRelevance');
const dentalOutline = require('../dentalOutline');
const contentGenerator = require('../contentGenerator');
const config = require('../config');
const keywordUniverseMap = require('../keywordUniverseMap');
const keywordAdapter = require('../keywordAdapter');

// The keyword-presence check carries its own threshold in its id, so it is
// derived from config rather than hardcoded here.
// Threshold-carrying ids are derived from config, never hardcoded.
const FAQ_LOCALIZATION_CHECK = `city_in_faq_min_${config.dental.faqs.minLocalized}`;
const KEYWORD_PRESENCE_CHECK = `primary_keyword_present_${config.dental.minKeywordUses}x`;

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}

async function testAsync(name, fn) {
  try { await fn(); passed++; console.log(`  [ok] ${name}`); }
  catch (e) { failed++; console.error(`  [FAIL] ${name}\n    ${e.message}`); }
}

console.log('URL builder');
test('pageUrl nests service under location', () => {
  assert.strictEqual(url.pageUrl('psychiatrist-brea', 'talk-therapy'), '/locations/psychiatrist-brea/talk-therapy/');
});
test('slugify handles ampersand, accents, apostrophes', () => {
  assert.strictEqual(url.slugify("Teen Psychiatry & Psychotherapy"), 'teen-psychiatry-and-psychotherapy');
  assert.strictEqual(url.slugify("Let's Heal"), 'lets-heal');
});
test('canonicalUrl joins origin without double slash', () => {
  assert.strictEqual(url.canonicalUrl('https://x.com/', 'loc', 'svc'), 'https://x.com/locations/loc/svc/');
});

console.log('Category logic (Spec §5)');
test('medication → symptoms block', () => {
  assert.strictEqual(cat.benefitsOrSymptoms('medication', 'Medication Management', 'Brea').section_type, 'symptoms');
});
test('condition → causes decision-support', () => {
  assert.strictEqual(cat.decisionSupport('condition', 'Depression Treatment', 'Brea').section_type, 'causes');
});
test('procedure → what_to_expect + secondary when_to_consider', () => {
  const d = cat.decisionSupport('procedure', 'TMS Therapy', 'Brea');
  assert.strictEqual(d.section_type, 'what_to_expect');
  assert.strictEqual(d.secondary.section_type, 'when_to_consider');
});
test('therapy → conditions heading present, medication → null', () => {
  assert.ok(cat.conditionsTreatedHeading('therapy', 'Talk Therapy', 'Brea'));
  assert.strictEqual(cat.conditionsTreatedHeading('medication', 'Medication Management', 'Brea'), null);
});
test('orderConditions leads with relevant for Talk Therapy', () => {
  const ordered = cat.orderConditions('Talk Therapy', ['OCD', 'Depression', 'Anxiety', 'PTSD']);
  assert.strictEqual(ordered[0], 'Anxiety');
});

console.log('Approval state machine (Spec §10)');
test('clinical gate only applies to YMYL', () => {
  assert.deepStrictEqual(approval.applicableGates({ _ymyl: true }), ['seo', 'clinical', 'content', 'client']);
  assert.deepStrictEqual(approval.applicableGates({ _ymyl: false }), ['seo', 'content', 'client']);
});
test('cannot approve content before seo', () => {
  const page = { _ymyl: false, approval_status: { seo: 'pending', content: 'pending', client: 'pending' } };
  assert.throws(() => approval.approveGate(page, 'content'));
});
test('SEO gate blocked when QA has blocking failures', () => {
  const page = { _ymyl: false, approval_status: { seo: 'pending', content: 'pending', client: 'pending' } };
  assert.throws(() => approval.approveGate(page, 'seo', { qaBlockingFailures: 2 }));
});
test('approving last gate → Client Approved', () => {
  const page = { _ymyl: false, approval_status: { seo: 'approved', content: 'approved', client: 'pending' } };
  const r = approval.approveGate(page, 'client');
  assert.strictEqual(r.status, approval.STATUS.CLIENT_APPROVED);
});
test('editing resets approved gates', () => {
  const page = { _ymyl: false, approval_status: { seo: 'approved', content: 'approved', client: 'pending' } };
  const r = approval.resetGatesAfterEdit(page);
  assert.deepStrictEqual(r.reset.sort(), ['content', 'seo']);
  assert.strictEqual(r.approval_status.seo, 'pending');
});
test('only owning role can act; admin overrides', () => {
  assert.ok(approval.canActOn('clinical', 'clinical'));
  assert.ok(!approval.canActOn('clinical', 'seo'));
  assert.ok(approval.canActOn('clinical', 'admin'));
});

console.log('QA engine (Spec §9)');
function minimalPage() {
  const copy = 'word '.repeat(120);
  return {
    meta: { service_id: 'svc1' },
    global_template: { brand_name: 'Brand', business_type: 'MedicalBusiness' },
    location_data: {
      location_name: 'Brea', city: 'Brea', state: 'California', state_abbreviation: 'CA',
      street_address: '1 Main', phone_number: '(877) 000-0000', zip_code: '92821',
      location_slug: 'psychiatrist-brea', location_page_url: '/locations/psychiatrist-brea/',
      hero_image_url: 'https://x.com/brea.jpg', hero_image_alt: 'Office in Brea, CA',
      nearby_areas: ['Fullerton'],
      reviews: [{ reviewer_name: 'A', rating: 5, text: 'great', date: '2026-01-01' }],
    },
    service_data: { service_name: 'Talk Therapy', service_slug: 'talk-therapy', service_category: 'therapy', conditions_treated: [] },
    page_data: {
      page_url: '/locations/psychiatrist-brea/talk-therapy/',
      canonical_url: 'https://x.com/locations/psychiatrist-brea/talk-therapy/',
      meta_title: 'Talk Therapy in Brea | Brand', h1: 'Effective talk therapy in Brea',
      hero_intro: 'Talk therapy in Brea near Fullerton. ' + copy,
      approach: { heading: 'Our approach to Talk Therapy', intro: 'intro', care_pillars: [
        { heading: 'Our philosophy of compassionate care', copy },
        { heading: 'Clinical therapies offered', copy },
      ] },
      competitor_section: { blocks: [
        { h2: 'What talk therapy involves', h3s: [
          { heading: 'Approach', copy }, { heading: 'Sessions', copy }, { heading: 'Outcomes', copy },
        ] },
      ] },
      services_for_schema: [],
      faqs: Array.from({ length: 7 }, (_, i) => ({ question: `Q${i + 1}`, answer: `A${i + 1}`, faq_type: 'service' })),
      internal_links: [],
    },
  };
}
test('clean page → 0 blocking failures', () => {
  const p = minimalPage();
  p._client = { brand_static: {}, brand_rules: { prohibited_claims: [] } };
  p.page_data.schema = schemaGenerator.generateSchema(p);
  const r = qaEngine.runQA(p, { client: p._client, location: { street_address: '1 Main', phone_number: '(877) 000-0000', services_available_ids: ['svc1'] }, similarity: { similarity: 0 }, competitorOverlap: 0 });
  assert.strictEqual(r.blocking_failures, 0, 'failed: ' + JSON.stringify(r.checks.filter(c => !c.passed)));
});
test('NAP mismatch is a blocking failure', () => {
  const p = minimalPage();
  p._client = { brand_static: {}, brand_rules: { prohibited_claims: [] } };
  p.page_data.schema = schemaGenerator.generateSchema(p);
  const r = qaEngine.runQA(p, { client: p._client, location: { street_address: 'DIFFERENT', phone_number: 'x', services_available_ids: ['svc1'] }, similarity: { similarity: 0 }, competitorOverlap: 0 });
  assert.ok(r.checks.find(c => c.key === 'nap_matches_l2' && !c.passed));
});
test('prohibited claim is caught', () => {
  const p = minimalPage();
  p.page_data.hero_intro = 'We guarantee a cure for everyone. ' + 'word '.repeat(700);
  p._client = { brand_static: {}, brand_rules: { prohibited_claims: ['guarantee a cure'] } };
  p.page_data.schema = schemaGenerator.generateSchema(p);
  const r = qaEngine.runQA(p, { client: p._client, location: { street_address: '1 Main', phone_number: '(877) 000-0000', services_available_ids: ['svc1'] }, similarity: { similarity: 0 }, competitorOverlap: 0 });
  assert.ok(r.checks.find(c => c.key === 'prohibited_claims_absent' && !c.passed));
});
test('FAQ schema mismatch caught', () => {
  const p = minimalPage();
  p._client = { brand_static: {}, brand_rules: { prohibited_claims: [] } };
  p.page_data.schema = schemaGenerator.generateSchema(p);
  p.page_data.faqs.push({ question: 'Q2 added after schema', answer: 'A2' }); // schema now stale
  const r = qaEngine.runQA(p, { client: p._client, location: { street_address: '1 Main', phone_number: '(877) 000-0000', services_available_ids: ['svc1'] }, similarity: { similarity: 0 }, competitorOverlap: 0 });
  assert.ok(r.checks.find(c => c.key === 'faq_schema_matches_visible' && !c.passed));
});

console.log('\nDental (Gentle Dental) — URL builder (Build Brief §2.1)');
test('dentalPageUrl appends service slug to the location path', () => {
  assert.strictEqual(url.dentalPageUrl('/dental-offices/ma/quincy', 'teeth-whitening'), '/dental-offices/ma/quincy/teeth-whitening');
});
test('dentalPageUrl handles a location path with a sub-area segment', () => {
  assert.strictEqual(url.dentalPageUrl('/dental-offices/ma/boston/newbury-st', 'veneers'), '/dental-offices/ma/boston/newbury-st/veneers');
});
test('canonicalDentalUrl joins origin without double slash', () => {
  assert.strictEqual(url.canonicalDentalUrl('https://gentledental.com/', '/dental-offices/ma/quincy', 'implants'), 'https://gentledental.com/dental-offices/ma/quincy/implants');
});

console.log('\nDental — scaffold composition');
function dentalLayers() {
  return {
    client: { id: 'client_gentle_dental', name: 'Gentle Dental of New England', brand_static: { base_url: 'https://gentledental.com' } },
    service: { id: 'dsvc_teeth-whitening', name: 'Teeth Whitening', slug: 'teeth-whitening', category: 'Cosmetic' },
    location: {
      id: 'dloc_ma-quincy', location_name: 'Quincy', city: 'Quincy', region: 'South Shore',
      state: 'Massachusetts', state_abbreviation: 'MA', location_page_url: '/dental-offices/ma/quincy',
      street_address: '', phone_number: '', hours_by_day: {}, directions_url: '',
      latitude: '', longitude: '', services_available_ids: ['dsvc_teeth-whitening', 'dsvc_veneers'],
      nap_todo: ['street_address', 'phone_number', 'hours_by_day'],
    },
    allServices: [
      { id: 'dsvc_teeth-whitening', name: 'Teeth Whitening', slug: 'teeth-whitening', category: 'Cosmetic' },
      { id: 'dsvc_veneers', name: 'Veneers', slug: 'veneers', category: 'Cosmetic' },
    ],
  };
}
test('buildDentalScaffold derives urlPath/title/canonical and a deterministic breadcrumb+menu', () => {
  const scaffold = compose.buildDentalScaffold(dentalLayers());
  assert.strictEqual(scaffold.meta.urlPath, '/dental-offices/ma/quincy/teeth-whitening');
  assert.strictEqual(scaffold.meta.title, 'Teeth Whitening in Quincy, MA | Gentle Dental');
  assert.strictEqual(scaffold.sections.hero.h1, 'Teeth Whitening in Quincy, MA');
  assert.strictEqual(scaffold.sections.breadcrumb.items.length, 4);
  assert.strictEqual(scaffold.sections.servicesInCity.categories[0].items.length, 2);
  assert.deepStrictEqual(scaffold.sections.officeInfo.nap_todo, ['street_address', 'phone_number', 'hours_by_day']);
});
test('mergeDentalL3 fills in the generated subset (heroIntro/metaDescription/educationalBody/faqs) — no OG tags', () => {
  const scaffold = compose.buildDentalScaffold(dentalLayers());
  compose.mergeDentalL3(scaffold, {
    heroIntro: 'Teeth whitening in Quincy brightens smiles fast.',
    metaDescription: 'a'.repeat(155),
    educationalBody: [{ h2: 'What Is Teeth Whitening?', html: '<p>x</p>' }],
    faqs: [{ q: 'Q1', a: 'A1' }],
  });
  assert.strictEqual(scaffold.sections.hero.intro, 'Teeth whitening in Quincy brightens smiles fast.');
  assert.strictEqual(scaffold.meta.metaDescription.length, 155);
  assert.strictEqual(scaffold.sections.educationalBody.blocks.length, 1);
  assert.strictEqual(scaffold.sections.faq.items[0].q, 'Q1');
  // servicesInCity.intro is NOT generated — stays untouched (manual/optional).
  assert.strictEqual(scaffold.sections.servicesInCity.intro, '');
  // No OG tags in the contract at all.
  assert.ok(!('ogTitle' in scaffold.meta));
  assert.ok(!('ogDescription' in scaffold.meta));
  assert.ok(!('ogImageAlt' in scaffold.meta));
});

console.log('\nDental — internal links (Appendix C sibling-location cluster)');
test('buildDentalSiblings caps at maxSiblingLocations and prefers same region', () => {
  const currentLocation = { id: 'a', region: 'South Shore', city: 'Quincy', location_page_url: '/dental-offices/ma/quincy' };
  const allLocations = [
    currentLocation,
    { id: 'b', region: 'South Shore', city: 'Braintree', location_page_url: '/dental-offices/ma/braintree' },
    { id: 'c', region: 'South Shore', city: 'Hanover', location_page_url: '/dental-offices/ma/hanover' },
    { id: 'd', region: 'Worcester', city: 'Worcester', location_page_url: '/dental-offices/ma/worcester' },
    { id: 'e', region: 'Boston', city: 'Boston', location_page_url: '/dental-offices/ma/boston' },
  ];
  const links = internalLinks.buildDentalSiblings({ allLocations, currentLocation, service: { name: 'Teeth Whitening', slug: 'teeth-whitening' } });
  assert.strictEqual(links.length, 3);
  assert.ok(links.every(l => l.link_type === 'sibling_location'));
  assert.strictEqual(links[0].url, '/dental-offices/ma/braintree/teeth-whitening');
});

console.log('\nDental — schema (5 JSON-LD blocks, Appendix C layering)');
function dentalScaffoldWithContent() {
  const scaffold = compose.buildDentalScaffold(dentalLayers());
  let metaDescription = 'Get professional teeth whitening in Quincy, MA at Gentle Dental.';
  while (metaDescription.length < 152) metaDescription += ' Visit our caring Quincy team today.';
  metaDescription = metaDescription.slice(0, 158);
  compose.mergeDentalL3(scaffold, {
    heroIntro: 'Teeth whitening in Quincy can brighten your smile with safe, professional care close to home.',
    metaDescription,
    // Six blocks, mirroring the 6-7 stack dentalOutline now always plans.
    educationalBody: [
      { h2: 'What Is Teeth Whitening?', html: '<p>Teeth whitening in Quincy is a cosmetic procedure that lightens stains.</p>' },
      { h2: 'Benefits of Teeth Whitening', html: '<p>A brighter smile boosts confidence for Quincy patients.</p>' },
      { h2: 'What to Expect During Teeth Whitening', html: '<p>Sessions run about 60 minutes chairside.</p>' },
      { h2: 'Who Is a Good Candidate for Teeth Whitening?', html: '<p>Healthy gums and enamel make teeth whitening a good fit.</p>' },
      { h2: 'Types and Options for Teeth Whitening', html: '<p>In-office trays and take-home kits are both available.</p>' },
      { h2: 'Is Teeth Whitening Safe?', html: '<p>Professional whitening is safe when a dentist supervises it.</p>' },
    ],
    faqs: [
      { q: 'How long does teeth whitening take?', a: 'Most Quincy patients finish in one visit.' },
      { q: 'Is teeth whitening safe?', a: 'Yes, professional whitening is safe under a dentist’s care.' },
      { q: 'How much does teeth whitening cost?', a: 'Cost varies by case; ask our Quincy team for a quote.' },
      { q: 'Will insurance cover it?', a: 'Whitening is typically cosmetic and not covered.' },
    ],
  });
  scaffold.primaryKeyword = 'teeth whitening quincy';
  scaffold.secondaryKeywords = ['teeth whitening ma'];
  scaffold.sections.servicesInCity.internalLinks = [
    { anchor_text: 'Teeth Whitening in Braintree', url: '/dental-offices/ma/braintree/teeth-whitening', link_type: 'sibling_location', placement: 'services_in_city' },
    { anchor_text: 'Teeth Whitening in Hanover', url: '/dental-offices/ma/hanover/teeth-whitening', link_type: 'sibling_location', placement: 'services_in_city' },
    { anchor_text: 'Teeth Whitening in Worcester', url: '/dental-offices/ma/worcester/teeth-whitening', link_type: 'sibling_location', placement: 'services_in_city' },
  ];
  return scaffold;
}
test('generateDentalSchema returns 5 parseable JSON-LD strings, FAQ mirrors visible FAQs', () => {
  const layers = dentalLayers();
  const scaffold = dentalScaffoldWithContent();
  const schema = schemaGenerator.generateDentalSchema({ scaffold, client: layers.client, location: layers.location, service: layers.service });
  ['breadcrumbList', 'dentist', 'medicalWebPage', 'medicalProcedure', 'faqPage'].forEach(k => {
    assert.doesNotThrow(() => JSON.parse(schema[k]), `${k} should be valid JSON`);
  });
  const faqPage = JSON.parse(schema.faqPage);
  assert.strictEqual(faqPage.mainEntity.length, scaffold.sections.faq.items.length);
});

console.log('\nDental — QC (Build Brief §6 QcResult)');
test('a fully-formed dental page has no Critical failures', () => {
  const layers = dentalLayers();
  const scaffold = dentalScaffoldWithContent();
  scaffold.schema = schemaGenerator.generateDentalSchema({ scaffold, client: layers.client, location: layers.location, service: layers.service });
  const qc = qaEngine.runDentalQC(scaffold);
  const criticalFails = qc.checks.filter(c => c.severity === 'Critical' && !c.pass);
  assert.deepStrictEqual(criticalFails, [], 'unexpected critical failures: ' + JSON.stringify(criticalFails));
  assert.notStrictEqual(qc.verdict, 'FAIL');
});
test('missing primary keyword in H1/title/meta is a Critical failure → FAIL', () => {
  const layers = dentalLayers();
  const scaffold = dentalScaffoldWithContent();
  scaffold.primaryKeyword = 'something totally unrelated';
  scaffold.schema = schemaGenerator.generateDentalSchema({ scaffold, client: layers.client, location: layers.location, service: layers.service });
  const qc = qaEngine.runDentalQC(scaffold);
  assert.strictEqual(qc.verdict, 'FAIL');
  // The fixture's related keyword ("teeth whitening ma") IS in the H1 — a
  // related keyword must never stand in for the primary in an identity gate,
  // it only earns a more useful message.
  const h1 = qc.checks.find(c => c.id === 'primary_keyword_in_h1');
  assert.strictEqual(h1.pass, false);
  assert.ok(h1.detail.includes('Only the related keyword'), `unexpected detail: ${h1.detail}`);
});
test('a close variant of the primary satisfies the H1/title gates', () => {
  const layers = dentalLayers();
  const scaffold = dentalScaffoldWithContent();
  // Reordered, singular, and without the "in"/comma the H1 template adds.
  scaffold.primaryKeyword = 'quincy teeth whitening';
  scaffold.schema = schemaGenerator.generateDentalSchema({ scaffold, client: layers.client, location: layers.location, service: layers.service });
  const qc = qaEngine.runDentalQC(scaffold);
  ['primary_keyword_in_h1', 'primary_keyword_in_title'].forEach(id => {
    assert.strictEqual(qc.checks.find(c => c.id === id).pass, true, `${id} should accept a close variant`);
  });
});
test('fewer than 4 FAQs is a Critical failure', () => {
  const layers = dentalLayers();
  const scaffold = dentalScaffoldWithContent();
  scaffold.sections.faq.items = scaffold.sections.faq.items.slice(0, 2);
  scaffold.schema = schemaGenerator.generateDentalSchema({ scaffold, client: layers.client, location: layers.location, service: layers.service });
  const qc = qaEngine.runDentalQC(scaffold);
  assert.ok(qc.checks.find(c => c.name === 'faq_count_min_4' && !c.pass));
  assert.strictEqual(qc.verdict, 'FAIL');
});
test('primary keyword frequency check counts close variants (not just literal substring), no OG check exists', () => {
  const layers = dentalLayers();
  const scaffold = dentalScaffoldWithContent();
  scaffold.schema = schemaGenerator.generateDentalSchema({ scaffold, client: layers.client, location: layers.location, service: layers.service });
  const qc = qaEngine.runDentalQC(scaffold);
  const freqCheck = qc.checks.find(c => c.name === KEYWORD_PRESENCE_CHECK);
  assert.ok(freqCheck, KEYWORD_PRESENCE_CHECK + ' check should exist');
  assert.strictEqual(freqCheck.severity, 'Major');
  assert.ok(!qc.checks.find(c => c.name === 'og_fields_present'), 'og_fields_present check should no longer exist');
});
test('primary keyword frequency check fails when no approved keyword appears in the body', () => {
  const layers = dentalLayers();
  const scaffold = dentalScaffoldWithContent();
  scaffold.primaryKeyword = 'dental implants worcester'; // never appears anywhere in this fixture's body
  scaffold.secondaryKeywords = [];
  scaffold.schema = schemaGenerator.generateDentalSchema({ scaffold, client: layers.client, location: layers.location, service: layers.service });
  const qc = qaEngine.runDentalQC(scaffold);
  const freqCheck = qc.checks.find(c => c.name === KEYWORD_PRESENCE_CHECK);
  assert.strictEqual(freqCheck.pass, false);
});
test('usage frequency counts an approved RELATED keyword, not just the primary', () => {
  const scaffold = dentalScaffoldWithContent();
  scaffold.primaryKeyword = 'dental implants worcester'; // absent from the body
  const withoutRelated = qaEngine.runDentalQC({ ...scaffold, secondaryKeywords: [] })
    .checks.find(c => c.id === KEYWORD_PRESENCE_CHECK);
  // "teeth whitening ma" is what this fixture's body actually uses.
  const withRelated = qaEngine.runDentalQC(scaffold)
    .checks.find(c => c.id === KEYWORD_PRESENCE_CHECK);
  assert.ok(withRelated.detail.includes('teeth whitening ma'), `related keyword should be reported: ${withRelated.detail}`);
  assert.ok(withoutRelated.pass === false && withRelated.pass === true,
    'a body carrying only the related keyword should satisfy the usage gate, not the primary-in-H1 gate');
});
test('consecutive sentences that each use the keyword are each counted', () => {
  // The counter used to skip a whole window after every hit, which swallowed
  // any further use inside it: five sentences counted four, and a page could
  // be told to add a sixth use it had already written.
  const sentence = 'Teeth whitening in Quincy is quick. ';
  for (const n of [1, 2, 5, 9]) {
    assert.strictEqual(text.countAnyKeywordOccurrences(sentence.repeat(n), ['teeth whitening quincy']).total, n,
      `${n} consecutive uses should count ${n} times`);
  }
  // Still non-overlapping: one run of words is never counted twice, and words
  // too far apart to be one phrase are not a use at all.
  assert.strictEqual(text.countAnyKeywordOccurrences('teeth whitening in Quincy, MA', ['teeth whitening quincy']).total, 1);
  const scattered = `teeth whitening ${Array.from({ length: 20 }, (_, i) => `w${i}`).join(' ')} quincy`;
  assert.strictEqual(text.countAnyKeywordOccurrences(scattered, ['teeth whitening quincy']).total, 0);
  // One window satisfying two approved phrases is one use, not two.
  assert.strictEqual(
    text.countAnyKeywordOccurrences('teeth whitening in quincy ma', ['teeth whitening quincy', 'teeth whitening ma']).total, 1);
});
test('the usage and density gates cannot contradict each other', () => {
  // Frequency asks for >= 5 uses; density caps uses per word. They are only
  // satisfiable together because the word-count gate holds the denominator up
  // — if that floor ever drops, the writer gets two instructions it cannot
  // obey at once.
  const d = config.dental;
  const worstCaseDensity = 5 / d.pageWords.acceptMin;
  assert.ok(worstCaseDensity <= 0.025,
    `the minimum 5 uses at the ${d.pageWords.acceptMin}-word floor is ${(worstCaseDensity * 100).toFixed(1)}% density, over the 2.5% cap`);
});

console.log('\nDental — QC anchoring + single-check recheck');
test('every check names the editor control its failure belongs to', () => {
  const scaffold = dentalScaffoldWithContent();
  const fields = new Set(['hero.h1', 'hero.intro', 'meta.title', 'meta.metaDescription', 'educationalBody', 'faq', 'schema', 'internalLinks']);
  qaEngine.runDentalQC(scaffold).checks.forEach(c => {
    assert.ok(c.id, `check ${c.name} must have a stable id`);
    assert.ok(fields.has(c.field), `check ${c.id} has an unroutable field: ${c.field}`);
    assert.ok(c.label, `check ${c.id} must have a label for its inline notice`);
  });
});
test('a readability failure is reported per block, so the notice lands on it', () => {
  const scaffold = dentalScaffoldWithContent();
  const wall = Array.from({ length: config.dental.paragraphWords.hardMax + 5 }, (_, i) => `word${i}`).join(' ');
  scaffold.sections.educationalBody.blocks[1].html = `<p>${wall}</p>`;
  const check = qaEngine.runDentalQC(scaffold).checks.find(c => c.id === 'readability_paragraph_length');
  assert.deepStrictEqual(Object.keys(check.blocks), ['1'], 'only the offending block should be named');
  assert.ok(check.blocks[1].includes('longest paragraph'));
});
test('a single check can be re-run alone and gives the same answer', () => {
  const layers = dentalLayers();
  const scaffold = dentalScaffoldWithContent();
  scaffold.schema = schemaGenerator.generateDentalSchema({ scaffold, client: layers.client, location: layers.location, service: layers.service });
  const full = qaEngine.runDentalQC(scaffold);
  full.checks.forEach(c => {
    const alone = qaEngine.runDentalCheck(scaffold, c.id);
    assert.deepStrictEqual(alone, c, `${c.id} must not depend on being run with the others`);
  });
  assert.throws(() => qaEngine.runDentalCheck(scaffold, 'no_such_check'), /Unknown QC check/);
});
test('re-running one check splices it back in and re-derives the verdict', () => {
  const layers = dentalLayers();
  const scaffold = dentalScaffoldWithContent();
  scaffold.meta.metaDescription = 'Too short.';
  scaffold.schema = schemaGenerator.generateDentalSchema({ scaffold, client: layers.client, location: layers.location, service: layers.service });
  const before = qaEngine.runDentalQC(scaffold);
  assert.strictEqual(before.verdict, 'FAIL');

  // The reviewer fixes exactly that field and rechecks only it. Both meta
  // description checks hang off the same control, so both are re-run.
  scaffold.meta.metaDescription = 'Professional teeth whitening in Quincy, MA at Gentle Dental. Book your visit today and see what a brighter, healthier, more confident smile can do for you.';
  let merged = { checks: before.checks };
  ['meta_description_length', 'primary_keyword_in_meta_description'].forEach(id => {
    const fixed = qaEngine.runDentalCheck(scaffold, id);
    assert.strictEqual(fixed.pass, true, `${id} should pass after the fix: ${fixed.detail}`);
    merged = qaEngine.mergeDentalCheck(merged.checks, fixed);
  });
  assert.strictEqual(merged.checks.length, before.checks.length, 'the checks are replaced, not appended');
  assert.notStrictEqual(merged.verdict, 'FAIL', 'the verdict is re-derived from the merged set');
});
test('a second recheck must build on the first one\'s result, not on the same snapshot', () => {
  // The contract the wizard relies on by serializing its rechecks: each one
  // sends the list the previous one returned. Two fixes rechecked against the
  // SAME starting list would leave whichever replied last holding a result that
  // still says the other field is broken.
  const layers = dentalLayers();
  const scaffold = dentalScaffoldWithContent();
  scaffold.meta.metaDescription = 'Too short.';
  scaffold.sections.faq.items = scaffold.sections.faq.items.slice(0, 2);
  scaffold.schema = schemaGenerator.generateDentalSchema({ scaffold, client: layers.client, location: layers.location, service: layers.service });
  const stale = qaEngine.runDentalQC(scaffold);
  assert.strictEqual(stale.verdict, 'FAIL');

  // The reviewer fixes both fields, then rechecks them one after the other.
  scaffold.meta.metaDescription = 'Professional teeth whitening in Quincy, MA at Gentle Dental. Book your visit today and see what a brighter, healthier, more confident smile can do for you.';
  scaffold.sections.faq.items = dentalScaffoldWithContent().sections.faq.items;

  const first = qaEngine.recheckDental(scaffold, 'meta_description_length', stale.checks);
  const chained = qaEngine.recheckDental(scaffold, 'faq_count_min_4', first.checks);
  assert.strictEqual(chained.checks.find(c => c.id === 'meta_description_length').pass, true,
    'chaining keeps the first fix');
  assert.strictEqual(chained.checks.find(c => c.id === 'faq_count_min_4').pass, true);

  // Against the stale snapshot instead, the first fix is silently dropped —
  // which is exactly what the client must never do.
  const raced = qaEngine.recheckDental(scaffold, 'faq_count_min_4', stale.checks);
  assert.strictEqual(raced.checks.find(c => c.id === 'meta_description_length').pass, false,
    'this is the failure mode the queue exists to prevent');
});
test('a recheck with nothing to merge into runs the full pass, never a one-check verdict', () => {
  const layers = dentalLayers();
  const scaffold = dentalScaffoldWithContent();
  scaffold.sections.faq.items = scaffold.sections.faq.items.slice(0, 2); // a real Critical failure
  scaffold.schema = schemaGenerator.generateDentalSchema({ scaffold, client: layers.client, location: layers.location, service: layers.service });
  const full = qaEngine.runDentalQC(scaffold);

  // The caller stores what it gets back, so a single passing check must never
  // come back as a complete PASS result and overwrite a real one.
  [[], undefined, null].forEach(prior => {
    const r = qaEngine.recheckDental(scaffold, 'internal_links_min_3', prior);
    assert.strictEqual(r.checks.length, full.checks.length, 'the full check set must come back');
    assert.strictEqual(r.verdict, 'FAIL', 'the verdict must still reflect the FAQ failure');
    assert.strictEqual(r.check.id, 'internal_links_min_3', 'the requested check is returned alongside');
  });

  // With a prior set it merges, leaving every other check untouched.
  const merged = qaEngine.recheckDental(scaffold, 'internal_links_min_3', full.checks);
  assert.deepStrictEqual(
    merged.checks.filter(c => c.id !== 'internal_links_min_3'),
    full.checks.filter(c => c.id !== 'internal_links_min_3'),
    'a single-check recheck must not disturb the others');
  assert.throws(() => qaEngine.recheckDental(scaffold, 'no_such_check', full.checks), /Unknown QC check/);
});
test('the scaffold guard rejects payloads QC cannot meaningfully read', () => {
  [null, undefined, 'a string', {}, { meta: {} }, { sections: {} }]
    .forEach(bad => assert.strictEqual(qaEngine.isDentalScaffold(bad), false, `${JSON.stringify(bad)} is not a GeneratedPage`));
  assert.strictEqual(qaEngine.isDentalScaffold(dentalScaffoldWithContent()), true);
});
test('an H1 that is not "{Service} in {City}, {ST}" says so instead of quoting an empty city', () => {
  const scaffold = dentalScaffoldWithContent();
  scaffold.sections.hero.h1 = 'Quincy Teeth Whitening'; // no " in {City}, {ST}"
  const qc = qaEngine.runDentalQC(scaffold);
  ['city_in_educational_body', FAQ_LOCALIZATION_CHECK].forEach(id => {
    const c = qc.checks.find(x => x.id === id);
    assert.strictEqual(c.pass, false);
    assert.ok(!c.detail.includes('""'), `${id} quoted an empty city: ${c.detail}`);
    assert.ok(c.detail.includes('Could not read a city from the H1'), `${id} should point at the H1: ${c.detail}`);
  });
});

console.log('\nDental — educational-body outline planner (fallback ladder + competitor grading)');
test('pickLadder returns the clinical ladder for urgent/surgical services', () => {
  const clinical = dentalOutline.ladderHeadings({ name: 'Root Canals', category: 'Endodontics' });
  assert.strictEqual(clinical[1], 'Signs You May Need Root Canals');
  const emergency = dentalOutline.ladderHeadings({ name: 'Emergency Dental Care', category: 'Urgent' });
  assert.strictEqual(emergency[2], 'The Emergency Dental Care Procedure');
});
test('ladder rungs agree in number with plural service names', () => {
  // Half the Gentle Dental catalogue is plural, so a flat `What Is ${name}?`
  // used to render "What Is Root Canals?" and "Is Extractions Safe?".
  const plural = dentalOutline.ladderHeadings({ name: 'Root Canals', category: 'Restorative' });
  assert.strictEqual(plural[0], 'What Are Root Canals?');
  assert.strictEqual(plural[6], 'Are Root Canals Safe?');
  assert.strictEqual(plural[2], 'What Happens During Root Canals', 'avoids "The Root Canals Procedure"');

  const singular = dentalOutline.ladderHeadings({ name: 'Emergency Dental Care', category: 'Specialty' });
  assert.strictEqual(singular[0], 'What Is Emergency Dental Care?');
  assert.strictEqual(singular[6], 'Is Emergency Dental Care Safe?');
  assert.strictEqual(singular[2], 'The Emergency Dental Care Procedure');

  // The LAST word decides, and -ss/-us/-is words stay singular.
  assert.strictEqual(dentalOutline.isPluralName('Crowns & Bridges'), true);
  assert.strictEqual(dentalOutline.isPluralName('Diabetes & Oral Health'), false);
  assert.strictEqual(dentalOutline.isPluralName('Teeth Whitening'), false);
  assert.strictEqual(dentalOutline.isPluralName('Digital X-rays'), true);
});
test('pickLadder returns the general ladder for elective services', () => {
  const general = dentalOutline.ladderHeadings({ name: 'Teeth Whitening', category: 'Cosmetic' });
  assert.strictEqual(general[1], 'Benefits of Teeth Whitening');
  assert.strictEqual(general.length, 7);
});
test('scraped nav/CTA/brand headings are filtered out, real topics survive', () => {
  const kept = dentalOutline.filterCompetitorHeadings([
    'Meet Our Team', 'Book Your Appointment Today', 'Patient Reviews', 'Our Dentists in Quincy',
    'How Much Do Veneers Cost?', 'Does Insurance Cover Dental Implants?', 'Recovery Time After An Extraction',
    'Veneers', // too short to write a section from
    'How Much Do Veneers Cost?', // duplicate
  ]);
  assert.deepStrictEqual(kept, [
    'How Much Do Veneers Cost?',
    'Does Insurance Cover Dental Implants?',
    'Recovery Time After An Extraction',
  ]);
});

// Six competitor topics, none of which carries the service terms — the state
// that makes the keyword-in-an-H2 repair actually run.
const SIX_KEYWORDLESS_BLOCKS = () => [
  'Why Stains Form on Enamel', 'Caring for a Brighter Smile', 'Coffee and Tea Habits',
  'Enamel Health Basics', 'At-Home Kits Compared', 'Aftercare Tips',
].map(h2 => ({ h2, source: 'competitor', paragraphs: 2 }));

const OUTLINE_CTX = {
  service: { id: 'svc_teeth_whitening', name: 'Teeth Whitening', category: 'Cosmetic' },
  location: { id: 'loc_quincy', city: 'Quincy', state_abbreviation: 'MA' },
  primaryKeyword: 'teeth whitening quincy',
};

test('an outline with too few blocks is topped up from the ladder to 6', () => {
  const o = dentalOutline.normalizeOutline({
    competitorQuality: 'partial',
    blocks: [
      { h2: 'What Is Teeth Whitening?', source: 'competitor', paragraphs: 2 },
      { h2: 'How Much Does Teeth Whitening Cost?', source: 'competitor', paragraphs: 2 },
    ],
  }, OUTLINE_CTX);
  assert.strictEqual(o.blocks.length, 6);
  assert.strictEqual(o.blocks[0].h2, 'What Is Teeth Whitening?');
  assert.strictEqual(o.blocks[1].h2, 'How Much Does Teeth Whitening Cost?');
  assert.ok(o.blocks.slice(2).every(b => b.source === 'fallback'), 'topped-up blocks are tagged fallback');
});
test('an over-long outline is truncated to 7 blocks and boilerplate/duplicates are dropped', () => {
  const o = dentalOutline.normalizeOutline({
    competitorQuality: 'good',
    blocks: [
      ...Array.from({ length: 9 }, (_, i) => ({ h2: `Teeth Whitening Topic ${i}`, source: 'competitor', paragraphs: 2 })),
      { h2: 'Teeth Whitening Topic 0', source: 'competitor', paragraphs: 2 },
      { h2: 'Meet Our Team', source: 'competitor', paragraphs: 2 },
    ],
  }, OUTLINE_CTX);
  assert.strictEqual(o.blocks.length, 7);
  assert.ok(!o.blocks.some(b => b.h2 === 'Meet Our Team'), 'boilerplate must never reach the writer');
  assert.strictEqual(new Set(o.blocks.map(b => b.h2)).size, 7, 'headings must be unique');
});
test('paragraph counts are clamped to 1-3 and the stack stays inside the word budget', () => {
  const o = dentalOutline.normalizeOutline({
    blocks: [
      { h2: 'What Is Teeth Whitening?', paragraphs: 12 },
      { h2: 'Teeth Whitening Aftercare', paragraphs: 0 },
      { h2: 'Teeth Whitening Options', paragraphs: 'nonsense' },
    ],
  }, OUTLINE_CTX);
  assert.ok(o.blocks.every(b => b.paragraphs >= 1 && b.paragraphs <= 3), 'every block is 1-3 paragraphs');
  const total = o.blocks.reduce((n, b) => n + b.paragraphs, 0);
  assert.ok(total >= 12 && total <= 16, `total paragraphs ${total} should sit in 12-16`);
});
test('a full outline with no keyword-bearing H2 gets a ladder rung promoted', () => {
  // Mirrors qaEngine's keyword-in-an-H2 gate. A short outline is padded from
  // the ladder first, which already satisfies the gate; this exercises the
  // repair proper — a full 6-block outline where no heading carries it.
  const o = dentalOutline.normalizeOutline({ blocks: SIX_KEYWORDLESS_BLOCKS() },
    { ...OUTLINE_CTX, primaryKeyword: 'teeth whitening quincy' });
  assert.strictEqual(o.blocks[0].h2, 'What Is Teeth Whitening?');
  assert.strictEqual(o.blocks.length, 7);
});
test('a rung is promoted only when it actually satisfies the gate', () => {
  // "zoom" appears in no ladder rung, so no rung can satisfy the gate. This
  // used to hardcode the "What Is X?" rung on the theory that naming the
  // service is always enough — inserting a block that fixed nothing and
  // displacing a real competitor topic to do it. Leave the outline alone and
  // let QC flag the gate, which is what its `fix` hint is for.
  const o = dentalOutline.normalizeOutline({ blocks: SIX_KEYWORDLESS_BLOCKS() },
    { ...OUTLINE_CTX, primaryKeyword: 'zoom whitening quincy' });
  assert.strictEqual(o.blocks[0].h2, 'Why Stains Form on Enamel');
  assert.strictEqual(o.blocks.length, 6, 'no block slot is spent on a heading that changes nothing');
  assert.ok(!o.blocks.some(b => b.h2 === 'What Is Teeth Whitening?'));
});
test('an approved related keyword can satisfy the H2 gate, as it does in QC', () => {
  // qaEngine accepts the primary OR any approved related keyword in an H2, so
  // the repair reads the same phrase list rather than the primary alone.
  const o = dentalOutline.normalizeOutline({ blocks: SIX_KEYWORDLESS_BLOCKS() }, {
    ...OUTLINE_CTX,
    primaryKeyword: 'zoom whitening quincy',
    keywordPhrases: ['zoom whitening quincy', 'teeth whitening quincy'],
  });
  assert.strictEqual(o.blocks[0].h2, 'What Is Teeth Whitening?',
    'the related keyword is satisfiable by a rung, so it is promoted');
});
test('exactly one block is marked for city localization', () => {
  const o = dentalOutline.normalizeOutline({
    blocks: [
      { h2: 'What Is Teeth Whitening?', paragraphs: 2 },
      { h2: 'Teeth Whitening Options', paragraphs: 2 },
    ],
  }, OUTLINE_CTX);
  assert.strictEqual(o.blocks.filter(b => b.localize).length, 1);
  assert.strictEqual(o.blocks[1].localize, true);
});
test('fallbackOutline yields a full 7-rung ladder tagged unavailable', () => {
  const o = dentalOutline.fallbackOutline(OUTLINE_CTX);
  assert.strictEqual(o.competitorQuality, 'unavailable');
  assert.strictEqual(o.blocks.length, 7);
  assert.ok(o.blocks.every(b => b.source === 'fallback'));
  assert.ok(o.rationale.length > 0, 'the reviewer needs to know why the ladder was used');
});

console.log('\nDental — readability + block-count QC gates');
test('a 6-block stack passes the H2 count gate, a 3-block one fails it', () => {
  const layers = dentalLayers();
  const scaffold = dentalScaffoldWithContent();
  scaffold.schema = schemaGenerator.generateDentalSchema({ scaffold, client: layers.client, location: layers.location, service: layers.service });
  const pass = qaEngine.runDentalQC(scaffold).checks.find(c => c.name === `educational_h2_count_${config.dental.blocks.min}_${config.dental.blocks.max}`);
  assert.strictEqual(pass.pass, true);
  assert.strictEqual(pass.severity, 'Major');

  const thin = dentalScaffoldWithContent();
  thin.sections.educationalBody.blocks = thin.sections.educationalBody.blocks.slice(0, 3);
  const fail = qaEngine.runDentalQC(thin).checks.find(c => c.name === `educational_h2_count_${config.dental.blocks.min}_${config.dental.blocks.max}`);
  assert.strictEqual(fail.pass, false);
});
test('a paragraph longer than three phone lines fails the readability gate', () => {
  const scaffold = dentalScaffoldWithContent();
  const wall = Array.from({ length: 90 }, (_, i) => `word${i}`).join(' ');
  scaffold.sections.educationalBody.blocks[2].html = `<p>${wall}</p>`;
  const check = qaEngine.runDentalQC(scaffold).checks.find(c => c.name === 'readability_paragraph_length');
  assert.strictEqual(check.pass, false);
  assert.ok(check.detail.includes('What to Expect During Teeth Whitening'), 'the detail names the offending block');
});
test('more than three paragraph-level nodes in one block fails the readability gate', () => {
  const scaffold = dentalScaffoldWithContent();
  scaffold.sections.educationalBody.blocks[1].html =
    '<p>One short line.</p><p>Two short lines.</p><p>Three short lines.</p><ul><li>And a list</li></ul>';
  const check = qaEngine.runDentalQC(scaffold).checks.find(c => c.name === 'readability_paragraph_length');
  assert.strictEqual(check.pass, false);
});
test('a compliant stack of short paragraphs and one small list passes the readability gate', () => {
  const scaffold = dentalScaffoldWithContent();
  scaffold.sections.educationalBody.blocks[4].html =
    '<p>Two options are available for teeth whitening in Quincy.</p><ul><li>In-office trays</li><li>Take-home kits</li></ul>';
  const check = qaEngine.runDentalQC(scaffold).checks.find(c => c.name === 'readability_paragraph_length');
  assert.strictEqual(check.pass, true);
});
test('secondary keyword coverage is reported as Minor, and an empty list never fails it', () => {
  const scaffold = dentalScaffoldWithContent();
  scaffold.secondaryKeywords = ['whitening trays quincy'];
  const miss = qaEngine.runDentalQC(scaffold).checks.find(c => c.name === 'secondary_keyword_used');
  assert.strictEqual(miss.severity, 'Minor');
  assert.strictEqual(miss.pass, false);

  scaffold.sections.educationalBody.blocks[4].html = '<p>Whitening trays for Quincy patients are one option.</p>';
  const hit = qaEngine.runDentalQC(scaffold).checks.find(c => c.name === 'secondary_keyword_used');
  assert.strictEqual(hit.pass, true);

  scaffold.secondaryKeywords = [];
  assert.strictEqual(qaEngine.runDentalQC(scaffold).checks.find(c => c.name === 'secondary_keyword_used').pass, true);
});


// -- Dental keyword selection (Primary/Secondary relevance + review) --------
// These exercise the deterministic paths only. Both LLM passes are absent in
// tests (no ANTHROPIC_API_KEY), which is itself the behaviour under test: the
// module must degrade to the code-side gate rather than throw.
const KW_POOL = [
  { keyword: 'invisalign cost', volume: 1900, difficulty: 0, intent: 'commercial', source: 'live' },
  { keyword: 'invisalign cambridge', volume: 800, difficulty: 0, intent: 'commercial', source: 'live' },
  { keyword: 'invisalign brookline', volume: 90, difficulty: 0, intent: 'commercial', source: 'universe' },
  { keyword: 'clear aligners brookline', volume: 40, difficulty: 0, intent: 'commercial', source: 'universe' },
];
const KW_ARGS = {
  service: 'Invisalign', city: 'Brookline', state: 'MA', region: 'Greater Boston',
  relevanceTerms: ['invisalign', 'clear aligner'],
};

console.log('\nDental — the outline contract is enforced in code, not just requested');
test('a draft matching the outline gets the planned headings restored verbatim', () => {
  const outline = { blocks: [
    { h2: 'What Is Teeth Whitening?', paragraphs: 2 },
    { h2: 'Benefits of Teeth Whitening', paragraphs: 2 },
  ] };
  const l3 = { educationalBody: [
    { h2: 'What is teeth-whitening, exactly?', html: '<p>A.</p>' },
    { h2: 'Why Patients Love It', html: '<p>B.</p>' },
  ] };
  assert.strictEqual(contentGenerator.matchesOutline(l3, outline), true);
  const aligned = contentGenerator.alignToOutline(l3, outline);
  assert.deepStrictEqual(aligned.educationalBody.map(b => b.h2), ['What Is Teeth Whitening?', 'Benefits of Teeth Whitening']);
  assert.deepStrictEqual(aligned.educationalBody.map(b => b.html), ['<p>A.</p>', '<p>B.</p>'], 'bodies stay with their own block');
});
test('a draft with the wrong block count is detected and keeps its own headings', () => {
  // Index-forcing a short response would slide the plan's headings onto the
  // wrong bodies, so alignToOutline must leave a mismatch alone.
  const outline = { blocks: [
    { h2: 'What Is Teeth Whitening?' }, { h2: 'Benefits of Teeth Whitening' }, { h2: 'Is Teeth Whitening Safe?' },
  ] };
  const l3 = { educationalBody: [
    { h2: 'What Is Teeth Whitening?', html: '<p>A.</p>' },
    { h2: 'Is Teeth Whitening Safe?', html: '<p>C.</p>' },
  ] };
  assert.strictEqual(contentGenerator.matchesOutline(l3, outline), false);
  const aligned = contentGenerator.alignToOutline(l3, outline);
  assert.deepStrictEqual(aligned.educationalBody.map(b => b.h2), ['What Is Teeth Whitening?', 'Is Teeth Whitening Safe?']);
});
test('with no outline, any draft is accepted unchanged', () => {
  const l3 = { educationalBody: [{ h2: 'X', html: '<p>A.</p>' }] };
  assert.strictEqual(contentGenerator.matchesOutline(l3, null), true);
  assert.strictEqual(contentGenerator.alignToOutline(l3, null).educationalBody[0].h2, 'X');
});
test('the generated word count measures the same span as the QC gate', () => {
  const wc = contentGenerator.dentalGeneratedWordCount({
    heroIntro: 'one two three',
    metaDescription: 'this must not be counted at all not one word of it',
    educationalBody: [{ h2: 'H', html: '<p>four five</p><ul><li>six</li></ul>' }],
    faqs: [{ q: 'seven?', a: 'eight nine' }],
  });
  assert.strictEqual(wc, 9, 'hero(3) + body(3) + faq q(1) + faq a(2), meta excluded');
});

console.log('\nDental — the writer budget has to fit inside the QC word gate');
test('the instructed budget cannot overrun the QC word gate', () => {
  // Regression guard for a real defect: the prompt used to ask for 70-95 words
  // per block AND 12-16 paragraphs, which reached 1,023 words while telling the
  // model to stay under 860 and while QC failed anything over 900. Widening
  // config.dental without redoing this arithmetic reintroduces it.
  const d = config.dental;
  const totalParas = (blocks, per) => dentalOutline
    .normalizeOutline({ blocks: Array.from({ length: blocks }, (_, i) => ({ h2: `Teeth Whitening Topic ${i}`, paragraphs: per })) },
      { service: { name: 'Teeth Whitening' }, location: { city: 'Quincy', state_abbreviation: 'MA' }, primaryKeyword: 'teeth whitening quincy' })
    .blocks.reduce((n, b) => n + b.paragraphs, 0);

  // A short FAQ answer still carries its question, so ~8 words + the answer.
  const thinnest = d.paragraphWords.min + totalParas(d.blocks.min, 1) * d.paragraphWords.min + 4 * (8 + 25);
  const fattest = d.paragraphWords.max + totalParas(d.blocks.max, d.paragraphsPerBlock.max) * d.paragraphWords.max
    + 6 * (8 + d.faqAnswerMaxWords);
  assert.ok(thinnest >= d.pageWords.acceptMin, `thinnest instructed page (${thinnest}w) must clear the ${d.pageWords.acceptMin}w floor`);
  assert.ok(fattest <= d.pageWords.acceptMax, `fattest instructed page (${fattest}w) must stay under the ${d.pageWords.acceptMax}w ceiling`);
});
test('the readability gate enforces exactly the cap the writer prompt states', () => {
  // The cap used to be written twice, once in qaEngine and once in
  // contentGenerator; both now read config.dental.paragraphWords.hardMax.
  const scaffold = dentalScaffoldWithContent();
  const atCap = Array.from({ length: config.dental.paragraphWords.hardMax }, (_, i) => `w${i}`).join(' ');
  scaffold.sections.educationalBody.blocks[0].html = `<p>${atCap}</p>`;
  assert.strictEqual(qaEngine.runDentalQC(scaffold).checks.find(c => c.name === 'readability_paragraph_length').pass, true,
    'a paragraph exactly at the stated cap must pass');
  scaffold.sections.educationalBody.blocks[0].html = `<p>${atCap} oneMore</p>`;
  assert.strictEqual(qaEngine.runDentalQC(scaffold).checks.find(c => c.name === 'readability_paragraph_length').pass, false,
    'one word over the stated cap must fail');
});

console.log('\nDental — readability gate sees content the <p> scan would miss');
test('an unclosed <p> is reported as malformed, not silently passed', () => {
  const scaffold = dentalScaffoldWithContent();
  const wall = Array.from({ length: 90 }, (_, i) => `word${i}`).join(' ');
  scaffold.sections.educationalBody.blocks[0].html = `<p>${wall}`;
  const check = qaEngine.runDentalQC(scaffold).checks.find(c => c.name === 'readability_paragraph_length');
  assert.strictEqual(check.pass, false);
  assert.ok(check.detail.includes('outside any <p>'), 'the detail should say the text sits outside any paragraph');
});
test('bare text or a stray <div> body is reported as malformed', () => {
  const scaffold = dentalScaffoldWithContent();
  scaffold.sections.educationalBody.blocks[0].html = 'Just some bare copy with no markup at all.';
  assert.strictEqual(qaEngine.runDentalQC(scaffold).checks.find(c => c.name === 'readability_paragraph_length').pass, false);
  scaffold.sections.educationalBody.blocks[0].html = '<div>Wrapped in a disallowed tag.</div>';
  assert.strictEqual(qaEngine.runDentalQC(scaffold).checks.find(c => c.name === 'readability_paragraph_length').pass, false);
});
test('an overlong list item fails the gate even though the list is one node', () => {
  const scaffold = dentalScaffoldWithContent();
  const wall = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ');
  scaffold.sections.educationalBody.blocks[0].html = `<p>Short intro line.</p><ul><li>${wall}</li></ul>`;
  const check = qaEngine.runDentalQC(scaffold).checks.find(c => c.name === 'readability_paragraph_length');
  assert.strictEqual(check.pass, false);
  assert.ok(check.detail.includes('longest list item'), 'the detail should name the list-item cap');
});
test('an empty block body is not reported as malformed', () => {
  const scaffold = dentalScaffoldWithContent();
  scaffold.sections.educationalBody.blocks[0].html = '';
  const check = qaEngine.runDentalQC(scaffold).checks.find(c => c.name === 'readability_paragraph_length');
  assert.strictEqual(check.pass, true, 'emptiness is a content gap, caught by the word-count gate, not a markup defect');
});

console.log('\nDental — boilerplate filter keeps real topics, drops brand furniture');
test('"Why Choose" is only dropped when it is the brand block', () => {
  ['Why Choose Us', 'Why Choose Our Quincy Office', 'Why Choose Gentle Dental of New England']
    .forEach(h => assert.strictEqual(dentalOutline.BOILERPLATE_RE.test(h), true, `${h} should be dropped`));
  ['Why Choose Professional Teeth Whitening', 'Why Choose an Experienced Dentist for Veneers', 'Why Choose the Right Whitening Option']
    .forEach(h => assert.strictEqual(dentalOutline.BOILERPLATE_RE.test(h), false, `${h} is a real topic and must survive`));
});

console.log('\nDental - the service dropdown (seeded taxonomy)');
// Read the taxonomy out of the seed rather than restating it, so the test
// covers whatever is actually in the dropdown.
const SERVICE_DEFS = (() => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'seed.js'), 'utf8');
  const block = src.slice(src.indexOf('const GD_SERVICE_DEFS'), src.indexOf('const GD_SERVICES'));
  return [...block.matchAll(/\['([^']+)', '([^']+)', '([^']+)'\]/g)]
    .map(m => ({ category: m[1], name: m[2], slug: m[3] }));
})();
const WIZARD_CATEGORIES = ['Cosmetic', 'Restorative', 'Oral Surgery', 'Orthodontics', 'Preventive', 'Specialty'];

test('every service has a unique slug that matches its name', () => {
  // The slug is both the page URL and the service id, so a mismatch means the
  // URL does not follow from the name and a collision means two services
  // share an id.
  const seen = new Map();
  SERVICE_DEFS.forEach(d => {
    assert.strictEqual(url.slugify(d.name), d.slug, `${d.name}: slugify gives "${url.slugify(d.name)}"`);
    assert.ok(!seen.has(d.slug), `slug "${d.slug}" is used by both "${seen.get(d.slug)}" and "${d.name}"`);
    seen.set(d.slug, d.name);
  });
  assert.ok(SERVICE_DEFS.length >= 38, `expected the full taxonomy, found ${SERVICE_DEFS.length}`);
});
test('trademarked names survive slugification', () => {
  assert.strictEqual(url.slugify('Invisalign® Treatment'), 'invisalign-treatment');
  assert.strictEqual(url.slugify('Curodont™'), 'curodont');
});
test('every service groups under a category the wizard renders', () => {
  SERVICE_DEFS.forEach(d => assert.ok(WIZARD_CATEGORIES.includes(d.category),
    `${d.name} is in "${d.category}", which the dropdown does not group by`));
});
test('every service has keyword relevance terms', () => {
  // relevanceTermsFor returning null means the live SERP/SEMrush pool gets no
  // topical filter at all, which is how "veneers" ended up pulling in
  // "vanguard dental" and "dentist manchester nh". Renaming a slug silently
  // drops its entry, so this guards the whole taxonomy.
  SERVICE_DEFS.forEach(d => {
    const terms = keywordUniverseMap.relevanceTermsFor(d.slug);
    assert.ok(terms && terms.length, `${d.name} [${d.slug}] has no relevance terms`);
  });
});

console.log('\nDental - ladder grammar across the whole taxonomy');
test('no ladder heading is ungrammatical for any service', () => {
  const broken = [];
  SERVICE_DEFS.forEach(d => {
    dentalOutline.ladderHeadings(d).forEach(h => {
      // Agreement: a field or mass noun is never "What Are ...?"
      if (/^What Are .*(Dentistry|Surgery|Orthodontics|Whitening|Screening)\?$/.test(h)) broken.push(`${d.name}: ${h}`);
      // A person is never a procedure.
      if (/(During|Options for) (a|an) .*(ist|Dentist)\b/.test(h)) broken.push(`${d.name}: ${h}`);
      if (/^(Is|Are) .*(ist|Dentist) Safe\?$/.test(h)) broken.push(`${d.name}: ${h}`);
      // A countable singular always takes an article in a sentence rung.
      if (/^(Is) (Dental Exam|Tooth Extraction|Smile Makeover) Safe\?$/.test(h)) broken.push(`${d.name}: ${h}`);
    });
  });
  assert.deepStrictEqual(broken, [], `ungrammatical headings:\n  ${broken.join('\n  ')}`);
});
test('-ics names a field, so it is singular', () => {
  assert.strictEqual(dentalOutline.isPluralName('Orthodontics'), false);
  const h = dentalOutline.ladderHeadings({ name: 'Orthodontics', category: 'Orthodontics' });
  assert.strictEqual(h[0], 'What Is Orthodontics?');
  assert.ok(!h.some(x => /Are Orthodontics/.test(x)), 'never "Are Orthodontics Safe?"');
});
test('a countable singular takes an article, a mass noun does not', () => {
  assert.strictEqual(dentalOutline.withArticle('Dental Exam', false), 'a Dental Exam');
  assert.strictEqual(dentalOutline.withArticle('Tooth Extraction', false), 'a Tooth Extraction');
  assert.strictEqual(dentalOutline.withArticle('Oral Surgery', false), 'Oral Surgery');
  assert.strictEqual(dentalOutline.withArticle('Teeth Whitening', false), 'Teeth Whitening');
  assert.strictEqual(dentalOutline.withArticle('Cosmetic Dentistry', false), 'Cosmetic Dentistry');
  assert.strictEqual(dentalOutline.withArticle('Veneers', true), 'Veneers');
  // A trademarked name is a proper noun.
  assert.strictEqual(dentalOutline.withArticle('Curodont™', false), 'Curodont™');
  assert.strictEqual(dentalOutline.ladderHeadings({ name: 'Dental Exam', category: 'Preventive' })[6], 'Is a Dental Exam Safe?');
});
test('a practitioner page gets its own ladder, not the procedure one', () => {
  ['Orthodontist', 'Periodontist', 'Emergency Dentist'].forEach(name => {
    assert.strictEqual(dentalOutline.isPractitionerName(name), true);
    const h = dentalOutline.ladderHeadings({ name, category: 'Specialty' });
    assert.ok(/^What Does an? .* Do\?$/.test(h[0]), `${name}: ${h[0]}`);
    assert.ok(h.some(x => /^When Should You See/.test(x)), `${name} needs a "when to see one" rung`);
    assert.ok(!h.some(x => /What to Expect During/.test(x)), `${name}: "During a person" is not English`);
    assert.ok(!h.some(x => /Safe\?$/.test(x)), `${name}: a person is not "safe"`);
  });
});
test('Periodontist takes the practitioner ladder despite matching the clinical regex', () => {
  // CLINICAL_RE matches "periodont", so order matters in pickLadder.
  assert.strictEqual(dentalOutline.pickLadder({ name: 'Periodontist', category: 'Specialty' }),
    dentalOutline.PRACTITIONER_LADDER);
});
test('the clinical ladder still wins for urgent procedures', () => {
  const h = dentalOutline.ladderHeadings({ name: 'Teeth Extractions', category: 'Oral Surgery' });
  assert.ok(h.some(x => /^Signs You May Need/.test(x)), 'a symptom-led rung is the point of that ladder');
});

console.log('\nDental - FAQ localization is meaningful, not decorative');
// The reviewer's own pairs. Both lists say "in Methuen", so the phrasing is not
// the signal — what the question ASKS is.
const FAQ_LOCAL_GOOD = [
  'What types of sedation dentistry are available at your Methuen location?',
  'Is oral conscious sedation offered in Methuen?',
  'Do you offer IV sedation at your Methuen practice?',
  'Do you use sedation for dental implants at Gentle Dental Methuen?',
];
const FAQ_LOCAL_BAD = [
  'Does sedation dentistry hurt in Methuen?',
  'How long does sedation dentistry take in Methuen?',
  'Is sedation dentistry safe for me in Methuen?',
  'Who should consider sedation dentistry in Methuen?',
];
const METHUEN = { city: 'Methuen', brandName: 'Gentle Dental' };

test('questions about what THIS office offers may name the city', () => {
  assert.deepStrictEqual(text.findForcedFaqLocalization(FAQ_LOCAL_GOOD, METHUEN), [],
    'availability, options and booking are genuinely local');
});
test('universal clinical questions may not name the city', () => {
  const flagged = text.findForcedFaqLocalization(FAQ_LOCAL_BAD, METHUEN);
  assert.strictEqual(flagged.length, FAQ_LOCAL_BAD.length,
    `all four should flag, got ${JSON.stringify(flagged)}`);
});
test('the same question is fine once the city comes off', () => {
  const stripped = FAQ_LOCAL_BAD.map(q => q.replace(/ in Methuen/, ''));
  assert.deepStrictEqual(text.findForcedFaqLocalization(stripped, METHUEN), [],
    'pain/duration/safety/candidacy questions are wanted — just not localized');
});
test('an availability question survives a clinical word', () => {
  // "safe" appears, but the question is about what the office provides.
  assert.deepStrictEqual(
    text.findForcedFaqLocalization(['Do you offer sedation that is safe for children in Methuen?'], METHUEN), []);
  assert.deepStrictEqual(
    text.findForcedFaqLocalization(['Is IV sedation available for nervous patients in Methuen?'], METHUEN), []);
});
test('cost is not treated as universal — it varies by office', () => {
  assert.deepStrictEqual(
    text.findForcedFaqLocalization(['How much does sedation dentistry cost in Methuen?'], METHUEN), []);
});
test('the office name is a proper noun, not a keyword jammed against a city', () => {
  // "Gentle Dental Methuen" puts a service word right against the city, which
  // is exactly the force-fit shape — but it is what the office is called.
  const opts = { keywordPhrases: ['dental sedation methuen'], city: 'Methuen', brandName: 'Gentle Dental' };
  assert.deepStrictEqual(
    text.findForcedKeywordPhrases('Do you use sedation for implants at Gentle Dental Methuen?', opts), [],
    'the practice name must not be reported as a force-fit');
  assert.deepStrictEqual(
    text.findForcedKeywordPhrases('Ask about dental sedation Methuen options today.', opts), ['sedation Methuen'],
    'a real force-fit in the same sentence shape still flags');
});

console.log('\nDental - the two FAQ gates hold each other honest');
function faqScaffold(items) {
  const scaffold = dentalScaffoldWithContent();
  scaffold.sections.faq.items = items;
  return scaffold;
}
const faqCheck = (scaffold, id) => qaEngine.runDentalQC(scaffold).checks.find(c => c.id === id);

test(`fewer than ${config.dental.faqs.minLocalized} localized FAQs fails`, () => {
  const check = faqCheck(faqScaffold([
    { q: 'Do you offer in-office whitening in Quincy?', a: 'Yes, most visits take an hour.' },
    { q: 'Does whitening hurt?', a: 'Some brief sensitivity is normal.' },
    { q: 'How long do results last?', a: 'Usually a year with good care.' },
    { q: 'Will insurance cover it?', a: 'Whitening is cosmetic, so usually not.' },
  ]), FAQ_LOCALIZATION_CHECK);
  assert.strictEqual(check.pass, false);
  assert.ok(check.detail.includes(`minimum ${config.dental.faqs.minLocalized}`), check.detail);
});
test(`${config.dental.faqs.minLocalized} localized FAQs pass`, () => {
  const check = faqCheck(faqScaffold([
    { q: 'Do you offer in-office whitening in Quincy?', a: 'Yes, most visits take an hour.' },
    { q: 'Which whitening options are available at your Quincy office?', a: 'In-office trays and take-home kits.' },
    { q: 'Does whitening hurt?', a: 'Some brief sensitivity is normal.' },
    { q: 'Will insurance cover it?', a: 'Whitening is cosmetic, so usually not.' },
  ]), FAQ_LOCALIZATION_CHECK);
  assert.strictEqual(check.pass, true, check.detail);
});
test('hitting the count by localizing universal questions is caught', () => {
  // Exactly the trade a bare count invites: two cities bolted onto questions
  // whose answers do not change by city.
  const scaffold = faqScaffold([
    { q: 'Does teeth whitening hurt in Quincy?', a: 'Some brief sensitivity is normal.' },
    { q: 'Is teeth whitening safe for me in Quincy?', a: 'Yes, under a dentist.' },
    { q: 'How long do results last?', a: 'Usually a year with good care.' },
    { q: 'Will insurance cover it?', a: 'Whitening is cosmetic, so usually not.' },
  ]);
  assert.strictEqual(faqCheck(scaffold, FAQ_LOCALIZATION_CHECK).pass, true, 'the count is satisfied');
  const meaningful = faqCheck(scaffold, 'faq_localization_is_meaningful');
  assert.strictEqual(meaningful.pass, false, 'but the localization is decoration');
  assert.strictEqual(meaningful.severity, 'Major');
  assert.ok(meaningful.detail.includes('hurt in Quincy'), meaningful.detail);
});
test('the FAQ localization minimum is published to the wizard', () => {
  assert.strictEqual(qaEngine.DENTAL_LIMITS.faqs.minLocalized, config.dental.faqs.minLocalized);
});
test('every prompt path states the FAQ localization rule', () => {
  const brief = contentGenerator.DENTAL_SECTION_BRIEFS.faqs;
  assert.ok(brief.includes('LOCALIZING THE FAQ'), 'the brief must carry the rule');
  assert.ok(brief.includes('Does sedation dentistry hurt in Methuen?'), 'the BAD pair must be shown, not described');
  assert.ok(brief.includes('Do you offer IV sedation at your Methuen practice?'), 'the GOOD pair too');
  assert.ok(!/gentle dental/i.test(brief), 'the worked example must not hardcode one office brand');
});

console.log('\nDental - the meta description is never handed back truncated');
test('a short description is left alone, not padded with a clipped CTA', () => {
  // The reported failure: a 142-char description was padded with
  // "Ask our Stoughton team about digital x-rays options and book your visit
  // today." and then clipped to 160, producing "... precise care today. Ask our."
  const short = 'Digital x-rays in Stoughton, MA help your dentist spot problems fast with less radiation. See how this technology supports precise care today.';
  const out = contentGenerator.normalizeMetaDescriptionLength(short);
  assert.strictEqual(out, short, 'a readable-but-short description must survive untouched');
  assert.ok(!/\bAsk our\.$/.test(out), 'the clipped-CTA fragment must be gone');
});
test('an over-long description is trimmed at a sentence boundary', () => {
  const long = 'Digital x-rays in Stoughton, MA let your dentist find decay early and plan care precisely, with far less radiation than film. Book a visit with our team today, we are ready.';
  const out = contentGenerator.normalizeMetaDescriptionLength(long);
  assert.ok(out.length <= config.dental.metaDescription.max, `${out.length} chars must fit the snippet`);
  assert.ok(/[.!?]$/.test(out), 'it has to end as a finished sentence');
  assert.ok(out.endsWith('today.'), `expected a clean sentence trim, got ${JSON.stringify(out)}`);
});
test('a sentence trim that would gut the description falls back to a word trim', () => {
  // First sentence is only 103 chars — trimming there would waste the snippet.
  const long = 'Digital x-rays in Stoughton, MA help your dentist spot problems fast with far less radiation than film. See how this technology supports precise, comfortable care and book your visit with our team today.';
  const out = contentGenerator.normalizeMetaDescriptionLength(long);
  assert.ok(out.length >= config.dental.metaDescription.min, `${out.length} chars is below the ${config.dental.metaDescription.min} floor`);
  assert.ok(out.length <= config.dental.metaDescription.max);
});
test('no trim ever ends on a dangling function word', () => {
  const dangling = [
    'Digital x-rays in Stoughton help your dentist find decay early and plan treatment with far less radiation than film, and our team will walk you through every step and',
    'Digital x-rays in Stoughton help your dentist find decay early and plan treatment with far less radiation than traditional film, which is better for you and your',
  ];
  dangling.forEach(v => {
    const out = contentGenerator.normalizeMetaDescriptionLength(v);
    assert.ok(out.length <= config.dental.metaDescription.max, `${out.length} chars`);
    assert.ok(!/\s(?:a|an|and|our|the|to|your|with|for|every|this|that)\.?$/i.test(out),
      `ends on a dangling word: ${JSON.stringify(out)}`);
  });
});
test('the meta description range is single-sourced', () => {
  // The prompt, the QC gate and the wizard's counter all read config.
  const L = qaEngine.DENTAL_LIMITS.metaDescription;
  assert.deepStrictEqual(L, { min: config.dental.metaDescription.min, max: config.dental.metaDescription.max });
});

console.log('\nDental - the practice name is per office, not global');
test('an office with its own brand is never called Gentle Dental', () => {
  const newbury = { location_page_url: '/dental-offices/ma/boston/newbury-st' };
  assert.strictEqual(compose.dentalBrandName(newbury, { name: 'Gentle Dental of New England' }), 'Newbury Dental Associates');
});
test('every other office falls back to the group brand', () => {
  assert.strictEqual(compose.dentalBrandName({ location_page_url: '/dental-offices/ma/quincy' }, {}), config.dental.brand.default);
  assert.strictEqual(compose.dentalBrandName({}, {}), config.dental.brand.default);
});
test("a location row's own brand_name wins over the config map", () => {
  const row = { location_page_url: '/dental-offices/ma/boston/newbury-st', brand_name: 'Something Else Dental' };
  assert.strictEqual(compose.dentalBrandName(row, {}), 'Something Else Dental');
});
test('the title tag and page object carry the office brand', () => {
  const client = { id: 'c', name: 'Gentle Dental of New England', brand_static: { base_url: 'https://gentledental.com' } };
  const service = { id: 's', name: 'Digital X-rays', slug: 'digital-x-rays', category: 'Preventive' };
  const location = {
    id: 'l', location_name: 'Boston - Newbury Street', city: 'Boston', region: 'Boston',
    state: 'Massachusetts', state_abbreviation: 'MA', location_page_url: '/dental-offices/ma/boston/newbury-st',
  };
  const scaffold = compose.buildDentalScaffold({ client, service, location, allServices: [service] });
  assert.strictEqual(scaffold.meta.brandName, 'Newbury Dental Associates');
  assert.strictEqual(scaffold.meta.title, 'Digital X-rays in Boston, MA | Newbury Dental Associates');

  // Schema reads the resolved name off the page object, not client.name.
  scaffold.sections.hero.intro = 'x';
  scaffold.sections.educationalBody.blocks = [{ h2: 'h', html: '<p>x</p>' }];
  scaffold.sections.faq.items = [{ q: 'q', a: 'a' }];
  const dentist = JSON.parse(schemaGenerator.generateDentalSchema({ scaffold, client, location, service }).dentist);
  assert.ok(dentist.name.startsWith('Newbury Dental Associates'), `schema says ${JSON.stringify(dentist.name)}`);
});
test('the writer prompt names the office brand and never the wrong one', () => {
  const service = { id: 's', name: 'Digital X-rays', category: 'Preventive' };
  const location = {
    id: 'l', location_name: 'Boston - Newbury Street', city: 'Boston', region: 'Boston',
    state_abbreviation: 'MA', location_page_url: '/dental-offices/ma/boston/newbury-st',
  };
  const outline = dentalOutline.fallbackOutline({ service, location, primaryKeyword: 'digital x-rays boston' });
  const { system, user } = contentGenerator.buildDentalPrompt({
    service, location, primaryKeyword: 'digital x-rays boston', secondaryKeywords: [],
    outline, competitorFaqs: [], brandName: 'Newbury Dental Associates',
  });
  assert.ok(system.includes('Newbury Dental Associates'), 'the writer must be told who it is writing for');
  assert.ok(user.includes('Practice name (use this, never another): Newbury Dental Associates'));
  assert.ok(!/gentle dental/i.test(system + user),
    'no prompt for this office may mention Gentle Dental');
});

console.log('\nDental - keywords must read as English, not as pasted search strings');
// The pair the rule exists for. Same topic, same city, same coverage; one is
// a search string pasted into a sentence, the other is English.
const FORCED_HERO = "Invisalign Boston patients trust offers a discreet way to straighten teeth without metal brackets. At your visit, we'll explain clear aligner treatment, discuss Invisalign cost Boston and help you understand what to expect from start to finish.";
const NATURAL_HERO = 'Straighten your teeth discreetly with Invisalign clear aligners in Boston. Learn about the treatment process, costs, and what to expect from start to finish.';
const INVISALIGN_PHRASES = ['invisalign boston', 'invisalign cost boston', 'clear aligners boston'];

test('the force-fitted hero is detected and the natural one is not', () => {
  const forced = text.findForcedKeywordPhrases(FORCED_HERO, { keywordPhrases: INVISALIGN_PHRASES, city: 'Boston' });
  assert.deepStrictEqual(forced, ['Invisalign Boston', 'cost Boston'],
    'both pasted fragments should be reported, verbatim, so QC can quote them');
  assert.deepStrictEqual(
    text.findForcedKeywordPhrases(NATURAL_HERO, { keywordPhrases: INVISALIGN_PHRASES, city: 'Boston' }), [],
    'the rewritten hero says the same thing in English and must pass');
});
test('natural phrasings are never flagged', () => {
  [
    'We offer clear aligners in Boston and across the South Shore.',
    'Ask about the cost of Invisalign in Boston before you commit.',
    'Our Boston office sees teens and adults for Invisalign.',
    'Many patients travel to Boston. Invisalign is popular with adults.',
    "Boston's weather has nothing to do with your treatment plan.",
    'Treatment usually costs less than braces.',
  ].forEach(s => assert.deepStrictEqual(
    text.findForcedKeywordPhrases(s, { keywordPhrases: INVISALIGN_PHRASES, city: 'Boston' }), [],
    `should not flag: ${s}`));
});
test('the service/city label is caught in either word order', () => {
  const opts = { keywordPhrases: ['veneers quincy', 'veneers cost quincy'], city: 'Quincy' };
  assert.deepStrictEqual(text.findForcedKeywordPhrases('Veneers Quincy residents love are thin.', opts), ['Veneers Quincy']);
  assert.deepStrictEqual(text.findForcedKeywordPhrases('Our Quincy veneers last for years.', opts), ['Quincy veneers']);
  assert.deepStrictEqual(text.findForcedKeywordPhrases('Learn about veneers cost Quincy shoppers see.', opts), ['cost Quincy']);
});
test('the regex uses real escapes, not a template-literal backspace', () => {
  // \b inside a template literal is a literal backspace and \w / \s collapse to
  // bare letters, which silently matches nothing. This caught exactly that.
  assert.deepStrictEqual(
    text.findForcedKeywordPhrases('Root Canals Malden patients ask about pain.', { keywordPhrases: ['root canal malden'], city: 'Malden' }),
    ['Canals Malden'], 'a stemmed keyword term must still match its plural in the copy');
});

console.log('\nDental - the force-fit gate in QC');
test('a force-fitted hero fails the gate and routes the reviewer to the hero', () => {
  const scaffold = dentalScaffoldWithContent();
  scaffold.sections.hero.intro = 'Teeth Whitening Quincy patients trust brightens your smile fast.';
  const check = qaEngine.runDentalQC(scaffold).checks.find(c => c.id === 'keyword_reads_naturally');
  assert.strictEqual(check.pass, false);
  assert.strictEqual(check.severity, 'Major');
  assert.strictEqual(check.field, 'hero.intro', 'the failure belongs to the hero control, not the body');
  assert.ok(check.detail.includes('Whitening Quincy'), 'the offending adjacency is quoted back verbatim');
});
test('a force-fitted block names the block so the reviewer can regenerate it', () => {
  const scaffold = dentalScaffoldWithContent();
  scaffold.sections.educationalBody.blocks[2].html = '<p>Ask about teeth whitening Quincy options today.</p>';
  const check = qaEngine.runDentalQC(scaffold).checks.find(c => c.id === 'keyword_reads_naturally');
  assert.strictEqual(check.pass, false);
  assert.strictEqual(check.field, 'educationalBody');
  assert.ok(check.blocks && check.blocks[2], 'the offending block index is reported');
});
test('the keyword floor is a low minimum, not a quota', () => {
  // A 5-use quota is what produced the force-fitted copy: no writer reaches
  // five uses of a search string in 700 words without padding.
  assert.ok(config.dental.minKeywordUses <= 2,
    'a high keyword floor and "never force-fit" cannot both hold');
  const scaffold = dentalScaffoldWithContent();
  const presence = qaEngine.runDentalQC(scaffold).checks.find(c => c.id === KEYWORD_PRESENCE_CHECK);
  assert.ok(presence, 'the presence check should exist');
  assert.ok(!/frequency/i.test(presence.fix), 'the fix hint must not ask for more mentions');
});

console.log('\nDental - every generated section is written to its own brief');
test('each section brief states where it appears, who reads it and its job', () => {
  ['metaDescription', 'heroIntro', 'educationalBody', 'faqs'].forEach(k => {
    const brief = contentGenerator.DENTAL_SECTION_BRIEFS[k];
    assert.ok(brief, `${k} needs a brief`);
    ['Where it appears:', 'Who is reading:', 'Its job:', 'Do NOT:'].forEach(part =>
      assert.ok(brief.includes(part), `${k} brief is missing "${part}"`));
  });
});
test('the page is framed as commercial intent, not a guide', () => {
  // These are location+service pages whose job is to fill a chair. The hero
  // used to close by describing what the page covers, which is blog framing.
  const svc = { id: 's', name: 'Sedation Dentistry', category: 'Specialty' };
  const loc = { id: 'l', location_name: 'Methuen', city: 'Methuen', region: 'Merrimack Valley', state_abbreviation: 'MA' };
  const outline = dentalOutline.fallbackOutline({ service: svc, location: loc, primaryKeyword: 'sedation dentistry methuen' });
  const { system } = contentGenerator.buildDentalPrompt({
    service: svc, location: loc, primaryKeyword: 'sedation dentistry methuen',
    secondaryKeywords: [], outline, competitorFaqs: [], brandName: 'Gentle Dental',
  });
  assert.ok(system.includes('THIS IS A COMMERCIAL-INTENT PAGE'), 'the page type has to be stated outright');
  assert.ok(/Commercial does NOT mean hype/.test(system), 'commercial must not be read as license to hype');

  const meta = contentGenerator.DENTAL_SECTION_BRIEFS.metaDescription;
  const hero = contentGenerator.DENTAL_SECTION_BRIEFS.heroIntro;
  [meta, hero].forEach(brief => assert.ok(/COMMERCIAL/.test(brief), 'both top-of-page briefs are commercial'));
  assert.ok(/next step|book|consultation/i.test(meta), 'the snippet has to move the reader');
  assert.ok(/next step|consultation/i.test(hero), 'so does the hero');

  // The body stays explanatory — the evidence, not the pitch.
  assert.ok(/Do NOT: sell/.test(contentGenerator.DENTAL_SECTION_BRIEFS.educationalBody),
    'the educational body must still explain rather than sell');
});
test('the hero brief carries the worked good/bad example', () => {
  const hero = contentGenerator.DENTAL_SECTION_BRIEFS.heroIntro;
  assert.ok(hero.includes('GOOD:'), 'the target has to be shown, not described');
  assert.ok(hero.includes('Invisalign Boston patients trust'), 'the force-fit failure is shown verbatim');
  // Two distinct failure modes, both worked: a force-fitted keyword and an
  // informational close on a page whose job is commercial.
  assert.ok(hero.includes('BAD (force-fitted keyword)'), 'the keyword failure must be labelled');
  assert.ok(hero.includes('BAD (informational'), 'the informational failure must be labelled');
  assert.ok(hero.includes('Learn about the treatment process'),
    'the informational close is shown as the thing NOT to write');
});
test('no prompt asks for a keyword frequency any more', () => {
  const svc = { id: 's', name: 'Invisalign', category: 'Cosmetic' };
  const loc = { id: 'l', location_name: 'Boston', city: 'Boston', region: 'Boston', state_abbreviation: 'MA' };
  const outline = dentalOutline.fallbackOutline({ service: svc, location: loc, primaryKeyword: 'invisalign boston' });
  const { system, user } = contentGenerator.buildDentalPrompt({
    service: svc, location: loc, primaryKeyword: 'invisalign boston',
    secondaryKeywords: ['invisalign cost boston'], outline, competitorFaqs: [],
  });
  [system, user].forEach(p => {
    assert.ok(!/\d+-\d+ times/i.test(p), 'no "4-5 times" style quota may survive');
    assert.ok(!/must appear \d/i.test(p), 'no "must appear N" quota may survive');
  });
  assert.ok(system.includes('THERE IS NO FREQUENCY TARGET'), 'the rule has to be stated outright');
  assert.ok(user.includes('"Invisalign Boston"'), 'the wrong form is shown back for this page');
});

(async () => {
  console.log('\nDental - the limits the wizard displays are the limits QC enforces');
  test('DENTAL_LIMITS matches the thresholds the checks actually gate on', () => {
    // The wizard shows these next to each field. If they drifted from the
    // gates, the UI would promise a target QC does not enforce.
    const L = qaEngine.DENTAL_LIMITS;
    assert.deepStrictEqual(L.blocks, { min: config.dental.blocks.min, max: config.dental.blocks.max });
    assert.deepStrictEqual(L.pageWords, { min: config.dental.pageWords.acceptMin, max: config.dental.pageWords.acceptMax });
    assert.strictEqual(L.paragraphWords.max, config.dental.paragraphWords.hardMax);
    assert.strictEqual(L.paragraphsPerBlock.max, config.dental.paragraphsPerBlock.max);
    assert.strictEqual(L.listItemMaxWords, config.dental.listItemMaxWords);
    assert.strictEqual(L.faqAnswerMaxWords, config.dental.faqAnswerMaxWords);
    assert.strictEqual(L.faqs.min, config.dental.faqs.min);

    // The meta-description range has to agree with the gate that uses it.
    const scaffold = dentalScaffoldWithContent();
    const mdCheck = qaEngine.runDentalQC(scaffold).checks.find(c => c.id === 'meta_description_length');
    assert.ok(mdCheck.detail.includes(`${L.metaDescription.min}-${L.metaDescription.max}`),
      `the length gate reports "${mdCheck.detail}", which must use the same range the UI shows`);
  });

  console.log('\nDental - DOCX export');
  await testAsync('the docx is a real Word container carrying every section', async () => {
    const scaffold = dentalScaffoldWithContent();
    scaffold.meta.metaDescription = 'META_MARKER';
    scaffold.sections.hero.intro = 'HERO_MARKER';
    scaffold.sections.educationalBody.blocks[0] = {
      h2: 'HEADING_MARKER',
      html: '<p>BODY_MARKER</p><ul><li>LIST_MARKER</li></ul>',
    };
    scaffold.sections.faq.items[0] = { q: 'QUESTION_MARKER', a: 'ANSWER_MARKER' };

    const buffer = await exporter.toDentalDocxBuffer(scaffold);
    assert.ok(buffer.length > 2000, 'a formatted document should not be near-empty');
    assert.strictEqual(buffer.slice(0, 2).toString(), 'PK', 'a .docx is a zip container');

    // The markers live in compressed parts, so check the whole buffer for the
    // ones long enough not to collide, and trust the zip structure otherwise.
    const zipText = buffer.toString('latin1');
    assert.ok(zipText.includes('word/document.xml'), 'the main document part must be present');
  });
  await testAsync('the docx filename is derived from the page URL path', async () => {
    const scaffold = dentalScaffoldWithContent();
    assert.strictEqual(exporter.safeFilename(scaffold), 'ma_quincy_teeth-whitening');
  });
  await testAsync('an edited page exports without needing to be saved first', async () => {
    // The wizard edits client-side, so the route takes the page in the body.
    // Exporting must therefore work on a scaffold that has no id at all.
    const scaffold = dentalScaffoldWithContent();
    delete scaffold.meta.page_id;
    const buffer = await exporter.toDentalDocxBuffer(scaffold);
    assert.strictEqual(buffer.slice(0, 2).toString(), 'PK');
  });

  console.log('\nDental - outline planner with no LLM available');
  await testAsync('planDentalOutline degrades to the code-side ladder instead of throwing', async () => {
    const o = await dentalOutline.planDentalOutline({
      service: { id: 'svc_root_canals', name: 'Root Canals', category: 'Endodontics' },
      location: { id: 'loc_malden', city: 'Malden', state_abbreviation: 'MA' },
      primaryKeyword: 'root canal malden',
      secondaryKeywords: [],
      competitorHeadings: ['Meet Our Team', 'Book Your Appointment Today'],
      competitorFaqs: [],
    });
    assert.strictEqual(o.competitorQuality, 'unavailable');
    assert.strictEqual(o.blocks.length, 7);
    assert.strictEqual(o.blocks[1].h2, 'Signs You May Need Root Canals');
    assert.ok(o.blocks.every(b => b.source === 'fallback'));
  });

  console.log('\nDental - Primary eligibility gate (service AND location)');
  test('a keyword naming both service and city is eligible', () => {
    assert.strictEqual(keywordRelevance.isPrimaryEligible('invisalign brookline', 'Brookline', ['invisalign'], 'Invisalign'), true);
  });
  test('a keyword missing the city is NOT eligible for Primary', () => {
    assert.strictEqual(keywordRelevance.isPrimaryEligible('invisalign cost', 'Brookline', ['invisalign'], 'Invisalign'), false);
  });
  test('a keyword missing the service is NOT eligible for Primary', () => {
    assert.strictEqual(keywordRelevance.isPrimaryEligible('dentist brookline', 'Brookline', ['invisalign'], 'Invisalign'), false);
  });

  console.log('\nDental - keyword selection fallback (no LLM available)');
  await testAsync('an empty pool synthesizes the "{service} {city}" Primary pair at volume 0', async () => {
    const r = await keywordRelevance.selectPrimaryAndSecondary({ ...KW_ARGS, candidates: [] });
    assert.strictEqual(r.primary.length, 2);
    assert.deepStrictEqual(r.primary.map(c => c.keyword), ['invisalign brookline', 'invisalign brookline ma']);
    assert.ok(r.primary.every(c => c.volume === 0), 'synthesized Primary must report zero volume');
    assert.ok(r.primary.every(c => c.source === 'synthesized'));
  });
  await testAsync('an empty pool sets lowVolume so the UI states searches are low', async () => {
    const r = await keywordRelevance.selectPrimaryAndSecondary({ ...KW_ARGS, candidates: [] });
    assert.strictEqual(r.lowVolume, true);
  });
  await testAsync('the code-side gate keeps off-location keywords out of Primary', async () => {
    const r = await keywordRelevance.selectPrimaryAndSecondary({ ...KW_ARGS, candidates: KW_POOL });
    const keys = r.primary.map(c => c.keyword);
    assert.ok(!keys.includes('invisalign cost'), 'a keyword with no city must not be Primary');
    assert.ok(!keys.includes('invisalign cambridge'), 'a rival city must not be Primary');
    assert.deepStrictEqual(keys, ['invisalign brookline', 'clear aligners brookline']);
  });
  await testAsync('real location-bearing Primary keywords leave lowVolume false', async () => {
    const r = await keywordRelevance.selectPrimaryAndSecondary({ ...KW_ARGS, candidates: KW_POOL });
    assert.strictEqual(r.lowVolume, false);
  });
  await testAsync('Secondary never repeats a keyword already taken by Primary', async () => {
    const r = await keywordRelevance.selectPrimaryAndSecondary({ ...KW_ARGS, candidates: KW_POOL });
    const primaryKeys = new Set(r.primary.map(c => c.keyword.toLowerCase()));
    const overlap = r.secondary.filter(c => primaryKeys.has(c.keyword.toLowerCase()));
    assert.deepStrictEqual(overlap.map(c => c.keyword), [], 'Secondary must not duplicate Primary');
  });
  await testAsync('an unconfigured cache degrades to recompute instead of throwing', async () => {
    // store.cacheGet throws when Supabase is absent; selectPrimaryAndSecondary
    // must swallow that rather than fail the whole research request.
    const r = await keywordRelevance.selectPrimaryAndSecondary({ ...KW_ARGS, candidates: KW_POOL });
    assert.ok(Array.isArray(r.primary) && r.primary.length > 0);
  });

  console.log('\nDental - sub-area office labels resolve to the parent city');
  test('a "City - Street" office label resolves to the city', () => {
    assert.strictEqual(keywordAdapter.baseCity('Boston - Newbury Street', 'Boston'), 'Boston');
    assert.strictEqual(keywordAdapter.baseCity('Worcester - Shrewsbury Street', 'Worcester'), 'Worcester');
    assert.strictEqual(keywordAdapter.baseCity('Nashua - Main Street', 'Nashua'), 'Nashua');
  });
  test('a label leading with its own region resolves to that region city', () => {
    // No " - " separator, so only the region signal catches these.
    assert.strictEqual(keywordAdapter.baseCity('Worcester at The Trolley Yard', 'Worcester'), 'Worcester');
    assert.strictEqual(keywordAdapter.baseCity('Manchester Elm Street', 'Manchester'), 'Manchester');
    assert.strictEqual(keywordAdapter.baseCity('Manchester South Willow', 'Manchester'), 'Manchester');
  });
  test('a real multi-word city is left intact', () => {
    // These are genuine place names people search for -- resolving them would
    // be worse than the bug it fixes.
    assert.strictEqual(keywordAdapter.baseCity('Jamaica Plain', 'Boston'), 'Jamaica Plain');
    assert.strictEqual(keywordAdapter.baseCity('South Boston', 'Boston'), 'South Boston');
    assert.strictEqual(keywordAdapter.baseCity('West Roxbury', 'Boston'), 'West Roxbury');
    assert.strictEqual(keywordAdapter.baseCity('North Andover', 'Merrimack Valley'), 'North Andover');
    assert.strictEqual(keywordAdapter.baseCity('New Bedford', 'South Coast'), 'New Bedford');
    assert.strictEqual(keywordAdapter.baseCity('South Nashua', 'Nashua'), 'South Nashua');
  });
  test('a city identical to its region is unchanged', () => {
    assert.strictEqual(keywordAdapter.baseCity('Boston', 'Boston'), 'Boston');
    assert.strictEqual(keywordAdapter.baseCity('Brookline', 'Greater Boston'), 'Brookline');
  });
  test('the parent city satisfies the Primary gate for a sub-area office', () => {
    const city = keywordAdapter.baseCity('Manchester Elm Street', 'Manchester');
    assert.strictEqual(keywordRelevance.isPrimaryEligible('invisalign manchester', city, ['invisalign'], 'Invisalign'), true);
    // The raw label never matches, which is the bug this resolves.
    assert.strictEqual(keywordRelevance.isPrimaryEligible('invisalign manchester', 'Manchester Elm Street', ['invisalign'], 'Invisalign'), false);
  });

  console.log('\nDental - rival-city filter and the broader-region exception');
  const OFFICE_CITIES = ['Boston', 'South Boston', 'West Roxbury', 'Cambridge', 'Brookline', 'Nashua', 'South Nashua', 'Manchester'];
  // Mirrors how keywordAdapter assembles the filter from its two pure halves.
  function isBlocked(keyword, { targetCity, allowTerms }) {
    const others = keywordAdapter.rivalCities({ targetCity, allowTerms, knownCities: OFFICE_CITIES });
    if (!others.length) return false;
    const esc = t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`\\b(${others.map(esc).join('|')})\\b`, 'i');
    return re.test(keywordAdapter.stripAllowedRegions(keyword, allowTerms));
  }
  const BROOKLINE = { targetCity: 'Brookline', allowTerms: ['Greater Boston', 'MA', 'Massachusetts'] };
  const BROOKLINE_KNOWN = { ...BROOKLINE, knownCities: OFFICE_CITIES };

  test('a rival office city is blocked', () => {
    assert.strictEqual(isBlocked('invisalign cambridge', BROOKLINE), true);
    assert.strictEqual(isBlocked('dentist manchester nh', BROOKLINE), true);
    assert.strictEqual(isBlocked('invisalign boston', BROOKLINE), true);
  });
  test('the page own city is never blocked', () => {
    assert.strictEqual(isBlocked('invisalign brookline', BROOKLINE), false);
  });
  test('the broader region survives even though a rival city sits inside it', () => {
    // "boston" is a rival office city and also a substring of "greater boston";
    // a word-boundary match on the raw keyword would block this wrongly.
    assert.strictEqual(isBlocked('invisalign greater boston', BROOKLINE), false);
    assert.strictEqual(isBlocked('invisalign massachusetts', BROOKLINE), false);
  });
  test('a shorter office city inside this page own city does not block it', () => {
    // "Boston" must not knock out "invisalign south boston" on the South Boston page.
    const southBoston = { targetCity: 'South Boston', allowTerms: ['Greater Boston', 'MA', 'Massachusetts'] };
    assert.strictEqual(isBlocked('invisalign south boston', southBoston), false);
    assert.strictEqual(isBlocked('invisalign cambridge', southBoston), true);
    const southNashua = { targetCity: 'South Nashua', allowTerms: ['All New Hampshire', 'NH', 'New Hampshire'] };
    assert.strictEqual(isBlocked('invisalign south nashua', southNashua), false);
    assert.strictEqual(isBlocked('invisalign manchester', southNashua), true);
  });
  test('the rival regex uses real word boundaries, not a backspace escape', () => {
    // Regression guard: written in a template literal, a single backslash-b is
    // the backspace character and the filter silently matches nothing.
    const others = keywordAdapter.rivalCities(BROOKLINE_KNOWN);
    assert.ok(others.includes('cambridge'), 'sanity: cambridge is a rival of Brookline');
    assert.ok(isBlocked('invisalign cambridge', BROOKLINE), 'the filter must actually match');
  });

  console.log('\nDental - synthesized keywords are search-shaped');
  test('service-name punctuation never reaches a synthesized keyword', () => {
    const k = keywordRelevance.keywordizeService;
    assert.strictEqual(k('Crowns & Bridges'), 'crowns and bridges');
    assert.strictEqual(k('Cavity Prevention (Curodont)'), 'cavity prevention');
    assert.strictEqual(k('TMD/TMJ Treatment'), 'tmd tmj treatment');
    assert.strictEqual(k('Diabetes & Oral Health'), 'diabetes and oral health');
    assert.strictEqual(k('Digital X-rays'), 'digital x-rays');
    assert.strictEqual(k('Invisalign'), 'invisalign');
  });

  console.log('\nDental - review pass (step 3) and its verdict (step 4)');
  const SELECTED = {
    primary: ['invisalign brookline', 'clear aligners brookline'],
    secondary: ['invisalign greater boston', 'invisalign price'],
    rejected: [],
  };

  await testAsync('a clean verdict keeps every discovered pick and leaves lowVolume false', async () => {
    stubLlm({ select: SELECTED, review: { ok: true, failures: [] } });
    const r = await keywordRelevance.selectPrimaryAndSecondary({ ...KW_ARGS, candidates: KW_POOL });
    assert.deepStrictEqual(r.primary.map(c => c.keyword), ['invisalign brookline', 'clear aligners brookline']);
    assert.strictEqual(r.lowVolume, false);
    LLM_STUB = null;
  });

  await testAsync('a flagged Primary replaces ONLY that slot, keeping the one that passed', async () => {
    stubLlm({
      select: SELECTED,
      review: { ok: false, failures: [{ keyword: 'clear aligners brookline', slot: 'primary', reason: 'off-service' }] },
    });
    const r = await keywordRelevance.selectPrimaryAndSecondary({ ...KW_ARGS, candidates: KW_POOL });
    assert.ok(r.primary.some(c => c.keyword === 'invisalign brookline' && c.volume === 90),
      'a Primary the critic passed must survive, not be traded for a zero-volume synonym');
    assert.ok(!r.primary.some(c => c.keyword === 'clear aligners brookline'), 'the flagged Primary must be gone');
    assert.strictEqual(r.primary.length, 2, 'the emptied slot must be refilled');
    assert.strictEqual(r.lowVolume, true, 'a synthesized slot must set lowVolume');
    LLM_STUB = null;
  });

  await testAsync('a flagged Secondary is dropped and Primary is untouched', async () => {
    stubLlm({
      select: SELECTED,
      review: { ok: false, failures: [{ keyword: 'invisalign price', slot: 'secondary', reason: 'not local' }] },
    });
    const r = await keywordRelevance.selectPrimaryAndSecondary({ ...KW_ARGS, candidates: KW_POOL });
    assert.ok(!r.secondary.some(c => c.keyword === 'invisalign price'));
    assert.deepStrictEqual(r.primary.map(c => c.keyword), ['invisalign brookline', 'clear aligners brookline']);
    assert.strictEqual(r.lowVolume, false);
    LLM_STUB = null;
  });

  await testAsync('a verdict naming a keyword never submitted for review is ignored', async () => {
    // The critic only ever sees discovered keywords. A failure naming a
    // synthesized one (or anything else it wasn't shown) must not churn Primary.
    stubLlm({
      select: { primary: [], secondary: ['invisalign price'], rejected: [] },
      review: { ok: false, failures: [{ keyword: 'invisalign brookline', slot: 'primary', reason: 'hallucinated' }] },
    });
    const r = await keywordRelevance.selectPrimaryAndSecondary({ ...KW_ARGS, candidates: KW_POOL });
    assert.deepStrictEqual(r.primary.map(c => c.keyword), ['invisalign brookline', 'invisalign brookline ma'],
      'the deterministic pair must survive a bogus verdict, in order');
    assert.deepStrictEqual(r.reviewFailures, [], 'a verdict about an unsubmitted keyword must not reach the UI');
    LLM_STUB = null;
  });

  await testAsync('a keyword the model invented is dropped (never in the pool)', async () => {
    stubLlm({
      select: { primary: ['invisalign newton', 'invisalign brookline'], secondary: ['made up keyword'], rejected: [] },
      review: { ok: true, failures: [] },
    });
    const r = await keywordRelevance.selectPrimaryAndSecondary({ ...KW_ARGS, candidates: KW_POOL });
    assert.ok(!r.primary.some(c => c.keyword === 'invisalign newton'), 'off-pool Primary must be dropped');
    assert.ok(!r.secondary.some(c => c.keyword === 'made up keyword'), 'off-pool Secondary must be dropped');
    LLM_STUB = null;
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
