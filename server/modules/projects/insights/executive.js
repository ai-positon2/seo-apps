// ── The answer for whoever signs off on the work ──────────────────────────────
//
// The dashboard above this layer is built for an operator: composite score, six
// module cards, pages crawled, coverage. That is the right screen for the person
// doing the audit and the wrong one for the person paying for it. A CMO, a
// founder or a VP of marketing opens it and reads four figures, two of which are
// about the TOOL — how many pages it fetched, how many of its six modules have
// run — and none of which answer what they came for:
//
//   1. Is the site in trouble, or not?
//   2. Which way is it moving?
//   3. What is the one thing worth doing, and how much does it cover?
//   4. Can I trust this, and what is it NOT telling me?
//
// This composes those four answers out of evidence that is already stored. It is
// a pure function of the overview and the backlog — no reads, no model calls, no
// new measurement — so it is cheap enough to serve on the dashboard's path and
// testable without a database.
//
// ── What it is not allowed to do ─────────────────────────────────────────────
//
// §6.2 forbids minting a methodology that did not come from a measurement, and
// an executive summary is exactly where that rule gets broken: a "revenue at
// risk" figure, a "$ per month lost", a five-point urgency index. Every one of
// those needs traffic and conversion data this product does not have — the
// backlog says so itself (`ranking.trafficWeighted` is false without a Search
// Console connection), and a fabricated number in front of the person who
// approves budget is the most expensive lie the product could tell.
//
// So reach is stated in PAGES, which is what was actually counted, and the
// summary says out loud that pages are not traffic. Every sentence below is a
// restatement of a stored figure, and `basis` on each block names where it came
// from so a reader who wants to check can.
//
// §16.11 applies throughout: nothing unmeasured is reported as zero, absent, or
// fine. "No errors found" and "nothing has looked for errors" are different
// sentences and this file never confuses them.

const NOT_MEASURED = 'not_measured';

// The bands the dashboard already colours by (ProfileStats, AuditRadar,
// OverviewPanel all use 80/60). Reused rather than re-chosen so a summary that
// says "healthy" cannot sit above a score the rings are drawing in amber.
const HEALTHY_AT = 80;
const WATCH_AT = 60;

/** Pages counted once, however many findings they carry. */
const plural = (n, one, many) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

/**
 * Evidence older than this is described as dated rather than current. Four weeks
 * is the retainer cycle the reporting is built around (insights/changes.js: "the
 * question a retainer client asks every month"), so a reading from before the
 * last one is a reading from a previous engagement period.
 */
const STALE_AFTER_MS = 28 * 24 * 60 * 60 * 1000;

function msSince(iso) {
  if (!iso) return null;
  const at = new Date(iso).getTime();
  return Number.isFinite(at) ? Date.now() - at : null;
}

/**
 * The most recent moment any module produced evidence.
 *
 * `updatedAt` on a card is when that module last ran. The freshest of them is
 * how current the picture is — not the oldest, which would describe the audit as
 * stale because one module has not been re-run.
 */
function lastEvidenceAt(modules) {
  const times = modules
    .map((m) => m.updatedAt && new Date(m.updatedAt).getTime())
    .filter((t) => Number.isFinite(t));
  return times.length ? new Date(Math.max(...times)).toISOString() : null;
}

/**
 * The lowest-scoring areas, worst first — the part of a mean the reader needs
 * named. "64 out of 100" says how much is wrong; "Agent Readiness (33)" says
 * where. Only modules that actually scored and sit below the healthy band are
 * named: an unscored module is not weak, it is unmeasured (§16.11), and naming a
 * module at 85 as a "weakest area" would be a criticism no band supports.
 */
function weakestAreas(modules = [], limit = 2) {
  return modules
    .filter((m) => m && m.scored && Number.isFinite(m.score) && m.score < HEALTHY_AT)
    .map((m) => ({ label: m.label, score: Math.round(m.score) }))
    .sort((a, b) => a.score - b.score)
    .slice(0, limit);
}

/** " Weakest areas: A (33) and B (57)." — or '' when nothing scored below par. */
function weakestClause(modules) {
  const weak = weakestAreas(modules);
  if (!weak.length) return '';
  const named = weak.map((w) => `${w.label} (${w.score})`).join(' and ');
  return ` Weakest area${weak.length === 1 ? '' : 's'}: ${named}.`;
}

