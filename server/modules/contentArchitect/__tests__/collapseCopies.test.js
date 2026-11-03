// ── Locale copies are one page, not a topic ─────────────────────────────────
//
// 63 of Thoughtworks' 70 clusters were copies of one article across locales.
//
// Run: node --test modules/contentArchitect/__tests__/collapseCopies.test.js

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { collapseCopies, reindexLinkGraph } = require('../collapseCopies');

const page = (path, title, wordCount = 1200) => ({ url: `https://www.example.com${path}`, title, wordCount });

test('five locale copies of one article collapse to the page without a locale', () => {
  const pages = ['/en-au', '/en-gb', '/en-in', '/de', ''].map((loc) => page(`${loc}/insights/ai-value`, 'AI Value From POC to Impact'));
  const { keep, collapsed } = collapseCopies(pages);
  assert.equal(keep.length, 1);
  assert.equal(pages[keep[0]].url, 'https://www.example.com/insights/ai-value');
  assert.equal(collapsed.length, 4);
});

test('locale alternates whose titles differ only in a regional suffix are one page', () => {
  // Thoughtworks: "Insights top picks from 2021 | Thoughtworks Australia", "… Brazil", …
  const pages = ['', '/en-au', '/en-br', '/en-in'].map((loc, i) => page(
    `${loc}/insights/blog/top-picks-2021`,
    `Insights top picks from 2021 | Thoughtworks${['', ' Australia', ' Brazil', ' India'][i]}`,
  ));
  const { keep } = collapseCopies(pages);
  assert.deepEqual(keep, [0]);
});

test('pages that only share a title, with different content, are kept', () => {
  const pages = [page('/blog/pricing', 'Pricing', 400), page('/docs/pricing', 'Pricing', 3000)];
  assert.equal(collapseCopies(pages).keep.length, 2);
});

test('different titles are never collapsed', () => {
  const pages = [page('/en-au/a', 'Topic A'), page('/en-au/b', 'Topic B')];
  assert.equal(collapseCopies(pages).keep.length, 2);
});

test('links to a dropped copy count as links to the kept page', () => {
  const pages = [page('/hub', 'Hub'), page('/en-gb/x', 'X'), page('/x', 'X')];
  const { keep, collapsed } = collapseCopies(pages);
  const graph = { graph: [new Set([1]), new Set([0]), new Set()], inboundCounts: [1, 1, 0], depths: [0, 1, 2] };
  const re = reindexLinkGraph(graph, pages, keep, collapsed);
  assert.deepEqual([...re.graph[0]], [1], 'the hub now links to /x');
  assert.equal(re.inboundCounts[1], 1);
  assert.deepEqual(re.depths, [0, 2]);
});
