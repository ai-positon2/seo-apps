// ── The insight layer, assembled ─────────────────────────────────────────────
//
// One read for the dashboard: the evidence index, the ranked backlog, the
// cross-module insights, what changed since last time, and an explicit account of
// what is not measured.
//
// Composed rather than merged: each layer stays independently testable, and each
// can be fetched on its own by a caller that only wants one of them.

const findingIndex = require('./findingIndex');
const projectPages = require('../pages');
const backlogModule = require('./backlog');
const correlations = require('./correlations');
const changes = require('./changes');

/**
 * What the product cannot currently see, and what would fix it.
 *
 * Assembled from the coverage block plus the ranking's own declaration of what it
 * lacked. PRD §30: a capability gap is surfaced, never quietly absent — a
 * dashboard that shows six modules' findings without saying that three of them
 * failed is not a partial answer, it is a wrong one.
 */
function buildGaps({ index, backlog, correlated }) {
  const gaps = [];

  for (const c of index.coverage) {
    if (c.state === 'measured' && !c.stale) continue;
    gaps.push({
      kind: 'module',
      moduleKey: c.moduleKey,
      label: c.moduleLabel,
      state: c.stale ? 'stale' : c.state,
      reason: c.stale
        ? 'This ran before the latest crawl, so it describes an earlier inventory of the site.'
        : c.reason,
      unblock: c.state === 'failed' ? 'Re-run it — the failure reason is above.'
        : c.state === 'never_run' ? 'Run it.'
          : c.stale ? 'Re-run it against the current crawl.' : null,
    });
  }

  for (const w of correlated.withheld) {
    gaps.push({
      kind: 'insight',
      id: w.id,
      modules: w.modules,
      reason: w.reason,
      unblock: w.unblock,
    });
  }

  if (!backlog.ranking.trafficWeighted) {
    gaps.push({
      kind: 'data',
      id: 'search_console',
      reason: 'No Search Console connection, so the backlog is ranked by how many pages a defect '
        + 'affects rather than by how much traffic those pages earn.',
      unblock: 'Connect Search Console for this project.',
    });
  }

  if (backlog.totals.excludedPages) {
    gaps.push({
      kind: 'exclusion',
      id: 'excluded_pages',
      reason: backlog.totals.exclusionNote,
      unblock: 'Review the exclusions on the pages screen if this looks wrong.',
    });
  }

  if (backlog.totals.unattributed) {
    gaps.push({
      kind: 'attribution',
      id: 'unattributed_findings',
      reason: `${backlog.totals.unattributed} finding(s) record a count but not which pages they `
        + 'are on, so they cannot be worked from or ranked by reach.',
      unblock: 'Re-run the module that produced them; newer runs store page attribution.',
    });
  }

  return gaps;
}

/**
 * @param {object} input
 * @param {object} input.access  from projectAccess.requireProject
 * @param {object} [input.traffic]  Search Console metrics, when connected
 */
async function buildInsights({ access, traffic = null }) {
  const index = await findingIndex.buildFindingIndex({ access });

  // Pages somebody has decided not to audit. Degrades to an empty set when
  // project_pages does not exist yet, so the backlog is unchanged rather than
  // broken before migration 0015 is applied.
  const excluded = await projectPages
    .excludedKeys(access.project.id)
    .catch((e) => {
      console.error('[insights.excludedKeys]', e.message);
      return new Set();
    });

  const backlog = backlogModule.buildBacklog(index, { traffic, excludedKeys: excluded });
  const correlated = correlations.buildCorrelations({ index, backlog });

  // Change detection reads a second run per module and must never take the
  // dashboard down with it — the rest of the answer is still worth having.
  let changed = null;
  let changesError = null;
  try {
    changed = await changes.buildChanges({ access });
  } catch (e) {
    changesError = e.message;
    console.error('[insights.changes]', e.message);
  }

  return {
    project: {
      id: access.project.id,
      name: access.project.name,
    },
    lead: correlated.lead,
    insights: correlated.insights,
    backlog: {
      actions: backlog.actions,
      needsReview: backlog.needsReview,
      ranking: backlog.ranking,
      totals: backlog.totals,
    },
    changes: changed,
    changesError,
    coverage: index.coverage,
    gaps: buildGaps({ index, backlog, correlated }),
    crawl: index.crawl,
    keywords: index.keywords,
    keywordRecovery: index.keywordRecovery,
    generatedAt: new Date().toISOString(),
  };
}

module.exports = {
  buildInsights,
  buildGaps,
  findingIndex,
  backlog: backlogModule,
  correlations,
  changes,
};
