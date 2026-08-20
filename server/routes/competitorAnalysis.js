const express = require('express');
const router = express.Router();

const { getDatabase } = require('../utils/countryToDatabase');
const jobStore = require('../services/jobStore');
const semrushCA = require('../services/semrushCA');
const { getPageSpeedForAllDomains } = require('../services/pageSpeedCA');
const gptAnalysis = require('../services/gptAnalysisCA');
const { generatePptx } = require('../services/pptxGenerator');
const { parseOrganicCSV, parseReferringDomainsCSV } = require('../services/semrushUploadParser');

// Simple UUID using crypto (no external dep)
function generateId() {
  return require('crypto').randomBytes(16).toString('hex');
}

function classifyPageType(url) {
  if (/\/blog\/|\/resources\/|\/articles?\//i.test(url)) return 'Blog / Informational';
  if (/\/location[s]?\/|\/[a-z]+-[a-z]+-[a-z]+\/$/i.test(url)) return 'Location Page';
  if (/\/service[s]?\/|\/solution[s]?\/|\/product[s]?\//i.test(url)) return 'Service / Product Page';
  if (/\/about|\/team|\/doctors?\/|\/clinician/i.test(url)) return 'Clinician / About';
  const path = url.replace(/https?:\/\/[^/]+/, '');
  if (!path || path === '/') return 'Homepage';
  return 'Other';
}

function buildRefdomainBuckets(refdomains) {
  return {
    '80+': refdomains.filter(d => d.ascore >= 80).length,
    '60-79': refdomains.filter(d => d.ascore >= 60 && d.ascore < 80).length,
    '40-59': refdomains.filter(d => d.ascore >= 40 && d.ascore < 60).length,
    '20-39': refdomains.filter(d => d.ascore >= 20 && d.ascore < 40).length,
    '0-19': refdomains.filter(d => d.ascore < 20).length,
  };
}

// ── POST /discover ────────────────────────────────────────────────────────────

router.post('/discover', async (req, res) => {
  const { brandName, targetUrl, analysisLevel, subUrl, country, dateRange, maxCompetitors = 5 } = req.body;

  if (!brandName || !targetUrl || !country) {
    return res.status(400).json({ error: 'brandName, targetUrl, and country are required.' });
  }

  const domain = targetUrl.replace(/^https?:\/\//, '').replace(/\/$/, '');
  const database = getDatabase(country);

  try {
    // Pull organic competitors from Semrush
    const semrushResults = await semrushCA.discoverCompetitors(domain, database, 20);

    if (!semrushResults.length) {
      return res.status(422).json({
        error: `No competitors found for ${domain} in the ${country} database. Try a different country or check the domain.`,
      });
    }

    // GPT validation
    const gptValidation = await gptAnalysis.validateCompetitors(brandName, domain, country, semrushResults);

    // Merge GPT reasoning into Semrush data
    const enriched = semrushResults.map(sr => {
      const gptEntry = gptValidation.find(g => g.domain === sr.domain) || {};
      return {
        ...sr,
        gptStatus: gptEntry.status || 'keep',
        gptReasoning: gptEntry.reason || '',
        competitorType: gptEntry.competitorType || 'direct',
      };
    });

    const kept = enriched
      .filter(c => c.gptStatus === 'keep')
      .sort((a, b) => b.competitionLevel - a.competitionLevel)
      .slice(0, maxCompetitors);

    const gptSummary = await gptAnalysis.generateCompetitorSummary(brandName, country, kept);

    const jobId = generateId();
    jobStore.create(jobId, {
      brandName,
      clientDomain: domain,
      analysisLevel: analysisLevel || 'domain',
      subUrl: subUrl || null,
      country,
      database,
      dateRange,
      status: 'pending',
    });

    return res.json({ jobId, competitors: kept, gptSummary });
  } catch (err) {
    console.error('[competitorAnalysis] /discover error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── POST /run ─────────────────────────────────────────────────────────────────

router.post('/run', (req, res) => {
  const { jobId, competitors } = req.body;

  if (!jobId || !competitors?.length) {
    return res.status(400).json({ error: 'jobId and competitors array are required.' });
  }

  const job = jobStore.get(jobId);
  if (!job) return res.status(404).json({ error: 'Job not found.' });

  // `req.run` is the tracked run for this request (deferred — see
  // server/config/runTracking.js). Handing it to the job lets jobStore close
  // the run out when the pipeline reaches a terminal status, which is long
  // after this response has been sent.
  jobStore.update(jobId, { competitors, status: 'running', run: req.run });

  // Kick off async data pull without awaiting
  runFullAnalysis(jobId).catch(err => {
    console.error('[competitorAnalysis] runFullAnalysis error:', err.message);
    jobStore.emit(jobId, { type: 'error', message: err.message });
    jobStore.update(jobId, { status: 'error', errorMessage: err.message });
  });

  return res.json({ status: 'running' });
});

// ── GET /progress/:jobId (SSE) ────────────────────────────────────────────────

router.get('/progress/:jobId', (req, res) => {
  const { jobId } = req.params;
  const job = jobStore.get(jobId);

  if (!job) {
    res.setHeader('Content-Type', 'application/json');
    return res.status(404).json({ error: 'Job not found.' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const send = (event) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  // Replay historical events
  const currentJob = jobStore.get(jobId);
  (currentJob.events || []).forEach(send);

  // If already done/error, close immediately
  if (currentJob.status === 'done' || currentJob.status === 'error') {
    return res.end();
  }

  // Subscribe to future events
  const listener = (event) => {
    send(event);
    if (event.type === 'done' || event.type === 'error') {
      cleanup();
      res.end();
    }
  };

  currentJob.emitter.on('event', listener);

  // Heartbeat to keep connection alive
  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, 20000);

  function cleanup() {
    clearInterval(heartbeat);
    const j = jobStore.get(jobId);
    if (j) j.emitter.off('event', listener);
  }

  req.on('close', cleanup);
});

// ── GET /export/:jobId ────────────────────────────────────────────────────────

router.get('/export/:jobId', async (req, res) => {
  const { jobId } = req.params;
  const job = jobStore.get(jobId);

  if (!job) return res.status(404).json({ error: 'Job not found.' });
  if (job.status !== 'done') return res.status(409).json({ error: 'Report is not ready yet.' });

  try {
    const buffer = await generatePptx(job.reportData || {});
    const filename = `${(job.brandName || 'Competitor_Analysis').replace(/\s+/g, '_')}_Competitor_Analysis.pptx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  } catch (err) {
    console.error('[competitorAnalysis] /export error:', err.message);
    res.status(500).json({ error: 'PPTX generation failed: ' + err.message });
  }
});

// ── GET /countries ────────────────────────────────────────────────────────────

router.get('/countries', (req, res) => {
  const { COUNTRY_LIST } = require('../utils/countryToDatabase');
  res.json({ countries: COUNTRY_LIST });
});

// ── POST /prepare (manual mode — creates job without Semrush) ─────────────────

router.post('/prepare', (req, res) => {
  const { brandName, targetUrl, country, dateRange, analysisLevel, subUrl } = req.body;
  if (!brandName || !targetUrl || !country) {
    return res.status(400).json({ error: 'brandName, targetUrl, and country are required.' });
  }
  const domain = targetUrl.replace(/^https?:\/\//, '').replace(/\/$/, '');
  const database = getDatabase(country);
  const jobId = generateId();
  jobStore.create(jobId, {
    brandName,
    clientDomain: domain,
    analysisLevel: analysisLevel || 'domain',
    subUrl: subUrl || null,
    country,
    database,
    dateRange,
    mode: 'manual',
    status: 'pending',
  });
  return res.json({ jobId });
});

// ── POST /run-manual ──────────────────────────────────────────────────────────
// Payload shape:
//   positionFiles:   { [domain]: csvText }   — required, one per domain
//   refdomainFiles:  { [domain]: csvText }   — optional
//   authorityScores: { [domain]: number }    — optional

router.post('/run-manual', (req, res) => {
  const { jobId, competitors, positionFiles, refdomainFiles = {}, authorityScores = {} } = req.body;

  if (!jobId || !positionFiles || !Object.keys(positionFiles).length) {
    return res.status(400).json({ error: 'jobId and positionFiles are required.' });
  }

  const job = jobStore.get(jobId);
  if (!job) return res.status(404).json({ error: 'Job not found.' });

  const parseErrors = [];

  // Parse organic positions
  const domainKwMap = {};
  for (const [domain, csvText] of Object.entries(positionFiles)) {
    const result = parseOrganicCSV(csvText);
    if (!Array.isArray(result)) {
      parseErrors.push(`Positions (${domain}): ${result.error}`);
    } else {
      domainKwMap[domain] = result;
    }
  }

  // Parse referring domains (optional — skip on error, just log)
  const domainBlMap = {};
  for (const [domain, csvText] of Object.entries(refdomainFiles)) {
    if (!csvText) continue;
    const result = parseReferringDomainsCSV(csvText);
    if (result.error) {
      parseErrors.push(`Referring Domains (${domain}): ${result.error}`);
    } else {
      domainBlMap[domain] = result;
    }
  }

  if (parseErrors.length) {
    return res.status(422).json({ error: parseErrors.join('\n') });
  }

  jobStore.update(jobId, { competitors, status: 'running', run: req.run });

  runManualAnalysis(jobId, domainKwMap, domainBlMap, authorityScores).catch(err => {
    console.error('[CA] runManualAnalysis error:', err.message);
    jobStore.emit(jobId, { type: 'error', message: err.message });
    jobStore.update(jobId, { status: 'error', errorMessage: err.message });
  });

  return res.json({ status: 'running' });
});

// ── Full analysis pipeline ────────────────────────────────────────────────────

async function runFullAnalysis(jobId) {
  const job = jobStore.get(jobId);
  if (!job) throw new Error('Job not found');

  const {
    brandName, clientDomain, database, country, competitors,
    dateRange, analysisLevel, subUrl,
  } = job;

  const allDomains = [clientDomain, ...competitors.map(c => c.domain)];
  const emit = (event) => jobStore.emit(jobId, event);

  const sections = {};
  const gptDrafts = {};

  function startSection(id, label) {
    emit({ type: 'section_start', section: id, label });
  }
  function doneSection(id, progress) {
    emit({ type: 'section_done', section: id, progress });
  }

  // Helper: format overall metrics for GPT summary
  function formatTableForGPT(headers, rows) {
    const h = headers.join(' | ');
    const lines = rows.map(r => r.join(' | '));
    return [h, ...lines].join('\n');
  }

  // ── Section 1: Overall Performance ─────────────────────────────────────────
  startSection('overallMetrics', 'Overall Performance Metrics');
  try {
    const [rankResults, backlinkResults] = await Promise.all([
      Promise.allSettled(allDomains.map(d => semrushCA.getDomainRank(d, database))),
      Promise.allSettled(allDomains.map(d => semrushCA.getBacklinksOverview(d))),
    ]);

    // AIO will come from section 6 but we pre-fetch totals here for performance table
    const overallMetrics = allDomains.map((domain, i) => {
      const rank = rankResults[i].status === 'fulfilled' ? rankResults[i].value : null;
      const bl = backlinkResults[i].status === 'fulfilled' ? backlinkResults[i].value : null;
      return {
        domain,
        isClient: domain === clientDomain,
        authorityScore: rank?.authorityScore ?? bl?.authorityScore ?? 0,
        organicKeywords: rank?.organicKeywords ?? 0,
        organicTraffic: rank?.organicTraffic ?? 0,
        backlinks: bl?.totalBacklinks ?? 0,
        referringDomains: bl?.referringDomains ?? 0,
        aiOverviewKeywords: 0, // filled in section 6
      };
    });

    sections.overallMetrics = overallMetrics;

    const gptTable = formatTableForGPT(
      ['Domain', 'Auth Score', 'Traffic', 'Keywords', 'Backlinks', 'Ref Domains'],
      overallMetrics.map(d => [d.domain, d.authorityScore, d.organicTraffic, d.organicKeywords, d.backlinks, d.referringDomains])
    );
    gptDrafts.overallMetrics = await gptAnalysis.generateObsRecs(
      'Overall Performance Metrics', brandName, country, dateRange, gptTable
    );
  } catch (err) {
    console.error('[CA] overallMetrics error:', err.message);
    sections.overallMetrics = [];
    gptDrafts.overallMetrics = '• Could not retrieve overall metrics.\n→ Check Semrush API key and try again.';
  }
  doneSection('overallMetrics', 12);

  // ── Section 2: Page Speed ───────────────────────────────────────────────────
  startSection('pageSpeed', 'Page Speed Analysis');
  try {
    sections.pageSpeed = await getPageSpeedForAllDomains(allDomains);

    const gptTable = formatTableForGPT(
      ['Domain', 'Mobile Score', 'Desktop Score', 'LCP', 'CLS', 'Core Web Vitals'],
      sections.pageSpeed.map(d => [
        d.domain, d.mobile?.score ?? 'N/A', d.desktop?.score ?? 'N/A',
        d.mobile?.lcp ?? 'N/A', d.mobile?.cls ?? 'N/A',
        d.coreWebVitalsPassed ? 'Pass' : 'Fail',
      ])
    );
    gptDrafts.pageSpeed = await gptAnalysis.generateObsRecs(
      'Page Speed Analysis', brandName, country, dateRange, gptTable
    );
  } catch (err) {
    console.error('[CA] pageSpeed error:', err.message);
    sections.pageSpeed = [];
    gptDrafts.pageSpeed = '• Page speed data unavailable.\n→ Run PageSpeed Insights manually.';
  }
  doneSection('pageSpeed', 25);

  // ── Shared keyword fetch (used by sections 3 & 4) ──────────────────────────
  // Pull once per domain at 3,000 rows (30,000 units/domain vs 170,000+ previously).
  // Position buckets and branded counts are computed locally from this data.
  let sharedKwData = [];
  try {
    const sharedKwResults = await Promise.allSettled(
      allDomains.map(d => semrushCA.getKeywordsFull(d, database, 3000))
    );
    sharedKwData = sharedKwResults.map((r, i) => ({
      domain: allDomains[i],
      keywords: r.status === 'fulfilled' ? r.value : [],
    }));
  } catch (err) {
    console.error('[CA] shared keyword fetch error:', err.message);
    sharedKwData = allDomains.map(d => ({ domain: d, keywords: [] }));
  }

  // ── Section 3: Keyword Ranking ──────────────────────────────────────────────
  startSection('keywordRanking', 'Keyword Ranking Comparison');
  try {
    const brandLower = brandName.toLowerCase();

    const kwRanking = sharedKwData.map(({ domain, keywords }, i) => {
      const rank = sections.overallMetrics?.[i] || null;
      const page1 = keywords.filter(k => k.position >= 1 && k.position <= 10).length;
      const page2 = keywords.filter(k => k.position >= 11 && k.position <= 20).length;
      const page3to5 = keywords.filter(k => k.position >= 21 && k.position <= 50).length;
      // Use domain_rank total if available (more accurate than capped sample)
      const total = (rank?.organicKeywords > 0 ? rank.organicKeywords : null) ?? keywords.length;
      const branded = keywords.filter(k => k.keyword.toLowerCase().includes(brandLower)).length;
      const nonBranded = Math.max(0, total - branded);

      return {
        domain,
        page1,
        page2,
        page3to5,
        totalOrganic: total,
        branded,
        nonBranded,
        nonBrandedPct: total > 0 ? Math.round((nonBranded / total) * 100) : 0,
      };
    });

    sections.keywordRanking = kwRanking;

    const gptTable = formatTableForGPT(
      ['Domain', 'Page 1', 'Page 2', 'Pages 3-5', 'Total', 'Non-Branded %'],
      kwRanking.map(d => [d.domain, d.page1, d.page2, d.page3to5, d.totalOrganic, `${d.nonBrandedPct}%`])
    );
    gptDrafts.keywordRanking = await gptAnalysis.generateObsRecs(
      'Keyword Ranking Comparison', brandName, country, dateRange, gptTable
    );
  } catch (err) {
    console.error('[CA] keywordRanking error:', err.message);
    sections.keywordRanking = [];
    gptDrafts.keywordRanking = '• Keyword ranking data unavailable.\n→ Check Semrush API limits.';
  }
  doneSection('keywordRanking', 40);

  // ── Section 4: Keyword Gap ──────────────────────────────────────────────────
  startSection('keywordGap', 'Keyword Gap Analysis');
  try {
    const clientKws = sharedKwData[0]?.keywords || [];
    const clientMap = new Map(clientKws.map(k => [k.keyword, k]));

    // Build competitor top-10 map: keyword → { position, domain }
    const competitorTop10Map = new Map();
    sharedKwData.slice(1).forEach(({ domain, keywords }) => {
      keywords.filter(k => k.position <= 10).forEach(k => {
        const existing = competitorTop10Map.get(k.keyword);
        if (!existing || k.position < existing.position) {
          competitorTop10Map.set(k.keyword, { position: k.position, domain, volume: k.volume });
        }
      });
    });

    const strikingDistance = clientKws
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

    sections.keywordGap = { strikingDistance, untapped, missing };

    const gptSummary = [
      `Striking distance keywords (client pos 11-50, competitor top 10): ${strikingDistance.length}`,
      `Untapped keywords (competitor top 10, client weak/absent): ${untapped.length}`,
      `Missing keywords (competitor top 10, client not ranking): ${missing.length}`,
      strikingDistance.slice(0, 5).map(k => `  - "${k.keyword}" (vol: ${k.searchVolume}, client: #${k.clientPosition}, competitor: #${k.bestCompetitorPosition} @ ${k.bestCompetitorDomain})`).join('\n'),
    ].join('\n');

    gptDrafts.keywordGap = await gptAnalysis.generateObsRecs(
      'Keyword Gap Analysis', brandName, country, dateRange, gptSummary
    );
  } catch (err) {
    console.error('[CA] keywordGap error:', err.message);
    sections.keywordGap = { strikingDistance: [], untapped: [], missing: [] };
    gptDrafts.keywordGap = '• Keyword gap data unavailable.\n→ Check Semrush API limits.';
  }
  doneSection('keywordGap', 58);

  // ── Section 5: Backlinks ────────────────────────────────────────────────────
  startSection('backlinks', 'Backlink & Authority Analysis');
  try {
    const [overviewResults, refdomainResults] = await Promise.all([
      Promise.allSettled(allDomains.map(d => semrushCA.getBacklinksOverview(d))),
      Promise.allSettled(allDomains.map(d => semrushCA.getBacklinksRefdomains(d))),
    ]);

    sections.backlinks = allDomains.map((domain, i) => {
      const ov = overviewResults[i].status === 'fulfilled' ? overviewResults[i].value : null;
      const rd = refdomainResults[i].status === 'fulfilled' ? refdomainResults[i].value : [];
      return {
        domain,
        authorityScore: ov?.authorityScore ?? 0,
        totalBacklinks: ov?.totalBacklinks ?? 0,
        referringDomains: ov?.referringDomains ?? 0,
        followLinks: ov?.followLinks ?? 0,
        nofollowLinks: ov?.nofollowLinks ?? 0,
        buckets: buildRefdomainBuckets(rd),
      };
    });

    const gptTable = formatTableForGPT(
      ['Domain', 'Auth Score', 'Backlinks', 'Ref Domains', 'Follow', 'NoFollow'],
      sections.backlinks.map(d => [d.domain, d.authorityScore, d.totalBacklinks, d.referringDomains, d.followLinks, d.nofollowLinks])
    );
    gptDrafts.backlinks = await gptAnalysis.generateObsRecs(
      'Backlink & Authority Analysis', brandName, country, dateRange, gptTable
    );
  } catch (err) {
    console.error('[CA] backlinks error:', err.message);
    sections.backlinks = [];
    gptDrafts.backlinks = '• Backlink data unavailable.\n→ Check Semrush API limits.';
  }
  doneSection('backlinks', 70);

  // ── Section 6: AI Overview ──────────────────────────────────────────────────
  startSection('aiOverview', 'AI Overview Visibility');
  try {
    const aioResults = await Promise.allSettled(
      allDomains.map(d => semrushCA.getAIOKeywords(d, database))
    );

    sections.aiOverview = allDomains.map((domain, i) => {
      const r = aioResults[i].status === 'fulfilled' ? aioResults[i].value : { count: 0, keywords: [] };
      return { domain, count: r.count, keywords: r.keywords };
    });

    // Update overall metrics with AIO counts
    if (sections.overallMetrics?.length) {
      sections.overallMetrics = sections.overallMetrics.map(om => {
        const aio = sections.aiOverview.find(a => a.domain === om.domain);
        return { ...om, aiOverviewKeywords: aio?.count ?? 0 };
      });
    }

    const gptSummary = sections.aiOverview.map(d => `${d.domain}: ${d.count} AIO keywords`).join('\n');
    gptDrafts.aiOverview = await gptAnalysis.generateObsRecs(
      'AI Overview Visibility', brandName, country, dateRange, gptSummary
    );
  } catch (err) {
    console.error('[CA] aiOverview error:', err.message);
    sections.aiOverview = allDomains.map(d => ({ domain: d, count: 0, keywords: [] }));
    gptDrafts.aiOverview = '• AI Overview data unavailable. This feature may require a Semrush plan with SERP feature filtering.\n→ Check keyword-level SERP features manually for priority keywords.';
  }
  doneSection('aiOverview', 80);

  // ── Section 7: Content Analysis ─────────────────────────────────────────────
  startSection('contentAnalysis', 'Content Analysis');
  try {
    const topPagesResults = await Promise.allSettled(
      allDomains.map(d => semrushCA.getTopPages(d, database, 10))
    );

    sections.contentAnalysis = allDomains.map((domain, i) => {
      const pages = topPagesResults[i].status === 'fulfilled' ? topPagesResults[i].value : [];
      const totalTraffic = pages.reduce((sum, p) => sum + (p.traffic || 0), 0);
      const pagesWithType = pages.map(p => ({
        ...p,
        type: classifyPageType(p.url),
        trafficShare: totalTraffic > 0 ? Math.round((p.traffic / totalTraffic) * 100) : 0,
      }));
      const contentMix = pagesWithType.reduce((acc, p) => {
        acc[p.type] = (acc[p.type] || 0) + 1;
        return acc;
      }, {});
      return { domain, topPages: pagesWithType, contentMix };
    });

    const gptSummary = sections.contentAnalysis.map(d => {
      const mix = Object.entries(d.contentMix).map(([k, v]) => `${k}: ${v}`).join(', ');
      return `${d.domain} — content mix: ${mix || 'N/A'}`;
    }).join('\n');
    gptDrafts.contentAnalysis = await gptAnalysis.generateObsRecs(
      'Content Analysis', brandName, country, dateRange, gptSummary
    );
  } catch (err) {
    console.error('[CA] contentAnalysis error:', err.message);
    sections.contentAnalysis = [];
    gptDrafts.contentAnalysis = '• Content analysis data unavailable.\n→ Check Semrush API limits.';
  }
  doneSection('contentAnalysis', 90);

  // ── Executive Summary ───────────────────────────────────────────────────────
  emit({ type: 'section_start', section: 'executiveSummary', label: 'Generating Executive Summary' });
  const executiveSummary = await gptAnalysis.generateExecutiveSummary(brandName, gptDrafts);
  doneSection('executiveSummary', 95);

  // ── PPTX ─────────────────────────────────────────────────────────────────────
  emit({ type: 'section_start', section: 'pptx', label: 'Building PPTX' });

  const reportData = {
    brandName,
    clientDomain,
    competitors,
    sections,
    gptDrafts,
    executiveSummary,
    dateRange,
    country,
  };

  jobStore.update(jobId, { reportData, status: 'done' });
  doneSection('pptx', 100);

  emit({ type: 'done', reportData });
}

// ── Manual analysis pipeline (sourced from uploaded CSVs) ─────────────────────

async function runManualAnalysis(jobId, domainKwMap, domainBlMap, authorityScores) {
  const job = jobStore.get(jobId);
  if (!job) throw new Error('Job not found');

  const { brandName, clientDomain, competitors, country, dateRange } = job;
  const allDomains = [clientDomain, ...competitors.map(c => c.domain)];
  const emit = event => jobStore.emit(jobId, event);
  const sections = {};
  const gptDrafts = {};
  const brandLower = brandName.toLowerCase();

  function startSection(id, label) { emit({ type: 'section_start', section: id, label }); }
  function doneSection(id, progress) { emit({ type: 'section_done', section: id, progress }); }
  function kws(domain) { return domainKwMap[domain] || []; }
  function bl(domain) { return domainBlMap[domain] || null; }
  function as(domain) { return parseInt(authorityScores[domain]) || null; }
  function formatTableForGPT(headers, rows) {
    return [headers.join(' | '), ...rows.map(r => r.join(' | '))].join('\n');
  }

  // ── Section 1: Overall Performance ─────────────────────────────────────────
  startSection('overallMetrics', 'Overall Performance Metrics');
  sections.overallMetrics = allDomains.map(domain => {
    const keywords    = kws(domain);
    const blData      = bl(domain);
    const totalTraffic = keywords.reduce((s, k) => s + k.traffic, 0);
    return {
      domain,
      isClient: domain === clientDomain,
      authorityScore:   as(domain),
      organicKeywords:  keywords.length,
      organicTraffic:   Math.round(totalTraffic),
      backlinks:        blData?.totalBacklinks ?? null,
      referringDomains: blData?.referringDomains ?? null,
      aiOverviewKeywords: 0,
    };
  });
  gptDrafts.overallMetrics = await gptAnalysis.generateObsRecs(
    'Overall Performance Metrics', brandName, country, dateRange,
    formatTableForGPT(
      ['Domain', 'Auth Score', 'Organic Keywords', 'Est. Traffic', 'Backlinks', 'Ref Domains'],
      sections.overallMetrics.map(d => [
        d.domain,
        d.authorityScore ?? 'N/A',
        d.organicKeywords,
        d.organicTraffic,
        d.backlinks ?? 'N/A',
        d.referringDomains ?? 'N/A',
      ])
    )
  );
  doneSection('overallMetrics', 12);

  // ── Section 2: Page Speed (Google PSI — free, no Semrush) ──────────────────
  startSection('pageSpeed', 'Page Speed Analysis');
  try {
    sections.pageSpeed = await getPageSpeedForAllDomains(allDomains);
    gptDrafts.pageSpeed = await gptAnalysis.generateObsRecs(
      'Page Speed Analysis', brandName, country, dateRange,
      formatTableForGPT(
        ['Domain', 'Mobile Score', 'Desktop Score', 'LCP', 'CLS', 'Core Web Vitals'],
        sections.pageSpeed.map(d => [
          d.domain, d.mobile?.score ?? 'N/A', d.desktop?.score ?? 'N/A',
          d.mobile?.lcp ?? 'N/A', d.mobile?.cls ?? 'N/A',
          d.coreWebVitalsPassed ? 'Pass' : 'Fail',
        ])
      )
    );
  } catch {
    sections.pageSpeed = [];
    gptDrafts.pageSpeed = '• Page speed data unavailable.';
  }
  doneSection('pageSpeed', 25);

  // ── Section 3: Keyword Ranking ──────────────────────────────────────────────
  startSection('keywordRanking', 'Keyword Ranking Comparison');
  sections.keywordRanking = allDomains.map(domain => {
    const keywords   = kws(domain);
    const page1      = keywords.filter(k => k.position <= 10).length;
    const page2      = keywords.filter(k => k.position >= 11 && k.position <= 20).length;
    const page3to5   = keywords.filter(k => k.position >= 21 && k.position <= 50).length;
    const total      = keywords.length;
    const branded    = keywords.filter(k => k.keyword.toLowerCase().includes(brandLower)).length;
    const nonBranded = Math.max(0, total - branded);
    return {
      domain, page1, page2, page3to5, totalOrganic: total,
      branded, nonBranded,
      nonBrandedPct: total > 0 ? Math.round((nonBranded / total) * 100) : 0,
    };
  });
  gptDrafts.keywordRanking = await gptAnalysis.generateObsRecs(
    'Keyword Ranking Comparison', brandName, country, dateRange,
    formatTableForGPT(
      ['Domain', 'Page 1', 'Page 2', 'Pages 3-5', 'Total', 'Non-Branded %'],
      sections.keywordRanking.map(d => [d.domain, d.page1, d.page2, d.page3to5, d.totalOrganic, `${d.nonBrandedPct}%`])
    )
  );
  doneSection('keywordRanking', 40);

  // ── Section 4: Keyword Gap ──────────────────────────────────────────────────
  startSection('keywordGap', 'Keyword Gap Analysis');
  const clientKws = kws(clientDomain);
  const clientMap = new Map(clientKws.map(k => [k.keyword, k]));

  const competitorTop10Map = new Map();
  competitors.forEach(c => {
    kws(c.domain).filter(k => k.position <= 10).forEach(k => {
      const existing = competitorTop10Map.get(k.keyword);
      if (!existing || k.position < existing.position) {
        competitorTop10Map.set(k.keyword, { position: k.position, domain: c.domain, volume: k.volume });
      }
    });
  });

  const strikingDistance = clientKws
    .filter(k => k.position >= 11 && k.position <= 50 && competitorTop10Map.has(k.keyword))
    .sort((a, b) => b.volume - a.volume).slice(0, 25)
    .map(k => {
      const comp = competitorTop10Map.get(k.keyword);
      return { keyword: k.keyword, searchVolume: k.volume, clientPosition: k.position, bestCompetitorPosition: comp.position, bestCompetitorDomain: comp.domain };
    });

  const untapped = [];
  for (const [kw, comp] of competitorTop10Map.entries()) {
    const ck = clientMap.get(kw);
    if (!ck || ck.position > 50) {
      untapped.push({ keyword: kw, searchVolume: comp.volume, clientPosition: ck?.position || null, bestCompetitorPosition: comp.position, bestCompetitorDomain: comp.domain });
    }
  }
  untapped.sort((a, b) => b.searchVolume - a.searchVolume);
  untapped.splice(25);

  const missing = [];
  for (const [kw, comp] of competitorTop10Map.entries()) {
    if (!clientMap.has(kw)) {
      missing.push({ keyword: kw, searchVolume: comp.volume, bestCompetitorPosition: comp.position, bestCompetitorDomain: comp.domain });
    }
  }
  missing.sort((a, b) => b.searchVolume - a.searchVolume);
  missing.splice(25);

  sections.keywordGap = { strikingDistance, untapped, missing };
  gptDrafts.keywordGap = await gptAnalysis.generateObsRecs(
    'Keyword Gap Analysis', brandName, country, dateRange,
    [
      `Striking distance: ${strikingDistance.length}`,
      `Untapped: ${untapped.length}`,
      `Missing: ${missing.length}`,
      strikingDistance.slice(0, 5).map(k => `  - "${k.keyword}" (vol: ${k.searchVolume}, client: #${k.clientPosition}, competitor: #${k.bestCompetitorPosition} @ ${k.bestCompetitorDomain})`).join('\n'),
    ].join('\n')
  );
  doneSection('keywordGap', 58);

  // ── Section 5: Backlinks ────────────────────────────────────────────────────
  startSection('backlinks', 'Backlink & Authority Analysis');
  const hasAnyBlData = allDomains.some(d => bl(d) !== null);
  sections.backlinks = allDomains.map(domain => {
    const blData = bl(domain);
    return {
      domain,
      authorityScore:   as(domain),
      totalBacklinks:   blData?.totalBacklinks ?? null,
      referringDomains: blData?.referringDomains ?? null,
      followLinks:      blData?.followLinks ?? null,
      nofollowLinks:    blData?.nofollowLinks ?? null,
      buckets:          blData?.buckets ?? null,
      dataUnavailable:  blData === null && as(domain) === null,
    };
  });
  if (hasAnyBlData) {
    gptDrafts.backlinks = await gptAnalysis.generateObsRecs(
      'Backlink & Authority Analysis', brandName, country, dateRange,
      formatTableForGPT(
        ['Domain', 'Auth Score', 'Backlinks', 'Ref Domains', 'Follow', 'NoFollow'],
        sections.backlinks.map(d => [
          d.domain,
          d.authorityScore ?? 'N/A',
          d.totalBacklinks ?? 'N/A',
          d.referringDomains ?? 'N/A',
          d.followLinks ?? 'N/A',
          d.nofollowLinks ?? 'N/A',
        ])
      )
    );
  } else {
    gptDrafts.backlinks = '• Backlink data not provided.\n→ Upload a Referring Domains CSV per domain to populate this section.';
  }
  doneSection('backlinks', 70);

  // ── Section 6: AI Overview ──────────────────────────────────────────────────
  startSection('aiOverview', 'AI Overview Visibility');
  sections.aiOverview = allDomains.map(domain => {
    const aioKws = kws(domain).filter(k => {
      const fp = k.serpFeatures.toLowerCase();
      return fp.includes('ai overview') || fp.includes('ai_overview');
    });
    return { domain, count: aioKws.length, keywords: aioKws.slice(0, 20).map(k => ({ keyword: k.keyword, position: k.position, volume: k.volume })) };
  });
  sections.overallMetrics = sections.overallMetrics.map(om => {
    const aio = sections.aiOverview.find(a => a.domain === om.domain);
    return { ...om, aiOverviewKeywords: aio?.count ?? 0 };
  });
  gptDrafts.aiOverview = await gptAnalysis.generateObsRecs(
    'AI Overview Visibility', brandName, country, dateRange,
    sections.aiOverview.map(d => `${d.domain}: ${d.count} AIO keywords`).join('\n')
  );
  doneSection('aiOverview', 80);

  // ── Section 7: Content Analysis ─────────────────────────────────────────────
  startSection('contentAnalysis', 'Content Analysis');
  sections.contentAnalysis = allDomains.map(domain => {
    const pageMap = new Map();
    kws(domain).forEach(k => {
      const url = k.url ? (k.url.replace(/^https?:\/\/[^/]+/, '') || '/') : '/';
      if (!pageMap.has(url)) pageMap.set(url, { url, keywords: 0, totalVolume: 0, totalTraffic: 0 });
      const p = pageMap.get(url);
      p.keywords++;
      p.totalVolume += k.volume;
      p.totalTraffic += k.traffic;
    });
    const pages = Array.from(pageMap.values()).sort((a, b) => b.totalTraffic - a.totalTraffic).slice(0, 10);
    const totalTraffic = pages.reduce((s, p) => s + p.totalTraffic, 0);
    const topPages = pages.map(p => ({
      url: p.url, traffic: Math.round(p.totalTraffic), keywords: p.keywords,
      trafficShare: totalTraffic > 0 ? Math.round((p.totalTraffic / totalTraffic) * 100) : 0,
      type: classifyPageType(p.url),
    }));
    const contentMix = topPages.reduce((acc, p) => { acc[p.type] = (acc[p.type] || 0) + 1; return acc; }, {});
    return { domain, topPages, contentMix };
  });
  gptDrafts.contentAnalysis = await gptAnalysis.generateObsRecs(
    'Content Analysis', brandName, country, dateRange,
    sections.contentAnalysis.map(d => {
      const mix = Object.entries(d.contentMix).map(([k, v]) => `${k}: ${v}`).join(', ');
      return `${d.domain} — content mix: ${mix || 'N/A'}`;
    }).join('\n')
  );
  doneSection('contentAnalysis', 90);

  // ── Executive Summary ───────────────────────────────────────────────────────
  emit({ type: 'section_start', section: 'executiveSummary', label: 'Generating Executive Summary' });
  const executiveSummary = await gptAnalysis.generateExecutiveSummary(brandName, gptDrafts);
  doneSection('executiveSummary', 95);

  // ── Done ─────────────────────────────────────────────────────────────────────
  emit({ type: 'section_start', section: 'pptx', label: 'Building PPTX' });
  const reportData = { brandName, clientDomain, competitors, sections, gptDrafts, executiveSummary, dateRange, country, dataSource: 'manual' };
  jobStore.update(jobId, { reportData, status: 'done' });
  doneSection('pptx', 100);
  emit({ type: 'done', reportData });
}

module.exports = router;
