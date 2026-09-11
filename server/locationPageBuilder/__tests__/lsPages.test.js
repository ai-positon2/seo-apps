// ── Tests for the template-driven engine (docs/ybh-ls-pages.md) ─────────────
// No test framework is configured in this app, so this is a zero-dependency
// runner using Node's built-in assert, matching __tests__/run.js.
// Run: node locationPageBuilder/__tests__/lsPages.test.js
//
// Everything covered here is deterministic: the profile resolver, the ladders'
// grammar, the brief normalizer's repairs, the writer's brief-alignment and
// length logic, the QC gates, and the exporters. The model calls themselves are
// not exercised — what IS exercised is every code path that has to hold when
// the model returns something unusable, which is where the real risk sits.

const assert = require('assert');
const config = require('../config');
const lsProfiles = require('../lsProfiles');
const lsLadder = require('../lsLadder');
const lsBrief = require('../lsBrief');
const lsWriter = require('../lsWriter');
const lsQa = require('../lsQa');
const lsCompose = require('../lsCompose');
const lsSeed = require('../lsSeed');
const exporter = require('../exporter');
const schemaGenerator = require('../schemaGenerator');
const internalLinks = require('../internalLinks');
const text = require('../text');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); passed++; }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); failed++; }
}

// ── Fixtures ────────────────────────────────────────────────────────────────
const CLIENT = {
  id: 'client_clear_behavioral_health',
  name: 'Clear Behavioral Health',
  brand_static: { base_url: 'https://www.clearbehavioralhealth.com' },
  brand_rules: { ymyl: true, prohibited_claims: ['guaranteed cure', '100% effective'] },
  global_template_id: 'gt_clear_behavioral_location_service',
};
const SERVICE = {
  id: 'cbh_svc_anxiety-treatment', client_id: CLIENT.id, name: 'Anxiety Treatment',
  slug: 'anxiety-treatment', category: 'condition',
  conditions_treated: ['Anxiety', 'Panic disorder'], parent_service_url: '/services/anxiety-treatment/',
};
const LOCATION = {
  id: 'cbh_loc_torrance', client_id: CLIENT.id, location_name: 'Torrance', city: 'Torrance',
  state: 'California', state_abbreviation: 'CA', street_address: '1 Example St', zip_code: '90503',
  phone_number: '(310) 555-0100', location_slug: 'torrance',
  location_page_url: '/locations/torrance/', serving_areas: ['Redondo Beach', 'Carson'],
  ages_served: 'Adults 18+', directions_url: 'https://maps.example/torrance',
  services_available_ids: [SERVICE.id],
};
const SIBLING = {
  ...LOCATION, id: 'cbh_loc_long-beach', location_name: 'Long Beach', city: 'Long Beach',
  location_slug: 'long-beach', location_page_url: '/locations/long-beach/',
};
const TEMPLATE = { id: CLIENT.global_template_id, page_type: 'ls_location_service', schema_skeletons: { business_type: 'MedicalBusiness' } };
const PROFILE = lsProfiles.resolveProfile(CLIENT);

function layers(overrides = {}) {
  return {
    client: CLIENT, service: SERVICE, location: LOCATION, template: TEMPLATE,
    allServices: [SERVICE], providers: [], reviews: [], resources: [], servicesAtLocation: [SERVICE],
    ...overrides,
  };
}

const briefCtx = (overrides = {}) => ({
  service: SERVICE, location: LOCATION, budgets: PROFILE.budgets,
  brandName: CLIENT.name,
  primaryKeyword: 'anxiety treatment torrance',
  primaryPhrases: ['anxiety treatment torrance'],
  secondaryPhrases: ['anxiety therapy cost', 'panic attack help', 'teen anxiety support'],
  keywordPhrases: ['anxiety treatment torrance', 'anxiety therapy cost', 'panic attack help', 'teen anxiety support'],
  competitors: [],
  ...overrides,
});

// ── Profiles ────────────────────────────────────────────────────────────────
console.log('\nlsProfiles');

test('resolves brand facts from the client row, not from config', () => {
  assert.strictEqual(PROFILE.brandName, 'Clear Behavioral Health');
  assert.strictEqual(PROFILE.ownDomain, 'clearbehavioralhealth.com', 'www must be stripped');
  assert.strictEqual(PROFILE.ymyl, true);
  assert.deepStrictEqual(PROFILE.prohibitedClaims, ['guaranteed cure', '100% effective']);
});

test('per-client config overrides merge one level deep onto the defaults', () => {
  const merged = lsProfiles.mergeBudgets(config.lsPages.defaults, { faqs: { max: 6 } });
  assert.strictEqual(merged.faqs.max, 6, 'the override applies');
  assert.strictEqual(merged.faqs.min, config.lsPages.defaults.faqs.min, 'siblings survive');
  assert.strictEqual(merged.faqs.minLocalized, config.lsPages.defaults.faqs.minLocalized);
});

test('budgetsFor resolves without a store or a client row', () => {
  const b = lsProfiles.budgetsFor(CLIENT.id);
  assert.strictEqual(b.metaDescription.min, 140, 'template §4');
  assert.strictEqual(b.metaDescription.max, 160);
  assert.strictEqual(b.seoTitle.min, 50, 'template §3');
  assert.strictEqual(b.faqs.min, 5, 'template §9');
  assert.strictEqual(b.faqs.max, 7);
  assert.strictEqual(b.sectionChars.min, 500, 'template §7');
  assert.strictEqual(b.sectionChars.max, 700);
});

test('the URL comes from the profile pattern (template §2)', () => {
  assert.strictEqual(lsProfiles.lsPageUrl(PROFILE, LOCATION, SERVICE), '/locations/torrance/anxiety-treatment');
  const trailing = { ...PROFILE, trailingSlash: true };
  assert.strictEqual(lsProfiles.lsPageUrl(trailing, LOCATION, SERVICE), '/locations/torrance/anxiety-treatment/');
  const custom = { ...PROFILE, urlPattern: '/{service_slug}/{location_slug}' };
  assert.strictEqual(lsProfiles.lsPageUrl(custom, LOCATION, SERVICE), '/anxiety-treatment/torrance');
});

test('a location with no slug still yields a usable URL', () => {
  const url = lsProfiles.lsPageUrl(PROFILE, { city: 'Long Beach' }, SERVICE);
  assert.strictEqual(url, '/locations/long-beach/anxiety-treatment');
});

