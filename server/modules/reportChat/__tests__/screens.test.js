// ── The server's screen maps match the client's ─────────────────────────────
//
// screens.js copies three maps from the client (it cannot import ES modules).
// This imports the client originals and fails on any disagreement, so a screen
// renamed or a report route moved on one side cannot silently break the other.
//
// Run: node --test modules/reportChat/__tests__/screens.test.js

const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const screens = require('../screens');

const CLIENT = path.join(__dirname, '../../../../client/src');
const load = (rel) => import(pathToFileURL(path.join(CLIENT, rel)).href);

test('SCREENS and MODULE_SCREEN match explainScreens.js', async () => {
  const client = await load('components/explain/explainScreens.js');
  assert.deepEqual(screens.SCREENS, client.SCREENS);
  assert.deepEqual(screens.MODULE_SCREEN, client.MODULE_SCREEN);
});

test('every screen goes to the same tool page as the client', async () => {
  const client = await load('components/explain/explainScreens.js');
  for (const screen of Object.keys(screens.SCREENS)) {
    assert.equal(screens.TOOL_PATH[screen], client.nextRoute(screen, {}), screen);
  }
});

test('report paths match moduleReportRoute for every kind of card', async () => {
  const { moduleReportRoute } = await load('lib/moduleReportRoute.js');
  const cards = [
    { key: 'technical', runId: 'run-1', toolPath: '/crawl-scope' },
    { key: 'technical', toolPath: '/crawl-scope' },
    { key: 'hub_spoke', reportRef: 'proj_9', toolPath: '/content-architect' },
    { key: 'competitor', reportRef: 'c-3', toolPath: '/competitor-analysis' },
    { key: 'seo_geo', reportRef: 'r-4', toolPath: '/seo-geo-audit', evidence: {} },
    { key: 'agent_readiness', toolPath: '/agent-readiness-audit' },
  ];
  for (const card of cards) {
    assert.equal(screens.moduleReportPath(card), moduleReportRoute(card).path, JSON.stringify(card));
  }
});

test('isScreen accepts only known screens', () => {
  assert.equal(screens.isScreen('tech'), true);
  assert.equal(screens.isScreen('keyword'), false);
  assert.equal(screens.isScreen('__proto__'), false);
  assert.equal(screens.isScreen(null), false);
});
