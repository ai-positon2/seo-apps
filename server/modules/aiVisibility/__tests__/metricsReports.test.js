// ── metrics/reports ───────────────────────────────────────────────────────
//
// The §12 contract: one envelope, every number pre-formatted, and the UI does
// no metric maths. The tests that matter most are the ones proving the
// Executive overview RE-SELECTS rather than recomputes (§10) — two independent
// computations of "visibility" would eventually disagree and put two different
// numbers on two screens.
//
// Run: node modules/aiVisibility/__tests__/metricsReports.test.js

const assert = require('assert');
const reports = require('../metrics/reports');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (e) { failed += 1; console.error(`  ✗ ${name}\n    ${e.message}`); }
}
const section = (name) => console.log(`\n${name}`);

const CLIENT = { id: 'b1', name: 'Gentle Dental', isClient: true, domain: 'gentledental.com' };
const COMP = { id: 'b2', name: 'Aspen Dental', isClient: false, domain: 'aspendental.com' };
const BRANDS = [CLIENT, COMP];

const PROMPTS = [
  { id: 'p1', text: 'best dentist in boston', topicLabel: 'General dentistry', slot: 'local_geo' },
  { id: 'p2', text: 'dental implants cost boston', topicLabel: 'Implants', slot: 'cost_pricing' },
];

// 4 captures this period, 4 in the previous one, same two prompts.
const CAPTURES = [
  ...['p1', 'p1', 'p2', 'p2'].map((promptId, i) => ({
    id: `now${i}`,
    promptId,
    prompt: PROMPTS.find((p) => p.id === promptId).text,
    engine: i % 2 ? 'gemini' : 'chatgpt',
    status: 'captured',
    offGeo: false,
    features: ['web_search'],
    answerText: 'Gentle Dental is well reviewed in Boston.',
    capturedAt: '2026-08-20T10:00:00Z',
    extractedAt: '2026-08-20T11:00:00Z',
  })),
  ...['p1', 'p1', 'p2', 'p2'].map((promptId, i) => ({
    id: `prev${i}`,
    promptId,
    prompt: PROMPTS.find((p) => p.id === promptId).text,
    engine: i % 2 ? 'gemini' : 'chatgpt',
    status: 'captured',
    offGeo: false,
    features: ['web_search'],
    answerText: 'An earlier answer.',
    capturedAt: '2026-07-10T10:00:00Z',
    extractedAt: '2026-07-10T11:00:00Z',
  })),
];

// Client named in 2 of 4 now (50%), 1 of 4 before (25%).
const MENTIONS = [
  { captureId: 'now0', brandId: 'b1', ordinal: 1, mentionCount: 2, negated: false, sentimentScore: 70 },
  { captureId: 'now1', brandId: 'b1', ordinal: 2, mentionCount: 1, negated: false, sentimentScore: 60 },
  { captureId: 'now0', brandId: 'b2', ordinal: 2, mentionCount: 1, negated: false, sentimentScore: 50 },
  { captureId: 'now2', brandId: 'b2', ordinal: 1, mentionCount: 3, negated: false, sentimentScore: 50 },
  { captureId: 'prev0', brandId: 'b1', ordinal: 3, mentionCount: 1, negated: false, sentimentScore: 55 },
];

const CITATIONS = [
  { captureId: 'now0', domain: 'zocdoc.com', host: 'zocdoc.com', url: 'https://zocdoc.com/dentists', isInlineCited: true, occurrences: 2, domainType: 'reference', urlType: 'category' },
  { captureId: 'now2', domain: 'zocdoc.com', host: 'zocdoc.com', url: 'https://zocdoc.com/dentists', isInlineCited: true, occurrences: 1, domainType: 'reference', urlType: 'category' },
  { captureId: 'now1', domain: 'gentledental.com', host: 'gentledental.com', url: null, isInlineCited: true, occurrences: 1, domainType: 'you', urlType: null },
];

const INPUT = {
  captures: CAPTURES,
  mentions: MENTIONS,
  citations: CITATIONS,
  brands: BRANDS,
  prompts: PROMPTS,
  options: { to: '2026-08-29', days: 30 },
};

section('the envelope — §12');

test('every report returns meta, data and warnings', () => {
  for (const id of reports.REPORT_IDS) {
    const r = reports.buildReport(id, INPUT);
    assert.deepStrictEqual(Object.keys(r).sort(), ['data', 'meta', 'warnings'], `${id}`);
  }
});

test('an unknown report id is a 400, not a silent empty page', () => {
  assert.throws(() => reports.buildReport('made_up', INPUT), /Unknown report/);
});

test('meta carries the period, the compare period and the ruleset version', () => {
  const { meta } = reports.buildReport('insights', INPUT);
  assert.strictEqual(meta.period.to, '2026-08-29');
  assert.strictEqual(meta.comparePeriod.to, '2026-07-30');
  assert.ok(meta.rulesetVersion, 'a past period must stay recomputable under its own rules');
  assert.strictEqual(meta.promptsMeasured, 2);
});

