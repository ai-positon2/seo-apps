// ── One ranked list of work, from every module ────────────────────────────────
//
// The dashboard's problem is not that it lacks findings. It has about a hundred,
// in severity order, across six cards, and no answer to "what do I do on Monday".
//
// This ranks them. What it must not do is invent a priority score: §6.2 rules out
// a methodology that did not come from a measurement, and a 0–100 "impact score"
// composed of weights somebody picked is exactly that. So the ranking is a
// **lexicographic sort over measured facts in a stated precedence order**, and
// every item carries the line that explains its own position.
//
// The precedence, and why each key is where it is:
//
//   1. severity         The module's own judgement of how bad it is per page.
//                       Universal — every module reports it — and it goes first
//                       because an error is a broken thing. An earlier version
//                       put template scope first and buried a High Priority
//                       sitemap error under four template-wide notices, which is
//                       not an order anybody would defend out loud.
//   2. template scope   One change fixes every affected page: a fact about
//                       effort, not an opinion about importance. It promotes an
//                       item within its severity band, never across one.
//   3. reach            How many pages carry it. With Search Console connected
//                       this becomes the share of measured clicks those pages
//                       earn; without it, pages are the only honest unit.
//   4. source priority  The crawler's rule catalog assigns one. A tiebreak, never
//                       above measured reach, because only one of the six modules
//                       supplies it and ordering the other five against it would
//                       be a comparison of nothing.
//   5. title            So the same evidence always produces the same order.
//
// Severity is deliberately NOT mapped onto the recommendation lifecycle's
// priority field. That mapping is refused in recommendations.js for a good
// reason and nothing here undoes it.

const { canonicalKey } = require('../crawledPages');
// Excluding pages changes how widely a defect is spread, so the classification
// has to be recomputed with the same function that produced it.
const { scopeFor } = require('./findingIndex');

const SEVERITY_RANK = { error: 0, warning: 1, notice: 2, info: 3 };

// The crawler rule catalog's vocabulary. Only used to break ties among its own
// findings.
const PRIORITY_RANK = {
  'high priority': 0,
  'medium priority': 1,
  // The catalog's third tier is "Low Priority"; "good to have" is an older
  // spelling kept so anything still carrying it ranks the same.
  'low priority': 2,
  'good to have': 2,
};

const SCOPE_RANK = { template: 0, section: 1, page: 2 };

function severityRank(severity) {
  const rank = SEVERITY_RANK[String(severity || '').toLowerCase()];
  // An unknown severity sorts after every known one rather than before: a module
  // that stops reporting severity must not jump the queue.
  return rank === undefined ? 8 : rank;
}

function priorityRank(priority) {
  const rank = PRIORITY_RANK[String(priority || '').toLowerCase()];
  return rank === undefined ? 8 : rank;
}

/**
 * Findings that are not defects.
 *
 * On-Page's auditor marks a check `manual` when it cannot be automated — "cannot
 * verify inbound links from a single-page fetch", "PSI data unavailable". Those
 * became `notice` severity on the way into storage, which puts a capability gap
 * in the same bucket as a minor defect. In a work queue that is actively
 * misleading: nobody can fix "PSI data unavailable".
 *
 * They are real information and they belong in their own list (§30 — surface
 * capability gaps), so they are separated rather than dropped.
 */
function isManualCheck(item) {
  // Set explicitly by the per-page auditors from this release onwards.
  if (item.manual === true) return true;
  // Runs stored before that flag existed. Narrow on purpose: these are the exact
  // phrases the auditor emits, not a general guess at what sounds unverifiable.
  const text = `${item.title || ''} ${item.detail || ''}`;
  return /\b(cannot verify|cannot be confirmed|data unavailable|requires manual|not detectable via)\b/i
    .test(text);
}

/** What it would take to fix, stated only where the evidence says it. */
function effortHint(item) {
  if (item.scope === 'template') {
    return item.pageCount
      ? `One template change covers ${item.pageCount} pages`
      : 'One template change';
  }
  if (item.pageCount === null) return null;
  if (item.pageCount === 1) return 'One page';
  return `${item.pageCount} page edits`;
}

/**
 * The sentence under an item explaining why it sits where it does.
 *
 * Every clause is a measured fact with its source named. This is the mechanism
 * that keeps the ranking auditable — a reader who disagrees can see exactly what
 * it was built from.
 */