test('the seed qualifier is added only when the seed does not imply it', () => {
  assert.strictEqual(lsProfiles.qualifySeed('IOP Long Beach CA', PROFILE), 'mental health IOP Long Beach CA');
  assert.strictEqual(lsProfiles.qualifySeed('mental health therapy Torrance', PROFILE), 'mental health therapy Torrance');
  assert.strictEqual(lsProfiles.qualifySeed('anything', { seedQualifier: '' }), 'anything');
});

// ── Ladders ─────────────────────────────────────────────────────────────────
console.log('\nlsLadder');

test('condition rungs use the CONDITION, not the service name', () => {
  const headings = lsLadder.ladderHeadings(SERVICE);
  assert.ok(headings.includes('Symptoms of Anxiety'), `got ${JSON.stringify(headings)}`);
  assert.ok(!headings.some(h => /Symptoms of Anxiety Treatment/.test(h)),
    'a condition rung built from the service name is not about anything searchable');
  assert.ok(headings.some(h => h.includes('Anxiety Treatment')),
    'the service name still appears where the rung is about the service');
});

test('the condition falls back to stripping service words when none is on record', () => {
  assert.strictEqual(lsLadder.conditionNameOf({ name: 'Depression Treatment' }), 'Depression');
  assert.strictEqual(lsLadder.conditionNameOf({ name: 'Grief Counseling' }), 'Grief');
  assert.strictEqual(lsLadder.conditionNameOf({ name: 'Anxiety', conditions_treated: ['Panic disorder'] }), 'Panic disorder');
});

test('articles read as English across every service shape', () => {
  const first = s => lsLadder.ladderHeadings(s)[0];
  assert.strictEqual(first({ name: 'Depression Treatment', category: 'condition' }), 'What Is Depression?');
  assert.strictEqual(first({ name: 'PTSD Treatment', category: 'condition' }), 'What Is PTSD?');
  assert.strictEqual(first({ name: 'Psychotherapy', category: 'therapy' }), 'What Is Psychotherapy?');
  assert.strictEqual(first({ name: 'Intensive Outpatient Program', category: 'program' }), 'What Is an Intensive Outpatient Program?');
  assert.strictEqual(first({ name: 'Psychiatrist', category: 'therapy' }), 'What Does a Psychiatrist Do?');
});

test('the ladder is picked by name before category, so a mis-tagged row is not mangled', () => {
  assert.strictEqual(lsLadder.pickLadder({ name: 'Psychiatrist', category: 'condition' }), lsLadder.PRACTITIONER_LADDER);
  assert.strictEqual(lsLadder.pickLadder({ name: 'Partial Hospitalization Program', category: 'condition' }), lsLadder.PROGRAM_LADDER);
});

// ── Brief normalization ─────────────────────────────────────────────────────
console.log('\nlsBrief');

test('a too-short section list is topped up from the ladder', () => {
  const brief = lsBrief.normalizeBrief({ sections: [{ h2: 'What Is Anxiety?', paragraphs: 2 }] }, briefCtx());
  assert.ok(brief.sections.length >= PROFILE.budgets.blocks.min,
    `expected at least ${PROFILE.budgets.blocks.min}, got ${brief.sections.length}`);
});

test('a too-long section list is trimmed to the band', () => {
  const sections = Array.from({ length: 14 }, (_, i) => ({ h2: `Heading ${i}`, paragraphs: 3 }));
  const brief = lsBrief.normalizeBrief({ sections }, briefCtx());
  assert.strictEqual(brief.sections.length, PROFILE.budgets.blocks.max);
});

test('paragraphs are clamped and a char budget is always attached', () => {
  const brief = lsBrief.normalizeBrief({ sections: [{ h2: 'A topic here', paragraphs: 99 }] }, briefCtx());
  // Found by heading, not by index: the keyword-anchor repair can prepend a
  // ladder rung, so position 0 is not necessarily the section under test.
  const section = brief.sections.find(s => s.h2 === 'A topic here');
  assert.strictEqual(section.paragraphs, PROFILE.budgets.paragraphsPerBlock.max);
  brief.sections.forEach((s) => {
    assert.deepStrictEqual(s.charLimit, {
      min: PROFILE.budgets.sectionChars.min, max: PROFILE.budgets.sectionChars.max,
    }, `${s.h2} carries no budget`);
  });
});

test('duplicate and boilerplate headings are dropped', () => {
  const brief = lsBrief.normalizeBrief({
    sections: [
      { h2: 'What Is Anxiety?' }, { h2: 'what is anxiety?' },
      { h2: 'Meet Our Team' }, { h2: 'Insurance We Accept' },
    ],
  }, briefCtx());
  const headings = brief.sections.map(s => s.h2.toLowerCase());
  assert.strictEqual(headings.filter(h => h === 'what is anxiety?').length, 1, 'de-duplicated');
  assert.ok(!headings.some(h => h.includes('meet our team')), 'nav/brand furniture rejected');
});

test('exactly one section is marked to carry the city', () => {
  const many = lsBrief.normalizeBrief({
    sections: Array.from({ length: 6 }, (_, i) => ({ h2: `Topic number ${i}`, localize: true })),
  }, briefCtx());
  assert.strictEqual(many.sections.filter(s => s.localize).length, 1, 'never more than one');

  const none = lsBrief.normalizeBrief({
    sections: Array.from({ length: 6 }, (_, i) => ({ h2: `Topic number ${i}` })),
  }, briefCtx());
  assert.strictEqual(none.sections.filter(s => s.localize).length, 1, 'never fewer than one');
  assert.strictEqual(none.sections[0].localize, false, 'not the definition section');
});

test('a section heading is promoted so the keyword-in-a-heading gate can pass', () => {
  const brief = lsBrief.normalizeBrief({
    sections: Array.from({ length: 6 }, (_, i) => ({ h2: `Unrelated topic ${i}` })),
  }, briefCtx());
  const geo = new Set([...text.words('Torrance'), ...text.words('CA')]);
  assert.ok(
    brief.sections.some(s => text.matchAnyKeyword(s.h2, ['anxiety treatment torrance'], geo)),
    `no heading carries the keyword terms: ${JSON.stringify(brief.sections.map(s => s.h2))}`,
  );
});

test('the FAQ list lands inside the template band and is topped up when short', () => {
  const brief = lsBrief.normalizeBrief({ sections: [{ h2: 'What Is Anxiety?' }], faqs: [{ question: 'Does it help?' }] }, briefCtx());
  assert.ok(brief.faqs.length >= PROFILE.budgets.faqs.min, `got ${brief.faqs.length}`);
  assert.ok(brief.faqs.length <= PROFILE.budgets.faqs.max);
});

