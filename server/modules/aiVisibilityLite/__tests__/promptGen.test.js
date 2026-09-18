// ── The brand guard, and the bug that made it reject everything ─────────────
//
// Pinned against a real failure. The first live setup run, on acalvio.com,
// built a good profile and then wrote ZERO questions: all 16 candidates were
// rejected as `brand_leak` with `brandGuard: 'strict'` and no error anywhere.
// The screen showed "QUESTIONS (0 OF 20)" and nothing else.
//
// None of the 16 named the client. The cause was that the profile's
// `brand_aliases` had collected page titles and product lines —
// "Acalvio | Cyber Deception Technology for Preemptive Cybersecurity",
// "ShadowPlex Advanced Threat Defense" — and promptValidator tokenises every
// alias it is given and treats each token as "this reads as the brand". The
// brand token set became the entire product category (`cyber`, `deception`,
// `threat`, `cloud`, `security`, `platform`) plus the stopword `for`, so every
// question about the category read as naming the client.
//
// Two defences, both tested here:
//
//   businessProfile.nameLike   keeps titles and taglines out of the stored
//                              aliases in the first place
//   promptGen.guardNamesFrom   narrows what the GUARD sees to the business name
//                              and the aliases that stand alone as one word,
//                              never the parts of a multi-word alias
//
// Run: node modules/aiVisibilityLite/__tests__/promptGen.test.js

const assert = require('assert');
const validator = require('../../aiVisibility/promptValidator');
const { guardNamesFrom } = require('../promptGen');
const { nameLike } = require('../businessProfile');

let passed = 0; let failed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ✓ ${name}`); } catch (e) { failed += 1; console.error(`  ✗ ${name}\n    ${e.message}`); }
}
const section = (name) => console.log(`\n${name}`);

// The profile exactly as it was stored on the failing run.
const ACALVIO = {
  businessName: 'Acalvio',
  summary: 'Acalvio provides cyber deception technology for preemptive cybersecurity in enterprise environments.',
  products: ['ShadowPlex', 'Identity Protection', 'Cloud Security', 'Targeted Threat Intel'],
  services: ['cyber deception', 'threat detection', 'identity protection', 'ransomware defense',
    'lateral movement detection', 'OT security', 'red teaming support'],
  locations: [],
  competitors: [],
  brandAliases: [
    'Acalvio', 'ShadowPlex', 'ShadowPlex Advanced Threat Defense',
    'ShadowPlex Identity Protection', 'ShadowPlex Cloud Security',
    'ShadowPlex Targeted Threat Intel', 'ShadowPlex Preemptive Cybersecurity Platform',
    'ShadowPlex Deception Guardrails',
    'Acalvio | Cyber Deception Technology for Preemptive Cybersecurity',
    'ShadowPlex: AI-Powered Cyber Deception Platform',
  ],
};

// Four of the sixteen that were wrongly rejected. None names the client.
const REAL_QUESTIONS = [
  'What does a cyber deception platform usually cost for a mid-size enterprise?',
  'Are there good options for deception technology that work in cloud environments as well as on-prem?',
  'What should I look for in a tool that detects identity-based attacks before an attacker can escalate privileges?',
  'For OT security, are there cyber deception products that can help detect attackers early?',
];

const batch = (texts, aliases) => validator.validateBatch(
  texts.map((text) => ({ text })),
  { brand: { name: ACALVIO.businessName, aliases }, competitors: [], existing: [] },
);

section('The regression: the category is not the brand');

test('the raw alias list rejects every question — this is the bug', () => {
  const out = batch(REAL_QUESTIONS, ACALVIO.brandAliases);
  assert.strictEqual(out.accepted.length, 0, 'if this passes, the bug is gone by another route');
  assert.ok(out.rejected.every((r) => r.code === 'brand_leak'));
});

test('the narrowed guard accepts all of them', () => {
  const out = batch(REAL_QUESTIONS, guardNamesFrom(ACALVIO));
  assert.strictEqual(out.accepted.length, REAL_QUESTIONS.length,
    `rejected: ${out.rejected.map((r) => r.reason).join(' | ')}`);
});

test('the guard still catches a question that really does name the client', () => {
  const leaks = [
    'Is Acalvio any good for enterprise deception?',
    'How does ShadowPlex compare to other deception tools?',
    'Should I buy Acalvio ShadowPlex for lateral movement detection?',
  ];
  const out = batch(leaks, guardNamesFrom(ACALVIO));
  assert.strictEqual(out.accepted.length, 0, 'a question naming the client proves nothing and must be rejected');
  assert.ok(out.rejected.every((r) => r.code === 'brand_leak'));
});

section('guardNamesFrom');

// Case-insensitively: the business name keeps whatever case the site used, and
// the validator lowercases internally.
const lower = (profile) => guardNamesFrom(profile).map((n) => n.toLowerCase());

test('keeps the distinguishing names', () => {
  const names = lower(ACALVIO);
  assert.ok(names.includes('acalvio'), 'the company name must survive');
  assert.ok(names.includes('shadowplex'), 'the product name must survive');
});

test('drops the descriptive words inside multi-word aliases', () => {
  const names = lower(ACALVIO);
  for (const category of ['cyber', 'deception', 'threat', 'cloud', 'security', 'identity', 'protection', 'platform', 'advanced', 'powered', 'guardrails']) {
    assert.ok(!names.includes(category), `"${category}" is the category, not the brand`);
  }
});

test('a company named after what it sells still gets a guard', () => {
  // The business name is always kept as a phrase, so a company whose every word
  // is a category word still has something to match on. v1's brandTokens
  // subtracts generic industry words and reports `weak` when little is left,
  // which setup.js surfaces rather than swallowing.
  const profile = {
    businessName: 'Deception',
    summary: 'Deception sells deception technology.',
    products: ['deception'], services: ['deception'], locations: [], brandAliases: ['Deception'],
  };
  const names = guardNamesFrom(profile);
  assert.ok(names.length > 0, 'a guard of nothing accepts everything');
  const out = validator.validateBatch([{ text: 'Is Deception a good vendor for this?' }], {
    brand: { name: 'Deception', aliases: names }, competitors: [], existing: [],
  });
  assert.strictEqual(out.accepted.length, 0);
});

section('nameLike — keeping titles out of the alias list');

test('rejects page titles and taglines', () => {
  for (const bad of [
    'Acalvio | Cyber Deception Technology for Preemptive Cybersecurity',
    'ShadowPlex: AI-Powered Cyber Deception Platform',
    'Security for your enterprise — preemptive and autonomous',
    'The best dental care in North Carolina.',
  ]) {
    assert.strictEqual(nameLike(bad), false, bad);
  }
});

test('keeps real names', () => {
  for (const good of ['Acalvio', 'ShadowPlex', 'Gentle Dental', 'Brush and Floss'.replace(' and ', ' '), 'Commonwealth Dentistry']) {
    assert.strictEqual(nameLike(good), true, good);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
