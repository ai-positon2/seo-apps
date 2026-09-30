// ── The report, over rows rather than over a database ───────────────────────
//
// This is the test that the metric REUSE is real: every number below is
// produced by v1's scoring.js, metrics/core.js, metrics/period.js and
// metrics/format.js, reading rows this module stores. If the row shape ever
// drifts from what those functions read, the failures land here rather than as
// an empty dashboard nobody can explain.
//
// The three-state rule (§11) is the other thing under test:
//
//   no data in scope  -> '—'
//   zero measured     -> '—'
//   a real zero       -> '0.0%'
//
// These are different claims. "We asked and you were never named" is a finding;
// "we could not ask" is not.
//
// Run: node modules/aiVisibilityLite/__tests__/report.test.js

const assert = require('assert');
const report = require('../report');
const { costOf, PRICING } = require('../models');

let passed = 0; let failed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ✓ ${name}`); } catch (e) { failed += 1; console.error(`  ✗ ${name}\n    ${e.message}`); }
}
const section = (name) => console.log(`\n${name}`);

const BRAND = { name: 'Acme Dental', domain: 'acmedental.com' };
const RIVAL = { name: 'Rival Dental', domain: 'rivaldental.com' };
const PROMPTS = [{ id: 'p1', text: 'best dentist in raleigh' }, { id: 'p2', text: 'what do implants cost' }];

const ago = (days) => new Date(Date.now() - days * 86_400_000).toISOString();

/** A stored capture in the shape store.captureRow returns. */
const cap = (over = {}) => ({
  id: over.id || Math.random().toString(36).slice(2),
  promptId: 'p1',
  prompt: 'best dentist in raleigh',
  engine: 'openai',
  surfaceLabel: 'ChatGPT (API · web search)',
  status: 'captured',
  answerText: 'Acme Dental is well reviewed in the area for implants and general care.',
  citations: [],
  mentioned: true,
  cited: false,
  prominence: 0.1,
  competitorsMentioned: [],
  webQueries: [],
  grounded: true,
  capturedAt: ago(1),
  taskCost: 0.02,
  offGeo: false,
  ...over,
});

section('The three-state rule');

test('a project with no captures reports — , not 0%', () => {
  const out = report.build({ captures: [], prompts: PROMPTS, brand: BRAND });
  assert.strictEqual(out.headline.namedRate.display, '—');
  assert.strictEqual(out.headline.namedRate.value, null);
  assert.strictEqual(out.headline.namedRate.value, null, 'the value must be null, never 0');
  assert.ok(out.headline.namedRate.note, 'and it must say why');
});

test('captures that all FAILED report — , not 0%', () => {
  const captures = [
    cap({ status: 'failed', mentioned: null, cited: null, answerText: null }),
    cap({ status: 'failed', mentioned: null, cited: null, answerText: null, promptId: 'p2' }),
  ];
  const out = report.build({ captures, prompts: PROMPTS, brand: BRAND });
  assert.strictEqual(out.headline.namedRate.display, '—', 'we could not ask — that is not a zero');
  assert.strictEqual(out.headline.namedRate.value, null);
});

test('measured but never named is a real 0.0%', () => {
  const captures = [
    cap({ mentioned: false, prominence: null }),
    cap({ mentioned: false, prominence: null, promptId: 'p2' }),
  ];
  const out = report.build({ captures, prompts: PROMPTS, brand: BRAND });
  assert.strictEqual(out.headline.namedRate.display, '0.0%', 'asked and absent IS a zero');
  assert.strictEqual(out.headline.namedRate.value, 0);
});

section('A failed capture never enters a denominator');

test('one provider outage does not lower visibility', () => {
  // Two prompts. Both named where measured; one provider failed on the second.
  const withFailure = report.build({
    captures: [cap({ promptId: 'p1' }), cap({ promptId: 'p2', status: 'failed', mentioned: null, answerText: null })],
    prompts: PROMPTS,
    brand: BRAND,
  });
  assert.strictEqual(withFailure.headline.namedRate.display, '100.0%',
    'scoring out of attempted rather than measured would read 50%');
  assert.strictEqual(withFailure.meta.coverage.display, '50.0%', 'and coverage must say half was missed');
});

test('the basis sentence states the denominator', () => {
  const out = report.build({
    captures: [cap(), cap({ promptId: 'p2', status: 'failed', mentioned: null, answerText: null })],
    prompts: PROMPTS,
    brand: BRAND,
  });
  assert.match(out.meta.basis, /1 of 1/);
  assert.match(out.meta.basis, /could not be measured/);
});

section('Deleted questions leave the report');

test('captures for a deleted prompt are excluded and flagged', () => {
  const out = report.build({
    captures: [cap(), cap({ promptId: 'deleted', mentioned: false })],
    prompts: PROMPTS,
    brand: BRAND,
  });
  assert.strictEqual(out.meta.answers, 1);
  assert.ok(out.warnings.includes('removed_prompts_excluded'), 'and the reader is told');
});

section('Per-engine and grounding');

test('each engine is scored over its own measured captures', () => {
  const out = report.build({
    captures: [
      cap({ engine: 'openai', mentioned: true }),
      cap({ engine: 'anthropic', mentioned: false }),
      cap({ engine: 'google', status: 'failed', mentioned: null, answerText: null }),
    ],
    prompts: PROMPTS,
    brand: BRAND,
  });
  const byEngine = Object.fromEntries(out.byEngine.map((e) => [e.engine, e.namedRate.display]));
  assert.strictEqual(byEngine.openai, '100.0%');
  assert.strictEqual(byEngine.anthropic, '0.0%');
  assert.strictEqual(byEngine.google, undefined, 'a failed-only engine has nothing to score');
});

test('an ungrounded answer is counted and warned about', () => {
  const out = report.build({
    captures: [cap({ grounded: true }), cap({ promptId: 'p2', grounded: false })],
    prompts: PROMPTS,
    brand: BRAND,
  });
  assert.strictEqual(out.headline.groundedRate.display, '50.0%');
  assert.ok(out.warnings.includes('ungrounded_answers_included'),
    'half these answers came from training data, not the live web');
});

section('Prompt-wise analysis — byQuestion carries the whole answer, per engine');

test('byQuestion.byEngine carries mention, competitors, citations, and the answer text', () => {
  const citation = { url: 'https://acmedental.com/implants', title: 'Implants', domain: 'acmedental.com' };
  const out = report.build({
    captures: [
      cap({
        engine: 'openai',
        mentioned: true,
        citations: [citation],
        competitorsMentioned: ['Rival Dental'],
        answerText: 'Acme Dental and Rival Dental both offer implants.',
      }),
      cap({
        engine: 'anthropic',
        promptId: 'p1',
        mentioned: false,
        citations: [],
        competitorsMentioned: ['Rival Dental'],
        answerText: 'Rival Dental is a solid choice for implants.',
      }),
    ],
    prompts: PROMPTS,
    brand: BRAND,
  });

  const q = out.byQuestion.find((row) => row.promptId === 'p1');
  assert.ok(q, 'the prompt both captures belong to must have its own row');
  // The question-level list pools every engine on this question together.
  assert.deepStrictEqual(q.competitors, ['Rival Dental']);

  const openai = q.byEngine.find((e) => e.engine === 'openai');
  assert.strictEqual(openai.mentioned, true);
  assert.deepStrictEqual(openai.competitorsMentioned, ['Rival Dental']);
  assert.deepStrictEqual(openai.citations, [citation]);
  assert.strictEqual(openai.answerText, 'Acme Dental and Rival Dental both offer implants.');

  const anthropic = q.byEngine.find((e) => e.engine === 'anthropic');
  assert.strictEqual(anthropic.mentioned, false);
  assert.deepStrictEqual(anthropic.citations, [], 'no citations is an empty list, not a missing key');
});

test('a failed capture carries no answer text, but still names its engine and status', () => {
  const out = report.build({
    captures: [cap({
      engine: 'google', status: 'failed', mentioned: null, cited: null, answerText: null,
      failureReason: 'timeout',
    })],
    prompts: PROMPTS,
    brand: BRAND,
  });
  const q = out.byQuestion.find((row) => row.promptId === 'p1');
  const google = q.byEngine.find((e) => e.engine === 'google');
  assert.strictEqual(google.answerText, null);
  assert.strictEqual(google.status, 'failed');
  assert.strictEqual(google.failureReason, 'timeout');
});

test('byQuestion.visibilityByEngine collapses repeated surfaces into one rate per engine', () => {
  const out = report.build({
    captures: [
      cap({ engine: 'openai', mentioned: true }),
      cap({ engine: 'openai', mentioned: false, id: 'openai-2' }),
      cap({ engine: 'anthropic', mentioned: false }),
      cap({ engine: 'google', status: 'failed', mentioned: null, answerText: null }),
    ],
    prompts: PROMPTS,
    brand: BRAND,
  });
  const q = out.byQuestion.find((row) => row.promptId === 'p1');
  const byEngine = Object.fromEntries(q.visibilityByEngine.map((e) => [e.engine, e]));

  assert.strictEqual(byEngine.openai.answers, 2, 'two surfaces for the same engine collapse to one row');
  assert.strictEqual(byEngine.openai.namedRate.display, '50.0%', 'named once out of two measured');
  assert.strictEqual(byEngine.anthropic.namedRate.display, '0.0%', 'measured and absent is a real zero');
  assert.strictEqual(byEngine.google.measured, 0, 'a failed-only engine has nothing measured');
  assert.strictEqual(byEngine.google.namedRate.display, '—', 'and so no rate to show');
});

section('Position — the client\'s place in the answer\'s own list');

const positionOf = (answerText, engine = 'openai', over = {}) => {
  const out = report.build({
    captures: [cap({ engine, answerText, ...over })],
    prompts: PROMPTS,
    brand: BRAND,
  });
  return out.byQuestion.find((row) => row.promptId === 'p1').visibilityByEngine[0];
};

test('counts untracked businesses listed ahead of the client (bold-name lines)', () => {
  const e = positionOf([
    '## Top Recommendations:', '',
    '**Newton Dental (Boston)**', '', 'Great practice.', '',
    '**South Boston Dental Group**', '', 'Also good.', '',
    '**Acme Dental of Raleigh**', '', 'Acme Dental is well reviewed.', '',
    '**City Hospital Dentistry**', '', 'Hospital-based.',
  ].join('\n'));
  assert.strictEqual(e.position.display, '#3', 'third in the list, though no competitor is tracked');
  assert.strictEqual(e.position.listed, 4, 'the section label is not an entry');
});

test('numbered headings with bullet details underneath form one list', () => {
  const e = positionOf([
    '### **1. Rival Dental (Raleigh)**', '* **The Setup:** big practice.',
    '### **2. Acme Dental (Raleigh)**', '* **Services:** everything.',
    '### **3. Smile Co**', '* **Services:** cleanings.',
    '', '**Tips before booking:**', '* **Insurance:** call ahead.',
  ].join('\n'));
  assert.strictEqual(e.position.display, '#2');
  assert.strictEqual(e.position.listed, 3, 'the "Setup:" bullets and closing tips are not places');
});

test('a later "other options" list is not counted as more places', () => {
  const e = positionOf([
    'Here are a few options:', '',
    '- Rival Dental (Raleigh)', '  - What they offer: implants.',
    '- Acme Dental (Cary)', '  - What they offer: everything.', '',
    'Other options you might consider:',
    '- Some Other Clinic', '',
    'A few quick questions:', '- Do you have a preferred location?',
  ].join('\n'));
  assert.strictEqual(e.position.display, '#2');
  assert.strictEqual(e.position.listed, 2);
});

test('named only in running text has no position, and says so', () => {
  const e = positionOf('Many people like Acme Dental, but it depends on your needs.');
  assert.strictEqual(e.position, null, 'no list means no place — not #1');
  assert.strictEqual(e.namedOutsideList, true);
});

test('not named means no position, not last place', () => {
  const e = positionOf('- Rival Dental\n- Smile Co', 'openai', { mentioned: false });
  assert.strictEqual(e.position, null);
  assert.strictEqual(e.namedOutsideList, false);
});

test('several answers from one model average their places', () => {
  const out = report.build({
    captures: [
      cap({ engine: 'openai', answerText: '1. Acme Dental\n2. Rival Dental' }),
      cap({ engine: 'openai', id: 'o2', answerText: '1. Rival Dental\n2. Acme Dental' }),
    ],
    prompts: PROMPTS,
    brand: BRAND,
  });
  const e = out.byQuestion.find((row) => row.promptId === 'p1').visibilityByEngine[0];
  assert.strictEqual(e.position.display, '#1.5');
  assert.strictEqual(e.position.answers, 2);
});

section('The brand table');

const COMPETITORS = [{ name: 'Smile Co', domain: 'smileco.com', aliases: [] }];

test('a name repeated in one answer counts once', () => {
  const out = report.build({
    captures: [
      cap({ answerText: 'Acme Dental is good. Acme Dental again. Acme Dental a third time. Smile Co too.' }),
      cap({ promptId: 'p2', answerText: 'Smile Co is worth a look for implants and routine care.', mentioned: false }),
    ],
    prompts: PROMPTS,
    brand: BRAND,
    competitors: COMPETITORS,
  });
  const smile = out.brands.find((b) => b.name === 'Smile Co');
  const acme = out.brands.find((b) => b.isClient);
  assert.strictEqual(smile.named, 2, 'named in both answers');
  assert.strictEqual(acme.named, 1, 'three occurrences in one answer is one answer');
});

test('mention order ranks by where a brand first appears', () => {
  // Acme is named second in this answer, so its order is 2 — not 1 because it
  // is the client, and not null because it was named at all.
  const answer = 'Smile Co is the best known option here. Acme Dental is also strong on implants.';
  const ranks = report.mentionOrder(answer, [
    { name: 'Acme Dental', aliases: [] },
    { name: 'Smile Co', aliases: [] },
  ]);
  assert.strictEqual(ranks.get('Smile Co'), 1);
  assert.strictEqual(ranks.get('Acme Dental'), 2);
});

test('a brand named too few times is not ranked', () => {
  const out = report.build({
    captures: [cap({ answerText: 'Acme Dental and Smile Co both operate here in the Raleigh area today.' })],
    prompts: PROMPTS,
    brand: BRAND,
    competitors: COMPETITORS,
  });
  const acme = out.brands.find((b) => b.isClient);
  assert.strictEqual(acme.mentionRank.display, '—', 'one answer is not a position');
  assert.ok(acme.mentionRank.note, 'and it says why rather than showing a bare dash');
});

section('Sources');

const withCitations = (domains) => cap({
  citations: domains.map((d, i) => ({ url: `https://${d}/x`, title: d, domain: d, index: i + 1 })),
});

