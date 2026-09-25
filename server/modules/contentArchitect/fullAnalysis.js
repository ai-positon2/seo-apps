// ── Full pipeline orchestration (Stages 4-7) ─────────────────────────────────
// Ties together the crawler, link graph, full-content clustering (with link
// boost), LLM naming, hub selection, and diagnostics into the canonical
// Project/Page/Cluster/Flag shape the export (Stage 9) reads from. This is
// the "real" analysis — Stage 3's draft-clustering stays separate (instant,
// slug-only, no crawl) and is not replaced by this.
const crypto = require('crypto');
const { crawlSite } = require('./crawler');
const { buildLinkGraphAndDepths } = require('./linkGraph');
const { buildCorpusTermProfiles } = require('./termProfile');
const { buildSimilarityMatrix, applyLinkBoost } = require('./similarity');
const { runClustering, mechanicalName, topTermsForCluster } = require('./clusterEngine');
const { nameClusters } = require('./llmNaming');
const { selectHub } = require('./hubSelection');
const { runDiagnostics } = require('./diagnostics');
const { assessRelevance } = require('./contentRelevance');
const { SIMILARITY_THRESHOLD, THIN_WORD_COUNT, STALE_MONTHS } = require('./config');

function genId(prefix) { return `${prefix}_${crypto.randomBytes(6).toString('hex')}`; }

function assignmentReason(pageIndex, cluster, hubResult, pages, profiles, idf) {
  const page = pages[pageIndex];
  const isHub = hubResult.hubPageIndex === pageIndex;
  if (isHub) {
    const breadth = hubResult.scores.get(pageIndex)?.breakdown.breadth || 0;
    return `Selected as hub — covers ${Math.round(breadth * 100)}% of this cluster's topic vocabulary, ${page.wordCount || 0} words.`;
  }
  if (hubResult.isGap) {
    return `No existing page broad enough to serve as hub for this cluster (gap identified).`;
  }
  const hubIdx = hubResult.hubPageIndex;
  const shared = hubIdx == null ? [] : [...profiles[pageIndex].keys()].filter((t) => profiles[hubIdx].has(t))
    .sort((a, b) => (profiles[pageIndex].get(b) * (idf.get(b) || 0)) - (profiles[pageIndex].get(a) * (idf.get(a) || 0)))
    .slice(0, 3);
  const linksToHub = hubIdx != null && (page.outboundLinks || []).some((l) => l.href === pages[hubIdx].url);
  const parts = [];
  if (shared.length) parts.push(`Shares '${shared.join(', ')}' with the hub`);
  parts.push(linksToHub ? 'already links to hub' : 'does not yet link to hub');
  parts.push(`${page.wordCount || 0} words`);
  return parts.join('. ') + '.';
}

// urls: confirmed URL strings. project: { domain, vertical }. onProgress:
// optional callback(stage, detail) for SSE wiring.
//
// This is the crawl-and-analyse entry point. The analysis half is separate
// (analyzeCrawledPages, below) so pages that were ALREADY fetched by something
// else can go through the identical pipeline — see
// projects/crawlToArchitect.js, which feeds it a CrawlScope run. One pipeline,
// two sources of pages: §32 prefers that to a second implementation that would
// drift into producing different clusters for the same site.
async function runFullAnalysis(urls, project, { onProgress } = {}) {
  const notify = (stage, detail) => onProgress && onProgress(stage, detail);

  notify('crawl', { message: `Crawling ${urls.length} confirmed URLs…` });
  const crawlResult = await crawlSite(urls, project.domain, {
    onProgress: (p) => notify('crawl', { message: `Reading pages — ${p.completed} of ${p.total}`, ...p }),
  });

  return analyzeCrawledPages(crawlResult, project, { onProgress });
}

