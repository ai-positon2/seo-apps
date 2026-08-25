// ── Auditing pages as the crawl finds them ───────────────────────────────────
//
// The old flow: crawl runs to completion, then the three per-page modules read
// the stored pages and audit them. That has two problems. Nothing happens for
// the first few minutes and the cards say nothing, and pressing "Run Full Audit"
// ran the modules BEFORE queuing the crawl — so they audited the pages of the
// PREVIOUS crawl and reported it as the current audit.
//
// This follows a crawl instead. It watches crawl_run_results for pages the crawl
// has stored, audits each one, and stops when the crawl is finished and there is
// nothing left. Work starts about ten seconds in rather than three minutes in,
// and every completed page is immediately readable in that module's report.
//
// ── One page at a time, all three modules on it ─────────────────────────────
//
// Three modules could each follow the crawl independently, but then three audits
// fetch the client's site at once, on top of the crawl already fetching it. The
// crawler is careful about per-host delay and it would be strange for the audits
// built on top of it not to be. So there is ONE loop: take the next page, run
// each module against it, then take the next page. Load on the client's site is
// one audit at a time, and all three cards advance together.
//
// ── What this changes about which pages get audited ────────────────────────
//
// The completed-crawl path ranks pages by how many other pages link to them,
// which is the best available measure of what a site treats as important. That
// ranking needs the whole link graph, and the whole link graph does not exist
// until the crawl ends. Following a crawl therefore audits in DISCOVERY order.
//
// That is defensible — a crawl reaches the homepage first, then depth 1 — but it
// is a different set from the ranked one, so the run says so in its own note
// rather than letting anyone assume the audited pages were chosen by importance.
//
// ── What this does NOT fix ─────────────────────────────────────────────────
//
// A server restart still destroys the work in progress. The parent rows are left
// at 'running' and the sweeper fails them within their allowance. Fixing that
// needs the leased job model (plan B2); nothing here can recover a dead process.

const { getSupabase, isSupabaseConfigured } = require('../../services/supabase');
const adminLimits = require('../../services/adminLimits');
const moduleEvidence = require('./moduleEvidence');
const projectPages = require('./pages');
const pageSelection = require('./pageSelection');
const { canonicalKey } = require('./crawledPages');

// How often to look for pages the crawl has newly stored. The crawl writes rows
// in batches, and a page audit takes tens of seconds, so polling faster than this
// would just spend queries to learn nothing.
const POLL_MS = 4000;

// Waiting for a crawl to START is a different thing from waiting for a running
// crawl to produce a page, and conflating them was a real bug: a single 5-minute
// idle timeout guaranteed this loop gave up before the crawl began.
//
// Measured on this deployment, a queued crawl waits 612-637 seconds before the
// worker picks it up, and then takes 37-42 seconds to finish. So the patience for
// a queued crawl has to exceed ten minutes, while patience for a RUNNING crawl
// that has stopped producing pages can be short, because a running crawl writes
// its first row about twelve seconds in.
//
// (That ~620s queue wait is itself suspicious and worth fixing separately: it
// matches the crawl worker's RUN_STALE_MS of 600_000 almost exactly, which
// suggests manual runs are being rescued by stale recovery rather than picked up
// by the worker's own 5-second poll.)
const QUEUE_TIMEOUT_MS = 20 * 60 * 1000;
const IDLE_TIMEOUT_MS = 3 * 60 * 1000;

const CRAWL_TERMINAL = ['completed', 'stopped', 'failed', 'cancelled'];
// A crawl that has not begun. Time spent here is queue latency, not silence.
const CRAWL_PENDING = ['queued', 'pending'];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The crawl's current status, or null if it has gone. */
async function crawlStatus(crawlRunId) {
  const { data, error } = await getSupabase()
    .from('crawl_runs')
    .select('id, status, finished_at, created_at, options')
    .eq('id', crawlRunId)
    .maybeSingle();
  if (error) throw new Error(`[streamingAudit.crawlStatus] ${error.message}`);
  return data || null;
}

/**
 * Pages this crawl has stored so far, in the order it found them.
 *
 * Ordered by id, which is insertion order — the closest thing to "the order the
 * crawl discovered them" that the schema records. Assets and non-2xx responses
 * are excluded on the same terms as the completed-crawl path, so the two agree
 * about what counts as an auditable page.
 */
