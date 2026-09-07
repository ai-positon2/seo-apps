const { getDatabase } = require('../../../utils/countryToDatabase');
const { hasSemrushKey } = require('../provider');
const { createLlmClient, WRITER_MODEL_ID } = require('../../../services/llmProviders');
const { crawlSitemaps } = require('./sitemapAnalyzer');
const { fetchTopPages } = require('./topPagesAnalyzer');
const { classifyTemplates } = require('./templateClassifier');
const {
  extractTemplates, mapByTemplate, resolveType,
  countsFromTemplateCounts, countsFromPages,
} = require('./folderMapping');
const { summarizeTopPages, summarizeSitemapStructure } = require('./summarizer');
const { isValidType } = require('./taxonomy');
const { classifyTopPages, MODEL: CLASSIFIER_MODEL, CLASSIFIER_VERSION } = require('./pageClassifier');
const { TAXONOMY_VERSION, familyOf } = require('./pageTaxonomy');
const { TOP_PAGES_COST, MAX_UNITS_PER_RUN } = require('./unitCosts');

function domainEntriesFor(client) {
  return [
    { domain: client.domain, label: client.name, isClient: true },
    ...client.competitors.map((c) => ({ domain: c.domain, label: c.label, isClient: false })),
  ];
}

// GPT (templateClassifier) drives every type decision, but its output is
// arranged so a human can see and correct it: the folder map is a flat,
// editable list of pattern → type, user edits win over GPT and persist across
// re-runs (userOverrides), and unchanged patterns are served from the prior
// run's cache so re-runs re-classify only genuinely new folders.
// ── One page's stored classification ───────────────────────────────────────
//
// The spec's per-URL columns, written on the page row itself. `contentType`
// carries the subtype as well, because the table, the counts and the composition
// bar all read that field — the taxonomy changed underneath them, not the shape
// they read.
//
// A page with no model result is stored as `unclassified` WITH a reason rather
// than left holding a stale type. That is the difference between "we could not
// classify this" and "this is other", which the previous taxonomy could not say.
function storedClassification(page, result, byTemplate, userTemplates, resolveTemplateType) {
  // A folder mapping the user edited by hand still outranks the classifier.
  if (userTemplates.has(page.template)) {
    const subtype = resolveTemplateType(page.template, byTemplate);
    return {
      contentType: subtype,
      type: familyOf(subtype),
      subtype,
      type_secondary: null,
      subtype_secondary: null,
      confidence: 1,
      reason: null,
      signals: [{ rule: 'user_override', detail: `folder mapping "${page.template}" was set by hand`, from: 'user' }],
      facets: null,
      taxonomy_version: TAXONOMY_VERSION,
      classifier_version: CLASSIFIER_VERSION,
      classified_at: new Date().toISOString(),
    };
  }
  if (result) {
    return {
      contentType: result.subtype,
      type: result.type,
      subtype: result.subtype,
      type_secondary: result.type_secondary,
      subtype_secondary: result.subtype_secondary,
      confidence: result.confidence,
      reason: result.reason,
      signals: result.signals,
      facets: result.facets,
      taxonomy_version: result.taxonomy_version,
      classifier_version: result.classifier_version,
      classified_at: result.classified_at,
    };
  }
  return {
    contentType: 'unclassified',
    type: 'fallback',
    subtype: 'unclassified',
    type_secondary: null,
    subtype_secondary: null,
    confidence: 0,
    reason: 'Page-level classification did not run for this page.',
    signals: [],
    facets: null,
    taxonomy_version: TAXONOMY_VERSION,
    classifier_version: CLASSIFIER_VERSION,
    classified_at: null,
  };
}

