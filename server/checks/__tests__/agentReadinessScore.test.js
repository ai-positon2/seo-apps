// ── Agent Readiness: 70 core access, 20 other checks today, 10 emerging ─────
//
// Most sites scored near the bottom because many checks are for standards that
// cannot be adopted yet. The score is 70 × the core tier's share (AI bot rules,
// robots.txt, sitemap) + 20 × the other today checks' share + 10 × the emerging
// standards' share (checks/agentReadinessScore.js).
//
// Run: node --test checks/__tests__/agentReadinessScore.test.js

const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  WEIGHTS, READINESS_TIERS, CORE_POINTS, NOW_POINTS, FUTURE_POINTS, readinessScore, quickWinProjection,
  rescoreStoredReport, scorePointsFor, tierOf, groupOf, levelFromScore, scoringSummary,
} = require('../agentReadinessScore');
const route = require('../../routes/agentReadinessAudit');

const HTTP_IDS = Object.keys(WEIGHTS);
const http = (passing = [], extra = {}) => HTTP_IDS.map((id) => ({
  id,
  status: passing.includes(id) ? 'pass' : (id === 'webbotauth' ? 'info' : 'fail'),
  effort: ['robots', 'linkheaders', 'aibots', 'contentsignals'].includes(id) ? 'quick' : 'medium',
  ...(extra[id] || {}),
}));
const CORE_HTTP = HTTP_IDS.filter((id) => tierOf(id) === 'core');
const NOW_HTTP = HTTP_IDS.filter((id) => tierOf(id) === 'now');
const FUTURE_HTTP = HTTP_IDS.filter((id) => tierOf(id) === 'future');
const onPage = (id, pass, maxScore, effort = 'quick') => ({
  id, status: pass ? 'pass' : 'fail', maxScore, score: pass ? maxScore : 0, effort,
});
const round2 = (n) => Math.round(n * 100) / 100;

test('the tiers: 70 core, 20 now, 10 future, every HTTP check in exactly one tier', () => {
  assert.equal(CORE_POINTS + NOW_POINTS + FUTURE_POINTS, 100);
  assert.deepEqual(READINESS_TIERS.map((t) => [t.key, t.points]), [['core', 70], ['now', 20], ['future', 10]]);
  assert.deepEqual([...CORE_HTTP].sort(), ['aibots', 'robots', 'sitemap']);
  assert.deepEqual(NOW_HTTP, ['linkheaders']);
  assert.deepEqual([...FUTURE_HTTP].sort(), [
    'agentskills', 'apicatalog', 'contentsignals', 'markdown', 'mcp', 'oauth', 'oauthresource', 'webbotauth', 'webmcp',
  ]);
  for (const id of HTTP_IDS) {
    const n = READINESS_TIERS.filter((t) => t.ids.includes(id)).length;
    assert.equal(n, 1, `${id} must be in one tier`);
  }
  assert.equal(tierOf('captcha'), 'now');
  assert.equal(tierOf('something_new'), 'now', 'an unlisted check defaults to now');
  assert.equal(groupOf, tierOf);
  assert.equal(WEIGHTS.webbotauth, 0, 'web bot auth stays informational');
  // The route scores with the same module, not a copy.
  assert.equal(route.WEIGHTS, WEIGHTS);
  assert.equal(route.READINESS_TIERS, READINESS_TIERS);
});

test('every core check passing, nothing else = 70', () => {
  const r = readinessScore({ httpChecks: http(CORE_HTTP), onPageChecks: [onPage('form_labels', false, 10)] });
  assert.equal(r.score, 70);
  assert.deepEqual(r.core, { earned: 25, max: 25, points: 70 });
  assert.deepEqual(r.now, { earned: 0, max: 16, points: 20 });
  assert.deepEqual(r.future, { earned: 0, max: 69, points: 10 });
});

test('every core and now check passing, no future check = 90', () => {
  const r = readinessScore({ httpChecks: http([...CORE_HTTP, ...NOW_HTTP]), onPageChecks: [onPage('form_labels', true, 10)] });
  assert.equal(r.score, 90);
  assert.deepEqual(r.now, { earned: 16, max: 16, points: 20 });
});

test('everything passing = 100; nothing passing = 0', () => {
  assert.equal(readinessScore({ httpChecks: http(HTTP_IDS), onPageChecks: [onPage('captcha', true, 8)] }).score, 100);
  assert.equal(readinessScore({ httpChecks: http([]), onPageChecks: [onPage('captcha', false, 8)] }).score, 0);
});

