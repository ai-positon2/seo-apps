// ── Client feedback rules: engine, QC, reviewer, writer, brief, regen ───────
// Called from run.js, which owns the runner and the LLM stub. Kept in its own
// file because run.js is already three thousand lines and these tests share a
// handful of builders nothing else uses.

const cbhContract = require('../cbhContract');
const cbhCompose = require('../cbhCompose');
const cbhQc = require('../cbhQc');
const cbhFixture = require('./cbhFixture');
const fb = require('../cbhFeedback');
const seedData = require('../cbhFeedbackSeed');

const SEED = seedData.RULES.map(r => ({ ...r, status: 'active', version: 1, client_id: seedData.CBH_CLIENT_ID }));
const byKey = key => SEED.find(r => r.key === key);

// The fixture page, as the pipeline would build it for one service at one
// location, with the marker generateFromBrief stamps on every new page.
function page({ serviceId = 'cbh_anxiety', groups = ['mh-outpatient'], marker = true, mutate } = {}) {
  const l3 = cbhFixture.passingL3();
  if (mutate) mutate(l3);
  const p = cbhCompose.mergeCbhL3(cbhFixture.scaffold(), l3);
  cbhCompose.applyProvenance(p, cbhFixture.passingProvenance());
  p.meta.service_id = serviceId;
  p.meta.programGroups = groups;
  if (marker) p.feedback = { rulesVersion: fb.rulesVersion(SEED), ruleKeys: SEED.map(r => r.key) };
  return p;
}

const fbChecks = (p, rules = SEED) => fb.deterministicChecks(p, rules);
const failing = (p, rules = SEED) => fbChecks(p, rules).filter(c => !c.pass);
const failingIds = (p, rules) => failing(p, rules).map(c => c.id);

