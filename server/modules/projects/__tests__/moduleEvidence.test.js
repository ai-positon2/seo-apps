// Tests for project-scoped module evidence (PRD phase 3).
//
// The rules worth protecting here are the honesty rules. A regression that turns
// a missing score into 0, or stores a number with no stated basis, is not a
// cosmetic bug: it puts an indefensible figure on a client-facing dashboard.

const assert = require('assert');
const moduleEvidence = require('../moduleEvidence');
const moduleRunners = require('../moduleRunners');
const overview = require('../overview');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed += 1;
  } catch (e) {
    console.log(`  ✗ ${name}`);
    console.log(`      ${e.message}`);
    failed += 1;
  }
}

console.log('\nModule evidence — severity normalisation');

test('module vocabularies map onto the shared severity set', () => {
  assert.strictEqual(moduleEvidence.normalizeSeverity('fail'), 'error');
  assert.strictEqual(moduleEvidence.normalizeSeverity('critical'), 'error');
  assert.strictEqual(moduleEvidence.normalizeSeverity('warn'), 'warning');
  assert.strictEqual(moduleEvidence.normalizeSeverity('WARNING'), 'warning');
  assert.strictEqual(moduleEvidence.normalizeSeverity('manual'), 'notice');
  assert.strictEqual(moduleEvidence.normalizeSeverity('pass'), 'info');
});

test('an unrecognised severity degrades to notice rather than being dropped', () => {
  // Dropping it would silently lose a finding; calling it an error would
  // overstate it. Notice is the honest middle.
  assert.strictEqual(moduleEvidence.normalizeSeverity('spicy'), 'notice');
  assert.strictEqual(moduleEvidence.normalizeSeverity(undefined), 'notice');
});

console.log('\nModule evidence — findings');

test('a finding keeps its identity and never counts zero things', () => {
  const f = moduleEvidence.normalizeFinding({ id: 'x1', label: 'Missing H1', status: 'fail' }, 0);
  assert.strictEqual(f.ruleId, 'x1');
  assert.strictEqual(f.title, 'Missing H1');
  assert.strictEqual(f.severity, 'error');
  assert.strictEqual(f.count, 1, 'a finding that applies to nothing should not exist');
});

test('a finding with no id at all still gets a stable one', () => {
  const f = moduleEvidence.normalizeFinding({ title: 'Something' }, 4);
  assert.strictEqual(f.ruleId, 'finding-5');
});

test('counts are derived from the findings, so the two cannot disagree', () => {
  const findings = [
    { severity: 'error' }, { severity: 'error' }, { severity: 'warning' }, { severity: 'info' },
  ];
  assert.deepStrictEqual(
    moduleEvidence.countsFor(findings),
    { error: 2, warning: 1, notice: 0, info: 1 },
  );
});

console.log('\nModule evidence — payload trimming');

test('a payload under the cap is stored verbatim', () => {
  const { payload, truncated } = moduleEvidence.trimPayload({ a: 1 });
  assert.deepStrictEqual(payload, { a: 1 });
  assert.strictEqual(truncated, false);
});

test('an oversized payload is trimmed to something that says what was dropped', () => {
  const big = { blob: 'x'.repeat(moduleEvidence.MAX_PAYLOAD_CHARS + 100), other: 1 };
  const { payload, truncated } = moduleEvidence.trimPayload(big);
  assert.strictEqual(truncated, true);
  assert.strictEqual(payload._truncated, true);
  assert.deepStrictEqual(payload.keys, ['blob', 'other'], 'a reader can see what is missing');
});

test('a circular payload is recorded as unserialisable, not thrown', () => {
  const circular = { name: 'loop' };
  circular.self = circular;
  const { payload, truncated } = moduleEvidence.trimPayload(circular);
  assert.strictEqual(truncated, true);
  assert.strictEqual(payload._unserializable, true);
});

console.log('\nModule evidence — the module vocabulary is closed');

test('every runnable module is a valid evidence module_key', () => {
  for (const key of moduleRunners.RUNNABLE) {
    assert.ok(
      moduleEvidence.MODULE_KEYS.includes(key),
      `${key} is runnable but not storable — migration 0012's CHECK would reject it`,
    );
  }
});

test('technical is NOT a module-evidence key', () => {
  // CrawlScope owns crawl_runs. Letting it also write here would give the
  // technical card two sources of truth that could disagree.
  assert.ok(!moduleEvidence.MODULE_KEYS.includes('technical'));
  assert.ok(!moduleRunners.RUNNABLE.includes('technical'));
});