function basisLine(item, crawledCount) {
  const parts = [];

  if (item.scope === 'template') {
    parts.push(crawledCount
      ? `Template-wide (${item.pageCount} of ${crawledCount} crawled pages)`
      : 'Template-wide');
  } else if (item.pageCount === null) {
    parts.push(item.instanceCount
      ? `${item.instanceCount} occurrence(s), pages not recorded`
      : 'Pages not recorded');
  } else if (item.pagesPartial) {
    parts.push(`${item.pageCount} of ${item.instanceCount} affected pages named`);
  } else {
    parts.push(`${item.pageCount} page${item.pageCount === 1 ? '' : 's'}`);
  }

  if (item.severity) parts.push(item.severity);
  if (item.priority) {
    parts.push(item.priorityBasis
      ? `${item.priority} (${item.priorityBasis})`
      : item.priority);
  }
  parts.push(item.moduleLabel);

  return parts.join(' · ');
}

function compare(a, b) {
  const sevA = severityRank(a.severity);
  const sevB = severityRank(b.severity);
  if (sevA !== sevB) return sevA - sevB;

  // Template scope promotes within a severity band, not across one. Only
  // template earns the jump; section and page fall through to reach, so a
  // three-page warning does not outrank a twenty-page one on scope alone.
  const templateA = (SCOPE_RANK[a.scope] ?? 8) === 0 ? 0 : 1;
  const templateB = (SCOPE_RANK[b.scope] ?? 8) === 0 ? 0 : 1;
  if (templateA !== templateB) return templateA - templateB;

  // Reach. A null page count is unknown, not zero (§16.11), so it sorts after
  // everything measured rather than at the bottom of a numeric scale.
  const reachA = a.pageCount === null ? -1 : a.pageCount;
  const reachB = b.pageCount === null ? -1 : b.pageCount;
  if (reachA !== reachB) return reachB - reachA;

  const prioA = priorityRank(a.priority);
  const prioB = priorityRank(b.priority);
  if (prioA !== prioB) return prioA - prioB;

  return String(a.title).localeCompare(String(b.title));
}

/**
 * Remove excluded pages from an item, and drop the item if nothing is left.
 *
 * An exclusion is somebody saying "do not audit this page" — a legal notice, a
 * paginated archive, a page another team owns. Honouring it silently would be
 * worse than not honouring it at all: work would vanish from the backlog with no
 * trace, and the next person would not know why the numbers moved. So the
 * subtraction is counted and reported.
 *
 * `scope` is recomputed, not carried over: a defect on 49 pages of which 45 are
 * excluded is not a template problem any more.
 */
function applyExclusions(items, excluded, crawledCount) {
  if (!excluded || !excluded.size) {
    return { items, droppedItems: 0, droppedPages: 0 };
  }

  const kept = [];
  let droppedItems = 0;
  const droppedPages = new Set();

  for (const item of items) {
    if (!item.pages.length) { kept.push(item); continue; }

    const pages = [];
    for (const url of item.pages) {
      const key = canonicalKey(url);
      if (key && excluded.has(key)) droppedPages.add(key);
      else pages.push(url);
    }

    if (pages.length === item.pages.length) { kept.push(item); continue; }
    if (!pages.length) { droppedItems += 1; continue; }

    kept.push({
      ...item,
      pages,
      pageCount: pages.length,
      scope: scopeFor(pages.length, crawledCount),
      excludedPageCount: item.pages.length - pages.length,
    });
  }

  return { items: kept, droppedItems, droppedPages: droppedPages.size };
}

/**
 * @param {object} index  the output of findingIndex.buildFindingIndex
 * @param {object} [opts]
 * @param {object} [opts.traffic]  reserved for Search Console weighting; when
 *   absent the ranking says so rather than implying it was considered
 * @param {Set}    [opts.excludedKeys]  canonical keys of pages nobody wants audited
 * @returns {object} { actions, needsReview, ranking, totals }
 */
