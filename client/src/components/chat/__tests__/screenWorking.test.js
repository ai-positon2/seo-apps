// ── Each report's working, for the report assistant ─────────────────────────
//
// The Tech Audit working is built from the scorer's own output, so the rules
// the assistant lists must add up to the bars on screen.
//
// Run: node --test src/components/chat/__tests__/screenWorking.test.js

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { techWorking, agentWorking, compWorking, aivisLiteWorking, aivisWorking, hubWorking } from '../screenWorking.js';

// The shape server/modules/aiVisibility/metrics/format.js metric() returns.
const m = (value, display) => ({ value, display, delta: null, deltaDisplay: null, direction: 'higher_is_better' });
import { healthMetrics, healthScoreBreakdown } from '../../crawlScope/crawlHelpers.js';

const page = (i, issues) => ({ url: `https://example.com/${i}`, scope: 'Internal', contentType: 'text/html', issues });

test('Tech Audit: rules add up to each bar\'s exact loss, with their labels', () => {
  const pages = [
    page(0, [{ id: 'redir', severity: 'warning' }, { id: 'title-long', severity: 'warning' }]),
    page(1, [{ id: 'redir', severity: 'warning' }, { id: 'broken', severity: 'error' }]),
    page(2, []),
    page(3, [{ id: 'alt', severity: 'notice' }]),
  ];
  const metrics = healthMetrics(pages, []);
  const breakdown = healthScoreBreakdown(metrics);
  const groups = [{ id: 'redir', label: 'Links to redirected pages', count: 2 }];
  const w = techWorking({ metrics, breakdown, groups });

  assert.equal(w.pagesScored, 4);
  assert.equal(w.rules.find((r) => r.ruleId === 'redir').rule, 'Links to redirected pages');
  assert.equal(w.rules.find((r) => r.ruleId === 'redir').points, 5); // 10 × 2 ÷ 4
  for (const band of w.bands) {
    const sum = w.rules.filter((r) => r.severity === band.severity).reduce((s, r) => s + r.points, 0);
    assert.ok(Math.abs(sum - band.exactPoints) < 1e-9, band.severity);
  }
  assert.equal(w.bands.reduce((s, b) => s + b.barShows, 0), 100 - metrics.health);
});

test('Tech Audit: a rule listed only on unscored URLs is in the working at 0 points', () => {
  const metrics = healthMetrics([page(0, [{ id: 'redir', severity: 'warning' }]), page(1, [])], []);
  const groups = [
    { id: 'redir', label: 'Links to redirected pages', severity: 'warning', urls: ['https://example.com/0'] },
    // Found on redirect URLs only, which the score leaves out.
    { id: 'chain', label: 'Redirect chain', severity: 'warning', urls: ['https://example.com/r1', 'https://example.com/r2'] },
  ];
  const w = techWorking({ metrics, breakdown: healthScoreBreakdown(metrics), groups });
  const chain = w.rules.find((r) => r.ruleId === 'chain');
  assert.deepEqual(
    { points: chain.points, pagesAffected: chain.pagesAffected, urlsListedInReport: chain.urlsListedInReport, rule: chain.rule },
    { points: 0, pagesAffected: 0, urlsListedInReport: 2, rule: 'Redirect chain' },
  );
  assert.equal(w.rules.length, 2);
});

test('AI Visibility: rates go as the report prints them, counts as numbers', () => {
  // Shapes as aiVisibilityLite/report.js builds them (brandRows, questionTable).
  const w = aivisLiteWorking({
    headline: { score: m(41, '41'), scoreBreakdown: [{ key: 'named', weight: 40, included: true, value: 32 }] },
    meta: { answersMeasured: 120 },
    brands: [{ name: 'Acme', isClient: true, answers: 120, named: 38, namedRate: m(0.3167, '32%'), shareOfMentions: m(0.21, '21%'), mentionRank: m(2.1, '#2.1') }],
    byQuestion: [{ promptId: 'q1', text: 'best GRC software', intent: 'commercial', state: 'named', answers: 3, measured: 3, named: 1, namedRate: m(0.33, '33%') }],
  });
  assert.equal(w.score, 41);
  assert.equal(w.brands[0].namedRate, '32%');
  assert.equal(w.brands[0].answersNamingIt, 38);
  assert.equal(w.brands[0].averageMentionPosition, 2.1);
  assert.deepEqual(w.byQuestion[0], { question: 'best GRC software', intent: 'commercial', state: 'named', answers: 3, measured: 3, named: 1, namedRate: '33%' });
});

test('AI Visibility (scraped): share-of-voice rows keep the brand, count and share', () => {
  // Shapes as aiVisibility/metrics/reports.js builds them (kpis, insights).
  const w = aivisWorking({
    kpis: { visibility: m(0.42, '42.0%'), shareOfVoice: m(0.18, '18.0%'), position: m(2.4, '#2.4'), sentiment: { ...m(61, '61'), note: 'Scored on 40 of 44 mentions' }, engines: [{ engine: 'chatgpt', measured: 30, ...m(0.5, '50.0%') }] },
    meta: { captures: 90 },
    shareOfVoice: { totalMentions: 200, otherMentions: 12, rows: [{ brandId: 'b1', name: 'Acme', isClient: true, mentions: m(36, '36'), ...m(0.18, '18.0%') }] },
  });
  assert.equal(w.visibility, '42.0%');
  assert.deepEqual(w.shareOfVoiceRows[0], { brand: 'Acme', you: true, mentions: 36, share: '18.0%' });
  assert.deepEqual(w.engines[0], { engine: 'chatgpt', measured: 30, visibility: '50.0%' });
  assert.equal(w.sentiment.note, 'Scored on 40 of 44 mentions');
});

test('Hub and Spoke: members, depth and flags per cluster', () => {
  // Pages and clusters as contentArchitect/fullAnalysis.js stores them (flags are type strings).
  const pageById = new Map([
    ['p1', { id: 'p1', url: 'https://x.com/whitening', depth: 1, flags: [] }],
    ['p2', { id: 'p2', url: 'https://x.com/a', depth: 3, flags: ['orphan', 'thin-or-stale'] }],
    ['p3', { id: 'p3', url: 'https://x.com/b', depth: null, flags: ['buried'] }],
  ]);
  const w = hubWorking({ pageById, clusters: [{ name: 'Whitening', health: 62, isGap: false, ambiguous: false, hubPageId: 'p1', spokeIds: ['p2', 'p3'], hubSuggestion: { reason: 'broad page' } }] });
  const c = w.clusters[0];
  assert.equal(c.members, 3);
  assert.equal(c.meanDepth, 2, 'unreachable pages are left out of the average');
  assert.deepEqual([c.orphaned, c.thin, c.buried], [1, 1, 1]);
  assert.equal(c.hubUrl, 'https://x.com/whitening');
  assert.equal(c.hubSuggestionReason, 'broad page');
});

test('nothing loaded yet means no working, not an error', () => {
  assert.equal(techWorking({ metrics: null }), null);
  assert.equal(agentWorking(null), null);
  assert.equal(compWorking({ snapshot: null }), null);
});

test('Competitor: Semrush figures are read off each domain', () => {
  const w = compWorking({ snapshot: { trafficScore: { score: 50 }, domains: [
    { domain: 'you.com', isClient: true, domainRank: { organicTraffic: '5000', organicKeywords: 120 }, authorityScore: 30, backlinks: { totalBacklinks: 900 } },
  ] } });
  assert.deepEqual(w.domains[0], { domain: 'you.com', isClient: true, traffic: 5000, keywords: 120, authority: 30, backlinks: 900 });
});
