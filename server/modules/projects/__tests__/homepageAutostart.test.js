const assert = require('node:assert/strict');
const { test, beforeEach, afterEach, mock } = require('node:test');

const { createFakeDb } = require('./helpers/fakeDb');

// Only these three tables may be touched. `queried` records every read, which
// is what lets a test assert that homepage setup never goes near a crawl.
const tables = { crawl_projects: [], project_module_runs: [], project_module_page_runs: [] };
const queried = [];
let failModule = null;

const fakeDb = createFakeDb(tables, {
  onQuery: (table) => queried.push(table),
  beforeInsert: (table, row) => {
    if (table === 'project_module_runs' && row.module_key === failModule) {
      throw new Error('Queue insert failed');
    }
  },
});

const dbPath = require.resolve('../../../services/db');
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true, exports: fakeDb,
};

const autostart = require('../homepageAutostart');
const executors = require('../../../services/moduleExecutors');
const runners = require('../moduleRunners');
const projectsStore = require('../store');
const projectAccess = require('../../../services/projectAccess');
const seoService = require('../../../routes/seoGeoAudit');
const agentService = require('../../../routes/agentReadinessAudit');
let access;
let seoMock;
let agentMock;

beforeEach(() => {
  for (const table of Object.keys(tables)) tables[table] = [];
  queried.length = 0;
  failModule = null;
  access = {
    project: { id: 'project-a', url: 'https://example.com/old-path', workspace_id: 'workspace-a', country_code: 'US', settings: {
      pageKeywords: [{ url: 'https://example.com', keywords: ['homepage keyword'] }],
    } },
    userId: 'user-a', can: () => true,
  };
  tables.crawl_projects.push(access.project);
  mock.method(require('../../../services/auditEvents'), 'record', async () => {});
  mock.method(console, 'error', () => {});
  seoMock = mock.method(seoService, 'runSeoGeoAudit', async () => ({
    findings: { scores: { overall: 83 }, checks: [{ id: 'title', title: 'Missing title', severity: 'warning' }] },
    ai: { recommendations: 'Improve the title' },
  }));
  agentMock = mock.method(agentService, 'runAgentReadiness', async () => ({
    site: { score: 72, level: 'AI aware' }, checks: [], onPageChecks: [], brief: 'Agent readiness brief',
  }));
});
afterEach(() => mock.restoreAll());

test('project setup immediately queues both homepage audits with no crawl or audit request', async () => {
  const result = await autostart.scheduleHomepageAudits({ access });
  assert.equal(result.scheduled, true);
  assert.deepEqual(result.runs.map((r) => r.module_key), ['seo_geo', 'agent_readiness']);
  for (const run of result.runs) {
    assert.equal(run.trigger, 'project_setup');
    assert.equal(run.target_url, 'https://example.com/');
    assert.equal(run.project_id, access.project.id);
    assert.equal(run.workspace_id, access.project.workspace_id);
    assert.equal(run.created_by, access.userId);
    assert.equal(run.status, 'queued');
    assert.ok(Date.parse(run.scheduled_for) <= Date.now());
  }
  assert.equal(seoMock.mock.callCount(), 0);
  assert.equal(agentMock.mock.callCount(), 0);
  assert.ok(queried.every((t) => t === 'project_module_runs'));
});

test('the active primary domain wins and is normalized to its homepage', async () => {
  const result = await autostart.scheduleHomepageAudits({ access, domains: [
    { role: 'competitor', status: 'active', normalized_origin: 'https://competitor.com' },
    { role: 'primary', status: 'active', normalized_origin: 'https://www.primary.com/path?query=1' },
  ] });
  assert.equal(result.targetUrl, 'https://www.primary.com/');
});

test('concurrent and repeated setup does not duplicate queued or finished initial audits', async () => {
  await Promise.all(Array.from({ length: 6 }, () => autostart.scheduleHomepageAudits({ access })));
  assert.equal(tables.project_module_runs.length, 2);
  tables.project_module_runs[0].status = 'completed';
  tables.project_module_runs[1].status = 'failed';
  await autostart.scheduleHomepageAudits({ access });
  assert.equal(tables.project_module_runs.length, 2);
});

