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
  // `branded` answers a count, or an array of phrases, per spelling asked for.
  t.mock.method(semrush, 'getBrandedKeywordPhrases', async (domain, db, brand, limit) => {
    calls.push({ brand, limit });
    const r = await branded(brand, limit);
    return Array.isArray(r) ? r : Array.from({ length: Math.min(r, limit) }, (_, i) => `${brand} kw${i}`);
  });
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

test('a spaced brand label matches both "foot locker" and "footlocker", within the same row budget', async (t) => {
  const calls = stubSemrush(t, {
    backlinks: async () => null,
    branded: async (brand) => (brand === 'foot locker'
      ? ['foot locker near me', 'foot locker footlocker']
      : ['footlocker shoes', 'foot locker footlocker', 'footlocker']),
  });
  const d = await realProvider.fetchDomainData('footlocker.test', {}, { brandName: 'Foot  Locker' });
  assert.deepStrictEqual(calls.map((c) => c.brand), ['foot locker', 'footlocker']);
  // The spaced phrase gets the whole page; the joined one only what is left,
  // so the lines billed never exceed the budget.
  assert.deepStrictEqual(calls.map((c) => c.limit), [ROW_LIMITS.brandedKeywordCount, ROW_LIMITS.brandedKeywordCount - 2]);
  assert.strictEqual(d.brandedKeywordCount, 4, 'the keyword found under both spellings counts once');
  assert.strictEqual(d.brandedKeywordCountCapped, false);
  assert.strictEqual(d.nonBrandedKeywordCount, 996);
});

// Splitting the 40 rows in two halves capped each spelling at 20, so an exact
// 25 came back as "20+".
test('an exact count above half the budget stays exact', async (t) => {
  const calls = stubSemrush(t, { backlinks: async () => null, branded: async (brand) => (brand === 'foot locker' ? 25 : 0) });
  const d = await realProvider.fetchDomainData('footlocker.test', {}, { brandName: 'Foot Locker' });
  assert.strictEqual(d.brandedKeywordCount, 25);
  assert.strictEqual(d.brandedKeywordCountCapped, false);
  assert.deepStrictEqual(calls.map((c) => c.limit), [ROW_LIMITS.brandedKeywordCount, ROW_LIMITS.brandedKeywordCount - 25]);
});

test('a full first page is capped and the joined spelling is not requested', async (t) => {
  const calls = stubSemrush(t, { backlinks: async () => null, branded: async (brand, limit) => limit });
  const d = await realProvider.fetchDomainData('footlocker.test', {}, { brandName: 'Foot Locker' });
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(d.brandedKeywordCount, ROW_LIMITS.brandedKeywordCount, 'shown as "40+"');
  assert.strictEqual(d.brandedKeywordCountCapped, true);
});

test('the joined spelling filling the leftover rows marks the count as capped', async (t) => {
  stubSemrush(t, { backlinks: async () => null, branded: async (brand, limit) => (brand === 'footlocker' ? limit : 1) });
  const d = await realProvider.fetchDomainData('footlocker.test', {}, { brandName: 'Foot Locker' });
  assert.strictEqual(d.brandedKeywordCountCapped, true);
  assert.strictEqual(d.brandedKeywordCount, ROW_LIMITS.brandedKeywordCount);
  assert.strictEqual(d.nonBrandedKeywordCount, null);
});

// withRetry wrapped both spellings together, so one failing re-requested (and
// re-billed) the one that had succeeded.
test('a failing spelling is retried on its own; the other is not re-requested', async (t) => {
  t.mock.method(global, 'setTimeout', (fn) => { fn(); return 0; });
  let joinedTries = 0;
  const calls = stubSemrush(t, {
    backlinks: async () => null,
    branded: async (brand) => {
      if (brand === 'footlocker' && ++joinedTries === 1) throw new Error('blip');
      return brand === 'foot locker' ? ['foot locker a'] : ['footlocker b'];
    },
  });
  const d = await realProvider.fetchDomainData('footlocker.test', {}, { brandName: 'Foot Locker' });
  assert.deepStrictEqual(calls.map((c) => c.brand), ['foot locker', 'footlocker', 'footlocker']);
  assert.strictEqual(d.brandedKeywordCount, 2);
  assert.deepStrictEqual(d.fetchErrors, []);
});

test('brand spellings: one word is one term; only a spaced label gets a joined form; a domain is its name', () => {
  assert.deepStrictEqual(realProvider.brandVariants('Nike'), ['nike']);
  assert.deepStrictEqual(realProvider.brandVariants(' Foot Locker '), ['foot locker', 'footlocker']);
  assert.deepStrictEqual(realProvider.brandVariants('Hibbett-Sports'), ['hibbett-sports']);
  assert.deepStrictEqual(realProvider.brandVariants('nike.com'), ['nike'], 'never "nikecom"');
  assert.deepStrictEqual(realProvider.brandVariants('www.argos.co.uk'), ['argos']);
  assert.deepStrictEqual(realProvider.brandVariants(''), []);
  assert.deepStrictEqual(realProvider.brandVariants(null), []);
});

test('each domain is measured against its own brand', () => {
  const client = { brandName: 'Nike' };
  assert.strictEqual(brandTermFor({ isClient: true, domain: 'nike.com', label: 'Nike Inc' }, client), 'Nike');
  assert.strictEqual(brandTermFor({ isClient: false, domain: 'www.footlocker.com', label: 'footlocker.com' }, client), 'footlocker');
  assert.strictEqual(brandTermFor({ isClient: false, domain: 'hibbett.com', label: 'Hibbett Sports' }, client), 'Hibbett Sports');
  assert.strictEqual(brandTermFor({ isClient: false, domain: 'https://www.argos.co.uk/', label: '' }, client), 'argos');
  assert.strictEqual(domainStem('shop.example.com'), 'example');
});
