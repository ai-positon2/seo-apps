// Adapts this dashboard's actual snapshot + content-analysis data into the
// section shape server/services/competitorPdfGenerator.js renders as a PDF
// report. Also owns the GPT narrative (Observations/Recommendations per
// section + one executive summary), generated once per analysis run and
// cached on the snapshot so repeat downloads don't re-spend OpenAI calls or
// produce different text each time.
const gptAnalysis = require('../../services/gptAnalysisCA');

// Buckets the 16-value page-type taxonomy (contentAnalysis/taxonomy.js) down
// to the 4 buckets the PDF report's "Content Mix Summary" table expects.
// Types not explicitly listed fall through to "Other".
function bucketContentTypeCounts(counts = {}) {
  const buckets = { 'Blog / Informational': 0, 'Location Page': 0, 'Service / Product Page': 0, 'Other': 0 };
  const MAP = {
    blog: 'Blog / Informational',
    resource: 'Blog / Informational',
    location: 'Location Page',
    locationService: 'Location Page',
    service: 'Service / Product Page',
    solution: 'Service / Product Page',
    serviceProvider: 'Service / Product Page',
    product: 'Service / Product Page',
    pricing: 'Service / Product Page',
  };
  for (const [type, count] of Object.entries(counts)) {
    const bucket = MAP[type] || 'Other';
    buckets[bucket] += count;
  }
  return buckets;
}

function mapSnapshotToSections(client, snapshot, contentAnalysis) {
  const domains = snapshot?.domains || [];
  const contentByDomain = new Map((contentAnalysis?.topPages?.domains || []).map((d) => [d.domain, d]));

  const overallMetrics = domains.map((d) => ({
    domain: d.domain,
    authorityScore: d.authorityScore,
    organicTraffic: d.domainRank?.organicTraffic,
    organicKeywords: d.domainRank?.organicKeywords,
    backlinks: d.backlinks?.totalBacklinks,
    referringDomains: d.backlinks?.referringDomains,
    aiOverviewKeywords: d.aioKeywordCount,
  }));

  // pageSpeed can be null (PSI disabled, or not fetched yet for this domain)
  // — the PDF report expects the mobile/desktop sub-objects to exist.
  const pageSpeed = domains.map((d) => ({
    domain: d.domain,
    mobile: d.pageSpeed?.mobile || { score: null, lcp: 'N/A', cls: 'N/A', ttfb: 'N/A' },
    desktop: d.pageSpeed?.desktop || { score: null },
    coreWebVitalsPassed: !!d.pageSpeed?.coreWebVitalsPassed,
  }));

  const keywordRanking = domains.map((d) => {
    const totalOrganic = d.domainRank?.organicKeywords ?? d.keywordBuckets?.total ?? 0;
    // A capped branded count is "at least N" and leaves the split unknown:
    // print "40+" and N/A, not a 100% non-branded share.
    const capped = !!d.brandedKeywordCountCapped;
    const nonBranded = capped ? null : (d.nonBrandedKeywordCount ?? null);
    return {
      domain: d.domain,
      page1: d.keywordBuckets?.page1,
      page2: d.keywordBuckets?.page2,
      page3to5: d.keywordBuckets?.page3to5,
      totalOrganic,
      branded: capped ? `${d.brandedKeywordCount}+` : d.brandedKeywordCount,
      nonBranded,
      nonBrandedPct: nonBranded !== null && totalOrganic > 0 ? Math.round((nonBranded / totalOrganic) * 100) : undefined,
    };
  });

  // Field names already match the PDF report's expectations exactly (see
  // gapAnalysis.js) — passed through as-is.
  const keywordGap = snapshot?.keywordGap || { strikingDistance: [], untapped: [], missing: [] };

  const backlinks = domains.map((d) => ({
    domain: d.domain,
    authorityScore: d.authorityScore,
    totalBacklinks: d.backlinks?.totalBacklinks,
    referringDomains: d.backlinks?.referringDomains,
    followLinks: d.backlinks?.followLinks,
    nofollowLinks: d.backlinks?.nofollowLinks,
    // Not fetched by this dashboard (would need an extra live SEMrush call
    // this export deliberately avoids making) — renders as "N/A", a known
    // v1 limitation rather than a bug.
    buckets: {},
  }));

  const aiOverview = domains.map((d) => ({ domain: d.domain, count: d.aioKeywordCount || 0 }));

  const contentAnalysisSections = domains.map((d) => {
    const cd = contentByDomain.get(d.domain);
    return {
      domain: d.domain,
      topPages: (cd?.pages || []).map((p) => ({
        url: p.fullUrl || p.url, traffic: p.traffic, keywords: p.keywords, type: p.contentType,
      })),
      contentMix: bucketContentTypeCounts(cd?.contentTypeCounts),
    };
  });

  return {
    brandName: client.brandName || client.name,
    clientDomain: client.domain,
    competitors: client.competitors.map((c) => ({ domain: c.domain })),
    sections: {
      overallMetrics, pageSpeed, keywordRanking, keywordGap, backlinks, aiOverview,
      contentAnalysis: contentAnalysisSections,
    },
  };
}