test('a city is only attached to a question whose answer depends on it (§9)', () => {
  assert.strictEqual(lsBrief.isLocalizableQuestion('What types of anxiety treatment are available in Torrance?'), true);
  assert.strictEqual(lsBrief.isLocalizableQuestion('Does anxiety treatment hurt?'), false);
  assert.strictEqual(lsBrief.isLocalizableQuestion('How long does anxiety treatment take?'), false);
  assert.strictEqual(lsBrief.isLocalizableQuestion('Is anxiety treatment safe for teens?'), false);
});

test('a universal question never keeps a localize flag the model set', () => {
  const brief = lsBrief.normalizeBrief({
    sections: [{ h2: 'What Is Anxiety?' }],
    faqs: [
      { question: 'Is anxiety treatment safe?', localize: true },
      { question: 'What options are available at your Torrance office?', localize: true },
    ],
  }, briefCtx());
  const unsafe = brief.faqs.find(f => /safe/i.test(f.question));
  assert.strictEqual(unsafe.localize, false, 'a universal question must not be localized');
});

test('keywords are mapped to the section they relate to, never to all of them (§11)', () => {
  const brief = lsBrief.normalizeBrief({
    sections: [
      { h2: 'What Is Anxiety?' },
      { h2: 'How Much Does Anxiety Therapy Cost?' },
      { h2: 'Support for Teen Anxiety' },
      { h2: 'When Panic Attacks Need Help' },
      { h2: 'What to Expect From Treatment' },
    ],
  }, briefCtx());
  const cost = brief.sections.find(s => /cost/i.test(s.h2));
  assert.ok(cost.keywords.includes('anxiety therapy cost'), `got ${JSON.stringify(cost.keywords)}`);
  const assignedTwice = brief.sections.flatMap(s => s.keywords);
  assert.strictEqual(new Set(assignedTwice).size, assignedTwice.length, 'no keyword is assigned twice');
  assert.deepStrictEqual(brief.keywordMap.seoTitle, ['anxiety treatment torrance'], '§11 maps the primary to the title');
});

test('the fallback brief is usable with no competitor data at all', () => {
  const brief = lsBrief.fallbackBrief(briefCtx());
  assert.strictEqual(brief.competitorQuality, 'unavailable');
  assert.ok(brief.sections.length >= PROFILE.budgets.blocks.min);
  assert.ok(brief.faqs.length >= PROFILE.budgets.faqs.min);
  assert.ok(brief.sections.every(s => s.instructions), 'every section carries writing instructions');
  assert.strictEqual(brief.approved, false, 'a planned brief is never pre-approved');
});

// ── Writer ──────────────────────────────────────────────────────────────────
console.log('\nlsWriter');

const APPROVED_BRIEF = lsBrief.normalizeBrief({
  sections: [
    { h2: 'What Is Anxiety?', paragraphs: 2 },
    { h2: 'Symptoms of Anxiety', paragraphs: 2 },
    { h2: 'Anxiety Treatment Options in Torrance', paragraphs: 2, localize: true },
    { h2: 'How Much Does Anxiety Therapy Cost?', paragraphs: 2 },
    { h2: 'What to Expect From Treatment', paragraphs: 2 },
  ],
  faqs: [
    { question: 'What types of anxiety treatment are available in Torrance?', localize: true },
    { question: 'How do I know if I need professional anxiety treatment?' },
    { question: 'How long does anxiety treatment usually take?' },
    { question: 'Does Clear Behavioral Health accept insurance for anxiety treatment?', localize: true },
    { question: 'What should I expect during my first appointment?' },
  ],
}, briefCtx());

test('a response matching the brief has its approved headings restored', () => {
  const l3 = {
    sections: APPROVED_BRIEF.sections.map((s, i) => ({ h2: `Reworded ${i}`, html: '<p>Copy.</p>' })),
    faqs: APPROVED_BRIEF.faqs.map(() => ({ q: 'Reworded question?', a: 'Answer.' })),
  };
  const aligned = lsWriter.alignToBrief(l3, APPROVED_BRIEF);
  assert.deepStrictEqual(aligned.sections.map(s => s.h2), APPROVED_BRIEF.sections.map(s => s.h2));
  assert.deepStrictEqual(aligned.faqs.map(f => f.q), APPROVED_BRIEF.faqs.map(f => f.question));
});

test('a response with the wrong section count keeps its own headings', () => {
  const l3 = { sections: [{ h2: 'Only one', html: '<p>x</p>' }], faqs: [] };
  assert.strictEqual(lsWriter.matchesBrief(l3, APPROVED_BRIEF), false);
  const aligned = lsWriter.alignToBrief(l3, APPROVED_BRIEF);
  assert.strictEqual(aligned.sections[0].h2, 'Only one',
    'stamping a heading by position onto a mismatched list puts the wrong heading over the wrong copy');
});

test('deviation is zero only when every length is in band', () => {
  const inBand = {
    seoTitle: 'Anxiety Treatment in Torrance, CA | Clear Behavioral',
    metaDescription: 'x'.repeat(150),
    sections: APPROVED_BRIEF.sections.map(() => ({ html: `<p>${'word '.repeat(110)}</p>` })),
  };
  assert.strictEqual(lsWriter.deviation(inBand, APPROVED_BRIEF, PROFILE.budgets), 0,
    `title ${inBand.seoTitle.length} chars, section ${lsWriter.sectionCharCount(inBand.sections[0].html)} chars`);

  const short = { ...inBand, metaDescription: 'too short' };
  assert.ok(lsWriter.deviation(short, APPROVED_BRIEF, PROFILE.budgets) > 0, 'a short meta description is a deviation');
});

test('an over-long title and meta description are trimmed without ending mid-thought', () => {
  const out = lsWriter.normalizeLengths({
    seoTitle: 'Anxiety Treatment in Torrance, California for Adults and Teens With Panic Disorder',
    metaDescription: `${'Compassionate anxiety treatment in Torrance for adults. '.repeat(6)}`,
  }, PROFILE.budgets);
  assert.ok(out.seoTitle.length <= PROFILE.budgets.seoTitle.max, `title was ${out.seoTitle.length}`);
  assert.ok(out.metaDescription.length <= PROFILE.budgets.metaDescription.max, `meta was ${out.metaDescription.length}`);
  assert.ok(!/\s(and|for|with|the|to|of|in)$/i.test(out.seoTitle.replace(/[.!?]$/, '')),
    `title ends on a function word: "${out.seoTitle}"`);
});