async function runContentAnalysis(client, previous) {
  const allEntries = domainEntriesFor(client);
  const database = getDatabase(client.country);
  const writerClient = createLlmClient(WRITER_MODEL_ID);
  const enabled = hasSemrushKey();

  // ── Fetch (Part 2 always; Part 1 needs SEMrush + fits its own budget) ──
  const sitemapRaw = await crawlSitemaps(allEntries);

  let topRaw = [];
  const topPagesSkipped = [];
  if (enabled) {
    const included = [];
    let usedUnits = 0;
    for (const entry of allEntries) {
      if (usedUnits + TOP_PAGES_COST > MAX_UNITS_PER_RUN) { topPagesSkipped.push(entry.domain); continue; }
      included.push(entry);
      usedUnits += TOP_PAGES_COST;
    }
    topRaw = await fetchTopPages(included, database);
  }
  const topByDomain = new Map(topRaw.map((d) => [d.domain, d]));

  // ── Template extraction (per domain, over its sitemap + top-page URLs) ──
  const globalTemplates = new Map(); // template -> { example, count }
  const sitemapTemplateCounts = new Map(); // domain -> { template: count }
  const taggedTopPages = new Map(); // domain -> pages[] with .template

  for (const s of sitemapRaw) {
    const top = topByDomain.get(s.domain);
    const sitemapUrls = s.urls || [];
    const topFullUrls = (top?.pages || []).map((p) => p.fullUrl);
    const { urlTemplate } = extractTemplates([...sitemapUrls, ...topFullUrls]);

    const perTemplate = {};
    for (const u of sitemapUrls) {
      const t = urlTemplate.get(u);
      perTemplate[t] = (perTemplate[t] || 0) + 1;
    }
    sitemapTemplateCounts.set(s.domain, perTemplate);

    if (top) {
      taggedTopPages.set(s.domain, top.pages.map((p) => ({ ...p, template: urlTemplate.get(p.fullUrl) })));
    }

    for (const [u, t] of urlTemplate) {
      const g = globalTemplates.get(t) || { example: u, count: 0 };
      g.count += 1;
      globalTemplates.set(t, g);
    }
  }

  // ── Classify: cache (prior run) + user overrides + GPT for new only ──
  const cache = new Map((previous?.folderMap || []).map((e) => [e.template, e]));
  const userOverrides = { ...(previous?.userOverrides || {}) };

  const allTemplates = [...globalTemplates.keys()];
  const needGpt = allTemplates
    .filter((t) => !cache.has(t) && !(t in userOverrides))
    .map((t) => ({ template: t, example: globalTemplates.get(t).example, count: globalTemplates.get(t).count }));
  const gptMap = needGpt.length ? await classifyTemplates(writerClient, needGpt) : new Map();

  const folderMap = allTemplates
    .sort((a, b) => globalTemplates.get(b).count - globalTemplates.get(a).count)
    .map((t) => {
      let type, source;
      if (t in userOverrides && isValidType(userOverrides[t])) { type = userOverrides[t]; source = 'user'; }
      else if (gptMap.has(t)) { type = gptMap.get(t); source = 'gpt'; }
      else if (cache.has(t)) { type = cache.get(t).type; source = cache.get(t).source || 'gpt'; }
      else { type = 'other'; source = 'gpt'; }
      return { template: t, example: globalTemplates.get(t).example, count: globalTemplates.get(t).count, type, source };
    });

  const byTemplate = mapByTemplate(folderMap);
  const now = new Date().toISOString();

  // ── Fan out to per-domain counts (raw sitemap URLs are NOT persisted) ──
  const sitemapDomains = sitemapRaw.map((s) => {
    const templateCounts = sitemapTemplateCounts.get(s.domain) || {};
    return {
      domain: s.domain, label: s.label, isClient: s.isClient,
      sitemapUrl: s.sitemapUrl, sitemapStatus: s.sitemapStatus, totalUrls: s.totalUrls,
      capped: s.capped, error: s.error,
      templateCounts,
      pageTypeCounts: countsFromTemplateCounts(templateCounts, byTemplate),
    };
  });

  // ── Top pages: classified as pages, not as folder patterns ────────────────
  //
  // Every URL in this table goes to Claude Sonnet 5 with its title, and comes
  // back typed individually. The table is bounded by the analysis itself — 25
  // pages per domain over at most 5 domains, so 125 URLs — which is what makes
  // reading them directly affordable. The sitemap breakdown below still runs on
  // the folder map, because it covers thousands of URLs that could never be sent
  // anywhere.
  //
  // Precedence when they disagree:
  //
  //   1. a folder mapping the USER edited, which is a decision, not a guess
  //   2. this page-level classification
  //   3. the folder map's own answer for that page's template
  //
  // A failure here is a downgrade, not a stop: every page falls back to (3),
  // which is exactly what the table showed before, and the reason is recorded on
  // the snapshot rather than left to be inferred from a column full of "Other".
  const allTopPages = topRaw.flatMap((d) => taggedTopPages.get(d.domain) || []);
  const userTemplates = new Set(
    folderMap.filter((e) => e.source === 'user').map((e) => e.template),
  );

  let pageTypes = new Map();
  let pageTypesError = null;
  if (allTopPages.length) {
    try {
      pageTypes = await classifyTopPages(allTopPages);
    } catch (e) {
      pageTypesError = e.message;
      console.error('[contentAnalysis.classifyTopPages]', e.message);
    }
  }

  const topPagesDomains = topRaw.map((d) => {
    const pages = (taggedTopPages.get(d.domain) || []).map((p) => ({
      ...p,
      ...storedClassification(p, pageTypes.get(p.fullUrl), byTemplate, userTemplates, resolveType),
    }));
    // Counted off the types actually shown, not re-derived from the templates —
    // otherwise the breakdown under the table would disagree with the table.
    const contentTypeCounts = {};
    for (const p of pages) contentTypeCounts[p.contentType] = (contentTypeCounts[p.contentType] || 0) + 1;
    return {
      domain: d.domain, label: d.label, isClient: d.isClient,
      pages,
      contentTypeCounts,
    };
  });

  // ── Summaries ──
  let topPagesSummary = '';
  if (topPagesDomains.length) {
    topPagesSummary = await summarizeTopPages(writerClient, topPagesDomains).catch((e) => `Summary generation failed: ${e.message}`);
  }
  const sitemapSummary = await summarizeSitemapStructure(writerClient, sitemapDomains).catch((e) => `Summary generation failed: ${e.message}`);

  return {
    capturedAt: now,
    folderMap,
    userOverrides,
    topPages: {
      enabled,
      fetchedAt: enabled ? now : null,
      skipped: topPagesSkipped,
      domains: topPagesDomains,
      // How the TYPE column was decided, and what went wrong if it wasn't.
      // Stored because "every page is Other" and "the classifier never ran" look
      // identical in the table, and the run that produced 581 unclassified
      // templates reported itself as a success.
      classifier: {
        model: CLASSIFIER_MODEL,
        classified: pageTypes.size,
        of: allTopPages.length,
        error: pageTypesError,
        taxonomyVersion: TAXONOMY_VERSION,
        classifierVersion: CLASSIFIER_VERSION,
      },
      summary: { text: topPagesSummary, generatedAt: topPagesDomains.length ? now : null },
    },
    sitemap: {
      fetchedAt: now,
      domains: sitemapDomains,
      summary: { text: sitemapSummary, generatedAt: now },
    },
  };
}

