// ── metrics/core ──────────────────────────────────────────────────────────
//
// The denominators. Every test here exists because getting one wrong turns a
// measurement failure into a claim about the client — the one thing this
// module is built not to do.
//
// Run: node modules/aiVisibility/__tests__/metricsCore.test.js

const assert = require('assert');
const core = require('../metrics/core');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (e) { failed += 1; console.error(`  ✗ ${name}\n    ${e.message}`); }
}
const section = (name) => console.log(`\n${name}`);

const CLIENT = 'b1';
const COMP = 'b2';

const cap = (id, over = {}) => ({
  id,
  promptId: `p${id}`,
  prompt: `prompt ${id}`,
  engine: 'chatgpt',
  status: 'captured',
  offGeo: false,
  features: ['web_search'],
  answerText: 'An answer.',
  capturedAt: '2026-08-20T10:00:00Z',
  extractedAt: '2026-08-20T11:00:00Z',
  ...over,
});

const men = (captureId, brandId, over = {}) => ({
  captureId, brandId, ordinal: 1, mentionCount: 1, negated: false, sentimentScore: null, ...over,
});

const cit = (captureId, domain, over = {}) => ({
  captureId, domain, host: domain, url: null, isInlineCited: true, occurrences: 1, domainType: 'reference', ...over,
});

section('scopeCaptures — the denominator is MEASURED captures');

test('a failed capture is excluded, so it can never read as an absence', () => {
  const rows = [cap('1'), cap('2', { status: 'failed' })];
  assert.strictEqual(core.scopeCaptures(rows).length, 1);
});

test('an off-geo capture is excluded rather than counted as a miss', () => {
  const rows = [cap('1'), cap('2', { offGeo: true })];
  assert.strictEqual(core.scopeCaptures(rows).length, 1,
    'an answer about the wrong city must not penalise the client for our targeting error');
});

section('coverage — §3.1, the ONE metric that counts failures');

test('coverage divides by attempted, unlike everything else', () => {
  const c = core.coverage([cap('1'), cap('2'), cap('3', { status: 'failed' })]);
  assert.strictEqual(c.attempted, 3);
  assert.strictEqual(c.captured, 2);
  assert.ok(Math.abs(c.value - 2 / 3) < 1e-9);
});

test('below 90% the warning is raised here, not left to each report', () => {
  assert.strictEqual(core.coverage([cap('1'), cap('2', { status: 'failed' })]).belowThreshold, true);
  assert.strictEqual(core.coverage([cap('1'), cap('2')]).belowThreshold, false);
});

section('visibility — §3.2');

test('a brand named twice in one capture still counts that capture once', () => {
  const scoped = core.scopeCaptures([cap('1'), cap('2')]);
  const v = core.visibility(scoped, [men('1', CLIENT), men('1', CLIENT)], CLIENT);
  assert.strictEqual(v.named, 1, 'visibility is per capture; repetition belongs to share of voice');
  assert.strictEqual(v.value, 0.5);
});

test('a negated mention does not count as being named', () => {
  const scoped = core.scopeCaptures([cap('1'), cap('2')]);
  const v = core.visibility(scoped, [men('1', CLIENT, { negated: true })], CLIENT);
  assert.strictEqual(v.named, 0, '"not affiliated with X" is not a recommendation');
});

test('zero measured captures returns null, not zero', () => {
  assert.strictEqual(core.visibility([], [], CLIENT).value, null);
});

section('run visibility — §3.3, deliberately a separate name');

test('1 of 8 captures is 13, and is labelled Run visibility', () => {
  const scoped = core.scopeCaptures(Array.from({ length: 8 }, (_, i) => cap(String(i))));
  const r = core.runVisibility(scoped, [men('0', CLIENT)], CLIENT);
  assert.strictEqual(r.score, 13, '12.5 rounds half-up');
  assert.strictEqual(r.label, 'Run visibility',
    'calling this "Visibility" puts two contradictory numbers in front of one client');
});

section('share of voice — §3.4, share of ATTENTION');

