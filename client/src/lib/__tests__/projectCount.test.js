// ── Projects page headline count ────────────────────────────────────────────
//
// Run: npm test --prefix client
//
// The Projects page said "13 projects in this workspace" while the Team page
// said 8 for the same workspace: the 13 counted soft-deleted projects, which
// the list shows greyed out. The count is of live projects; deleted ones are
// mentioned separately so the greyed rows still add up.

import { test } from 'node:test';
import assert from 'node:assert';

import { projectCountText } from '../projectCount.js';

const live = { lifecycleStatus: 'active' };
const gone = { lifecycleStatus: 'deleted' };

test('counts only live projects, mentions deleted ones', () => {
  assert.strictEqual(projectCountText([...Array(8).fill(live), ...Array(5).fill(gone)]), '8 projects in this workspace, plus 5 deleted');
});

test('no deleted projects: no mention', () => {
  assert.strictEqual(projectCountText([live, live]), '2 projects in this workspace');
});

test('singulars', () => {
  assert.strictEqual(projectCountText([live, gone]), '1 project in this workspace, plus 1 deleted');
});

test('a project without lifecycleStatus is live', () => {
  assert.strictEqual(projectCountText([{}]), '1 project in this workspace');
});
