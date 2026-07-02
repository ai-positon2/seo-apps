// Rule-based gate — decides whether a module has anything worth an AI-written
// Observation/Recommendation this refresh. No LLM calls happen here. Thresholds
// are intentionally generous: this is a "give the full competitive picture"
// tool, not a rare-alert tool, so most real competitive gaps should qualify —
// but literally-empty/identical data still correctly produces nothing to say.

function leadDomain(domains, metric) {
  return domains.reduce((best, d) => (d[metric] > (best?.[metric] ?? -Infinity) ? d : best), null);
}

function overallNotable({ domains }) {
  const client = domains.find(d => d.isClient);
  if (!client) return false;
  const others = domains.filter(d => !d.isClient && d.domainRank);
  if (!others.length || !client.domainRank) return false;
  return others.some(o =>
    Math.abs((o.domainRank.organicTraffic || 0) - (client.domainRank.organicTraffic || 0)) >= (client.domainRank.organicTraffic || 1) * 0.5 ||
    Math.abs((o.domainRank.organicKeywords || 0) - (client.domainRank.organicKeywords || 0)) >= (client.domainRank.organicKeywords || 1) * 0.5
  );
}

function pageSpeedNotable({ domains }) {
  const scored = domains.filter(d => d.pageSpeed?.mobile?.score != null);
  if (scored.length < 2) return false;
  const scores = scored.map(d => d.pageSpeed.mobile.score);
  return (Math.max(...scores) - Math.min(...scores)) >= 15;
}

function keywordRankingNotable({ keywordGap }) {
  return (keywordGap?.strikingDistance?.length || 0) + (keywordGap?.untapped?.length || 0) + (keywordGap?.missing?.length || 0) > 0;
}

function brandedNotable({ domains }) {
  const client = domains.find(d => d.isClient);
  const others = domains.filter(d => !d.isClient);
  if (!client || !others.length) return false;
  return others.some(o => (o.nonBrandedKeywordCount || 0) >= (client.nonBrandedKeywordCount || 0) * 1.5 + 20);
}

function backlinkNotable({ domains, backlinkGap }) {
  if ((backlinkGap?.length || 0) > 0) return true;
  const client = domains.find(d => d.isClient);
  const others = domains.filter(d => !d.isClient);
  if (!client) return false;
  return others.some(o => (o.authorityScore || 0) - (client.authorityScore || 0) >= 10);
}

function aiVisibilityNotable({ manual }) {
  if (!manual?.domains) return false;
  const values = Object.values(manual.domains).map(d => d.aiVisibilityScore).filter(v => v != null);
  return values.length >= 2 && (Math.max(...values) - Math.min(...values)) >= 10;
}

module.exports = {
  overallNotable,
  pageSpeedNotable,
  keywordRankingNotable,
  brandedNotable,
  backlinkNotable,
  aiVisibilityNotable,
  leadDomain,
};
