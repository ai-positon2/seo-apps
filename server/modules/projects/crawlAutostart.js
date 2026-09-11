// ── The initial crawl starts itself once a project has something to crawl ───
//
// Everything else waits on this. Hub and Spoke starts itself once a crawl
// finishes (hubSpokeAutostart.js), and SEO & GEO Audit / Agent Readiness start
// themselves at project setup but only against the homepage
// (homepageAutostart.js) — none of them start the crawl itself, so a brand-new
// project sat with a "no data yet" Tech Audit card until someone opened it and
// clicked run by hand, and Hub and Spoke had nothing to react to either.
//
// Unlike the module-run queue (0019) the other four autostarts use, CrawlScope
// runs manual crawls in-process via the shared RunManager (crawlScope/api/
// routes.js POST /runs) — so this mirrors that path directly rather than
// enqueuing: create the run row, then execute it detached. There is also
// nothing to check for "already in flight" the way the others do — a project
// that was just created cannot already have a crawl.

const db = require('../../services/db');
const repo = require('../crawlScope/db/repo');
const { parseCrawlRequest } = require('../crawlScope/shared/options');
const { targetFor } = require('./moduleRunners');

const OFF_VALUES = ['0', 'off', 'false', 'no', 'disabled'];

/** On unless a deployment turns it off. */
function isEnabled() {
  const raw = String(process.env.CRAWL_AUTOSTART ?? '').trim().toLowerCase();
  if (!raw) return true;
  return !OFF_VALUES.includes(raw);
}

/**
 * Start the initial crawl for a project that was just created.
 *
 * Never throws into its caller — creating the project succeeded, and a
 * follow-on crawl that could not be started must not report otherwise. The
 * same rule scheduleCompetitorResearch and scheduleHubSpoke already follow.
 *
 * @param {object} input
 * @param {object} input.project    the just-created project row
 * @param {Array}  input.domains    project_domains rows (from store.listDomains)
 * @param {string} [input.ownerId]  crawl_runs.owner — the user who created the project
 * @param {object} [input.crawlOptions] passed through to CrawlScope as-is
 * @returns {Promise<{scheduled: boolean, reason: string, runId: string|null}>}
 */
async function scheduleInitialCrawl({ project, domains = [], ownerId, crawlOptions } = {}) {
  const answer = (extra) => ({ scheduled: false, runId: null, ...extra });

  if (!isEnabled()) return answer({ reason: 'autostart_disabled' });
  if (!db.isDatabaseConfigured()) return answer({ reason: 'not_configured' });
  if (!project?.id) return answer({ reason: 'no_project' });

  let target;
  try {
    target = targetFor(project, domains);
  } catch {
    return answer({ reason: 'no_primary_domain' });
  }

  let parsed;
  try {
    parsed = parseCrawlRequest({ url: target.origin, options: crawlOptions || {} });
  } catch (e) {
    console.error('[crawlAutostart] could not build a crawl request:', e.message);
    return answer({ reason: 'invalid_crawl_request' });
  }

  let run;
  try {
    run = await repo.createRun(db, {
      owner: ownerId || null,
      workspace_id: project.workspace_id || null,
      project_id: project.id,
      url: parsed.url,
      options: parsed.options,
      // crawl_runs_trigger_check only allows 'manual', 'schedule' or
      // 'initial' — the schema already had a value for exactly this case.
      trigger: 'initial',
    });
  } catch (e) {
    console.error('[crawlAutostart] could not create the crawl run:', e.message);
    return answer({ reason: 'create_failed' });
  }

  // Detached, same as the manual POST /runs path — the caller (project
  // creation) must not wait out an entire crawl before responding.
  // The shared RunManager instance, not a second one: pause/resume/stop and
  // the SSE stream both key off manager.isActive(run.id) against THIS
  // instance, so a crawl this starts has to run on it to be controllable
  // the same way a manually started one is.
  const { manager } = require('../crawlScope/api/routes');
  manager.execute(run).catch((error) => {
    console.error(`[crawlAutostart] crawl ${run.id} failed:`, error.message);
  });

  return answer({ scheduled: true, reason: 'queued', runId: run.id });
}

module.exports = { isEnabled, scheduleInitialCrawl };