test('citations are grouped by registrable domain and classified', () => {
  const out = report.build({
    captures: [
      withCitations(['www.reddit.com', 'blog.reddit.com', 'ada.org']),
      cap({ promptId: 'p2', citations: [{ url: 'https://acmedental.com/a', domain: 'acmedental.com', index: 1 }] }),
    ],
    prompts: PROMPTS,
    brand: BRAND,
    competitors: COMPETITORS,
  });
  const byDomain = Object.fromEntries(out.sources.domains.map((d) => [d.domain, d]));
  assert.strictEqual(out.sources.totalCitations, 4);
  assert.strictEqual(byDomain['reddit.com'].citations, 2, 'subdomains collapse to one source');
  assert.strictEqual(byDomain['reddit.com'].sourceType, 'ugc');
  assert.strictEqual(byDomain['ada.org'].sourceType, 'institutional');
  // The rule that matters: the client's own domain is 'you' by configuration,
  // never 'corporate' by pattern.
  assert.strictEqual(byDomain['acmedental.com'].sourceType, 'you');
});

test('the type mix shares sum over the citations counted', () => {
  const out = report.build({
    captures: [withCitations(['reddit.com', 'ada.org', 'example.com', 'example.com'])],
    prompts: PROMPTS,
    brand: BRAND,
  });
  const total = out.sources.byType.reduce((sum, t) => sum + t.citations, 0);
  assert.strictEqual(total, out.sources.totalCitations);
});

