const db = require('../../services/db');
const moduleQueue = require('../../services/moduleQueue');

const MODULE_KEYS = ['seo_geo', 'agent_readiness'];
const TRIGGER = 'project_setup';
const scheduling = new Map();

function homepageUrl(project, domains = []) {
  const primary = domains.find((d) => d.role === 'primary' && d.status === 'active');
  const url = new URL(primary?.normalized_origin || project.url);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('A valid primary domain is required for homepage audits.');
  }
  return `${url.origin}/`;
}

/** One initial homepage run per module. Repeated setup events reuse those runs. */
async function scheduleHomepageAudits({ access, domains = [] }) {
  if (!db.isDatabaseConfigured()) return { scheduled: false, reason: 'not_configured', runs: [] };
  if (!access?.project?.id || access.can?.('startRun') !== true) {
    return { scheduled: false, reason: 'not_authorized', runs: [] };
  }
  const project = access.project;
  if (scheduling.has(project.id)) return scheduling.get(project.id);
  const work = (async () => {
    const targetUrl = homepageUrl(project, domains);
    const data = await db.rows(
      `select id, module_key, status from project_module_runs
        where project_id = $1 and trigger = $2 and module_key = any($3)`,
      [project.id, TRIGGER, MODULE_KEYS]
    );
    const runs = [...data];
    const errors = [];
    for (const moduleKey of MODULE_KEYS) {
      if (runs.some((r) => r.module_key === moduleKey)) continue;
      try {
        const run = await moduleQueue.enqueue({
          projectId: project.id,
          workspaceId: project.workspace_id || null,
          moduleKey,
          trigger: TRIGGER,
          targetUrl,
          createdBy: access.userId || null,
          countryCode: project.country_code || null,
          scheduledFor: new Date().toISOString(),
        });
        if (!run) throw new Error('The module queue is unavailable.');
        runs.push(run);
      } catch (e) {
        errors.push({ moduleKey, message: e.message });
        console.error(`[homepageAutostart] could not queue ${moduleKey}:`, e.message);
      }
    }
    return { scheduled: runs.length === MODULE_KEYS.length, targetUrl, runs, errors };
  })();
  scheduling.set(project.id, work);
  try { return await work; } finally { scheduling.delete(project.id); }
}

// A follow-on failure must not turn a successfully created project into a 500.
async function scheduleForProject(req, projectId) {
  try {
    const access = await require('../../services/projectAccess').requireProject(req, projectId, 'startRun');
    const domains = await require('./store').listDomains(projectId);
    return await scheduleHomepageAudits({ access, domains });
  } catch (e) {
    console.error('[homepageAutostart] setup skipped:', e.message);
    return { scheduled: false, reason: 'not_started', runs: [] };
  }
}

module.exports = { MODULE_KEYS, TRIGGER, homepageUrl, scheduleHomepageAudits, scheduleForProject };