function buildBacklog(index, { traffic = null, excludedKeys = null } = {}) {
  const crawledCount = index?.crawl?.internalPages ?? null;
  const rawItems = Array.isArray(index?.items) ? index.items : [];
  const excl = applyExclusions(rawItems, excludedKeys, crawledCount);
  const all = excl.items;

  const decorate = (item) => ({
    ...item,
    effortHint: effortHint(item),
    basisLine: basisLine(item, crawledCount),
  });

  const actions = all.filter((i) => !isManualCheck(i)).map(decorate).sort(compare);
  const needsReview = all.filter(isManualCheck).map(decorate).sort(compare);

  // Distinct pages named by at least one action — the honest answer to "how much
  // of the site needs work". Never a sum of per-item counts, because one page
  // carries many findings. Counted on the canonical spelling for the same reason
  // the link graph is: a trailing slash would otherwise make one page two.
  const pagesAffected = new Set(
    actions.flatMap((i) => i.pages).map((u) => canonicalKey(u)).filter(Boolean),
  );

  return {
    actions,
    needsReview,
    ranking: {
      trafficWeighted: Boolean(traffic),
      // The one sentence a reader needs before trusting the order.
      basis: traffic
        ? 'Errors first, then fixes that are template-wide, then the share of '
          + 'measured Search Console clicks the affected pages earn.'
        : 'Errors first, then fixes that are template-wide, then how many pages '
          + 'are affected. Not weighted by traffic — Search Console is not '
          + 'connected, so reach is counted in pages.',
      keys: ['severity', 'template scope', 'pages affected', 'source priority', 'title'],
      // Named so the UI can offer the thing that would improve the ranking.
      missing: traffic ? [] : ['search_console'],
    },
    totals: {
      actions: actions.length,
      needsReview: needsReview.length,
      // How the work splits by how bad each item is. Four numbers rather than a
      // single "47 things to fix", because 47 notices and 47 errors are the same
      // figure and not remotely the same situation — and a reader deciding
      // whether to act on this needs the second fact, not the first. An unknown
      // severity is counted under `unknown` and never folded into `notice`,
      // which would report an absent judgement as a mild one (§16.11).
      bySeverity: actions.reduce((acc, i) => {
        const key = SEVERITY_RANK[String(i.severity || '').toLowerCase()] === undefined
          ? 'unknown' : String(i.severity).toLowerCase();
        acc[key] = (acc[key] || 0) + 1;
        return acc;
      }, { error: 0, warning: 0, notice: 0, info: 0, unknown: 0 }),
      templateWide: actions.filter((i) => i.scope === 'template').length,
      // Template-wide items, split the same way. "Nine of your twelve errors are
      // one change each" is the single most decision-changing sentence this
      // layer can produce, and it needs both halves.
      templateWideErrors: actions.filter((i) => i.scope === 'template' && String(i.severity).toLowerCase() === 'error').length,
      // Pages carrying at least one ERROR — distinct, canonical, counted the
      // same way `pagesAffected` is. Not a sum of per-item counts.
      pagesWithErrors: new Set(
        actions.filter((i) => String(i.severity).toLowerCase() === 'error')
          .flatMap((i) => i.pages).map((u) => canonicalKey(u)).filter(Boolean),
      ).size,
      unattributed: actions.filter((i) => i.pageCount === null).length,
      pagesAffected: pagesAffected.size,
      crawledPages: crawledCount,
      // A module whose run predates the latest crawl names pages from the
      // inventory it saw, which can include URLs the current crawl did not — the
      // live project reports 51 affected pages against 50 crawled. That is a real
      // fact about stale evidence, not a counting bug, so it is explained rather
      // than clamped. `coverage` names which module is stale.
      // What an exclusion took out of this list. Reported so the backlog shrinking
      // is explainable rather than mysterious.
      excludedPages: excl.droppedPages,
      itemsFullyExcluded: excl.droppedItems,
      exclusionNote: excl.droppedPages
        ? `${excl.droppedPages} page(s) are excluded from auditing`
          + (excl.droppedItems
            ? `, which removed ${excl.droppedItems} finding(s) from this list entirely`
            : '')
          + '.'
        : null,
      pagesAffectedNote: crawledCount && pagesAffected.size > crawledCount
        ? `${pagesAffected.size} pages are named across all findings, more than the `
          + `${crawledCount} in the latest crawl: at least one module ran against an `
          + 'earlier inventory of the site. Re-run it to bring the two together.'
        : null,
    },
  };
}

module.exports = {
  buildBacklog,
  applyExclusions,
  isManualCheck,
  effortHint,
  basisLine,
  compare,
  severityRank,
  priorityRank,
  SEVERITY_RANK,
  PRIORITY_RANK,
  SCOPE_RANK,
};