test('only the future checks passing = 10', () => {
  assert.equal(readinessScore({ httpChecks: http(FUTURE_HTTP) }).score, 10);
});

test('on-page checks absent: the now tier is Link headers alone', () => {
  const r = readinessScore({ httpChecks: http(['robots', 'sitemap', 'aibots']) });
  assert.equal(r.now.max, 6);
  assert.equal(r.score, 70);
  assert.equal(readinessScore({ httpChecks: http(['linkheaders']) }).score, 20);
  assert.equal(readinessScore({ httpChecks: http(['robots']), onPageChecks: [] }).score, 20); // 70 × 7 ÷ 25 = 19.6
});

test('on-page checks count in the now tier, with partial credit', () => {
  const r = readinessScore({
    httpChecks: http([]),
    onPageChecks: [{ id: 'captcha', status: 'fail', maxScore: 8, score: 4 }, onPage('form_labels', true, 10)],
  });
  assert.deepEqual(r.now, { earned: 14, max: 24, points: 20 });
  assert.equal(r.score, 12); // 20 × 14 ÷ 24 = 11.67
});

test('an empty now tier hands its 20 points to core and future in proportion', () => {
  const checks = http(CORE_HTTP).filter((c) => c.id !== 'linkheaders');
  const r = readinessScore({ httpChecks: checks });
  assert.equal(r.now.max, 0);
  assert.equal(r.now.points, 0);
  assert.equal(r.core.points, 87.5); // 70 × 100 ÷ 80
  assert.equal(r.future.points, 12.5); // 10 × 100 ÷ 80
  assert.equal(r.score, 88);
});

test('a future tier with nothing to score gives its 10 points to the others', () => {
  const noFuture = http(['robots']).filter((c) => tierOf(c.id) !== 'future');
  const r0 = readinessScore({ httpChecks: noFuture });
  assert.equal(r0.score, Math.round((7000 / 90) * (7 / 25))); // 77.78 × 7 ÷ 25 = 21.78
  // Only web bot auth (weight 0) in the future tier: max 0, the same.
  const r = readinessScore({ httpChecks: [...noFuture, { id: 'webbotauth', status: 'pass' }] });
  assert.equal(r.future.max, 0);
  assert.equal(round2(r.core.points + r.now.points), 100);
  assert.equal(r.score, 22);
  // Only future checks, all passing.
  assert.equal(readinessScore({ httpChecks: [{ id: 'mcp', status: 'pass' }] }).score, 100);
  // Nothing to score at all.
  assert.equal(readinessScore({ httpChecks: [] }).score, null);
});

test('a check not re-checked or not in the report counts in neither earned nor max', () => {
  const checks = http(['robots']).filter((c) => c.id !== 'sitemap');
  const r = readinessScore({ httpChecks: checks.map((c) => (c.id === 'aibots' ? { ...c, status: 'info', olderRule: true } : c)) });
  assert.equal(r.core.max, 25 - 7 - 11);
  assert.equal(r.core.earned, 7);
});

test('the route raw map and the report list score the same', () => {
  const list = http(['robots', 'markdown', 'mcp']);
  const map = Object.fromEntries(list.map(({ id, ...c }) => [id, c]));
  assert.equal(readinessScore({ httpChecks: map }).score, readinessScore({ httpChecks: list }).score);
});

test('a check\'s worth in score points: its points over its tier, times the share', () => {
  const r = readinessScore({ httpChecks: http([]) });
  assert.equal(round2(scorePointsFor(r, 'robots', 7)), 19.6); // 7 ÷ 25 × 70
  assert.equal(round2(scorePointsFor(r, 'linkheaders', 6)), 20); // 6 ÷ 6 × 20
  assert.equal(round2(scorePointsFor(r, 'mcp', 10)), 1.45); // 10 ÷ 69 × 10
});

test('quick wins: the report re-scored with failing quick checks fixed, by the same formula', () => {
  const checks = http(['robots', 'sitemap', 'aibots']);
  const result = quickWinProjection({
    httpChecks: checks,
    onPageChecks: [onPage('form_labels', false, 10, 'quick'), onPage('js_rendering', false, 8, 'medium')],
  });
  // Quick and failing: linkheaders 6, contentsignals 9 (future), form labels 10.
  // Core 70; now 20 × 16 ÷ 24 = 13.33; future 10 × 9 ÷ 69 = 1.30 → 84.64.
  assert.deepEqual(result, { quickWinScore: 85, quickWinCount: 3 });
  // Advisory ('info') checks are not counted as wins.
  const info = quickWinProjection({ httpChecks: checks, onPageChecks: [{ id: 'vague_buttons', status: 'info', effort: 'quick', maxScore: 4, score: 0 }] });
  assert.equal(info.quickWinCount, 2);
});