async function pagesSoFar(crawlRunId, afterId = 0) {
  const { data, error } = await getSupabase()
    .from('crawl_run_results')
    .select('id, url, status, data')
    .eq('run_id', crawlRunId)
    .eq('data->>scope', 'Internal')
    .gt('id', afterId)
    .order('id', { ascending: true })
    .limit(200);
  if (error) throw new Error(`[streamingAudit.pagesSoFar] ${error.message}`);

  const usable = [];
  for (const row of (data || [])) {
    const d = row.data || {};
    const url = d.url || row.url;
    if (!url) continue;
    if (d.isAsset) continue;
    const code = Number(d.status ?? row.status);
    if (Number.isFinite(code) && (code < 200 || code >= 300)) continue;
    usable.push({ id: row.id, url, depth: Number(d.depth), title: d.title || null });
  }
  // The high-water mark advances past every row read, auditable or not, so an
  // excluded row is never re-read.
  const lastId = (data || []).reduce((max, r) => Math.max(max, r.id), afterId);
  return { pages: usable, lastId };
}

/** Keywords configured for one URL, if any. */
function keywordsForUrl(project, url, requestKeywords) {
  if (Array.isArray(requestKeywords) && requestKeywords.length) return requestKeywords;
  const configured = Array.isArray(project?.settings?.pageKeywords)
    ? project.settings.pageKeywords : [];
  return configured.find((p) => p.url === url)?.keywords || [];
}

/**
 * Audit pages as a crawl produces them.
 *
 * @param {object} input
 * @param {object} input.access       from projectAccess.requireProject
 * @param {object} input.project
 * @param {string} input.crawlRunId   the crawl to follow
 * @param {string[]} input.moduleKeys which per-page modules to run
 * @param {object} [input.audits]     moduleKey -> per-page audit fn (injected by moduleRunners)
 * @param {string[]} [input.keywords]
 * @param {string} [input.trigger]
 * @returns {Promise<object>} one entry per module: { runId, status, pages, mean }
 */