/**
 * Error-level findings the module cards report, summed.
 *
 * The verdict's state is decided by the backlog, as it always was. This is only
 * consulted before a sentence claims nothing is broken: the backlog can be empty
 * — still being built, or a module's findings not yet indexed — while a card on
 * the same screen says "1 error", and a summary that announced "no errors"
 * beside it is the contradiction the reader notices first.
 */
function moduleErrorCount(modules = []) {
  return modules.reduce((sum, m) => sum + (Number(m?.counts?.error) || 0), 0);
}

// ── 1. The verdict ───────────────────────────────────────────────────────────
//
// Four states, in the order a reader needs them settled. The order matters more
// than the thresholds: an ERROR outranks a good composite, because a composite
// is a mean and a mean hides a broken thing. A site scoring 84 with eleven pages
// returning 5xx is not "healthy", and a summary that said so would be worse than
// no summary.
//
// Every sentence states a count only when it is above zero. "0 issues are
// holding the site at 64" was the old middle-band sentence on a project whose
// backlog was still empty — a number that explained nothing and contradicted
// the score beside it.
function buildVerdict({ composite, totals, scoredModules, everRun, modules = [] }) {
  if (!everRun) {
    return {
      state: NOT_MEASURED,
      headline: 'Not audited yet',
      sentence: 'Nothing has been checked for this site yet, so there is nothing to report. '
        + 'Run Full Audit to score it.',
      basis: 'No stored module run for this project.',
    };
  }

  const errors = totals?.bySeverity?.error || 0;
  const warnings = totals?.bySeverity?.warning || 0;
  const open = totals?.actions || 0;
  const score = Number.isFinite(composite) ? composite : null;
  // "Nothing is broken" may only be said when neither the backlog nor any card
  // reports an error. See moduleErrorCount.
  const noErrorsAnywhere = !errors && !moduleErrorCount(modules);
  const weakest = weakestClause(modules);

  if (errors) {
    const pages = totals?.pagesWithErrors || 0;
    return {
      state: 'at_risk',
      headline: 'Action needed',
      sentence: `${plural(errors, 'issue is', 'issues are')} serious enough to be costing this site `
        + `search visibility right now`
        + (pages ? `, across ${plural(pages, 'page', 'pages')}` : '')
        + '.'
        + (score === null ? '' : ` The audit scores the site ${score} out of 100 overall.`),
      basis: 'Findings the auditing modules classify as errors, counted from stored runs.',
    };
  }

  if (score !== null && score >= HEALTHY_AT) {
    return {
      state: 'healthy',
      headline: 'In good shape',
      sentence: (noErrorsAnywhere
        ? `Nothing found is serious enough to be losing search visibility, and the audit `
          + `scores the site ${score} out of 100.`
        : `The audit scores the site ${score} out of 100.`)
        + weakest
        + (warnings
          ? ` ${plural(warnings, 'improvement is', 'improvements are')} worth making when there is capacity.`
          : ''),
      basis: 'No error-severity finding in any stored run; composite is the mean of the modules that scored.',
    };
  }

  if (score !== null && score < WATCH_AT) {
    return {
      state: 'needs_attention',
      headline: 'Below where it should be',
      sentence: `${noErrorsAnywhere ? 'Nothing is broken outright, but the' : 'The'} audit scores `
        + `the site ${score} out of 100 — far enough below par that competitors with cleaner `
        + 'sites will out-rank it on equal content.'
        + weakest
        + (warnings ? ` ${plural(warnings, 'issue', 'issues')} to work through.` : ''),
      basis: 'Composite below 60, with no error-severity finding.',
    };
  }

  // Scored in the middle band, or not scored at all but with findings stored.
  //
  // The headline matches the word the score tile above it shows for the same
  // band (client/src/lib/scoreVerdict.js: 60-79 is "Needs attention"), so the
  // two do not read as two different opinions about one number.
  if (score === null) {
    return {
      state: 'needs_attention',
      headline: 'Needs attention',
      sentence: open
        ? `${plural(open, 'issue is', 'issues are')} open. No area has produced a score yet, so `
          + 'there is no overall number to put against them.'
        : 'Checks have started, but no area has produced a score or a fix yet. '
          + 'This fills in as they finish.',
      basis: 'Findings are stored, but no module has produced a score.',
    };
  }

  // Leads with the number and where it is lost, which is the answer; the count
  // of open items follows only when there is one to state.
  return {
    state: 'needs_attention',
    headline: 'Needs attention',
    sentence: `Overall ${score}/100.`
      + weakest
      + (open ? ` ${plural(open, 'issue', 'issues')} to work through.` : ''),
    basis: 'Composite between 60 and 80, with no error-severity finding.',
  };
}