test('coverage is stated as a fraction the reader can check', () => {
  const { meta } = reports.buildReport('insights', INPUT);
  assert.strictEqual(meta.coverageLabel, '4 of 4 captured');
  assert.strictEqual(meta.coverage.display, '100.0%');
});

section('KPIs — the numbers arrive pre-formatted');

test('visibility ships raw AND display, so the UI never divides', () => {
  const { data } = reports.buildReport('insights', INPUT);
  assert.strictEqual(data.kpis.visibility.value, 0.5);
  assert.strictEqual(data.kpis.visibility.display, '50.0%');
});

test('the delta is computed on the intersection, in percentage points', () => {
  const { data } = reports.buildReport('insights', INPUT);
  assert.strictEqual(data.kpis.visibility.deltaDisplay, '+25.0 pts', '50% now vs 25% before');
});

test('position carries lower_is_better so an improving rank is not painted red', () => {
  const { data } = reports.buildReport('insights', INPUT);
  assert.strictEqual(data.kpis.position.direction, 'lower_is_better');
  assert.strictEqual(data.kpis.position.display, '#1.5');
});

test('sentiment says what it rests on, because it ships uncalibrated', () => {
  const { data } = reports.buildReport('insights', INPUT);
  assert.match(data.kpis.sentiment.note, /Scored on 2 of 2 mentions/);
});

test('share of voice discloses the excluded `other` bucket', () => {
  const { data } = reports.buildReport('insights', INPUT);
  // client 3 mentions, competitor 4 → 3/7
  assert.strictEqual(data.kpis.shareOfVoice.display, '42.9%');
  assert.strictEqual(data.kpis.shareOfVoice.note, undefined,
    'with nothing outside the measured set, the key is omitted rather than carried as null');
});

test('a model with too few captures is not named strongest', () => {
  const { data } = reports.buildReport('insights', INPUT);
  assert.strictEqual(data.kpis.strongestModel.engine, null);
  assert.strictEqual(data.kpis.strongestModel.note, 'insufficient_captures_per_model');
  assert.strictEqual(data.kpis.strongestModel.display, '—');
});

section('§10 — the Executive overview re-selects, it does not recompute');

test('the overview hero number is IDENTICAL to the Insights report', () => {
  const ov = reports.buildReport('overview', INPUT);
  const ins = reports.buildReport('insights', INPUT);
  assert.deepStrictEqual(ov.data.kpis, ins.data.kpis,
    'two computations of the same metric would eventually disagree');
});

test('the overview gap list is the top of the Gap analysis query, not its own', () => {
  const ov = reports.buildReport('overview', INPUT);
  const gaps = reports.buildReport('gaps', INPUT);
  assert.deepStrictEqual(ov.data.topGaps, gaps.data.topFive);
});

section('prompts report — the weak-markets list is the same query');

test('rows sort weakest first and carry their topic', () => {
  const { data } = reports.buildReport('prompts', INPUT);
  assert.strictEqual(data.rows.length, 2);
  assert.strictEqual(data.rows[0].visibility.value, 0, 'p2 never named the client');
  assert.strictEqual(data.rows[0].topicLabel, 'Implants');
});

test('a prompt measured but never naming the client is 0%, not an em-dash', () => {
  const { data } = reports.buildReport('prompts', INPUT);
  assert.strictEqual(data.rows[0].visibility.display, '0.0%',
    'a real zero is a finding; an em-dash would say we never asked');
});

section('sources — Domains and URLs share a builder, not a definition');

test('domains roll up and both count definitions ship', () => {
  const { data } = reports.buildReport('domains', INPUT);
  const zocdoc = data.rows.find((r) => r.domain === 'zocdoc.com');
  assert.strictEqual(zocdoc.retrievals.display, '3');
  assert.strictEqual(zocdoc.retrievedPct.display, '50.0%', '2 of 4 captures cited it');
});

test('a domain-only citation is flagged rather than given a guessed URL type', () => {
  const r = reports.buildReport('domains', INPUT);
  assert.ok(r.warnings.includes('url_type_unavailable'),
    'ChatGPT exposes domains only — the report must say what it does not know');
});

section('chats — §4');

test('the two citation definitions stay distinct', () => {
  const { data } = reports.buildReport('chats', INPUT);
  assert.strictEqual(data.kpis.totalChats.display, '4');
  assert.strictEqual(data.kpis.brandMentioned.display, '2');
  assert.strictEqual(data.kpis.webSearch.display, '100.0%');
});

section('run detail — §3.3');

test('the score is labelled Run visibility, never Visibility', () => {
  const { data } = reports.buildReport('run', INPUT);
  assert.strictEqual(data.label, 'Run visibility');
  assert.strictEqual(data.score.display, '50');
  assert.strictEqual(data.basis, '2 of 4 captures');
});

test('with no client brand the basis does not read as a measured zero', () => {
  const { data } = reports.buildReport('run', { ...INPUT, brands: [] });
  assert.strictEqual(data.score.display, '—');
  assert.strictEqual(data.basis, '4 captures, none matched against a brand',
    '"0 of 4" beside an em-dash claims a measurement that never happened');
  assert.match(data.score.note, /No client brand approved/);
});

