// ── Hub & Spoke cluster health v2 (fix 5.3) ─────────────────────────────────
//
// Run: node --test modules/contentArchitect/__tests__/clusterHealth.test.js

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { clusterHealth, hubSpokeLinking } = require('../diagnostics');

// Hub 0 with spokes 1-4. Breadth needs term profiles; empty ones score 0, so
// these isolate the other parts.
const members = [0, 1, 2, 3, 4];
const profiles = members.map(() => ({ terms: new Map(), tf: new Map() }));
const flat = members.map(() => 1);

test('ideal hub-and-spoke linking scores full, with no spoke-to-spoke links', () => {
  const graph = [[1, 2, 3, 4], [0], [0], [0], [0]];
  assert.equal(hubSpokeLinking(0, members, graph), 1);
});

test('a full mesh with no hub link scores nothing for linking', () => {
  const graph = [[], [2, 3, 4], [1, 3, 4], [1, 2, 4], [1, 2, 3]];
  assert.equal(hubSpokeLinking(0, members, graph), 0);
});

test('a suggested or glossary hub gets half the hub credit', () => {
  const graph = [[], [], [], [], []];
  const sure = clusterHealth({}, { isGap: false, hubPageIndex: null, hubConfidence: 'high' }, members, flat, graph, profiles);
  const suggested = clusterHealth({}, { isGap: false, hubPageIndex: null, hubConfidence: 'suggested' }, members, flat, graph, profiles);
  const reference = clusterHealth({}, { isGap: false, hubPageIndex: null, hubConfidence: 'reference' }, members, flat, graph, profiles);
  assert.equal(sure - suggested, 15);
  assert.equal(suggested, reference);
});

test('cluster size no longer adds points it could never withhold', () => {
  const graph = [[], [], [], [], []];
  const gap = clusterHealth({}, { isGap: true, hubPageIndex: null }, members, members.map(() => Infinity), graph, profiles);
  assert.equal(gap, 0, 'no hub, no links, no known depth: nothing earned');
});
