// ── What no single module can say ─────────────────────────────────────────────
//
// Every module answers its own question well and none of them talk. A page can be
// orphaned in Hub and Spoke, failing schema in SEO & GEO, invisible to agents in
// Agent Readiness and ranking eleventh for a term a competitor owns — and the
// product shows those as four numbers on four cards.
//
// Each rule below is a join across two or more modules' stored evidence. Two
// properties every one of them has to keep:
//
//   1. It names the fields it read. An insight a reader cannot trace is a claim.
//   2. It WITHHOLDS ITSELF when an input is missing, rather than degrading into a
//      weaker version of itself. `orphanCount: null` means orphan detection was
//      withheld because the crawl was capped — a rule that treated that as zero
//      orphans would report "no orphaned pages" about a site nobody checked.
//
// A withheld rule is reported, with the reason. Silence about a check that did
// not run is the failure mode this whole layer exists to avoid (§30).

const { canonicalKey } = require('../crawledPages');

/** A rule that produced something. */
function insight(fields) {
  return {
    id: fields.id,
    headline: fields.headline,
    detail: fields.detail || null,
    // What a marketing team would do about it. Not generated — written per rule.
    action: fields.action || null,
    modules: fields.modules,
    // The exact stored fields this was computed from, so any number here can be
    // traced back to the run that produced it.
    readFrom: fields.readFrom,
    pages: fields.pages || [],
    keywords: fields.keywords || [],
    count: fields.count ?? null,
    severity: fields.severity || 'notice',
  };
}

/** A rule that could not run, and why. */
function withheld(id, modules, reason, unblock) {
  return { id, modules, reason, unblock: unblock || null };
}

// ── The rules ───────────────────────────────────────────────────────────────

/**
 * A defect on most of the site is a template defect.
 *
 * The single most valuable thing page attribution buys. "49 pages are missing Open
 * Graph tags" is 49 tickets; "your page template is missing Open Graph tags" is
 * one, and it is the same evidence.
 */
function templateDefects({ backlog, crawl }) {
  const template = (backlog.actions || []).filter((i) => i.scope === 'template');
  if (!template.length) {
    return {
      insights: [],
      withheld: [withheld(
        'template_defects',
        ['technical', 'seo_geo', 'agent_readiness'],
        crawl
          ? 'No single defect covers enough of the crawled pages to be a template problem.'
          : 'No completed crawl, so there is no page inventory to measure spread against.',
        crawl ? null : 'Run a site crawl.',
      )],
    };
  }

  const worst = template[0];
  return {
    insights: [insight({
      id: 'template_defects',
      severity: worst.severity === 'error' ? 'error' : 'warning',
      headline: template.length === 1
        ? `One defect runs through the whole site template: ${worst.title.toLowerCase()}`
        : `${template.length} defects run through the whole site template, not individual pages`,
      detail: template
        .map((i) => `${i.title} (${i.pageCount} of ${crawl.internalPages} pages)`)
        .join('; '),
      action: `Fix these in the template rather than page by page — ${template.length} `
        + `change(s) instead of ${template.reduce((n, i) => n + (i.pageCount || 0), 0)} page edits.`,
      modules: [...new Set(template.map((i) => i.moduleKey))],
      readFrom: ['crawl_run_finding_instances.data.url', 'project_module_page_runs.findings'],
      pages: worst.pages.slice(0, 25),
      count: template.length,
    })],
    withheld: [],
  };
}

/**
 * Pages the site itself does not link to.
 *
 * Hub and Spoke withholds `orphanCount` on a capped crawl, on the grounds that a
 * page with no inbound link in a partial crawl may simply not have been reached.
 * That withholding is respected here — the weaker signal it does publish,
 * `pagesWithNoInboundLink`, is reported as what it is.
 */
