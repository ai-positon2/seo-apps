// ── Keyword Research state machine ───────────────────────────────────────────
//
// The standalone page and Content Architect's compact panel both render from
// this model, so these rules are what keeps the two views in agreement.
//
// Run: npm test --prefix client

import { test } from 'node:test';
import assert from 'node:assert';

import {
  initialState, reduce, availableKeywords, poolByTier, progressOf,
  buildCopyTable, buildContentWriterUrl, snapshot, selectionOf, hydrate, shortVolume,
  MAX_PRIMARY, MAX_SECONDARY,
} from '../keywordResearchModel.js';

const kw = (keyword, extra = {}) => ({ keyword, volume: 100, difficulty: 30, ...extra });

// A recorded run, event by event, as the server emits it for a topic.
function recordedRun() {
  const pool = [
    kw('managed it services', { volume: 5400, urlFrequency: 4 }),
    kw('managed it provider', { volume: 1900, urlFrequency: 3 }),
    kw('msp pricing', { volume: 880, urlFrequency: 2 }),
    kw('it outsourcing', { volume: 720, urlFrequency: 1 }),
    kw('choosing an msp', { volume: 90, urlFrequency: 1 }),
  ];
  const secondary = Array.from({ length: 10 }, (_, i) => kw(`secondary ${i}`));
  return [
    { type: 'start' },
    { type: 'step', data: { id: 'seed', status: 'active', message: 'Deriving…' } },
    { type: 'seed', data: { keyword: 'managed it provider', fromTopic: 'How to Choose a Managed IT Provider', source: 'model' } },
    { type: 'step', data: { id: 'seed', status: 'done', message: 'Seed keyword: "managed it provider"' } },
    { type: 'step', data: { id: 'variants', status: 'done', message: 'Generated 5 variants' } },
    { type: 'variants', data: { queries: ['managed it provider', 'how msps work'] } },
    { type: 'urls', data: { urls: [{ url: 'https://a.com/x', pageType: 'article', queryCount: 2, rubricScore: 0.8 }], totalQueries: 6 } },
    { type: 'url_status', data: { url: 'https://a.com/x', title: 'A' } },
    { type: 'url_keywords', data: { url: 'https://a.com/x', title: 'A', status: 'done', keywords: pool.slice(0, 2) } },
    { type: 'step', data: { id: 'semrush', status: 'active', message: 'Fetching…' } },
    { type: 'allKeywords', data: { keywords: pool } },
    { type: 'result', data: { primary: [pool[1], kw('Managed IT Services ', { reason: 'core' })], secondary, warning: null } },
    { type: 'done', data: {} },
  ];
}

const play = (events, from = initialState({ keyword: '', intent: 'informational' })) => events.reduce(reduce, from);

test('a recorded topic run lands as a finished result with the derived seed', () => {
  const s = play(recordedRun());
  assert.strictEqual(s.running, false);
  assert.strictEqual(s.started, true);
  assert.strictEqual(s.keyword, 'managed it provider');
  assert.strictEqual(s.seed.fromTopic, 'How to Choose a Managed IT Provider');
  assert.strictEqual(s.primary.length, 2);
  assert.strictEqual(s.secondary.length, 10);
  assert.strictEqual(s.urlData['https://a.com/x'].keywords.length, 2);
  assert.strictEqual(s.intent, 'informational');
});

test('start clears the previous run but keeps the seed and intent', () => {
  const s = reduce(play(recordedRun()), { type: 'start' });
  assert.strictEqual(s.result, null);
  assert.deepStrictEqual(s.primary, []);
  assert.strictEqual(s.running, true);
  assert.strictEqual(s.keyword, 'managed it provider');
  assert.strictEqual(s.intent, 'informational');
});

test('the pool excludes picks, matching case- and space-insensitively', () => {
  const s = play(recordedRun());
  const pool = availableKeywords(s).map((k) => k.keyword);
  // "Managed IT Services " was picked as primary; the pool's lowercase entry is gone.
  assert.ok(!pool.includes('managed it services'));
  assert.ok(!pool.includes('managed it provider'));
  assert.deepStrictEqual(pool.sort(), ['choosing an msp', 'it outsourcing', 'msp pricing']);
});

test('tiers: core 3+, relevant 2, discovery 1, each by volume, empty tiers dropped', () => {
  let s = play(recordedRun());
  let tiers = poolByTier(s);
  assert.deepStrictEqual(tiers.map((t) => t.id), ['relevant', 'discovery']);
  assert.deepStrictEqual(tiers[1].keywords.map((k) => k.keyword), ['it outsourcing', 'choosing an msp']);
  s = reduce(s, { type: 'removePrimary', index: 0 });
  tiers = poolByTier(s);
  assert.deepStrictEqual(tiers[0].keywords.map((k) => k.keyword), ['managed it provider']);
});

test('caps: never more than 2 primary or 10 secondary, and no duplicates', () => {
  let s = play(recordedRun());
  const before = s;
  s = reduce(s, { type: 'addPrimary', kw: kw('msp pricing') });
  assert.strictEqual(s, before, 'primary is full');
  s = reduce(s, { type: 'addSecondary', kw: kw('msp pricing') });
  assert.strictEqual(s.secondary.length, MAX_SECONDARY, 'secondary is full');
  s = reduce(s, { type: 'removeSecondary', index: 0 });
  s = reduce(s, { type: 'addSecondary', kw: kw('MANAGED IT PROVIDER') });
  assert.strictEqual(s.secondary.length, MAX_SECONDARY - 1, 'already a primary');
  s = reduce(s, { type: 'addSecondary', kw: kw('msp pricing') });
  assert.strictEqual(s.secondary.length, MAX_SECONDARY);
});

