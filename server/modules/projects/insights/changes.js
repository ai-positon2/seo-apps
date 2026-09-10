// ── What changed since last time ──────────────────────────────────────────────
//
// The question a retainer client asks every month, and the product could not
// answer it: run history has always been stored and nothing ever compared two
// runs. Scores, findings and per-page reports are all already there.
//
// The trap this module exists to avoid: **"fixed" is the easiest lie to tell.**
//
// The three page audits work to a page budget — ten of fifty crawled pages by
// default — and the pages they pick are ranked by inbound links, so the audited
// SET changes between runs as the site's link structure changes. A finding that
// appears in run 1 and not in run 2 therefore has two completely different
// explanations:
//
//   * the page was audited again and the defect is gone      → fixed
//   * the page was not audited this time                     → unknown
//
// Reporting the second as the first would tell a client they fixed something
// nobody looked at. So a fix is only ever claimed for a page that was audited in
// BOTH runs; everything else is `not_rechecked`, and the count of those is stated
// next to the count of fixes so the two cannot be confused.
//
// The same reasoning applies to the crawl: it stops at a URL cap, and which URLs
// it reaches can shift.

const moduleEvidence = require('../moduleEvidence');
const overview = require('../overview');
const db = require('../../../services/db');
const { normalizeRuleId } = require('./findingIndex');

const SCORED_STATUSES = ['completed', 'insufficient_data'];

/** Two runs of one module: the latest, and the one before it. */
async function lastTwoRuns(projectId, moduleKey) {
  const runs = await moduleEvidence.listRuns(projectId, moduleKey, { limit: 10 });
  const terminal = runs.filter((r) => SCORED_STATUSES.includes(r.status));
  return { current: terminal[0] || null, previous: terminal[1] || null };
}

/**
 * Which pages a run actually audited, and which of them succeeded.
 *
 * A page whose audit failed is not evidence of anything: it must not count as
 * "no findings", which would read as a clean page.
 */
async function auditedPages(runId) {
  const rows = await moduleEvidence.pageRunsForRun(runId);
  const audited = new Set();
  for (const row of rows) {
    if (row.status === 'failed') continue;
    if (row.url) audited.add(row.url);
  }
  return { audited, rows };
}

function findingKeys(rows) {
  // rule → the pages it was found on, for one run.
  const byRule = new Map();
  for (const row of rows) {
    if (row.status === 'failed') continue;
    for (const f of (Array.isArray(row.findings) ? row.findings : [])) {
      const ruleId = normalizeRuleId(f.ruleId);
      if (!ruleId) continue;
      if (!byRule.has(ruleId)) byRule.set(ruleId, { title: f.title, pages: new Set() });
      if (row.url) byRule.get(ruleId).pages.add(row.url);
    }
  }
  return byRule;
}

/**
 * Per-page module: compare rule-by-rule, page-by-page, over the pages both runs
 * covered.
 */
async function perPageDelta(moduleKey, current, previous) {
  const [now, before] = await Promise.all([
    auditedPages(current.id),
    auditedPages(previous.id),
  ]);

  // The only pages any claim can be made about.
  const comparable = [...now.audited].filter((u) => before.audited.has(u));
  const droppedOut = [...before.audited].filter((u) => !now.audited.has(u));
  const newlyAudited = [...now.audited].filter((u) => !before.audited.has(u));

  const nowRules = findingKeys(now.rows);
  const beforeRules = findingKeys(before.rows);
  const comparableSet = new Set(comparable);

  const fixed = [];
  const appeared = [];
  const stillOpen = [];

  for (const [ruleId, entry] of beforeRules) {
    const wasOn = [...entry.pages].filter((u) => comparableSet.has(u));
    if (!wasOn.length) continue;  // only on pages nobody re-audited
    const isOn = [...(nowRules.get(ruleId)?.pages || [])].filter((u) => comparableSet.has(u));
    const goneFrom = wasOn.filter((u) => !isOn.includes(u));
    if (goneFrom.length) fixed.push({ ruleId, title: entry.title, pages: goneFrom });
    if (isOn.length) stillOpen.push({ ruleId, title: entry.title, pages: isOn });
  }

  for (const [ruleId, entry] of nowRules) {
    const isOn = [...entry.pages].filter((u) => comparableSet.has(u));
    if (!isOn.length) continue;
    const wasOn = [...(beforeRules.get(ruleId)?.pages || [])].filter((u) => comparableSet.has(u));
    const newOn = isOn.filter((u) => !wasOn.includes(u));
    if (newOn.length) appeared.push({ ruleId, title: entry.title, pages: newOn });
  }

  return {
    comparablePages: comparable.length,
    pagesAuditedNow: now.audited.size,
    pagesAuditedBefore: before.audited.size,
    // Named, not summarised: "3 pages were not re-checked" is the sentence that
    // stops a fix count being read as the whole story.
    notRechecked: droppedOut,
    newlyAudited,
    fixed,
    appeared,
    stillOpen,
  };
}

/** Site-level module: compare the run-level finding lists. */
function runLevelDelta(current, previous) {
  const keyed = (run) => new Map(
    (Array.isArray(run.findings) ? run.findings : [])
      .map((f) => [normalizeRuleId(f.ruleId), f]),
  );
  const now = keyed(current);
  const before = keyed(previous);

  return {
    comparablePages: null,
    fixed: [...before.keys()].filter((k) => !now.has(k))
      .map((k) => ({ ruleId: k, title: before.get(k).title, pages: [] })),
    appeared: [...now.keys()].filter((k) => !before.has(k))
      .map((k) => ({ ruleId: k, title: now.get(k).title, pages: [] })),
    stillOpen: [...now.keys()].filter((k) => before.has(k))
      .map((k) => ({ ruleId: k, title: now.get(k).title, pages: [] })),
    notRechecked: [],
    newlyAudited: [],
  };
}

