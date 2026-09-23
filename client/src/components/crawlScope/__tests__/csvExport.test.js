// ── The URL export's Click depth column ─────────────────────────────────────
//
// Run: npm test --prefix client
//
// The export's "Crawl depth" was the order the crawler found a page in; with
// every sitemap URL queued at depth 1 it read "1" for most of a site. A
// finished crawl now carries clickDepth — the fewest links from the start page
// — and null for a page no link reaches.

import { test } from 'node:test';
import assert from 'node:assert';

import { toCsv } from '../crawlHelpers.js';

const cellsOf = (csv) => {
  const [header, ...rows] = csv.split('\r\n');
  const columns = header.split(',');
  return rows.map((row) => Object.fromEntries(row.split(',').map((cell, i) => [columns[i], cell])));
};

test('the export reports click depth, and says when no link reaches a page', () => {
  const rows = cellsOf(toCsv([
    { url: 'https://example.com/deep', depth: 1, clickDepth: 4 },
    { url: 'https://example.com/orphan', depth: 1, clickDepth: null },
    // A crawl analysed before click depth existed keeps its crawl depth.
    { url: 'https://example.com/old-run', depth: 2 },
  ]));
  assert.deepStrictEqual(rows.map((r) => r['Click depth']), ['4', 'not linked', '2']);
});
