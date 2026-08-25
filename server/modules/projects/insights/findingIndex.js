// ── One page-attributed index of everything the modules found ────────────────
//
// Six modules each store findings in their own shape, with their own idea of
// what a finding is attached to. The dashboard reads a count and a title from
// each and shows six independent cards. Everything needed to do better is
// already stored — this module reads it and puts it in one shape.
//
// Why attribution is the whole point: "28 pages have titles over 60 characters"
// is a statistic. "These 28 pages, and here is what each title should be" is
// work somebody can do. The crawl already records the second one and drops it at
// the dashboard boundary — crawl_run_findings.detail keeps only a title — while
// the per-instance list survives in crawl_runs.summary.findings. So nothing has
// to be re-crawled to recover it (PRD §32).
//
// Three attribution levels, never conflated:
//
//   per-instance  the source names a URL for every occurrence  (crawl)
//   per-page      one stored report per audited page           (the three page audits)
//   aggregate     a count with no page list                    (legacy runs)
//
// An aggregate-only item keeps `pageCount: null` rather than borrowing its
// instance count, because "we found 39 of these" and "we know which 39 pages"
// are different claims and only the second can be worked from.

const overview = require('../overview');
const moduleEvidence = require('../moduleEvidence');
const { getSupabase, isSupabaseConfigured } = require('../../../services/supabase');

const MODULE_LABEL = new Map(overview.MODULES.map((m) => [m.key, m.label]));

// Modules whose evidence is derived from a crawl. A run older than the latest
// crawl describes a site inventory that has since been replaced, which is worth
// saying out loud rather than presenting as current.
const CRAWL_DEPENDENT = ['seo_geo', 'agent_readiness', 'hub_spoke'];

// How much of the crawled inventory a defect has to cover before it is a
// template problem rather than a page problem. Not a score — a classification,
// and every item carries the counts it was classified from so a reader can
// disagree with the threshold.
const TEMPLATE_SHARE = 0.6;
const SECTION_MIN_PAGES = 3;

function notConfigured() {
  return Object.assign(
    new Error('The finding index needs Supabase configured.'),
    { status: 503, code: 'not_configured' },
  );
}

/**
 * The stable identity of a rule, across pages and across runs.
 *
 * On-Page's site-level runner appended the audited URL to each ruleId
 * (`onpage-2:https://example.com`), so the same check on two pages produced two
 * rule ids and nothing aggregated. Per-page runs no longer do that, but stored
 * runs from before the change still exist, and a trend that silently breaks at a
 * refactor is worse than one that never existed.
 */
function normalizeRuleId(ruleId) {
  const id = String(ruleId || '').trim();
  const at = id.indexOf(':http');
  return at > 0 ? id.slice(0, at) : id;
}

