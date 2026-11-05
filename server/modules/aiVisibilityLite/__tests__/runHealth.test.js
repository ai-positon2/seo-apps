// ── runHealth: a run that lost a model says so, in words ─────────────────────
//
// Also the setup sentence for a setup that wrote no questions, and the run
// closing for a partial run — the pure parts of UX-011, UX-102 and UX-147.
//
// Run: node modules/aiVisibilityLite/__tests__/runHealth.test.js

const assert = require('assert');
const h = require('../runHealth');

let passed = 0; let failed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ✓ ${name}`); } catch (e) { failed += 1; console.error(`  ✗ ${name}\n    ${e.message}`); }
}
const section = (name) => console.log(`\n${name}`);

const CLAUDE_401 = '401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"},"request_id":"req_1"}';
const GEMINI_KEY = 'Gemini refused the request (API key not valid. Please pass a valid API key.)';
const row = (engine, status, failureReason = null) => ({
  engine,
  surfaceLabel: { openai: 'ChatGPT (API · web search)', anthropic: 'Claude (API · web search)', google: 'Gemini (API · Google Search grounding)' }[engine],
  status,
  failureReason,
});

section('normaliseFailure');

test('provider errors fold into a few plain reasons', () => {
  assert.strictEqual(h.normaliseFailure(CLAUDE_401).code, 'auth');
  assert.strictEqual(h.normaliseFailure(GEMINI_KEY).code, 'auth');
  assert.strictEqual(h.normaliseFailure('429 rate limit exceeded').code, 'rate_limited');
  assert.strictEqual(h.normaliseFailure('Gemini did not answer within 60s').code, 'timeout');
  assert.strictEqual(h.normaliseFailure('ANTHROPIC_API_KEY is not configured.').code, 'not_configured');
  assert.strictEqual(h.normaliseFailure('something odd').code, 'other');
});

test('the answer-card sentence carries no raw JSON', () => {
  const s = h.plainFailure(CLAUDE_401);
  assert.ok(!/request_id|\{/.test(s));
  assert.match(s, /API key/);
  assert.strictEqual(h.plainFailure(null), null);
});

section('healthOfRows');

test('two models fully failed: partial, grouped by model and reason', () => {
  const rows = [
    ...Array.from({ length: 10 }, () => row('openai', 'captured')),
    ...Array.from({ length: 10 }, (_, i) => row('anthropic', 'failed', CLAUDE_401.replace('req_1', `req_${i}`))),
    ...Array.from({ length: 10 }, () => row('google', 'failed', GEMINI_KEY)),
  ];
  const out = h.healthOfRows(rows);
  assert.strictEqual(out.partial, true);
  assert.deepStrictEqual(out.failedEngines.sort(), ['Claude', 'Gemini']);
  assert.match(out.summary, /Claude: 10 of 10 failed \(our API key for this model was rejected\)\./);
  assert.match(out.summary, /Gemini: 10 of 10 failed/);
  const claude = out.engines.find((e) => e.engine === 'anthropic');
  assert.strictEqual(claude.reasons.length, 1, 'unique request ids still group into one reason');
});

test('one failed answer of thirty is not a partial run', () => {
  const rows = [
    ...Array.from({ length: 29 }, () => row('openai', 'captured')),
    row('openai', 'failed', 'timeout'),
  ];
  assert.strictEqual(h.healthOfRows(rows).partial, false);
});

section('healthFromPayload — older runs');

test('a run stored before health existed is rebuilt from its coverage block', () => {
  const out = h.healthFromPayload({
    surfaces: ['openai:api', 'anthropic:api', 'google:api'],
    coverage: {
      total: 30, measured: 10, failed: 20,
      failureReasons: [
        ...Array.from({ length: 10 }, (_, i) => ({ reason: CLAUDE_401.replace('req_1', `req_${i}`), count: 1 })),
        { reason: GEMINI_KEY, count: 10 },
      ],
    },
  });
  assert.strictEqual(out.partial, true);
  assert.deepStrictEqual(out.failedEngines.sort(), ['Claude', 'Gemini']);
});

test('surfacesWithHealth marks a key that was rejected as not ready', () => {
  const health = h.healthOfRows([row('openai', 'captured'), row('anthropic', 'failed', CLAUDE_401)]);
  const out = h.surfacesWithHealth([
    { id: 'openai:api', engine: 'openai', label: 'ChatGPT (API · web search)', ready: true, reason: null },
    { id: 'anthropic:api', engine: 'anthropic', label: 'Claude (API · web search)', ready: true, reason: null },
  ], health, '2026-11-03T04:00:00Z');
  assert.strictEqual(out[0].ready, true);
  assert.strictEqual(out[1].ready, false);
  assert.strictEqual(out[1].keySet, true);
  assert.match(out[1].reason, /Claude answered none of its 1 questions on the last run \(2026-11-03\)/);
});

section('run closing and setup warnings');

test('a run with a fully failed model adds a warning finding and keeps its status', () => {
  const { closingFor } = require('../run');
  const health = h.healthOfRows([row('openai', 'captured'), row('anthropic', 'failed', CLAUDE_401)]);
  const out = closingFor({ score: 50, findings: [] }, health);
  assert.strictEqual(out.status, 'completed');
  assert.strictEqual(out.findings.length, 1);
  assert.strictEqual(out.findings[0].severity, 'warning');
  assert.match(out.findings[0].title, /Claude answered nothing/);
});

test('a setup that wrote no questions says why', () => {
  const { zeroWrittenWarning } = require('../setup');
  const s = zeroWrittenWarning(Array.from({ length: 16 }, () => ({ code: 'brand_leak' })), []);
  assert.match(s, /No questions were written/);
  assert.match(s, /16 named the business/);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
