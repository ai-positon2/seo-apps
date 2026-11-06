// ── Agent Readiness: share links, older rules, and what counts as a block ───
//
// UX-029/030: "Share summary" threw on the em dash in every level label, and an
// incomplete link blanked the app. UX-211/222: a robots.txt letting every AI
// crawler in was reported as "Blocking AI agents".
//
// Run: npm test --prefix client

import { test } from 'node:test';
import assert from 'node:assert';

import {
  encodeSharePayload, decodeSharePayload, isShareableSummary, sharePayload, sharedOlderRules,
  reconcileStoredReport, glanceGroups, isBlockingCheck, OLD_AIBOTS_FAIL, readinessScore, WEIGHTS,
} from '../agentReadinessReport.js';
import { scoreTone } from '../scoreVerdict.js';

test('a payload with an em dash, curly quotes and an arrow round-trips', () => {
  const payload = {
    level: 'Level 0 — Not started',
    brief: { headline: 'SoundHound’s “agents” → next', summary: 'ok' },
    url: 'www.soundhound.com',
  };
  const encoded = encodeSharePayload(payload);
  assert.match(encoded, /^[A-Za-z0-9_-]+$/, 'base64url: safe in a query string');
  assert.deepStrictEqual(decodeSharePayload(encoded), payload);
});

test('an ASCII link made by the old encoder still opens', () => {
  const old = btoa(JSON.stringify({ url: 'x.test', score: 40 }));
  assert.deepStrictEqual(decodeSharePayload(old), { url: 'x.test', score: 40 });
});

test('garbage decodes to null rather than throwing', () => {
  assert.strictEqual(decodeSharePayload('%%%not-base64'), null);
  assert.strictEqual(decodeSharePayload(''), null);
  assert.strictEqual(decodeSharePayload(null), null);
});

test('a link without a brief is not drawn (UX-030)', () => {
  assert.strictEqual(isShareableSummary({ url: 'www.soundhound.com', score: 40 }), false);
  assert.strictEqual(isShareableSummary({ url: 'x', brief: 'text' }), false);
  assert.strictEqual(isShareableSummary({ url: 'x', brief: {} }), false);
  assert.strictEqual(isShareableSummary({ url: 'x', brief: { headline: 'Hi' } }), true);
});

test('the share payload says where the full report lives', () => {
  const result = { cmoBrief: { headline: 'h' }, site: { url: 'x.test', full: 'https://x.test/', score: 30, level: 'L', date: 'd' } };
  const p = sharePayload(result, { projectId: 'p1', pageRunId: 'r1' });
  assert.strictEqual(p.projectId, 'p1');
  assert.strictEqual(p.pageRunId, 'r1');
  assert.ok(!('olderRules' in p));
});

const storedRun = (aibots, extra = []) => ({
  site: { score: 20, onPageMax: 0 },
  cats: [{ id: 'Bot Access', score: 0 }],
  checks: [
    { id: 'robots', cat: 'Discoverability', status: 'pass', tech: 'Valid robots.txt returned (200, text/plain)' },
    { id: 'aibots', cat: 'Bot Access', status: 'fail', tech: aibots },
    { id: 'contentsignals', cat: 'Bot Access', status: 'fail', tech: 'No Content-Signal directives in robots.txt' },
    ...extra,
  ],
});

test('a report from the old aibots rule is not shown as failing or blocking', () => {
  const out = reconcileStoredReport(storedRun(OLD_AIBOTS_FAIL,
    [{ id: 'webmcp', cat: 'API / Auth / MCP', status: 'fail', tech: 'WebMCP not detectable via HTTP' }]));
  assert.deepStrictEqual(out.olderRules, ['aibots', 'webmcp']);
  // By the current formula over these checks: core = robots 7 of (7 + 11),
  // no now checks (its 20 points go to core and future: 87.5 and 12.5),
  // future = content signals + WebMCP 0 of (9 + 6) → 34.03. Both re-read
  // checks passing → 87.5 × 18 ÷ 18 + 12.5 × 6 ÷ 15 = 92.5. Up to 58.
  assert.strictEqual(out.olderRulesPoints, 58);
  const aibots = out.checks.find((c) => c.id === 'aibots');
  assert.strictEqual(aibots.status, 'info');
  assert.strictEqual(isBlockingCheck(aibots), false);
  assert.strictEqual(out.checks.find((c) => c.id === 'webmcp').status, 'info');
});