/** A URL list stored as prose, or nothing. Never a partial guess. */
function urlsFromDetail(detail) {
  const text = String(detail || '');
  if (!/https?:\/\//.test(text)) return [];
  return text
    .split(/[,\s]+/)
    .map((part) => part.trim().replace(/[.,;]+$/, ''))
    .filter((part) => /^https?:\/\//.test(part));
}

/** How widely a defect is spread, given how much of the site was crawled. */
function scopeFor(pageCount, crawledCount) {
  if (pageCount === null || !Number.isFinite(Number(pageCount))) return null;
  if (crawledCount === null || !Number.isFinite(Number(crawledCount)) || Number(crawledCount) <= 0) return null;
  const pages = Number(pageCount);
  if (pages >= SECTION_MIN_PAGES && pages / Number(crawledCount) >= TEMPLATE_SHARE) return 'template';
  if (pages >= SECTION_MIN_PAGES) return 'section';
  return 'page';
}

function item(fields) {
  const pages = [...new Set((fields.pages || []).filter(Boolean))];
  const attributed = fields.attribution !== 'aggregate';
  return {
    key: `${fields.moduleKey}:${fields.ruleId}`,
    moduleKey: fields.moduleKey,
    moduleLabel: MODULE_LABEL.get(fields.moduleKey) || fields.moduleKey,
    ruleId: fields.ruleId,
    title: fields.title || fields.ruleId,
    severity: fields.severity || null,
    // The source module's own priority, where it has one. Nothing here derives a
    // priority from severity: an error on one page can matter less than a notice
    // on six hundred, and mapping one to the other would dress a guess as a
    // decision.
    priority: fields.priority || null,
    priorityBasis: fields.priority ? (fields.priorityBasis || null) : null,
    category: fields.category || null,
    pages: attributed ? pages : [],
    // Null, not the instance count: an unattributed finding does not know which
    // pages it is on, and pretending otherwise is what makes a backlog untrustable.
    pageCount: attributed ? pages.length : null,
    // Occurrences, not pages. A page can skip a heading level three times; the
    // crawl records three instances and one page. These are different numbers and
    // neither substitutes for the other.
    instanceCount: Number.isFinite(Number(fields.instanceCount)) ? Number(fields.instanceCount) : null,
    attribution: fields.attribution,
    // True only where the source could not name every page it counted — which is
    // a property of how that module stored its evidence, not something inferable
    // from the numbers. Hub and Spoke reports 39 unclustered pages and lists 15 of
    // them in a capped prose string: 15 understates the problem, 39 overstates
    // what we can act on, so both travel and the UI says "15 of 39 named".
    // An adapter that walked every instance and took its URL sets this false —
    // there, instances exceeding pages is normal and means nothing is missing.
    pagesPartial: attributed && Boolean(fields.pagesPartial),
    scope: attributed ? scopeFor(pages.length, fields.crawledCount) : null,
    detectedValue: fields.detectedValue || null,
    recommendedValue: fields.recommendedValue || null,
    recommendation: fields.recommendation || null,
    detail: fields.detail || null,
    description: fields.description || null,
    sourceRunId: fields.sourceRunId || null,
    // WHICH table sourceRunId is a key into. recommendations.source_run_id has a
    // foreign key to project_module_runs, and the crawl's runs live in crawl_runs
    // — passing one where the other is expected violates the constraint and the
    // promote endpoint 500s. Every crawl-sourced item is affected, which is most
    // of a typical backlog, so the distinction is carried explicitly rather than
    // re-derived from the module key at each call site.
    sourceRunKind: fields.sourceRunKind || 'module',
    sourceRunAt: fields.sourceRunAt || null,
  };
}

// ── technical: the crawl's own per-instance findings ────────────────────────
//
// crawl_runs.summary.findings holds one row per occurrence, each naming a url,
// and each carrying the rule catalog's priority plus the value it measured and
// the value it wanted. All of it is already there; none of it reaches the card.

async function crawlAdapter(crawl, crawledCount) {
  if (!crawl) return [];

  const { data, error } = await getSupabase()
    .from('crawl_runs')
    .select('summary, finished_at')
    .eq('id', crawl.id)
    .maybeSingle();
  if (error) throw new Error(`[findingIndex.crawl] ${error.message}`);

  const instances = Array.isArray(data?.summary?.findings) ? data.summary.findings : [];
  const byRule = new Map();

  for (const inst of instances) {
    const ruleId = normalizeRuleId(inst.ruleId);
    if (!ruleId) continue;
    if (!byRule.has(ruleId)) byRule.set(ruleId, { first: inst, urls: new Set(), instances: 0 });
    const bucket = byRule.get(ruleId);
    bucket.instances += 1;
    if (inst.url) bucket.urls.add(inst.url);
  }

  return [...byRule.entries()].map(([ruleId, bucket]) => item({
    moduleKey: 'technical',
    ruleId,
    title: bucket.first.title,
    severity: bucket.first.severity,
    priority: bucket.first.priority,
    priorityBasis: 'the crawler rule catalog',
    category: bucket.first.category,
    pages: [...bucket.urls],
    instanceCount: bucket.instances,
    attribution: 'per-instance',
    crawledCount,
    detectedValue: bucket.first.detectedValue,
    recommendedValue: bucket.first.recommendedValue,
    recommendation: bucket.first.recommendation,
    detail: bucket.first.detail,
    description: bucket.first.description,
    sourceRunId: crawl.id,
    sourceRunKind: 'crawl',
    sourceRunAt: data?.finished_at || crawl.finished_at || null,
  }));
}

// ── the three per-page audits ───────────────────────────────────────────────
//
// Complete attribution comes from the child rows, not from the run's rolled-up
// findings: the rollup caps its example list at 25 URLs, which is right for a
// card and wrong for a work queue.

async function perPageAdapter(moduleKey, run, crawledCount) {
  const pageRuns = await moduleEvidence.pageRunsForRun(run.id);

  if (!pageRuns.length) {
    // A run stored before per-page reports existed. Its findings are real; their
    // page attribution is whatever the run itself recorded, and often nothing.
    return (Array.isArray(run.findings) ? run.findings : []).map((f) => {
      const pages = Array.isArray(f.pages) && f.pages.length
        ? f.pages
        : (run.target_url ? [run.target_url] : []);
      return item({
        moduleKey,
        ruleId: normalizeRuleId(f.ruleId),
        title: f.title,
        severity: f.severity,
        category: f.category,
        pages,
        instanceCount: Number(f.count) || 1,
        attribution: pages.length ? 'per-instance' : 'aggregate',
        crawledCount,
        recommendation: f.recommendation,
        detail: f.detail,
        sourceRunId: run.id,
        sourceRunAt: run.finished_at || run.created_at,
      });
    });
  }

  const byRule = new Map();
  for (const page of pageRuns) {
    if (page.status === 'failed') continue;  // audited nothing, so found nothing
    for (const f of (Array.isArray(page.findings) ? page.findings : [])) {
      const ruleId = normalizeRuleId(f.ruleId);
      if (!ruleId) continue;
      if (!byRule.has(ruleId)) byRule.set(ruleId, { first: f, urls: new Set(), instances: 0 });
      const bucket = byRule.get(ruleId);
      bucket.instances += Number(f.count) || 1;
      if (page.url) bucket.urls.add(page.url);
    }
  }

  return [...byRule.entries()].map(([ruleId, bucket]) => item({
    moduleKey,
    ruleId,
    title: bucket.first.title,
    severity: bucket.first.severity,
    category: bucket.first.category,
    pages: [...bucket.urls],
    instanceCount: bucket.instances,
    attribution: 'per-page',
    crawledCount,
    recommendation: bucket.first.recommendation,
    detail: bucket.first.detail,
    sourceRunId: run.id,
    sourceRunAt: run.finished_at || run.created_at,
  }));
}

// ── hub_spoke: some findings name pages, some name clusters ─────────────────

function hubSpokeAdapter(run, crawledCount) {
  return (Array.isArray(run.findings) ? run.findings : []).map((f) => {
    const pages = urlsFromDetail(f.detail);
    return item({
      moduleKey: 'hub_spoke',
      ruleId: normalizeRuleId(f.ruleId),
      title: f.title,
      severity: f.severity,
      category: f.category,
      pages,
      instanceCount: Number(f.count) || 1,
      // A finding whose detail lists cluster names rather than URLs is real and
      // unattributed. Both cases exist in this module and must not be merged.
      attribution: pages.length ? 'per-instance' : 'aggregate',
      // The URL list lives in a prose string that gets capped when stored, so
      // fewer named pages than counted means the rest are unrecoverable here —
      // not that they do not exist.
      pagesPartial: pages.length > 0 && (Number(f.count) || 0) > pages.length,
      crawledCount,
      recommendation: f.recommendation,
      detail: f.detail,
      sourceRunId: run.id,
      sourceRunAt: run.finished_at || run.created_at,
    });
  });
}

// ── competitor: keywords, not pages ─────────────────────────────────────────
//
// This module measures standing on search terms. Its findings do not belong in a
// page backlog and are never given synthetic page attribution — they go in their
// own bucket, where a correlation rule can later match them to the page that
// ranks for them.

const KEYWORD_PATTERNS = {
  // "dental crown (vol 301000, www.aspendental.com at #3)"
  'competitor-missing-keywords': /^(.+?)\s+\(vol\s+([\d,]+),\s*(.+?)\s+at\s+#(\d+)\)$/,
  // "dental implants (#14 vs www.aspendental.com #7)"
  'competitor-striking-distance': /^(.+?)\s+\(#(\d+)\s+vs\s+(.+?)\s+#(\d+)\)$/,
};

/**
 * The keywords, and how many of them survived storage.
 *
 * The module reports a count and lists the terms in a detail string that gets
 * capped, so parsing recovers a prefix of them — 17 of 29 on the live project.
 * Returning only the 17 would quietly shrink a keyword gap; returning 29 would
 * claim terms we cannot name. Both numbers are reported.
 */
function competitorKeywords(run) {
  const out = [];
  const recovery = {};

  for (const f of (Array.isArray(run.findings) ? run.findings : [])) {
    const ruleId = normalizeRuleId(f.ruleId);
    const pattern = KEYWORD_PATTERNS[ruleId];
    if (!pattern) continue;

    const before = out.length;
    for (const part of String(f.detail || '').split(';')) {
      const match = pattern.exec(part.trim());
      if (!match) continue;
      if (ruleId === 'competitor-missing-keywords') {
        out.push({
          kind: 'missing',
          keyword: match[1].trim(),
          volume: Number(match[2].replace(/,/g, '')) || null,
          competitor: match[3].trim(),
          competitorPosition: Number(match[4]) || null,
          ourPosition: null,
          sourceRunId: run.id,
        });
      } else {
        out.push({
          kind: 'striking_distance',
          keyword: match[1].trim(),
          volume: null,
          ourPosition: Number(match[2]) || null,
          competitor: match[3].trim(),
          competitorPosition: Number(match[4]) || null,
          sourceRunId: run.id,
        });
      }
    }

    recovery[ruleId] = {
      title: f.title,
      reported: Number(f.count) || 0,
      named: out.length - before,
    };
  }

  return { keywords: out, recovery };
}

/**
 * The full stored payload of one module's latest terminal run.
 *
 * Separate from the dashboard's read on purpose. `latestByModule` projects two
 * scalar fields out of the payload so that drawing six cards does not transfer
 * megabytes; anything needing the whole object asks for it explicitly, for the
 * one module that needs it.
 */
async function fullPayload(projectId, moduleKey) {
  const { data, error } = await getSupabase()
    .from('project_module_runs')
    .select('payload')
    .eq('project_id', projectId)
    .eq('module_key', moduleKey)
    .in('status', ['completed', 'insufficient_data'])
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) throw new Error(`[findingIndex.fullPayload:${moduleKey}] ${error.message}`);
  return (data || [])[0]?.payload || null;
}

// ── coverage: what was measured, and what was not ──────────────────────────

function coverageEntry(moduleKey, state, extra = {}) {
  return {
    moduleKey,
    moduleLabel: MODULE_LABEL.get(moduleKey) || moduleKey,
    state,
    reason: extra.reason || null,
    runId: extra.runId || null,
    runAt: extra.runAt || null,
    attribution: extra.attribution || null,
    stale: Boolean(extra.stale),
    itemCount: Number.isFinite(extra.itemCount) ? extra.itemCount : null,
  };
}

/**
 * @param {object} input
 * @param {object} input.access  from projectAccess.requireProject
 * @returns {Promise<object>} { items, keywords, coverage, crawl, structure, generatedAt }
 */
async function buildFindingIndex({ access }) {
  if (!isSupabaseConfigured()) throw notConfigured();

  const projectId = access.project.id;

  const [crawlRuns, evidenceByModule] = await Promise.all([
    overview.recentCrawlRuns(projectId),
    moduleEvidence.latestByModule(projectId),
  ]);

  const crawl = crawlRuns.find((r) => ['completed', 'stopped'].includes(r.status)) || null;
  const crawledAt = crawl ? (crawl.finished_at || crawl.created_at) : null;

  // The denominator for "how much of the site does this affect". Read from the
  // same helper the dashboard uses, so a share here and a page count there agree.
  const internalPages = crawl ? await overview.internalPageCount(crawl.id) : null;
  const crawledCount = internalPages === null || internalPages === undefined
    ? null
    : Number(internalPages);

  const items = [];
  const coverage = [];
  let keywords = [];
  let keywordRecovery = null;
  let structure = null;

  if (!crawl) {
    coverage.push(coverageEntry('technical', 'never_run', {
      reason: 'No completed crawl for this project yet. Every page-level audit depends on it.',
    }));
  } else {
    const crawlItems = await crawlAdapter(crawl, crawledCount);
    items.push(...crawlItems);
    coverage.push(coverageEntry('technical', 'measured', {
      runId: crawl.id,
      runAt: crawledAt,
      attribution: 'per-instance',
      itemCount: crawlItems.length,
    }));
  }

  for (const module of overview.MODULES) {
    if (module.key === 'technical') continue;

    const run = evidenceByModule.get(module.key)?.terminal || null;

    if (!run) {
      coverage.push(coverageEntry(module.key, 'never_run', {
        reason: `${module.label} has not been run against this project.`,
      }));
      continue;
    }

    const runAt = run.finished_at || run.created_at;

    if (run.status === 'failed') {
      coverage.push(coverageEntry(module.key, 'failed', {
        reason: run.error || 'The run failed without recording a reason.',
        runId: run.id,
        runAt,
      }));
      continue;
    }

    if (run.status === 'insufficient_data') {
      coverage.push(coverageEntry(module.key, 'insufficient_data', {
        reason: run.payload?.note || run.note
          || 'The module ran and found nothing it could measure.',
        runId: run.id,
        runAt,
      }));
      continue;
    }

    // A crawl-dependent module whose run predates the latest crawl describes an
    // inventory that has since been replaced.
    const stale = Boolean(
      CRAWL_DEPENDENT.includes(module.key)
      && crawledAt && runAt && String(runAt) < String(crawledAt),
    );

    let produced = [];
    if (moduleEvidence.PAGE_MODULE_KEYS.includes(module.key)) {
      produced = await perPageAdapter(module.key, run, crawledCount);
    } else if (module.key === 'hub_spoke') {
      produced = hubSpokeAdapter(run, crawledCount);
      // latestByModule deliberately projects only `payload->>note` and
      // `payload->>reportRef` — the dashboard must not pull five 400KB payloads to
      // draw six cards. The structural facts the correlation rules need (clusters,
      // orphan counts, limitations) live in the full payload, so it is fetched
      // once, here, for the one module that has them.
      structure = await fullPayload(projectId, module.key);
    } else if (module.key === 'competitor') {
      const parsed = competitorKeywords(run);
      keywords = parsed.keywords;
      keywordRecovery = parsed.recovery;
    }

    items.push(...produced);
    coverage.push(coverageEntry(module.key, 'measured', {
      runId: run.id,
      runAt,
      stale,
      reason: stale
        ? 'This ran before the latest crawl, so it describes an earlier inventory of the site.'
        : null,
      attribution: produced.length
        ? [...new Set(produced.map((p) => p.attribution))].join(' + ')
        : (module.key === 'competitor' ? 'keyword-level' : null),
      itemCount: module.key === 'competitor' ? keywords.length : produced.length,
    }));
  }

  return {
    items,
    keywords,
    // How many of the reported keywords could actually be named, per rule.
    keywordRecovery,
    coverage,
    crawl: crawl ? {
      runId: crawl.id,
      crawledAt,
      internalPages: crawledCount,
      urlCap: Number(crawl.options?.maxUrls) || null,
      capped: Boolean(
        crawledCount && crawl.options?.maxUrls
        && crawledCount >= Number(crawl.options.maxUrls),
      ),
    } : null,
    structure,
    generatedAt: new Date().toISOString(),
  };
}

module.exports = {
  buildFindingIndex,
  normalizeRuleId,
  urlsFromDetail,
  scopeFor,
  competitorKeywords,
  hubSpokeAdapter,
  perPageAdapter,
  crawlAdapter,
  coverageEntry,
  CRAWL_DEPENDENT,
  TEMPLATE_SHARE,
  SECTION_MIN_PAGES,
};
