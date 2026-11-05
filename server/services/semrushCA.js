const axios = require('axios');

const BASE = 'https://api.semrush.com/';
// Backlinks Analytics report types (backlinks_overview, backlinks_refdomains, ...)
// 400 ("query type not found") on the general endpoint above — they live on a
// separate base. Confirmed directly against the live API.
const BACKLINKS_BASE = 'https://api.semrush.com/analytics/v1/';
const TIMEOUT = 20000;

async function semrushGet(params, base = BASE) {
  const key = process.env.SEMRUSH_API_KEY;
  if (!key) throw new Error('SEMRUSH_API_KEY not configured');
  try {
    const res = await axios.get(base, { params: { key, ...params }, timeout: TIMEOUT });
    return (res.data || '').toString();
  } catch (err) {
    if (err.code === 'ECONNABORTED') throw new Error('Semrush request timed out');
    throw new Error(`Semrush request failed: ${err.message}`);
  }
}

// Positional row parser — safer than header-name lookup since Semrush sometimes
// returns full column labels instead of the short codes we request.
function parseRows(raw, skip = 1) {
  if (!raw || typeof raw !== 'string') return [];
  const t = raw.trim();
  if (!t || t.startsWith('ERROR') || t.startsWith('error')) return [];
  const lines = t.split('\n').filter(Boolean);
  if (lines.length <= skip) return [];
  return lines.slice(skip).map(line => line.split(';').map(v => (v || '').trim()));
}

function isSemrushError(raw) {
  const t = (raw || '').trim();
  return !t || t.startsWith('ERROR') || t.startsWith('error');
}

// ── Competitor discovery ──────────────────────────────────────────────────────
// export_columns: Dn,Cr,Np,Or,Ot,Oc,Ad
// row: [domain, compLevel, commonKw, organicKw, organicTraffic, organicCost, authorityScore]

async function discoverCompetitors(domain, database, displayLimit = 20) {
  const raw = await semrushGet({
    type: 'domain_organic_organic',
    domain,
    database,
    display_limit: displayLimit,
    display_sort: 'np_desc',
    export_columns: 'Dn,Cr,Np,Or,Ot,Oc,Ad',
  });
  if (isSemrushError(raw)) return [];
  return parseRows(raw).map(p => ({
    domain: p[0] || '',
    competitionLevel: parseFloat(p[1]) || 0,
    commonKeywords: parseInt(p[2]) || 0,
    organicKeywords: parseInt(p[3]) || 0,
    organicTraffic: parseInt(p[4]) || 0,
    organicCost: parseFloat(p[5]) || 0,
    authorityScore: parseInt(p[6]) || 0,
  })).filter(r => r.domain);
}

// ── Domain overview ───────────────────────────────────────────────────────────
// export_columns: Or,Ot
// row: [organicKeywords, organicTraffic]

async function getDomainRank(domain, database) {
  const raw = await semrushGet({
    type: 'domain_rank',
    domain,
    database,
    export_columns: 'Or,Ot',
  });
  const rows = parseRows(raw);
  if (!rows.length) return null;
  const p = rows[0];
  // An unparseable figure is unknown, not zero: a 0 here used to make a rival
  // with no Semrush data read as a site with no traffic.
  const count = (value) => {
    const n = parseInt(value, 10);
    return Number.isFinite(n) ? n : null;
  };
  return {
    domain,
    organicKeywords: count(p[0]) ?? 0,
    organicTraffic: count(p[1]),
  };
}

// ── Backlinks overview ────────────────────────────────────────────────────────
// export_columns: ascore,total,domains_num,follows_num,nofollows_num
// row: [ascore, total, domains_num, follows_num, nofollows_num]

async function getBacklinksOverview(domain) {
  const raw = await semrushGet({
    type: 'backlinks_overview',
    target: domain,
    target_type: 'root_domain',
    export_columns: 'ascore,total,domains_num,follows_num,nofollows_num',
  }, BACKLINKS_BASE);
  const rows = parseRows(raw);
  if (!rows.length) return null;
  const p = rows[0];
  return {
    authorityScore: parseInt(p[0]) || 0,
    totalBacklinks: parseInt(p[1]) || 0,
    referringDomains: parseInt(p[2]) || 0,
    followLinks: parseInt(p[3]) || 0,
    nofollowLinks: parseInt(p[4]) || 0,
  };
}

// ── Referring domains ─────────────────────────────────────────────────────────
// export_columns: domain,domain_ascore,backlinks_num
// row: [domain, ascore, backlinks]

async function getBacklinksRefdomains(domain) {
  const raw = await semrushGet({
    type: 'backlinks_refdomains',
    target: domain,
    target_type: 'root_domain',
    export_columns: 'domain,domain_ascore,backlinks_num',
    display_sort: 'domain_ascore_desc',
    display_limit: 200,
  }, BACKLINKS_BASE);
  if (isSemrushError(raw)) return [];
  return parseRows(raw).map(p => ({
    domain: p[0] || '',
    ascore: parseInt(p[1]) || 0,
    backlinks: parseInt(p[2]) || 0,
  })).filter(r => r.domain);
}

// ── Keyword position buckets ──────────────────────────────────────────────────
// export_columns: Ph,Po,Nq
// row: [keyword, position, volume]
//
// IMPORTANT: pass raw '+' chars — axios will URL-encode them to %2B correctly.
// Pre-encoding to %2B causes double-encoding (%252B) which Semrush rejects.