function unlinkedPages({ structure, crawl }) {
  if (!structure) {
    return {
      insights: [],
      withheld: [withheld('unlinked_pages', ['hub_spoke'],
        'Hub and Spoke has no stored analysis for this project.',
        'Run Hub and Spoke.')],
    };
  }

  const orphans = structure.orphanCount;
  const noInbound = Number(structure.pagesWithNoInboundLink);

  if (orphans === null || orphans === undefined) {
    if (!Number.isFinite(noInbound) || noInbound === 0) {
      return {
        insights: [],
        withheld: [withheld('unlinked_pages', ['hub_spoke'],
          structure.orphanDetectionWithheld
            ? 'Orphan detection was withheld: the crawl stopped at its URL cap, so a page '
              + 'with no inbound link may simply not have been reached.'
            : 'No unlinked pages were recorded.',
          structure.orphanDetectionWithheld ? 'Raise the crawl URL limit and re-crawl.' : null)],
      };
    }

    // The honest middle: report the observation, and label it an observation.
    return {
      insights: [insight({
        id: 'unlinked_pages',
        severity: 'warning',
        headline: `${noInbound} of ${structure.pagesAnalyzed} crawled pages have no inbound `
          + 'internal link',
        detail: 'Orphan detection itself was withheld because the crawl stopped at its URL cap, '
          + 'so some of these may simply not have been reached rather than being genuinely '
          + 'unlinked. The count is what the crawl saw, not a verdict.',
        action: 'Raise the crawl limit and re-crawl to separate genuinely orphaned pages from '
          + 'pages the crawl never reached.',
        modules: ['hub_spoke', 'technical'],
        readFrom: ['project_module_runs.payload.pagesWithNoInboundLink',
          'project_module_runs.payload.orphanDetectionWithheld'],
        count: noInbound,
      })],
      withheld: [],
    };
  }

  if (!orphans) {
    return {
      insights: [],
      withheld: [withheld('unlinked_pages', ['hub_spoke'],
        'Orphan detection ran and found none.')],
    };
  }

  return {
    insights: [insight({
      id: 'unlinked_pages',
      severity: 'error',
      headline: `${orphans} pages earn nothing because nothing links to them`,
      action: 'Link each from its topic hub, or retire it.',
      modules: ['hub_spoke'],
      readFrom: ['project_module_runs.payload.orphanCount'],
      count: orphans,
    })],
    withheld: [],
  };
}

/**
 * Content the site has published and then left out of its own structure.
 *
 * Distinct from an orphan: these pages are linked, they just belong to no topic.
 * Search engines and answer engines both read a site's structure as a claim about
 * what it is authoritative on, and unclustered mass dilutes that claim.
 */
function unclusteredMass({ structure }) {
  if (!structure) {
    return {
      insights: [],
      withheld: [withheld('unclustered_mass', ['hub_spoke'],
        'Hub and Spoke has no stored analysis for this project.', 'Run Hub and Spoke.')],
    };
  }

  const unassigned = Number(structure.unassignedCount);
  const analyzed = Number(structure.pagesAnalyzed);
  if (!Number.isFinite(unassigned) || !unassigned || !Number.isFinite(analyzed) || !analyzed) {
    return {
      insights: [],
      withheld: [withheld('unclustered_mass', ['hub_spoke'],
        'Every analysed page joined a topic cluster.')],
    };
  }

  const share = Math.round((unassigned / analyzed) * 100);
  return {
    insights: [insight({
      id: 'unclustered_mass',
      severity: share >= 50 ? 'warning' : 'notice',
      headline: `${share}% of the site (${unassigned} of ${analyzed} pages) belongs to no topic cluster`,
      detail: `${structure.clusterCount} cluster(s) were identified, covering `
        + `${analyzed - unassigned} pages.`,
      action: 'Decide for each page whether it joins an existing cluster, starts one, or comes '
        + 'down. Unclustered content dilutes what the site looks authoritative on.',
      modules: ['hub_spoke'],
      readFrom: ['project_module_runs.payload.unassignedCount',
        'project_module_runs.payload.pagesAnalyzed'],
      count: unassigned,
    })],
    withheld: [],
  };
}

/**
 * Clusters with no page fit to lead them.
 *
 * A gap hub is a topic the site has spokes for and no hub: the demand is already
 * being written about, and nothing consolidates it.
 */
