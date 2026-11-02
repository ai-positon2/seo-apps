// ── What the assistant is given to answer from ──────────────────────────────
//
// The readers are faked: what is under test is which data reaches the prompt,
// how it is cut down, and that one failed reader does not fail the answer.
//
// Run: node --test modules/reportChat/__tests__/context.test.js

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { buildChatContext, sanitizeScreenCopy, scoreOnScreen, techPointsByRule, withScorePoints, allowedLinks, compact, MAX_ARRAY_ITEMS } = require('../context');
const { buildMessages, buildContextMessage } = require('../prompt');

const access = { project: { id: 'p-1', name: 'Acme', url: 'https://acme.example' } };

const MODULES = [
  { key: 'technical', label: 'Tech Audit', status: 'completed', scored: true, score: 77, runId: 'run-7', toolPath: '/crawl-scope', headline: '12 errors' },
  { key: 'seo_geo', label: 'SEO & GEO', status: 'not_run', scored: false, score: null, toolPath: '/seo-geo-audit' },
];

function fakeDeps(over = {}) {
  const calls = { moduleDetail: [] };
  return {
    calls,
    deps: {
      buildOverview: async () => ({ modules: MODULES, composite: { score: 77 } }),
      buildInsights: async () => ({
        backlog: {
          actions: Array.from({ length: 30 }, (_, i) => ({ title: `Fix ${i}`, moduleLabel: 'Tech Audit', severity: 'error', pageCount: 30 - i, pages: [] })),
          ranking: { basis: 'Errors first' },
          totals: { actions: 30 },
        },
      }),
      buildExecutiveSummary: () => ({ verdict: { line: 'Needs work' }, standing: { score: 77 } }),
      buildModuleDetail: async (_a, key) => { calls.moduleDetail.push(key); return { findings: [{ title: 'Broken links', pages: 12 }] }; },
      ...over,
    },
  };
}

const sectionNames = (ctx) => ctx.sections.map(([name]) => name);

test('a report screen gets its module detail and its explainers', async () => {
  const { deps, calls } = fakeDeps();
  const ctx = await buildChatContext({
    access,
    screen: 'tech',
    screenCopy: { explainers: [{ key: 't_health', t: 'Site health', calc: 'Every page starts at 100…' }] },
    deps,
  });
  assert.equal(ctx.screenName, 'Tech Audit');
  assert.deepEqual(calls.moduleDetail, ['technical']);
  assert.deepEqual(sectionNames(ctx), ['PROJECT', 'MODULES', 'EXECUTIVE_SUMMARY', 'FIXES_RANKED', 'SCORING_METHOD', 'REPORT_ON_SCREEN_DATA', 'REPORT_ON_SCREEN_EXPLAINERS']);
  assert.match(ctx.sections.find(([n]) => n === 'SCORING_METHOD')[1], /error 40, warning 10, notice 2/);
  const copy = ctx.sections.find(([n]) => n === 'REPORT_ON_SCREEN_EXPLAINERS')[1];
  assert.match(copy, /Every page starts at 100/);
});

test('any other page is project-level only', async () => {
  const { deps, calls } = fakeDeps();
  const ctx = await buildChatContext({ access, screen: 'keyword-research', screenCopy: { explainers: [{ t: 'x' }] }, deps });
  assert.equal(ctx.screen, null);
  assert.deepEqual(calls.moduleDetail, []);
  assert.ok(!sectionNames(ctx).includes('REPORT_ON_SCREEN_EXPLAINERS'), 'copy for an unknown screen is ignored');
  assert.match(buildContextMessage(ctx), /cannot read this page/);
});

test('the overview screen has no module of its own', async () => {
  const { deps, calls } = fakeDeps();
  const ctx = await buildChatContext({ access, screen: 'overview', deps });
  assert.equal(ctx.screenName, 'Overview');
  assert.deepEqual(calls.moduleDetail, []);
});

test('the fix list is cut to the top 20 and says how many more there are', async () => {
  const { deps } = fakeDeps();
  const ctx = await buildChatContext({ access, deps });
  const fixes = JSON.parse(ctx.sections.find(([n]) => n === 'FIXES_RANKED')[1]);
  assert.equal(fixes.moreNotShown, 10);
  assert.equal(fixes.top[0].title, 'Fix 0');
  // compact() then cuts the 20 to its own array limit, and says so.
  assert.equal(fixes.top.length, MAX_ARRAY_ITEMS + 1);
  assert.match(fixes.top.at(-1), /8 more/);
});