// ── Recompute on folder-map edit (no crawl, no GPT) ─────────────────────────
// The user edits pattern → type in the UI; this re-derives every per-domain
// count from the already-stored template counts and page templates. Edits are
// recorded as userOverrides so they survive future re-runs. Summaries are left
// as-is (now potentially stale) — the UI exposes "Regenerate" for those.
function applyMappingEdits(previous, edits) {
  if (!previous?.folderMap) throw new Error('Run Content Analysis first — there is no folder map to edit.');

  const cleanEdits = {};
  for (const [template, type] of Object.entries(edits || {})) {
    if (isValidType(type)) cleanEdits[template] = type;
  }

  const userOverrides = { ...(previous.userOverrides || {}), ...cleanEdits };
  const folderMap = previous.folderMap.map((e) =>
    e.template in cleanEdits ? { ...e, type: cleanEdits[e.template], source: 'user' } : e
  );
  const byTemplate = mapByTemplate(folderMap);

  const sitemapDomains = (previous.sitemap?.domains || []).map((d) => ({
    ...d,
    pageTypeCounts: countsFromTemplateCounts(d.templateCounts, byTemplate),
  }));
  const topPagesDomains = (previous.topPages?.domains || []).map((d) => {
    const pages = (d.pages || []).map((p) => ({ ...p, contentType: resolveType(p.template, byTemplate) }));
    return { ...d, pages, contentTypeCounts: countsFromPages(pages, byTemplate) };
  });

  return {
    ...previous,
    folderMap,
    userOverrides,
    mappingEditedAt: new Date().toISOString(),
    topPages: { ...previous.topPages, domains: topPagesDomains },
    sitemap: { ...previous.sitemap, domains: sitemapDomains },
  };
}