function scoreDelta(current, previous) {
  const now = current.score === null || current.score === undefined ? null : Number(current.score);
  const then = previous.score === null || previous.score === undefined
    ? null : Number(previous.score);
  // A missing score on either side means there is no delta to report — not a
  // delta of zero, and not a fall to zero (§16.11).
  if (now === null || then === null) {
    return { current: now, previous: then, delta: null, direction: 'unknown' };
  }
  const delta = now - then;
  return {
    current: now,
    previous: then,
    delta,
    direction: delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat',
  };
}

/**
 * @param {object} input
 * @param {object} input.access
 * @returns {Promise<object>} { modules, crawl, generatedAt }
 */
async function buildChanges({ access }) {
  if (!db.isDatabaseConfigured()) {
    throw Object.assign(new Error('Change detection needs the database configured.'), { status: 503 });
  }

  const projectId = access.project.id;
  const modules = [];

  for (const module of overview.MODULES) {
    if (module.key === 'technical') continue;

    const { current, previous } = await lastTwoRuns(projectId, module.key);
    if (!current) continue;

    if (!previous) {
      modules.push({
        moduleKey: module.key,
        moduleLabel: module.label,
        state: 'first_run',
        reason: 'This is the first stored run, so there is nothing to compare it against.',
        currentRunId: current.id,
        currentRunAt: current.finished_at || current.created_at,
      });
      continue;
    }

    const perPage = moduleEvidence.PAGE_MODULE_KEYS.includes(module.key);
    const delta = perPage
      ? await perPageDelta(module.key, current, previous)
      : runLevelDelta(current, previous);

    // Zero fixes and zero new findings across zero comparable pages is not "no
    // change" — it is "no comparison". Reporting the first would tell a reader
    // the site held steady when in fact nothing was checked twice.
    if (perPage && !delta.comparablePages) {
      modules.push({
        moduleKey: module.key,
        moduleLabel: module.label,
        state: 'not_comparable',
        reason: delta.pagesAuditedNow === 0 && delta.pagesAuditedBefore === 0
          ? 'Neither run stored per-page reports, so there are no pages to compare. Runs stored '
            + 'before per-page audits existed cannot be diffed page by page.'
          : `No page was audited in both runs (${delta.pagesAuditedBefore} last time, `
            + `${delta.pagesAuditedNow} this time), so nothing can be said about what changed.`,
        currentRunId: current.id,
        currentRunAt: current.finished_at || current.created_at,
        previousRunId: previous.id,
        previousRunAt: previous.finished_at || previous.created_at,
        score: scoreDelta(current, previous),
        pagesAuditedNow: delta.pagesAuditedNow,
        pagesAuditedBefore: delta.pagesAuditedBefore,
      });
      continue;
    }

    modules.push({
      moduleKey: module.key,
      moduleLabel: module.label,
      state: 'compared',
      perPage,
      currentRunId: current.id,
      currentRunAt: current.finished_at || current.created_at,
      previousRunId: previous.id,
      previousRunAt: previous.finished_at || previous.created_at,
      score: scoreDelta(current, previous),
      ...delta,
      // The caveat travels with the numbers rather than living in a footnote.
      caveat: perPage && delta.notRechecked.length
        ? `${delta.fixed.length} fix(es) are counted across the ${delta.comparablePages} page(s) `
          + `audited in both runs. ${delta.notRechecked.length} page(s) audited last time were not `
          + 'audited this time, so nothing is claimed about them.'
        : null,
    });
  }

  // The crawl, which has its own evidence shape.
  const crawlRuns = await overview.recentCrawlRuns(projectId);
  const done = crawlRuns.filter((r) => ['completed', 'stopped'].includes(r.status));
  let crawl = null;
  if (done.length >= 2) {
    const [now, then] = done;
    const counts = (r) => r.summary?.counts || {};
    const pageCount = async (id) => overview.internalPageCount(id);
    const [pagesNow, pagesThen] = await Promise.all([pageCount(now.id), pageCount(then.id)]);
    crawl = {
      moduleKey: 'technical',
      moduleLabel: 'Tech Audit',
      state: 'compared',
      currentRunId: now.id,
      currentRunAt: now.finished_at,
      previousRunId: then.id,
      previousRunAt: then.finished_at,
      pages: { current: pagesNow, previous: pagesThen },
      counts: { current: counts(now), previous: counts(then) },
      caveat: pagesNow !== pagesThen
        ? `The crawl reached ${pagesNow} pages this time and ${pagesThen} last time, so some `
          + 'differences below are a change in what was looked at rather than a change to the site.'
        : null,
    };
  } else if (done.length === 1) {
    crawl = {
      moduleKey: 'technical',
      moduleLabel: 'Tech Audit',
      state: 'first_run',
      reason: 'Only one completed crawl is stored, so there is nothing to compare it against.',
      currentRunId: done[0].id,
      currentRunAt: done[0].finished_at,
    };
  }

  return { modules, crawl, generatedAt: new Date().toISOString() };
}

module.exports = {
  buildChanges,
  perPageDelta,
  runLevelDelta,
  scoreDelta,
  findingKeys,
  lastTwoRuns,
};