test('failure to queue one module does not prevent the other; retry only fills the missing run', async () => {
  failModule = 'seo_geo';
  const partial = await autostart.scheduleHomepageAudits({ access });
  assert.equal(partial.scheduled, false);
  assert.equal(partial.errors[0].moduleKey, 'seo_geo');
  assert.deepEqual(partial.runs.map((r) => r.module_key), ['agent_readiness']);
  failModule = null;
  const retried = await autostart.scheduleHomepageAudits({ access });
  assert.equal(retried.scheduled, true);
  assert.equal(tables.project_module_runs.length, 2);
});

test('a caller without run permission cannot schedule the audits', async () => {
  const result = await autostart.scheduleHomepageAudits({ access: { ...access, can: () => false } });
  assert.equal(result.reason, 'not_authorized');
  assert.equal(tables.project_module_runs.length, 0);
});

test('the worker stores both native homepage reports and scores without reading a crawl', async () => {
  const { runs } = await autostart.scheduleHomepageAudits({ access });
  for (const run of runs) {
    run.status = 'running';
    await executors[run.module_key](run, { isStillOurs: () => true });
    assert.equal(run.status, 'completed');
    assert.equal(run.payload.scope, 'homepage');
    assert.equal(run.payload.pagesAudited, 1);
    assert.equal(run.payload.crawlRunId, undefined);
    assert.equal(run.payload.pagesCrawled, undefined);
    assert.match(run.payload.note, /homepage only/);
    assert.ok(run.score_basis);
  }
  const seoPage = tables.project_module_page_runs.find((r) => r.module_key === 'seo_geo');
  const agentPage = tables.project_module_page_runs.find((r) => r.module_key === 'agent_readiness');
  assert.equal(seoPage.source, 'project_setup');
  assert.equal(seoPage.url, 'https://example.com/');
  assert.equal(seoPage.score, 83);
  assert.equal(seoPage.payload.native.ai.recommendations, 'Improve the title');
  assert.equal(agentPage.score, 72);
  assert.equal(agentPage.payload.native.brief, 'Agent readiness brief');
  assert.deepEqual(seoMock.mock.calls[0].arguments[0], { url: 'https://example.com/', keywords: ['homepage keyword'], skipAi: false });
  assert.deepEqual(agentMock.mock.calls[0].arguments[0], { url_homepage: 'https://example.com/', skipBrief: false });
  assert.equal(tables.project_module_runs.length, 2, 'workers complete the queued runs instead of opening others');
});

test('a failed homepage closes its page and parent as failed without blocking the other module', async () => {
  seoMock.mock.mockImplementation(async () => { throw new Error('Homepage fetch failed'); });
  const { runs } = await autostart.scheduleHomepageAudits({ access });
  await assert.rejects(executors.seo_geo(runs[0]), /Homepage fetch failed/);
  assert.equal(runs[0].status, 'failed');
  assert.equal(tables.project_module_page_runs[0].status, 'failed');
  await executors.agent_readiness(runs[1]);
  assert.equal(runs[1].status, 'completed');
});

test('manual project audits retain the crawl-based path', async () => {
  const read = mock.method(require('../crawledPages'), 'listCrawledPages', async () => ({ crawl: null, pages: [] }));
  mock.method(require('../pages'), 'keyToId', async () => new Map());
  for (const moduleKey of autostart.MODULE_KEYS) {
    const result = await runners.RUNNERS[moduleKey]({ access, project: access.project, run: { id: 'manual', trigger: 'manual' } });
    assert.equal(result.payload.reason, 'no_completed_crawl');
  }
  assert.equal(read.mock.callCount(), 2);
  assert.equal(seoMock.mock.callCount(), 0);
  assert.equal(agentMock.mock.callCount(), 0);
});

