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

// Drives the passes independently: `select` answers the selection prompt,
// `review` the critic prompt, `synth` the synthesized-keyword prompt. `synth`
// defaults to "nothing usable", which is what makes the synthesized Primary
// the deterministic code-side pair in every test that doesn't opt in.
function stubLlm({ select, review, synth }) {
  LLM_STUB = () => ({
    model: 'claude-sonnet-5',
    provider: 'anthropic',
    chat: {
      completions: {
        create: async ({ messages }) => {
          const prompt = messages[0].content;
          const answer = prompt.includes('You are reviewing a finished keyword selection') ? review
            : prompt.includes('You write the search phrases') ? (synth || { keywords: [] })
              : select;
          return { choices: [{ message: { content: JSON.stringify(answer) } }] };
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
const seed = require('../seed');
const keywordAdapter = require('../keywordAdapter');
const brief = require('../brief');
const verticals = require('../verticals');
const cbhContract = require('../cbhContract');
const cbhQc = require('../cbhQc');
const cbhCompose = require('../cbhCompose');
const cbhWriter = require('../cbhWriter');
const cbhFixture = require('./cbhFixture');
const cbhBrief = require('../cbhBrief');
const cbhSources = require('../cbhFallbackSources');
const briefWizard = require('../briefWizard');

// The keyword-presence check carries its own threshold in its id, so it is
// derived from config rather than hardcoded here.
// Threshold-carrying ids are derived from config, never hardcoded.
// Stable check id; the threshold rides in the check's `name` (asserted below),
// so retuning the minimum in config cannot rename the check out from under a
// saved page's Recheck button.
const FAQ_LOCALIZATION_CHECK = 'city_in_faq';
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
  // In range (150-160) AND closing on a call to action, because those are two
  // separate gates now.
  const metaDescription = 'Get professional teeth whitening in Quincy, MA, with both in-office and '
    + 'take-home options and your insurance filed for you. Book a visit with our team today.';
  compose.mergeDentalL3(scaffold, {
    // 90-110 characters: one sentence with the outcome and city, then the step.
    heroIntro: 'Brighten your smile with professional teeth whitening in Quincy, MA. Book a visit with us today.',
    metaDescription,
    // Six planned blocks plus the fixed "Why Choose" closer — the 7-8 stack
    // every page carries (dentalOutline plans the first six or seven).
    educationalBody: [
      { h2: 'What Is Teeth Whitening?', html: '<p>Teeth whitening in Quincy is a cosmetic procedure that lightens stains.</p>' },
      { h2: 'Benefits of Teeth Whitening', html: '<p>A brighter smile boosts confidence for Quincy patients.</p>' },
      { h2: 'What to Expect During Teeth Whitening', html: '<p>Sessions run about 60 minutes chairside.</p>' },
      { h2: 'Who Is a Good Candidate for Teeth Whitening?', html: '<p>Healthy gums and enamel make teeth whitening a good fit.</p>' },
      { h2: 'Types and Options for Teeth Whitening', html: '<p>In-office trays and take-home kits are both available.</p>' },
      { h2: 'Is Teeth Whitening Safe?', html: '<p>Professional whitening is safe when a dentist supervises it.</p>' },
      { h2: 'Why Choose Gentle Dental for Teeth Whitening in Quincy, MA?', html: '<p>Our Quincy team walks you through both options and files your insurance for you.</p>' },
    ],
    // Seven questions, three of them localized the way the brief asks: the
    // city rides on what the OFFICE does (options, booking, insurance), never
    // on the universal ones about pain, safety or how long it takes.
    faqs: [
      { q: 'Which whitening options are available at your Quincy office?', a: 'In-office trays and take-home kits.' },
      { q: 'Can I book teeth whitening in Quincy before a weekend?', a: 'Yes, ask our team for the next open slot.' },
      { q: 'Does your Quincy office file whitening claims with insurance?', a: 'We file for you where a plan contributes.' },
      { q: 'How long does teeth whitening take?', a: 'Most patients finish in a single visit.' },
      { q: 'Is teeth whitening safe?', a: 'Yes, professional whitening is safe under a dentist’s care.' },
      { q: 'How much does teeth whitening cost?', a: 'Cost varies by case; ask our team for a quote.' },
      { q: 'Will whitening work on crowns?', a: 'Whitening does not lighten crowns or veneers.' },
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
test(`fewer than ${config.dental.faqs.min} FAQs is a Critical failure`, () => {
  const layers = dentalLayers();
  const scaffold = dentalScaffoldWithContent();
  scaffold.sections.faq.items = scaffold.sections.faq.items.slice(0, 2);
  scaffold.schema = schemaGenerator.generateDentalSchema({ scaffold, client: layers.client, location: layers.location, service: layers.service });
  const qc = qaEngine.runDentalQC(scaffold);
  assert.ok(qc.checks.find(c => c.name === `faq_count_min_${config.dental.faqs.min}` && !c.pass));
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
  const chained = qaEngine.recheckDental(scaffold, 'faq_count', first.checks);
  assert.strictEqual(chained.checks.find(c => c.id === 'meta_description_length').pass, true,
    'chaining keeps the first fix');
  assert.strictEqual(chained.checks.find(c => c.id === 'faq_count').pass, true);

  // Against the stale snapshot instead, the first fix is silently dropped —
  // which is exactly what the client must never do.
  const raced = qaEngine.recheckDental(scaffold, 'faq_count', stale.checks);
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

console.log('\nDental — the fixed "Why Choose" closing block');
test('the closer names the practice, the service and the city', () => {
  assert.strictEqual(
    dentalOutline.brandBlockHeading({
      brandName: 'Gentle Dental',
      service: { name: 'Teeth Whitening' },
      location: { city: 'Boston', state_abbreviation: 'MA' },
    }),
    'Why Choose Gentle Dental for Teeth Whitening in Boston, MA?');
});
test('an office with its own brand is never called Gentle Dental in the closer', () => {
  // The Newbury Street office trades as Newbury Dental Associates.
  assert.strictEqual(
    dentalOutline.brandBlockHeading({
      brandName: 'Newbury Dental Associates',
      service: { name: 'Veneers' },
      location: { city: 'Boston', state_abbreviation: 'MA' },
    }),
    'Why Choose Newbury Dental Associates for Veneers in Boston, MA?');
});
test('the closer is appended last, tagged brand, and never appended twice', () => {
  const planned = dentalOutline.fallbackOutline(OUTLINE_CTX);
  const ctx = { service: { name: 'Teeth Whitening' }, location: { city: 'Quincy', state_abbreviation: 'MA' }, brandName: 'Gentle Dental' };
  const withCloser = dentalOutline.withBrandBlock(planned, ctx);

  assert.strictEqual(withCloser.blocks.length, planned.blocks.length + 1);
  const last = withCloser.blocks[withCloser.blocks.length - 1];
  assert.strictEqual(last.h2, 'Why Choose Gentle Dental for Teeth Whitening in Quincy, MA?');
  assert.strictEqual(last.source, 'brand');
  assert.strictEqual(last.paragraphs, config.dental.brandBlock.paragraphs);

  // A cached outline re-read on a later run must not collect a second closer.
  assert.strictEqual(dentalOutline.withBrandBlock(withCloser, ctx).blocks.length, withCloser.blocks.length);
});
test('the planned count and the page count stay one apart', () => {
  // qaEngine gates the TOTAL; dentalOutline plans everything except the closer.
  // Retuning one without the other is what makes a page fail its own gate.
  assert.strictEqual(config.dental.blocks.min, config.dental.plannedBlocks.min + 1);
  assert.strictEqual(config.dental.blocks.max, config.dental.plannedBlocks.max + 1);
});
test('a scraped "Why Choose Us" heading is still rejected from the planned stack', () => {
  // The closer is added in code; a competitor's brand furniture must not
  // become a second one.
  const o = dentalOutline.normalizeOutline({
    blocks: [
      { h2: 'Why Choose Us for Teeth Whitening', paragraphs: 2 },
      { h2: 'What Is Teeth Whitening?', paragraphs: 2 },
    ],
  }, OUTLINE_CTX);
  assert.ok(!o.blocks.some(b => /^why choose/i.test(b.h2)));
});

console.log('\nDental — readability + block-count QC gates');
test('a full stack passes the H2 count gate, a 3-block one fails it', () => {
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
  // The fixed closer is written to the same per-paragraph budget as any other
  // block, and sits on TOP of the planner's paragraph total. The hero intro is
  // budgeted in characters, so it enters the word arithmetic at ~7 chars/word
  // — the same conversion the writer prompt quotes.
  const brandParas = d.brandBlock.paragraphs;
  const heroWords = (chars) => Math.round(chars / 7);
  const thinnest = heroWords(d.heroIntro.minChars)
    + (totalParas(d.plannedBlocks.min, 1) + brandParas) * d.paragraphWords.min
    + d.faqs.min * (8 + 25);
  const fattest = heroWords(d.heroIntro.maxChars)
    + (totalParas(d.plannedBlocks.max, d.paragraphsPerBlock.max) + brandParas) * d.paragraphWords.max
    + d.faqs.max * (8 + d.faqAnswerMaxWords);
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

test('re-seeding preserves hand-entered NAP', () => {
  // seedGentleDental replaceAll-ed locations, which wiped the address, phone
  // and hours the SEO team enters by hand (the seed ships those blank on
  // purpose). That made re-seeding to pick up a service change cost the whole
  // NAP effort -- and re-seeding is the ONLY way a taxonomy change reaches the
  // dropdown, so the two were in direct conflict.
  const seeded = {
    id: 'dloc_ma-quincy', city: 'Quincy', region: 'South Shore',
    street_address: '', phone_number: '', hours_by_day: {}, nearby_areas: [],
    brand_name: null, nap_todo: ['street_address', 'phone_number'],
  };
  const stored = {
    id: 'dloc_ma-quincy', city: 'Quincy', region: 'South Shore',
    street_address: '123 Hancock St', phone_number: '617-555-0100',
    hours_by_day: { mon: '8-5' }, nearby_areas: ['Braintree'],
    brand_name: null, nap_todo: [],
  };
  const merged = seed.mergeLocation(seeded, stored);
  assert.strictEqual(merged.street_address, '123 Hancock St');
  assert.strictEqual(merged.phone_number, '617-555-0100');
  assert.deepStrictEqual(merged.hours_by_day, { mon: '8-5' });
  assert.deepStrictEqual(merged.nearby_areas, ['Braintree']);
  assert.deepStrictEqual(merged.nap_todo, [], 'a completed NAP checklist must not be reset');
});
test('re-seeding still applies seeded identity and brand overrides', () => {
  // The point of re-seeding is to pick up changes, so anything the team has
  // NOT populated must take the seeded value.
  const seeded = { id: 'x', city: 'Boston', brand_name: 'Newbury Dental Associates', street_address: '' };
  const merged = seed.mergeLocation(seeded, { id: 'x', city: 'Stale', brand_name: null, street_address: '' });
  assert.strictEqual(merged.brand_name, 'Newbury Dental Associates');
  assert.strictEqual(merged.city, 'Boston', 'identity/geo always comes from the seed');
});
test('a location with nothing stored seeds unchanged', () => {
  const seeded = { id: 'new', city: 'Methuen', street_address: '' };
  assert.deepStrictEqual(seed.mergeLocation(seeded, null), seeded);
});
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
    { q: 'Can I book a whitening visit at your Quincy practice on a Saturday?', a: 'Ask our team for the next open slot.' },
    { q: 'Does whitening hurt?', a: 'Some brief sensitivity is normal.' },
    { q: 'Will insurance cover it?', a: 'Whitening is cosmetic, so usually not.' },
  ]), FAQ_LOCALIZATION_CHECK);
  assert.strictEqual(check.pass, true, check.detail);
});
test('hitting the count by localizing universal questions is caught', () => {
  // Exactly the trade a bare count invites: cities bolted onto questions whose
  // answers do not change by city.
  const scaffold = faqScaffold([
    { q: 'Does teeth whitening hurt in Quincy?', a: 'Some brief sensitivity is normal.' },
    { q: 'Is teeth whitening safe for me in Quincy?', a: 'Yes, under a dentist.' },
    { q: 'How long does teeth whitening take in Quincy?', a: 'About an hour.' },
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
  const brief = contentGenerator.DENTAL_SECTION_BRIEFS.faqs('dental');
  assert.ok(brief.includes('LOCALIZING THE FAQ'), 'the brief must carry the rule');
  assert.ok(brief.includes('Does sedation dentistry hurt in Methuen?'), 'the BAD pair must be shown, not described');
  assert.ok(brief.includes('Do you offer IV sedation at your Methuen practice?'), 'the GOOD pair too');
  assert.ok(!/gentle dental/i.test(brief), 'the worked example must not hardcode one office brand');
});

console.log('\nDental - the meta description closes on a call to action');
test('a description that ends on a next step passes; one that trails off does not', () => {
  const withCta = dentalScaffoldWithContent();
  const cta = qaEngine.runDentalQC(withCta).checks.find(c => c.id === 'meta_description_ends_with_cta');
  assert.strictEqual(cta.pass, true, cta.detail);

  const without = dentalScaffoldWithContent();
  without.meta.metaDescription = 'Professional teeth whitening in Quincy, MA lifts everyday stains from '
    + 'coffee and tea, using in-office trays or take-home kits fitted to your teeth by our dentists.';
  const failing = qaEngine.runDentalQC(without).checks.find(c => c.id === 'meta_description_ends_with_cta');
  assert.strictEqual(failing.pass, false, failing.detail);
  assert.strictEqual(failing.severity, 'Major');
});
test('the ask has to be the CLOSE, not a mention buried mid-description', () => {
  // "book" appears, but the snippet ends on a clinical fact, so the reader is
  // left without a next step — which is the whole point of the gate.
  const scaffold = dentalScaffoldWithContent();
  scaffold.meta.metaDescription = 'Book teeth whitening in Quincy, MA. Results usually last about a year '
    + 'with good home care, and sensitivity settles within a day or two for most patients.';
  const check = qaEngine.runDentalQC(scaffold).checks.find(c => c.id === 'meta_description_ends_with_cta');
  assert.strictEqual(check.pass, false, check.detail);
});
test('a description that merely describes booking is not an ask', () => {
  assert.strictEqual(text.endsWithCta('Our team schedules same-day visits for urgent care.'), false);
  assert.strictEqual(text.endsWithCta('Call our Quincy team to schedule.'), true);
  assert.strictEqual(text.endsWithCta('Request an appointment online today.'), true);
});
test('trimming an over-long description keeps the closing ask', () => {
  // The failure this guards: the ordinary trim drops whole trailing sentences,
  // and the ask is now always the last one. This is the shape a real overshoot
  // takes — a description a little over the window, closing on its CTA.
  const long = 'Professional teeth whitening in Quincy, MA lifts everyday stains from coffee, tea '
    + 'and red wine, with in-office and take-home options. Book a visit with our team today.';
  assert.ok(long.length > config.dental.metaDescription.max, 'the fixture has to be over the window');

  const out = contentGenerator.normalizeMetaDescriptionLength(long);
  assert.ok(out.length <= config.dental.metaDescription.max, `${out.length} chars must fit the snippet`);
  assert.ok(out.length >= config.dental.metaDescription.min, `${out.length} chars is below the floor`);
  assert.ok(out.endsWith('Book a visit with our team today.'), `the ask must survive the trim, got ${JSON.stringify(out)}`);
});
test('a trim never hands back a bare verb as the ask', () => {
  // A word cut that lands just inside the closing sentence used to leave
  // "... insurance for you. Book." — which satisfies every CTA test and reads
  // as a truncation. Here nothing fits 150-160 with the ask attached, so the
  // net hands back readable copy that is slightly short (the length gate says
  // by how much, and a reviewer adds a clause) instead of a broken snippet.
  const long = 'Professional teeth whitening in Quincy, MA lifts stains from coffee and tea. '
    + 'We fit take-home kits to your own teeth and file your insurance for you. Book a visit today.';
  const out = contentGenerator.normalizeMetaDescriptionLength(long);
  assert.ok(out.length <= config.dental.metaDescription.max, `${out.length} chars must fit the snippet`);
  assert.ok(/[.!?]$/.test(out), 'it still has to end as a finished sentence');
  assert.ok(!/\.\s*(Book|Call|Schedule|Visit|Request)\.$/.test(out), `a bare verb is not an ask: ${JSON.stringify(out)}`);
  assert.ok(out.endsWith('Book a visit today.'), out);
});

console.log('\nDental - the hero intro is one line, measured in characters');
test('the hero gate accepts the target window and rejects a paragraph', () => {
  const scaffold = dentalScaffoldWithContent();
  const heroCheck = (s) => qaEngine.runDentalQC(s).checks.find(c => c.id === 'hero_intro_length');
  assert.strictEqual(heroCheck(scaffold).pass, true, heroCheck(scaffold).detail);

  const long = dentalScaffoldWithContent();
  long.sections.hero.intro = 'Teeth whitening in Quincy can brighten your smile with safe, professional '
    + 'care close to home, and our team will walk you through the options at your first visit.';
  assert.strictEqual(heroCheck(long).pass, false, 'a two-idea paragraph is over the window');
  assert.strictEqual(heroCheck(long).severity, 'Major');

  const short = dentalScaffoldWithContent();
  short.sections.hero.intro = 'Whiter teeth in Quincy.';
  assert.strictEqual(heroCheck(short).pass, false, 'a bare label wastes the slot');
});
test('the hero window is stated to the writer in the unit the gate measures', () => {
  // Every vertical, not just the default: each ships its own worked example,
  // and one written outside the window teaches the writer to miss it.
  Object.keys(contentGenerator.VERTICALS).forEach((v) => {
    const hero = contentGenerator.DENTAL_SECTION_BRIEFS.heroIntro(v);
    assert.ok(hero.includes('CHARACTERS'), `the ${v} brief has to name the unit`);
    // The worked example must itself be inside the window it teaches.
    const example = /GOOD \(\d+ chars\): "([^"]+)"/.exec(hero.replace(/\n/g, ' '));
    assert.ok(example, `the ${v} brief must show a worked example`);
    const len = example[1].replace(/\s+/g, ' ').length;
    assert.ok(len >= config.dental.heroIntro.minChars && len <= config.dental.heroIntro.maxChars,
      `the ${v} example is ${len} chars, outside the ${config.dental.heroIntro.minChars}-${config.dental.heroIntro.maxChars} window it teaches`);
    // The label is not decorative — a stale hand-typed count would let an
    // out-of-window example pass the check above by lying about its length.
    assert.strictEqual(Number(/GOOD \((\d+) chars\)/.exec(hero)[1]), len,
      `the ${v} example's stated length must be its real length`);
  });
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
  // A brief that names a profession is a FUNCTION of the vertical (a dental
  // page says "dentist", a behavioral-health one says "clinician"); the rest
  // are plain strings. Resolve either shape so the contract is checked the
  // same way regardless.
  const resolve = (b, vertical) => (typeof b === 'function' ? b(vertical) : b);
  ['metaDescription', 'heroIntro', 'educationalBody', 'faqs'].forEach(k => {
    const raw = contentGenerator.DENTAL_SECTION_BRIEFS[k];
    assert.ok(raw, `${k} needs a brief`);
    // Every vertical, not just the default — a new profile that drops one of
    // these sections' structure is exactly what this guards.
    Object.keys(contentGenerator.VERTICALS).forEach(vertical => {
      const brief = resolve(raw, vertical);
      ['Where it appears:', 'Who is reading:', 'Its job:', 'Do NOT:'].forEach(part =>
        assert.ok(brief.includes(part), `${k} brief (${vertical}) is missing "${part}"`));
    });
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

  const meta = contentGenerator.DENTAL_SECTION_BRIEFS.metaDescription('dental');
  const hero = contentGenerator.DENTAL_SECTION_BRIEFS.heroIntro('dental');
  [meta, hero].forEach(brief => assert.ok(/COMMERCIAL/.test(brief), 'both top-of-page briefs are commercial'));
  assert.ok(/next step|book|consultation/i.test(meta), 'the snippet has to move the reader');
  assert.ok(/next step|consultation/i.test(hero), 'so does the hero');

  // The body stays explanatory — the evidence, not the pitch.
  assert.ok(/Do NOT: sell/.test(contentGenerator.DENTAL_SECTION_BRIEFS.educationalBody('dental')),
    'the educational body must still explain rather than sell');
});
test('the hero brief carries the worked good/bad example', () => {
  const hero = contentGenerator.DENTAL_SECTION_BRIEFS.heroIntro('dental');
  assert.ok(/GOOD \(\d+ chars\):/.test(hero), 'the target has to be shown, not described — with its length');
  assert.ok(hero.includes(`${config.dental.heroIntro.minChars}-${config.dental.heroIntro.maxChars} CHARACTERS`),
    'the brief must state the character window the gate enforces');
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
    assert.strictEqual(L.faqs.max, config.dental.faqs.max);
    assert.deepStrictEqual(L.heroIntro, { min: config.dental.heroIntro.minChars, max: config.dental.heroIntro.maxChars });

    // The two character ranges have to agree with the gates that use them —
    // both are shown against their field in the wizard.
    const scaffold = dentalScaffoldWithContent();
    const checks = qaEngine.runDentalQC(scaffold).checks;
    const mdCheck = checks.find(c => c.id === 'meta_description_length');
    assert.ok(mdCheck.detail.includes(`${L.metaDescription.min}-${L.metaDescription.max}`),
      `the length gate reports "${mdCheck.detail}", which must use the same range the UI shows`);
    const heroCheck = checks.find(c => c.id === 'hero_intro_length');
    assert.ok(heroCheck.detail.includes(`${L.heroIntro.min}-${L.heroIntro.max}`),
      `the hero gate reports "${heroCheck.detail}", which must use the same range the UI shows`);
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
  await testAsync('the docx carries real Word heading styles, not bold text that looks like one', async () => {
    // The download is worked on in Word and pasted into a CMS. Only styled
    // headings survive that trip — they drive the navigation pane and a
    // generated table of contents, and paste as <h1>/<h2>/<h3> rather than
    // <p><strong>. Bold coloured runs (what this used to emit) do neither.
    const JSZip = require('jszip');
    const scaffold = dentalScaffoldWithContent();
    scaffold.sections.educationalBody.blocks[0].html = '<p>Body.</p><h3>A Subheading</h3><p>More.</p>';

    const zip = await JSZip.loadAsync(await exporter.toDentalDocxBuffer(scaffold));
    const documentXml = await zip.file('word/document.xml').async('string');
    const stylesXml = await zip.file('word/styles.xml').async('string');

    const used = [...documentXml.matchAll(/w:pStyle w:val="(Heading\d)"/g)].map(m => m[1]);
    const count = (id) => used.filter(s => s === id).length;

    // One H1 (the page's own), one H2 per educational block PLUS the FAQ
    // heading, one H3 per in-block subheading and per FAQ question.
    assert.strictEqual(count('Heading1'), 1, 'the page H1 must be exported as Heading 1');
    assert.strictEqual(count('Heading2'), scaffold.sections.educationalBody.blocks.length + 1,
      'every educational H2, plus the FAQ heading, must be exported as Heading 2');
    assert.strictEqual(count('Heading3'), scaffold.sections.faq.items.length + 1,
      'in-block subheadings and FAQ questions must be exported as Heading 3');

    // Word only treats them as headings if the styles are declared with their
    // built-in names.
    ['Heading 1', 'Heading 2', 'Heading 3'].forEach(name => {
      assert.ok(stylesXml.includes(`w:val="${name}"`), `${name} must be defined in styles.xml`);
    });

    // Document furniture is deliberately NOT a heading: styling "SEO Metadata"
    // as one would put it in the same outline as the page's own H2s.
    const furniture = documentXml.indexOf('SEO Metadata');
    assert.ok(furniture > 0, 'the metadata section is still in the document');
    assert.ok(!documentXml.slice(Math.max(0, furniture - 200), furniture).includes('w:pStyle w:val="Heading'),
      'deliverable furniture must not be exported as a page heading');
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
      brandName: 'Gentle Dental',
    });
    assert.strictEqual(o.competitorQuality, 'unavailable');
    assert.strictEqual(o.blocks.length, config.dental.blocks.max);
    assert.strictEqual(o.blocks[1].h2, 'Signs You May Need Root Canals');
    assert.ok(o.blocks.slice(0, -1).every(b => b.source === 'fallback'));
    // Even with no LLM at all, the page still ends with the fixed closer.
    assert.deepStrictEqual(
      { h2: o.blocks[o.blocks.length - 1].h2, source: o.blocks[o.blocks.length - 1].source },
      { h2: 'Why Choose Gentle Dental for Root Canals in Malden, MA?', source: 'brand' });
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
  await testAsync('an empty pool synthesizes the "{service} in {city}" Primary pair at volume 0', async () => {
    const r = await keywordRelevance.selectPrimaryAndSecondary({ ...KW_ARGS, candidates: [] });
    assert.strictEqual(r.primary.length, 2);
    assert.deepStrictEqual(r.primary.map(c => c.keyword),
      ['invisalign treatment in brookline', 'invisalign treatment in brookline, ma']);
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
    // A trademark sign is not something anyone types into Google.
    assert.strictEqual(k('Invisalign® Treatment'), 'invisalign treatment');
    assert.strictEqual(k('BOTOX® Cosmetic & Injectables'), 'botox cosmetic and injectables');
  });

  // The complaint this guards: a condition-named service ("Anxiety") pasted
  // against a city produced "anxiety anaheim hills", which nobody searches.
  test('a bare condition gains the head noun that makes it a service', () => {
    const p = keywordRelevance.servicePhrase;
    assert.strictEqual(p('Anxiety'), 'anxiety treatment');
    assert.strictEqual(p('ADHD'), 'adhd treatment');
    assert.strictEqual(p('Bipolar disorder'), 'bipolar disorder treatment');
  });
  test('a service name that is already search-shaped is left alone', () => {
    const p = keywordRelevance.servicePhrase;
    // Covers each detection route: an -ing/-ment/-istry/-ist/-ention ending,
    // and the service nouns that have no such ending.
    ['Anxiety Treatment', 'Teeth Whitening', 'Cosmetic Dentistry', 'Orthodontist',
      'Cavity Prevention (Curodont)', 'Psychotherapy', 'Oral Surgery', 'Root Canals',
      'Veneers', 'Dental Implants', 'Smile Makeover', 'Diabetes & Oral Health',
      'Digital X-rays', 'BOTOX® Cosmetic & Injectables'].forEach((name) => {
      assert.strictEqual(p(name), keywordRelevance.keywordizeService(name),
        `"${name}" already names a service — no head noun should be added`);
    });
  });
  test('the synthesized pair reads as a phrase, not a concatenation', () => {
    assert.deepStrictEqual(
      keywordRelevance.deterministicPhrases({ service: 'Anxiety', city: 'Anaheim Hills', state: 'CA' }),
      ['anxiety treatment in anaheim hills', 'anxiety treatment in anaheim hills, ca']);
    // No state on the location record: the second phrase is dropped rather
    // than emitted with a trailing comma.
    assert.deepStrictEqual(
      keywordRelevance.deterministicPhrases({ service: 'Teeth Whitening', city: 'Quincy', state: '' }),
      ['teeth whitening in quincy']);
  });
  await testAsync('the LLM phrase pass degrades to the deterministic pair', async () => {
    // No API key in tests — synthesizePhrases must return the code-side pair
    // rather than throw, which is what keeps Primary filled during an outage.
    const phrases = await keywordRelevance.synthesizePhrases({
      service: 'Anxiety', city: 'Anaheim Hills', state: 'CA', maxPrimary: 2,
    });
    assert.deepStrictEqual(phrases,
      ['anxiety treatment in anaheim hills', 'anxiety treatment in anaheim hills, ca']);
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
    assert.deepStrictEqual(r.primary.map(c => c.keyword),
      ['invisalign treatment in brookline', 'invisalign treatment in brookline, ma'],
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

  console.log('\nBrief - a hand-edited brief cannot instruct the writer to fail QC');
  test('normalizeBrief clamps, filters and de-junks whatever the client sends', () => {
    const b = brief.normalizeBrief({
      primaryKeyword: '  anxiety treatment in anaheim hills ',
      outline: { competitorQuality: 'bogus', blocks: [
        { h2: ' Kept ', paragraphs: 99, source: 'competitor', localize: 'yes' },
        { h2: '   ', paragraphs: 2 },
        { h2: 'Typed by hand', paragraphs: 0, source: 'nonsense' },
      ] },
      faqs: ['A plain string question?', { q: 'From a rival?', source: 'competitor' }, { q: '  ' }],
      wordTarget: { min: 99999, max: 1 },
    });
    assert.strictEqual(b.primaryKeyword, 'anxiety treatment in anaheim hills', 'whitespace is collapsed');
    assert.deepStrictEqual(b.outline.blocks.map(x => x.h2), ['Kept', 'Typed by hand'],
      'a block with no heading is dropped, not written as an empty H2');
    assert.strictEqual(b.outline.blocks[0].paragraphs, config.dental.paragraphsPerBlock.max,
      'a paragraph count above the band is clamped to it');
    assert.strictEqual(b.outline.blocks[1].paragraphs, config.dental.paragraphsPerBlock.min,
      'and one below it is clamped up');
    assert.strictEqual(b.outline.blocks[0].localize, true, 'localize is coerced to a boolean');
    assert.strictEqual(b.outline.blocks[1].source, null,
      'an unrecognised provenance tag becomes none, never a fabricated one');
    assert.strictEqual(b.outline.competitorQuality, 'unavailable', 'an unknown grade falls back');
    assert.deepStrictEqual(b.faqs.map(f => f.q), ['A plain string question?', 'From a rival?'],
      'a bare string is accepted as a question; an empty one is dropped');
    assert.strictEqual(b.faqs[0].source, 'drafted');
    assert.strictEqual(b.faqs[1].source, 'competitor');
  });
  test('the word target cannot be set outside what QC accepts', () => {
    const b = brief.normalizeBrief({ wordTarget: { min: 99999, max: 1 } });
    assert.ok(b.wordTarget.min <= b.wordTarget.max, 'an inverted range is put back in order');
    assert.ok(b.wordTarget.min >= config.dental.pageWords.acceptMin
      && b.wordTarget.max <= config.dental.pageWords.acceptMax,
      'the target must sit inside the range body_word_count will accept');
  });
  test('only real questions reach the reviewer', () => {
    ['How soon can I be seen?', 'What is anxiety treatment?', 'Does insurance cover this?']
      .forEach(q => assert.ok(brief.usableQuestion(q), `"${q}" is a question`));
    // Scraped nav/CTA furniture, which is most of what a competitor page yields.
    ['Our Team', 'Contact us today', 'Insurance We Accept', 'Book', '?', '']
      .forEach(q => assert.ok(!brief.usableQuestion(q), `"${q}" is not a question`));
  });
  test('drafted FAQs lead with what competitors answer, then top up to the QC floor', () => {
    const drafted = brief.draftFaqs({
      competitorFaqs: ['How long does treatment take?', 'Our Team', 'Is it confidential?'],
      service: { name: 'Anxiety Treatment' },
      city: 'Anaheim Hills',
    });
    assert.deepStrictEqual(drafted.slice(0, 2).map(f => f.q),
      ['How long does treatment take?', 'Is it confidential?'],
      'real competitor questions come first, in order, with the furniture filtered out');
    assert.ok(drafted.every(f => f.source === 'competitor' || f.source === 'drafted'));
    assert.strictEqual(drafted.length, config.dental.faqs.min,
      'topped up to the MINIMUM only - padding to the maximum buries the real ones');
    assert.strictEqual(new Set(drafted.map(f => f.q.toLowerCase())).size, drafted.length, 'no duplicates');
  });

  console.log('\nBrief - the writer is bound by the brief, and un-briefed pages are unchanged');
  test('a brief fixes the FAQ questions verbatim and carries its own word target', () => {
    const base = {
      service: { name: 'Anxiety Treatment', category: 'condition' },
      location: { city: 'Anaheim Hills', state_abbreviation: 'CA', location_name: 'Anaheim Hills' },
      primaryKeyword: 'anxiety treatment in anaheim hills',
      secondaryKeywords: [],
      outline: { blocks: [{ h2: 'What Is It?', paragraphs: 2 }] },
      competitorFaqs: ['A competitor topic?'],
      brandName: 'Clear Behavioral Health',
    };
    const briefed = contentGenerator.buildDentalPrompt({
      ...base,
      brief: { faqs: [{ q: 'How soon can I be seen?' }, { q: 'Does insurance cover it?' }], wordTarget: { min: 800, max: 900 } },
    }).user;
    assert.ok(/THE FAQ QUESTIONS ARE FIXED/.test(briefed), 'the questions are a contract, not a suggestion');
    assert.ok(/1\. How soon can I be seen\?/.test(briefed) && /2\. Does insurance cover it\?/.test(briefed),
      'each approved question is listed, in order');
    assert.ok(!/A competitor topic\?/.test(briefed),
      'a second, looser list of topics must not sit beside the fixed one');
    assert.ok(/land between 800 and 900 words/.test(briefed), "the brief's word target is what the writer is given");
  });
  test('a brief with fewer FAQs than the localization floor cannot ask for the impossible', () => {
    const p = contentGenerator.buildDentalPrompt({
      service: { name: 'Anxiety Treatment', category: 'condition' },
      location: { city: 'Anaheim Hills', state_abbreviation: 'CA', location_name: 'Anaheim Hills' },
      primaryKeyword: 'anxiety treatment in anaheim hills', secondaryKeywords: [],
      outline: { blocks: [{ h2: 'X', paragraphs: 2 }] }, competitorFaqs: [], brandName: 'CBH',
      brief: { faqs: [{ q: 'Only one?' }], wordTarget: { min: 700, max: 1050 } },
    }).user;
    const asked = Number(/At least\s+(\d+) of your ANSWERS/.exec(p.replace(/\s+/g, ' '))[1]);
    assert.ok(asked <= 1, `cannot require ${asked} localized answers from 1 question`);
  });
  test('no brief means the writer is instructed exactly as it was before briefs existed', () => {
    const p = contentGenerator.buildDentalPrompt({
      service: { name: 'Invisalign', category: 'Cosmetic' },
      location: { city: 'Brookline', state_abbreviation: 'MA', location_name: 'Brookline' },
      primaryKeyword: 'invisalign brookline', secondaryKeywords: [],
      outline: { blocks: [{ h2: 'X', paragraphs: 2 }] },
      competitorFaqs: ['A competitor topic?'], brandName: 'Gentle Dental',
    }).user;
    assert.ok(new RegExp(`Write ${config.dental.faqs.min}-${config.dental.faqs.max} Q&As`).test(p),
      'the writer still chooses its own questions');
    assert.ok(/COMPETITOR FAQ TOPICS/.test(p), 'competitor questions are still topic inspiration');
    assert.ok(!/THE FAQ QUESTIONS ARE FIXED/.test(p), 'and are not a contract');
    assert.ok(new RegExp(`land between ${config.dental.pageWords.targetMin} and ${config.dental.pageWords.targetMax} words`).test(p),
      'the config word target still applies');
  });
  test('a page is written in its own vertical, not always in dental', () => {
    const args = {
      service: { name: 'Anxiety Treatment', category: 'condition' },
      location: { city: 'Anaheim Hills', state_abbreviation: 'CA', location_name: 'Anaheim Hills' },
      primaryKeyword: 'anxiety treatment in anaheim hills', secondaryKeywords: [],
      outline: { blocks: [{ h2: 'X', paragraphs: 2, source: 'brand' }] },
      competitorFaqs: [], brandName: 'Clear Behavioral Health',
    };
    const bh = contentGenerator.buildDentalPrompt({ ...args, vertical: 'behavioralHealth' });
    assert.ok(/a behavioral health provider in California/.test(bh.system),
      'a behavioral-health page must not be told it writes for a dental practice');
    assert.ok(/clinician/.test(bh.system + bh.user), 'and must name the right profession');

    // The default is unchanged, so Gentle Dental reads exactly as before.
    const dental = contentGenerator.buildDentalPrompt(args);
    assert.ok(/a dental practice in Massachusetts and New Hampshire/.test(dental.system));
    assert.strictEqual(dental.system, contentGenerator.buildDentalPrompt({ ...args, vertical: 'dental' }).system,
      'omitting the vertical must be identical to naming the default');
  });


  console.log('\nVerticals - research must not be run in the wrong industry');
  test('a dental seed is still qualified, exactly as before', () => {
    const GD = 'client_gentle_dental';
    // These names are why the qualifier exists: bare, they return construction
    // and orthopedic results instead of dental competitors.
    assert.strictEqual(keywordAdapter.disambiguate('Sealants Quincy MA', GD), 'Dental Sealants Quincy MA');
    assert.strictEqual(keywordAdapter.disambiguate('Braces Derry NH', GD), 'Dental Braces Derry NH');
    // Already qualified, so it is left alone rather than doubled.
    assert.strictEqual(keywordAdapter.disambiguate('Dental Crowns Malden MA', GD), 'Dental Crowns Malden MA');
  });
  test('a behavioral-health seed is never prefixed with a dental word', () => {
    const CBH = 'client_clear_behavioral_health';
    // The regression this guards: "Dental Anxiety Anaheim Hills" researched the
    // wrong industry entirely and returned dental keywords for a psychiatry page.
    ['Anxiety Anaheim Hills CA', 'Xanax Addiction Gardena CA', 'Teen Depression Pasadena CA']
      .forEach(seed => assert.strictEqual(keywordAdapter.disambiguate(seed, CBH), seed,
        `"${seed}" must reach the SERP untouched`));
  });
  test('an unregistered client gets no qualifier rather than a guessed one', () => {
    // Injecting the wrong industry word silently researches the wrong industry,
    // so "unknown" has to mean "add nothing", never "assume dental".
    assert.strictEqual(keywordAdapter.disambiguate('Anxiety Anaheim Hills CA', 'client_nope'),
      'Anxiety Anaheim Hills CA');
    assert.strictEqual(keywordAdapter.disambiguate('Anxiety Anaheim Hills CA', undefined),
      'Anxiety Anaheim Hills CA');
    assert.strictEqual(verticals.verticalFor('client_nope'), null);
  });
  test('the research vertical and the writing vertical cannot disagree', () => {
    // One client, two consumers: the SERP seed and the writer prompt. Were
    // these to come from separate tables, a client could be researched as
    // dental and written as behavioral health.
    Object.entries(verticals.VERTICAL_BY_CLIENT).forEach(([clientId, vertical]) => {
      assert.strictEqual(briefWizard.verticalFor(clientId), vertical,
        `${clientId} must be written in the vertical it is researched in`);
      assert.ok(Object.prototype.hasOwnProperty.call(verticals.SEED_QUALIFIER, vertical),
        `${vertical} needs a seed-qualifier entry (null is a valid answer)`);
      assert.ok(contentGenerator.VERTICALS[vertical], `${vertical} needs a writer profile`);
    });
  });


  console.log('\nRelevance terms - a client with no curated map still gets a topical filter');
  test('terms are derived from the service name when the map has no entry', () => {
    const t = (name) => keywordUniverseMap.relevanceTermsForService('not-in-map', name);
    assert.deepStrictEqual(t('Anxiety'), ['anxiety']);
    // The audience word is not the topic: keeping "teen" would admit "teen dentist".
    assert.deepStrictEqual(t('Teen Depression'), ['depression']);
    // The substance is the topic; "addiction" alone would pool every other addiction.
    assert.deepStrictEqual(t('Xanax Addiction'), ['xanax']);
    // A parenthetical is an acronym, not a topic.
    assert.deepStrictEqual(t('Outpatient Mental Health Treatment (IOP)'), ['mental']);
  });
  test('an entirely generic name still gets a filter rather than none', () => {
    // "Family Therapy" is all generic words. A loose filter beats null, which
    // the live-pool check reads as "no topical filter at all".
    const terms = keywordUniverseMap.relevanceTermsForService('not-in-map', 'Family Therapy');
    assert.ok(Array.isArray(terms) && terms.length, 'must never fall back to null');
  });
  test('a curated entry always wins over the derived one', () => {
    // Derivation cannot know that whitening keywords also say "bleach".
    assert.deepStrictEqual(
      keywordUniverseMap.relevanceTermsForService('teeth-whitening', 'Teeth Whitening'),
      ['whiten', 'bleach']);
  });
  test('the derived filter removes the pool that was reported as irrelevant', () => {
    // Verbatim from the report: an "Anxiety in Anaheim Hills" pool made almost
    // entirely of veterinary and dental keywords, because no filter ran at all.
    const reported = [
      'anaheim hills pet clinic', 'orange county emergency pet clinic', 'route 66 emergency vet',
      'anaheim hills dentist', 'mission hills pediatric dentist', 'veg anaheim hills',
      'awesome dental anaheim', 'twilight dentistry', 'christian counseling orange county',
      'anxiety therapist anaheim hills',
    ];
    const terms = keywordUniverseMap.relevanceTermsForService('not-in-map', 'Anxiety');
    const kept = reported.filter(k => terms.some(t => k.includes(t)));
    assert.deepStrictEqual(kept, ['anxiety therapist anaheim hills'],
      'only the keyword actually about this page survives');
  });


  console.log('\nCBH - the contract is satisfiable, and every gate bites');

  // Builds the fixture page, optionally mutating the L3 first.
  const cbhPage = (mutate) => {
    const l3 = cbhFixture.passingL3();
    if (mutate) mutate(l3);
    const page = cbhCompose.mergeCbhL3(cbhFixture.scaffold(), l3);
    return cbhCompose.applyProvenance(page, cbhFixture.passingProvenance());
  };
  const cbhFails = (page) => cbhQc.runCbhQc(page).checks.filter(c => !c.pass).map(c => c.id);

  test('a page written to the guidelines passes every gate', () => {
    const r = cbhQc.runCbhQc(cbhPage());
    assert.deepStrictEqual(r.checks.filter(c => !c.pass).map(c => c.id), [],
      'the contract must be satisfiable - a limit no page can meet is a broken contract, not a strict one');
    assert.strictEqual(r.verdict, 'PASS');
  });

  test('the fixed headings survive whatever the writer returns', () => {
    // The guidelines say "use this H2 exactly as written", so the headings are
    // never the model's to produce. Merging output that tries to reword them
    // must change nothing.
    const page = cbhPage();
    const merged = cbhCompose.mergeCbhL3(page, {
      approach: { paragraphs: ['x'], philosophy: ['y'], therapies: ['z'] },
      insurance: 'a', uvp: 'b', service: 'c',
      educational: { paragraphs: ['d'], h3s: [{ heading: 'Rewritten', lines: ['e'] }] },
    });
    assert.strictEqual(merged.sections.insurance.heading, cbhContract.FIXED_HEADINGS.insurance);
    assert.strictEqual(merged.sections.uvp.heading, cbhContract.FIXED_HEADINGS.uvp);
    assert.strictEqual(merged.sections.approach.philosophy.heading, cbhContract.FIXED_HEADINGS.approachPhilosophy);
    assert.strictEqual(merged.sections.approach.therapies.heading, cbhContract.FIXED_HEADINGS.approachTherapies);
  });

  test('the brand suffix is appended once and excluded from the length count', () => {
    const page = cbhPage(l3 => { l3.metaTitle = 'Anxiety Treatment in Anaheim Hills for Lasting Relief'; });
    assert.ok(page.meta.fullTitle.endsWith(cbhContract.TITLE_SUFFIX), 'the shipped title carries the suffix');
    assert.ok(!page.meta.title.includes(cbhContract.BRAND), 'the counted title does not');
    // Idempotent: a reviewer pasting a title that already has the suffix must
    // not end up with it twice.
    const twice = cbhCompose.mergeCbhL3(cbhFixture.scaffold(), { metaTitle: page.meta.fullTitle });
    assert.strictEqual(twice.meta.fullTitle, page.meta.fullTitle);
  });

  test('a meta title inside 50-60 passes and one outside it fails', () => {
    assert.ok(!cbhFails(cbhPage()).includes('meta_title_length'));
    assert.ok(cbhFails(cbhPage(l3 => { l3.metaTitle = 'Anxiety Treatment'; })).includes('meta_title_length'),
      'a 17-character title is under the floor');
    assert.ok(cbhFails(cbhPage(l3 => { l3.metaTitle = 'A'.repeat(61); })).includes('meta_title_length'));
  });

  test('the meta description needs every keyword word, in any order, plus a CTA', () => {
    // The guidelines say explicitly that the words need not be in order.
    const reordered = cbhPage(l3 => {
      l3.metaDescription = 'In Anaheim Hills, treatment for anxiety is delivered by licensed clinicians '
        + 'who tailor each plan to the person in front of them. Schedule a consultation today.';
    });
    assert.ok(!cbhFails(reordered).includes('meta_description_has_keyword_words'),
      'out-of-order keyword words must satisfy the rule');
    const noCta = cbhPage(l3 => {
      l3.metaDescription = 'Evidence-based anxiety treatment in Anaheim Hills from licensed clinicians '
        + 'who tailor care to your needs, your goals and the pace that actually suits you.';
    });
    assert.ok(cbhFails(noCta).includes('meta_description_has_cta'));
  });

  test('the H1 must carry the keyword and the city, within 70 characters', () => {
    assert.ok(cbhFails(cbhPage(l3 => { l3.hero.h1 = 'Compassionate Care for You'; }))
      .includes('hero_h1_keyword_and_location'), 'no keyword, no city');
    assert.ok(cbhFails(cbhPage(l3 => { l3.hero.h1 = 'Anxiety Treatment ' + 'x'.repeat(60) + ' in Anaheim Hills'; }))
      .includes('hero_h1_length'));
  });

  test('the approach section is capped as a whole, not just per paragraph', () => {
    // Three paragraphs each inside the 300 limit can still breach the 1,200
    // section cap - which is why the section gate exists separately.
    const long = 'x'.repeat(295);
    const page = cbhPage((l3) => {
      l3.approach.paragraphs = [long, long];
      l3.approach.philosophy = [long, long];
      l3.approach.therapies = [long, long];
    });
    const fails = cbhFails(page);
    assert.ok(fails.includes('approach_section_length'), 'the section total must be gated');
    assert.ok(!fails.includes('approach_paragraph_limits'), 'while every individual paragraph is legal');
  });

  test('every H3 body gets three lines per H3 - four H3s means twelve each', () => {
    // "3 x number of H3s" is what EACH body gets, not what the bodies share.
    // The fixture has four H3s, so every one of them has twelve lines of its
    // own and a short neighbour neither lends nor constrains.
    assert.strictEqual(cbhContract.linesPerBody(4), 12);
    assert.strictEqual(cbhContract.linesPerBody(5), 15);
    const L = 'y'.repeat(80);
    // Nine content lines plus the two breaks they oblige is eleven, inside the
    // twelve. All four bodies spending that is 44 lines across the section --
    // which a pooled reading of the same sentence would reject outright.
    const full = cbhPage((l3) => { l3.educational.h3s.forEach((h) => { h.lines = Array(9).fill(L); }); });
    assert.ok(!cbhFails(full).includes('educational_h3_line_budget'),
      'four bodies of nine lines each is legal - the allowance is per body');
    // Ten content lines oblige three breaks: thirteen, past the twelve.
    const over = cbhPage((l3) => { l3.educational.h3s[2].lines = Array(10).fill(L); });
    assert.ok(cbhFails(over).includes('educational_h3_line_budget'),
      'but one body past its own twelve still fails');
  });
  test('a bullet costs the same as the words would as a sentence', () => {
    // It carried a surcharge briefly. That made the client's own pages
    // impossible -- one of their subsections is an eight-bullet list, which at
    // two lines each came to sixteen against a cap of nine to fifteen.
    const words = 'Group sessions for shared skills practice.';
    assert.strictEqual(cbhContract.lineCount(words), 1);
    assert.strictEqual(cbhContract.lineCount(`- ${words}`), 1, 'the marker is free');
    assert.strictEqual(cbhContract.lineCount(`1. ${words}`), 1);
    assert.ok(!cbhContract.isBullet('-nospace'), 'a hyphenated word is not a bullet');
    // The client's real body now fits: eight bullets are eight lines, plus the
    // two breaks they oblige.
    const B = `- ${'y'.repeat(58)}`;
    assert.strictEqual(cbhContract.linesUsed(Array(8).fill(B)), 10);
    const eight = cbhPage((l3) => { l3.educational.h3s[0].lines = Array(8).fill(B); });
    assert.ok(!cbhFails(eight).includes('educational_h3_line_budget'),
      'ten lines is inside the twelve a four-H3 page allows');
    // Breaks are now the larger charge on a list, so a long enough one still
    // overruns: 14 bullets are 14 lines plus 4 breaks.
    const overrun = cbhPage((l3) => { l3.educational.h3s[0].lines = Array(14).fill(B); });
    assert.ok(cbhFails(overrun).includes('educational_h3_line_budget'));
  });
  test('a section of one-line fragments is flagged, a mixed one is not', () => {
    // The reported defect: every H3 body a list of short standalone sentences,
    // which reads like a slide deck. The fixture mixes paragraphs and bullets
    // and must stay clean; stripping either form has to be caught.
    assert.ok(!cbhFails(cbhPage()).includes('educational_body_mix'));
    const fragments = cbhPage((l3) => {
      l3.educational.h3s.forEach((h) => { h.lines = ['A short standalone sentence.', 'And another one.']; });
    });
    assert.ok(cbhFails(fragments).includes('educational_body_mix'),
      'one-line entries throughout is the shape the client rejected');
    const noBullets = cbhPage((l3) => {
      l3.educational.h3s.forEach((h) => { h.lines = h.lines.filter(l => !cbhContract.isBullet(l)); });
    });
    assert.ok(cbhFails(noBullets).includes('educational_body_mix'), 'all prose is one-sided too');
    // Minor, not Major: a one-sided section is still a usable page. But the
    // writer retries on it, which is how the shape actually gets fixed.
    assert.strictEqual(cbhQc.runCbhQc(noBullets).verdict, 'CONDITIONAL PASS');
    assert.ok(cbhWriter.CORRECTABLE.has('educational_body_mix'));
  });
  test('an entry is a bullet, a paragraph or a fragment', () => {
    const f = cbhContract.entryForm;
    assert.strictEqual(f('- Worry that is hard to control most days'), 'bullet');
    assert.strictEqual(f('A short standalone sentence.'), 'fragment');
    assert.strictEqual(f('y'.repeat(86)), 'paragraph', 'past one line of wrap it is prose');
    assert.strictEqual(f('   '), 'empty');
  });
  test('the mandatory break after every third line is charged for', () => {
    const L = 'y'.repeat(80);
    const used = (n) => cbhContract.linesUsed(Array(n).fill(L));
    assert.strictEqual(used(3), 3, 'no break is needed after the last line');
    assert.strictEqual(used(4), 5, 'a fourth line obliges a break after the third');
    assert.strictEqual(used(7), 9, 'seven lines carry two breaks');
    // Which is why the writer is asked for nine lines and not twelve: the
    // breaks come out of the same allowance.
    assert.strictEqual(cbhContract.contentAllowance(12), 9);
    assert.strictEqual(cbhContract.contentAllowance(15), 12);
  });
  test('a long paragraph counts as several lines against its own body', () => {
    assert.strictEqual(cbhContract.lineCount('y'.repeat(200)), 3, 'a 200-char line is three lines');
    assert.strictEqual(cbhContract.linesUsed(['y'.repeat(255)]), 3);
    // 765 characters wrap to nine lines, which with two breaks fills a body.
    assert.ok(!cbhFails(cbhPage((l3) => { l3.educational.h3s[0].lines = ['y'.repeat(765)]; }))
      .includes('educational_h3_line_budget'));
    assert.ok(cbhFails(cbhPage((l3) => { l3.educational.h3s[0].lines = ['y'.repeat(766)]; }))
      .includes('educational_h3_line_budget'), 'one character more is a tenth line and overruns');
  });
  test('an H3 with no body fails', () => {
    const page = cbhPage((l3) => { l3.educational.h3s[1].lines = []; });
    assert.ok(cbhFails(page).includes('educational_h3_line_budget'));
  });
  test('the H3 count is gated at both ends', () => {
    assert.ok(cbhFails(cbhPage(l3 => { l3.educational.h3s = l3.educational.h3s.slice(0, 3); }))
      .includes('educational_h3_count'), '3 H3s is under the floor');
    const six = cbhPage((l3) => {
      while (l3.educational.h3s.length < 6) l3.educational.h3s.push({ heading: 'Extra section', lines: ['a line'] });
    });
    assert.ok(cbhFails(six).includes('educational_h3_count'), '6 H3s is over the ceiling');
  });

  test('a fallback section with no source is a failure, not a pass', () => {
    // The guidelines forbid inventing information. An unattributed fallback is
    // indistinguishable from an invented one.
    const page = cbhPage();
    page.sections.educational.h3s[2].sourceUrl = '';
    assert.ok(cbhFails(page).includes('educational_fallback_cited'));
  });

  test('every educational section has to declare where it came from', () => {
    const page = cbhPage();
    page.sections.educational.h3s[0].source = null;
    assert.ok(cbhFails(page).includes('educational_provenance_stated'));
  });

  test('the treatment H2 is gated on presence, no longer on length', () => {
    // The only H2 the writer composes. Its LENGTH gate went at the client's
    // instruction: the shape they asked for -- "<service> treatment experts at
    // Clear Behavioral Health, <city>" -- is longer than the cap it replaced.
    // So the remaining gate has to still catch a heading that is not there.
    assert.ok(!cbhFails(cbhPage()).includes('treatment_heading_present'));
    assert.ok(!cbhFails(cbhPage()).includes('treatment_length'));

    const asked = 'Anger management treatment experts at Clear Behavioral Health, Anaheim Hills';
    assert.ok(asked.length > 60, 'the requested shape is over the cap that used to gate it');
    assert.ok(!cbhFails(cbhPage(l3 => { l3.treatment.heading = asked; }))
      .includes('treatment_heading_present'), 'and it passes');

    assert.ok(cbhFails(cbhPage(l3 => { l3.treatment.heading = ''; }))
      .includes('treatment_heading_present'), 'but an empty H2 still fails');
    assert.ok(cbhFails(cbhPage(l3 => { l3.treatment.paragraph = 'z'.repeat(251); }))
      .includes('treatment_length'));
    assert.ok(cbhFails(cbhPage(l3 => { l3.treatment.paragraph = ''; }))
      .includes('treatment_length'));
    // Both are model-fixable, so both drive the correction pass.
    assert.ok(cbhWriter.CORRECTABLE.has('treatment_heading_present'));
    assert.ok(cbhWriter.CORRECTABLE.has('treatment_length'));
    assert.ok(!cbhWriter.CORRECTABLE.has('treatment_heading_length'), 'the old id is gone');
  });
  test('a general treatment H2 is accepted, because the CMS spec uses one', () => {
    // There was a gate requiring the service and the city here. The client's
    // CMS format then showed this heading as "Work With Experienced Mental
    // Health Professionals", so a general heading has to pass.
    const general = cbhPage(l3 => { l3.treatment.heading = 'Work With Experienced Mental Health Professionals'; });
    const ids = cbhFails(general);
    assert.ok(!ids.some(id => id.startsWith('treatment_')), 'no treatment gate may fail on it');
  });
  test('the treatment section sits between Service and the FAQs', () => {
    // The client asked for it directly above the FAQs, and the exports walk
    // SECTION_ORDER rather than hard-coding a sequence of their own.
    const keys = cbhContract.SECTION_ORDER.map(x => x.key);
    assert.deepStrictEqual(keys.slice(-3), ['service', 'treatment', 'faq']);
  });
  test('the scaffold leaves the treatment H2 empty for the writer', () => {
    // Every other heading is filled in by code; this one is not, and merging
    // must not blank it when a correction returns only the paragraph.
    const blank = cbhFixture.scaffold();
    assert.strictEqual(blank.sections.treatment.heading, '');
    const merged = cbhCompose.mergeCbhL3(cbhFixture.scaffold(), cbhFixture.passingL3());
    assert.ok(merged.sections.treatment.heading.length > 0);
    const kept = cbhCompose.mergeCbhL3(merged, { treatment: { paragraph: 'Only the paragraph came back.' } });
    assert.ok(kept.sections.treatment.heading.length > 0, 'the heading survives a partial correction');
    assert.strictEqual(kept.sections.treatment.paragraph, 'Only the paragraph came back.');
  });

  test('the FAQ set is gated on count, answer length and type mix', () => {
    assert.ok(cbhFails(cbhPage(l3 => { l3.faqs = l3.faqs.slice(0, 4); })).includes('faq_count'));
    assert.ok(cbhFails(cbhPage(l3 => { l3.faqs[0].a = 'z'.repeat(301); })).includes('faq_answer_length'));
    const noBrand = cbhPage(l3 => { l3.faqs.forEach((f) => { f.type = 'intent'; }); });
    assert.ok(cbhFails(noBrand).includes('faq_type_mix'), 'a missing question type is flagged');
    assert.strictEqual(cbhQc.runCbhQc(noBrand).verdict, 'CONDITIONAL PASS',
      'but only as a Minor - a useful set that skips a category is not a failed page');
  });

  test('the writer only retries on failures a model can actually fix', () => {
    // Told "your description is 138 characters, it must be 150-160" a model
    // fixes it. Told "your UVP is not specific enough" it rewrites at random.
    assert.ok(cbhWriter.CORRECTABLE.has('meta_description_length'));
    assert.ok(cbhWriter.CORRECTABLE.has('educational_h3_line_budget'));
    assert.ok(!cbhWriter.CORRECTABLE.has('uvp_is_specific'));
    assert.ok(!cbhWriter.CORRECTABLE.has('insurance_heading'), 'a fixed heading is code, not a writing error');
  });

  test('a correction that made the page worse is discarded', () => {
    const good = cbhQc.runCbhQc(cbhPage());
    const worse = cbhQc.runCbhQc(cbhPage(l3 => { l3.faqs = []; l3.educational.h3s = []; }));
    assert.ok(cbhWriter.failureWeight(worse) > cbhWriter.failureWeight(good),
      'weighting must rank a broken page above a clean one so the better draft wins');
  });

  test('the correction note quotes the real measured numbers', () => {
    const qcResult = cbhQc.runCbhQc(cbhPage(l3 => { l3.metaDescription = 'Too short.'; }));
    const note = cbhWriter.correctionFrom(qcResult);
    assert.ok(/meta description/i.test(note), 'the failing section is named');
    assert.ok(/\d+ characters/.test(note), 'with the count the model has to correct against');
  });

  console.log('\nCBH - the CMS ingest JSON');

  const cmsJson = (mutate) => {
    const page = cbhPage(mutate);
    return exporter.toCbhCmsJson(page, {
      service: { slug: 'anxiety-treatment', groups: ['mh-outpatient'] },
      location: { location_slug: 'anaheim-hills' },
    });
  };

  test('the CMS block names do not match ours, and the mapping is the client\'s', () => {
    // Confirmed with the client: their `treatment` is OUR service section, and
    // their `experts` is our treatment section. Getting this backwards puts the
    // clinician copy under a heading about the service, on every page.
    const j = cmsJson();
    // Sentence-cased on the way out, so the leading word is capitalised where
    // it is not already a protected acronym ("ADHD treatment in ..." keeps its).
    assert.strictEqual(j.treatment.heading, 'Anxiety treatment programs in Anaheim Hills');
    assert.strictEqual(j.experts.heading, 'Our anxiety treatment experts in Anaheim Hills');
    assert.ok(j.experts.description.includes('clinicians'), 'the clinician copy lands under experts');
  });

  test('headings the CMS writes differently are adapted on the way out', () => {
    const j = cmsJson();
    // The page's educational H2 now carries the question mark itself, so the
    // export's asQuestion is belt-and-braces for a page that never passed the
    // read path rather than the thing that adds it.
    assert.ok(cbhPage().sections.educational.heading.endsWith('?'));
    assert.ok(j.what_is.heading.endsWith('?'));
    assert.strictEqual(j.what_is.heading, cbhPage().sections.educational.heading);
    assert.strictEqual(j.jump_menu.service_label, j.what_is.heading);
    // The UVP H2 keeps its mark. An earlier reading of the CMS sample stripped
    // it here; the client's own example carries it, so both the page and the
    // export now end on the question.
    assert.ok(cbhPage().sections.uvp.heading.endsWith('?'));
    assert.ok(j.why_choose.heading.endsWith('?'));
    // page_title follows the client's VALUE ("<Service> in <Location>"), not
    // their comment, which says "same as H1" beside a different string.
    assert.strictEqual(j.page_title, j.treatment.heading);
    assert.notStrictEqual(j.page_title, j.banner.heading);
  });

  test('every heading comes out sentence case', () => {
    const j = cmsJson();
    // No city: the client reversed the earlier "append the city" instruction.
    assert.strictEqual(j.approach.heading, 'Our approach to anxiety treatment');
    assert.strictEqual(j.why_choose.heading, 'Why choose Clear Behavioral Health?');
    // The fixed client headings are already sentence case, so nothing moves.
    assert.strictEqual(j.approach.items[0].heading, 'Our philosophy of compassionate care');
  });

  test('sentence case lowers title case without destroying names', () => {
    // The whole difficulty: "Treatment" and "Anaheim" are the same shape, and
    // one has to come down while the other must not. A blunt lowercase pass
    // gives "adhd treatment in anaheim hills".
    const page = { serviceName: 'ADHD treatment', locationName: 'Anaheim Hills' };
    const loc = { city: 'Anaheim Hills', state: 'California', state_abbreviation: 'CA',
      nearby_areas: ['Yorba Linda'] };
    const keep = exporter.protectedTermsFor(page, loc);
    const sc = (t) => exporter.sentenceCase(t, keep);
    assert.strictEqual(sc('Our Approach to ADHD Treatment in Anaheim Hills'),
      'Our approach to ADHD treatment in Anaheim Hills');
    assert.strictEqual(sc('ADHD Treatment in Anaheim Hills That Fits Your Life'),
      'ADHD treatment in Anaheim Hills that fits your life', 'a protected first word stays as it is');
    assert.strictEqual(sc('Treatment Options Near Yorba Linda in California'),
      'Treatment options near Yorba Linda in California', 'nearby areas and the state are names too');
    assert.strictEqual(sc('(Stress) Relief Explained'), '(Stress) relief explained',
      'the first LETTER is capitalised, not the first character');
  });

  test('sentence case leaves acronyms, roman numerals and the pronoun I alone', () => {
    const keep = exporter.protectedTermsFor({ serviceName: 'Bipolar I & II', locationName: 'El Monte' }, {});
    // "bipolar" comes DOWN: it is a common noun, and the service name grants
    // nothing protection. Protecting it was the bug that produced "Our approach
    // to Anxiety treatment". The numerals survive on the acronym rule.
    assert.strictEqual(exporter.sentenceCase('Our Approach to Bipolar I & II in El Monte', keep),
      'Our approach to bipolar I & II in El Monte');
    // "I" is all-caps but one letter, so the acronym rule alone would lower it.
    assert.strictEqual(exporter.sentenceCase('How quickly can I get an ADHD evaluation?', keep),
      'How quickly can I get an ADHD evaluation?');
    // And its contractions: "I'm" is neither all-caps nor a name, and shipped
    // once as "if i'm too drained to keep working".
    assert.strictEqual(exporter.sentenceCase("Can Therapy Help If I'm Too Drained?", keep),
      "Can therapy help if I'm too drained?");
    assert.strictEqual(exporter.sentenceCase("What If I've Tried Therapy Before?", keep),
      "What if I've tried therapy before?");
    // Idempotent: running it over text already in sentence case changes nothing.
    const once = exporter.sentenceCase('What is ADHD treatment?', keep);
    assert.strictEqual(exporter.sentenceCase(once, keep), once);
  });

  test('a service name grants no word protection, but real proper nouns keep theirs', () => {
    // The reported defect: "Our approach to Anxiety treatment", "What is
    // Anxiety treatment". Every capitalised word in the service name was being
    // treated as a name, and most service names are common nouns.
    assert.strictEqual(cbhContract.approachHeading('Anxiety treatment'), 'Our approach to anxiety treatment');
    // educationalHeading takes the RAW condition, not the display phrase.
    assert.strictEqual(cbhContract.educationalHeading('Anxiety'), 'What is anxiety?');
    assert.strictEqual(cbhContract.serviceHeading('Anxiety treatment', 'Santa Clarita'),
      'Anxiety treatment programs in Santa Clarita', 'the leading word is still capitalised');
    // But an acronym, a branded medicine and a city all keep their capitals.
    assert.strictEqual(cbhContract.approachHeading('ADHD treatment'), 'Our approach to ADHD treatment');
    assert.strictEqual(cbhContract.approachHeading('Xanax Addiction treatment'),
      'Our approach to Xanax addiction treatment', 'a branded medicine is a proper noun');
    assert.strictEqual(cbhContract.serviceHeading('Burnout treatment', 'Anaheim Hills'),
      'Burnout treatment programs in Anaheim Hills');
  });

  test('model-written headings are cased as they are merged, not merely asked for', () => {
    // A prompt is a request; casing on merge is a guarantee, and it reaches
    // pages regenerated from an older draft too.
    const page = cbhCompose.mergeCbhL3(cbhFixture.scaffold(), {
      hero: { h1: 'Compassionate Anxiety Treatment in Anaheim Hills, CA' },
      educational: { paragraphs: ['x'], h3s: [{ heading: 'Understanding Anxiety and Its Symptoms', lines: ['y'] }] },
      treatment: { heading: 'Our Anxiety Treatment Experts', paragraph: 'z' },
      faqs: [{ q: 'How Quickly Can I Be Seen?', a: 'Soon.', type: 'location' }],
    });
    assert.strictEqual(page.sections.hero.h1, 'Compassionate anxiety treatment in Anaheim Hills, CA');
    assert.strictEqual(page.sections.educational.h3s[0].heading, 'Understanding anxiety and its symptoms');
    assert.strictEqual(page.sections.treatment.heading, 'Our anxiety treatment experts');
    assert.strictEqual(page.sections.faq.items[0].q, 'How quickly can I be seen?');
  });

  test('a possessive form of a protected name keeps its capital', () => {
    // "Clear Behavioral health's approach to burnout" shipped once: the token
    // was "Health's" and the protected set holds "health".
    const keep = cbhContract.protectedTerms({ locationName: 'Torrance' });
    assert.strictEqual(cbhContract.sentenceCase("Clear Behavioral Health's Approach to Burnout", keep),
      "Clear Behavioral Health's approach to burnout");
    assert.strictEqual(cbhContract.sentenceCase("Torrance's Outpatient Team", keep),
      "Torrance's outpatient team");
  });

  test('brief headings are cased too, not only the page', () => {
    // The brief is what the reviewer reads and edits, and its H3 headings are
    // copied VERBATIM onto the page. Casing only at merge left the brief in
    // the planner's title case.
    const b = cbhBrief.normalizeCbhBrief({
      educational: { h3s: [{ heading: 'What Is Burnout and Executive Burnout?', source: 'competitor' }] },
      faqs: [{ q: 'How Quickly Can Someone Be Seen In Torrance?', type: 'location' }],
    }, { locationName: 'Torrance' });
    assert.strictEqual(b.educational.h3s[0].heading, 'What is burnout and executive burnout?');
    assert.strictEqual(b.faqs[0].q, 'How quickly can someone be seen in Torrance?');
  });

  test('the service H2 names programmes, where that reads as English', () => {
    // Every live page reads "Depression treatment programs in Van Nuys".
    const h = cbhContract.serviceHeading;
    assert.strictEqual(h('Depression treatment', 'Anaheim Hills'), 'Depression treatment programs in Anaheim Hills');
    assert.strictEqual(h('Family Therapy', 'Torrance'), 'Family therapy programs in Torrance');
    // But NOT where it would double up or read badly. A blanket append gives
    // "Partial hospitalization program program" and "(IOP) program".
    assert.strictEqual(h('Partial Hospitalization Program (PHP)', 'Torrance'),
      'Partial hospitalization program (PHP) in Torrance');
    assert.strictEqual(h('Outpatient Mental Health Treatment (IOP)', 'Torrance'),
      'Outpatient mental health treatment (IOP) in Torrance');
  });

  test('a name that says neither "treatment" nor "programs" takes both', () => {
    // "Anger management in Anaheim Hills" named the condition and stopped
    // there: "management", "groups" and "support" read as service nouns, so
    // neither of the earlier rules fired and the heading never said what the
    // care was. The client asked for both words on exactly these.
    const h = cbhContract.serviceHeading;
    assert.strictEqual(h('Anger Management', 'Anaheim Hills'),
      'Anger management treatment programs in Anaheim Hills');
    assert.strictEqual(h('Case Management', 'Pasadena'),
      'Case management treatment programs in Pasadena');
    assert.strictEqual(h('Parent Support Groups', 'Pasadena'),
      'Parent support groups treatment programs in Pasadena');
    // A trailing acronym is still left alone -- it would read as a second
    // programme -- and a name that already says "program" keeps its own.
    assert.strictEqual(h('Outpatient Addiction Treatment (IOP & PHP)', 'Gardena'),
      'Outpatient addiction treatment (IOP & PHP) in Gardena');
    assert.strictEqual(h('Cognitive Behavioral Therapy (CBT)', 'Van Nuys'),
      'Cognitive behavioral therapy (CBT) in Van Nuys');
    assert.strictEqual(h('Legal Diversion Program', 'El Monte'),
      'Legal diversion program in El Monte');
  });

  test('a multi-word name is protected as a phrase, not as loose words', () => {
    // Protecting the brand word by word capitalised those words everywhere:
    // "Health" is in "Clear Behavioral Health", so "outpatient mental health
    // treatment" came out "mental Health".
    const keep = cbhContract.protectedTerms({ locationName: 'Torrance', location: { nearby_areas: ['Redondo Beach'] } });
    assert.strictEqual(cbhContract.sentenceCase('Outpatient Mental Health Treatment In Torrance', keep),
      'Outpatient mental health treatment in Torrance');
    assert.strictEqual(cbhContract.sentenceCase("Clear Behavioral Health's Approach To Burnout", keep),
      "Clear Behavioral Health's approach to burnout");
    assert.strictEqual(cbhContract.sentenceCase('Serving Torrance And Redondo Beach', keep),
      'Serving Torrance and Redondo Beach');
  });

  test('a bold sub-label is markup: free to count, rendered on the way out', () => {
    // The client's live bodies break a long subsection up with bold labels.
    // The asterisks must not eat the line budget -- this module counts rendered
    // text, never markup.
    const withLabel = '**Biological factors** shape how depression develops over time.';
    assert.strictEqual(cbhContract.lineCount(withLabel), cbhContract.lineCount(cbhContract.stripInlineMarkup(withLabel)));
    assert.strictEqual(cbhContract.lineCount(withLabel), 1, 'four asterisks do not push it to two lines');
    // A label does not make an entry a bullet, and a bullet keeps its form.
    assert.strictEqual(cbhContract.entryForm(withLabel), 'fragment');
    assert.strictEqual(cbhContract.entryForm('- **Signs:** low mood most days'), 'bullet');
  });

  test('bold labels render as <strong>, and stray HTML is still escaped', () => {
    const html = exporter.linesToHtml([
      '**Biological factors** include family history.',
      '- **Signs:** low mood most days',
      'A closer with <b>stray</b> markup & an ampersand.',
    ]);
    assert.ok(html.includes('<p><strong>Biological factors</strong> include'));
    assert.ok(html.includes('<li><strong>Signs:</strong> low mood most days</li>'));
    // Escaped FIRST, so the only tags in the output are the ones we generate.
    assert.ok(html.includes('&lt;b&gt;stray&lt;/b&gt;'));
    assert.ok(html.includes('&amp;'));
    assert.ok(!html.includes('<b>'), 'a tag in the copy must not survive as markup');
  });

  test('the meta title is not sentence-cased, because it is not a heading', () => {
    // It is the <title> tag, read in a SERP rather than on the page, and it
    // ships as the SEO team wrote it.
    const j = cmsJson();
    assert.strictEqual(j.seo.title, cbhPage().meta.fullTitle);
  });

  test('educational bullets become one list, prose stays paragraphs', () => {
    const j = cmsJson();
    const withBullets = j.tabs.find(t => t.content.includes('<ul>'));
    assert.ok(withBullets, 'the fixture mixes prose and bullets, so a tab must carry a list');
    // ONE list, not one per bullet, and the marker is stripped -- it was a
    // costing signal for the line budget, not something a reader should see.
    assert.strictEqual((withBullets.content.match(/<ul>/g) || []).length, 1);
    assert.ok(!withBullets.content.includes('<li>- '));
    assert.ok(withBullets.content.startsWith('<p>'), 'the lead paragraph stays a paragraph');
    // FAQ answers are plain text, unlike what_is and tabs.
    assert.ok(j.faqs.length && !j.faqs[0].answer.includes('<p>'));
    assert.ok(j.what_is.content.startsWith('<p>'));
  });

  test('HTML in the copy is escaped, not passed through', () => {
    const j = cmsJson(l3 => { l3.educational.paragraphs = ['Care for <b>anxiety</b> & stress.']; });
    assert.ok(j.what_is.content.includes('&lt;b&gt;'), 'a stray tag must not become markup');
    assert.ok(j.what_is.content.includes('&amp;'));
  });

  test('service_type comes from the service groups, not a hand-kept list', () => {
    // Approved with the client: an addiction-* group means addiction, and
    // everything else -- including teen services, which carry only `teen` --
    // is mental_health.
    const t = (groups) => exporter.serviceTypeFor({ groups });
    assert.strictEqual(t(['addiction-residential']), 'addiction');
    assert.strictEqual(t(['addiction-outpatient', 'addiction-residential']), 'addiction');
    assert.strictEqual(t(['mh-outpatient']), 'mental_health');
    assert.strictEqual(t(['teen']), 'mental_health', 'teen services fall to the default');
    assert.strictEqual(t([]), 'mental_health');
    assert.strictEqual(t(undefined), 'mental_health');
  });

  test('every key the CMS asks for is present, even on a thin page', () => {
    const j = cmsJson();
    ['location_slug', 'service_slug', 'page_title', 'service_type', 'seo', 'banner', 'insurance',
      'jump_menu', 'approach', 'what_is', 'tabs', 'why_choose', 'treatment', 'experts', 'faqs']
      .forEach(k => assert.ok(k in j, `${k} is missing`));
    assert.strictEqual(j.approach.items.length, 2, 'philosophy and therapies, always two');
    assert.ok(j.seo.title.endsWith(cbhContract.TITLE_SUFFIX), 'the shipping title carries the brand suffix');
  });

  console.log('\nCBH - the experts heading and the live location slugs');

  // A page as generateFromBrief builds one now: from the real scaffold, so it
  // carries meta.fixedExpertsHeading.
  const cbhLoc = id => seed.CBH_LOCATIONS.find(l => l.id === id);
  const cbhSvc = id => seed.CBH_SERVICES.find(s => s.id === id);
  const newCbhPage = (serviceId = 'cbh_anxiety', locationId = 'cbhloc_anaheim-hills') => {
    const location = cbhLoc(locationId);
    const service = cbhSvc(serviceId);
    const sc = cbhCompose.buildCbhScaffold({
      client: { id: 'client_clear_behavioral_health', brand_static: { base_url: 'https://clearbehavioralhealth.com' } },
      service, location,
    }, { servicePhrase: keywordRelevance.servicePhraseDisplay });
    return { page: cbhCompose.mergeCbhL3(sc, cbhFixture.passingL3(), location), service, location };
  };

  test('the experts heading names the service, the brand and the city', () => {
    const h = (name, city) => cbhContract.expertsHeading(keywordRelevance.servicePhraseDisplay(name), city);
    assert.strictEqual(h('Stress', 'Manhattan Beach'),
      'Stress treatment experts at Clear Behavioral Health, Manhattan Beach');
    // A therapy already names the service, so it does not grow "Treatment".
    assert.strictEqual(h('Cognitive Behavioral Therapy', 'Manhattan Beach'),
      'Cognitive behavioral therapy experts at Clear Behavioral Health, Manhattan Beach');
    assert.strictEqual(h('ADHD', 'El Monte'), 'ADHD treatment experts at Clear Behavioral Health, El Monte');
    assert.ok(!/therapy treatment/i.test(h('Family Therapy', 'Torrance')));
  });

  test('a new page gets the code-built experts heading, whatever the writer returned', () => {
    const { page, service, location } = newCbhPage();
    assert.strictEqual(page.meta.fixedExpertsHeading, true);
    const expected = 'Anxiety treatment experts at Clear Behavioral Health, Anaheim Hills';
    assert.strictEqual(page.sections.treatment.heading, expected, 'the model\'s own heading is ignored');
    // A hand edit does not stick: the heading is rebuilt on every read and save.
    page.sections.treatment.heading = 'Meet our team';
    cbhCompose.refreshCbhDerived(page, { location, service });
    assert.strictEqual(page.sections.treatment.heading, expected);
    page.primaryKeyword = cbhFixture.PRIMARY;
    const checks = cbhQc.runCbhQc(page).checks;
    assert.ok(checks.find(c => c.id === 'treatment_heading').pass);
    assert.ok(checks.find(c => c.id === 'treatment_heading_present').pass);
    assert.strictEqual(exporter.toCbhCmsJson(page, { service, location }).experts.heading, expected);
  });

  test('a page generated before the change keeps its written experts heading', () => {
    const old = cbhPage();
    assert.ok(!old.meta.fixedExpertsHeading);
    cbhCompose.refreshCbhDerived(old, {});
    assert.strictEqual(old.sections.treatment.heading, 'Our anxiety treatment experts in Anaheim Hills');
    assert.strictEqual(cbhQc.runCbhQc(old).checks.find(c => c.id === 'treatment_heading').pass, true,
      'the exact-wording gate does not apply to it');
    old.sections.treatment.heading = '';
    assert.ok(!cbhQc.runCbhQc(old).checks.find(c => c.id === 'treatment_heading_present').pass,
      'and it is still held to the presence check');
  });

  test('the export always names the city in the CMS treatment heading', () => {
    const p = cbhPage();
    p.sections.service.heading = 'Anxiety treatment programs';
    assert.strictEqual(exporter.toCbhCmsJson(p, {}).treatment.heading, 'Anxiety treatment programs in Anaheim Hills');
    assert.strictEqual(exporter.toCbhCmsJson(cbhPage(), {}).treatment.heading, 'Anxiety treatment programs in Anaheim Hills',
      'a heading that already has it is unchanged');
  });

  test('each CBH location carries its live slug, and its id is unchanged', () => {
    const anaheim = cbhLoc('cbhloc_anaheim-hills');
    assert.strictEqual(anaheim.location_slug, 'anaheim-hills-outpatient-mental-health-services');
    assert.strictEqual(anaheim.location_page_url, '/locations/anaheim-hills-outpatient-mental-health-services/');
    assert.strictEqual(cbhLoc('cbhloc_los-angeles-mid-wilshire').location_slug, 'outpatient-mental-health-treatment-los-angeles');
    assert.strictEqual(cbhLoc('cbhloc_gardena-residential').location_slug, 'residential-rehab-for-addiction-in-gardena');
    assert.strictEqual(seed.CBH_LOCATIONS.length, 14);
    seed.CBH_LOCATIONS.forEach(l => assert.ok(l.location_slug !== l.id.replace(/^cbhloc_/, ''), `${l.id} still has its old slug`));
  });

  test('the export and the page URL use the full location slug', () => {
    const { page, service, location } = newCbhPage();
    assert.strictEqual(page.meta.urlPath, '/locations/anaheim-hills-outpatient-mental-health-services/anxiety-treatment/');
    assert.strictEqual(exporter.toCbhCmsJson(page, { service, location }).location_slug,
      'anaheim-hills-outpatient-mental-health-services');
  });

  test('Redondo Beach outpatient picks its live page by the kind of service', () => {
    const loc = cbhLoc('cbhloc_redondo-beach-outpatient');
    const addiction = cbhSvc('cbh_dual-diagnosis-addiction-treatment');
    const mh = cbhSvc('cbh_anxiety');
    assert.strictEqual(cbhContract.cbhLocationSlug(loc, addiction), 'dual-diagnosis-outpatient-redondo-beach');
    assert.strictEqual(cbhContract.cbhLocationSlug(loc, mh), 'outpatient-mental-health-redondo-beach');
    assert.strictEqual(cbhContract.cbhLocationPageUrl(loc, addiction), '/locations/dual-diagnosis-outpatient-redondo-beach/');
    const { page } = newCbhPage('cbh_dual-diagnosis-addiction-treatment', 'cbhloc_redondo-beach-outpatient');
    assert.ok(page.meta.urlPath.startsWith('/locations/dual-diagnosis-outpatient-redondo-beach/'), page.meta.urlPath);
    assert.strictEqual(exporter.toCbhCmsJson(page, { service: addiction, location: loc }).location_slug,
      'dual-diagnosis-outpatient-redondo-beach');
  });

  test('the dental gates are not applied to a CBH page, or the reverse', () => {
    const page = cbhPage();
    assert.ok(cbhQc.isCbhPage(page), 'a CBH page is recognisable by its own sections');
    assert.ok(!cbhQc.isCbhPage({ meta: {}, sections: { hero: {}, educationalBody: { blocks: [] } } }),
      'a dental page is not mistaken for one');
  });


  console.log('\nCBH - fallback sourcing is an allowlist, not "whatever ranked"');
  test('only the approved clinical authorities count as a source', () => {
    ['https://www.nimh.nih.gov/health/topics/anxiety-disorders',
      'https://pubmed.ncbi.nlm.nih.gov/12345', 'https://www.mayoclinic.org/anxiety']
      .forEach(u => assert.ok(cbhSources.isAllowed(u), `${u} is an approved authority`));
    ['https://example.com/anxiety', 'https://psychologytoday.com/x', 'not a url', '']
      .forEach(u => assert.ok(!cbhSources.isAllowed(u), `${u} is not`));
  });
  test('a lookalike domain cannot pass as an authority', () => {
    // Suffix matching alone would accept the first of these; the check is host
    // equality or a real subdomain, so a domain merely CONTAINING an
    // allowlisted one fails.
    assert.ok(!cbhSources.isAllowed('https://nimh.nih.gov.evil.com/anxiety'));
    assert.ok(!cbhSources.isAllowed('https://notcdc.gov/anxiety'));
    assert.ok(cbhSources.isAllowed('https://sub.nimh.nih.gov/anxiety'), 'a genuine subdomain is fine');
  });
  test('the lookup cap can never be lower than the number of sections needing one', () => {
    // A cap below the maximum H3 count produced a page that structurally could
    // not pass educational_fallback_cited: with all sections marked fallback,
    // two got a source and the rest could never get one, no matter how many
    // times it was regenerated. The cap is derived from the contract for this
    // reason; hardcoding it is how the bug happened.
    assert.ok(cbhSources.MAX_LOOKUPS_PER_PAGE >= cbhContract.LIMITS.educational.h3Count.max,
      `cap ${cbhSources.MAX_LOOKUPS_PER_PAGE} must cover ${cbhContract.LIMITS.educational.h3Count.max} sections`);
  });
  await testAsync('a fully-fallback plan leaves no section unsourceable by the cap', async () => {
    // The code-side plan marks EVERY section fallback, which is the case that
    // exposed the cap. No lookups run here (max 0 keeps it offline); what is
    // asserted is that the cap would have allowed one for each.
    const plan = cbhBrief.fallbackPlan({ serviceName: 'Depression Treatment', city: 'Anaheim Hills' });
    const r = await cbhSources.attachFallbackSources({
      h3s: plan.h3s, serviceName: 'Depression Treatment', max: 0,
    });
    assert.ok(r.needed <= cbhSources.MAX_LOOKUPS_PER_PAGE,
      `${r.needed} sections need a source but the cap allows ${cbhSources.MAX_LOOKUPS_PER_PAGE}`);
  });
  test('the search is restricted to the allowlist up front', () => {
    const q = cbhSources.buildQuery('Signs you may need support', 'Anxiety Treatment');
    cbhSources.ALLOWLIST.forEach(d => assert.ok(q.includes(`site:${d}`), `${d} must be in the query`));
  });
  await testAsync('fallback lookups are capped per page, and uncapped sections stay unsourced', async () => {
    // Beyond the cap a section keeps its fallback tag with no URL, so QC flags
    // it rather than the page shipping unsourced copy as if it were researched.
    const h3s = Array.from({ length: 4 }, (_, i) => ({ heading: `Gap ${i}`, source: 'fallback', sourceUrl: '' }));
    const r = await cbhSources.attachFallbackSources({ h3s, serviceName: 'Anxiety Treatment', max: 0 });
    assert.strictEqual(r.needed, 4);
    assert.strictEqual(r.attempted, 0);
    assert.ok(r.h3s.every(h => !h.sourceUrl), 'nothing is invented when no lookup runs');
  });
  await testAsync('a section already carrying a source is not looked up again', async () => {
    const h3s = [{ heading: 'Covered', source: 'fallback', sourceUrl: 'https://www.cdc.gov/x' }];
    const r = await cbhSources.attachFallbackSources({ h3s, serviceName: 'Anxiety Treatment' });
    assert.strictEqual(r.needed, 0, 'an attributed section needs no lookup');
    assert.strictEqual(r.h3s[0].sourceUrl, 'https://www.cdc.gov/x');
  });

  console.log('\nCBH - the brief only offers what the guidelines leave open');
  test('an unrecognised provenance becomes fallback, never competitor', () => {
    // Defaulting the other way would let an untagged section pass as
    // competitor-backed and skip the attribution gate entirely.
    const b = cbhBrief.normalizeCbhBrief({ educational: { h3s: [{ heading: 'X', source: 'nonsense' }] } });
    assert.strictEqual(b.educational.h3s[0].source, 'fallback');
  });
  test('a planner-proposed meta value outside the contract is not stored', () => {
    // It would override the writer's output AFTER the correction pass has run,
    // so an out-of-range proposal replaced a compliant title and then had no
    // way of being fixed. Left empty, the writer produces it and the correction
    // pass covers it.
    const L = cbhContract.LIMITS;
    assert.strictEqual(cbhBrief.withinRange('Depression Treatment in Anaheim Hills, CA', L.metaTitle), false,
      '41 characters is under the 50 floor');
    assert.strictEqual(cbhBrief.withinRange('Anxiety Treatment in Anaheim Hills, CA | Expert Care', L.metaTitle), true);
    assert.strictEqual(cbhBrief.withinRange('x'.repeat(163), L.metaDescription), false);
    assert.strictEqual(cbhBrief.withinRange('x'.repeat(155), L.metaDescription), true);
  });
  test('range checking measures the way the gates measure', () => {
    // Whitespace-collapsed rendered text, so a value that only passes because
    // of padding cannot slip through one check and fail the other.
    const L = cbhContract.LIMITS;
    const padded = '  ' + 'x'.repeat(155) + '   ';
    assert.strictEqual(cbhBrief.withinRange(padded, L.metaDescription), true);
    assert.strictEqual(cbhContract.textLength(padded), 155);
  });
  test('the brief stores the title without the brand suffix', () => {
    const b = cbhBrief.normalizeCbhBrief({ meta: { title: `Anxiety Treatment in Anaheim Hills${cbhContract.TITLE_SUFFIX}` } });
    assert.strictEqual(b.meta.title, 'Anxiety Treatment in Anaheim Hills',
      'the reviewer edits, and QC counts, the title without the suffix');
  });
  test('the brief cannot carry more H3s or FAQs than the contract allows', () => {
    const b = cbhBrief.normalizeCbhBrief({
      educational: { h3s: Array.from({ length: 9 }, (_, i) => ({ heading: `H${i}` })) },
      faqs: Array.from({ length: 12 }, (_, i) => ({ q: `Q${i}?` })),
    });
    assert.strictEqual(b.educational.h3s.length, cbhContract.LIMITS.educational.h3Count.max);
    assert.strictEqual(b.faqs.length, cbhContract.LIMITS.faqs.count.max);
  });
  test('the code-side plan marks every section fallback, because none was researched', () => {
    const plan = cbhBrief.fallbackPlan({ serviceName: 'Anxiety Treatment', city: 'Anaheim Hills' });
    assert.ok(plan.h3s.every(h => h.source === 'fallback'),
      'a plan written without competitor data must not claim to be competitor-driven');
    assert.ok(plan.h3s.length >= cbhContract.LIMITS.educational.h3Count.min);
    const types = new Set(plan.faqs.map(f => f.type));
    ['location', 'brand', 'intent'].forEach(t => assert.ok(types.has(t), `the default FAQ set covers ${t}`));
    assert.ok(plan.faqs.length >= cbhContract.LIMITS.faqs.count.min);
  });


  console.log('\nCBH - headings keep the client\'s own capitalisation');
  test('an acronym survives into display text', () => {
    // The regression: display text was derived from the KEYWORD phrase, which
    // is lowercase by design, then title-cased back -- turning ADHD into
    // "Adhd" and "Bipolar I & II" into "Bipolar i And ii".
    const d = keywordRelevance.servicePhraseDisplay;
    assert.strictEqual(d('ADHD'), 'ADHD treatment');
    assert.strictEqual(d('OCD'), 'OCD treatment');
    assert.strictEqual(d('Bipolar I & II'), 'Bipolar I & II treatment');
  });
  test('the acronym in a parenthetical is kept, because that is where it lives', () => {
    // Stripping it produced a heading for an OCD page that never says OCD --
    // the term people search and scan for.
    const d = keywordRelevance.servicePhraseDisplay;
    assert.strictEqual(d('Obsessive Compulsive Disorder (OCD)'),
      'Obsessive Compulsive Disorder (OCD) treatment');
    assert.strictEqual(d('Partial Hospitalization Program (PHP)'),
      'Partial Hospitalization Program (PHP)');
    assert.strictEqual(d('Outpatient Addiction Treatment (IOP & PHP)'),
      'Outpatient Addiction Treatment (IOP & PHP)');
  });
  test('a trademark sign is still dropped from display text', () => {
    assert.strictEqual(keywordRelevance.servicePhraseDisplay('Invisalign® Treatment'), 'Invisalign Treatment');
  });
  test('the head-noun rule is the same for display as for keywords', () => {
    // Only the casing differs -- a name that already says what service it is
    // gains nothing in either path.
    ['Anxiety', 'ADHD', 'Teen IOP Treatment', 'Family Therapy', 'Psychotherapy'].forEach((n) => {
      const kw = keywordRelevance.servicePhrase(n);
      const disp = keywordRelevance.servicePhraseDisplay(n);
      assert.strictEqual(disp.toLowerCase().endsWith('treatment'), kw.endsWith('treatment'),
        `"${n}" must gain the head noun in both paths or neither`);
    });
  });
  test('the keyword path is unchanged: still lowercase, parentheticals still stripped', () => {
    // Display casing must not leak into search queries.
    assert.strictEqual(keywordRelevance.servicePhrase('ADHD'), 'adhd treatment');
    assert.strictEqual(keywordRelevance.servicePhrase('Obsessive Compulsive Disorder (OCD)'),
      'obsessive compulsive disorder treatment');
  });
  test('every CBH heading carries the display phrase, not the keyword phrase', () => {
    const page = cbhCompose.buildCbhScaffold({
      client: { id: 'c', brand_static: { base_url: 'https://x.test' } },
      service: { id: 's', name: 'ADHD', slug: 'adhd' },
      location: { id: 'l', city: 'Anaheim Hills', location_page_url: '/locations/anaheim-hills/' },
    }, { servicePhrase: keywordRelevance.servicePhraseDisplay });
    assert.strictEqual(page.serviceName, 'ADHD treatment');
    assert.ok(page.sections.approach.heading.includes('ADHD'), 'approach H2');
    assert.ok(page.sections.educational.heading.includes('ADHD'), 'educational H2');
    assert.ok(page.sections.service.heading.includes('ADHD'), 'service H2');
    assert.ok(!/Adhd/.test(JSON.stringify(page)), 'no title-cased acronym anywhere on the page');
  });


  console.log('\nCBH - a citation means the writer actually read the source');
  test('a block page is not accepted as source text', () => {
    // NCBI answers automated traffic with 800 characters of perfectly
    // scrapeable "Access Denied". Accepting it would hand the writer an error
    // notice and then cite a clinical authority for whatever it wrote instead.
    const blocked = 'NCBI Error Access Denied Your access to the NCBI website has been temporarily '
      + 'blocked due to a possible misuse/abuse situation involving your site. ' + 'x'.repeat(300);
    assert.ok(!cbhSources.usableExcerpt(blocked));
    assert.ok(!cbhSources.usableExcerpt('Please verify you are human. ' + 'x'.repeat(300)));
    assert.ok(!cbhSources.usableExcerpt('Enable JavaScript to continue. ' + 'x'.repeat(300)));
  });
  test('a stub is not accepted as source text', () => {
    assert.ok(!cbhSources.usableExcerpt('too short'));
    assert.ok(!cbhSources.usableExcerpt(''));
  });
  test('genuine clinical prose is accepted, even where it says "error" later on', () => {
    const real = 'Depression is a common and serious medical illness that negatively affects how you '
      + 'feel, the way you think and how you act. Fortunately, it is also treatable. It causes '
      + 'feelings of sadness and a loss of interest in activities once enjoyed, and can lead to a '
      + 'variety of emotional and physical problems. A diagnostic error is possible in any field.';
    assert.ok(cbhSources.usableExcerpt(real), 'the block check reads the OPENING, not the whole body');
  });
  test('the query does not repeat the service word or carry page furniture', () => {
    // "Anxiety treatment" + "Treatment options available" was concatenated raw
    // into "anxiety treatment Treatment options available" -- the topic word
    // twice -- and returned nothing usable across three attempts.
    const q = cbhSources.queryTopic('Treatment options available', 'Anxiety treatment');
    assert.strictEqual(q, 'anxiety treatment options available');
    assert.strictEqual((q.match(/treatment/g) || []).length, 1, 'the topic word appears once');
  });
  test('words that distinguish one section from another are kept', () => {
    // An earlier, over-aggressive stopword list reduced "What to expect at your
    // first visit" to "visit" and lost a source that had been retrieving fine.
    const q = cbhSources.queryTopic('What to expect at your first visit', 'Anxiety treatment');
    ['expect', 'first', 'visit'].forEach(w => assert.ok(q.includes(w), `"${w}" distinguishes this section`));
  });
  test('a heading of pure stopwords still yields a usable query', () => {
    assert.strictEqual(cbhSources.queryTopic('the and of', 'Anxiety treatment'), 'anxiety treatment');
  });
  test('the site-restricted query is tried first, then an open one', () => {
    const [restricted, open] = cbhSources.buildQueries('Treatment options', 'Anxiety treatment');
    assert.ok(restricted.includes('site:'), 'precision first');
    assert.ok(!open.includes('site:'), 'then breadth, with isAllowed doing the filtering');
  });
  test('more than one authority is tried before a section is given up on', () => {
    assert.ok(cbhSources.MAX_URL_ATTEMPTS > 1,
      'stopping at the first allowed URL left a section unsourced whenever that one blocked scrapers');
  });
  test('the brief carries the source TEXT, not just the URL', () => {
    // The lookup was paid for, cited, and then discarded: the excerpt never
    // reached the brief, so the writer never saw what it was citing.
    const b = cbhBrief.normalizeCbhBrief({
      educational: { h3s: [{ heading: 'X', source: 'fallback', sourceUrl: 'https://www.cdc.gov/a', sourceExcerpt: 'Real source text.' }] },
    });
    assert.strictEqual(b.educational.h3s[0].sourceExcerpt, 'Real source text.');
  });
  test('a sourced section is told to write from its source; an unsourced one is not', () => {
    const prompt = cbhWriter.userPrompt({
      scaffold: cbhFixture.scaffold(),
      primaryKeyword: cbhFixture.PRIMARY, secondaryKeywords: [],
      faqPlan: [],
      h3Plan: [
        { heading: 'From competitors', source: 'competitor' },
        { heading: 'From a source', source: 'fallback', sourceUrl: 'https://www.nimh.nih.gov/x', sourceExcerpt: 'NIMH states CBT is first-line.' },
        { heading: 'Unsourced', source: 'fallback', sourceUrl: '', sourceExcerpt: '' },
      ],
    });
    assert.ok(prompt.includes('NIMH states CBT is first-line.'), 'the source text reaches the writer');
    assert.ok(/WRITE THIS ONE FROM THE SOURCE BELOW/.test(prompt), 'and it is told to stay inside it');
    assert.ok(/nothing specific enough to need a citation/.test(prompt),
      'while an unsourced section is told to stay general rather than invent');
    // The competitor-backed section gets neither directive.
    const firstSection = prompt.slice(prompt.indexOf('1. From competitors'), prompt.indexOf('2. From a source'));
    assert.ok(!/WRITE THIS ONE FROM THE SOURCE/.test(firstSection));
  });

  // ── Em dashes ─────────────────────────────────────────────────────────────
  console.log('\nCBH - no em dash reaches a brief, a page or an export');
  const EM = '\u2014';

  test('an aside becomes a comma, not a run-on', () => {
    assert.strictEqual(
      cbhContract.removeEmDashes(`We treat the whole person ${EM} not just the symptom.`),
      'We treat the whole person, not just the symptom.');
  });
  test('an appositive keeps both of its commas', () => {
    assert.strictEqual(
      cbhContract.removeEmDashes(`Three formats ${EM} IOP, PHP and virtual ${EM} are offered here.`),
      'Three formats, IOP, PHP and virtual, are offered here.');
  });
  test('a dash with no spaces around it is still a dash', () => {
    assert.strictEqual(cbhContract.removeEmDashes(`care${EM}fast`), 'care, fast');
  });
  test('a dash opening a bullet becomes the canonical marker, not a comma', () => {
    // It is a MARKER, not punctuation: ", Evening sessions" would stop being a
    // bullet, and a bullet costs a different number of lines than the same
    // words as prose.
    const out = cbhContract.removeEmDashes(`${EM} Evening sessions are available.`);
    assert.strictEqual(out, '- Evening sessions are available.');
    assert.ok(cbhContract.isBullet(out), 'and it is still counted as a bullet');
  });
  test('a dash next to punctuation does not stack a comma on top', () => {
    assert.strictEqual(cbhContract.removeEmDashes(`Ask us. ${EM} We answer.`), 'Ask us. We answer.');
    assert.strictEqual(cbhContract.removeEmDashes(`options, ${EM} and more`), 'options, and more');
  });
  test('a trailing dash just goes', () => {
    assert.strictEqual(cbhContract.removeEmDashes(`Call today ${EM}`), 'Call today');
  });
  test('the en dash is left alone, because this module uses it structurally', () => {
    // Office labels ("Los Angeles – Mid Wilshire") are split on it, and it is a
    // legal bullet marker. Banning it would break both.
    const label = 'Los Angeles \u2013 Mid Wilshire';
    assert.strictEqual(cbhContract.removeEmDashes(label), label);
  });
  test('clean text is returned untouched', () => {
    const s = 'Anxiety treatment in Anaheim Hills, paced to you.';
    assert.strictEqual(cbhContract.removeEmDashes(s), s);
  });

  test('the brief cannot store an em dash the planner returned', () => {
    const b = cbhBrief.normalizeCbhBrief({
      meta: { title: `Anxiety Treatment ${EM} Anaheim Hills`, description: `Care that fits ${EM} today.` },
      educational: { h3s: [{
        heading: `Signs you may need support ${EM} and when`,
        intent: `What prompts people to seek care ${EM} and what does not.`,
        source: 'fallback', sourceUrl: 'https://www.cdc.gov/a',
        sourceExcerpt: `Anxiety disorders ${EM} the most common class ${EM} are treatable.`,
      }] },
      faqs: [{ q: `How soon can I start ${EM} realistically?`, type: 'location' }],
    });
    const everything = JSON.stringify(b);
    assert.ok(!everything.includes(EM), `an em dash survived into the brief: ${everything}`);
    // The source excerpt matters as much as the copy: it goes into the writer's
    // prompt, and clinical publishers use em dashes heavily.
    assert.ok(!b.educational.h3s[0].sourceExcerpt.includes(EM));
    // And the URL is untouched, not "cleaned".
    assert.strictEqual(b.educational.h3s[0].sourceUrl, 'https://www.cdc.gov/a');
  });

  test('the writer cannot put an em dash on a page', () => {
    const l3 = cbhFixture.passingL3();
    l3.hero.h1 = `Anxiety Treatment ${EM} Anaheim Hills`;
    l3.uvp = `We treat the whole person ${EM} not just the symptom.`;
    l3.educational.h3s[0].lines.push(`${EM} Evening appointments`);
    l3.faqs[0].a = `Usually within a week ${EM} sometimes sooner.`;
    const page = cbhCompose.mergeCbhL3(cbhFixture.scaffold(), l3);
    assert.ok(!JSON.stringify(page).includes(EM), 'an em dash survived the merge');
    assert.strictEqual(page.sections.uvp.paragraph, 'We treat the whole person, not just the symptom.');
  });

  test('a page saved before this rule existed is cleaned when it is read', () => {
    // The retroactive path: no regeneration, no billed call, just the read.
    const page = cbhCompose.mergeCbhL3(cbhFixture.scaffold(), cbhFixture.passingL3());
    page.sections.insurance.paragraph = `We accept most major insurance providers ${EM} ask us.`;
    page.meta.metaDescription = `Anxiety treatment in Anaheim Hills ${EM} get support.`;
    cbhCompose.refreshCbhDerived(page, {
      client: { brand_static: { base_url: 'https://clearbehavioralhealth.com' } },
      location: { city: 'Anaheim Hills', state_abbreviation: 'CA', location_page_url: '/locations/anaheim-hills/' },
    });
    assert.ok(!JSON.stringify(page.sections).includes(EM));
    // The JSON-LD quotes the meta and the FAQs, so it has to be built AFTER the
    // strip or it ships the dash the page no longer has.
    assert.ok(!JSON.stringify(page.schema).includes(EM), 'the schema was rebuilt from the cleaned copy');
  });

  test('a URL on the page is never rewritten by the strip', () => {
    const page = cbhCompose.mergeCbhL3(cbhFixture.scaffold(), cbhFixture.passingL3());
    page.sections.educational.h3s[0].sourceUrl = 'https://www.nimh.nih.gov/health/topics/anxiety';
    cbhCompose.stripCbhEmDashes(page);
    assert.strictEqual(page.sections.educational.h3s[0].sourceUrl,
      'https://www.nimh.nih.gov/health/topics/anxiety');
  });

  test('QC reports an em dash a reviewer typed, and says where', () => {
    const page = cbhCompose.mergeCbhL3(cbhFixture.scaffold(), cbhFixture.passingL3());
    cbhCompose.applyProvenance(page, cbhFixture.passingProvenance());
    page.primaryKeyword = cbhFixture.PRIMARY;
    // Assigned AFTER the merge, which is the only way one gets onto a page:
    // the reviewer edits the field and presses Recheck before saving.
    page.sections.uvp.paragraph = `Care that fits ${EM} and a team that stays.`;
    const check = cbhQc.runCbhCheck(page, 'no_em_dash');
    assert.strictEqual(check.pass, false);
    assert.ok(/Why Choose/.test(check.detail), `the detail names the section: ${check.detail}`);
    assert.strictEqual(check.severity, 'Major');
  });

  test('QC passes the fixture, so the gate does not fire on a clean page', () => {
    const page = cbhCompose.mergeCbhL3(cbhFixture.scaffold(), cbhFixture.passingL3());
    cbhCompose.applyProvenance(page, cbhFixture.passingProvenance());
    page.primaryKeyword = cbhFixture.PRIMARY;
    assert.strictEqual(cbhQc.runCbhCheck(page, 'no_em_dash').pass, true);
  });

  test('the export cleans a page that was never saved', () => {
    // The export routes deliberately render WHAT IS ON SCREEN, so an unsaved
    // edit has not been through the save path that would have stripped it.
    const page = cbhCompose.mergeCbhL3(cbhFixture.scaffold(), cbhFixture.passingL3());
    page.sections.service.paragraph = `Care in Anaheim Hills ${EM} five days a week.`;
    const md = exporter.toCbhMarkdown(page);
    assert.ok(!md.includes(EM), 'an em dash reached the exported document');
    // And the caller's own object is not mutated by exporting it.
    assert.ok(page.sections.service.paragraph.includes(EM), 'the export worked on a copy');
  });

  test('the provenance annotation in the export carries no em dash either', () => {
    const label = exporter.cbhProvenanceLabel({ source: 'fallback', sourceUrl: 'https://www.cdc.gov/a' });
    assert.ok(!label.includes(EM), `the deliverable must be searchably clean: ${label}`);
  });

  test('every model-facing CBH prompt bans the em dash and uses none itself', () => {
    // A prompt that spends forty em dashes telling a model not to write one is
    // an argument it will lose.
    const writer = cbhWriter.systemPrompt() + cbhWriter.userPrompt({
      scaffold: cbhFixture.scaffold(),
      primaryKeyword: cbhFixture.PRIMARY, secondaryKeywords: [],
      h3Plan: [{ heading: 'Signs you may need support', intent: 'What prompts people to seek care.', source: 'competitor' }],
      faqPlan: [{ q: 'How soon can I start?', type: 'location' }],
    });
    const planner = cbhBrief.planPrompt({
      serviceName: cbhFixture.SERVICE, conditionName: cbhFixture.CONDITION, city: cbhFixture.CITY,
      primaryKeyword: cbhFixture.PRIMARY, competitorHeadings: [], competitorFaqs: [],
    });
    [['writer', writer], ['planner', planner.system + planner.user]].forEach(([name, text]) => {
      assert.ok(/em dash/i.test(text), `the ${name} prompt does not state the rule`);
      // The one em dash each prompt may contain is the character it names.
      const stray = text.split(EM).length - 1;
      assert.strictEqual(stray, 1,
        `the ${name} prompt uses ${stray} em dashes; only the one in "(\u2014)" naming the rule is allowed`);
    });
  });

  // ── CMS JSON shape ────────────────────────────────────────────────────────
  console.log('\nCBH - the CMS payload matches the client\'s sample');

  // One built page, reused: every assertion below is about the same export.
  const cmsPage = (() => {
    const p = cbhCompose.mergeCbhL3(cbhFixture.scaffold(), cbhFixture.passingL3());
    cbhCompose.applyProvenance(p, cbhFixture.passingProvenance());
    p.primaryKeyword = cbhFixture.PRIMARY;
    return p;
  })();

  test('the banner heading bolds the city', () => {
    const json = exporter.toCbhCmsJson(cmsPage, {});
    assert.ok(json.banner.heading.includes(`<strong>${cbhFixture.CITY}</strong>`),
      `expected the city in bold: ${json.banner.heading}`);
  });
  test('the bold survives the sentence-case pass with the city still capitalised', () => {
    // The order matters: casing first, then the tag. Wrapping first would hand
    // sentenceCase a token starting "<strong>" and lower-case the city inside it.
    const json = exporter.toCbhCmsJson(cmsPage, {});
    assert.ok(!/<strong>anaheim/i.test(json.banner.heading) || /<strong>Anaheim Hills<\/strong>/.test(json.banner.heading),
      `the city lost its capitals: ${json.banner.heading}`);
    assert.ok(/^[A-Z]/.test(json.banner.heading), 'and the heading still opens with a capital');
  });
  test('only the banner carries markup; the other headings stay plain', () => {
    const json = exporter.toCbhCmsJson(cmsPage, {});
    [json.page_title, json.treatment.heading, json.experts.heading, json.what_is.heading]
      .forEach(h => assert.ok(!/<(b|strong)>/.test(h), `unexpected markup in "${h}"`));
  });
  test('the city is bolded once, not at every mention', () => {
    const doubled = structuredClone(cmsPage);
    doubled.sections.hero.h1 = `Anxiety treatment in ${cbhFixture.CITY} for ${cbhFixture.CITY} residents`;
    const json = exporter.toCbhCmsJson(doubled, {});
    assert.strictEqual(json.banner.heading.split('<strong>').length - 1, 1);
    assert.ok(!json.banner.heading.includes('<b>'), 'the client asked for <strong>, not <b>');
  });
  test('a heading that never names the city exports unchanged', () => {
    // Should not happen -- a Critical gate requires the city in the H1 -- but an
    // export is the wrong place to start throwing.
    const noCity = structuredClone(cmsPage);
    noCity.sections.hero.h1 = 'Compassionate anxiety treatment';
    const json = exporter.toCbhCmsJson(noCity, {});
    assert.strictEqual(json.banner.heading, 'Compassionate anxiety treatment');
  });
  test('the Why Choose heading keeps its question mark', () => {
    const json = exporter.toCbhCmsJson(cmsPage, {});
    assert.strictEqual(json.why_choose.heading, 'Why choose Clear Behavioral Health?');
  });
  test('a stored heading that lost its question mark gets one back', () => {
    const stripped = structuredClone(cmsPage);
    stripped.sections.uvp.heading = 'Why choose Clear Behavioral Health';
    const json = exporter.toCbhCmsJson(stripped, {});
    assert.ok(json.why_choose.heading.endsWith('?'), json.why_choose.heading);
  });
  test('exporting does not mutate the page it was handed', () => {
    const before = JSON.stringify(cmsPage);
    exporter.toCbhCmsJson(cmsPage, {});
    assert.strictEqual(JSON.stringify(cmsPage), before, 'the export wrote back into the page object');
  });

  test('the code-side fallback plan is clean', () => {
    // It ships verbatim whenever the planner cannot run, so it is copy in its
    // own right rather than a prompt.
    const plan = cbhBrief.fallbackPlan({ serviceName: 'Anxiety treatment', city: 'Anaheim Hills' });
    assert.ok(!JSON.stringify(plan).includes(EM));
  });

  await require('./cbhFeedbackTests')({ test, testAsync, assert, setLlmStub: (fn) => { LLM_STUB = fn; } });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
