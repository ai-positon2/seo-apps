// ── The report assistant's pure helpers ─────────────────────────────────────
//
// What the panel sends about a screen, the questions it suggests, how it reads
// the answer stream, and — the one that matters most — that an answer can only
// ever link inside the app.
//
// Run: node --test src/components/chat/__tests__/chatModel.test.js

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildScreenCopy, starterQuestions, isSafeAppPath, parseInline, parseBlocks, createSseParser,
} from '../chatModel.js';
import { EXPLAINER_KEYS_BY_SCREEN, resolveExplainer } from '../../explain/explainCopy.js';

test('screen copy is the info icons’ own text, for every key on the screen', () => {
  const ctx = { modules: [] };
  const copy = buildScreenCopy('tech', ctx);
  assert.equal(copy.explainers.length, EXPLAINER_KEYS_BY_SCREEN.tech.length);
  assert.deepEqual(copy.explainers[0], resolveExplainer(EXPLAINER_KEYS_BY_SCREEN.tech[0], ctx));
  assert.ok(Array.isArray(copy.legend));
});

test('every explainer screen builds without figures', () => {
  for (const screen of Object.keys(EXPLAINER_KEYS_BY_SCREEN)) {
    const copy = buildScreenCopy(screen, null);
    assert.ok(copy.explainers.length > 0, screen);
    assert.ok(copy.explainers.every((e) => e.t && typeof e.calc === 'string'), screen);
  }
});

test('a page with no explainers sends no copy', () => {
  assert.equal(buildScreenCopy('keyword-research', {}), null);
  assert.equal(buildScreenCopy(null, {}), null);
});

test('starter questions are worded for the screen', () => {
  const tech = starterQuestions('tech');
  assert.equal(tech.length, 4);
  assert.match(tech[3], /SEO/, "the fourth is a general SEO question");
  assert.equal(tech[0], 'How is the site health score calculated?');
  for (const screen of Object.keys(EXPLAINER_KEYS_BY_SCREEN)) {
    assert.equal(starterQuestions(screen).length, 4, screen);
    // The wording explainer titles produced when dropped into a sentence.
    assert.ok(!/^How is the (where you stand|topic clusters|ai) /.test(starterQuestions(screen)[0]), screen);
  }
  assert.match(starterQuestions('overview')[0], /overall score/);
  assert.match(starterQuestions(null)[0], /overall state of this project/);
});

test('only paths inside the app are links', () => {
  for (const ok of ['/', '/crawl-scope/runs/abc', '/competitor-analysis?client=x', '/market-potential', '/seo-geo-audit']) {
    assert.equal(isSafeAppPath(ok), true, ok);
  }
  for (const bad of [
    'https://evil.example', '//evil.example/x', 'javascript:alert(1)', '/\\evil.example',
    '/admin', '/not-a-section', 'crawl-scope', '', null,
  ]) {
    assert.equal(isSafeAppPath(bad), false, String(bad));
  }
});

test('inline markdown: bold and links, everything else as text', () => {
  const toks = parseInline('Score **77** — see [Tech Audit](/crawl-scope) or [this](https://evil.example).');
  assert.deepEqual(toks.map((t) => t.type), ['text', 'bold', 'text', 'link', 'text', 'link', 'text']);
  assert.equal(toks[1].text, '77');
  assert.deepEqual(toks[3], { type: 'link', text: 'Tech Audit', path: '/crawl-scope', safe: true });
  assert.equal(toks[5].safe, false);
  assert.deepEqual(parseInline('<img src=x onerror=alert(1)>'), [{ type: 'text', text: '<img src=x onerror=alert(1)>' }]);
});

test('an app link labelled as an outside page is not a link', () => {
  assert.equal(parseInline('[Redirects and Google Search](/)')[0].safe, false);
  assert.equal(parseInline('[Google Search Central — Redirects](/)')[0].safe, false);
  assert.equal(parseInline('[moz.com guide](/crawl-scope)')[0].safe, false);
  assert.equal(parseInline('[Project overview](/)')[0].safe, true);
  assert.equal(parseInline('[Hub and Spoke report](/content-architect/p1)')[0].safe, true);
});

test('blocks: paragraphs and lists', () => {
  const blocks = parseBlocks('Your score is 77.\nIt lost 23 points.\n\n- Fix 12 broken links\n- Add titles\n  to 4 pages\n\n1. First\n2. Second\nDone.');
  assert.deepEqual(blocks, [
    { type: 'p', text: 'Your score is 77. It lost 23 points.' },
    { type: 'ul', items: ['Fix 12 broken links', 'Add titles to 4 pages'] },
    { type: 'ol', items: ['First', 'Second'] },
    { type: 'p', text: 'Done.' },
  ]);
  assert.deepEqual(parseBlocks(''), []);
});

test('the stream parser copes with events split across pieces', () => {
  const seen = [];
  const feed = createSseParser((event, data) => seen.push([event, data]));
  feed('event: start\ndata: {"userMessage":{"id":"m1"}}\n\nevent: del');
  feed('ta\ndata: {"text":"Your "}\n\n');
  feed('event: delta\ndata: {"text":"score"}\n\nevent: done\ndata: {"message":{"id":"m2"}}\n\n');
  feed('event: broken\ndata: {not json\n\n');
  assert.deepEqual(seen, [
    ['start', { userMessage: { id: 'm1' } }],
    ['delta', { text: 'Your ' }],
    ['delta', { text: 'score' }],
    ['done', { message: { id: 'm2' } }],
  ]);
});