section('Citation rate is separate from being named');

test('an unresolved citation set leaves the denominator rather than counting against', () => {
  // `cited: null` means the citations could not be resolved — not evidence the
  // client was uncited. Counting it as a miss would invent a worse number than
  // the evidence supports.
  const out = report.build({
    captures: [
      cap({ cited: true }),
      cap({ promptId: 'p2', cited: null }),
    ],
    prompts: PROMPTS,
    brand: BRAND,
  });
  assert.strictEqual(out.headline.citationRate.display, '100.0%',
    'one of one resolvable answer cited the client');
});

section('The run-close contract');

// moduleEvidence.completeRun REFUSES a score with no basis — an unattributable
// number on a dashboard cannot be defended later (PRD §6.2). run.js hands it
// summarise()'s score and scoreBasis straight through, so if those two can ever
// disagree, a real run throws at the moment it tries to record its result, with
// the captures already paid for.
const scoring = require('../../aiVisibility/scoring');

test('a non-null score always comes with a basis', () => {
  const cases = [
    [cap()],
    [cap({ mentioned: false })],
    [cap(), cap({ promptId: 'p2', status: 'failed', mentioned: null, answerText: null })],
    [cap({ mentioned: true }), cap({ promptId: 'p2', mentioned: false })],
  ];
  for (const rows of cases) {
    const s = scoring.summarise(rows, BRAND);
    if (s.score !== null) {
      assert.ok(s.scoreBasis, `score ${s.score} arrived with no basis — completeRun would throw`);
    }
  }
});