test('the writer prompt carries the brand rules and the no-invention line', () => {
  const system = lsWriter.systemPrompt({ brandName: CLIENT.name, profile: PROFILE, budgets: PROFILE.budgets });
  assert.ok(system.includes('guaranteed cure'), 'the prohibited-claims list reaches the prompt');
  assert.ok(/YMYL/.test(system), 'the YMYL posture reaches the prompt');
  assert.ok(/No prices or costs/i.test(system), '§13 prohibitions reach the prompt');
  assert.ok(/REQUIRES CLIENT CONFIRMATION/.test(system), 'the escape hatch reaches the prompt');
});

test('the user prompt states each section budget and forbids the pasted keyword form', () => {
  const user = lsWriter.buildUserPrompt({
    service: SERVICE, location: LOCATION,
    locationInfo: lsCompose.buildLocationInfo(LOCATION),
    brandName: CLIENT.name, brief: APPROVED_BRIEF,
    primaryKeyword: 'anxiety treatment torrance', secondaryKeywords: ['anxiety therapy cost'],
    budgets: PROFILE.budgets,
  });
  assert.ok(user.includes('500-700 characters'), 'the per-section budget is stated');
  assert.ok(user.includes('Anxiety Treatment Torrance'), 'the wrong (pasted) form is shown back concretely');
  assert.ok(user.includes('(310) 555-0100'), 'facts on record are offered to the writer');
});

test('facts NOT on record are named as forbidden in the prompt', () => {
  const bare = { ...LOCATION, phone_number: '', ages_served: '', serving_areas: [], nearby_areas: [] };
  const user = lsWriter.buildUserPrompt({
    service: SERVICE, location: bare,
    locationInfo: lsCompose.buildLocationInfo(bare),
    brandName: CLIENT.name, brief: APPROVED_BRIEF,
    primaryKeyword: 'anxiety treatment torrance', secondaryKeywords: [],
    budgets: PROFILE.budgets,
  });
  assert.ok(/do not state or imply/i.test(user));
  assert.ok(user.includes('PHONE NUMBER REQUIRED FROM CLIENT'));
});

// ── Compose ─────────────────────────────────────────────────────────────────
console.log('\nlsCompose');

test('missing location fields are flagged with the template §6 wording', () => {
  const info = lsCompose.buildLocationInfo({ city: 'Torrance', state_abbreviation: 'CA' });
  assert.deepStrictEqual(info.dataRequired, [
    'LOCATION ADDRESS REQUIRED FROM CLIENT',
    'PHONE NUMBER REQUIRED FROM CLIENT',
    'SERVING AREAS REQUIRED FROM CLIENT',
    'AGES SERVED REQUIRED FROM CLIENT',
    'MAP / DIRECTIONS REQUIRED FROM CLIENT',
  ]);
});

test('a fully populated location flags nothing', () => {
  assert.deepStrictEqual(lsCompose.buildLocationInfo(LOCATION).dataRequired, []);
});

test('nearby_areas satisfies SERVING AREAS, so the data is not entered twice', () => {
  const info = lsCompose.buildLocationInfo({ ...LOCATION, serving_areas: undefined, nearby_areas: ['Carson'] });
  assert.deepStrictEqual(info.servingAreas, ['Carson']);
  assert.ok(!info.dataRequired.includes('SERVING AREAS REQUIRED FROM CLIENT'));
});

test('the scaffold carries the fallback title and H1 shapes (§3, §5)', () => {
  const scaffold = lsCompose.buildLsScaffold(layers(), PROFILE);
  assert.strictEqual(scaffold.meta.title, 'Anxiety Treatment in Torrance | Clear Behavioral Health');
  assert.strictEqual(scaffold.sections.hero.h1, 'Anxiety Treatment in Torrance');
  assert.strictEqual(scaffold.meta.urlPath, '/locations/torrance/anxiety-treatment');
  assert.strictEqual(scaffold.meta.canonical, 'https://www.clearbehavioralhealth.com/locations/torrance/anxiety-treatment');
  assert.strictEqual(scaffold.brief, null, 'a fresh scaffold has no brief');
  assert.ok(lsCompose.isLsScaffold(scaffold));
});

test('a location brand name overrides the client name', () => {
  assert.strictEqual(lsCompose.lsBrandName({ brand_name: 'South Bay Clear' }, PROFILE), 'South Bay Clear');
  assert.strictEqual(lsCompose.lsBrandName({}, PROFILE), 'Clear Behavioral Health');
});

test('merging L3 keeps the brief on each block and normalizes its HTML', () => {
  const scaffold = lsCompose.buildLsScaffold(layers(), PROFILE);
  lsCompose.mergeLsL3(scaffold, {
    seoTitle: 'Anxiety Treatment in Torrance, CA | Clear Behavioral',
    metaDescription: 'x'.repeat(150),
    h1: 'Anxiety Treatment in Torrance: Support That Fits Your Life',
    heroOneLiner: 'One sentence.',
    // Loose text outside any <p> is a formatting defect with a safe repair.
    sections: APPROVED_BRIEF.sections.map(() => ({ h2: 'ignored', html: 'bare copy' })),
    faqIntro: 'An intro.',
    faqs: APPROVED_BRIEF.faqs.map(f => ({ q: f.question, a: 'An answer.' })),
  }, APPROVED_BRIEF, PROFILE.budgets);

  assert.deepStrictEqual(
    scaffold.sections.body.blocks.map(b => b.h2),
    APPROVED_BRIEF.sections.map(s => s.h2),
    'the approved headings win over whatever the writer returned',
  );
  assert.strictEqual(scaffold.sections.body.blocks[0].html, '<p>bare copy</p>', 'loose text is wrapped');
  assert.ok(scaffold.sections.body.blocks[0].instructions, 'the brief travels with the block');
  assert.strictEqual(scaffold.sections.faq.items.length, APPROVED_BRIEF.faqs.length);
});

// ── QC ──────────────────────────────────────────────────────────────────────
console.log('\nlsQa');

