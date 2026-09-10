const caStore = require('../contentArchitect/store');
const db = require('../../services/db');
const crawlToArchitect = require('./crawlToArchitect');
const autostart = require('./hubSpokeAutostart');

async function ensureProject(project, domains = []) {
  const primary = domains.find((d) => d.role === 'primary' && d.status === 'active');
  const domain = primary?.normalized_origin || project.primaryDomain?.origin
    || project.url || project.legacyUrl;
  if (!domain) throw Object.assign(new Error('This project needs a primary domain.'), { status: 400 });
  return caStore.ensureProject({
    platformProjectId: project.id,
    workspaceId: project.workspace_id || project.workspaceId || null,
    domain,
    host: new URL(domain).host,
  });
}

async function recentRuns(projectId) {
  return db.rows(
    `select id, status, created_at, started_at, error,
            payload->>'note' as "note",
            payload->>'crawlRunId' as "crawlRunId"
       from project_module_runs
      where project_id = $1 and module_key = 'hub_spoke'
      order by created_at desc
      limit 25`,
    [projectId]
  );
}

// Serialize catch-up requests from repeated mounts/tabs. The crawl completion
// trigger still owns normal scheduling; this repairs projects that predate it.
const connecting = new Map();
async function connect(options) {
  const id = options.access.project.id;
  if (connecting.has(id)) return connecting.get(id);
  const pending = status({ ...options, start: true });
  connecting.set(id, pending);
  try { return await pending; } finally { connecting.delete(id); }
}

async function status({ access, domains = [], start = false, retry = false }) {
  const project = await ensureProject(access.project, domains);
  const [crawl, runs, analysis] = await Promise.all([
    crawlToArchitect.latestCompletedCrawl(access.project.id),
    recentRuns(access.project.id),
    caStore.getFullAnalysis(project.id),
  ]);
  const inFlight = runs.find((r) => ['queued', 'running'].includes(r.status));
  const attempted = crawl && runs.find((r) => r.crawlRunId === crawl.id
    || Date.parse(r.started_at || r.created_at) >= Date.parse(crawl.finished_at || crawl.created_at));
  const ready = Boolean(analysis);
  let scheduled = null;
  if (start && crawl && !inFlight && access.can('startRun') === true
    && (retry || (!attempted && project.crawlRunId !== crawl.id))) {
    scheduled = await autostart.scheduleHubSpoke({
      run: {
        project_id: access.project.id,
        workspace_id: access.project.workspace_id,
        owner: access.userId,
        url: project.domain,
      },
      delayMs: 0,
    });
  }
  let state = ready ? 'analyzed' : 'waiting_for_crawl';
  let note = ready ? 'Content architecture is ready.'
    : 'Content Architect is set up. Analysis starts automatically when the project crawl finishes.';
  if (inFlight || scheduled?.scheduled) {
    state = inFlight?.status === 'running' ? 'analyzing' : 'queued';
    note = state === 'analyzing' ? 'Analyzing the pages from your project crawl.'
      : 'Analysis is queued and will start automatically.';
  } else if (attempted && !['completed', 'completed_with_errors'].includes(attempted.status)) {
    state = attempted.status;
    note = attempted.error || attempted.note || 'The analysis did not finish. Retry it from this project.';
  } else if (crawl && !ready) {
    state = 'not_started';
    note = !autostart.isEnabled()
      ? 'Automatic Content Architect analysis is disabled on this server.'
      : 'Content Architect is set up, but its analysis has not started. Retry to queue it.';
  }
  return { project, state, note, ready, canStartRun: access.can('startRun') === true && autostart.isEnabled() };
}

module.exports = { ensureProject, connect, status };
