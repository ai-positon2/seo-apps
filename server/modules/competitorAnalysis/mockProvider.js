// Stand-in data source. Produces the exact shape a live SEMrush-backed
// provider would (see semrushCA.js's function set) but with zero network
// calls and zero real API spend — so the rest of the pipeline (gap analysis,
// budget guard, snapshot store, UI) can be built and tested today, and a
// real provider can be dropped in later behind the same `fetchDomainData`
// signature without touching dataFetcher.js.
//
// Numbers are seeded from the domain name (and the run's full domain set,
// for the shared keyword/backlink pools) so a given client+competitor list
// produces stable, explorable-but-fake data across repeated runs.

function hashSeed(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed) {
  let a = seed;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function baseWord(domain) {
  return (domain || '').replace(/^https?:\/\//, '').replace(/\.[a-z.]+$/i, '').replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 14) || 'brand';
}

const KEYWORD_MODIFIERS = ['best', 'top', 'affordable', 'near me', 'reviews', 'cost of', 'pricing', 'alternative to', 'how to choose a', 'guide to', 'vs'];

function buildKeywordPool(domains, size = 45) {
  const rand = mulberry32(hashSeed('kw:' + domains.slice().sort().join('|')));
  const words = domains.map(baseWord);
  const pool = new Map();
  let guard = 0;
  while (pool.size < size && guard++ < size * 20) {
    const mod = KEYWORD_MODIFIERS[Math.floor(rand() * KEYWORD_MODIFIERS.length)];
    const w = words[Math.floor(rand() * words.length)];
    const keyword = mod === 'vs'
      ? `${w} vs ${words[Math.floor(rand() * words.length)]}`
      : `${mod} ${w}`;
    if (!pool.has(keyword) && keyword.split(' ').length > 1) {
      pool.set(keyword, { keyword, volume: 20 + Math.floor(rand() * 4000) });
    }
  }
  return [...pool.values()];
}

// Mirrors the shape of pageSpeedCA.js's real extractFixes() output — titles
// and descriptions modeled on Lighthouse's own actual audit copy, so the
// "Fixes & Recommendations" UI is exercisable (including its "no major
// issues" empty state) without a live GOOGLE_PSI_API_KEY.
const MOCK_FIX_LIBRARY = [
  { id: 'render-blocking-resources', title: 'Eliminate render-blocking resources', description: 'Resources are blocking the first paint of your page.' },
  { id: 'unused-css-rules', title: 'Reduce unused CSS', description: 'Remove dead rules from stylesheets to reduce bytes consumed by network activity.' },
  { id: 'unminified-javascript', title: 'Minify JavaScript', description: 'Minifying JS files can reduce payload sizes and script parse time.' },
  { id: 'uses-responsive-images', title: 'Properly size images', description: 'Serve images sized appropriately to save data and improve load time.' },
  { id: 'uses-optimized-images', title: 'Efficiently encode images', description: 'Optimized images load faster and consume less data.' },
  { id: 'total-blocking-time', title: 'Reduce JavaScript execution time', description: 'Consider reducing time spent parsing, compiling, and executing JS.' },
];

function pageSpeedFor(rand) {
  const mkStrategy = () => {
    const score = 25 + Math.floor(rand() * 70);
    return {
      score,
      lcp: (1.2 + rand() * 3.5).toFixed(1) + 's',
      cls: (rand() * 0.35).toFixed(2),
      ttfb: Math.round(200 + rand() * 1200) + 'ms',
      fcp: (0.8 + rand() * 2.5).toFixed(1) + 's',
      inp: Math.round(100 + rand() * 500) + 'ms',
    };
  };
  const mobile = mkStrategy();
  const desktop = mkStrategy();

  const fixCount = mobile.score >= 85 ? 0 : 1 + Math.floor(rand() * 3);
  const fixes = MOCK_FIX_LIBRARY
    .filter(() => rand() < 0.6)
    .slice(0, fixCount)
    .map((f) => ({ ...f, savingsMs: Math.round(200 + rand() * 2500) }));

  return {
    mobile, desktop,
    coreWebVitalsPassed: mobile.score >= 50 && desktop.score >= 50,
    fixes,
    strategyErrors: { mobile: null, desktop: null },
  };
}

// One shared context per run — call once, reuse across every domain in
// the run so keyword/backlink pools overlap and gap analysis has real
// (if fake) overlaps to find.
function createRunContext(allDomains) {
  return {
    keywordPool: buildKeywordPool(allDomains),
  };
}

function fetchDomainData(domain, ctx, { brandName } = {}) {
  const rand = mulberry32(hashSeed('domain:' + domain));

  const keywords = ctx.keywordPool
    .filter(() => rand() < 0.6)
    .map(({ keyword, volume }) => ({
      keyword,
      position: 1 + Math.floor(rand() * 100),
      volume,
      cpc: +(rand() * 8).toFixed(2),
    }))
    .sort((a, b) => b.volume - a.volume);

  const organicKeywords = 200 + Math.floor(rand() * 20000);
  const organicTraffic = 500 + Math.floor(rand() * 120000);
  const totalBacklinks = 500 + Math.floor(rand() * 200000);
  const brandedKeywordCount = Math.floor(rand() * 400);

  return {
    domain,
    domainRank: { organicKeywords, organicTraffic },
    // All 5 of these come from ONE 1-unit backlinks_overview row
    // (ascore,total,domains_num,follows_num,nofollows_num) — no per-row cost.
    authorityScore: 10 + Math.floor(rand() * 80),
    backlinks: {
      totalBacklinks,
      referringDomains: 50 + Math.floor(rand() * 3000),
      followLinks: Math.floor(totalBacklinks * (0.6 + rand() * 0.3)),
      nofollowLinks: Math.floor(totalBacklinks * (0.05 + rand() * 0.2)),
    },
    keywords,
    aioKeywordCount: Math.floor(rand() * (keywords.length * 0.3)),
    brandedKeywordCount,
    brandedKeywordCountCapped: false,
    brandTerm: brandName || null,
    nonBrandedKeywordCount: Math.max(0, organicKeywords - brandedKeywordCount),
    pageSpeed: pageSpeedFor(rand),
    // Mock data never fails a fetch — kept for interface parity with
    // realProvider.js so the UI's fetchErrors check works the same for both.
    fetchErrors: [],
  };
}

module.exports = { createRunContext, fetchDomainData };
