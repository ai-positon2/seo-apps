// ── The words behind every "i" ──────────────────────────────────────────────
//
// Run: npm test --prefix client
//
// The copy came from a design prototype written against sample data — a clinic
// called Harborview, a rival called Riverbend, "18.4K ÷ 23.9K = 77". Shipped as
// is, a real client would read another company's numbers in their own report.
// These tests hold the copy to three promises: every icon resolves to real
// sentences even when the screen has no data yet, a missing figure says "not
// measured yet" rather than 0 (PRD §16.11), and the figures that do appear are
// the screen's own.

import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  EXPLAINERS, EXPLAINER_KEYS_BY_SCREEN, LEGEND_BY_SCREEN, LEGEND_SHARED,
  resolveExplainer, resolveLegend, competitiveScoreSentence,
} from '../explainCopy.js';
import { SCREENS, screenOf, nextRoute } from '../explainScreens.js';

const FIELDS = ['t', 's', 'why', 'good', 'calc', 'src'];
const BROKEN = /undefined|NaN|null|\[object/;
// A lone 0 — what a missing number coerced to zero looks like in a sentence.
// "0–39" and "0%" are real copy and do not match.
const LONE_ZERO = /(^|[\s(])0([\s.,;)]|$)/;

const allKeys = Object.values(EXPLAINER_KEYS_BY_SCREEN).flat();

test('every icon resolves to real sentences with no data at all', () => {
  for (const key of allKeys) {
    const e = resolveExplainer(key, {});
    for (const f of FIELDS) {
      assert.ok(typeof e[f] === 'string' && e[f].trim(), `${key}.${f} is empty`);
      assert.doesNotMatch(e[f], BROKEN, `${key}.${f} printed "${e[f]}"`);
      assert.doesNotMatch(e[f], LONE_ZERO, `${key}.${f} printed a zero for missing data: "${e[f]}"`);
    }
    assert.ok(e.next && typeof e.next.label === 'string' && e.next.label.trim(), `${key}.next is empty`);
    assert.doesNotMatch(e.next.label, BROKEN, `${key}.next printed "${e.next.label}"`);
  }
});

test('an unknown key resolves to nothing rather than throwing', () => {
  assert.strictEqual(resolveExplainer('nope', {}), null);
});

test('every explainer belongs to exactly one screen, and every screen is known', () => {
  const seen = new Map();
  for (const [screen, keys] of Object.entries(EXPLAINER_KEYS_BY_SCREEN)) {
    assert.ok(SCREENS[screen], `screen ${screen} has no display name`);
    for (const k of keys) {
      assert.ok(!seen.has(k), `${k} is listed on ${seen.get(k)} and ${screen}`);
      seen.set(k, screen);
      assert.ok(EXPLAINERS[k], `${k} is listed on ${screen} but has no copy`);
    }
  }
  for (const k of Object.keys(EXPLAINERS)) {
    assert.ok(seen.has(k), `${k} has copy but sits on no screen`);
    assert.strictEqual(screenOf(k), seen.get(k));
  }
});

test('every "Open …" link points at a screen that exists', () => {
  for (const key of allKeys) {
    const { next } = resolveExplainer(key, {});
    if (next.screen) assert.ok(SCREENS[next.screen], `${key} links to unknown screen ${next.screen}`);
  }
});

test('every screen has a legend, and every legend line is a real sentence', () => {
  for (const screen of Object.keys(SCREENS)) {
    assert.ok(LEGEND_BY_SCREEN[screen]?.length, `no legend for ${screen}`);
    for (const row of resolveLegend(screen, {})) {
      assert.ok(row.term && row.line, `${screen} has an empty legend row`);
      assert.doesNotMatch(`${row.term} ${row.line} ${row.ex ?? ''}`, BROKEN);
      if (row.ex !== null) assert.doesNotMatch(row.ex, LONE_ZERO, `${screen} legend example printed a zero: "${row.ex}"`);
    }
  }
  for (const row of LEGEND_SHARED) assert.ok(row.term && row.line);
});

test('no sample client, rival or date from the prototype survives', () => {
  const src = readFileSync(fileURLToPath(new URL('../explainCopy.js', import.meta.url)), 'utf8');
  for (const sample of ['Harborview', 'Riverbend', 'Healthgrades', 'Yelp', 'Sports injuries', 'Oct 2026', '18.4K', '23.9K']) {
    assert.ok(!src.includes(sample), `sample text "${sample}" is still in the copy`);
  }
});

test('the legend says SEO & GEO bands differ, instead of claiming one scale everywhere', () => {
  const bands = LEGEND_SHARED.find((r) => r.key === 'bands');
  assert.match(bands.line, /SEO & GEO/);
  assert.doesNotMatch(bands.line, /Same on every score/);
});

// ── Live figures ────────────────────────────────────────────────────────────

const MODULES = [
  { key: 'technical', label: 'Tech Audit', scored: true, score: 82, status: 'completed' },
  { key: 'hub_spoke', label: 'Hub and Spoke', scored: false, score: null, status: 'completed', evidence: { findingCount: 9 } },
  { key: 'competitor', label: 'Competitor Research', scored: true, score: 77, status: 'completed' },
  { key: 'agent_readiness', label: 'Agent Readiness', scored: false, score: null, status: 'not_run' },
];

test('the composite shows its own arithmetic and names what it left out', () => {
  const { calc } = resolveExplainer('composite', {
    modules: MODULES, composite: { value: 80, scoredModules: 2, totalModules: 4 },
  });
  assert.match(calc, /\(82 \+ 77\) ÷ 2 = 80/);
  assert.match(calc, /Hub and Spoke reports findings rather than a score/);
  assert.match(calc, /Agent Readiness hasn’t run yet/);
});

test('a composite with nothing scored says so instead of printing a number', () => {
  const { calc } = resolveExplainer('composite', {
    modules: [MODULES[3]], composite: { value: null, scoredModules: 0, totalModules: 1 },
  });
  assert.match(calc, /Not measured yet/);
  assert.doesNotMatch(calc, /÷/);
});

test('a module card left out of the dashboard is left out of the composite sum', () => {
  const { calc } = resolveExplainer('composite', {
    modules: [...MODULES, { key: 'ai_visibility', label: 'Old AI Vis', scored: true, score: 10, card: false }],
    composite: { value: 80, scoredModules: 2, totalModules: 4 },
  });
  assert.doesNotMatch(calc, /10/);
});

test('the radar points at the lowest-scoring audit', () => {
  const { next } = resolveExplainer('radar', { modules: MODULES });
  assert.match(next.label, /Competitor Research/);
  assert.strictEqual(next.screen, 'comp');
});

test('the tech health breakdown adds up to the published score', () => {
  const { calc } = resolveExplainer('t_lost', {
    health: 82,
    breakdown: [{ label: 'Errors', points: 11 }, { label: 'Warnings', points: 5 }, { label: 'Notices', points: 2 }],
  });
  assert.match(calc, /errors 11 \+ warnings 5 \+ notices 2 = 18 points lost, so 100 − 18 = 82/);
});

test('the tech health score names the pages it averaged over', () => {
  assert.match(resolveExplainer('t_health', { htmlCount: 1284 }).calc, /1,284 HTML pages/);
});

test('agent readiness counts the checks that actually ran', () => {
  const http = resolveExplainer('a_score', { checkCount: 13, cats: ['Discoverability', 'Content', 'Bot Access', 'API / Auth / MCP'] });
  assert.match(http.calc, /13 automatic checks across 4 categories/);
  const full = resolveExplainer('a_score', { checkCount: 23, cats: ['a', 'b', 'c', 'd', 'e', 'f'] });
  assert.match(full.calc, /23 automatic checks across 6 categories/);
});

test('the competitive score shows its division, and says when it is capped', () => {
  const ratio = resolveExplainer('c_score', {
    trafficScore: { score: 77, ratio: 0.77, clientTraffic: 18400, strongestTraffic: 23900, strongestDomain: 'rival.com' },
  });
  assert.match(ratio.calc, /18\.4K ÷ 23\.9K = 77/);
  const capped = resolveExplainer('c_score', {
    trafficScore: { score: 100, ratio: 1.5, clientTraffic: 30000, strongestTraffic: 20000, strongestDomain: 'rival.com', aheadOfAll: true },
  });
  assert.match(capped.calc, /30K ÷ 20K = 150, capped at 100/);
  assert.match(resolveExplainer('c_score', { trafficScore: null }).calc, /Not measured yet/);
});

test('the competitive score card says where the client stands in one sentence', () => {
  assert.strictEqual(
    competitiveScoreSentence({ score: 77, ratio: 0.774, strongestDomain: 'rival.com' }),
    'Your search traffic is 77% of rival.com’s, the strongest competitor tracked.',
  );
  assert.strictEqual(
    competitiveScoreSentence({ score: 100, ratio: 1.4, strongestDomain: 'rival.com', aheadOfAll: true }),
    'You’re ahead of rival.com, the strongest competitor tracked.',
  );
  assert.strictEqual(
    competitiveScoreSentence({ score: 100, ratio: null, strongestDomain: 'rival.com', strongestTraffic: 0, aheadOfAll: true }),
    'Every tracked competitor shows no organic traffic, so you lead.',
  );
  assert.match(competitiveScoreSentence(null), /Not measured yet/);
});

test('the "Open …" link goes to the module card’s own report when the overview has it', () => {
  const module = { key: 'technical', runId: 'run-1', toolPath: '/crawl-scope' };
  assert.strictEqual(nextRoute('tech', { modules: [module] }), '/crawl-scope/runs/run-1');
  assert.strictEqual(nextRoute('tech', { module }), '/crawl-scope/runs/run-1');
  assert.strictEqual(nextRoute('tech', {}), '/crawl-scope');
  assert.strictEqual(nextRoute('aivisLite', {}), '/ai-visibility-lite');
});