// A page that should PASS everything, built to the budgets rather than by hand
// so the fixture cannot drift away from the gates it is meant to satisfy.
function passingPage() {
  const scaffold = lsCompose.buildLsScaffold(layers(), PROFILE);
  scaffold.primaryKeyword = 'anxiety treatment torrance';
  scaffold.primaryKeywords = ['anxiety treatment torrance'];
  scaffold.secondaryKeywords = ['anxiety therapy cost'];
  scaffold.brief = { ...APPROVED_BRIEF, approved: true, approvedAt: new Date().toISOString() };
  scaffold.meta.title = 'Anxiety Treatment in Torrance, CA | Clear Behavior';
  scaffold.meta.metaDescription = `Compassionate anxiety treatment in Torrance for adults who want practical support. Ask about an assessment and the next available appointment.`;
  scaffold.sections.hero.h1 = 'Anxiety Treatment in Torrance: Practical Support for Daily Life';
  scaffold.sections.hero.oneLiner = 'At Clear Behavioral Health we provide anxiety treatment in Torrance for adults who want steady, practical help with worry, panic and the sleepless nights that follow them around.';
  const paragraph = `${'Anxiety is a normal response to pressure that becomes a problem when it does not settle again. '.repeat(1)}${'Our clinicians explain each step so you know what to expect before anything begins here. '.repeat(2)}`;
  scaffold.sections.body.blocks = APPROVED_BRIEF.sections.map((s, i) => ({
    h2: s.h2,
    html: `<p>${paragraph}</p><p>${i === 2 ? 'People come to our Torrance practice from across the South Bay, and we talk through which option fits before starting. ' : ''}${paragraph}</p>`,
    instructions: s.instructions, keywords: s.keywords, charLimit: s.charLimit, source: s.source,
  }));
  scaffold.sections.faq.intro = 'These questions cover what people ask us most often before a first appointment, from how sessions run to what happens if you are unsure whether you need care at all.';
  scaffold.sections.faq.items = APPROVED_BRIEF.faqs.map(f => ({
    q: f.question,
    // The brief marks two questions as genuinely location-dependent, so their
    // answers name the city — that is what §9's localization floor asks for,
    // and a fixture that ignored it would not exercise the gate.
    a: f.localize
      ? 'Our Torrance team talks this through at the first appointment and agrees a plan with you before anything starts.'
      : 'We talk this through at the first appointment and agree a plan together before anything starts.',
  }));
  scaffold.sections.internalLinks = internalLinks.buildLsLinks({
    allLocations: [LOCATION, SIBLING], currentLocation: LOCATION, service: SERVICE,
    profile: PROFILE, lsPageUrl: lsProfiles.lsPageUrl,
  });
  scaffold.schema = schemaGenerator.generateLsSchema({ scaffold, client: CLIENT, location: LOCATION, service: SERVICE, profile: PROFILE });
  return scaffold;
}

const EXTRAS = { budgets: PROFILE.budgets, prohibitedClaims: PROFILE.prohibitedClaims, verticalWords: PROFILE.verticalWords };
const checkOf = (qc, id) => qc.checks.find(c => c.id === id);

test('every gate has a stable id, a severity and a fix', () => {
  const ids = lsQa.LS_CHECKS.map(c => c.id);
  assert.strictEqual(new Set(ids).size, ids.length, 'ids must be unique');
  lsQa.LS_CHECKS.forEach((c) => {
    assert.ok(['Critical', 'Major', 'Minor'].includes(c.severity), `${c.id} severity`);
    assert.ok(c.field, `${c.id} must name the field its failure belongs to`);
    assert.ok(c.fix, `${c.id} must tell the reviewer what to do`);
  });
});

test('a page built to the budgets clears every Critical gate', () => {
  const qc = lsQa.runLsQC(passingPage(), EXTRAS);
  const criticals = qc.checks.filter(c => c.severity === 'Critical' && !c.pass);
  assert.deepStrictEqual(criticals.map(c => `${c.id}: ${c.detail}`), [], 'the fixture must be satisfiable');
});

test('the gates enforce the template numbers, not their own', () => {
  const page = passingPage();
  page.meta.metaDescription = 'Too short for the template range.';
  const qc = lsQa.runLsQC(page, EXTRAS);
  const check = checkOf(qc, 'meta_description_length');
  assert.strictEqual(check.pass, false);
  assert.ok(check.detail.includes('140-160'), `got "${check.detail}"`);
  assert.strictEqual(qc.verdict, 'FAIL', 'a Critical failure is a FAIL');
});

test('a per-client override re-gates the same page', () => {
  const page = passingPage();
  const relaxed = { ...EXTRAS, budgets: lsProfiles.mergeBudgets(PROFILE.budgets, { metaDescription: { min: 10, max: 300 } }) };
  page.meta.metaDescription = 'Anxiety treatment in Torrance.';
  assert.strictEqual(checkOf(lsQa.runLsQC(page, EXTRAS), 'meta_description_length').pass, false);
  assert.strictEqual(checkOf(lsQa.runLsQC(page, relaxed), 'meta_description_length').pass, true);
});

test('the primary keyword is required in the title, H1, meta and hero (§13.3)', () => {
  const page = passingPage();
  page.meta.title = 'Support for Adults | Clear Behavioral Health';
  page.sections.hero.h1 = 'Support for Adults';
  page.sections.hero.oneLiner = 'We help adults who want steady, practical support with the things that keep them awake at night and make ordinary days feel much harder than they should.';
  const qc = lsQa.runLsQC(page, EXTRAS);
  ['primary_keyword_in_seo_title', 'primary_keyword_in_h1'].forEach((id) => {
    assert.strictEqual(checkOf(qc, id).pass, false, `${id} should fail`);
  });
  assert.strictEqual(checkOf(qc, 'hero_one_liner').pass, false, 'the hero must carry the keyword too');
});

test('a close natural variant satisfies the identity gates (§3, §4)', () => {
  const page = passingPage();
  // The keyword is "anxiety treatment torrance"; the title says it as English.
  page.meta.title = 'Anxiety Treatment in Torrance, CA | Clear Behavior';
  assert.strictEqual(checkOf(lsQa.runLsQC(page, EXTRAS), 'primary_keyword_in_seo_title').pass, true);
});

test('a section outside its character budget is flagged against that section', () => {
  const page = passingPage();
  page.sections.body.blocks[1].html = '<p>Far too short.</p>';
  const check = checkOf(lsQa.runLsQC(page, EXTRAS), 'section_char_budget');
  assert.strictEqual(check.pass, false);
  assert.ok(check.blocks && check.blocks[1], 'the finding is keyed to the block it came from');
});

