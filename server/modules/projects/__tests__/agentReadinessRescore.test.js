// ── Stored Agent Readiness runs are re-scored on read ────────────────────────
//
// The overall score changed formula (v5: 70 points for core access, 20 for the
// other checks a site can do today, 10 for emerging standards). Runs stored before that keep their old score,
// so the dashboard works the new one out from each page's stored checks rather
// than paying to re-run the audits.
//
// Run: node --test modules/projects/__tests__/agentReadinessRescore.test.js

const assert = require('node:assert/strict');
const { test } = require('node:test');

const db = require('../../../services/db');
const moduleEvidence = require('../moduleEvidence');
const agentScore = require('../../../checks/agentReadinessScore');

const { rescoreAgentRuns, rescoreAgentPageRow, rescoreAgentPayload, agentPageScore } = moduleEvidence;

const IDS = Object.keys(agentScore.WEIGHTS);
const checksPassing = (passing) => IDS.map((id) => ({
  id, status: passing.includes(id) ? 'pass' : (id === 'webbotauth' ? 'info' : 'fail'),
  effort: ['robots', 'linkheaders', 'aibots', 'contentsignals'].includes(id) ? 'quick' : 'medium',
}));
const V2 = 'the agent readiness audit v2 (weighted HTTP plus on-page checks; agent-relevant Link headers, '
  + 'allow-all robots counts for AI bots, WebMCP detected in the page, no SearchAction)';

// robots, sitemap and AI bots pass: 25 under the old formula, 70 under the new
// (70 × 25 ÷ 25).
const pagePayload = () => ({
  native: {
    site: { url: 'example.com', score: 25, level: 'Level 0 — Not started', httpScore: 25, onPageMax: 0 },
    cats: [{ id: 'Discoverability', score: 70, passed: 2, total: 3 }],
    checks: checksPassing(['robots', 'sitemap', 'aibots']),
    onPageChecks: [],
  },
  site: { url: 'example.com', score: 25 },
  cats: [],
});

function withDb(t, handler) {
  t.mock.method(db, 'isDatabaseConfigured', () => true);
  const calls = [];
  t.mock.method(db, 'rows', async (sql, params) => { calls.push({ sql, params }); return handler(sql, params); });
  return calls;
}

test('a stored page report: score, level and payload in the new formula, categories untouched', () => {
  const row = { id: 'p1', module_key: 'agent_readiness', score: 25, band: 'Level 0 — Not started', payload: pagePayload() };
  const out = rescoreAgentPageRow(row);
  assert.equal(out.score, 70);
  assert.equal(out.payload.native.site.score, 70);
  assert.equal(out.payload.site.score, 70, 'the copy of site beside native follows');
  assert.equal(out.band, agentScore.levelFromScore(70));
  assert.deepEqual(out.payload.native.cats, row.payload.native.cats);
  assert.equal(row.score, 25, 'the stored row is not changed');
});

test('a page whose report lacks its checks keeps its stored score', () => {
  const truncated = { id: 'p2', module_key: 'agent_readiness', score: 41, band: 'Level 1 — Early steps', payload: { _truncated: true } };
  assert.equal(rescoreAgentPageRow(truncated).score, 41);
  assert.deepEqual(agentPageScore(41, null), { score: 41, rescored: false });
  assert.deepEqual(agentPageScore(null, { checks: checksPassing([]) }), { score: null, rescored: false }, 'an unscored page stays unscored');
  assert.equal(rescoreAgentPayload({ native: { site: { score: null }, blocked: 'HTTP 403', checks: [] } }).native.site.score, null);
});

test('other modules are left alone', () => {
  const seo = { id: 'x', module_key: 'seo_geo', score: 25, payload: pagePayload() };
  assert.equal(rescoreAgentPageRow(seo), seo);
});

test('a run\'s mean is worked out again from its pages\' stored checks', async (t) => {
  const pageChecks = (passing) => ({ checks: checksPassing(passing), onPageChecks: null, blocked: null });
  const calls = withDb(t, (sql) => {
    assert.match(sql, /from project_module_page_runs/);
    return [
      { run_id: 'r1', id: 'p1', status: 'completed', score: 25, storedChecks: pageChecks(['robots', 'sitemap', 'aibots']) }, // → 70
      { run_id: 'r1', id: 'p2', status: 'completed', score: 32, storedChecks: pageChecks(['robots', 'sitemap', 'aibots', 'mcp']) }, // → 71 (70 + 10 × 10 ÷ 69)
      { run_id: 'r1', id: 'p3', status: 'failed', score: null, storedChecks: null },
    ];
  });
  const run = {
    id: 'r1', module_key: 'agent_readiness', status: 'completed', score: 29,
    score_basis: `Mean of 2 page score(s) from ${V2}; 1 page not scored (an error page, a refused request or a failed audit)`,
    band: '2 of 3 pages scored',
    payload: { pages: [{ pageRunId: 'p1', score: 25, band: 'Level 0 — Not started' }, { pageRunId: 'p2', score: 32 }, { pageRunId: 'p3', score: null }] },
  };
  const [out] = await rescoreAgentRuns([run]);
  assert.equal(calls.length, 1, 'one query for every page of every run');
  assert.equal(out.score, 71); // mean of 70 and 71 = 70.5
  assert.match(out.score_basis, /^Mean of 2 page score\(s\) from the agent readiness audit v5/);
  assert.match(out.score_basis, /1 page not scored/);
  assert.deepEqual(out.payload.pages.map((p) => p.score), [70, 71, null]);
  assert.equal(out.payload.pages[0].band, agentScore.levelFromScore(70));
  assert.equal(run.score, 29, 'the stored row is not changed');
});