async function getKeywordsByPositionBucket(domain, database, minPos, maxPos, limit = 1000) {
  let filter;
  if (minPos > 1) {
    filter = `+|Po|Gt|${minPos - 1}|+|Po|Lt|${maxPos + 1}`;
  } else {
    filter = `+|Po|Lt|${maxPos + 1}`;
  }

  const raw = await semrushGet({
    type: 'domain_organic',
    domain,
    database,
    display_filter: filter,
    display_sort: 'po_asc',
    export_columns: 'Ph,Po,Nq',
    display_limit: limit,
  });
  if (isSemrushError(raw)) return [];
  return parseRows(raw).map(p => ({
    keyword: p[0] || '',
    position: parseInt(p[1]) || 0,
    volume: parseInt(p[2]) || 0,
  })).filter(r => r.keyword);
}

// ── Full keyword list for gap analysis ────────────────────────────────────────
// export_columns: Ph,Po,Nq,Cp
// row: [keyword, position, volume, cpc]

async function getKeywordsFull(domain, database, limit = 3000, sort) {
  const raw = await semrushGet({
    type: 'domain_organic',
    domain,
    database,
    display_limit: limit,
    export_columns: 'Ph,Po,Nq,Cp',
    ...(sort ? { display_sort: sort } : {}),
  });
  if (isSemrushError(raw)) return [];
  return parseRows(raw).map(p => ({
    keyword: p[0] || '',
    position: parseInt(p[1]) || 0,
    volume: parseInt(p[2]) || 0,
    cpc: parseFloat(p[3]) || 0,
  })).filter(r => r.keyword);
}

// ── Branded keyword count ─────────────────────────────────────────────────────
// Uses +|Ph|Co|brandName filter — axios encodes '+' to %2B correctly.

async function getBrandedKeywordCount(domain, database, brandName, limit = 10000) {
  const raw = await semrushGet({
    type: 'domain_organic',
    domain,
    database,
    display_filter: `+|Ph|Co|${brandName.toLowerCase()}`,
    export_columns: 'Ph,Po,Nq',
    display_limit: limit,
  });
  if (isSemrushError(raw)) return 0;
  return parseRows(raw).length;
}

// The branded keyword PHRASES (lowercased) rather than their count, so a
// caller matching several spellings of one brand ("foot locker" and
// "footlocker") can union them without counting a keyword twice. Same report,
// same per-line cost as getBrandedKeywordCount.
async function getBrandedKeywordPhrases(domain, database, brandName, limit = 10000) {
  const raw = await semrushGet({
    type: 'domain_organic',
    domain,
    database,
    display_filter: `+|Ph|Co|${String(brandName).toLowerCase()}`,
    export_columns: 'Ph,Po,Nq',
    display_limit: limit,
  });
  if (isSemrushError(raw)) return [];
  return parseRows(raw).map((p) => String(p[0] || '').toLowerCase()).filter(Boolean);
}

// ── AI Overview keywords ──────────────────────────────────────────────────────
// Filters for SERP features containing ai_overview.
// Falls back to empty if the plan doesn't support this filter.

async function getAIOKeywords(domain, database, limit = 5000) {
  try {
    const raw = await semrushGet({
      type: 'domain_organic',
      domain,
      database,
      display_filter: '+|Fp|Co|ai_overview',
      export_columns: 'Ph,Po,Nq,Fp',
      display_limit: limit,
    });
    if (isSemrushError(raw)) return { count: 0, keywords: [] };
    const rows = parseRows(raw).filter(p => {
      const fp = (p[3] || '').toLowerCase();
      return fp.includes('ai_overview') || fp.includes('ai overview');
    });
    return {
      count: rows.length,
      keywords: rows.slice(0, 20).map(p => ({
        keyword: p[0] || '',
        position: parseInt(p[1]) || 0,
        volume: parseInt(p[2]) || 0,
      })),
    };
  } catch {
    return { count: 0, keywords: [] };
  }
}

// ── Top pages by organic traffic ──────────────────────────────────────────────
// Pulls top keywords with their ranking URL, aggregates to page-level.
// export_columns: Ur,Ph,Nq  (URL first so aggregation uses p[0])
// row: [url, keyword, volume]

async function getTopPages(domain, database, limit = 10) {
  const raw = await semrushGet({
    type: 'domain_organic',
    domain,
    database,
    display_sort: 'nq_desc',
    export_columns: 'Ur,Ph,Nq',
    display_limit: 200,
  });
  if (isSemrushError(raw)) return [];

  const rows = parseRows(raw);
  const pageMap = new Map();

  rows.forEach(p => {
    const fullUrl = p[0] || '';
    // Normalise to path-only so table cells aren't huge
    const url = fullUrl ? (fullUrl.replace(/^https?:\/\/[^/]+/, '') || '/') : '/';
    const vol = parseInt(p[2]) || 0;
    if (!pageMap.has(url)) pageMap.set(url, { url, keywords: 0, totalVolume: 0 });
    const page = pageMap.get(url);
    page.keywords++;
    page.totalVolume += vol;
  });

  const pages = Array.from(pageMap.values())
    .sort((a, b) => b.totalVolume - a.totalVolume)
    .slice(0, limit);

  const totalVol = pages.reduce((s, p) => s + p.totalVolume, 0);
  return pages.map(p => ({
    url: p.url,
    traffic: p.totalVolume,
    keywords: p.keywords,
    trafficShare: totalVol > 0 ? Math.round((p.totalVolume / totalVol) * 100) : 0,
  }));
}

module.exports = {
  discoverCompetitors,
  getDomainRank,
  getBacklinksOverview,
  getBacklinksRefdomains,
  getKeywordsByPositionBucket,
  getKeywordsFull,
  getBrandedKeywordCount,
  getBrandedKeywordPhrases,
  getAIOKeywords,
  getTopPages,
};