test('moving between primary and secondary respects the target cap', () => {
  let s = play(recordedRun());
  assert.strictEqual(reduce(s, { type: 'toPrimary', index: 0 }), s, 'primary is full');
  assert.strictEqual(reduce(s, { type: 'toSecondary', index: 0 }), s, 'secondary is full');
  s = reduce(s, { type: 'removeSecondary', index: 0 });
  s = reduce(s, { type: 'toSecondary', index: 0 });
  assert.strictEqual(s.primary.length, 1);
  assert.strictEqual(s.secondary.at(-1).keyword, 'managed it provider');
  s = reduce(s, { type: 'toPrimary', index: MAX_SECONDARY - 1 });
  assert.strictEqual(s.primary.length, MAX_PRIMARY);
  assert.strictEqual(s.primary.at(-1).keyword, 'managed it provider');
});

test('progress counts the seed step only on a topic run', () => {
  const topicRun = play(recordedRun().slice(0, 4));
  assert.deepStrictEqual(
    { index: progressOf(topicRun).index, total: progressOf(topicRun).total, label: progressOf(topicRun).label },
    { index: 1, total: 8, label: 'Seed Keyword' },
  );
  const keywordRun = play([{ type: 'start' }, { type: 'step', data: { id: 'semrush', status: 'active', message: 'x' } }]);
  assert.deepStrictEqual([progressOf(keywordRun).index, progressOf(keywordRun).total], [4, 7]);
  assert.strictEqual(progressOf(initialState()), null);
});

test('copy table: TSV and escaped HTML, null when empty', () => {
  const t = buildCopyTable([kw('a<b', { volume: 5 })], [kw('c', { volume: 0 })]);
  assert.strictEqual(t.tsv, 'Type\tKeyword\tVolume\nPrimary\ta<b\t5\nSecondary\tc\t0');
  assert.ok(t.html.includes('<td>a&lt;b</td>'));
  assert.strictEqual(buildCopyTable([], []), null);
});

test('Content Writer handoff sends primary #1 and every other pick as secondary', () => {
  const url = buildContentWriterUrl({ primary: [kw('one'), kw('two')], secondary: [kw('three')], client: 'riccobene' });
  const q = new URLSearchParams(url.split('?')[1]);
  assert.ok(url.startsWith('/content-writer?'));
  assert.strictEqual(q.get('keyword'), 'one');
  assert.strictEqual(q.get('secondary'), 'two, three');
  assert.strictEqual(q.get('client'), 'riccobene');
  assert.strictEqual(new URLSearchParams(buildContentWriterUrl({ primary: [kw('x')], secondary: [] }).split('?')[1]).get('secondary'), null);
});

test('a saved snapshot and edited selection hydrate back to the same view', () => {
  let s = play(recordedRun());
  s = reduce(s, { type: 'removeSecondary', index: 3 });
  const saved = { intent: 'informational', result: JSON.parse(JSON.stringify(snapshot(s))), selection: JSON.parse(JSON.stringify(selectionOf(s))) };
  const back = hydrate(initialState(), saved);
  assert.strictEqual(back.started, true);
  assert.strictEqual(back.running, false);
  assert.strictEqual(back.keyword, 'managed it provider');
  assert.strictEqual(back.intent, 'informational');
  assert.strictEqual(back.secondary.length, 9);
  assert.deepStrictEqual(availableKeywords(back).map((k) => k.keyword).sort(), availableKeywords(s).map((k) => k.keyword).sort());
  // No selection saved yet: fall back to the AI's picks.
  assert.strictEqual(hydrate(initialState(), { result: saved.result }).secondary.length, 10);
  // Nothing usable: unchanged.
  const empty = initialState();
  assert.strictEqual(hydrate(empty, { result: {} }), empty);
});

test('fail keeps the message through the done that always follows it', () => {
  const s = play([{ type: 'start' }, { type: 'fail', data: { message: 'No keyword data' } }, { type: 'done' }]);
  assert.strictEqual(s.error, 'No keyword data');
  assert.strictEqual(s.running, false);
  const lost = play([{ type: 'start' }, { type: 'connectionLost' }]);
  assert.strictEqual(lost.error, 'Connection lost. Please try again.');
});

test('short volumes', () => {
  assert.strictEqual(shortVolume(800), '800');
  assert.strictEqual(shortVolume(5400), '5.4k');
  assert.strictEqual(shortVolume(0), '');
});

test('a replayed saved run is marked, and a new run clears the mark', () => {
  let s = reduce(initialState({ keyword: 'invisalign treatment overview' }), { type: 'start' });
  s = reduce(s, { type: 'result', data: { primary: [kw('invisalign treatment')], secondary: [] } });
  s = reduce(s, { type: 'cached', data: { at: '2026-10-09T10:00:00.000Z' } });
  s = reduce(s, { type: 'done' });
  assert.strictEqual(s.cachedAt, '2026-10-09T10:00:00.000Z');
  assert.strictEqual(s.primary[0].keyword, 'invisalign treatment', 'the saved picks are shown as they were');
  const next = reduce(s, { type: 'start' });
  assert.strictEqual(next.cachedAt, null, 'a fresh run is not labelled as saved');
});
