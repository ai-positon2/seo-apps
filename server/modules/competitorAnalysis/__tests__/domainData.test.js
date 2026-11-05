// ── Per-domain Semrush figures: unknown is null, and each brand is its own ──
//
// Run: node --test modules/competitorAnalysis/__tests__/domainData.test.js
//
// A failed backlinks call was stored as authority 0 / 0 backlinks, so a rival
// whose numbers never loaded ranked below the client. The branded count is a
// row count of a 40-row page, and every competitor was counted against the
// CLIENT's brand. Semrush is stubbed: no units are spent here.

const test = require('node:test');
const assert = require('node:assert');

const semrush = require('../../../services/semrushCA');
const realProvider = require('../realProvider');
const { brandTermFor, domainStem } = require('../dataFetcher');
const { ROW_LIMITS } = require('../unitCosts');

function stubSemrush(t, { backlinks, branded }) {
  t.mock.method(semrush, 'getDomainRank', async () => ({ organicKeywords: 1000, organicTraffic: 5000 }));
  t.mock.method(semrush, 'getKeywordsFull', async () => []);
  t.mock.method(semrush, 'getAIOKeywords', async () => ({ count: 0, keywords: [] }));
  t.mock.method(semrush, 'getBacklinksOverview', backlinks);
  const calls = [];
  t.mock.method(semrush, 'getBrandedKeywordCount', async (domain, db, brand) => { calls.push(brand); return branded(); });
  return calls;
}

test('a failed backlinks call is stored as not measured (null), not 0', async (t) => {
  t.mock.method(global, 'setTimeout', (fn) => { fn(); return 0; });
  stubSemrush(t, { backlinks: async () => { throw new Error('timeout'); }, branded: async () => 3 });
  const d = await realProvider.fetchDomainData('rival.test', {}, { brandName: 'rival' });
  assert.strictEqual(d.authorityScore, null);
  assert.strictEqual(d.backlinks.totalBacklinks, null);
  assert.ok(d.fetchErrors.includes('backlinksOverview'));
});

test('a branded count that fills the page is capped, and the split is unknown', async (t) => {
  stubSemrush(t, {
    backlinks: async () => ({ authorityScore: 50, totalBacklinks: 10, referringDomains: 2, followLinks: 8, nofollowLinks: 2 }),
    branded: async () => ROW_LIMITS.brandedKeywordCount,
  });
  const d = await realProvider.fetchDomainData('nike.test', {}, { brandName: 'nike' });
  assert.strictEqual(d.brandedKeywordCountCapped, true);
  assert.strictEqual(d.nonBrandedKeywordCount, null, 'organic - 40 is not the non-branded count');
  assert.strictEqual(d.authorityScore, 50);
});

test('an uncapped branded count gives a real split; no brand term gives null', async (t) => {
  stubSemrush(t, { backlinks: async () => null, branded: async () => 12 });
  const d = await realProvider.fetchDomainData('x.test', {}, { brandName: 'x' });
  assert.strictEqual(d.brandedKeywordCount, 12);
  assert.strictEqual(d.nonBrandedKeywordCount, 988);
  const none = await realProvider.fetchDomainData('x.test', {}, {});
  assert.strictEqual(none.brandedKeywordCount, null);
});

test('each domain is measured against its own brand', () => {
  const client = { brandName: 'Nike' };
  assert.strictEqual(brandTermFor({ isClient: true, domain: 'nike.com', label: 'Nike Inc' }, client), 'Nike');
  assert.strictEqual(brandTermFor({ isClient: false, domain: 'www.footlocker.com', label: 'footlocker.com' }, client), 'footlocker');
  assert.strictEqual(brandTermFor({ isClient: false, domain: 'hibbett.com', label: 'Hibbett Sports' }, client), 'Hibbett Sports');
  assert.strictEqual(brandTermFor({ isClient: false, domain: 'https://www.argos.co.uk/', label: '' }, client), 'argos');
  assert.strictEqual(domainStem('shop.example.com'), 'example');
});