test('nothing measured gives neither a score nor a basis', () => {
  const s = scoring.summarise(
    [cap({ status: 'failed', mentioned: null, answerText: null })],
    BRAND,
  );
  assert.strictEqual(s.score, null);
  assert.strictEqual(s.scoreBasis, null, 'a basis with no score would describe nothing');
});

section('score — named, rank, perception and cited, combined by weight');

test('all four factors combine by SCORE_WEIGHTS when every one is available', () => {
  // Three answers, each naming BOTH brands with Rival first — the client's
  // mention rank is a real #2 of 2 (rankCount 3 clears MIN_ANSWERS_TO_RANK).
  const text = 'Rival Dental and Acme Dental are both good options.';
  const captures = ['p1', 'p1', 'p2'].map((promptId, i) => cap({
    id: `s${i}`, promptId, runId: 'run1', mentioned: true, cited: true, answerText: text,
  }));
  const runSentiment = new Map([['run1', { score: 60, at: ago(1) }]]);

  const out = report.build({
    captures, prompts: PROMPTS, brand: BRAND, competitors: [RIVAL], runSentiment,
  });

  // named=100 (3/3), rank=#2 of 2 -> rankToScore = 0, perception=60, cited=100.
  // (100*40 + 0*25 + 60*20 + 100*15) / 100 = 67.
  assert.strictEqual(out.headline.score.display, '67');
  assert.match(out.headline.score.note, /named 100/);
  assert.match(out.headline.score.note, /rank #2\.0/);
  assert.match(out.headline.score.note, /sentiment 60/);
  assert.match(out.headline.score.note, /cited 100%/);
});

test('scoreBreakdown carries the same four factors as structured data, for a UI to draw apart', () => {
  const text = 'Rival Dental and Acme Dental are both good options.';
  const captures = ['p1', 'p1', 'p2'].map((promptId, i) => cap({
    id: `s${i}`, promptId, runId: 'run1', mentioned: true, cited: true, answerText: text,
  }));
  const runSentiment = new Map([['run1', { score: 60, at: ago(1) }]]);
  const out = report.build({
    captures, prompts: PROMPTS, brand: BRAND, competitors: [RIVAL], runSentiment,
  });

  const byKey = Object.fromEntries(out.headline.scoreBreakdown.map((p) => [p.key, p]));
  assert.strictEqual(byKey.named.value, 100);
  assert.strictEqual(byKey.named.included, true);
  assert.strictEqual(byKey.rank.display, '#2.0');
  assert.strictEqual(byKey.perception.value, 60);
  assert.strictEqual(byKey.cited.display, '100%');
  // Weights sum to 100 regardless of which run produced them — the contract
  // a UI needs to draw each factor's bar at the right proportion.
  const totalWeight = out.headline.scoreBreakdown.reduce((sum, p) => sum + p.weight, 0);
  assert.strictEqual(totalWeight, 100);
});

test('scoreBreakdown marks a missing factor excluded, not zero', () => {
  const out = report.build({
    captures: [cap({ mentioned: true, runId: 'run1' }), cap({ mentioned: false, promptId: 'p2', runId: 'run1' })],
    prompts: PROMPTS,
    brand: BRAND,
  });
  const byKey = Object.fromEntries(out.headline.scoreBreakdown.map((p) => [p.key, p]));
  assert.strictEqual(byKey.rank.included, false, 'no second tracked brand — rank cannot be judged');
  assert.strictEqual(byKey.rank.value, null);
  assert.strictEqual(byKey.perception.included, false, 'no runSentiment was passed at all');
});

test('a missing perception reweights across named/rank/cited, never scores it 0', () => {
  const text = 'Rival Dental and Acme Dental are both good options.';
  const captures = ['p1', 'p1', 'p2'].map((promptId, i) => cap({
    id: `s${i}`, promptId, runId: 'run1', mentioned: true, cited: true, answerText: text,
  }));
  // No runSentiment passed at all.
  const out = report.build({ captures, prompts: PROMPTS, brand: BRAND, competitors: [RIVAL] });

  // (100*40 + 0*25 + 100*15) / 80 = 68.75 -> 69. NOT (100*40+0*25+0*20+100*15)/100
  // = 55, which is what treating the missing factor as a zero would give —
  // the two numbers are far enough apart that a regression to "zero" fails loud.
  assert.strictEqual(out.headline.score.display, '69');
  assert.ok(!/perception/.test(out.headline.score.note), out.headline.score.note);
});

test('rank is excluded, not zeroed, with only one brand tracked', () => {
  // No competitors: trackedBrandCount is 1, so ranking against nothing is
  // excluded from the blend entirely rather than silently scoring #1 as 100.
  const captures = [
    cap({ mentioned: true, runId: 'run1' }),
    cap({ mentioned: false, promptId: 'p2', runId: 'run1' }),
  ];
  const out = report.build({ captures, prompts: PROMPTS, brand: BRAND });

  // named=50, cited=0 (default cited:false), reweighted over named+cited only:
  // (50*40 + 0*15) / 55 = 36.36 -> 36.
  assert.strictEqual(out.headline.score.display, '36');
  assert.ok(!/rank/.test(out.headline.score.note), out.headline.score.note);
});

test('nothing measured leaves score as — , the same as namedRate', () => {
  const out = report.build({ captures: [], prompts: PROMPTS, brand: BRAND });
  assert.strictEqual(out.headline.score.value, null);
  assert.strictEqual(out.headline.score.display, '—');
});

section('avgScore — the mean of each run\'s own score');

test('avgScore averages each RUN\'s own composite score, not every capture pooled together', () => {
  const captures = [
    // Run A: one capture, named and cited — scores higher.
    cap({ id: 'a1', runId: 'runA', mentioned: true, cited: true, capturedAt: ago(10) }),
    // Run B: three captures, one named, none cited — scores lower.
    cap({ id: 'b1', runId: 'runB', mentioned: false, promptId: 'p2', capturedAt: ago(5) }),
    cap({ id: 'b2', runId: 'runB', mentioned: false, capturedAt: ago(5) }),
    cap({ id: 'b3', runId: 'runB', mentioned: true, promptId: 'p2', capturedAt: ago(5) }),
  ];
  const out = report.build({ captures, prompts: PROMPTS, brand: BRAND });
  // Run A: named=100, cited=100 -> (100*40+100*15)/55 = 100.
  // Run B: named=33.3, cited=0  -> (33.3*40+0*15)/55  = 24.24.
  // Mean of the two runs' OWN scores: (100 + 24.24) / 2 = 62.12 -> 62.
  // Pooling all four captures into one rate first would give a different,
  // wrong number — proof this averages the runs, not the raw rows.
  assert.strictEqual(out.headline.avgScore.display, '62');
  assert.ok(/2 scored runs/.test(out.headline.avgScore.note), out.headline.avgScore.note);
});

test('a capture with no runId cannot be averaged — avgScore says so, not 0', () => {
  const out = report.build({
    captures: [cap({ mentioned: true }), cap({ mentioned: false, promptId: 'p2' })],
    prompts: PROMPTS,
    brand: BRAND,
  });
  assert.strictEqual(out.headline.avgScore.value, null);
  assert.ok(out.headline.avgScore.note, 'a null average must say why, same as any other em-dash');
});

section('Sentiment — tone per answer, weighted by position');

const LISTED_FIRST = '1. Acme Dental\n2. Rival Dental\n3. Smile Co';
const LISTED_FOURTH = '1. Rival Dental\n2. Smile Co\n3. Bright Teeth\n4. Acme Dental';
const PROSE = 'Many people like Acme Dental for routine care.';
const { TONE_VERSION } = require('../describe');
const tone = (runId, engine, t, promptId = 'p1') => ({
  runId, promptId, engine, tone: t, quote: 'q', v: TONE_VERSION,
});

test('tones from older instructions are ignored until re-read', () => {
  const out = report.build({
    captures: [cap({ runId: 'r1', engine: 'openai', answerText: LISTED_FIRST })],
    prompts: PROMPTS,
    brand: BRAND,
    answerTones: [{ ...tone('r1', 'openai', 'positive'), v: undefined }],
  });
  assert.strictEqual(out.sentiment.analysed, 0);
  assert.strictEqual(out.sentiment.unanalysed, 1);
});

test('each answer scores from the tone x position table, and the score is their mean', () => {
  const out = report.build({
    captures: [
      cap({ runId: 'r1', engine: 'openai', answerText: LISTED_FIRST }),
      cap({ runId: 'r1', engine: 'anthropic', answerText: LISTED_FOURTH }),
      cap({ runId: 'r1', engine: 'google', answerText: PROSE }),
    ],
    prompts: PROMPTS,
    brand: BRAND,
    answerTones: [tone('r1', 'openai', 'positive'), tone('r1', 'anthropic', 'positive'), tone('r1', 'google', 'neutral')],
  });
  const byEngine = Object.fromEntries(out.sentiment.answers.map((a) => [a.engine, a]));
  assert.strictEqual(byEngine.openai.score, report.SENTIMENT_SCORES.positive.first, 'positive at #1');
  assert.strictEqual(byEngine.anthropic.score, report.SENTIMENT_SCORES.positive.lower, 'positive at #4');
  assert.strictEqual(byEngine.google.score, report.SENTIMENT_SCORES.neutral.text, 'neutral, not in a list');
  assert.strictEqual(out.sentiment.score.value, (100 + 75 + 50) / 3);
  assert.deepStrictEqual([out.sentiment.positive, out.sentiment.neutral, out.sentiment.negative], [2, 1, 0]);
  assert.strictEqual(out.sentiment.net.display, '+67');
  assert.strictEqual(out.sentiment.summary,
    'Of the 3 answers that mention you, 2 praise you, 1 lists you without praise, and none criticise you.'
    + ' You were recommended first in 1.',
    'the sentence beside the gauge is built from the same counts as the score');
});

test('every cell of the table stays inside its own tone\'s band on the gauge', () => {
  const { positive, neutral, negative } = report.SENTIMENT_SCORES;
  Object.values(positive).forEach((v) => assert.ok(v >= 60, `positive ${v} would read as neutral`));
  Object.values(neutral).forEach((v) => assert.ok(v >= 40 && v < 60, `neutral ${v} would read as another tone`));
  Object.values(negative).forEach((v) => assert.ok(v < 40, `negative ${v} would read as neutral`));
});

test('a negative at #1 is worse than a negative lower down', () => {
  const { negative } = report.SENTIMENT_SCORES;
  assert.ok(negative.first < negative.lower, 'the first name read is the most damaging place to be criticised');
});

test('named answers with no tone yet are counted as unanalysed, not scored', () => {
  const out = report.build({
    captures: [
      cap({ runId: 'r1', engine: 'openai', answerText: LISTED_FIRST }),
      cap({ runId: 'r1', engine: 'anthropic', answerText: LISTED_FIRST }),
      cap({ runId: 'r1', engine: 'google', mentioned: false, answerText: 'Rival Dental only.' }),
    ],
    prompts: PROMPTS,
    brand: BRAND,
    answerTones: [tone('r1', 'openai', 'negative')],
  });
  assert.strictEqual(out.sentiment.named, 2, 'an answer that did not name you has no tone towards you');
  assert.strictEqual(out.sentiment.analysed, 1);
  assert.strictEqual(out.sentiment.unanalysed, 1);
  assert.strictEqual(out.sentiment.score.value, report.SENTIMENT_SCORES.negative.first);
});

test('an answer found not to be about you leaves every count, and is reported', () => {
  const out = report.build({
    captures: [
      cap({ runId: 'r1', engine: 'openai', answerText: LISTED_FIRST }),
      cap({ runId: 'r1', engine: 'google', answerText: 'Acme Dental offers Invisalign.' }),
    ],
    prompts: PROMPTS,
    brand: BRAND,
    answerTones: [tone('r1', 'openai', 'positive'), { ...tone('r1', 'google', 'absent'), quote: null }],
  });
  assert.strictEqual(out.sentiment.notAboutYou, 1);
  assert.deepStrictEqual(out.sentiment.notAboutYouMatched, [{ name: 'Acme Dental', answers: 1 }],
    'says which name matched, so the reader can fix the name list');
  assert.strictEqual(out.sentiment.named, 1);
  assert.strictEqual(out.sentiment.analysed, 1);
  assert.strictEqual(out.sentiment.score.value, 100);
});

test('the headline composite uses the answer-based score once 3+ answers are analysed', () => {
  const captures = [
    cap({ runId: 'r1', engine: 'openai', answerText: LISTED_FIRST }),
    cap({ runId: 'r1', engine: 'anthropic', answerText: LISTED_FIRST }),
    cap({ runId: 'r1', engine: 'google', answerText: LISTED_FIRST }),
  ];
  const runSentiment = new Map([['r1', { score: 20, at: ago(1) }]]);
  const out = report.build({
    captures,
    prompts: PROMPTS,
    brand: BRAND,
    runSentiment,
    answerTones: ['openai', 'anthropic', 'google'].map((e) => tone('r1', e, 'positive')),
  });
  const factor = out.headline.scoreBreakdown.find((f) => f.key === 'perception');
  assert.strictEqual(factor.value, 100, 'three positive #1 answers, not the older one-call reading of 20');
  assert.match(out.headline.score.note, /Sentiment over 3 analysed answers/);

  const fewer = report.build({
    captures, prompts: PROMPTS, brand: BRAND, runSentiment, answerTones: [tone('r1', 'openai', 'positive')],
  });
  assert.strictEqual(fewer.headline.scoreBreakdown.find((f) => f.key === 'perception').value, 20,
    'below 3 analysed answers, the older reading is kept');
});

test('sentiment is split by model and by prompt', () => {
  const out = report.build({
    captures: [
      cap({ runId: 'r1', engine: 'openai', answerText: LISTED_FIRST }),
      cap({ runId: 'r1', engine: 'openai', promptId: 'p2', answerText: LISTED_FIRST }),
      cap({ runId: 'r1', engine: 'anthropic', answerText: LISTED_FIRST }),
    ],
    prompts: PROMPTS,
    brand: BRAND,
    answerTones: [
      tone('r1', 'openai', 'positive'), tone('r1', 'openai', 'negative', 'p2'), tone('r1', 'anthropic', 'neutral'),
    ],
  });
  const openai = out.sentiment.byEngine.find((e) => e.engine === 'openai');
  assert.deepStrictEqual([openai.positive, openai.negative, openai.analysed], [1, 1, 2]);
  assert.strictEqual(out.sentiment.byPrompt.length, 2);
  assert.strictEqual(out.sentiment.byPrompt[0].promptId, 'p2', 'worst prompt first');
});

section('Cost arithmetic');

test('an unpriced model costs null, not zero', () => {
  assert.strictEqual(costOf('some-future-model', { inputTokens: 10_000 }), null,
    'a zero would understate spend exactly where somebody switched to something unfamiliar');
});

test('each default model is priced', () => {
  for (const id of ['gpt-5-nano', 'claude-haiku-4-5', 'gemini-3.5-flash-lite']) {
    assert.ok(PRICING[id], `${id} has no rate`);
    assert.ok(costOf(id, { inputTokens: 10_000, outputTokens: 800, searches: 1 }) > 0);
  }
});

test('the search call dominates a small answer', () => {
  // The finding that picked the models: tokens are the rounding error.
  const nano = costOf('gpt-5-nano', { inputTokens: 10_000, outputTokens: 800, searches: 1 });
  const tokensOnly = costOf('gpt-5-nano', { inputTokens: 10_000, outputTokens: 800, searches: 0 });
  assert.ok(tokensOnly / nano < 0.2, 'over 80% of a nano call is the metered search');
});

test('gemini 2.5-flash-lite really is dearer than 3.5 despite cheaper tokens', () => {
  const args = { inputTokens: 10_000, outputTokens: 800, searches: 1 };
  assert.ok(
    costOf('gemini-2.5-flash-lite', args) > costOf('gemini-3.5-flash-lite', args),
    'this is the whole reason the default is 3.5',
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
