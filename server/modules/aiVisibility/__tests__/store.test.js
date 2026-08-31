// ── store.js — the pure parts ────────────────────────────────────────────────
//
// Everything else in store.js talks to Supabase and is exercised manually
// against a real database (see the migration's own verification block and the
// plan's end-to-end checklist). promptView/captureView are pure row-shaping
// and are exactly the part regressions hide in silently, so they get a test.
//
// Run: node modules/aiVisibility/__tests__/store.test.js

const assert = require('assert');
const store = require('../store');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (e) { failed += 1; console.error(`  ✗ ${name}\n    ${e.message}`); }
}
const section = (name) => console.log(`\n${name}`);

section('promptView');

const ROW = {
  id: 'p1', project_id: 'proj1', text: 'best dentist boston',
  source: 'cluster', source_ref: 'Implants', intent: 'informational',
  slot: 'cluster_informational', rationale: 'grounded in the Implants cluster',
  topic_kind: 'page', topic_label: 'Dental Implants', target_url: 'https://x.com/implants',
  demand_volume: 880, demand_source: 'dataforseo',
  status: 'approved',
  proposed_at: '2026-01-01T00:00:00Z', approved_at: '2026-01-02T00:00:00Z', approved_by: 'u1',
  rejected_at: null, rejected_by: null, rejection_reason: null,
  retired_at: null, retired_by: null,
  generation_run_id: 'run1',
  created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z',
  evidence: { grounding: { cluster: { name: 'Implants' } } },
};

test('active is derived from status, not a stored column', () => {
  assert.strictEqual(store.promptView(ROW).active, true);
  assert.strictEqual(store.promptView({ ...ROW, status: 'draft' }).active, false);
  assert.strictEqual(store.promptView({ ...ROW, status: 'retired' }).active, false);
});

test('evidence is omitted by default and included on request', () => {
  const withoutEvidence = store.promptView(ROW);
  assert.strictEqual(withoutEvidence.evidence, undefined);

  const withEvidence = store.promptView(ROW, { includeEvidence: true });
  assert.deepStrictEqual(withEvidence.evidence, ROW.evidence);
});

test('topic and slot fields round-trip camelCase', () => {
  const view = store.promptView(ROW);
  assert.strictEqual(view.topicKind, 'page');
  assert.strictEqual(view.topicLabel, 'Dental Implants');
  assert.strictEqual(view.targetUrl, 'https://x.com/implants');
  assert.strictEqual(view.demandVolume, 880);
  assert.strictEqual(view.slot, 'cluster_informational');
});

section('captureView');

test('prominence and taskCost are numeric, or null when unmeasured', () => {
  const row = {
    id: 'c1', prompt_id: 'p1', prompt_text: 'x', engine: 'chatgpt', provider: 'dataforseo',
    access: 'scraped', surface_label: 'ChatGPT', status: 'captured',
    failure_reason: null, answer_text: 'x', citations: [],
    mentioned: true, cited: true, prominence: '0.250',
    competitors_mentioned: [], web_queries: [], model_version: null,
    task_cost: '0.00400', captured_at: '2026-01-01T00:00:00Z',
  };
  const view = store.captureView(row);
  assert.strictEqual(view.prominence, 0.25);
  assert.strictEqual(view.taskCost, 0.004);

  const unmeasured = store.captureView({ ...row, prominence: null, task_cost: null });
  assert.strictEqual(unmeasured.prominence, null);
  assert.strictEqual(unmeasured.taskCost, null);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