test('the FAQ count band comes from the template (5-7)', () => {
  const page = passingPage();
  page.sections.faq.items = page.sections.faq.items.slice(0, 3);
  page.brief = { ...page.brief, faqs: page.brief.faqs.slice(0, 3) };
  const check = checkOf(lsQa.runLsQC(page, EXTRAS), 'faq_count');
  assert.strictEqual(check.pass, false);
  assert.ok(check.detail.includes('5-7'), `got "${check.detail}"`);
});

test('an unanswered FAQ is a Critical failure (§9)', () => {
  const page = passingPage();
  page.sections.faq.items[2].a = '';
  const check = checkOf(lsQa.runLsQC(page, EXTRAS), 'faq_answers_present');
  assert.strictEqual(check.pass, false);
  assert.strictEqual(check.severity, 'Critical');
});

test('a prohibited claim is a Critical failure', () => {
  const page = passingPage();
  page.sections.body.blocks[0].html = '<p>This is a guaranteed cure for anxiety.</p>';
  const check = checkOf(lsQa.runLsQC(page, EXTRAS), 'prohibited_claims');
  assert.strictEqual(check.pass, false);
  assert.ok(check.detail.includes('guaranteed cure'));
});

test('invented prices, phone numbers and insurance claims are caught (§13.17-22)', () => {
  const cases = [
    ['<p>Sessions start at $150 per hour for new clients here.</p>', 'a price'],
    ['<p>Call us on 310-555-0199 to book an assessment today.</p>', 'a phone number'],
    ['<p>We accept most major insurance plans including Aetna and Cigna.</p>', 'an insurance claim'],
    ['<p>Same-day appointments are always available at this location.</p>', 'an availability claim'],
  ];
  cases.forEach(([html, label]) => {
    const page = passingPage();
    page.sections.body.blocks[0].html = html;
    const check = checkOf(lsQa.runLsQC(page, EXTRAS), 'unverified_claims');
    assert.strictEqual(check.pass, false, `should flag ${label}: ${html}`);
    assert.ok(check.detail.includes(label), `expected "${label}" in "${check.detail}"`);
  });
});

test('copy the writer flagged for a human is not double-reported', () => {
  const page = passingPage();
  page.sections.body.blocks[0].html = '<p>Most major insurance plans are accepted. [REQUIRES CLIENT CONFIRMATION]</p>';
  assert.strictEqual(checkOf(lsQa.runLsQC(page, EXTRAS), 'unverified_claims').pass, true);
});

test('a keyword pasted in as a search string is flagged', () => {
  const page = passingPage();
  page.sections.body.blocks[0].html = '<p>Anxiety treatment Torrance patients trust is available now for adults who need it most and want to start soon.</p>';
  const check = checkOf(lsQa.runLsQC(page, EXTRAS), 'keyword_reads_naturally');
  assert.strictEqual(check.pass, false, check.detail);
});

test('the localization gates read the city from the record, not from the H1', () => {
  const page = passingPage();
  // A rewritten H1 that no longer matches "{Service} in {City}" must not break
  // the localization checks — this is exactly what the dental engine cannot do.
  page.sections.hero.h1 = 'Feeling Anxious in Torrance? Anxiety Treatment That Helps';
  const qc = lsQa.runLsQC(page, EXTRAS);
  assert.strictEqual(checkOf(qc, 'city_in_body').pass, true, checkOf(qc, 'city_in_body').detail);
  assert.strictEqual(checkOf(qc, 'city_in_faq').pass, true, checkOf(qc, 'city_in_faq').detail);
});

test('a city bolted onto a universal question is flagged as filler (§9)', () => {
  const page = passingPage();
  page.sections.faq.items[1].q = 'Is anxiety treatment safe in Torrance?';
  const check = checkOf(lsQa.runLsQC(page, EXTRAS), 'faq_localization_is_meaningful');
  assert.strictEqual(check.pass, false, check.detail);
});

test('an unapproved brief and drifted copy are both reported', () => {
  const page = passingPage();
  page.brief = { ...page.brief, approved: false, approvedAt: null };
  page.sections.body.blocks[0].h2 = 'Something else entirely';
  const qc = lsQa.runLsQC(page, EXTRAS);
  assert.strictEqual(checkOf(qc, 'brief_approved').pass, false);
  assert.strictEqual(checkOf(qc, 'copy_matches_brief').pass, false);
});

test('missing location data is reported as Minor, not as a copy defect', () => {
  const page = passingPage();
  page.sections.locationInfo = lsCompose.buildLocationInfo({ city: 'Torrance', state_abbreviation: 'CA' });
  const check = checkOf(lsQa.runLsQC(page, EXTRAS), 'location_data_complete');
  assert.strictEqual(check.pass, false);
  assert.strictEqual(check.severity, 'Minor');
  assert.ok(check.detail.includes('PHONE NUMBER REQUIRED FROM CLIENT'));
});

test('readability findings are keyed to the section they came from', () => {
  const page = passingPage();
  page.sections.body.blocks[0].html = `<p>${'word '.repeat(120)}</p>`;
  const check = checkOf(lsQa.runLsQC(page, EXTRAS), 'readability');
  assert.strictEqual(check.pass, false);
  assert.ok(check.blocks[0], 'the finding names block 0');
});

test('loose copy outside any <p>/<ul> is measured, not invisible', () => {
  const { nodes, looseWords } = lsQa.blockNodes('<p>Fine.</p> stray words here');
  assert.strictEqual(nodes.length, 1);
  assert.strictEqual(looseWords, 3);
});

test('a single check can be re-run and spliced back into a verdict', () => {
  const page = passingPage();
  // Short, but still carrying the primary keyword: the point of this test is
  // that ONE failing gate is refreshed, so only one may be failing.
  page.meta.metaDescription = 'Anxiety treatment in Torrance.';
  const full = lsQa.runLsQC(page, EXTRAS);
  assert.strictEqual(full.verdict, 'FAIL');
  assert.deepStrictEqual(
    full.checks.filter(c => c.severity === 'Critical' && !c.pass).map(c => c.id),
    ['meta_description_length'],
    'only the length gate may be failing',
  );

  page.meta.metaDescription = 'Compassionate anxiety treatment in Torrance for adults who want practical support. Ask about an assessment and the next available appointment.';
  const re = lsQa.recheckLs(page, 'meta_description_length', full.checks, EXTRAS);
  assert.strictEqual(re.check.pass, true);
  assert.strictEqual(re.checks.length, full.checks.length, 'the check is replaced, not appended');
  assert.notStrictEqual(re.verdict, 'FAIL', 'the verdict is re-derived from the merged set');
});