test('a run already on the current formula is not read again', async (t) => {
  const calls = withDb(t, () => []);
  const current = { id: 'r2', module_key: 'agent_readiness', score: 30, score_basis: `Mean of 1 page score(s) from ${agentScore.SCORE_BASIS}` };
  const other = { id: 'r3', module_key: 'seo_geo', score: 70, score_basis: 'x' };
  const out = await rescoreAgentRuns([current, other]);
  assert.equal(calls.length, 0);
  assert.equal(out[0], current);
  assert.equal(out[1], other);
});

test('a run with a page it cannot re-score keeps the old basis, so it reads as a method change', async (t) => {
  withDb(t, () => [
    { run_id: 'r4', id: 'p1', status: 'completed', score: 25, storedChecks: { checks: checksPassing(['robots', 'sitemap', 'aibots']) } },
    { run_id: 'r4', id: 'p2', status: 'completed', score: 40, storedChecks: null },
  ]);
  const run = { id: 'r4', module_key: 'agent_readiness', score: 33, score_basis: `Mean of 2 page score(s) from ${V2}` };
  const [out] = await rescoreAgentRuns([run]);
  assert.equal(out.score, 55); // mean of 70 (re-scored) and 40 (kept)
  assert.equal(out.score_basis, run.score_basis);
});

test('a single-page run is re-scored from the report on the run row', async (t) => {
  withDb(t, (sql) => (/from project_module_page_runs/.test(sql)
    ? []
    : [{ id: 'r5', storedChecks: { checks: checksPassing(['robots', 'sitemap', 'aibots']) } }]));
  const run = { id: 'r5', module_key: 'agent_readiness', score: 25, score_basis: V2, band: 'Level 0 — Not started' };
  const [out] = await rescoreAgentRuns([run]);
  assert.equal(out.score, 70);
  assert.equal(out.score_basis, agentScore.SCORE_BASIS);
});

test('a run stored under the v4 (90/10) basis is re-scored too', async (t) => {
  withDb(t, (sql) => (/from project_module_page_runs/.test(sql)
    ? []
    : [{ id: 'r7', storedChecks: { checks: checksPassing(['robots', 'sitemap', 'aibots']) } }]));
  const V4 = 'the agent readiness audit v4 (90 points for checks any site can ship today — robots.txt, sitemap, '
    + 'Link headers, AI bot rules, on-page checks — 10 for emerging standards)';
  const run = { id: 'r7', module_key: 'agent_readiness', score: 73, score_basis: V4 };
  const [out] = await rescoreAgentRuns([run]);
  assert.equal(out.score, 70);
  assert.equal(out.score_basis, agentScore.SCORE_BASIS);
});

test('a failed read shows the rows as stored', async (t) => {
  t.mock.method(db, 'isDatabaseConfigured', () => true);
  t.mock.method(db, 'rows', async () => { throw new Error('boom'); });
  t.mock.method(console, 'error', () => {});
  const run = { id: 'r6', module_key: 'agent_readiness', score: 25, score_basis: V2 };
  const [out] = await rescoreAgentRuns([run]);
  assert.equal(out, run);
});

test('the per-page list re-scores each Agent Readiness page from its projected checks', async (t) => {
  const calls = withDb(t, (sql, params) => {
    if (/"storedChecks"/.test(sql)) {
      assert.deepEqual(params, [['p1']], 'only the scored Agent Readiness pages are read again');
      return [{ id: 'p1', storedChecks: { checks: checksPassing(['robots', 'sitemap', 'aibots']) } }];
    }
    return [
      { id: 'p1', module_key: 'agent_readiness', score: 25, band: 'Level 0 — Not started' },
      { id: 'p2', module_key: 'seo_geo', score: 70, band: 'Good' },
    ];
  });
  const pages = await moduleEvidence.pageRunsForRun('r1');
  assert.equal(calls.length, 2);
  assert.equal(pages[0].score, 70);
  assert.equal(pages[0].band, agentScore.levelFromScore(70));
  assert.equal(pages[1].score, 70);
  assert.ok(!('storedChecks' in pages[0]), 'the projected checks are not passed on');
});

test('a failed read of the stored checks leaves the page list as stored', async (t) => {
  t.mock.method(console, 'error', () => {});
  withDb(t, (sql) => {
    if (/"storedChecks"/.test(sql)) throw new Error('unsupported');
    return [{ id: 'p1', module_key: 'agent_readiness', score: 25, band: 'Level 0 — Not started' }];
  });
  const [page] = await moduleEvidence.pageRunsForRun('r1');
  assert.equal(page.score, 25);
});

test('both run scores paths store the v5 basis', () => {
  const moduleRunners = require('../moduleRunners');
  const streaming = require('../streamingAudit');
  assert.equal(moduleRunners.SCORE_BASIS.agent_readiness, agentScore.SCORE_BASIS);
  assert.equal(streaming.SCORE_BASIS.agent_readiness, agentScore.SCORE_BASIS);
  assert.ok(agentScore.SCORE_BASIS.includes(agentScore.SCORE_BASIS_MARK));
  assert.equal(agentScore.SCORE_BASIS_MARK, 'agent readiness audit v5');
});