test('an unconfigured brand goes to `other` and is excluded from the denominator', () => {
  const scoped = core.scopeCaptures([cap('1')]);
  const mentions = [
    men('1', CLIENT, { mentionCount: 3 }),
    men('1', COMP, { mentionCount: 1 }),
    men('1', 'stranger', { mentionCount: 6 }),
  ];
  const sov = core.shareOfVoice(scoped, mentions, [CLIENT, COMP]);
  assert.strictEqual(sov.totalMentions, 4, 'the stranger must not move the percentages');
  assert.strictEqual(sov.otherMentions, 6, 'but its size is surfaced so the number is auditable');
  assert.strictEqual(sov.rows.find((r) => r.brandId === CLIENT).value, 0.75);
});

test('a configured brand never named still gets a row at zero', () => {
  const scoped = core.scopeCaptures([cap('1')]);
  const sov = core.shareOfVoice(scoped, [men('1', CLIENT)], [CLIENT, COMP]);
  const comp = sov.rows.find((r) => r.brandId === COMP);
  assert.strictEqual(comp.mentions, 0, 'a competitor with no mentions is a finding, not a missing row');
  assert.strictEqual(comp.value, 0);
});

section('position — §3.5, absence contributes nothing');

test('captures where the brand is absent do not drag the average down', () => {
  const scoped = core.scopeCaptures([cap('1'), cap('2'), cap('3')]);
  const p = core.position(scoped, [men('1', CLIENT, { ordinal: 2 }), men('2', CLIENT, { ordinal: 4 })], CLIENT);
  assert.strictEqual(p.value, 3, 'imputing a worst-case rank would penalise absence twice');
  assert.strictEqual(p.basis, 2);
});

test('never named returns null, not a worst-case rank', () => {
  const scoped = core.scopeCaptures([cap('1')]);
  assert.strictEqual(core.position(scoped, [], CLIENT).value, null);
});

section('sentiment — §3.6, unscored is not neutral');

test('unscored mentions are excluded and the basis is reported', () => {
  const scoped = core.scopeCaptures([cap('1'), cap('2')]);
  const s = core.sentiment(scoped, [
    men('1', CLIENT, { sentimentScore: 70 }),
    men('2', CLIENT, { sentimentScore: null }),
  ], CLIENT);
  assert.strictEqual(s.value, 70, 'a null score must not be averaged in as 50');
  assert.strictEqual(s.scored, 1);
  assert.strictEqual(s.basis, 2, 'the report can say the number rests on 1 of 2 mentions');
});

test('nothing scored returns null, never 0', () => {
  const scoped = core.scopeCaptures([cap('1')]);
  assert.strictEqual(core.sentiment(scoped, [men('1', CLIENT)], CLIENT).value, null);
});

section('strongest / weakest model — §3.7');

test('a model with too few captures is not rankable', () => {
  const rows = [
    ...Array.from({ length: 20 }, (_, i) => cap(`a${i}`, { engine: 'chatgpt' })),
    ...Array.from({ length: 3 }, (_, i) => cap(`b${i}`, { engine: 'gemini' })),
  ];
  const scoped = core.scopeCaptures(rows);
  const engines = core.byEngine(scoped, [men('b0', CLIENT)], CLIENT);
  assert.strictEqual(engines.find((e) => e.engine === 'gemini').rankable, false);
  assert.strictEqual(engines.find((e) => e.engine === 'chatgpt').rankable, true);
});

test('with nothing rankable, both are null and the reason is given', () => {
  const scoped = core.scopeCaptures([cap('1')]);
  const sw = core.strongestWeakest(core.byEngine(scoped, [], CLIENT));
  assert.strictEqual(sw.strongest, null);
  assert.strictEqual(sw.reason, 'insufficient_captures_per_model');
});

section('trend — a gap must stay a gap');

test('a bucket with no captures is null, never zero', () => {
  const rows = [
    cap('1', { capturedAt: '2026-08-01T10:00:00Z' }),
    // nothing on the 2nd
    cap('3', { capturedAt: '2026-08-03T10:00:00Z' }),
  ];
  const t = core.trend(core.scopeCaptures(rows), [men('1', CLIENT)], CLIENT, { from: '2026-08-01', to: '2026-08-03' });
  const all = t.series.find((x) => x.key === 'all');
  assert.strictEqual(all.points[0].value, 1);
  assert.strictEqual(all.points[1].value, null,
    'zero would show visibility collapsing on a day the scheduler simply did not fire');
  assert.strictEqual(all.points[2].value, 0, 'but a day that ran and never named IS a zero');
});