// ── 2. Leverage ──────────────────────────────────────────────────────────────
//
// The single most decision-changing fact this product holds, and until now it
// was one clause of a footnote under a stat: most of the work is not per-page
// work. A template-wide finding is one change that fixes every page carrying it,
// which turns "47 things to fix" — which sounds like a quarter of engineering
// time — into "nine changes cover most of it".
//
// Stated as a share as well as a count, because the share is the argument.
function buildLeverage(totals) {
  const actions = totals?.actions || 0;
  const templateWide = totals?.templateWide || 0;
  const pagesAffected = totals?.pagesAffected || 0;
  const crawledPages = totals?.crawledPages || null;

  if (!actions) {
    return {
      actions: 0,
      templateWide: 0,
      templateShare: null,
      pagesAffected: 0,
      crawledPages,
      sentence: null,
      basis: 'Nothing actionable is stored for this project.',
    };
  }

  const share = Math.round((templateWide / actions) * 100);
  const siteShare = crawledPages ? Math.round((pagesAffected / crawledPages) * 100) : null;

  const parts = [];
  if (templateWide) {
    parts.push(
      `${plural(templateWide, 'fix', 'fixes')} of the ${actions} `
      + `${templateWide === 1 ? 'is' : 'are'} a single template change — ${share}% of the work, `
      + 'done once and applied everywhere',
    );
  }
  if (pagesAffected) {
    parts.push(
      siteShare === null
        ? `${plural(pagesAffected, 'page needs', 'pages need')} some change`
        : `${plural(pagesAffected, 'page', 'pages')} are affected, ${siteShare}% of what was crawled`,
    );
  }

  return {
    actions,
    templateWide,
    templateShare: share,
    pagesAffected,
    crawledPages,
    siteShare,
    sentence: parts.length ? `${parts.join('. ')}.` : null,
    // Named because the ranking says it about itself, and because "affects the
    // most pages" and "costs the most traffic" are different claims.
    basis: 'Counted from stored findings. Reach is pages, not traffic — pages are what was '
      + 'measured, and this project has no Search Console connection to weight them by.',
  };
}

// ── 3. What to do ────────────────────────────────────────────────────────────
//
// Three items, never more. The ranked backlog is already correct — it is a
// lexicographic sort over measured facts, and this does not re-rank it — but a
// list of 47 is a work queue, and a work queue is not a decision. Three is what
// somebody can hold in their head while deciding whether to fund it.
//
// Each item keeps its `key`, so the row is one click from POST
// /insights/promote, which turns it into a recommendation draft. That path has
// existed and had nothing pointing at it.
const TOP_N = 3;

function buildPriorities(actions = []) {
  return actions.slice(0, TOP_N).map((item, index) => ({
    rank: index + 1,
    key: item.key,
    title: item.title,
    moduleKey: item.moduleKey,
    moduleLabel: item.moduleLabel,
    severity: item.severity || null,
    // The two facts that decide whether it is worth doing, already computed by
    // the backlog and already worded: how much it covers, and what it costs.
    reach: item.effortHint || null,
    // The full audit trail for the rank, so a reader who disagrees can see what
    // it was built from rather than being asked to trust an ordering.
    basis: item.basisLine || null,
    scope: item.scope || null,
    pageCount: item.pageCount,
  }));
}