module.exports = async function run({ test, testAsync, assert, setLlmStub }) {
  console.log('\nCBH feedback rules - scope, checks and prompts');

  test('every seeded rule validates against the CBH vocabulary, service ids included', () => {
    const serviceIds = require('../seed').CBH_SERVICES.map(s => s.id);
    SEED.forEach((r) => {
      const v = fb.validateRule(r, { serviceIds });
      assert.deepStrictEqual(v.errors, [], `${r.key}: ${v.errors.join('; ')}`);
    });
  });

  test('a page written to the guidelines passes every seeded rule', () => {
    assert.deepStrictEqual(failingIds(page()), []);
    assert.deepStrictEqual(failingIds(page({ serviceId: 'cbh_stress', mutate: (l3) => {
      l3.approach.philosophy = ['We treat stress as a signal, not a flaw. It’s the body and mind telling you '
        + 'something needs attention.'];
    } })), [], 'the stress page passes once it opens with the client line');
  });

  test('scope: a service rule only applies to its own service', () => {
    const stressRule = byKey('stress-philosophy-opening');
    assert.strictEqual(fb.rulesFor([stressRule], { serviceId: 'cbh_anxiety' }).length, 0);
    assert.strictEqual(fb.rulesFor([stressRule], { serviceId: 'cbh_stress' }).length, 1);
    assert.strictEqual(fb.rulesFor([stressRule], { serviceId: 'cbh_teen-stress' }).length, 1);
    assert.ok(failingIds(page({ serviceId: 'cbh_stress' })).includes('fb_stress-philosophy-opening'),
      'a stress page without the line fails');
    assert.ok(!failingIds(page({ serviceId: 'cbh_anxiety' })).includes('fb_stress-philosophy-opening'),
      'an anxiety page is not asked for it');
  });

  test('scope: a program-group rule needs the page to be in that program', () => {
    const r = byKey('family-therapy-teen-iop');
    assert.strictEqual(fb.rulesFor([r], { serviceId: 'cbh_family-therapy', programGroups: ['teen'] }).length, 1);
    assert.strictEqual(fb.rulesFor([r], { serviceId: 'cbh_family-therapy', programGroups: ['mh-outpatient'] }).length, 0);
    assert.strictEqual(fb.rulesFor([r], { serviceId: 'cbh_family-therapy', programGroups: [] }).length, 0);
  });

  test('scope: stage filtering', () => {
    const southern = byKey('no-southern-california-location');
    assert.strictEqual(fb.rulesFor([southern], { serviceId: 'cbh_anxiety', stage: 'brief' }).length, 0);
    assert.strictEqual(fb.rulesFor([southern], { serviceId: 'cbh_anxiety', stage: 'writer' }).length, 1);
  });

  test('ketamine and TMS in clinical therapies fail, naming the section', () => {
    const p = page({ mutate: (l3) => {
      l3.approach.therapies = ['We offer CBT, DBT, TMS and ketamine-assisted therapy for treatment-resistant cases.'];
    } });
    const c = failing(p).find(x => x.id === 'fb_no-tms-ketamine');
    assert.ok(c, 'the rule fired');
    assert.strictEqual(c.severity, 'Critical');
    assert.ok(/clinical therapies/i.test(c.detail), c.detail);
    assert.ok(/ketamine/i.test(c.detail), c.detail);
    assert.strictEqual(c.group, 'feedback');
    assert.strictEqual(c.ruleKey, 'no-tms-ketamine');
  });

  test('TMS attributed to Neuro Wellness Spa outside the therapies list is fine', () => {
    const p = page({ mutate: (l3) => {
      l3.faqs[2].a = 'TMS is available through our partner provider, Neuro Wellness Spa, if your clinician thinks it may help.';
    } });
    assert.ok(!failingIds(p).includes('fb_no-tms-ketamine'));
  });

  test('medication: a CBH claim fails, a Neuro Wellness Spa attribution passes, education is left to the reviewer', () => {
    const claim = page({ mutate: (l3) => { l3.faqs[2].a = 'Our psychiatrists provide medication management for ADHD.'; } });
    assert.ok(failingIds(claim).includes('fb_no-cbh-medication'));
    const ok = page({ mutate: (l3) => {
      l3.faqs[2].a = 'Medication management is available through our partner provider, Neuro Wellness Spa.';
    } });
    assert.ok(!failingIds(ok).includes('fb_no-cbh-medication'));
    const edu = page({ mutate: (l3) => {
      l3.educational.paragraphs = ['ADHD is often treated with a combination of therapy and medication.'];
    } });
    assert.ok(!failingIds(edu).includes('fb_no-cbh-medication'), 'educational copy is excepted');
  });

  test('"Southern California location" fails; naming the city passes', () => {
    const bad = page({ mutate: (l3) => { l3.faqs[0].a = 'Call our Southern California location to book a first visit.'; } });
    assert.ok(failingIds(bad).includes('fb_no-southern-california-location'));
    const ok = page({ mutate: (l3) => { l3.faqs[0].a = 'Call our Anaheim Hills location to book a first visit.'; } });
    assert.ok(!failingIds(ok).includes('fb_no-southern-california-location'));
  });

  test('telehealth switching fails in a question or an answer', () => {
    const q = page({ mutate: (l3) => { l3.faqs[3].q = 'Can I switch between in-person and telehealth sessions?'; } });
    assert.ok(failingIds(q).includes('fb_no-telehealth-switching'));
    const a = page({ mutate: (l3) => {
      l3.faqs[3].a = 'Yes. Clients can seamlessly transition between in-person and telehealth services.';
    } });
    assert.ok(failingIds(a).includes('fb_no-telehealth-switching'));
    assert.ok(!failingIds(page()).includes('fb_no-telehealth-switching'),
      '"delivered in person and online" on its own is not a switching claim');
  });

  test('insurance: "verify with your insurer" fails, and an insurance answer must offer our team', () => {
    const insurer = page({ mutate: (l3) => {
      l3.faqs[1].a = 'We accept most major insurance providers. Please verify with your insurer before your first visit.';
    } });
    assert.ok(failingIds(insurer).includes('fb_insurance-team-verifies'));
    const silent = page({ mutate: (l3) => { l3.faqs[1].a = 'We accept most major insurance providers.'; } });
    const c = failing(silent).find(x => x.id === 'fb_insurance-team-verifies');
    assert.ok(c && /verify benefits/i.test(c.detail), c && c.detail);
    assert.ok(!failingIds(page()).includes('fb_insurance-team-verifies'),
      '"We ... verify your benefits" satisfies it');
  });

  test('a city-first educational sentence fails; the same sentence elsewhere does not', () => {
    const bad = page({ mutate: (l3) => {
      l3.educational.h3s[0].lines[0] = 'In Anaheim Hills, burnout often follows long commutes and demanding jobs.';
    } });
    assert.ok(failingIds(bad).includes('fb_no-city-first-condition'));
    const hero = page({ mutate: (l3) => { l3.uvp = 'In Anaheim Hills, anxiety treatment here is paced to you.'; } });
    assert.ok(!failingIds(hero).includes('fb_no-city-first-condition'));
  });

  test('studies and statistics fail; ordinary numbers do not', () => {
    const study = page({ mutate: (l3) => {
      l3.educational.paragraphs = ['A recent study found that anxiety is the most common mental health condition.'];
    } });
    assert.ok(failingIds(study).includes('fb_no-studies-or-statistics'));
    const stat = page({ mutate: (l3) => {
      l3.educational.paragraphs = ['Anxiety disorders affect about 19% of adults each year.'];
    } });
    assert.ok(failingIds(stat).includes('fb_no-studies-or-statistics'));
    const oneIn = page({ mutate: (l3) => { l3.educational.paragraphs = ['Roughly 1 in 5 adults lives with anxiety.']; } });
    assert.ok(failingIds(oneIn).includes('fb_no-studies-or-statistics'));
    const fine = page({ mutate: (l3) => { l3.faqs[0].a = 'Most new clients are seen within 7 days of calling.'; } });
    assert.ok(!failingIds(fine).includes('fb_no-studies-or-statistics'));
    const journaling = page({ mutate: (l3) => { l3.educational.h3s[0].lines[1] = '- Journaling and study habits'; } });
    assert.ok(!failingIds(journaling).includes('fb_no-studies-or-statistics'), 'study habits is not a citation');
  });

  test('biofeedback fails anywhere', () => {
    const p = page({ mutate: (l3) => { l3.approach.therapies = ['CBT and biofeedback-informed relaxation training.']; } });
    assert.ok(failingIds(p).includes('fb_no-biofeedback'));
  });

  test('{city} is regex-escaped before it is matched', () => {
    const rule = fb.normalizeRule({
      key: 'city-test', title: 't', instruction: 'i', severity: 'Minor',
      checks: [{ type: 'forbid', pattern: '^{city}$' }],
    });
    const doc = { pieces: [{ section: 'uvp', field: 'uvp', text: 'St. Louis (North)' }], faqs: [] };
    const hit = fb.runRuleChecks(rule, doc, { city: 'St. Louis (North)' });
    assert.strictEqual(hit.pass, false, 'the literal city matched');
    const miss = fb.runRuleChecks(rule, { pieces: [{ section: 'uvp', field: 'uvp', text: 'StX Louis North' }], faqs: [] },
      { city: 'St. Louis (North)' });
    assert.strictEqual(miss.pass, true, 'the dot was not a wildcard');
  });

  test('validateRule rejects a bad regex, an unknown section and an unknown service', () => {
    const base = { key: 'x', title: 'x', instruction: 'x', severity: 'Major', checks: [] };
    assert.ok(fb.validateRule({ ...base, checks: [{ type: 'forbid', pattern: '(' }] }).errors.length);
    assert.ok(fb.validateRule({ ...base, scope: { sections: ['nowhere'] } }).errors.length);
    assert.ok(fb.validateRule({ ...base, scope: { services: ['cbh_unknown'] } }, { serviceIds: ['cbh_anxiety'] }).errors.length);
    assert.ok(fb.validateRule({ ...base, checks: [{ type: 'review' }] }).errors.length, 'a review needs a question');
    assert.deepStrictEqual(fb.validateRule({ ...base, checks: [{ type: 'forbid', pattern: 'x' }] }).errors, []);
  });

  test('normalizeRule fills defaults and drops unknown fields', () => {
    const r = fb.normalizeRule({ key: 'My Rule!', title: ' t ', instruction: 'i', junk: 1 });
    assert.strictEqual(r.key, 'my-rule');
    assert.strictEqual(r.status, 'draft');
    assert.deepStrictEqual(r.stages, ['brief', 'writer', 'regen']);
    assert.deepStrictEqual(r.scope, { services: ['*'], programGroups: [], sections: [] });
    assert.strictEqual(r.junk, undefined);
  });

  test('rulesVersion is order-independent and moves when a rule changes', () => {
    const a = fb.rulesVersion(SEED);
    assert.strictEqual(fb.rulesVersion([...SEED].reverse()), a);
    const bumped = SEED.map((r, i) => (i === 0 ? { ...r, version: 2 } : r));
    assert.notStrictEqual(fb.rulesVersion(bumped), a);
  });

  test('the prompt block carries the instructions for its stage, with placeholders filled', () => {
    const block = fb.promptBlock(SEED, { stage: 'writer', serviceId: 'cbh_burnout', city: 'Anaheim Hills', condition: 'Burnout' });
    assert.ok(block.includes('CLIENT FEEDBACK RULES'));
    assert.ok(block.includes('Neuro Wellness Spa'));
    assert.ok(block.includes('"our Anaheim Hills location"'), 'the {city} placeholder is filled');
    assert.ok(!block.includes('{city}') && !block.includes('{condition}'));
    assert.ok(!block.includes('We treat stress as a signal'), 'a stress-only rule stays off a burnout page');
    const brief = fb.promptBlock(SEED, { stage: 'brief', serviceId: 'cbh_burnout', city: 'Anaheim Hills' });
    assert.ok(!brief.includes('Southern California'), 'a writer-only rule stays out of the planner');
    assert.strictEqual(fb.promptBlock([], { stage: 'writer' }), '');
    assert.ok(!cbhContract.hasEmDash(block), 'the block itself carries no em dash');
  });

  test('brief warnings flag a planned telehealth-switching or medication question', () => {
    const brief = {
      educational: { h3s: [{ heading: 'Signs of ADHD in adults', intent: 'Common signs.' }] },
      faqs: [
        { q: 'Can I switch between in-person and telehealth sessions?', type: 'location' },
        { q: 'How long before ADHD medication is adjusted to the right dose?', type: 'intent' },
        { q: 'How soon can I start ADHD treatment in Anaheim Hills?', type: 'location' },
      ],
    };
    const warnings = fb.briefFeedbackWarnings(brief, SEED, { serviceId: 'cbh_adhd', city: 'Anaheim Hills' });
    const keys = warnings.map(w => w.ruleKey);
    assert.ok(keys.includes('no-telehealth-switching'), JSON.stringify(warnings));
    assert.ok(keys.includes('no-cbh-medication'), JSON.stringify(warnings));
    assert.ok(warnings.every(w => w.detail && w.title && w.severity));
    assert.deepStrictEqual(fb.briefFeedbackWarnings({ educational: { h3s: [] }, faqs: [
      { q: 'How soon can I start ADHD treatment in Anaheim Hills?' }] }, SEED, { serviceId: 'cbh_adhd', city: 'Anaheim Hills' }), []);
  });

  console.log('\nCBH feedback rules - QC integration');

  test('runCbhQc without rules is unchanged, marker or not', () => {
    const p = page();
    const r = cbhQc.runCbhQc(p);
    assert.ok(!r.checks.some(c => c.group === 'feedback' || String(c.id).startsWith('fb_')));
    assert.strictEqual(r.verdict, 'PASS');
  });

  test('a page made before feedback rules existed gets today\'s QC even with rules active', () => {
    const old = page({ marker: false, mutate: (l3) => { l3.approach.therapies = ['CBT, DBT and ketamine.']; } });
    const before = JSON.stringify(old);
    const r = cbhQc.runCbhQc(old, { feedbackRules: SEED });
    assert.ok(!r.checks.some(c => String(c.id).startsWith('fb_')), 'no feedback checks on an old page');
    assert.strictEqual(JSON.stringify(old), before, 'and the page object was not touched');
  });

  test('a new page breaking a Critical rule fails QC', () => {
    const p = page({ mutate: (l3) => { l3.approach.therapies = ['CBT, DBT and ketamine.']; } });
    p.feedbackReview = fb.emptyReview(p, SEED);
    const r = cbhQc.runCbhQc(p, { feedbackRules: SEED });
    assert.ok(r.checks.find(c => c.id === 'fb_no-tms-ketamine' && !c.pass));
    assert.strictEqual(r.verdict, 'FAIL');
  });

  test('review results: missing, current, stale and unverified', () => {
    const p = page();
    // No review on a page whose rules include review questions: flagged, Minor.
    let r = cbhQc.runCbhQc(p, { feedbackRules: SEED });
    const missing = r.checks.find(c => c.id === 'fb_review_missing');
    assert.ok(missing && !missing.pass && missing.severity === 'Minor');
    assert.strictEqual(r.verdict, 'CONDITIONAL PASS');

    // A current review: its results become checks at the rule's severity.
    const review = fb.emptyReview(p, SEED);
    review.results = review.results.map(x => (x.ruleKey === 'stay-on-condition'
      ? { ...x, compliant: false, verified: true, evidence: 'worry', fix: 'Stay on anxiety.' } : x));
    p.feedbackReview = review;
    r = cbhQc.runCbhQc(p, { feedbackRules: SEED });
    const stay = r.checks.find(c => c.id === 'fb_stay-on-condition_review');
    assert.ok(stay && !stay.pass && stay.severity === 'Major', JSON.stringify(stay));
    assert.ok(r.checks.find(c => c.id === 'fb_no-cbh-medication_review').pass);

    // Unverified: the reviewer's quote is not on the page. A human looks.
    p.feedbackReview.results = p.feedbackReview.results.map(x => (x.ruleKey === 'stay-on-condition'
      ? { ...x, verified: false } : x));
    r = cbhQc.runCbhQc(p, { feedbackRules: SEED });
    assert.strictEqual(r.checks.find(c => c.id === 'fb_stay-on-condition_review').severity, 'Minor');

    // Stale: the content moved after the review.
    p.sections.uvp.paragraph += ' Edited.';
    r = cbhQc.runCbhQc(p, { feedbackRules: SEED });
    const stale = r.checks.find(c => c.id === 'fb_review_stale');
    assert.ok(stale && !stale.pass && stale.severity === 'Minor');
    assert.ok(!r.checks.some(c => c.id === 'fb_stay-on-condition_review'), 'stale results are not reported as current');
  });

  test('the review hash ignores casing and the meta, so the final page matches what was reviewed', () => {
    const p = page();
    const h = fb.reviewContentHash(p);
    const q = structuredClone(p);
    q.meta.title = 'Something else entirely for the title tag';
    q.sections.educational.h3s[0].heading = q.sections.educational.h3s[0].heading.toUpperCase();
    assert.strictEqual(fb.reviewContentHash(q), h);
    q.sections.uvp.paragraph += ' More.';
    assert.notStrictEqual(fb.reviewContentHash(q), h);
  });

  // ── LLM stub ──────────────────────────────────────────────────────────────
  // Routes on the system prompt, so one generation can exercise the writer and
  // the reviewer with different answers. `answer` may be a function of the
  // call number for that handler.
  function stubByPrompt(handlers) {
    const calls = [];
    setLlmStub(() => ({
      model: 'claude-sonnet-5',
      provider: 'anthropic',
      chat: {
        completions: {
          create: async ({ messages }) => {
            const system = messages[0].content;
            const user = (messages[1] && messages[1].content) || '';
            calls.push({ system, user });
            const h = handlers.find(x => system.includes(x.match));
            const n = calls.filter(c => h && c.system.includes(h.match)).length;
            const answer = !h ? {} : (typeof h.answer === 'function' ? h.answer({ system, user, n }) : h.answer);
            return { choices: [{ message: { content: typeof answer === 'string' ? answer : JSON.stringify(answer) }, finish_reason: 'stop' }] };
          },
        },
      },
    }));
    return calls;
  }

  console.log('\nCBH feedback rules - the AI reviewer');
  const review = require('../cbhFeedbackReview');

  await testAsync('the reviewer checks its quotes against the page before trusting them', async () => {
    const p = page();
    const calls = stubByPrompt([{ match: review.REVIEWER_MARKER, answer: { results: [
      { ruleKey: 'stay-on-condition', compliant: false, section: 'educational.body',
        evidence: 'Worry that is hard to control most days', fix: 'Describe anxiety itself.' },
      { ruleKey: 'symptoms-are-mh-indicators', compliant: false, section: 'educational.body',
        evidence: 'crushing chest pain and fainting', fix: 'Remove emergency symptoms.' },
      { ruleKey: 'no-cbh-medication', compliant: true },
    ] } }]);
    try {
      const r = await review.reviewPage(p, SEED);
      assert.strictEqual(calls.length, 1, 'one call covers every rule');
      const by = k => r.results.find(x => x.ruleKey === k);
      assert.strictEqual(by('stay-on-condition').verified, true, 'quote is on the page');
      assert.strictEqual(by('symptoms-are-mh-indicators').verified, false, 'quote is not on the page');
      assert.strictEqual(by('no-cbh-medication').compliant, true);
      assert.strictEqual(r.contentHash, fb.reviewContentHash(p));
      assert.strictEqual(r.rulesVersion, fb.rulesVersion(fb.reviewRulesFor(p, SEED)));
      assert.ok(calls[0].user.includes('describe Anxiety itself'), 'the question has its {condition} filled');
      assert.ok(calls[0].user.includes('Worry that is hard to control'), 'the page body is reviewed');
      assert.ok(!calls[0].user.includes(p.meta.metaDescription), 'the meta is not');
      assert.ok(!calls[0].user.includes('family therapy'), 'rules for other services stay out');
    } finally { setLlmStub(null); }
  });

  await testAsync('a page with no applicable review question costs no call', async () => {
    const calls = stubByPrompt([]);
    try {
      const only = SEED.filter(r => !r.checks.some(c => c.type === 'review'));
      assert.strictEqual(await review.reviewPage(page(), only), null);
      assert.strictEqual(calls.length, 0);
    } finally { setLlmStub(null); }
  });

  await testAsync('a reviewer that fails degrades to no review rather than failing generation', async () => {
    stubByPrompt([{ match: review.REVIEWER_MARKER, answer: 'not json' }]);
    try {
      assert.strictEqual(await review.safeReviewPage(page(), SEED), null);
    } finally { setLlmStub(null); }
  });

  console.log('\nCBH feedback rules - the writer');
  const cbhWriter = require('../cbhWriter');

  test('the writer prompt names the program and carries the client rules', () => {
    const s = cbhFixture.scaffold();
    s.meta.service_id = 'cbh_family-therapy';
    s.meta.programGroups = ['teen'];
    const u = cbhWriter.userPrompt({ scaffold: s, h3Plan: [], faqPlan: [], primaryKeyword: 'x', feedbackRules: SEED });
    assert.ok(u.includes('PROGRAM AT THIS LOCATION: Teen mental health program (Teen IOP)'), u.slice(0, 300));
    assert.ok(u.includes('CLIENT FEEDBACK RULES'));
    assert.ok(u.includes('included in the teen'), 'the family therapy facts reach the writer');
    assert.ok(u.includes('unless a client rule below says otherwise'), 'the insurance instruction yields to a rule');
    const plain = cbhWriter.userPrompt({ scaffold: cbhFixture.scaffold(), h3Plan: [], faqPlan: [], primaryKeyword: 'x' });
    assert.ok(!plain.includes('CLIENT FEEDBACK RULES'));
  });

  test('the correction notes carry every failed client rule, not only the length gates', () => {
    const p = page({ mutate: (l3) => { l3.approach.therapies = ['CBT, DBT and ketamine.']; } });
    p.feedbackReview = fb.emptyReview(p, SEED);
    const note = cbhWriter.correctionFrom(cbhQc.runCbhQc(p, { feedbackRules: SEED }));
    assert.ok(note.includes('No TMS or ketamine'), note);
    assert.ok(/ketamine/.test(note));
  });

  await testAsync('a draft that breaks a client rule is rewritten, and the clean draft is kept', async () => {
    const bad = cbhFixture.passingL3();
    bad.approach.therapies = ['Our clinicians use CBT, DBT, TMS and ketamine for depression that has not responded.'];
    const good = cbhFixture.passingL3();
    const calls = stubByPrompt([
      { match: 'You are an expert local-SEO content writer', answer: ({ n }) => (n === 1 ? bad : good) },
      { match: review.REVIEWER_MARKER, answer: { results: [] } },
    ]);
    try {
      const s = cbhFixture.scaffold();
      s.meta.service_id = 'cbh_depression';
      s.meta.programGroups = ['mh-outpatient'];
      const out = await cbhWriter.generateCbhL3({
        scaffold: s, primaryKeyword: cbhFixture.PRIMARY, secondaryKeywords: [], h3Plan: [], faqPlan: [], feedbackRules: SEED,
      });
      const writes = calls.filter(c => c.system.includes('You are an expert local-SEO content writer'));
      assert.strictEqual(writes.length, 2, 'one correction pass');
      assert.ok(writes[1].user.includes('CORRECTION') && /ketamine/i.test(writes[1].user), 'the correction names the rule');
      assert.ok(!/ketamine/i.test(JSON.stringify(out.l3)), 'the clean draft won');
      assert.ok(out.feedbackReview, 'and its review travels with it');
      assert.strictEqual(calls.filter(c => c.system.includes(review.REVIEWER_MARKER)).length, 2, 'each draft reviewed');
    } finally { setLlmStub(null); }
  });

  await testAsync('without rules the writer behaves as before and returns no review', async () => {
    const calls = stubByPrompt([{ match: 'You are an expert local-SEO content writer', answer: cbhFixture.passingL3() }]);
    try {
      const out = await cbhWriter.generateCbhL3({
        scaffold: cbhFixture.scaffold(), primaryKeyword: cbhFixture.PRIMARY, secondaryKeywords: [], h3Plan: [], faqPlan: [],
      });
      assert.strictEqual(calls.length, 1);
      assert.strictEqual(out.feedbackReview, null);
      assert.ok(out.l3.metaTitle);
    } finally { setLlmStub(null); }
  });

  console.log('\nCBH feedback rules - the brief');
  const cbhBrief = require('../cbhBrief');
  const planArgs = {
    serviceName: 'ADHD treatment', conditionName: 'ADHD', city: 'Anaheim Hills',
    primaryKeyword: 'adhd treatment anaheim hills', competitorHeadings: [], competitorFaqs: [],
  };

  test('the planner no longer models a medication question', () => {
    const { system } = cbhBrief.planPrompt(planArgs);
    assert.ok(!/medication/i.test(system), 'the example that produced the ADHD medication FAQ is gone');
  });

  test('the code-side plan asks nothing about in-person versus online care', () => {
    const plan = cbhBrief.fallbackPlan({ serviceName: 'Anxiety treatment', city: 'Anaheim Hills' });
    assert.ok(!/in person|in-person|online|telehealth|virtual/i.test(JSON.stringify(plan.faqs)), JSON.stringify(plan.faqs));
    assert.strictEqual(plan.faqs.length, 6, 'still six questions');
  });

  test('the planner carries the brief-stage client rules for this service', () => {
    const { system } = cbhBrief.planPrompt({ ...planArgs, feedbackRules: SEED, serviceId: 'cbh_adhd', programGroups: ['mh-outpatient'] });
    assert.ok(system.includes('CLIENT FEEDBACK RULES'));
    assert.ok(system.includes('Do not plan an FAQ on it'), 'the telehealth rule reaches the planner');
    assert.ok(!system.includes('Southern California'), 'a writer-only rule does not');
    assert.ok(!cbhBrief.planPrompt(planArgs).system.includes('CLIENT FEEDBACK RULES'), 'no rules, no block');
  });

  await testAsync('a rule change re-plans instead of serving a cached plan', async () => {
    const seen = [];
    stubByPrompt([{ match: 'You plan the content brief', answer: ({ system }) => {
      seen.push(system);
      return { metaTitle: '', metaDescription: '', h3s: [{ heading: 'Signs of ADHD', intent: 'x', source: 'competitor' }], faqs: [] };
    } }]);
    try {
      await cbhBrief.plan({ ...planArgs, feedbackRules: SEED, serviceId: 'cbh_adhd', programGroups: [] });
      assert.ok(seen.length >= 1 && seen[seen.length - 1].includes('CLIENT FEEDBACK RULES'));
      assert.notStrictEqual(cbhBrief.planCacheKey({ ...planArgs, feedbackRules: SEED, serviceId: 'cbh_adhd' }),
        cbhBrief.planCacheKey({ ...planArgs, feedbackRules: [], serviceId: 'cbh_adhd' }), 'the rules are in the cache key');
    } finally { setLlmStub(null); }
  });

  console.log('\nCBH feedback rules - program groups, eligibility and the seed');
  const seed = require('../seed');

  test('Psychosis is offered only at mental-health residential locations', () => {
    const psychosis = seed.CBH_SERVICES.find(s => s.id === 'cbh_psychosis');
    assert.deepStrictEqual(psychosis.groups, ['mh-residential']);
    const anaheim = seed.CBH_LOCATIONS.find(l => l.id === 'cbhloc_anaheim-hills');
    const torrance = seed.CBH_LOCATIONS.find(l => l.id === 'cbhloc_torrance');
    assert.ok(!anaheim.services_available_ids.includes('cbh_psychosis'));
    assert.ok(torrance.services_available_ids.includes('cbh_psychosis'));
    // Other adult conditions are untouched.
    assert.ok(anaheim.services_available_ids.includes('cbh_anxiety'));
  });

  test('every CBH location stores the programs it runs', () => {
    seed.CBH_LOCATIONS.forEach(l => assert.ok(Array.isArray(l.program_groups) && l.program_groups.length, l.id));
    assert.deepStrictEqual(seed.CBH_LOCATIONS.find(l => l.id === 'cbhloc_anaheim-hills').program_groups, ['mh-outpatient', 'teen']);
  });

  test('a page\'s program is the service\'s groups that the location runs', () => {
    const svc = id => seed.CBH_SERVICES.find(s => s.id === id);
    const loc = id => seed.CBH_LOCATIONS.find(l => l.id === id);
    assert.deepStrictEqual(cbhCompose.programGroupsFor(svc('cbh_anxiety'), loc('cbhloc_anaheim-hills')), ['mh-outpatient']);
    assert.deepStrictEqual(cbhCompose.programGroupsFor(svc('cbh_family-therapy'), loc('cbhloc_anaheim-hills')), ['teen']);
    assert.deepStrictEqual(cbhCompose.programGroupsFor(svc('cbh_psychosis'), loc('cbhloc_torrance')), ['mh-residential']);
    assert.deepStrictEqual(cbhCompose.programGroupsFor(svc('cbh_anxiety'), { id: 'old' }), [], 'a location never re-seeded has none');
  });

  test('the CBH routes refuse a service the location does not offer', () => {
    const svc = id => seed.CBH_SERVICES.find(s => s.id === id);
    const loc = id => seed.CBH_LOCATIONS.find(l => l.id === id);
    assert.throws(() => cbhCompose.assertCbhEligible(svc('cbh_psychosis'), loc('cbhloc_anaheim-hills')), /not offered at Anaheim Hills/);
    assert.doesNotThrow(() => cbhCompose.assertCbhEligible(svc('cbh_psychosis'), loc('cbhloc_torrance')));
  });

  test('the scaffold carries the program onto the page', () => {
    const client = { id: seedData.CBH_CLIENT_ID, brand_static: { base_url: 'https://clearbehavioralhealth.com' } };
    const service = seed.CBH_SERVICES.find(s => s.id === 'cbh_family-therapy');
    const location = { ...seed.CBH_LOCATIONS.find(l => l.id === 'cbhloc_pasadena'), city: 'Pasadena' };
    const s = cbhCompose.buildCbhScaffold({ client, service, location });
    assert.deepStrictEqual(s.meta.programGroups, ['teen']);
    assert.ok(cbhWriter.programLine(s).includes('Teen IOP'));
  });

  console.log('\nCBH feedback rules - field regeneration');
  const cbhRegen = require('../cbhRegen');
  const regenLayers = (serviceId, locationId, city) => ({
    client: { id: seedData.CBH_CLIENT_ID, brand_static: { base_url: 'https://clearbehavioralhealth.com' } },
    service: seed.CBH_SERVICES.find(s => s.id === serviceId),
    location: { ...seed.CBH_LOCATIONS.find(l => l.id === locationId), city },
  });
  const LINE = 'We treat stress as a signal, not a flaw. It’s the body and mind telling you something needs attention.';

  await testAsync('a regenerated field gets its section\'s rules and one retry on a hit', async () => {
    const calls = stubByPrompt([{ match: 'You are rewriting ONE field', answer: ({ n }) => (n === 1
      ? { lines: ['We help you manage stress with practical, compassionate care.'] }
      : { lines: [`${LINE} We help you respond to it with care.`] }) }]);
    try {
      const r = await cbhRegen.regenerateField({
        clientId: seedData.CBH_CLIENT_ID, serviceId: 'cbh_stress', locationId: 'cbhloc_anaheim-hills',
        page: page({ serviceId: 'cbh_stress' }), field: 'approach.philosophy',
        layers: regenLayers('cbh_stress', 'cbhloc_anaheim-hills', 'Anaheim Hills'), feedbackRules: SEED,
      });
      assert.ok(calls[0].system.includes('We treat stress as a signal'), 'the stress rule reached the regen prompt');
      assert.strictEqual(calls.length, 2, 'one retry');
      assert.ok(calls[1].user.includes('CORRECTION') && calls[1].user.includes('client'), calls[1].user.slice(-400));
      assert.ok(r.value[0].startsWith('We treat stress as a signal'));
      assert.deepStrictEqual(r.feedbackHits, []);
    } finally { setLlmStub(null); }
  });

  await testAsync('regenerating a field on a page made before the rules ignores them', async () => {
    const calls = stubByPrompt([{ match: 'You are rewriting ONE field', answer: { lines: ['CBT, DBT and ketamine.'] } }]);
    try {
      const r = await cbhRegen.regenerateField({
        clientId: seedData.CBH_CLIENT_ID, serviceId: 'cbh_anxiety', locationId: 'cbhloc_anaheim-hills',
        page: page({ marker: false }), field: 'approach.therapies',
        layers: regenLayers('cbh_anxiety', 'cbhloc_anaheim-hills', 'Anaheim Hills'), feedbackRules: SEED,
      });
      assert.strictEqual(calls.length, 1);
      assert.ok(!calls[0].system.includes('CLIENT FEEDBACK RULES'));
      assert.deepStrictEqual(r.feedbackHits, []);
    } finally { setLlmStub(null); }
  });

  await testAsync('a regenerated brief question is checked against the rules', async () => {
    stubByPrompt([{ match: 'You are rewriting ONE field', answer: { value: 'Can I switch between in-person and telehealth sessions?' } }]);
    try {
      const brief = { faqs: [{ q: 'How soon can I start?', type: 'location' }], educational: { h3s: [] }, meta: {} };
      const r = await cbhRegen.regenerateField({
        clientId: seedData.CBH_CLIENT_ID, serviceId: 'cbh_anxiety', locationId: 'cbhloc_anaheim-hills',
        brief, field: 'brief.faq.q', index: 0,
        layers: regenLayers('cbh_anxiety', 'cbhloc_anaheim-hills', 'Anaheim Hills'), feedbackRules: SEED,
      });
      assert.ok(r.feedbackHits.some(h => h.ruleKey === 'no-telehealth-switching'), JSON.stringify(r.feedbackHits));
    } finally { setLlmStub(null); }
  });

  console.log('\nCBH feedback rules - generate, save and re-check (in-memory store)');
  const store = require('../store');
  const cbhWizard = require('../cbhWizard');
  const { briefId, tupleKey } = require('../brief');

  // Swaps the store's Supabase calls for an in-memory table set for one test.
  async function withMemoryStore(tables, fn) {
    const names = ['get', 'list', 'findOne', 'update', 'insert', 'upsertById', 'remove'];
    const orig = Object.fromEntries(names.map(n => [n, store[n]]));
    const t = c => (tables[c] = tables[c] || []);
    const matches = (r, f) => Object.entries(f || {}).every(([k, v]) => v == null || String(r[k]) === String(v));
    store.get = async (c, id) => structuredClone(t(c).find(r => r.id === id) || null);
    store.list = async (c, f) => structuredClone(t(c).filter(r => matches(r, f)));
    store.findOne = async (c, f) => structuredClone(t(c).find(r => matches(r, f)) || null);
    store.update = async (c, id, patch) => {
      const i = t(c).findIndex(r => r.id === id);
      if (i < 0) return null;
      t(c)[i] = { ...t(c)[i], ...structuredClone(patch), id, updated_at: new Date().toISOString() };
      return structuredClone(t(c)[i]);
    };
    store.insert = async (c, data, prefix) => {
      const row = { id: data.id || `${prefix || c}_${t(c).length + 1}`, ...structuredClone(data) };
      t(c).push(row);
      return structuredClone(row);
    };
    store.upsertById = async (c, data, prefix) => (t(c).some(r => r.id === data.id)
      ? store.update(c, data.id, data) : store.insert(c, data, prefix));
    store.remove = async (c, id) => { const n = t(c).length; tables[c] = t(c).filter(r => r.id !== id); return tables[c].length < n; };
    fb.invalidateRules();
    try { return await fn(tables); } finally { Object.assign(store, orig); fb.invalidateRules(); }
  }

  const CLIENT = { id: seedData.CBH_CLIENT_ID, name: 'Clear Behavioral Health', brand_static: { base_url: 'https://clearbehavioralhealth.com' } };
  const tablesFor = () => ({
    clients: [structuredClone(CLIENT)],
    services: structuredClone(seed.CBH_SERVICES),
    locations: structuredClone(seed.CBH_LOCATIONS),
    feedbackRules: SEED.map((r, i) => ({ ...structuredClone(r), id: `fbr_${i}` })),
  });
  const savedBrief = (serviceId, locationId) => {
    const tuple = { clientId: seedData.CBH_CLIENT_ID, serviceId, locationId };
    return {
      id: briefId(tuple), tuple_key: tupleKey(tuple), client_id: seedData.CBH_CLIENT_ID,
      service_id: serviceId, location_id: locationId, contract: 'cbh', approved: true,
      brief: {
        primaryKeyword: cbhFixture.PRIMARY, primaryKeywords: [cbhFixture.PRIMARY], secondaryKeywords: [],
        meta: { title: '', description: '' },
        educational: { h3s: cbhFixture.passingL3().educational.h3s.map((h, i) => ({
          heading: h.heading, intent: 'x', ...cbhFixture.passingProvenance()[i] })) },
        faqs: cbhFixture.passingL3().faqs.map(f => ({ q: f.q, type: f.type })),
      },
    };
  };

  await testAsync('a generated page is stamped, reviewed and gated by the client rules', async () => {
    await withMemoryStore({ ...tablesFor(), briefs: [savedBrief('cbh_anxiety', 'cbhloc_anaheim-hills')] }, async (tables) => {
      stubByPrompt([
        { match: 'You are an expert local-SEO content writer', answer: cbhFixture.passingL3() },
        { match: review.REVIEWER_MARKER, answer: { results: [] } },
      ]);
      try {
        const out = await cbhWizard.generateFromBrief({
          clientId: seedData.CBH_CLIENT_ID, serviceId: 'cbh_anxiety', locationId: 'cbhloc_anaheim-hills',
        });
        const stored = tables.pages[0].page_object;
        assert.ok(stored.feedback && stored.feedback.rulesVersion, 'the page carries the marker');
        assert.ok(stored.feedback.ruleKeys.includes('no-cbh-medication'));
        assert.deepStrictEqual(stored.meta.programGroups, ['mh-outpatient']);
        assert.ok(stored.feedbackReview, 'the review is stored');
        assert.strictEqual(stored.feedbackReview.contentHash, fb.reviewContentHash(stored), 'and is current for the final page');
        assert.ok(out.page.qc.checks.some(c => c.id === 'fb_no-tms-ketamine' && c.pass), 'the rules gated it');
        assert.ok(!out.page.qc.checks.some(c => c.id === 'fb_review_stale'), 'the review is not stale on arrival');
      } finally { setLlmStub(null); }
    });
  });

  await testAsync('generation refuses a service the location does not offer', async () => {
    await withMemoryStore({ ...tablesFor(), briefs: [savedBrief('cbh_psychosis', 'cbhloc_anaheim-hills')] }, async (tables) => {
      await assert.rejects(cbhWizard.generateFromBrief({
        clientId: seedData.CBH_CLIENT_ID, serviceId: 'cbh_psychosis', locationId: 'cbhloc_anaheim-hills',
      }), /not offered at Anaheim Hills/);
      assert.ok(!(tables.pages || []).length, 'nothing was written');
    });
  });

  await testAsync('saving a page made before the rules leaves it exactly as it was judged', async () => {
    const old = page({ marker: false, mutate: (l3) => { l3.approach.therapies = ['CBT, DBT and ketamine.']; } });
    await withMemoryStore({
      ...tablesFor(),
      pages: [{ id: 'cbh_1', client_id: seedData.CBH_CLIENT_ID, service_id: 'cbh_anxiety', location_id: 'cbhloc_anaheim-hills',
        page_type: cbhWizard.PAGE_TYPE, page_object: structuredClone(old) }],
    }, async (tables) => {
      const res = await cbhWizard.saveContent({ pageId: 'cbh_1', page: structuredClone(old) });
      const stored = tables.pages[0].page_object;
      assert.ok(!('feedback' in stored) && !('feedbackReview' in stored), 'no feedback fields were added');
      assert.ok(!res.qc.checks.some(c => String(c.id).startsWith('fb_')), 'and no feedback checks ran');
    });
  });

  await testAsync('saving a new page re-runs the rules and keeps the stored review, not the client\'s copy', async () => {
    const p = page({ mutate: (l3) => { l3.approach.therapies = ['CBT, DBT and ketamine.']; } });
    const stored = structuredClone(p);
    stored.feedbackReview = fb.emptyReview(stored, SEED);
    await withMemoryStore({
      ...tablesFor(),
      pages: [{ id: 'cbh_1', client_id: seedData.CBH_CLIENT_ID, service_id: 'cbh_anxiety', location_id: 'cbhloc_anaheim-hills',
        page_type: cbhWizard.PAGE_TYPE, page_object: stored }],
    }, async (tables) => {
      const sent = structuredClone(stored);
      sent.feedbackReview = { forged: true };
      delete sent.feedback;
      const res = await cbhWizard.saveContent({ pageId: 'cbh_1', page: sent });
      assert.ok(res.qc.checks.find(c => c.id === 'fb_no-tms-ketamine' && !c.pass));
      assert.strictEqual(tables.pages[0].page_object.feedbackReview.forged, undefined);
      assert.ok(tables.pages[0].page_object.feedback, 'the marker survives a client that dropped it');
    });
  });

  await testAsync('re-checking refreshes the review on a new page and refuses an old one', async () => {
    const p = page();
    await withMemoryStore({
      ...tablesFor(),
      pages: [
        { id: 'cbh_new', client_id: seedData.CBH_CLIENT_ID, service_id: 'cbh_anxiety', location_id: 'cbhloc_anaheim-hills',
          page_type: cbhWizard.PAGE_TYPE, page_object: structuredClone(p) },
        { id: 'cbh_old', client_id: seedData.CBH_CLIENT_ID, service_id: 'cbh_anxiety', location_id: 'cbhloc_anaheim-hills',
          page_type: cbhWizard.PAGE_TYPE, page_object: structuredClone(page({ marker: false })) },
      ],
    }, async (tables) => {
      stubByPrompt([{ match: review.REVIEWER_MARKER, answer: { results: [
        { ruleKey: 'stay-on-condition', compliant: false, section: 'educational.body',
          evidence: 'Worry that is hard to control most days', fix: 'Stay on anxiety.' },
      ] } }]);
      try {
        const res = await cbhWizard.recheckFeedback({ pageId: 'cbh_new' });
        assert.ok(tables.pages[0].page_object.feedbackReview.reviewedAt);
        assert.ok(res.qc.checks.find(c => c.id === 'fb_stay-on-condition_review' && !c.pass));
        await assert.rejects(cbhWizard.recheckFeedback({ pageId: 'cbh_old' }), /before the client feedback rules/);
        assert.ok(!('feedbackReview' in tables.pages[1].page_object), 'the old page was not touched');
      } finally { setLlmStub(null); }
    });
  });

  console.log('\nCBH feedback rules - drafting rules from pasted feedback');
  const draft = require('../cbhFeedbackDraft');
  const admin = require('../cbhFeedbackAdmin');
  const vocab = { serviceIds: seed.CBH_SERVICES.map(s => s.id), services: seed.CBH_SERVICES };
  const BATCH = { id: 'fbb_1', client_id: seedData.CBH_CLIENT_ID, title: 'Call notes', received_at: '2026-10-20',
    raw_text: 'Never mention art therapy, we do not offer it. Also please only offer OCD pages at residential locations.' };
  const drafted = {
    rules: [
      { key: 'no-art-therapy', title: 'Art therapy is not offered', quote: 'Never mention art therapy, we do not offer it.',
        severity: 'Critical', instruction: 'Never mention art therapy.', stages: ['brief', 'writer', 'regen'],
        checks: [{ type: 'forbid', unit: 'field', pattern: '\\bart\\s+therapy\\b', message: 'Mentions art therapy' }] },
      { key: 'broken-regex', title: 'Broken', instruction: 'x', checks: [{ type: 'forbid', pattern: '(' }] },
      { key: 'unknown-service', title: 'Bad scope', instruction: 'x', scope: { services: ['cbh_nope'] }, checks: [] },
    ],
    revisions: [{ ruleKey: 'no-biofeedback', rule: { ...byKey('no-biofeedback'), instruction: 'Never mention biofeedback or neurofeedback.' } }],
    actionItems: ['Offer OCD pages only at mental-health residential locations (service/location availability change).'],
  };

  await testAsync('the drafter keeps valid rules as drafts, rejects broken ones and routes code changes', async () => {
    const calls = stubByPrompt([{ match: draft.DRAFTER_MARKER, answer: drafted }]);
    try {
      const out = await draft.draftRules({ batch: BATCH, activeRules: SEED, vocab });
      assert.deepStrictEqual(out.rules.map(r => r.key), ['no-art-therapy']);
      assert.ok(out.rules.every(r => r.status === 'draft'));
      assert.deepStrictEqual(out.rejected.map(r => r.key).sort(), ['broken-regex', 'unknown-service']);
      assert.ok(out.rejected.every(r => r.errors.length));
      assert.strictEqual(out.revisions.length, 1);
      assert.strictEqual(out.revisions[0].ruleKey, 'no-biofeedback');
      assert.deepStrictEqual(out.actionItems.map(a => a.status), ['open']);
      const { system, user } = calls[0];
      assert.ok(user.includes('Never mention art therapy'), 'the raw feedback is in the prompt');
      assert.ok(user.includes('cbh_psychosis') && user.includes('educational.body'), 'so is the vocabulary');
      assert.ok(user.includes('no-biofeedback'), 'and the rules already in force');
      assert.ok(/which services are offered at which locations/i.test(system), 'the code-change categories are spelled out');
    } finally { setLlmStub(null); }
  });

  await testAsync('a revision of an unknown rule is dropped, and a duplicate key becomes a revision', async () => {
    stubByPrompt([{ match: draft.DRAFTER_MARKER, answer: {
      rules: [{ ...byKey('no-biofeedback'), instruction: 'Never mention biofeedback in any form.' }],
      revisions: [{ ruleKey: 'not-a-rule', rule: { title: 'x', instruction: 'y' } }],
      actionItems: [],
    } }]);
    try {
      const out = await draft.draftRules({ batch: BATCH, activeRules: SEED, vocab });
      assert.deepStrictEqual(out.rules, []);
      assert.deepStrictEqual(out.revisions.map(r => r.ruleKey), ['no-biofeedback']);
    } finally { setLlmStub(null); }
  });

  console.log('\nCBH feedback rules - managing rules and batches (in-memory store)');

  await testAsync('rules: create validates, rejects a duplicate key, and edits keep history', async () => {
    await withMemoryStore(tablesFor(), async (tables) => {
      const c = seedData.CBH_CLIENT_ID;
      await assert.rejects(admin.createRule({ clientId: c, rule: { title: 'x', instruction: 'y', checks: [{ type: 'forbid', pattern: '(' }] } }),
        e => e.status === 400 && /not a valid regex/.test(e.message));
      await assert.rejects(admin.createRule({ clientId: c, rule: { ...byKey('no-biofeedback') } }), e => e.status === 409);
      const made = await admin.createRule({ clientId: c, rule: { key: 'no-art-therapy', title: 'No art therapy', instruction: 'Never mention art therapy.',
        checks: [{ type: 'forbid', pattern: '\\bart therapy\\b' }] } });
      assert.strictEqual(made.version, 1);
      assert.strictEqual(made.status, 'draft');
      const edited = await admin.updateRule({ id: made.id, rule: { ...made, instruction: 'Never mention art or music therapy.' } });
      assert.strictEqual(edited.version, 2);
      assert.strictEqual(edited.history.length, 1);
      assert.strictEqual(edited.history[0].instruction, 'Never mention art therapy.');
      const live = await admin.setRuleStatus({ id: made.id, status: 'active' });
      assert.strictEqual(live.status, 'active');
      assert.ok((await fb.loadActiveRules(c)).some(r => r.key === 'no-art-therapy'), 'the cache was cleared on write');
      assert.strictEqual(tables.feedbackRules.length, SEED.length + 1);
    });
  });

  await testAsync('batches: drafting saves draft rules, revisions and action items on the batch', async () => {
    await withMemoryStore(tablesFor(), async (tables) => {
      const c = seedData.CBH_CLIENT_ID;
      const batch = await admin.createBatch({ clientId: c, title: 'Call notes', receivedAt: '2026-10-20', rawText: BATCH.raw_text });
      stubByPrompt([{ match: draft.DRAFTER_MARKER, answer: drafted }]);
      try {
        const out = await admin.draftBatch({ id: batch.id });
        assert.deepStrictEqual(out.rules.map(r => r.key), ['no-art-therapy']);
        assert.strictEqual(out.rejected.length, 2);
      } finally { setLlmStub(null); }
      const stored = tables.feedbackbatches || tables.feedbackBatches;
      const b = stored.find(x => x.id === batch.id);
      assert.deepStrictEqual(b.rule_keys, ['no-art-therapy']);
      assert.strictEqual(b.action_items.length, 1);
      assert.strictEqual(b.proposed_revisions.length, 1);
      const rule = tables.feedbackRules.find(r => r.key === 'no-art-therapy');
      assert.strictEqual(rule.status, 'draft');
      assert.strictEqual(rule.batch_id, batch.id);

      const done = await admin.updateActionItem({ id: batch.id, index: 0, status: 'done', note: 'seed.js changed' });
      assert.strictEqual(done.action_items[0].status, 'done');
      assert.strictEqual(done.action_items[0].note, 'seed.js changed');

      const applied = await admin.applyRevision({ id: batch.id, index: 0 });
      assert.ok(applied.rule.instruction.includes('neurofeedback'));
      assert.strictEqual(applied.rule.version, 2);
      assert.strictEqual(applied.batch.proposed_revisions[0].applied, true);
    });
  });

  test('testing a rule on sample text ignores its scope and reports what it would catch', () => {
    const res = admin.testRule({ rule: byKey('stress-philosophy-opening'), section: 'approach.philosophy',
      text: 'We help you manage stress.' });
    assert.strictEqual(res.pass, false);
    assert.ok(/client.s wording/.test(res.detail), res.detail);
    const ok = admin.testRule({ rule: byKey('stress-philosophy-opening'), section: 'approach.philosophy', text: LINE });
    assert.strictEqual(ok.pass, true);
    assert.throws(() => admin.testRule({ rule: { title: 'x', instruction: 'y', checks: [{ type: 'forbid', pattern: '(' }] }, text: 'a' }),
      e => e.status === 400);
  });

  return { SEED, page, stubByPrompt };
};