test('long periods bucket weekly rather than drawing 365 sub-pixel points', () => {
  const t = core.trend([], [], CLIENT, { from: '2026-01-01', to: '2026-12-31' });
  assert.ok(t.sizeDays > 1);
  assert.ok(t.buckets.length <= 30, `got ${t.buckets.length} buckets`);
});

test('one series per engine, plus an overall', () => {
  const rows = [
    cap('1', { engine: 'chatgpt', capturedAt: '2026-08-01T10:00:00Z' }),
    cap('2', { engine: 'gemini', capturedAt: '2026-08-01T10:00:00Z' }),
  ];
  const t = core.trend(core.scopeCaptures(rows), [], CLIENT, { from: '2026-08-01', to: '2026-08-02' });
  assert.deepStrictEqual(t.series.map((x) => x.key), ['all', 'chatgpt', 'gemini']);
});

section('chats — §4, two citation definitions that differ on purpose');

test('averageCitation counts INLINE only; the row `sources` counts everything', () => {
  const scoped = core.scopeCaptures([cap('1'), cap('2')]);
  const citations = [
    cit('1', 'ada.org'),
    cit('1', 'heart.org', { isInlineCited: false }),
    cit('2', 'yelp.com'),
  ];
  const c = core.chats(scoped, [], citations, CLIENT);
  assert.strictEqual(c.averageCitation, 1, '2 inline over 2 captures');
  assert.strictEqual(c.rows.find((r) => r.captureId === '1').sources, 2, 'retrieved-but-hidden still counts here');
});

test('over unextracted captures, citation counts are null rather than zero', () => {
  const scoped = core.scopeCaptures([cap('1', { extractedAt: null }), cap('2', { extractedAt: null })]);
  const c = core.chats(scoped, [], [], CLIENT);
  assert.strictEqual(c.averageCitation, null,
    '"0 sources per answer" would claim readers see none, when they have not been counted');
  assert.strictEqual(c.rows[0].sources, null);
  assert.strictEqual(c.citationsExtracted, false);
});

test('when no capture recorded any features, web-search share is null not 0%', () => {
  const scoped = core.scopeCaptures([cap('1', { features: [] }), cap('2', { features: [] })]);
  const c = core.chats(scoped, [], [], CLIENT);
  assert.strictEqual(c.webSearchPct, null,
    'the column is NOT NULL with an empty default — absent is not the same as none used');
  assert.strictEqual(c.featuresRecorded, false);
  assert.strictEqual(c.mostCommonFeature, null);
});

test('a capture where the client is absent leaves position blank, not zero', () => {
  const scoped = core.scopeCaptures([cap('1'), cap('2')]);
  const c = core.chats(scoped, [men('1', CLIENT, { ordinal: 3 })], [], CLIENT);
  assert.strictEqual(c.rows.find((r) => r.captureId === '1').position, 3);
  assert.strictEqual(c.rows.find((r) => r.captureId === '2').position, null,
    'the client was not ranked last, it was not there');
});

test('the excerpt strips markdown and truncates on a word boundary', () => {
  const text = `## Heading\n**Bold** ${'word '.repeat(60)}`;
  const e = core.excerpt(text);
  assert.ok(!e.includes('#') && !e.includes('**'));
  assert.ok(e.length <= 181);
  assert.ok(e.endsWith('…'));
});

section('domains — §5.2, retrievals and captures are different counts');

test('a capture citing one domain three times contributes 3 retrievals but 1 capture', () => {
  const scoped = core.scopeCaptures([cap('1'), cap('2')]);
  const rows = core.domains(scoped, [cit('1', 'ada.org', { occurrences: 3 })]);
  assert.strictEqual(rows[0].retrievals, 3);
  assert.strictEqual(rows[0].captures, 1);
  assert.strictEqual(rows[0].retrievedPct, 0.5, '1 of 2 captures cited it');
  assert.strictEqual(rows[0].retrievalRate, 3, 'average citations per answer that used it');
});