// ── 4. Confidence ────────────────────────────────────────────────────────────
//
// §30: a capability gap is surfaced, never quietly absent. This is where the two
// stats that used to take headline space — Pages crawled and Coverage — belong:
// they are not what the site is doing, they are how much of it was looked at,
// which is a caveat on every other number here.
//
// A summary that does not say what it missed is how a dashboard tells somebody
// their site is clean when nobody checked.
function buildConfidence({ modules, totals, lastAt }) {
  const neverRun = modules.filter((m) => m.status === 'not_run');
  const failed = modules.filter((m) => m.status === 'failed');
  const covered = modules.length - neverRun.length;
  const crawledPages = totals?.crawledPages || null;
  const age = msSince(lastAt);
  const stale = age !== null && age > STALE_AFTER_MS;

  const caveats = [];
  if (neverRun.length) {
    caveats.push(
      `${neverRun.map((m) => m.label).join(', ')} ${neverRun.length === 1 ? 'has' : 'have'} not run, `
      + 'so nothing here covers what they measure.',
    );
  }
  if (failed.length) {
    caveats.push(`${failed.map((m) => m.label).join(', ')} failed on the last attempt.`);
  }
  if (stale) {
    caveats.push('The most recent evidence is over a month old, so this describes the site as it was then.');
  }
  if (totals?.unattributed) {
    caveats.push(
      `${plural(totals.unattributed, 'finding records', 'findings record')} a count but not which pages `
      + 'they are on, so they are not included in the page figures above.',
    );
  }
  if (totals?.excludedPages) {
    caveats.push(totals.exclusionNote);
  }
  if (totals?.pagesAffectedNote) {
    caveats.push(totals.pagesAffectedNote);
  }
  if (!crawledPages) {
    caveats.push('No completed crawl is stored, so the page counts above come from module evidence alone.');
  }

  // Three levels, decided by how much of the audit actually ran — not by how
  // good the news is. A confident-sounding summary over two of six modules is
  // the failure this block exists to prevent.
  const ran = modules.length ? covered / modules.length : 0;
  const level = !covered ? 'none'
    : (ran >= 0.8 && !stale && !failed.length) ? 'high'
      : ran >= 0.5 ? 'partial' : 'low';

  return {
    level,
    modulesCovered: covered,
    modulesTotal: modules.length,
    notRun: neverRun.map((m) => ({ key: m.key, label: m.label })),
    failed: failed.map((m) => ({ key: m.key, label: m.label })),
    crawledPages,
    lastEvidenceAt: lastAt,
    stale,
    sentence: covered
      ? `Based on ${covered} of ${modules.length} audits`
        + (crawledPages ? ` across ${plural(crawledPages, 'crawled page', 'crawled pages')}` : '')
        + '.'
      : 'Nothing has been measured for this site yet.',
    caveats: caveats.filter(Boolean),
  };
}

// ── The trend, over a comparison that was already built ──────────────────────
//
// insights/changes.js answers "what changed since last time" — carefully, with
// the trap that makes it worth keeping: a fix is only ever claimed for a page
// audited in BOTH runs, because a page that dropped out of the audit set has not
// been fixed, it has not been looked at. That module is complete, tested, and
// rendered by nothing.
//
// This reduces it to the one line an executive reads. It is kept apart from
// buildExecutiveSummary because buildChanges is the expensive layer — it walks
// every module's last two runs and was measured at 2.4s of a 3.7s response,
// which is why it was taken off the dashboard's path in the first place. The
// summary renders without it and it fills in when it lands.
function summariseTrend(changes) {
  const compared = (changes?.modules || []).filter((m) => m.state === 'compared');

  if (!compared.length) {
    const firstRun = (changes?.modules || []).some((m) => m.state === 'first_run');
    return {
      state: firstRun ? 'first_run' : 'not_comparable',
      sentence: firstRun
        ? 'This is the first stored audit, so there is nothing to compare it against yet. '
          + 'The next one will show what moved.'
        : 'No two runs cover enough of the same pages to say what changed.',
      basis: 'insights/changes.js — a fix is only claimed for a page audited in both runs.',
    };
  }

  const fixed = compared.reduce((sum, m) => sum + (m.fixed?.length || 0), 0);
  const appeared = compared.reduce((sum, m) => sum + (m.appeared?.length || 0), 0);
  const notRechecked = compared.reduce((sum, m) => sum + (m.notRechecked?.length || 0), 0);

  // Score movement across the modules that scored in both runs. Reported as a
  // count of directions, not as an average of deltas: the six scores are on six
  // different scales (the dashboard's own caption says so), so a mean of their
  // movements would be a number about nothing.
  const moves = compared.map((m) => m.score).filter((s) => s && s.delta !== null);
  const up = moves.filter((s) => s.delta > 0);
  const down = moves.filter((s) => s.delta < 0);

  const direction = (() => {
    if (appeared > fixed) return 'worse';
    if (fixed > appeared) return 'better';
    if (down.length > up.length) return 'worse';
    if (up.length > down.length) return 'better';
    return 'flat';
  })();

  const parts = [];
  if (fixed || appeared) {
    parts.push(
      `${plural(fixed, 'issue', 'issues')} resolved and ${plural(appeared, 'new one', 'new ones')} `
      + 'appeared since the previous audit',
    );
  }
  if (up.length || down.length) {
    parts.push(
      `${up.length} module score${up.length === 1 ? '' : 's'} up, `
      + `${down.length} down`,
    );
  }
  if (!parts.length) parts.push('Nothing measurable moved since the previous audit');

  return {
    state: 'compared',
    direction,
    fixed,
    appeared,
    scoresUp: up.length,
    scoresDown: down.length,
    modulesCompared: compared.length,
    sentence: `${parts.join('; ')}.`,
    // The caveat travels with the number, as it does in changes.js itself.
    caveat: notRechecked
      ? `${plural(notRechecked, 'page', 'pages')} audited last time were not audited this time, `
        + 'so nothing is claimed about them either way.'
      : null,
    basis: 'Compared page by page over the pages audited in both runs.',
  };
}

