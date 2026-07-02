const axios = require('axios');

const BASE = 'https://api.semrush.com/';
// Backlinks reports (backlinks_overview, backlinks_refdomains, backlinks_geo, ...)
// live on a separate Backlinks Analytics API endpoint — the main domain/keyword
// endpoint above returns HTTP 400 for these report types.
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
  return {
    domain,
    organicKeywords: parseInt(p[0]) || 0,
    organicTraffic: parseInt(p[1]) || 0,
  };
}

// ── Backlinks overview ────────────────────────────────────────────────────────
// export_columns: ascore,total,domains_num,follows_num,nofollows_num
// row: [ascore, total, domains_num, follows_num, nofollows_num]

async function getBacklinksOverview(domain, targetType = 'root_domain') {
  const raw = await semrushGet({
    type: 'backlinks_overview',
    target: domain,
    target_type: targetType,
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

// ── Referring domains by country ───────────────────────────────────────────────
// export_columns: country,domains_num,backlinks_num
// row: [country, domains_num, backlinks_num]

async function getBacklinksGeo(domain, targetType = 'root_domain') {
  const raw = await semrushGet({
    type: 'backlinks_geo',
    target: domain,
    target_type: targetType,
    export_columns: 'country,domains_num,backlinks_num',
    display_sort: 'domains_num_desc',
  }, BACKLINKS_BASE);
  if (isSemrushError(raw)) return [];
  return parseRows(raw).map(p => ({
    country: p[0] || '',
    referringDomains: parseInt(p[1]) || 0,
    backlinks: parseInt(p[2]) || 0,
  })).filter(r => r.country);
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

async function getKeywordsFull(domain, database, limit = 3000, sort = null) {
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

// display_limit caps the WORST-CASE cost of this call, not just the result
// size: domain_organic bills per row actually returned, and a domain whose
// name is also a common keyword root (e.g. a branded chain) can match
// thousands of rows. Capped well below the daily credit budget so one
// unusually brand-heavy domain can't exhaust it in a single call — the
// tradeoff is an undercount for domains with more true matches than the cap.
async function getBrandedKeywordCount(domain, database, brandName, limit = 500) {
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

// ── AI Overview keywords ──────────────────────────────────────────────────────
// Filters for SERP features containing ai_overview.
// Falls back to empty if the plan doesn't support this filter.

async function getAIOKeywords(domain, database, limit = 500) {
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

async function getTopPages(domain, database, limit = 10, sampleSize = 200) {
  const raw = await semrushGet({
    type: 'domain_organic',
    domain,
    database,
    display_sort: 'nq_desc',
    export_columns: 'Ur,Ph,Nq',
    display_limit: sampleSize,
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
  getBacklinksGeo,
  getKeywordsByPositionBucket,
  getKeywordsFull,
  getBrandedKeywordCount,
  getAIOKeywords,
  getTopPages,
};
