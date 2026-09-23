// ── What a finding tells you to do, beyond the rule's own text ──────────────
//
// Run: npm test --prefix client
//
// The analyzer writes page-specific advice onto findings — a suggested title
// or meta description (recommendedValue), and for some rules a recommendation
// built from this page's evidence (the sitemap fix naming the canonical URL,
// the robots.txt line naming the real domain). The report UI showed only the
// catalog's one-size text, so that advice reached the Excel export and nothing
// else.

import { test } from 'node:test';
import assert from 'node:assert';

import { findingFix, pageIssueCards } from '../crawlHelpers.js';

const entry = { id: 'title-long', title: 'Titles are too long', recommendation: 'Rewrite titles to 50-60 characters.' };

test('a suggested value is surfaced as the suggestion', () => {
  const fix = findingFix({ ruleId: 'title-long', recommendedValue: 'Shorter title', recommendation: entry.recommendation }, entry);
  assert.equal(fix.suggestion, 'Shorter title');
  assert.equal(fix.fix, null, 'the catalog text is not repeated as if it were page-specific');
});

test('a finding-specific recommendation is surfaced; the catalog default is not', () => {
  const sitemapEntry = { recommendation: 'Keep only indexable, canonical URLs.' };
  const own = 'Replace this sitemap entry with its canonical URL: https://example.com/a.';
  assert.equal(findingFix({ recommendation: own }, sitemapEntry).fix, own);
  assert.equal(findingFix({ recommendation: sitemapEntry.recommendation }, sitemapEntry).fix, null);
  assert.deepEqual(findingFix({}, sitemapEntry), { suggestion: null, fix: null });
});

test('a page lists its page- and template-scoped findings, not site-wide or dismissed ones', () => {
  const url = 'https://example.com/a';
  const catalogById = new Map([
    ['meta-missing', { title: 'Missing meta descriptions', recommendation: 'Add one.' }],
    ['broken-internal-links', { title: 'Broken internal links', recommendation: 'Fix the link.' }],
    ['hsts-missing', { title: 'HSTS', recommendation: 'Send the header.' }],
  ]);
  const findings = [
    { id: '1', ruleId: 'meta-missing', scope: 'template', url, severity: 'warning', recommendedValue: 'Needs original copy' },
    { id: '2', ruleId: 'broken-internal-links', scope: 'page', url, severity: 'error', targetUrl: 'https://example.com/gone', detail: 'Not Found' },
    { id: '3', ruleId: 'broken-internal-links', scope: 'page', url, severity: 'error', targetUrl: 'https://example.com/lost', detail: 'Not Found' },
    { id: '4', ruleId: 'hsts-missing', scope: 'site', url, severity: 'notice' },
    { id: '5', ruleId: 'broken-internal-links', scope: 'page', url, severity: 'error', reviewStatus: 'False positive' },
    { id: '6', ruleId: 'meta-missing', scope: 'page', url: 'https://example.com/other', severity: 'warning' },
  ];
  const cards = pageIssueCards(findings, url, catalogById, new Map([['broken-internal-links', 7]]));

  assert.deepEqual(cards.map((c) => c.key), ['1', '2', '3']);
  assert.equal(cards[0].suggestion, 'Needs original copy');
  assert.equal(cards[1].targetUrl, 'https://example.com/gone');
  assert.equal(cards[1].detected, 'Not Found');
  assert.equal(cards[1].pages, 7);
  assert.equal(cards[1].recommendation, 'Fix the link.');
});