// ── Re-type the stored top pages, without re-fetching anything ─────────────
//
// The TYPE column is decided when an analysis RUNS and stored with it, so a
// snapshot captured before page-level classification existed keeps whatever it
// was given — for a site whose folder patterns went unclassified, that is
// "other" on every row, for ever, until something re-runs.
//
// Re-running the whole analysis to fix a column is the wrong trade: it spends
// 2,000 SEMrush units per domain to fetch top pages the snapshot already holds.
// Everything the classifier needs — each page's URL and its title — is already
// stored. So this re-reads them and rewrites only the types.
//
// Costs one Claude call (~$0.03 for a full five-domain run) and zero SEMrush
// units. Follows regenerateTopPagesSummary below: recompute one part of a
// stored snapshot, leave the rest untouched.
async function reclassifyTopPages(previous) {
  const domains = previous?.topPages?.domains || [];
  if (!domains.length) {
    throw new Error('Run Content Analysis first — there are no stored top pages to classify.');
  }

  const byTemplate = mapByTemplate(previous.folderMap || []);
  const userTemplates = new Set(
    (previous.folderMap || []).filter((e) => e.source === 'user').map((e) => e.template),
  );

  const allPages = domains.flatMap((d) => d.pages || []);
  const pageTypes = await classifyTopPages(allPages);

  const topPagesDomains = domains.map((d) => {
    const pages = (d.pages || []).map((p) => ({
      ...p,
      ...storedClassification(p, pageTypes.get(p.fullUrl), byTemplate, userTemplates, resolveType),
    }));
    const contentTypeCounts = {};
    for (const p of pages) contentTypeCounts[p.contentType] = (contentTypeCounts[p.contentType] || 0) + 1;
    return { ...d, pages, contentTypeCounts };
  });

  // ── The diff ──────────────────────────────────────────────────────────────
  //
  // What re-classifying actually changed, per subtype and per page. Without this
  // a taxonomy edit is unauditable: the counts move, and nobody can say which
  // pages moved or whether the move was an improvement. Returned alongside the
  // snapshot rather than stored on it — it describes one transition, not the
  // state.
  const before = new Map();
  for (const d of domains) for (const p of d.pages || []) before.set(p.fullUrl, p.contentType || p.subtype || null);

  const moved = [];
  const bySubtype = {};
  const bump = (key, field) => {
    bySubtype[key] = bySubtype[key] || { before: 0, after: 0 };
    bySubtype[key][field] += 1;
  };
  for (const d of topPagesDomains) {
    for (const p of d.pages || []) {
      const was = before.get(p.fullUrl) ?? null;
      const now = p.subtype;
      if (was) bump(was, 'before');
      bump(now, 'after');
      if (was !== now) moved.push({ url: p.fullUrl, from: was, to: now, confidence: p.confidence });
    }
  }

  const diff = {
    pages: allPages.length,
    changed: moved.length,
    unchanged: allPages.length - moved.length,
    bySubtype: Object.fromEntries(
      Object.entries(bySubtype)
        .map(([k, v]) => [k, { ...v, delta: v.after - v.before }])
        .sort((a, b) => Math.abs(b[1].delta) - Math.abs(a[1].delta)),
    ),
    moved,
  };

  return {
    snapshot: {
      ...previous,
      topPages: {
        ...previous.topPages,
        domains: topPagesDomains,
        classifier: {
          model: CLASSIFIER_MODEL,
          classified: pageTypes.size,
          of: allPages.length,
          error: null,
          taxonomyVersion: TAXONOMY_VERSION,
          classifierVersion: CLASSIFIER_VERSION,
          reclassifiedAt: new Date().toISOString(),
        },
      },
    },
    diff,
  };
}

async function regenerateTopPagesSummary(previous) {
  if (!previous?.topPages?.domains?.length) throw new Error('Run Content Analysis first — there is no top-pages data to summarize.');
  const writerClient = createLlmClient(WRITER_MODEL_ID);
  const text = await summarizeTopPages(writerClient, previous.topPages.domains);
  return { ...previous, topPages: { ...previous.topPages, summary: { text, generatedAt: new Date().toISOString() } } };
}

async function regenerateSitemapSummary(previous) {
  if (!previous?.sitemap?.domains?.length) throw new Error('Run Content Analysis first — there is no sitemap data to summarize.');
  const writerClient = createLlmClient(WRITER_MODEL_ID);
  const text = await summarizeSitemapStructure(writerClient, previous.sitemap.domains);
  return { ...previous, sitemap: { ...previous.sitemap, summary: { text, generatedAt: new Date().toISOString() } } };
}

module.exports = {
  runContentAnalysis, applyMappingEdits, reclassifyTopPages,
  regenerateTopPagesSummary, regenerateSitemapSummary,
};