/**
 * Stages 5-7 over pages that have already been fetched.
 *
 * @param {object}  crawlResult  { pages, excluded, sampled, sampleSize,
 *                                budgetHit, abortedForFailureRate, crawlMode }
 * @param {object}  project      { domain, vertical }
 * @param {object} [opts]
 * @param {Function}[opts.onProgress]
 * @param {boolean} [opts.orphanDetection=true]  false when the pages came from a
 *                                   crawl that did not cover the whole site: a page
 *                                   with no inbound link there may just be linked
 *                                   from a page never fetched, so no page is
 *                                   flagged an orphan and the analysis says so.
 * @param {object} [opts.linkGraph]  { graph, inboundCounts, depths } when the
 *                                   caller already knows them. Supplying this
 *                                   skips buildLinkGraphAndDepths, whose only
 *                                   network call is one homepage fetch to seed
 *                                   its depth BFS — a caller that already has
 *                                   crawl depths should not repeat it.
 */
async function analyzeCrawledPages(crawlResult, project, { onProgress, linkGraph, orphanDetection = true } = {}) {
  const notify = (stage, detail) => onProgress && onProgress(stage, detail);
  const pages = crawlResult.pages;

  notify('linkgraph', { message: 'Building internal link graph…' });
  const { graph, inboundCounts, depths } = linkGraph
    || await buildLinkGraphAndDepths(pages, project.domain);

  notify('cluster', { message: 'Clustering pages by topic…' });
  const profiles = buildCorpusTermProfiles(pages, { domain: project.domain, vertical: project.vertical });
  const baseMatrix = buildSimilarityMatrix(profiles);
  const boostedMatrix = applyLinkBoost(baseMatrix, graph);
  const { clusters, unassignedIndices } = await runClustering(profiles, boostedMatrix, { threshold: SIMILARITY_THRESHOLD, draft: false });
  const idf = require('./similarity').computeIdf(profiles);

  notify('naming', { message: `Naming ${clusters.length} clusters…` });
  const names = await nameClusters(clusters, pages, profiles, idf, project.domain);

  notify('hubs', { message: 'Selecting hub pages…' });
  const hubResults = new Map();
  for (const cluster of clusters) {
    const nameEntry = names.get(cluster.id);
    // selectHub's gap-suggestion path reads cluster.name directly — resolve
    // it to the final (LLM or mechanical-fallback) name first, or a gap
    // suggestion's proposed title shows the pre-naming mechanical
    // placeholder even when the cluster itself got a real LLM name.
    if (nameEntry?.name) cluster.name = nameEntry.name;
    hubResults.set(cluster.id, selectHub(cluster, pages, profiles, graph, nameEntry?.llmHubRecommendation || null));
  }

  notify('diagnostics', { message: 'Running diagnostics…' });
  const diag = runDiagnostics(clusters, hubResults, pages, boostedMatrix, profiles, graph, inboundCounts, depths, Date.now());

  // Assemble canonical Page records.
  const pageIdByIndex = pages.map(() => genId('page'));
  const clusterIdOfPage = new Array(pages.length).fill(null);
  const roleOfPage = new Array(pages.length).fill(null);
  clusters.forEach((c) => {
    const hubResult = hubResults.get(c.id);
    c.memberIndices.forEach((i) => {
      clusterIdOfPage[i] = c.id;
      roleOfPage[i] = hubResult.hubPageIndex === i ? 'hub' : 'spoke';
    });
  });

  const finalPages = pages.map((p, i) => ({
    id: pageIdByIndex[i],
    url: p.url,
    finalUrl: p.finalUrl,
    status: p.status,
    canonical: p.canonical,
    noindex: p.noindex,
    title: p.title,
    h1: p.h1,
    h2s: p.h2s,
    metaDescription: p.metaDescription,
    firstParagraph: p.firstParagraph,
    wordCount: p.wordCount,
    publishedAt: p.publishedAt,
    modifiedAt: p.modifiedAt,
    schemaType: p.schemaType,
    crawlStatus: p.crawlStatus,
    estimated: p.estimated,
    inboundLinkCount: inboundCounts[i],
    depth: depths[i] === Infinity ? null : depths[i],
    clusterId: clusterIdOfPage[i],
    role: roleOfPage[i],
    assignmentReason: clusterIdOfPage[i]
      ? assignmentReason(i, clusters.find((c) => c.id === clusterIdOfPage[i]), hubResults.get(clusterIdOfPage[i]), pages, profiles, idf)
      : null,
    flags: (diag.flagsByPage.get(i) || []).map((f) => f.type)
      .filter((type) => orphanDetection || type !== 'orphan'),
    contentAction: null,
    contentActionReason: null,
  }));

  // Word count and age are weak proxies for "should this be retired" (a real
  // page from 9 months ago isn't stale by any reasonable definition, and a
  // short timeless FAQ isn't worth retiring for being brief) — this reads
  // the actual content and judges relevance, falling back to the mechanical
  // thin/stale signal only if there's no API key or the call fails.
  notify('relevance', { message: 'Assessing which pages are worth refreshing or retiring…' });
  const relevance = await assessRelevance(finalPages, { thinWordCount: THIN_WORD_COUNT, staleMonths: STALE_MONTHS, now: Date.now() });
  for (const page of finalPages) {
    const assessment = relevance.get(page.id);
    if (assessment) {
      page.contentAction = assessment.action;
      page.contentActionReason = assessment.reason;
    }
  }

  const finalClusters = clusters.map((c) => {
    const hubResult = hubResults.get(c.id);
    const nameEntry = names.get(c.id);
    return {
      id: c.id,
      name: nameEntry?.name || c.name,
      description: nameEntry?.description || null,
      nameSource: nameEntry?.source || 'mechanical',
      hubPageId: hubResult.hubPageIndex !== null ? pageIdByIndex[hubResult.hubPageIndex] : null,
      isGap: hubResult.isGap,
      gapSuggestion: hubResult.gapSuggestion,
      spokeIds: c.memberIndices.filter((i) => i !== hubResult.hubPageIndex).map((i) => pageIdByIndex[i]),
      hubConfidence: hubResult.hubConfidence,
      ambiguous: hubResult.ambiguous,
      health: diag.clusterHealthById.get(c.id),
      meanSimilarity: c.meanSimilarity,
      draft: false,
    };
  });

  // For every unassigned page, find which cluster it came CLOSEST to joining
  // (even though it didn't clear the similarity bar) — an unassigned page
  // with no explanation just looks like a mistake; "38% similar to Root
  // Canal Information, needed ~45%" is something a person can act on.
  const nearestClusterFor = (pageIndex) => {
    let best = null;
    let bestSim = -1;
    for (const c of clusters) {
      if (!c.memberIndices.length) continue;
      const meanSim = c.memberIndices.reduce((s, i) => s + boostedMatrix[pageIndex][i], 0) / c.memberIndices.length;
      if (meanSim > bestSim) { bestSim = meanSim; best = c; }
    }
    return best ? { clusterId: best.id, clusterName: best.name, similarity: bestSim } : null;
  };

  const unassignedPages = unassignedIndices.map((i) => ({
    ...finalPages[i],
    nearestCluster: clusters.length ? nearestClusterFor(i) : null,
  }));

  // `code` and `source` are carried when the caller supplies them — the
  // project-linked run's informational selection does, so the report can group
  // exclusions by kind and say how each was decided.
  const excludedUrls = (crawlResult.excluded || []).map((e) => ({
    url: e.url,
    reason: e.reason,
    detail: e.detail || null,
    ...(e.code ? { code: e.code } : {}),
    ...(e.source ? { source: e.source } : {}),
  }));

  return {
    pages: finalPages,
    clusters: finalClusters,
    unassignedPages,
    excludedUrls,
    // Stated rather than left as zero orphan flags, which would read as "none".
    ...(orphanDetection ? {} : { orphanDetectionWithheld: true }),
    cannibalization: diag.cannibalization,
    crawlMeta: {
      sampled: crawlResult.sampled,
      sampleSize: crawlResult.sampleSize,
      budgetHit: crawlResult.budgetHit,
      abortedForFailureRate: crawlResult.abortedForFailureRate,
      crawlMode: crawlResult.crawlMode,
    },
    // How the analysed pages were chosen from the crawl, when a caller chose
    // them (projects/crawlToArchitect.js). Absent for the standalone flow, whose
    // pages are the URL patterns a person confirmed.
    ...(crawlResult.selection ? { selection: crawlResult.selection } : {}),
  };
}

module.exports = { runFullAnalysis, analyzeCrawledPages };