test('recheck falls back to a full pass when there is nothing to merge into', () => {
  const qc = lsQa.recheckLs(passingPage(), 'faq_count', null, EXTRAS);
  assert.ok(qc.checks.length > 1, 'a one-check PASS must never be written over a real result');
});

test('an unknown check id is an error, not a silent pass', () => {
  assert.throws(() => lsQa.runLsCheck(passingPage(), 'no_such_check', EXTRAS), /Unknown QC check/);
});

test('the limits served to the UI are the ones the gates use', () => {
  const limits = lsQa.lsLimits(CLIENT.id);
  assert.deepStrictEqual(limits.metaDescription, PROFILE.budgets.metaDescription);
  assert.deepStrictEqual(limits.faqs, PROFILE.budgets.faqs);
  assert.strictEqual(limits.paragraphWords.max, PROFILE.budgets.paragraphWords.hardMax);
});

// ── Internal links, schema, exports ─────────────────────────────────────────
console.log('\nlinks / schema / export');

test('sibling links use the profile URL pattern, not the location page path', () => {
  const links = internalLinks.buildLsLinks({
    allLocations: [LOCATION, SIBLING], currentLocation: LOCATION, service: SERVICE,
    profile: PROFILE, lsPageUrl: lsProfiles.lsPageUrl,
  });
  const sibling = links.find(l => l.link_type === 'sibling_location');
  assert.strictEqual(sibling.url, '/locations/long-beach/anxiety-treatment');
  assert.ok(links.length >= PROFILE.budgets.internalLinksMin, `only ${links.length} links`);
});

test('a location that does not offer the service is not linked', () => {
  const links = internalLinks.buildLsLinks({
    allLocations: [LOCATION, { ...SIBLING, services_available_ids: [] }],
    currentLocation: LOCATION, service: SERVICE, profile: PROFILE, lsPageUrl: lsProfiles.lsPageUrl,
  });
  assert.ok(!links.some(l => l.url.includes('long-beach')));
});

test('every JSON-LD block parses and the FAQ block mirrors the visible FAQs', () => {
  const page = passingPage();
  Object.entries(page.schema).forEach(([key, value]) => {
    assert.doesNotThrow(() => JSON.parse(value), `${key} must be valid JSON`);
  });
  const faq = JSON.parse(page.schema.faqPage);
  assert.strictEqual(faq.mainEntity.length, page.sections.faq.items.length);
  assert.strictEqual(faq.mainEntity[0].name, page.sections.faq.items[0].q);
});

test('schema omits NAP fields the record does not hold (§6)', () => {
  const bare = { ...LOCATION, street_address: '', phone_number: '', serving_areas: [], nearby_areas: [] };
  const scaffold = lsCompose.buildLsScaffold(layers({ location: bare }), PROFILE);
  const schema = schemaGenerator.generateLsSchema({ scaffold, client: CLIENT, location: bare, service: SERVICE, profile: PROFILE });
  const business = JSON.parse(schema.business);
  assert.ok(!('telephone' in business), 'no invented phone number');
  assert.ok(!('streetAddress' in business.address), 'no invented street address');
  assert.strictEqual(business.address.addressLocality, 'Torrance', 'the city is real and stays');
});

test('an LS page is not mistaken for a dental page by the exporters', () => {
  const page = passingPage();
  assert.strictEqual(exporter.isLsPage(page), true);
  assert.strictEqual(exporter.isDentalPage(page), false, 'both shapes have a hero — the body is what differs');
  assert.strictEqual(exporter.safeFilename(page), 'torrance_anxiety-treatment');
});

test('the markdown export carries the brief, the counts and the §6 flags', () => {
  const page = passingPage();
  page.sections.locationInfo = lsCompose.buildLocationInfo({ city: 'Torrance', state_abbreviation: 'CA' });
  const md = exporter.toLsMarkdown(page);
  assert.ok(md.includes('## SEO Details'));
  assert.ok(md.includes(`Character count: ${page.meta.title.length}`), 'title character count');
  assert.ok(md.includes('Writing instructions:'), 'the brief travels with the copy');
  assert.ok(md.includes('PHONE NUMBER REQUIRED FROM CLIENT'), 'gaps are unmissable in the hand-off');
  assert.ok(md.includes(page.sections.faq.items[0].q));
});

test('the JSON export matches the template §12 structure', () => {
  const parsed = JSON.parse(exporter.toLsJSON(passingPage()));
  ['brand_name', 'domain', 'service', 'location', 'keywords', 'competitors', 'seo', 'sections', 'faqs']
    .forEach(key => assert.ok(key in parsed, `§12 requires "${key}"`));
  assert.strictEqual(parsed.brand_name, 'Clear Behavioral Health');
  assert.strictEqual(parsed.domain, 'https://www.clearbehavioralhealth.com');
  assert.strictEqual(parsed.keywords.primary_keyword_1, 'anxiety treatment torrance');
  assert.strictEqual(parsed.location.serving_areas.length, 2);
  assert.ok(parsed.sections[0].writing_instructions, 'the brief is part of the machine contract');
});

// ── Seeding ─────────────────────────────────────────────────────────────────
console.log('\nlsSeed');

test('service rows are built with client-scoped ids', () => {
  const services = lsSeed.buildServices({
    clientId: CLIENT.id, idPrefix: 'cbh_',
    serviceDefs: [['Anxiety Treatment', 'anxiety-treatment', 'condition', ['Anxiety']]],
  });
  assert.strictEqual(services[0].id, 'cbh_svc_anxiety-treatment',
    'two clients naming a service the same thing must not collide in a shared table');
  assert.strictEqual(services[0].parent_service_url, '/services/anxiety-treatment/');
  assert.deepStrictEqual(services[0].conditions_treated, ['Anxiety']);
});

test('a location entry with no NAP records exactly what is missing', () => {
  const [row] = lsSeed.buildLocations({
    clientId: CLIENT.id, idPrefix: 'cbh_',
    locationDefs: [['Torrance', 'Torrance', 'CA', {}]],
    serviceIds: ['cbh_svc_anxiety-treatment'], stateNames: { CA: 'California' },
  });
  assert.deepStrictEqual(row.nap_todo, lsSeed.NAP_FIELDS, 'nothing supplied means everything is flagged');
  assert.strictEqual(row.state, 'California');
  assert.strictEqual(row.location_slug, 'torrance');
  assert.strictEqual(row.location_page_url, '', 'a page path is never guessed');
});

