// Pure functions only — no SEMrush/API calls here. Everything operates on
// already-fetched domain data (see dataFetcher.js), so this file can be
// unit-tested and re-run for free against a cached snapshot.

// ── Keyword position distribution (Page 1 / 2 / 3-5 / 6-10 / Total) ──────────

function computeKeywordPositionBuckets(keywords = []) {
  const page1 = keywords.filter(k => k.position >= 1 && k.position <= 10).length;
  const page2 = keywords.filter(k => k.position >= 11 && k.position <= 20).length;
  const page3to5 = keywords.filter(k => k.position >= 21 && k.position <= 50).length;
  const page6to10 = keywords.filter(k => k.position >= 51 && k.position <= 100).length;
  return { page1, page2, page3to5, page6to10, total: page1 + page2 + page3to5 + page6to10 };
}

// ── Keyword gap: striking distance / untapped / missing ──────────────────────
// Ported from server/routes/competitorAnalysis.js — same shape, same thresholds.

function computeKeywordGap(clientKeywords = [], competitorDomainsKeywords = []) {
  const clientMap = new Map(clientKeywords.map(k => [k.keyword, k]));

  const competitorTop10Map = new Map();
  competitorDomainsKeywords.forEach(({ domain, keywords }) => {
    keywords.filter(k => k.position <= 10).forEach(k => {
      const existing = competitorTop10Map.get(k.keyword);
      if (!existing || k.position < existing.position) {
        competitorTop10Map.set(k.keyword, { position: k.position, domain, volume: k.volume });
      }
    });
  });

  const strikingDistance = clientKeywords
    .filter(k => k.position >= 11 && k.position <= 50 && competitorTop10Map.has(k.keyword))
    .sort((a, b) => b.volume - a.volume)
    .slice(0, 25)
    .map(k => {
      const comp = competitorTop10Map.get(k.keyword);
      return {
        keyword: k.keyword,
        searchVolume: k.volume,
        clientPosition: k.position,
        bestCompetitorPosition: comp.position,
        bestCompetitorDomain: comp.domain,
      };
    });

  const untapped = [];
  for (const [kw, comp] of competitorTop10Map.entries()) {
    const clientKw = clientMap.get(kw);
    if (!clientKw || clientKw.position > 50) {
      untapped.push({
        keyword: kw,
        searchVolume: comp.volume,
        clientPosition: clientKw?.position || null,
        bestCompetitorPosition: comp.position,
        bestCompetitorDomain: comp.domain,
      });
    }
  }
  untapped.sort((a, b) => b.searchVolume - a.searchVolume);
  untapped.splice(25);

  const missing = [];
  for (const [kw, comp] of competitorTop10Map.entries()) {
    if (!clientMap.has(kw)) {
      missing.push({
        keyword: kw,
        searchVolume: comp.volume,
        bestCompetitorPosition: comp.position,
        bestCompetitorDomain: comp.domain,
      });
    }
  }
  missing.sort((a, b) => b.searchVolume - a.searchVolume);
  missing.splice(25);

  return { strikingDistance, untapped, missing };
}

// ── Keyword gap detail table: keyword × every domain's position ──────────────
// Matches the reference deck's "Competitor Top Keywords" table — one row per
// keyword, one column per domain, "Not Ranking" where a domain doesn't appear.

function computeKeywordDetailTable(allDomainsKeywords = [], limit = 100) {
  const keywordVolumes = new Map();
  const positionsByKeyword = new Map();

  for (const { domain, keywords } of allDomainsKeywords) {
    for (const k of keywords) {
      if (!keywordVolumes.has(k.keyword)) keywordVolumes.set(k.keyword, k.volume);
      if (!positionsByKeyword.has(k.keyword)) positionsByKeyword.set(k.keyword, {});
      const existing = positionsByKeyword.get(k.keyword)[domain];
      if (existing == null || k.position < existing) {
        positionsByKeyword.get(k.keyword)[domain] = k.position;
      }
    }
  }

  return Array.from(keywordVolumes.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([keyword, volume]) => ({
      keyword,
      searchVolume: volume,
      positions: positionsByKeyword.get(keyword) || {},
    }));
}

// ── Backlink gap: referring domains linking to competitors but not the client ─

function computeBacklinkGap(clientRefDomains = [], competitorDomainsRefDomains = []) {
  const clientDomainSet = new Set(clientRefDomains.map(d => d.domain));
  const countByReferrer = new Map();

  for (const { domain, refDomains } of competitorDomainsRefDomains) {
    for (const rd of refDomains) {
      if (clientDomainSet.has(rd.domain)) continue;
      if (!countByReferrer.has(rd.domain)) {
        countByReferrer.set(rd.domain, { domain: rd.domain, ascore: rd.ascore, linksTo: [] });
      }
      countByReferrer.get(rd.domain).linksTo.push(domain);
    }
  }

  return Array.from(countByReferrer.values())
    .map(r => ({ ...r, sharedByCount: r.linksTo.length }))
    .sort((a, b) => (b.ascore - a.ascore) || (b.sharedByCount - a.sharedByCount))
    .slice(0, 100);
}

// ── Authority distribution buckets (for the bar chart) ───────────────────────

function buildAuthorityBuckets(refDomains = []) {
  return {
    '80+': refDomains.filter(d => d.ascore >= 80).length,
    '60-79': refDomains.filter(d => d.ascore >= 60 && d.ascore < 80).length,
    '40-59': refDomains.filter(d => d.ascore >= 40 && d.ascore < 60).length,
    '20-39': refDomains.filter(d => d.ascore >= 20 && d.ascore < 40).length,
    '0-19': refDomains.filter(d => d.ascore < 20).length,
  };
}

module.exports = {
  computeKeywordPositionBuckets,
  computeKeywordGap,
  computeKeywordDetailTable,
  computeBacklinkGap,
  buildAuthorityBuckets,
};