// One data-summary line per domain, mirroring the pipe-delimited style
// gptAnalysisCA.js's own callers already use — keeps the GPT prompt short
// and numeric, not a raw JSON dump.
function summarizeForGpt(sectionKey, sections) {
  const rows = sections[sectionKey];
  if (!rows) return '';
  if (Array.isArray(rows)) {
    if (!rows.length) return '';
    return rows.map((r) => Object.entries(r).map(([k, v]) => `${k}=${v}`).join(', ')).join('\n');
  }
  // keywordGap is an object of arrays
  const parts = Object.entries(rows)
    .filter(([, list]) => Array.isArray(list) && list.length)
    .map(([name, list]) => `${name}: ${list.length} keywords (top: ${list.slice(0, 5).map((k) => k.keyword).join(', ')})`);
  return parts.join('\n');
}

const SECTION_LABELS = {
  overallMetrics: 'Overall Analysis',
  pageSpeed: 'Page Speed Score Comparison',
  keywordRanking: 'Keyword Ranking Comparison',
  keywordGap: 'Keyword Gap Analysis',
  backlinks: 'Off-Page Metrics Comparison',
  aiOverview: 'AI Overview Visibility',
  contentAnalysis: 'Content Analysis',
};

async function generateNarrative(client, sections) {
  if (!process.env.OPENAI_API_KEY) return { gptDrafts: {}, executiveSummary: '' };

  const brandName = client.brandName || client.name;
  const dateRange = `as of ${new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}`;

  const entries = Object.keys(SECTION_LABELS);
  const results = await Promise.all(entries.map(async (key) => {
    const summary = summarizeForGpt(key, sections);
    if (!summary) return [key, null];
    try {
      const text = await gptAnalysis.generateObsRecs(SECTION_LABELS[key], brandName, client.country, dateRange, summary);
      return [key, text];
    } catch (err) {
      console.error(`[reportExport] generateObsRecs failed for ${key}:`, err.message);
      return [key, null];
    }
  }));

  const gptDrafts = {};
  for (const [key, text] of results) {
    if (text) gptDrafts[key] = text;
  }

  let executiveSummary = '';
  if (Object.keys(gptDrafts).length) {
    try {
      executiveSummary = await gptAnalysis.generateExecutiveSummary(brandName, gptDrafts);
    } catch (err) {
      console.error('[reportExport] generateExecutiveSummary failed:', err.message);
    }
  }

  return { gptDrafts, executiveSummary };
}

// Cheap fingerprint of "what the report would contain" — invalidates the
// cached narrative whenever the main snapshot OR content analysis changes,
// without needing to diff the actual data.
function narrativeFingerprint(snapshot, contentAnalysis) {
  return `${snapshot?.capturedAt || ''}::${contentAnalysis?.capturedAt || ''}`;
}

// Returns { reportData, narrativeChanged }. When narrativeChanged is true,
// the caller (routes.js) should persist the mutated snapshot so future
// exports for this same run reuse the cached narrative instead of
// re-spending GPT calls.
async function buildReportData(client, snapshot, contentAnalysis) {
  const mapped = mapSnapshotToSections(client, snapshot, contentAnalysis);
  const fingerprint = narrativeFingerprint(snapshot, contentAnalysis);

  let narrativeChanged = false;
  let narrative = snapshot.reportNarrative;
  if (!narrative || narrative.fingerprint !== fingerprint) {
    const generated = await generateNarrative(client, mapped.sections);
    narrative = { fingerprint, ...generated, generatedAt: new Date().toISOString() };
    snapshot.reportNarrative = narrative;
    narrativeChanged = true;
  }

  return {
    reportData: {
      ...mapped,
      gptDrafts: narrative.gptDrafts || {},
      executiveSummary: narrative.executiveSummary || '',
    },
    narrativeChanged,
  };
}

module.exports = { buildReportData, mapSnapshotToSections, bucketContentTypeCounts };