test('domain type shares are NOT normalised to sum to 100', () => {
  const scoped = core.scopeCaptures([cap('1')]);
  const rows = core.domains(scoped, [
    cit('1', 'ada.org', { domainType: 'institutional', occurrences: 1 }),
    cit('1', 'yelp.com', { domainType: 'ugc', occurrences: 2 }),
  ]);
  const mix = core.domainTypeMix(rows);
  assert.strictEqual(mix.totalRetrievals, 3, '§5.3: show the total so the reader can check');
  assert.ok(Math.abs(mix.rows.reduce((a, r) => a + r.value, 0) - 1) < 1e-9);
});

section('gap analysis — §6');

test('a domain that cites competitors but never the client scores a gap', () => {
  const scoped = core.scopeCaptures([cap('1'), cap('2'), cap('3'), cap('4')]);
  const mentions = [men('1', COMP), men('2', COMP), men('3', CLIENT)];
  const citations = [cit('1', 'zocdoc.com'), cit('2', 'zocdoc.com')];
  const [row] = core.gaps(scoped, mentions, citations, {
    clientBrandId: CLIENT, competitorBrandIds: [COMP],
  });
  assert.strictEqual(row.compCaptures, 2);
  assert.strictEqual(row.youCaptures, 0);
  assert.strictEqual(row.gapCaptures, 2);
  assert.strictEqual(row.retrievedPct, 0.5);
  // 2 × 0.5 × 100 × 1.0 (reference)
  assert.strictEqual(row.gapScore, 100);
});

test('a domain that cites you more than competitors floors at zero, not negative', () => {
  const scoped = core.scopeCaptures([cap('1'), cap('2')]);
  const mentions = [men('1', CLIENT), men('2', CLIENT)];
  const citations = [cit('1', 'zocdoc.com'), cit('2', 'zocdoc.com')];
  const [row] = core.gaps(scoped, mentions, citations, {
    clientBrandId: CLIENT, competitorBrandIds: [COMP],
  });
  assert.strictEqual(row.gapCaptures, 0);
  assert.strictEqual(row.gapScore, 0, 'a source that already cites you is not a gap');
});

test('type weight makes a directory outrank a competitor site at equal gap', () => {
  const scoped = core.scopeCaptures([cap('1'), cap('2')]);
  const mentions = [men('1', COMP), men('2', COMP)];
  const citations = [
    cit('1', 'zocdoc.com', { domainType: 'reference' }),
    cit('1', 'rival.com', { domainType: 'corporate' }),
    cit('2', 'zocdoc.com', { domainType: 'reference' }),
    cit('2', 'rival.com', { domainType: 'corporate' }),
  ];
  const rows = core.gaps(scoped, mentions, citations, {
    clientBrandId: CLIENT, competitorBrandIds: [COMP],
  });
  assert.strictEqual(rows[0].domain, 'zocdoc.com',
    'a directory you can get listed in beats a site you can never appear on');
});

section('§3.7 — a ranking needs at least two things to rank');

test('one rankable engine is strongest, and weakest is null', () => {
  // Returning the same engine as both printed one number twice under opposite
  // labels — a comparison presented where no comparison exists.
  const rows = [
    { engine: 'chatgpt', measured: 40, named: 20, value: 0.5, rankable: true },
    { engine: 'gemini', measured: 3, named: 0, value: 0, rankable: false },
  ];
  const { strongest, weakest, reason } = core.strongestWeakest(rows);
  assert.strictEqual(strongest.engine, 'chatgpt');
  assert.strictEqual(weakest, null);
  assert.strictEqual(reason, 'only_one_rankable_model');
});

test('two rankable engines still rank normally', () => {
  const rows = [
    { engine: 'chatgpt', measured: 40, named: 30, value: 0.75, rankable: true },
    { engine: 'gemini', measured: 40, named: 10, value: 0.25, rankable: true },
  ];
  const { strongest, weakest, reason } = core.strongestWeakest(rows);
  assert.strictEqual(strongest.engine, 'chatgpt');
  assert.strictEqual(weakest.engine, 'gemini');
  assert.strictEqual(reason, null);
});

test('no rankable engine names neither', () => {
  const { strongest, weakest, reason } = core.strongestWeakest([
    { engine: 'chatgpt', measured: 3, named: 3, value: 1, rankable: false },
  ]);
  assert.strictEqual(strongest, null);
  assert.strictEqual(weakest, null);
  assert.strictEqual(reason, 'insufficient_captures_per_model');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