async function followCrawl({
  access, project, crawlRunId, moduleKeys, audits, keywords = null, trigger = 'audit_all',
}) {
  if (!isSupabaseConfigured()) {
    throw Object.assign(new Error('Streaming audits need Supabase configured.'), { status: 503 });
  }

  const budget = (await adminLimits
    .limit('maxPagesPerModuleAudit', { workspaceId: project.workspace_id })
    .catch(() => null)) || 10;

  // One parent run per module, opened now so the cards show work starting rather
  // than nothing happening. Each carries its own deadline from the budget.
  const runs = new Map();
  for (const moduleKey of moduleKeys) {
    const run = await moduleEvidence.startRun({
      access, moduleKey, trigger, pageBudget: budget, followingCrawlRunId: crawlRunId,
    });
    runs.set(moduleKey, { run, pageResults: [] });
  }

  // canonical key -> project_pages id, so each child row joins to the page
  // inventory. Re-read as the crawl adds pages.
  let pageIds = await projectPages.keyToId(project.id).catch(() => new Map());

  const audited = new Set();
  const auditedPages = [];
  let afterId = 0;
  let lastProgressAt = Date.now();
  const startedWaitingAt = Date.now();
  let crawl = await crawlStatus(crawlRunId);
  let stoppedBecause = null;
  let selection = null;

  const origin = project.url || null;

  // Audits one URL with every module, in sequence, so the client's site is
  // fetched by one auditor at a time. Shared by both phases below and by the
  // "analyze another page" endpoint, so a page added by hand is audited exactly
  // the way an automatically-chosen one is.
  const auditUrl = async (url, ordinal) => {
    const key = canonicalKey(url);
    if (!key || audited.has(key)) return false;      // never audit the same page twice
    audited.add(key);
    auditedPages.push(url);

    for (const moduleKey of moduleKeys) {
      const entry = runs.get(moduleKey);
      const audit = audits[moduleKey];
      if (!audit) continue;

      const pageRun = await moduleEvidence.startPageRun({
        access,
        runId: entry.run.id,
        moduleKey,
        url,
        ordinal,
        pageId: pageIds.get(key) || null,
      });

      try {
        const result = await audit({
          url,
          keywords: keywordsForUrl(project, url, keywords),
          project,
        });
        entry.pageResults.push(await moduleEvidence.completePageRun({
          pageRunId: pageRun.id,
          status: result.status || 'completed',
          score: result.score ?? null,
          scoreMax: result.scoreMax ?? 100,
          band: result.band ?? null,
          findings: result.findings || [],
          payload: result.payload || null,
        }));
      } catch (e) {
        // One page failing one module is one failed page. The others continue.
        console.error(`[stream:${moduleKey}] ${url} failed:`, e.message);
        entry.pageResults.push(await moduleEvidence.completePageRun({
          pageRunId: pageRun.id,
          status: 'failed',
          error: e.message,
        }));
      }
    }

    lastProgressAt = Date.now();
    return true;
  };

  try {
    // ── Phase 1: the homepage, as soon as the crawl has it ──────────────────
    //
    // Not "the first page discovered" — specifically the homepage. It is the one
    // page every site has, the one a reader checks first, and the one whose
    // result is worth showing while the rest of the crawl is still running.
    //
    // Only an exact root counts here. pickHomepage will fall back to the
    // shallowest page, but that is a judgement worth making over the finished
    // crawl rather than over the three pages that happen to have landed first.
    let homepage = null;
    let seenSoFar = 0;
    while (!homepage) {
      const { pages } = await pagesSoFar(crawlRunId, 0);

      // A crawl that is storing pages is not stalled, even if none of them is
      // the homepage yet.
      //
      // Without this the idle clock kept running from the moment the loop
      // started, so any crawl that took longer than IDLE_TIMEOUT_MS to reach the
      // root URL was declared 'crawl_stalled' while it was healthily working —
      // and a sitemap-seeded crawl reaches its root whenever the sitemap happens
      // to list it. The audit then abandoned the full crawl and sampled whatever
      // partial set existed, while its note claimed the crawl had stopped.
      if (pages.length > seenSoFar) {
        seenSoFar = pages.length;
        lastProgressAt = Date.now();
      }

      homepage = pages.find((pg) => {
        const u = pageSelection.safeUrl(pg.url);
        return u && (u.pathname || '/') === '/';
      }) || null;
      if (homepage) break;

      crawl = await crawlStatus(crawlRunId);
      if (!crawl) { stoppedBecause = 'crawl_gone'; break; }
      if (CRAWL_TERMINAL.includes(crawl.status)) break;   // decided below, over the full set

      if (CRAWL_PENDING.includes(crawl.status)) {
        if (Date.now() - startedWaitingAt > QUEUE_TIMEOUT_MS) {
          stoppedBecause = 'crawl_never_started';
          break;
        }
      } else if (Date.now() - lastProgressAt > IDLE_TIMEOUT_MS) {
        stoppedBecause = 'crawl_stalled';
        break;
      }
      await sleep(POLL_MS);
      if (!pageIds.size) pageIds = await projectPages.keyToId(project.id).catch(() => pageIds);
    }

    if (homepage) await auditUrl(homepage.url, 0);

    // ── Phase 2: wait for the crawl to finish ───────────────────────────────
    //
    // Choosing four pages that differ from each other needs the whole list to
    // choose from. Doing it early would pick from whatever the crawl happened to
    // have reached, which is the discovery-order problem this replaced.
    while (!stoppedBecause) {
      crawl = await crawlStatus(crawlRunId);
      if (!crawl) { stoppedBecause = 'crawl_gone'; break; }
      if (CRAWL_TERMINAL.includes(crawl.status)) { stoppedBecause = 'crawl_finished'; break; }

      const { pages, lastId } = await pagesSoFar(crawlRunId, afterId);
      if (pages.length) { afterId = lastId; lastProgressAt = Date.now(); }

      if (CRAWL_PENDING.includes(crawl.status)) {
        if (Date.now() - startedWaitingAt > QUEUE_TIMEOUT_MS) {
          stoppedBecause = 'crawl_never_started';
          break;
        }
      } else if (Date.now() - lastProgressAt > IDLE_TIMEOUT_MS) {
        stoppedBecause = 'crawl_stalled';
        break;
      }
      await sleep(POLL_MS);
    }

    pageIds = await projectPages.keyToId(project.id).catch(() => pageIds);

    // ── Phase 3: four more, chosen to be different from each other ──────────
    const { pages: allPages } = await pagesSoFar(crawlRunId, 0);

    // The homepage may only have appeared at the end of a capped crawl, or the
    // site may have no root at all. Either way it is decided here, over
    // everything the crawl found.
    if (!homepage && allPages.length) {
      homepage = pageSelection.pickHomepage(allPages, origin);
      if (homepage) await auditUrl(homepage.url, 0);
    }

    const alreadyDone = new Set(auditedPages);
    const remaining = Math.max(0, budget - audited.size);
    const want = Math.min(pageSelection.EXTRA_PAGES, remaining);

    if (want > 0 && allPages.length) {
      selection = await pageSelection.selectKeyPages(allPages, {
        exclude: alreadyDone,
        count: want,
      });
      for (const pick of selection.picks) {
        if (audited.size >= budget) { stoppedBecause = 'budget'; break; }
        await auditUrl(pick.url, audited.size);
      }
    }
  } catch (e) {
    // The loop itself broke. Fail every open run with the reason rather than
    // leaving them for the sweeper to guess at an hour later.
    for (const [, entry] of runs) {
      await moduleEvidence.failRun({
        access, runId: entry.run.id, error: `Streaming audit stopped: ${e.message}`,
      }).catch(() => {});
    }
    throw e;
  }

  // Close each parent run with its own rollup.
  const out = [];
  for (const [moduleKey, entry] of runs) {
    const rollup = moduleEvidence.aggregatePages(entry.pageResults);
    const basis = SCORE_BASIS[moduleKey];

    await moduleEvidence.completeRun({
      access,
      runId: entry.run.id,
      status: rollup.totalPages ? 'completed' : 'insufficient_data',
      score: rollup.mean,
      scoreMax: 100,
      scoreBasis: rollup.mean === null
        ? null
        : `Mean of ${rollup.scoredPages} page score(s) from ${basis}`,
      band: `${rollup.totalPages} page${rollup.totalPages === 1 ? '' : 's'} audited`,
      findings: rollup.findings,
      payload: {
        pagesAudited: rollup.totalPages,
        pagesScored: rollup.scoredPages,
        pagesFailed: rollup.failedPages,
        pageBudget: budget,
        crawlRunId,
        followedLiveCrawl: true,
        // How these pages were chosen, in words, because it is the difference
        // between "we audited your site" and "we audited five pages of it".
        pageSelection: selection
          ? pageSelection.selectionBasis({ ...selection, count: selection.picks.length })
          : 'the homepage only — the crawl offered no other page to choose from',
        pageSelectionMethod: selection?.method || null,
        pageSelectionModel: selection?.model || null,
        pageSelectionError: selection?.error || null,
        selectedPages: selection
          ? selection.picks.map((k) => ({ url: k.url, type: k.type, why: k.why }))
          : [],
        stoppedBecause,
        pages: entry.pageResults.map((p) => ({
          pageRunId: p.id,
          url: p.url,
          status: p.status,
          score: p.score === null || p.score === undefined ? null : Number(p.score),
          band: p.band || null,
          counts: p.counts || {},
        })),
      },
      note: rollup.totalPages === 0
        ? (stoppedBecause === 'crawl_never_started'
          ? 'The crawl this audit was following never started, so there were no pages to '
            + 'audit. It sat queued beyond the 20 minutes this waited — the crawl worker may '
            + 'not be picking up manual runs.'
          : stoppedBecause === 'crawl_stalled'
            ? 'The crawl this audit was following stopped producing pages before it finished, '
              + 'so there was nothing to audit.'
            : 'The crawl produced no auditable page before it finished.')
        : `${rollup.totalPages} page(s) audited as the crawl found them`
          + (stoppedBecause === 'budget'
            ? `, stopping at the ${budget}-page budget`
            : stoppedBecause === 'crawl_stalled'
              ? ', then the crawl stopped producing pages'
              : '')
          + (rollup.failedPages ? `. ${rollup.failedPages} page(s) failed` : '')
          + '. Pages were taken in the order the crawl discovered them, not ranked by '
          + 'how many other pages link to them — the link graph does not exist until the '
          + 'crawl finishes.',
    });

    out.push({
      moduleKey,
      runId: entry.run.id,
      pages: rollup.totalPages,
      scored: rollup.scoredPages,
      failed: rollup.failedPages,
      mean: rollup.mean,
    });
  }

  return { crawlRunId, budget, stoppedBecause, pagesAudited: audited.size, modules: out };
}

// Duplicated deliberately rather than imported: requiring moduleRunners here
// would close a cycle (moduleRunners -> streamingAudit -> moduleRunners). The
// strings are asserted identical in the tests.
const SCORE_BASIS = {
  seo_geo: 'the SEO & GEO audit (rule-based bucket scores, weighted composite, capped by blocking issues)',
  agent_readiness: 'the agent readiness audit (weighted HTTP plus on-page checks)',
};

module.exports = {
  followCrawl,
  QUEUE_TIMEOUT_MS,
  CRAWL_PENDING,
  pagesSoFar,
  crawlStatus,
  keywordsForUrl,
  SCORE_BASIS,
  POLL_MS,
  IDLE_TIMEOUT_MS,
  CRAWL_TERMINAL,
};