function hubGaps({ structure }) {
  const clusters = Array.isArray(structure?.clusters) ? structure.clusters : null;
  if (!clusters) {
    return {
      insights: [],
      withheld: [withheld('hub_gaps', ['hub_spoke'],
        'No stored cluster analysis for this project.', 'Run Hub and Spoke.')],
    };
  }

  const gaps = clusters.filter((c) => c.isGap);
  const ambiguous = clusters.filter((c) => c.hubConfidence === 'ambiguous');

  if (!gaps.length && !ambiguous.length) {
    return {
      insights: [],
      withheld: [withheld('hub_gaps', ['hub_spoke'],
        'Every cluster has a confident hub page.')],
    };
  }

  const parts = [];
  if (gaps.length) {
    parts.push(`${gaps.length} topic cluster${gaps.length === 1 ? ' has' : 's have'} no hub page`);
  }
  if (ambiguous.length) {
    parts.push(`${ambiguous.length} cluster${ambiguous.length === 1 ? '' : 's'} `
      + `(${ambiguous.map((c) => c.name).join(', ')}) `
      + `${ambiguous.length === 1 ? 'has a hub' : 'have hubs'} the analysis could not choose `
      + 'confidently');
  }

  return {
    insights: [insight({
      id: 'hub_gaps',
      severity: gaps.length ? 'warning' : 'notice',
      headline: parts.join(', and '),
      detail: clusters
        .map((c) => `${c.name}: ${c.spokes} spoke(s), health ${c.health}, hub ${c.hubConfidence}`)
        .join('; '),
      action: 'Name or write the hub page for each, then link its spokes to it. A cluster '
        + 'without a hub competes with itself.',
      modules: ['hub_spoke'],
      readFrom: ['project_module_runs.payload.clusters[]'],
      count: gaps.length + ambiguous.length,
    })],
    withheld: [],
  };
}

/**
 * Terms the site already ranks for, just not well enough to be seen.
 *
 * Position 11–50 is the cheapest traffic in SEO: the page already exists and
 * already ranks. Where the competitor module also records a competitor ahead on
 * the same term, the gap is specific and arguable.
 */
function strikingDistance({ keywords, keywordRecovery }) {
  const striking = (keywords || []).filter((k) => k.kind === 'striking_distance');
  if (!striking.length) {
    return {
      insights: [],
      withheld: [withheld('striking_distance', ['competitor'],
        'No competitor run has recorded striking-distance keywords for this project.',
        'Run Competitor Research (metered — it spends SEMrush units).')],
    };
  }

  const recovery = keywordRecovery?.['competitor-striking-distance'];
  const best = [...striking].sort((a, b) => (a.ourPosition ?? 99) - (b.ourPosition ?? 99));

  return {
    insights: [insight({
      id: 'striking_distance',
      severity: 'warning',
      headline: `${recovery?.reported ?? striking.length} terms already rank on page 2–5 where a `
        + 'competitor is ahead',
      detail: best.slice(0, 8)
        .map((k) => `${k.keyword}: you #${k.ourPosition}, ${k.competitor} #${k.competitorPosition}`)
        .join('; ')
        + (recovery && recovery.named < recovery.reported
          ? ` — ${recovery.named} of ${recovery.reported} named in stored evidence`
          : ''),
      action: 'These pages already rank. Strengthening the existing page is cheaper than writing '
        + 'a new one, and the competitor position tells you what you are being beaten by.',
      modules: ['competitor'],
      readFrom: ['project_module_runs.findings[competitor-striking-distance].detail'],
      keywords: best.slice(0, 25),
      count: recovery?.reported ?? striking.length,
    })],
    withheld: [],
  };
}

/**
 * Competitor demand that lands inside a topic the site already has.
 *
 * The expensive answer to a keyword gap is "write a new section". The cheap one is
 * "you already have a cluster about this — add a page to it". Matching the
 * competitor's missing terms against existing cluster names tells you which it is,
 * and no module can do that alone: one owns the keywords, the other the clusters.
 */