test('a stored report is re-scored on read: score, level and quick wins from its own checks', () => {
  const stored = {
    site: { url: 'example.com', score: 25, level: 'Level 0 — Not started', httpScore: 25, onPageMax: 0, quickWinScore: 40 },
    cats: [{ id: 'Discoverability', score: 70 }],
    checks: http(['robots', 'sitemap', 'aibots']),
    onPageChecks: [],
  };
  const out = rescoreStoredReport(stored);
  assert.notEqual(out, stored);
  assert.equal(out.site.score, 70);
  assert.equal(out.site.level, levelFromScore(70));
  // + linkheaders 6 (now), contentsignals 9 (future) → 70 + 20 + 10 × 9 ÷ 69 = 91.3
  assert.equal(out.site.quickWinScore, 91);
  assert.deepEqual(out.cats, stored.cats, 'category scores are unchanged');
  assert.equal(out.site.scoring.coreMax, 25);
  assert.equal(out.site.scoring.corePoints, 70);
  assert.equal(out.site.scoring.nowMax, 6);
  assert.equal(stored.site.score, 25, 'the stored object is not changed');
});

test('scoringSummary carries all three tiers', () => {
  const s = scoringSummary(readinessScore({ httpChecks: http(['robots']) }));
  assert.deepEqual(Object.keys(s).sort(), [
    'coreEarned', 'coreMax', 'corePoints', 'futureEarned', 'futureMax', 'futurePoints', 'nowEarned', 'nowMax', 'nowPoints',
  ]);
});

test('a stored report without its checks, refused or unscored is returned as it is', () => {
  const noChecks = { site: { score: 40 }, checks: [] };
  assert.equal(rescoreStoredReport(noChecks), noChecks);
  const blocked = { site: { score: null, blocked: 'HTTP 403' }, blocked: 'HTTP 403', checks: [] };
  assert.equal(rescoreStoredReport(blocked), blocked);
  assert.equal(rescoreStoredReport(null), null);
});

test('the PDF prints the current formula\'s score for a posted report', () => {
  const html = route._private.buildPdfHtml(rescoreStoredReport({
    site: { url: 'example.com', score: 25, level: 'x', date: 'today' },
    cats: [], checks: http(['robots', 'sitemap', 'aibots']), onPageChecks: [],
  }));
  assert.match(html, />70</);
  assert.match(html, /70 pts core access · 20 other checks you can do today · 10 emerging standards/);
});

test('the client\'s one mirror (client/src/lib/agentReadinessReport.js) scores the same', async () => {
  const path = require('node:path');
  const { pathToFileURL } = require('node:url');
  const client = await import(pathToFileURL(path.join(__dirname, '../../../client/src/lib/agentReadinessReport.js')).href);
  assert.deepEqual(client.WEIGHTS, WEIGHTS);
  assert.deepEqual(client.READINESS_TIERS, READINESS_TIERS);
  assert.equal(client.CORE_POINTS, CORE_POINTS);
  assert.equal(client.NOW_POINTS, NOW_POINTS);
  assert.equal(client.FUTURE_POINTS, FUTURE_POINTS);
  const cases = [
    { httpChecks: http(['robots', 'sitemap', 'aibots']) },
    { httpChecks: http(['mcp']), onPageChecks: [{ id: 'captcha', status: 'fail', maxScore: 8, score: 4 }] },
    { httpChecks: http(CORE_HTTP).filter((c) => tierOf(c.id) === 'core') },
    { httpChecks: http(CORE_HTTP).filter((c) => c.id !== 'linkheaders') },
    { httpChecks: [] },
  ];
  for (const input of cases) assert.deepEqual(client.readinessScore(input), readinessScore(input));
});

test('a report the page marked "not re-checked" keeps the score it was shown with', () => {
  const shown = {
    site: { score: 22 },
    checks: http(['robots']).map((c) => (c.id === 'aibots' ? { ...c, status: 'info', olderRule: true } : c)),
  };
  assert.equal(rescoreStoredReport(shown), shown);
});