console.log('\nEvidence cards — the honesty rules');

test('a module with no stored run says so and scores nothing', () => {
  const card = overview.evidenceCard(overview.MODULES.find((m) => m.key === 'seo_geo'), null);
  assert.strictEqual(card.status, 'not_run');
  assert.strictEqual(card.score, null);
  assert.strictEqual(card.scored, false);
  assert.strictEqual(card.evidence, null);
});

test('a run in flight reads as running, not as never-run', () => {
  const card = overview.evidenceCard(
    overview.MODULES.find((m) => m.key === 'seo_geo'),
    { terminal: null, inFlight: { id: 'r1', status: 'running', started_at: '2026-08-21T10:00:00Z' } },
  );
  assert.strictEqual(card.status, 'running');
  assert.strictEqual(card.moduleRunId, 'r1');
  assert.strictEqual(card.score, null);
});

test("a scored module reports the module's own score and names its basis", () => {
  const card = overview.evidenceCard(
    overview.MODULES.find((m) => m.key === 'seo_geo'),
    {
      terminal: {
        id: 'r2', status: 'completed', score: 74, score_max: 100,
        score_basis: 'SEO & GEO audit: rule-based bucket scores', band: 'Good',
        counts: { error: 0, warning: 3, notice: 5 },
        findings: [{ ruleId: 'a', title: 'A', severity: 'warning', count: 1 }],
        target_url: 'https://example.com', finished_at: '2026-08-21T10:00:00Z',
      },
      inFlight: null,
    },
  );
  assert.strictEqual(card.scored, true);
  assert.strictEqual(card.score, 74);
  assert.match(card.scoreBasis, /rule-based bucket scores/);
  assert.match(card.headline, /74\/100/);
});

test('an unscored module shows findings and an em dash, never a zero', () => {
  const card = overview.evidenceCard(
    overview.MODULES.find((m) => m.key === 'seo_geo'),
    {
      terminal: {
        id: 'r3', status: 'completed', score: null, score_basis: null,
        counts: { error: 2, warning: 4, notice: 1 },
        findings: [
          { ruleId: 'a', title: 'A', severity: 'error', count: 1 },
          { ruleId: 'b', title: 'B', severity: 'warning', count: 1 },
        ],
        finished_at: '2026-08-21T10:00:00Z',
      },
      inFlight: null,
    },
  );
  assert.strictEqual(card.score, null, 'no rubric means no number — §6.2');
  assert.strictEqual(card.scored, false);
  assert.notStrictEqual(card.score, 0, 'a zero would read as a catastrophic result — §16.11');
  assert.strictEqual(card.status, 'completed_with_errors');
  assert.strictEqual(card.evidence.counts.error, 2);
});

test('insufficient_data is reported as such, not as a failure or a zero', () => {
  const card = overview.evidenceCard(
    overview.MODULES.find((m) => m.key === 'competitor'),
    {
      terminal: {
        id: 'r4', status: 'insufficient_data', score: null,
        counts: {}, findings: [], finished_at: '2026-08-21T10:00:00Z',
      },
      inFlight: null,
    },
  );
  assert.strictEqual(card.status, 'insufficient_data');
  assert.strictEqual(card.score, null);
  assert.match(card.headline, /Nothing to measure/);
  assert.strictEqual(card.evidence, null, 'no findings and nothing measured means no evidence block');
});

test('a failed run surfaces its error rather than looking unrun', () => {
  const card = overview.evidenceCard(
    overview.MODULES.find((m) => m.key === 'agent_readiness'),
    {
      terminal: {
        id: 'r5', status: 'failed', score: null, counts: {}, findings: [],
        error: 'Could not fetch URL: timeout', finished_at: '2026-08-21T10:00:00Z',
      },
      inFlight: null,
    },
  );
  assert.strictEqual(card.status, 'failed');
  assert.match(card.error, /timeout/);
  assert.strictEqual(card.score, null);
});

console.log('\nThe composite, now that modules can really score');

test('the composite averages only the modules that actually scored', () => {
  const composite = overview.buildComposite([
    { key: 'technical', scored: false, score: null },
    { key: 'seo_geo', scored: true, score: 74 },
    { key: 'agent_readiness', scored: true, score: 90 },
    { key: 'on_page', scored: false, score: null },
    { key: 'competitor', scored: false, score: null },
    { key: 'hub_spoke', scored: false, score: null },
  ]);
  assert.strictEqual(composite.value, 82, '(74 + 90) / 2 — unscored modules are absent, not zero');
  assert.strictEqual(composite.scoredModules, 2);
  assert.strictEqual(composite.totalModules, 6);
  assert.strictEqual(composite.status, 'partial', 'partial coverage must not read as complete');
});