test('a fully supplied location entry flags nothing', () => {
  const [row] = lsSeed.buildLocations({
    clientId: CLIENT.id, idPrefix: 'cbh_',
    locationDefs: [['Torrance', 'Torrance', 'CA', {
      street: '1 Example St', phone: '(310) 555-0100', servingAreas: ['Carson'],
      agesServed: 'Adults 18+', directionsUrl: 'https://maps.example/t',
    }]],
    serviceIds: [], stateNames: {},
  });
  assert.deepStrictEqual(row.nap_todo, []);
});

test('an unknown service slug on a location is an error, not a silently short list', () => {
  assert.throws(
    () => lsSeed.resolveServiceIds({
      locationName: 'Torrance', serviceSlugs: ['no-such-service'],
      servicesBySlug: new Map([['anxiety', 'id']]), allServiceIds: ['id'],
    }),
    /no service defines/,
    'a typo must not quietly remove a service from a location',
  );
});

test('a location naming no services offers all of them', () => {
  const ids = lsSeed.resolveServiceIds({
    locationName: 'Torrance', serviceSlugs: undefined,
    servicesBySlug: new Map(), allServiceIds: ['a', 'b'],
  });
  assert.deepStrictEqual(ids, ['a', 'b']);
});

// ── Clear Behavioral Health reference data ──────────────────────────────────
// The client's own service taxonomy and location list. These assert the
// invariants that make the data USABLE — unique slugs, resolvable availability,
// English headings, no invented NAP — rather than restating the list, which
// would just be the file written twice.
console.log('\nClear Behavioral Health data');

const CBH = require('../data/clearBehavioralHealth');
const cbhServices = lsSeed.buildServices({ clientId: CBH.CLIENT_ID, idPrefix: 'cbh_', serviceDefs: CBH.SERVICE_DEFS });
const cbhLocations = lsSeed.buildLocations({
  clientId: CBH.CLIENT_ID, idPrefix: 'cbh_', locationDefs: CBH.LOCATION_DEFS,
  serviceIds: cbhServices.map(s => s.id),
  servicesBySlug: new Map(cbhServices.map(s => [s.slug, s.id])),
  stateNames: CBH.STATE_NAMES,
});

test('the brand carries its YMYL posture and prohibited claims', () => {
  assert.strictEqual(CBH.CLIENT.brand_rules.ymyl, true);
  assert.ok(CBH.CLIENT.brand_rules.prohibited_claims.length >= 5);
});

test('service and location slugs are unique, so no two pages share a URL', () => {
  const serviceSlugs = cbhServices.map(s => s.slug);
  const locationSlugs = cbhLocations.map(l => l.location_slug);
  assert.strictEqual(new Set(serviceSlugs).size, serviceSlugs.length, 'duplicate service slug');
  assert.strictEqual(new Set(locationSlugs).size, locationSlugs.length, 'duplicate location slug');
});

test('one row per city — no two locations share a city', () => {
  const cities = cbhLocations.map(l => l.city);
  assert.strictEqual(new Set(cities).size, cities.length,
    `a city listed once per programme is still one location: ${cities.filter((c, i) => cities.indexOf(c) !== i)}`);
});

test('every location carries a region, and regions group more than one city where they should', () => {
  cbhLocations.forEach(l => assert.ok(l.region, `${l.location_name} has no region`));
  const southBay = cbhLocations.filter(l => l.region === 'South Bay');
  assert.ok(southBay.length > 1, 'the region is what orders sibling links, so it has to actually group');
});

test('every location offers the full catalogue', () => {
  // The client confirmed availability is not location-scoped, so the seed says
  // so explicitly rather than leaving it to each page to imply.
  cbhLocations.forEach(l => assert.strictEqual(
    l.services_available_ids.length, cbhServices.length,
    `${l.location_name} offers ${l.services_available_ids.length} of ${cbhServices.length} services`,
  ));
});

test('every service and location combination resolves to a distinct URL', () => {
  const profile = lsProfiles.resolveProfile(CBH.CLIENT);
  const urls = new Set();
  cbhLocations.forEach((location) => {
    cbhServices.forEach((service) => {
      const url = lsProfiles.lsPageUrl(profile, location, service);
      assert.ok(!urls.has(url), `two pages would live at ${url}`);
      urls.add(url);
    });
  });
  assert.strictEqual(urls.size, cbhLocations.length * cbhServices.length);
});

test('no location ships an invented address, phone or serving area', () => {
  cbhLocations.forEach((l) => {
    assert.strictEqual(l.street_address, '', `${l.location_name} has a street address nobody supplied`);
    assert.strictEqual(l.phone_number, '');
    assert.deepStrictEqual(l.serving_areas, []);
    assert.strictEqual(l.ages_served, '');
    assert.strictEqual(l.location_page_url, '', 'a breadcrumb URL must not be guessed');
    assert.ok(l.nap_todo.length, `${l.location_name} must flag what the client still owes`);
  });
});

test('every service produces English ladder headings', () => {
  cbhServices.forEach((service) => {
    lsLadder.ladderHeadings(service).forEach((heading) => {
      assert.ok(!/(a|an) (?:[A-Z]?[a-z]*(?:tion|ty|ness|ism|osis)|Depression|Anxiety|Stress|Grief|Anger|Burnout|Autism)/.test(heading),
        `"${service.name}" produced "${heading}" — an article on an uncountable noun`);
      assert.ok(!/What Are (?:Teen )?(?:ADHD|PTSD|OCD)/.test(heading),
        `"${service.name}" produced "${heading}" — wrong agreement`);
      assert.ok(!/a (?:[AEIOU])/.test(heading), `"${service.name}" produced "${heading}" — wrong article`);
    });
  });
});

test('a trailing acronym does not decide the article', () => {
  assert.strictEqual(
    lsLadder.ladderHeadings({ name: 'Partial Hospitalization Program (PHP)', category: 'program' })[0],
    'What Is a Partial Hospitalization Program (PHP)?',
    'the head noun before the parenthetical is what takes the article',
  );
  assert.strictEqual(
    lsLadder.ladderHeadings({ name: 'Obsessive Compulsive Disorder (OCD)', category: 'condition', conditions_treated: ['OCD'] })[0],
    'What Is OCD?',
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
