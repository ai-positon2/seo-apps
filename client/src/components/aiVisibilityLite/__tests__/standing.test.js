// ── AI Visibility overview: rank, ties and the sentence under the headline ──
//
// UX-103: no 'LEADING' / 'ranks #1' on a tie or when nobody was named.
// UX-009/033: 'isn’t tracking any competitors' only when there are none.
// UX-008: an empty period names the last measurement instead of 'never'.
//
// Run: npm test --prefix client

import { test } from 'node:test';
import assert from 'node:assert';

import { standingOf, emptyHeadline } from '../standing.js';

const brand = (name, named, answers, isClient = false) => ({
  name,
  isClient,
  named,
  answers,
  namedRate: answers
    ? { value: named / answers, display: `${((named / answers) * 100).toFixed(1)}%` }
    : { value: null, display: '—' },
});
const report = (brands, answersMeasured = 20) => ({
  brands,
  meta: { answersMeasured },
  headline: { namedRate: { value: brands.find((b) => b.isClient)?.namedRate.value ?? null } },
});

test('both at 0%: no verdict, and a sentence that says nobody was named', () => {
  const s = standingOf(report([brand('Position²', 0, 20, true), brand('Thrive Agency', 0, 20)]));
  assert.strictEqual(s.verdict, null);
  assert.match(s.sentence, /Neither Position² nor Thrive Agency was named in any of the 20 answers/);
  assert.doesNotMatch(s.sentence, /#1/);
});

test('a tie at the top is TIED, not LEADING', () => {
  const s = standingOf(report([brand('Acme', 5, 20, true), brand('Rival', 5, 20)]));
  assert.strictEqual(s.verdict, 'TIED');
  assert.strictEqual(s.rank, 1);
  assert.match(s.sentence, /level with Rival at 25\.0%/);
});

test('a real lead is LEADING', () => {
  const s = standingOf(report([brand('Acme', 6, 20, true), brand('Rival', 5, 20)]));
  assert.strictEqual(s.verdict, 'LEADING');
  assert.match(s.sentence, /ranks #1 of the 2 brands/);
});

test('rank counts only brands strictly ahead, whatever the list order', () => {
  const s = standingOf(report([brand('A', 8, 20), brand('Acme', 3, 20, true), brand('B', 3, 20), brand('C', 1, 20)]));
  assert.strictEqual(s.rank, 2);
  assert.strictEqual(s.tied, true);
});

test('competitors tracked but no answers: no "add competitors" copy', () => {
  const s = standingOf(report([brand('Acme', 0, 0, true), brand('Five9', 0, 0), brand('Genesys', 0, 0)], 0));
  assert.doesNotMatch(s.sentence, /isn’t tracking any competitors/);
  assert.match(s.sentence, /Nothing was measured in this period/);
});

test('no competitors at all: the add-competitors hint stays', () => {
  const s = standingOf(report([brand('Acme', 3, 20, true)]));
  assert.match(s.sentence, /isn’t tracking any competitors/);
});

test('an empty period names the last measurement; a project never measured says so', () => {
  assert.match(emptyHeadline({ meta: { lastMeasuredAt: '2026-10-01T10:00:00Z' } }), /last measured/);
  assert.strictEqual(emptyHeadline({ meta: {} }), 'No AI answers measured yet.');
});