function keywordGapsInExistingClusters({ keywords, structure, keywordRecovery }) {
  const missing = (keywords || []).filter((k) => k.kind === 'missing');
  const clusters = Array.isArray(structure?.clusters) ? structure.clusters : null;

  if (!missing.length) {
    return {
      insights: [],
      withheld: [withheld('keyword_gaps_in_clusters', ['competitor', 'hub_spoke'],
        'No competitor keyword gap is stored for this project.',
        'Run Competitor Research (metered).')],
    };
  }
  if (!clusters) {
    return {
      insights: [],
      withheld: [withheld('keyword_gaps_in_clusters', ['competitor', 'hub_spoke'],
        'Keyword gaps are stored but there is no cluster analysis to place them in, so cheap '
        + 'gaps cannot be told from expensive ones.',
        'Run Hub and Spoke.')],
    };
  }

  // A term belongs to a cluster when they share a significant word. Deliberately
  // crude and deliberately visible: the match is shown so a human can overrule it.
  const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'for', 'of', 'in', 'to', 'near', 'me',
    'best', 'top', 'guide', 'options', 'my']);
  const words = (text) => new Set(String(text).toLowerCase().split(/[^a-z0-9]+/)
    .filter((w) => w.length > 3 && !STOP.has(w)));

  const matched = [];
  const unmatched = [];
  for (const k of missing) {
    const kw = words(k.keyword);
    const hit = clusters.find((c) => [...words(c.name)].some((w) => kw.has(w)));
    if (hit) matched.push({ ...k, cluster: hit.name });
    else unmatched.push(k);
  }

  if (!matched.length) {
    return {
      insights: [],
      withheld: [withheld('keyword_gaps_in_clusters', ['competitor', 'hub_spoke'],
        `None of the ${missing.length} named gap terms fall inside an existing topic cluster, so `
        + 'every one of them needs new territory rather than a new page in old territory.')],
    };
  }

  const recovery = keywordRecovery?.['competitor-missing-keywords'];
  return {
    insights: [insight({
      id: 'keyword_gaps_in_clusters',
      severity: 'warning',
      headline: `${matched.length} competitor keyword gap(s) fall inside a topic cluster the site `
        + 'already has',
      detail: matched.slice(0, 8)
        .map((k) => `"${k.keyword}" (vol ${k.volume ?? '—'}) → ${k.cluster}`)
        .join('; ')
        + (recovery && recovery.named < recovery.reported
          ? ` — matched against ${recovery.named} of ${recovery.reported} gap terms recoverable `
            + 'from stored evidence'
          : ''),
      action: 'Add a spoke to the existing cluster and link it from that hub. Cheaper and faster '
        + `than the ${unmatched.length} gap(s) that need a new topic area.`,
      modules: ['competitor', 'hub_spoke'],
      readFrom: ['project_module_runs.findings[competitor-missing-keywords].detail',
        'project_module_runs.payload.clusters[].name'],
      keywords: matched.slice(0, 25),
      count: matched.length,
    })],
    withheld: [],
  };
}

/**
 * Whether the site is legible to the engines that answer questions without a click.
 *
 * Agent Readiness scores the site's affordances; SEO & GEO checks the schema and
 * answerability of each page. A site failing both is not "a bit behind on
 * technical SEO" — it is absent from the surface that is replacing search results.
 */
function aiVisibility({ index, coverage }) {
  const agent = coverage.find((c) => c.moduleKey === 'agent_readiness');
  const geo = coverage.find((c) => c.moduleKey === 'seo_geo');

  const blocked = [agent, geo].filter((c) => c && c.state !== 'measured');
  if (blocked.length) {
    return {
      insights: [],
      withheld: [withheld('ai_visibility', ['agent_readiness', 'seo_geo'],
        blocked.map((c) => `${c.moduleLabel}: ${c.state.replace(/_/g, ' ')}`).join('; '),
        'Run both modules — this is the one insight that needs each to corroborate the other.')],
    };
  }

  const items = index.items || [];
  // The rules on either side that speak to machine legibility rather than ranking.
  const schema = items.filter((i) => i.moduleKey === 'seo_geo'
    && /^seogeo-(J|T)/.test(i.ruleId));
  const agentFails = items.filter((i) => i.moduleKey === 'agent_readiness'
    && i.severity === 'error');

  if (!schema.length && !agentFails.length) {
    return {
      insights: [],
      withheld: [withheld('ai_visibility', ['agent_readiness', 'seo_geo'],
        'Both modules ran and neither reported a machine-legibility failure.')],
    };
  }

  const pages = [...new Set([...schema, ...agentFails].flatMap((i) => i.pages))];
  return {
    insights: [insight({
      id: 'ai_visibility',
      severity: 'error',
      headline: `${schema.length + agentFails.length} machine-legibility failures across schema `
        + 'and agent affordances',
      detail: [...agentFails.slice(0, 5), ...schema.slice(0, 5)]
        .map((i) => i.title).join('; '),
      action: 'An answer engine reads schema and well-known endpoints, not prose. These are the '
        + 'checks that decide whether the site can be quoted at all.',
      modules: ['agent_readiness', 'seo_geo'],
      readFrom: ['project_module_page_runs.findings[seogeo-J*, seogeo-T*]',
        'project_module_page_runs.findings[agent-*]'],
      pages: pages.slice(0, 25),
      count: schema.length + agentFails.length,
    })],
    withheld: [],
  };
}