test('a reclaimed worker does not close a run it no longer owns', async () => {
  const { runs } = await autostart.scheduleHomepageAudits({ access });
  runs[0].status = 'running';
  await executors.seo_geo(runs[0], { isStillOurs: () => false });
  assert.equal(runs[0].status, 'running');
  assert.equal(seoMock.mock.callCount(), 0);
});

test('a worker retry reuses its saved homepage report and page row', async () => {
  const { runs } = await autostart.scheduleHomepageAudits({ access });
  await executors.seo_geo(runs[0]);
  runs[0].status = 'running'; // restarted after the page write
  await executors.seo_geo(runs[0]);
  assert.equal(runs[0].status, 'completed');
  assert.equal(tables.project_module_page_runs.length, 1);
  assert.equal(seoMock.mock.callCount(), 1);
});

test('a worker that loses ownership during an audit leaves its child row to the new owner', async () => {
  const { runs } = await autostart.scheduleHomepageAudits({ access });
  let owned = true;
  seoMock.mock.mockImplementation(async () => {
    owned = false;
    return { findings: { scores: { overall: 83 }, checks: [] } };
  });
  runs[0].status = 'running';
  await executors.seo_geo(runs[0], { isStillOurs: () => owned });
  assert.equal(runs[0].status, 'running');
  assert.equal(tables.project_module_page_runs[0].status, 'running');
});

function response() {
  return { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
}
function handler(router, route) {
  return router.stack.find((l) => l.route?.path === route && l.route.methods.post).route.stack[0].handle;
}
function authorizeCreation() {
  mock.method(require('../../../services/workspaceContext'), 'resolveIdentity', async () => ({ workspaceId: 'workspace-a' }));
  mock.method(projectAccess, 'requireWorkspace', async () => access);
  mock.method(projectAccess, 'requireProject', async () => access);
  mock.method(projectsStore, 'listProjects', async () => []);
  mock.method(projectsStore, 'listDomains', async () => []);
  mock.method(require('../contentArchitect'), 'ensureProject', async () => ({}));
  mock.method(require('../competitorAutostart'), 'scheduleCompetitorResearch', async () => ({ scheduled: false }));
}

test('the main project creation API queues the homepage audits before returning success', async () => {
  authorizeCreation();
  mock.method(projectsStore, 'createProject', async () => ({ id: access.project.id }));
  const res = response();
  await handler(require('../routes'), '/')({ body: { primaryDomain: access.project.url, country: 'US' } }, res);
  assert.equal(res.statusCode, 201);
  assert.equal(res.body.homepageAudits.scheduled, true);
  assert.equal(tables.project_module_runs.length, 2);
});

test('the Site Crawler project form also starts homepage audits at setup', async () => {
  authorizeCreation();
  const repo = require('../../crawlScope/db/repo');
  mock.method(repo, 'createProject', async () => access.project);
  mock.method(repo, 'createRun', async () => ({ id: 'initial-crawl' }));
  const res = response();
  await handler(require('../../crawlScope/api/routes'), '/projects')({
    body: { url: access.project.url, dayOfWeek: 1, hour: 8 },
    user: { id: access.userId }, crawlWorkspaceId: 'workspace-a', db: {},
  }, res, (error) => { throw error; });
  assert.equal(res.statusCode, 201);
  assert.equal(res.body.homepageAudits.scheduled, true);
  assert.equal(res.body.run.id, 'initial-crawl');
});

test('a scheduling failure cannot turn a created project into a failed creation response', async () => {
  authorizeCreation();
  mock.method(projectsStore, 'createProject', async () => ({ id: access.project.id }));
  mock.method(projectAccess, 'requireProject', async () => { throw new Error('Temporary access lookup failure'); });
  const res = response();
  await handler(require('../routes'), '/')({ body: { primaryDomain: access.project.url, country: 'US' } }, res);
  assert.equal(res.statusCode, 201);
  assert.equal(res.body.homepageAudits.scheduled, false);
});