/**
 * Compose the executive answer.
 *
 * Pure: everything it needs has already been read for the dashboard, so calling
 * it costs nothing beyond the composition and it can be tested without a
 * database. The trend is NOT included — see summariseTrend above.
 *
 * @param {object}  input
 * @param {object}  input.overview  buildOverview's result (modules + composite)
 * @param {object}  input.backlog   buildBacklog's result (actions + totals)
 * @returns {object}
 */
function buildExecutiveSummary({ overview, backlog }) {
  const modules = Array.isArray(overview?.modules) ? overview.modules : [];
  const totals = backlog?.totals || null;
  const actions = Array.isArray(backlog?.actions) ? backlog.actions : [];
  const composite = Number.isFinite(overview?.composite?.value) ? overview.composite.value : null;
  const scoredModules = overview?.composite?.scoredModules || 0;

  // "Has anything ever produced evidence", which is not "did anything score".
  // Hub and Spoke reports findings and has no rubric, so a project audited only
  // by it has evidence and no score — and calling that "not audited yet" would
  // be wrong in the direction that loses trust fastest.
  const everRun = modules.some((m) => m.status !== 'not_run');
  const lastAt = lastEvidenceAt(modules);

  return {
    verdict: buildVerdict({ composite, totals, scoredModules, everRun, modules }),
    standing: {
      // Echoed, never recomputed. §6.2: the composite is the server's own mean of
      // the modules that scored, and a second arithmetic here would eventually
      // publish two different overall numbers for one project.
      score: composite,
      scoredModules,
      totalModules: overview?.composite?.totalModules ?? modules.length,
      status: overview?.composite?.status || 'insufficient_data',
      band: composite === null ? null
        : composite >= HEALTHY_AT ? 'good'
          : composite >= WATCH_AT ? 'fair' : 'poor',
      basis: composite === null
        ? 'No module has produced a score for this project yet.'
        : `Mean of the ${scoredModules} module${scoredModules === 1 ? '' : 's'} that scored. `
          + 'Each is on its own scale, so this is a summary, not a measurement of its own.',
    },
    leverage: buildLeverage(totals),
    priorities: buildPriorities(actions),
    confidence: buildConfidence({ modules, totals, lastAt }),
    generatedAt: new Date().toISOString(),
  };
}

module.exports = {
  buildExecutiveSummary,
  summariseTrend,
  buildVerdict,
  buildLeverage,
  buildPriorities,
  buildConfidence,
  lastEvidenceAt,
  weakestAreas,
  HEALTHY_AT,
  WATCH_AT,
  STALE_AFTER_MS,
  TOP_N,
};