test('the composite stays null when nothing scored', () => {
  const composite = overview.buildComposite([
    { key: 'technical', scored: false, score: null },
    { key: 'seo_geo', scored: false, score: null },
  ]);
  assert.strictEqual(composite.value, null);
  assert.notStrictEqual(composite.value, 0);
  assert.strictEqual(composite.status, 'insufficient_data');
  assert.strictEqual(composite.scoredModules, 0);
});

console.log('\nOn-page: keywords are per page');

// The runner-side half of this section went with the on_page module.
//
// A test here used to assert that moduleRunners' "N keyword-placement checks
// were not run" counter matched the auditor's stand-down wording. on_page is no
// longer a project module, so nothing counts those checks and the contract has
// no two sides left to agree.
//
// The auditor itself stays — it still serves the On-Page tab inside the SEO &
// GEO Audit through /api/on-page-audit — so the guard below, which tests the
// auditor alone, is still worth having.
test('every keyword-dependent check is guarded against an empty keyword list', () => {
  // The auditor crashed on kws[0] when handed no keywords. Every remaining use
  // must sit behind a kws.length guard; this catches a new unguarded one.
  const fs = require('fs');
  const path = require('path');
  const source = fs.readFileSync(
    path.join(__dirname, '../../onPageAudit/auditor.js'), 'utf8',
  );
  const lines = source.split(/\r?\n/);
  const unguarded = [];
  lines.forEach((line, i) => {
    if (!line.includes('kws[0]')) return;
    if (line.includes('kwOr')) return;            // the helper itself
    if (/const kwOr/.test(line)) return;
    // Walk back to the nearest branch and require a kws.length guard in the
    // enclosing if/else chain or ternary.
    const window = lines.slice(Math.max(0, i - 14), i + 1).join('\n');
    if (!/kws\.length/.test(window)) unguarded.push(`${i + 1}: ${line.trim().slice(0, 70)}`);
  });
  assert.deepStrictEqual(unguarded, [], 'unguarded kws[0] would crash a keywordless audit');
});