test('cited-instead excludes the client\'s own domain', () => {
  const { data } = reports.buildReport('run', INPUT);
  assert.ok(!data.citedInstead.some((d) => d.domain === 'gentledental.com'));
});

section('perception — an unanswerable report says so instead of 404ing');

test('with nothing extracted the shape still returns, with a warning', () => {
  const r = reports.buildReport('perception', INPUT);
  assert.deepStrictEqual(r.data.association, []);
  assert.ok(r.warnings.includes('perception_not_extracted'));
});

section('warnings propagate to every report');

test('sub-90% coverage warns on every report, not just the one that noticed', () => {
  const withFailure = {
    ...INPUT,
    captures: [...CAPTURES, {
      id: 'x', promptId: 'p1', engine: 'chatgpt', status: 'failed', offGeo: false, capturedAt: '2026-08-20T10:00:00Z',
    }],
  };
  for (const id of ['overview', 'insights', 'prompts', 'chats']) {
    assert.ok(reports.buildReport(id, withFailure).warnings.includes('coverage_below_threshold'), id);
  }
});

test('a changed prompt set is disclosed wherever a delta is shown', () => {
  // p9 is a question this client currently asks, added since the previous
  // period. It has to be in `prompts` as well as in `captures`: a capture
  // belonging to no current question is excluded before any of this runs.
  const changed = {
    ...INPUT,
    prompts: [...PROMPTS, { id: 'p9', text: 'emergency dentist boston', topicLabel: 'Urgent' }],
    captures: [...CAPTURES, {
      id: 'new', promptId: 'p9', engine: 'chatgpt', status: 'captured', offGeo: false, capturedAt: '2026-08-21T10:00:00Z',
    }],
  };
  const r = reports.buildReport('insights', changed);
  assert.ok(r.warnings.includes('prompt_set_changed'));
  assert.match(r.meta.comparison.note, /2 of 3 prompts/);
});

section('a removed question leaves reporting entirely');

test('its captures are excluded from every metric, INCLUDING coverage', () => {
  // Coverage is the one metric whose denominator counts failures (§3.1), so a
  // removed question could otherwise keep dragging it down after the successes
  // it paid for had already gone. Both halves have to leave together.
  const withRemoved = {
    ...INPUT,
    captures: [
      ...CAPTURES,
      { id: 'gone1', promptId: 'pRemoved', engine: 'chatgpt', status: 'captured', offGeo: false, capturedAt: '2026-08-20T10:00:00Z' },
      { id: 'gone2', promptId: 'pRemoved', engine: 'gemini', status: 'failed', offGeo: false, capturedAt: '2026-08-20T10:00:00Z' },
    ],
    // pRemoved is deliberately NOT here: the reports route loads only draft
    // and approved prompts, so a removed one never reaches this function.
  };
  const base = reports.buildReport('insights', INPUT);
  const after = reports.buildReport('insights', withRemoved);

  assert.strictEqual(after.meta.captures, base.meta.captures, 'measured captures unchanged');
  assert.strictEqual(
    after.meta.coverageLabel, base.meta.coverageLabel,
    'coverage must not count a removed question\'s failure',
  );
  assert.deepStrictEqual(after.data.kpis, base.data.kpis, 'no headline number moves');
});

test('the exclusion is disclosed, not silent', () => {
  const withRemoved = {
    ...INPUT,
    captures: [...CAPTURES, {
      id: 'gone', promptId: 'pRemoved', engine: 'chatgpt', status: 'captured', offGeo: false, capturedAt: '2026-08-20T10:00:00Z',
    }],
  };
  const r = reports.buildReport('insights', withRemoved);
  assert.ok(r.warnings.includes('removed_prompts_excluded'));
  assert.strictEqual(r.meta.excludedCaptures, 1);
});

test('nothing removed raises no warning', () => {
  const r = reports.buildReport('insights', INPUT);
  assert.ok(!r.warnings.includes('removed_prompts_excluded'));
  assert.strictEqual(r.meta.excludedCaptures, 0);
});

test('meta.basis names the set the numbers rest on', () => {
  const r = reports.buildReport('insights', INPUT);
  assert.strictEqual(r.meta.promptCount, 2);
  assert.match(r.meta.basis, /4 captures across 2 questions/);
});

test('a capture with no prompt at all is excluded too', () => {
  // An orphan belongs to no current question, so it cannot be attributed to
  // one. Counting it would put numbers on screen that no row explains.
  const orphaned = {
    ...INPUT,
    captures: [...CAPTURES, {
      id: 'orphan', promptId: null, engine: 'chatgpt', status: 'captured', offGeo: false, capturedAt: '2026-08-20T10:00:00Z',
    }],
  };
  const r = reports.buildReport('insights', orphaned);
  assert.strictEqual(r.meta.captures, 4);
  assert.strictEqual(r.meta.excludedCaptures, 1);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