test('the interim rule is re-read: with a readable robots.txt it was a real block', () => {
  const out = reconcileStoredReport(storedRun('No AI-specific bot rules found in robots.txt, and the general rules do not let every crawler in'));
  const aibots = out.checks.find((c) => c.id === 'aibots');
  assert.strictEqual(aibots.blocking, true);
  assert.deepStrictEqual(out.olderRules, []);
});

test('a current report is returned untouched', () => {
  const fresh = storedRun('robots.txt blocks AI crawlers: GPTBot');
  assert.strictEqual(reconcileStoredReport(fresh), fresh);
});

test('Bot Access 0 is "not yet set up" unless a crawler is actually refused', () => {
  const cats = [{ id: 'Bot Access', score: 0 }, { id: 'Discoverability', score: 100 }];
  const open = glanceGroups(cats, storedRun('No AI-specific rules, but robots.txt lets every crawler in').checks, scoreTone);
  assert.deepStrictEqual(open.blocking, []);
  assert.deepStrictEqual(open.notSetUp.map((c) => c.id), ['Bot Access']);
  assert.deepStrictEqual(open.working.map((c) => c.id), ['Discoverability']);

  const shut = glanceGroups(cats, [{ id: 'aibots', cat: 'Bot Access', status: 'fail', blocking: true, tech: 'robots.txt blocks AI crawlers: GPTBot' }], scoreTone);
  assert.deepStrictEqual(shut.blocking.map((c) => c.id), ['Bot Access']);
});

test('a share link names which checks were re-read, and old links still decode', () => {
  const result = { cmoBrief: { headline: 'h' }, site: { url: 'x.test', full: 'https://x.test/', score: 30, level: 'L', date: 'd' } };
  // Only WebMCP re-read: the shared notice must not blame the AI-bot rule.
  const onlyWebmcp = decodeSharePayload(encodeSharePayload(sharePayload(result, { olderRules: ['webmcp'] })));
  assert.deepStrictEqual(onlyWebmcp.olderRules, ['webmcp']);
  assert.deepStrictEqual(sharedOlderRules(onlyWebmcp), ['webmcp']);
  const both = sharePayload(result, { olderRules: ['aibots', 'webmcp', 'junk'] });
  assert.deepStrictEqual(both.olderRules, ['aibots', 'webmcp']);
  assert.ok(!('olderRules' in sharePayload(result, { olderRules: [] })));
  // A link copied before the list carried `olderRules: true` for either check.
  assert.deepStrictEqual(sharedOlderRules({ olderRules: true }), ['unknown']);
  assert.strictEqual(sharePayload(result, { olderRules: true }).olderRules, true);
  assert.deepStrictEqual(sharedOlderRules({}), []);
  assert.deepStrictEqual(sharedOlderRules({ olderRules: 'yes' }), []);
});

test('the score: 70 core access, 20 other checks today, 10 emerging standards', () => {
  const ids = Object.keys(WEIGHTS);
  const future = [
    'markdown', 'contentsignals', 'apicatalog', 'oauth', 'oauthresource',
    'mcp', 'agentskills', 'webmcp', 'webbotauth',
  ];
  const http = (passing) => ids.map((id) => ({ id, status: passing.includes(id) ? 'pass' : 'fail' }));
  assert.strictEqual(readinessScore({ httpChecks: http(ids.filter((id) => !future.includes(id))) }).score, 90);
  assert.strictEqual(readinessScore({ httpChecks: http(ids) }).score, 100);
  assert.strictEqual(readinessScore({ httpChecks: http([]) }).score, 0);
  // Every core check (robots, sitemap, AI bots) passing, nothing else = 70.
  assert.strictEqual(readinessScore({ httpChecks: http(['robots', 'sitemap', 'aibots']) }).score, 70);
  // Only the future checks passing = 10.
  assert.strictEqual(readinessScore({ httpChecks: http(future) }).score, 10);
  // On-page checks join the now tier with Link headers.
  const withOnPage = readinessScore({
    httpChecks: http(['robots', 'sitemap', 'aibots']),
    onPageChecks: [{ id: 'form_labels', status: 'pass', maxScore: 10, score: 10 }],
  });
  assert.strictEqual(withOnPage.score, 83); // 70 + 20 × 10 ÷ (6 + 10) = 82.5
  assert.deepStrictEqual(withOnPage.now, { earned: 10, max: 16, points: 20 });
  // No now checks at all: its 20 points go to core and future in proportion.
  const noNow = readinessScore({ httpChecks: http(['robots', 'sitemap', 'aibots']).filter((c) => c.id !== 'linkheaders') });
  assert.strictEqual(noNow.core.points, 87.5);
  assert.strictEqual(noNow.future.points, 12.5);
  assert.strictEqual(noNow.score, 88);
});