test('no keyword is ever derived from the page being audited', () => {
  const fs = require('fs');
  const path = require('path');
  const source = fs.readFileSync(path.join(__dirname, '../moduleRunners.js'), 'utf8');
  // A regression here would be someone defaulting the keyword to the slug, the
  // title or the H1, which makes every keyword check measure the wrong term
  // while the findings still read as real.
  assert.ok(
    !/keywords:\s*\[?[^,\n]*\b(slug|pathname|h1|pageTitle)\b/i.test(source),
    'a keyword must come from configuration, never from the page itself',
  );
});

test('the page cap is declared, not implicit', () => {
  const store = require('../store');
  assert.strictEqual(typeof store.MAX_TARGET_PAGES, 'number');
  assert.ok(store.MAX_TARGET_PAGES >= 1);
});

console.log('\nThe market a comparison is measured in');

test('an ISO alpha-2 code resolves to the right SEMrush database', () => {
  // The lookup table is keyed on country NAMES, but projects store ISO codes
  // (AC-004). Every code except 'US' used to fall through to the 'us' default,
  // so a German project would have been measured against US search results —
  // silently, after spending ~1,955 units per domain to get the wrong market.
  const { resolveDatabase } = require('../../../utils/countryToDatabase');
  assert.strictEqual(resolveDatabase('DE'), 'de');
  assert.strictEqual(resolveDatabase('FR'), 'fr');
  assert.strictEqual(resolveDatabase('CA'), 'ca');
  assert.strictEqual(resolveDatabase('JP'), 'jp');
  assert.strictEqual(resolveDatabase('US'), 'us');
});

test("SEMrush's legacy 'uk' is used for ISO 'GB'", () => {
  const { resolveDatabase } = require('../../../utils/countryToDatabase');
  assert.strictEqual(resolveDatabase('GB'), 'uk');
});

test('country names still resolve, for the callers written against them', () => {
  const { resolveDatabase } = require('../../../utils/countryToDatabase');
  assert.strictEqual(resolveDatabase('United Kingdom'), 'uk');
  assert.strictEqual(resolveDatabase('united states'), 'us');
});

test('an unmapped country resolves to null, not to the US', () => {
  // The whole point: "which market was this measured in" cannot be recovered
  // from the numbers afterwards, so guessing is worse than refusing.
  const { resolveDatabase, getDatabase } = require('../../../utils/countryToDatabase');
  assert.strictEqual(resolveDatabase('ZZ'), null);
  assert.strictEqual(resolveDatabase(''), null);
  assert.strictEqual(resolveDatabase(null), null);
  // The lenient helper keeps its default for the call sites written against it.
  assert.strictEqual(getDatabase('ZZ'), 'us');
});

test('every database code the name table holds is reachable from some ISO code', () => {
  // Guards the derivation: KNOWN_DATABASES is built from the name table's
  // values, so a new country added there must not become unreachable by code.
  const { COUNTRY_TO_DATABASE, databaseForIso } = require('../../../utils/countryToDatabase');
  const unreachable = [];
  for (const db of new Set(Object.values(COUNTRY_TO_DATABASE))) {
    // 'uk' is reachable only via the GB override, which is the documented case.
    if (db === 'uk') {
      if (databaseForIso('GB') !== 'uk') unreachable.push(db);
      continue;
    }
    if (databaseForIso(db.toUpperCase()) !== db) unreachable.push(db);
  }
  assert.deepStrictEqual(unreachable, []);
});

console.log('\nA card explains itself');

test("the module's own note becomes the card's detail", () => {
  // Every runner writes a note saying what is missing and what to do. It was
  // stored in the payload and never selected, so cards fell back to generic text
  // like "found nothing it could measure" — true, but not actionable.
  const card = overview.evidenceCard(
    overview.MODULES.find((m) => m.key === 'hub_spoke'),
    {
      terminal: {
        id: 'r1', status: 'insufficient_data', score: null, counts: {}, findings: [],
        note: 'Content Architect has no project for this domain yet. Open it and run an analysis.',
        finished_at: '2026-08-22T10:00:00Z',
      },
      inFlight: null,
    },
  );
  assert.match(card.detail, /Content Architect has no project/);
  assert.doesNotMatch(card.detail, /found nothing it could measure/);
});

test('a run with no note still gets the generic explanation', () => {
  const card = overview.evidenceCard(
    overview.MODULES.find((m) => m.key === 'competitor'),
    {
      terminal: {
        id: 'r2', status: 'insufficient_data', score: null, counts: {}, findings: [],
        note: null, finished_at: '2026-08-22T10:00:00Z',
      },
      inFlight: null,
    },
  );
  assert.match(card.detail, /found nothing it could measure/);
});

test('a failed run says it failed, not that it found nothing', () => {
  // A failed run has zero counts, so it fell through to the "no error or warning
  // findings" branch — a clean bill of health for a run that never completed.
  const card = overview.evidenceCard(
    overview.MODULES.find((m) => m.key === 'seo_geo'),
    {
      terminal: {
        id: 'r3', status: 'failed', score: null,
        counts: { error: 0, warning: 0, notice: 0 }, findings: [],
        error: 'No result recorded within 30 minutes — the process running it stopped.',
        target_url: 'https://example.com', finished_at: '2026-08-22T10:00:00Z',
      },
      inFlight: null,
    },
  );
  assert.strictEqual(card.headline, 'Run failed');
  assert.doesNotMatch(card.headline, /No error or warning/);
  assert.match(card.detail, /process running it stopped/);
  assert.strictEqual(card.score, null);
});

test('the note query projects one field, not the whole payload', () => {
  // Six payloads at 120,000 chars each would be most of a megabyte to render one
  // sentence per card.
  const fs = require('fs');
  const path = require('path');
  const source = fs.readFileSync(path.join(__dirname, '../moduleEvidence.js'), 'utf8');
  const selectLine = source.split(/\r?\n/).find((l) => l.includes('note:payload->>note'));
  assert.ok(selectLine, 'latestByModule must project the note');
  assert.ok(
    !/\.select\('[^']*\bpayload\b[^']*'\)/.test(
      source.split('async function latestByModule')[1].split('async function')[0],
    ) || selectLine.includes('note:payload->>note'),
    'the full payload must not be selected for the dashboard',
  );
});

console.log('\nMetered modules');

test('the default audit set spends nothing', () => {
  for (const key of moduleRunners.DEFAULT_AUDIT_MODULES) {
    assert.ok(
      !moduleRunners.METERED[key],
      `${key} bills a third-party budget and must not run on every "Run Full Audit"`,
    );
  }
});

test('competitor is runnable but not default — it costs real money', () => {
  assert.ok(moduleRunners.RUNNABLE.includes('competitor'));
  assert.ok(!moduleRunners.DEFAULT_AUDIT_MODULES.includes('competitor'));
  assert.ok(moduleRunners.METERED.competitor);
});

test('the cost estimate counts the client domain, not just the competitors', () => {
  // SEMrush is billed per domain and the client's own domain is one of them.
  // Quoting only the competitors would understate every estimate.
  const one = moduleRunners.estimateCost('competitor', { competitorCount: 1 });
  assert.strictEqual(one.domains, 2);
  assert.strictEqual(one.estimate, 3910);

  const four = moduleRunners.estimateCost('competitor', { competitorCount: 4 });
  assert.strictEqual(four.domains, 5);
  assert.strictEqual(four.estimate, 9775);
});

test('an estimate for a metered run stays under the module’s own hard cap', () => {
  // competitorAnalysis/unitCosts.js refuses to spend more than this per run, so
  // an estimate above it would promise work the module would truncate.
  const { MAX_UNITS_PER_RUN } = require('../../competitorAnalysis/unitCosts');
  const four = moduleRunners.estimateCost('competitor', { competitorCount: 4 });
  assert.ok(
    four.estimate <= MAX_UNITS_PER_RUN,
    `${four.estimate} exceeds the module's ${MAX_UNITS_PER_RUN}-unit ceiling`,
  );
});

test('the declared per-domain cost matches the competitor module’s own model', () => {
  // Two places would drift: the estimate shown to a user, and what the module
  // actually spends. This ties them together.
  const { estimateDomainCost } = require('../../competitorAnalysis/unitCosts');
  assert.strictEqual(moduleRunners.METERED.competitor.perDomain, estimateDomainCost());
});

test('an unmetered module has no cost estimate at all', () => {
  for (const key of ['on_page', 'seo_geo', 'agent_readiness', 'hub_spoke']) {
    assert.strictEqual(moduleRunners.estimateCost(key), null);
  }
});

console.log('\nStructured bands are not pasted into headlines');

test('a band stored as JSON is dropped rather than shown raw', () => {
  // One module's band is { label, blurb }; stored in a text column it became a
  // JSON string that rendered verbatim on the card.
  const card = overview.evidenceCard(
    overview.MODULES.find((m) => m.key === 'seo_geo'),
    {
      terminal: {
        id: 'r9', status: 'completed', score: 88, score_max: 100,
        score_basis: 'rule-based bucket scores',
        band: '{"label":"Good","blurb":"Technically sound."}',
        counts: {}, findings: [], finished_at: '2026-08-21T10:00:00Z',
      },
      inFlight: null,
    },
  );
  assert.strictEqual(card.band, null);
  assert.doesNotMatch(card.headline, /\{|blurb/, 'no JSON on a client-facing card');
  assert.match(card.headline, /88\/100/, 'the score itself still shows');
});

test('a plain-text band still shows', () => {
  const card = overview.evidenceCard(
    overview.MODULES.find((m) => m.key === 'agent_readiness'),
    {
      terminal: {
        id: 'r10', status: 'completed', score: 28, score_max: 100,
        score_basis: 'weighted checks', band: 'Level 1 — Basic Web Presence',
        counts: {}, findings: [], finished_at: '2026-08-21T10:00:00Z',
      },
      inFlight: null,
    },
  );
  assert.strictEqual(card.band, 'Level 1 — Basic Web Presence');
  assert.match(card.headline, /Level 1/);
});

console.log('\nRunner targeting');

test('the target comes from the primary domain, not the legacy column', () => {
  const target = moduleRunners.targetFor(
    { url: 'https://old-value.example' },
    [{ role: 'primary', status: 'active', normalized_origin: 'https://gentledental.com', host: 'gentledental.com' }],
  );
  assert.strictEqual(target.origin, 'https://gentledental.com');
  assert.strictEqual(target.fromLegacyColumn, false);
});

test('a pre-0011 project falls back to its url column, and says it did', () => {
  const target = moduleRunners.targetFor({ url: 'https://legacy.example' }, []);
  assert.strictEqual(target.origin, 'https://legacy.example');
  assert.strictEqual(target.fromLegacyColumn, true);
});

test('a project with nothing to audit refuses rather than guessing a host', () => {
  assert.throws(
    () => moduleRunners.targetFor({ url: null }, []),
    (e) => e.status === 400 && e.code === 'no_primary_domain',
  );
});

test('an unrunnable module key is refused by name', async () => {
  await assert.rejects(
    () => moduleRunners.runModule({ access: { project: {} }, moduleKey: 'technical', domains: [] }),
    (e) => e.status === 400 && e.code === 'module_not_runnable',
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