/**
 * Pages carrying more defects than any other.
 *
 * Not a new measurement — a different cut of the same evidence, and the one a
 * person doing the work wants: which page to open first.
 */
function worstPages({ backlog }) {
  const actions = backlog.actions || [];
  const byPage = new Map();
  for (const item of actions) {
    for (const url of item.pages) {
      const key = canonicalKey(url);
      if (!key) continue;
      if (!byPage.has(key)) byPage.set(key, { url, items: [] });
      byPage.get(key).items.push(item);
    }
  }

  if (!byPage.size) {
    return {
      insights: [],
      withheld: [withheld('worst_pages', ['technical', 'seo_geo', 'agent_readiness'],
        'No finding names a page, so findings cannot be grouped by page.',
        'Run a crawl and the page audits.')],
    };
  }

  const ranked = [...byPage.values()]
    .map((p) => ({
      url: p.url,
      total: p.items.length,
      errors: p.items.filter((i) => i.severity === 'error').length,
      // A page-specific defect is worth more attention than a template one it
      // merely inherits: fixing the template fixes it everywhere at once.
      ownDefects: p.items.filter((i) => i.scope !== 'template').length,
    }))
    .sort((a, b) => b.errors - a.errors || b.ownDefects - a.ownDefects || b.total - a.total)
    .slice(0, 10);

  // Say what actually decided the order. Ranking on errors first and then
  // announcing "the most page-specific defects (1)" reads as a bug when the page
  // above it has three — the headline has to name the key that won.
  const top = ranked[0];
  const headline = top.errors
    ? `${top.url} has ${top.errors} error-level defect${top.errors === 1 ? '' : 's'} — more than any other page`
    : `${top.url} carries the most page-specific defects (${top.ownDefects}, plus template-wide ones)`;

  return {
    insights: [insight({
      id: 'worst_pages',
      severity: 'notice',
      headline,
      detail: ranked.slice(0, 6)
        .map((p) => `${p.url} — ${p.ownDefects} own, ${p.total} total`).join('; '),
      action: 'Template fixes are counted separately here, so this ranks pages by what is wrong '
        + 'with them specifically rather than what they inherit.',
      modules: [...new Set(actions.map((i) => i.moduleKey))],
      readFrom: ['the finding index, grouped by page'],
      pages: ranked.map((p) => p.url),
      count: ranked.length,
    })],
    withheld: [],
  };
}

const RULES = [
  templateDefects,
  aiVisibility,
  unlinkedPages,
  strikingDistance,
  keywordGapsInExistingClusters,
  hubGaps,
  unclusteredMass,
  worstPages,
];

/**
 * @param {object} input
 * @param {object} input.index    findingIndex.buildFindingIndex output
 * @param {object} input.backlog  backlog.buildBacklog output
 * @returns {object} { insights, withheld, lead }
 */
function buildCorrelations({ index, backlog }) {
  const context = {
    index,
    backlog,
    coverage: index.coverage || [],
    structure: index.structure || null,
    keywords: index.keywords || [],
    keywordRecovery: index.keywordRecovery || null,
    crawl: index.crawl || null,
  };

  const insights = [];
  const heldBack = [];

  for (const rule of RULES) {
    // A rule that throws must not take the dashboard with it — the point of this
    // layer is that a partial answer beats a blank screen.
    try {
      const result = rule(context) || {};
      insights.push(...(result.insights || []));
      heldBack.push(...(result.withheld || []));
    } catch (e) {
      heldBack.push(withheld(rule.name, [], `This check failed to run: ${e.message}`));
    }
  }

  const RANK = { error: 0, warning: 1, notice: 2 };
  insights.sort((a, b) => (RANK[a.severity] ?? 9) - (RANK[b.severity] ?? 9)
    || (b.count ?? 0) - (a.count ?? 0));

  return {
    insights,
    withheld: heldBack,
    // The one thing to say first. Null rather than a filler sentence when nothing
    // correlated — the dashboard has an honest empty state for that.
    lead: insights[0] || null,
  };
}

module.exports = {
  buildCorrelations,
  RULES,
  templateDefects,
  unlinkedPages,
  unclusteredMass,
  hubGaps,
  strikingDistance,
  keywordGapsInExistingClusters,
  aiVisibility,
  worstPages,
  insight,
  withheld,
};
