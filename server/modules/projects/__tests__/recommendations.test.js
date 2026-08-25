// Tests for the recommendation lifecycle (PRD phase 6).
//
// The transition table and the material-change rule are pure, which is why they
// are pure: these are the rules that decide who is accountable for advice given
// to a client, and they must be testable without a database or a session.

const assert = require('assert');
const reco = require('../recommendations');
const projectAccess = require('../../../services/projectAccess');

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

console.log('\nRecommendations — the transition table');

test('a draft can only be proposed', () => {
  assert.strictEqual(reco.transitionFor('draft', 'proposed').ok, true);
  assert.strictEqual(reco.transitionFor('draft', 'approved').ok, false);
  assert.strictEqual(reco.transitionFor('draft', 'shipped').ok, false);
});

test('proposing needs edit rights; approving needs approval rights', () => {
  assert.strictEqual(reco.transitionFor('draft', 'proposed').capability, 'editRecommendation');
  assert.strictEqual(reco.transitionFor('proposed', 'approved').capability, 'approveRecommendation');
  assert.strictEqual(reco.transitionFor('proposed', 'rejected').capability, 'approveRecommendation');
});

test('marking something shipped is its own capability', () => {
  // Separate from approval on purpose: whoever pushed the change is often not
  // whoever approved it.
  assert.strictEqual(reco.transitionFor('approved', 'shipped').capability, 'recordShippedDate');
});

test('nothing can be approved without being proposed first', () => {
  for (const from of ['draft', 'rejected', 'shipped']) {
    assert.strictEqual(
      reco.transitionFor(from, 'approved').ok, false,
      `${from} must not jump straight to approved`,
    );
  }
});

test('shipped is final', () => {
  const verdict = reco.transitionFor('shipped', 'proposed');
  assert.strictEqual(verdict.ok, false);
  assert.match(verdict.reason, /final/);
});

test('a rejection can be reopened — "not now" is not "never"', () => {
  assert.strictEqual(reco.transitionFor('rejected', 'proposed').ok, true);
});

test('an unreachable transition explains what IS reachable', () => {
  const verdict = reco.transitionFor('draft', 'shipped');
  assert.strictEqual(verdict.ok, false);
  assert.match(verdict.reason, /proposed/, 'the error names the way forward');
});

console.log('\nRecommendations — approval integrity');

test('editing the advice is material; re-prioritising it is not', () => {
  const existing = { title: 'Fix titles', body: 'Rewrite the 12 duplicate titles', priority: 'medium' };
  assert.strictEqual(reco.isMaterialChange(existing, { title: 'Fix meta titles' }), true);
  assert.strictEqual(reco.isMaterialChange(existing, { body: 'Something else' }), true);
  assert.strictEqual(
    reco.isMaterialChange(existing, { priority: 'urgent' }), false,
    're-ordering the queue is not a change to the advice',
  );
  assert.strictEqual(reco.isMaterialChange(existing, { effort: 'S' }), false);
});

test('an unchanged value is not a material change', () => {
  const existing = { title: 'Fix titles', body: null };
  assert.strictEqual(reco.isMaterialChange(existing, { title: 'Fix titles' }), false);
});

test('only approvers and above may approve, per §7.2', () => {
  // The transition table's capability has to exist in the shared matrix, or the
  // check would silently pass nobody.
  const capability = reco.transitionFor('proposed', 'approved').capability;
  assert.strictEqual(projectAccess.capabilityFor('contributor', capability), false);
  assert.strictEqual(projectAccess.capabilityFor('approver', capability), true);
  assert.strictEqual(projectAccess.capabilityFor('admin', capability), true);
  assert.strictEqual(projectAccess.capabilityFor('owner', capability), true);
});

test('a contributor may draft and propose, but not approve their own advice', () => {
  assert.strictEqual(projectAccess.capabilityFor('contributor', 'editRecommendation'), true);
  assert.strictEqual(projectAccess.capabilityFor('contributor', 'approveRecommendation'), false);
});

test('every capability the transition table names is a real capability', () => {
  for (const [from, targets] of Object.entries(reco.TRANSITIONS)) {
    for (const [to, capability] of Object.entries(targets)) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(projectAccess.CAPABILITIES, capability),
        `${from} -> ${to} requires "${capability}", which is not in the §7.2 matrix`,
      );
    }
  }
});

console.log('\nRecommendations — from a finding');

test("a finding's own recommendation text becomes the body, ungenerated", () => {
  const draft = reco.fromFinding({
    ruleId: 'onpage-4.2', title: 'Meta description missing', severity: 'warning',
    category: 'On-Page', count: 12, recommendation: 'Write a 150-character description.',
  }, { moduleKey: 'on_page', sourceRunId: 'run-1' });

  assert.strictEqual(draft.title, 'Meta description missing');
  assert.strictEqual(draft.body, 'Write a 150-character description.');
  assert.strictEqual(draft.moduleKey, 'on_page');
  assert.strictEqual(draft.sourceRunId, 'run-1');
  assert.strictEqual(draft.ruleId, 'onpage-4.2');
});

test('severity does not become priority', () => {
  // An error on one page can matter less than a warning on six hundred. Mapping
  // one to the other would dress a guess up as a decision.
  const fromError = reco.fromFinding({ title: 'x', severity: 'error', count: 1 });
  const fromNotice = reco.fromFinding({ title: 'y', severity: 'notice', count: 900 });
  assert.strictEqual(fromError.priority, 'medium');
  assert.strictEqual(fromNotice.priority, 'medium');
});

test('the evidence is snapshotted, not referenced', () => {
  const draft = reco.fromFinding({
    title: 'x', severity: 'error', category: 'Technical', count: 47, detail: '47 URLs',
  });
  assert.strictEqual(draft.evidence.severity, 'error');
  assert.strictEqual(draft.evidence.count, 47);
  assert.ok(draft.evidence.capturedAt, 'a snapshot records when it was taken');
});

test('a finding with no advice of its own yields no invented body', () => {
  const draft = reco.fromFinding({ title: 'Something is off', severity: 'warning', count: 1 });
  assert.strictEqual(draft.body, null, 'better empty than machine-written and unattributed');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