test('a failed reader is named, not fatal', async () => {
  const { deps } = fakeDeps({ buildInsights: async () => { throw new Error('db down'); } });
  const ctx = await buildChatContext({ access, screen: 'tech', deps });
  assert.deepEqual(ctx.missing, ['fix list']);
  assert.ok(!sectionNames(ctx).includes('FIXES_RANKED'));
  assert.ok(!sectionNames(ctx).includes('EXECUTIVE_SUMMARY'), 'the summary needs the fix list');
  assert.match(buildContextMessage(ctx), /UNAVAILABLE_RIGHT_NOW: fix list/);
});

test('links come from real routes only', () => {
  const links = allowedLinks(MODULES);
  const paths = links.map((l) => l.path);
  assert.ok(paths.includes('/crawl-scope/runs/run-7'));
  assert.ok(paths.includes('/seo-geo-audit'));
  assert.ok(paths.includes('/market-potential'));
  assert.equal(new Set(paths).size, paths.length, 'no duplicates');
  assert.ok(paths.every((p) => p.startsWith('/')));
});

test('screen copy is reduced to bounded plain strings', () => {
  const long = 'x'.repeat(5000);
  const out = sanitizeScreenCopy({
    explainers: [
      { key: 'a', t: 'Score', calc: long, next: { label: 'Open it', screen: 'tech' }, evil: () => 1 },
      { s: 'no title, dropped' },
      'not an object',
    ],
    legend: [{ term: 'Band', line: 'green is good' }, { line: 'no term' }],
  });
  assert.equal(out.explainers.length, 1);
  assert.equal(out.explainers[0].calc.length, 1500);
  assert.equal(out.explainers[0].next, 'Open it');
  assert.ok(!('evil' in out.explainers[0]));
  assert.equal(out.legend.length, 1);
  assert.equal(sanitizeScreenCopy({ explainers: [] }), null);
  assert.equal(sanitizeScreenCopy('nope'), null);
});

test('compact trims long strings and deep objects', () => {
  const deep = { a: { b: { c: { d: { e: { f: { g: 1 } } } } } } };
  assert.equal(compact(deep).a.b.c.d.e.f, '[…]');
  assert.equal(compact('y'.repeat(1000)).length, 401);
  assert.deepEqual(compact({ capabilities: { x: 1 }, keep: 2 }), { keep: 2 });
});

test('messages: rules, then data, then history, then the question', async () => {
  const { deps } = fakeDeps();
  const ctx = await buildChatContext({ access, screen: 'tech', deps });
  const msgs = buildMessages(ctx, [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }], 'How is it calculated?');
  assert.deepEqual(msgs.map((m) => m.role), ['system', 'system', 'user', 'assistant', 'user', 'system']);
  assert.match(msgs[0].content, /TWO KINDS OF STATEMENT/);
  assert.match(msgs[0].content, /\[\[P2_EXPERT\]\]/);
  assert.match(msgs[1].content, /CURRENT_SCREEN: Tech Audit report/);
  assert.match(msgs[1].content, /<ALLOWED_LINKS>[\s\S]*\(\/crawl-scope\/runs\/run-7\)/);
  assert.equal(msgs.at(-2).content, 'How is it calculated?');
  assert.match(msgs.at(-1).content, /Before you answer[\s\S]*\[\[P2_EXPERT\]\]/);
});

test('the score on screen is named, and a different dashboard figure explained', () => {
  assert.equal(scoreOnScreen('agent', { score: 42 }, { score: 42 }), 'This Agent Readiness report shows 42. "Our score" / "the score" on this screen means 42.');
  assert.match(scoreOnScreen('agent', { score: 42 }, { score: 41 }), /shows 41: the average over all audited scans, while 42 is the scan open here/);
  assert.match(scoreOnScreen('tech', { score: 65 }, { score: 64 }), /card for this module shows 64[\s\S]*Quote 65/);
  assert.match(scoreOnScreen('seogeo', { overall: 84 }, { score: 75 }), /shows 75: the average over all audited pages, while 84 is the page open here/);
  assert.equal(scoreOnScreen(null, { score: 1 }, null), null);
  assert.equal(scoreOnScreen('hub', { averageHealth: 70 }, { score: 70 }), null);
});

test('Tech Audit fix-list items carry what they cost the health score', () => {
  const points = techPointsByRule('tech', { rules: [{ rule: 'Broken internal links', points: 3.52 }, { rule: 'Pages returning 4XX errors', points: 0 }] });
  const action = (title) => ({ title, moduleLabel: 'Tech Audit' });
  assert.equal(withScorePoints({ title: 'x' }, action('Pages returning 4XX errors'), points).pointsLostOnTechScore, 0);
  assert.equal(withScorePoints({ title: 'x' }, action('broken internal links'), points).pointsLostOnTechScore, 3.52);
  assert.equal(withScorePoints({ title: 'x' }, { title: 'Broken internal links', moduleLabel: 'SEO & GEO' }, points).pointsLostOnTechScore, undefined);
  assert.equal(techPointsByRule('seogeo', { rules: [] }), null);
});
