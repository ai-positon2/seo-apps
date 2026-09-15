const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after, beforeEach, mock } = require('node:test');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'architect-project-test-'));
process.env.CONTENT_ARCHITECT_DATA_ROOT = tempRoot;
delete process.env.HUB_SPOKE_AUTOSTART;

const { createFakeDb } = require('./helpers/fakeDb');

// Only these two tables may be touched — reading anything else throws, which is
// how these tests assert that Content Architect setup stays off other paths.
const tables = { crawl_runs: [], project_module_runs: [] };
const fakeDb = createFakeDb(tables);

const dbPath = require.resolve('../../../services/db');
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true, exports: fakeDb,
};
const caStore = require('../../contentArchitect/store');
const architect = require('../contentArchitect');
const autostart = require('../hubSpokeAutostart');
const projectAccess = require('../../../services/projectAccess');
const projectsStore = require('../store');

let sequence = 0;
let access;
beforeEach(() => {
  tables.crawl_runs = [];
  tables.project_module_runs = [];
  delete process.env.HUB_SPOKE_AUTOSTART;
  access = {
    project: { id: `project-${++sequence}`, workspace_id: 'workspace-a', url: `https://site-${sequence}.example.com` },
    userId: 'user-a', can: () => true,
  };
});
after(() => {
  mock.restoreAll();
  assert.equal(path.dirname(path.resolve(tempRoot)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(tempRoot).startsWith('architect-project-test-'));
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

function completedCrawl() {
  const crawl = {
    id: `crawl-${sequence}`, project_id: access.project.id, status: 'completed',
    finished_at: '2026-09-08T12:00:00.000Z', created_at: '2026-09-08T11:00:00.000Z',
  };
  tables.crawl_runs.push(crawl);
  return crawl;
}

test('project setup creates a module entry before a crawl, without scheduling empty analysis', async () => {
  const result = await architect.connect({ access });
  assert.equal(result.project.platformProjectId, access.project.id);
  assert.equal(result.project.workspaceId, 'workspace-a');
  assert.equal(result.state, 'waiting_for_crawl');
  assert.equal(result.ready, false);
  assert.equal(tables.project_module_runs.length, 0);
});

test('parallel setup calls create one entry and preserve other project writes', async () => {
  const before = (await caStore.listProjects()).length;
  const entries = await Promise.all(Array.from({ length: 10 }, () => architect.ensureProject(access.project)));
  assert.equal(new Set(entries.map((p) => p.id)).size, 1);
  await Promise.all(Array.from({ length: 5 }, (_, i) => architect.ensureProject({
    ...access.project, id: `concurrent-${i}`, url: `https://concurrent-${i}.example.com`,
  })));
  assert.equal((await caStore.listProjects()).length, before + 6);
});

test('reuses legacy domain analysis without sharing another workspace linked entry', async () => {
  const legacy = await caStore.createProject({ domain: 'http://www.legacy.example.com', host: 'www.legacy.example.com' });
  await caStore.saveFullAnalysis(legacy.id, { clusters: [{ name: 'Existing cluster' }] });
  access.project.url = 'https://legacy.example.com';
  const linked = await architect.ensureProject(access.project);
  assert.equal(linked.id, legacy.id);
  assert.equal((await caStore.getFullAnalysis(linked.id)).clusters[0].name, 'Existing cluster');
  const separate = await architect.ensureProject({ ...access.project, id: 'other-workspace-project', workspace_id: 'workspace-b' });
  assert.notEqual(separate.id, linked.id);
  assert.equal(await caStore.getFullAnalysis(separate.id), null);
});

test('project views and raw primary-domain rows both initialize the correct domain', async () => {
  const view = await architect.ensureProject({ id: 'view-project', workspaceId: 'w', primaryDomain: { origin: 'https://view.example.com' } });
  assert.equal(view.domain, 'https://view.example.com');
  const raw = await architect.ensureProject(access.project, [{ role: 'primary', status: 'active', normalized_origin: 'https://primary.example.com' }]);
  assert.equal(raw.domain, 'https://primary.example.com');
});

test('opening an older project queues one analysis and polling does not duplicate it', async () => {
  completedCrawl();
  const results = await Promise.all(Array.from({ length: 8 }, () => architect.connect({ access })));
  assert.ok(results.every((r) => r.state === 'queued'));
  assert.equal(tables.project_module_runs.length, 1);
  assert.equal(tables.project_module_runs[0].module_key, 'hub_spoke');
  assert.equal(tables.project_module_runs[0].project_id, access.project.id);
  await architect.connect({ access });
  await architect.status({ access });
  assert.equal(tables.project_module_runs.length, 1);
  tables.project_module_runs[0].status = 'running';
  assert.equal((await architect.connect({ access })).state, 'analyzing');
  assert.equal(tables.project_module_runs.length, 1);
});

test('an insufficient-data run before the first crawl does not block automatic catch-up', async () => {
  completedCrawl();
  tables.project_module_runs.push({
    project_id: access.project.id, module_key: 'hub_spoke', status: 'insufficient_data',
    created_at: '2026-09-08T10:00:00.000Z', started_at: '2026-09-08T10:00:00.000Z',
  });
  assert.equal((await architect.connect({ access })).state, 'queued');
});

test('failed analysis is visible without an automatic retry loop; explicit retry queues once', async () => {
  const crawl = completedCrawl();
  tables.project_module_runs.push({
    project_id: access.project.id, module_key: 'hub_spoke', status: 'failed', crawlRunId: crawl.id,
    created_at: '2026-09-08T13:00:00.000Z', error: 'Analysis failed',
  });
  const result = await architect.connect({ access });
  assert.equal(result.state, 'failed');
  assert.equal(result.note, 'Analysis failed');
  assert.equal(tables.project_module_runs.length, 1);
  assert.equal((await architect.connect({ access, retry: true })).state, 'queued');
  assert.equal(tables.project_module_runs.length, 2);
});

test('completed analysis opens without rerunning and a new crawl triggers new analysis', async () => {
  const crawl = completedCrawl();
  const project = await architect.ensureProject(access.project);
  await caStore.saveFullAnalysis(project.id, { pages: [], clusters: [] });
  await caStore.updateProject(project.id, { workflowState: 'analyzed', crawlRunId: crawl.id });
  assert.equal((await architect.connect({ access })).state, 'analyzed');
  assert.equal(tables.project_module_runs.length, 0);
  tables.crawl_runs[0].id = 'newer-crawl';
  const result = await architect.connect({ access });
  assert.equal(result.ready, true);
  assert.equal(result.state, 'queued');
});

test('viewers can open their entry without starting a run, and deployment opt-out is honored', async () => {
  completedCrawl();
  assert.equal((await architect.connect({ access: { ...access, can: () => false } })).canStartRun, false);
  assert.equal(tables.project_module_runs.length, 0);
  process.env.HUB_SPOKE_AUTOSTART = 'off';
  const result = await architect.connect({ access });
  assert.match(result.note, /disabled/);
  assert.equal(tables.project_module_runs.length, 0);
});

test('crawl completion still automatically queues Content Architect without visiting its screen', async () => {
  await architect.ensureProject(access.project);
  const result = await autostart.scheduleHubSpoke({ run: { project_id: access.project.id, url: access.project.url } });
  assert.equal(result.scheduled, true);
  assert.equal((await autostart.scheduleHubSpoke({ run: { project_id: access.project.id } })).reason, 'already_queued');
});

test('the analysis worker updates the linked entry instead of creating another domain project', async () => {
  const crawl = completedCrawl();
  const linked = await architect.ensureProject(access.project);
  const pipeline = require('../../contentArchitect/fullAnalysis');
  const adapter = require('../crawlToArchitect');
  const analysis = { pages: [{ id: 'page-1', flags: [] }], clusters: [], unassignedPages: [] };
  const inputMock = mock.method(adapter, 'buildFromCrawl', async () => ({
    crawlResult: { pages: [] }, linkGraph: {}, meta: { pageCount: 5 }, limitations: [],
  }));
  const pipelineMock = mock.method(pipeline, 'analyzeCrawledPages', async () => {
    assert.equal((await caStore.getProject(linked.id)).workflowState, 'analyzing');
    return analysis;
  });
  try {
    const result = await require('../moduleRunners').RUNNERS.hub_spoke({ project: access.project, domains: [] });
    assert.equal(result.payload.contentArchitectProjectId, linked.id);
    const saved = await caStore.getProject(linked.id);
    assert.equal(saved.workflowState, 'analyzed');
    assert.equal(saved.crawlRunId, crawl.id);
    assert.deepEqual(await caStore.getFullAnalysis(linked.id), analysis);
    assert.equal((await architect.connect({ access })).ready, true);
    assert.equal(tables.project_module_runs.length, 0);
  } finally {
    inputMock.mock.restore();
    pipelineMock.mock.restore();
  }
});

function response() {
  return { statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
}
function handler(router, method, route) {
  return router.stack.find((l) => l.route?.path === route && l.route.methods[method]).route.stack[0].handle;
}

test('project creation route initializes Content Architect without a separate module request', async () => {
  const identity = require('../../../services/workspaceContext');
  const identityMock = mock.method(identity, 'resolveIdentity', async () => ({ workspaceId: 'workspace-a' }));
  const workspaceMock = mock.method(projectAccess, 'requireWorkspace', async () => access);
  const projectMock = mock.method(projectAccess, 'requireProject', async () => access);
  const listMock = mock.method(projectsStore, 'listProjects', async () => []);
  // The duplicate-domain check. It used to scan listProjects() in JavaScript;
  // it now asks the database directly, which this suite's fakeDb deliberately
  // refuses (only crawl_runs and project_module_runs may be touched here, so
  // that Content Architect setup staying off other paths is provable).
  const clashMock = mock.method(projectsStore, 'projectTrackingOrigin', async () => null);
  const createMock = mock.method(projectsStore, 'createProject', async () => ({
    id: access.project.id, workspaceId: 'workspace-a', primaryDomain: { origin: access.project.url },
  }));
  const domainsMock = mock.method(projectsStore, 'listDomains', async () => []);
  const competitorMock = mock.method(require('../competitorAutostart'), 'scheduleCompetitorResearch', async () => ({ scheduled: false }));
  try {
    const routes = require('../routes');
    const res = response();
    await handler(routes, 'post', '/')({ body: { name: 'Test', primaryDomain: access.project.url, country: 'US' } }, res);
    assert.equal(res.statusCode, 201);
    const linked = (await caStore.listProjects()).find((p) => p.platformProjectId === res.body.project.id);
    assert.ok(linked);
    assert.equal(linked.workflowState, 'waiting_for_crawl');
  } finally {
    for (const m of [identityMock, workspaceMock, projectMock, listMock, clashMock, createMock, domainsMock, competitorMock]) m.mock.restore();
  }
});

test('the Site Crawler project form also creates its linked entry before the initial crawl', async () => {
  const repo = require('../../crawlScope/db/repo');
  // This route used to call repo.createProject, which inserted crawl_projects
  // and nothing else. It now goes through the shared project store, which
  // writes the project and its primary domain in one transaction, then reads
  // the raw row back for the internals that expect DB shape. Mocking that trio
  // is what keeps this test about Content Architect setup rather than about SQL.
  const workspaceMock = mock.method(projectAccess, 'requireWorkspace', async () => access);
  const createMock = mock.method(projectsStore, 'createProject', async () => ({
    id: access.project.id, workspaceId: 'workspace-a', primaryDomain: { origin: access.project.url },
  }));
  const getMock = mock.method(repo, 'getProject', async () => access.project);
  const crawlMock = mock.method(repo, 'createRun', async () => {
    assert.ok((await caStore.listProjects()).find((p) => p.platformProjectId === access.project.id));
    return { id: 'initial-crawl' };
  });
  try {
    const routes = require('../../crawlScope/api/routes');
    const res = response();
    await handler(routes, 'post', '/projects')({
      body: { url: access.project.url, dayOfWeek: 1, hour: 8 },
      user: { id: access.userId }, crawlWorkspaceId: 'workspace-a', db: {},
    }, res, (error) => { throw error; });
    assert.equal(res.statusCode, 201);
    assert.equal(res.body.run.id, 'initial-crawl');

    // The point of routing through the store: this endpoint can no longer
    // create a project without a primary domain, and it asks for the country
    // to be optional rather than sending a guessed one.
    assert.equal(createMock.mock.callCount(), 1);
    const [args] = createMock.mock.calls[0].arguments;
    assert.equal(args.primaryDomain, access.project.url);
    assert.equal(args.requireCountry, false);
    // CrawlScope's own schedule contract survives the move: a schedule is
    // required here and the project starts enabled, which is the opposite of
    // the /api/projects default.
    assert.ok(args.schedule.cron);
    assert.equal(args.schedule.enabled, true);
  } finally {
    for (const m of [workspaceMock, createMock, getMock, crawlMock]) m.mock.restore();
  }
});

test('connection and module routes refuse inaccessible platform projects', async () => {
  const denial = mock.method(projectAccess, 'requireProject', async () => {
    throw Object.assign(new Error('Project not found'), { status: 404 });
  });
  try {
    const routes = require('../routes');
    const before = (await caStore.listProjects()).length;
    const res = response();
    await handler(routes, 'post', '/:projectId/content-architect')({ params: { projectId: 'denied' }, body: {} }, res);
    assert.equal(res.statusCode, 404);
    assert.equal((await caStore.listProjects()).length, before);
    const linked = await architect.ensureProject(access.project);
    const caRoutes = require('../../contentArchitect/routes');
    const detail = response();
    let allowed = false;
    await caRoutes.params.id[0]({ method: 'GET' }, detail, () => { allowed = true; }, linked.id);
    assert.equal(detail.statusCode, 404);
    assert.equal(allowed, false);
    const list = response();
    await handler(caRoutes, 'get', '/projects')({}, list);
    assert.ok(list.body.every((p) => !p.platformProjectId));
  } finally { denial.mock.restore(); }
});
