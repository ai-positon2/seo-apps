const assert = require('node:assert/strict');
const { test, after, beforeEach, mock } = require('node:test');

delete process.env.HUB_SPOKE_AUTOSTART;

const { createFakeDb } = require('./helpers/fakeDb');

// Only these tables may be touched — reading anything else throws, which is how
// these tests assert that Content Architect setup stays off other paths.
//
// The two content_architect_* tables joined this list when the module's store
// moved off disk (0032). Before that it kept a JSON file under a temp
// CONTENT_ARCHITECT_DATA_ROOT, which is why this file used to mkdtemp.
const tables = {
  crawl_runs: [],
  project_module_runs: [],
  content_architect_projects: [],
  content_architect_artifacts: [],
};

const fakeDb = createFakeDb(tables, {
  unique: {
    // uq_content_architect_projects_platform. Partial, exactly as in 0032:
    // standalone analyses have no platform project and there may be many.
    content_architect_projects: [{
      columns: ['platform_project_id'],
      where: (row) => row.platform_project_id !== null && row.platform_project_id !== undefined,
    }],
    content_architect_artifacts: [{ columns: ['project_id', 'kind'] }],
  },
});

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

// Platform project and workspace ids are uuids in crawl_projects/workspaces, and
// content_architect_projects mirrors them into uuid columns with real foreign
// keys (0032). Fixtures are shaped the same way so these tests exercise the
// column the uniqueness actually hangs off, rather than a string the store would
// have to reject.
// The tag only keeps two fixtures with the same number apart, so it is encoded
// to hex rather than written into the uuid literally — a uuid column rejects
// 'proj' as surely as it rejects 'project-1'.
const hexTag = (tag) => [...tag]
  .map((c) => c.charCodeAt(0).toString(16))
  .join('')
  .slice(0, 12)
  .padStart(12, '0');
const uuid = (n, tag) => `${String(n).padStart(8, '0')}-0000-4000-8000-${hexTag(tag)}`;
const WORKSPACE_A = uuid(1, 'wsa');

beforeEach(() => {
  tables.crawl_runs = [];
  tables.project_module_runs = [];
  delete process.env.HUB_SPOKE_AUTOSTART;
  sequence += 1;
  access = {
    project: {
      id: uuid(sequence, 'proj'),
      workspace_id: WORKSPACE_A,
      url: `https://site-${sequence}.example.com`,
    },
    userId: 'user-a', can: () => true,
  };
});
after(() => {
  mock.restoreAll();
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
  assert.equal(result.project.workspaceId, WORKSPACE_A);
  assert.equal(result.state, 'waiting_for_crawl');
  assert.equal(result.ready, false);
  assert.equal(tables.project_module_runs.length, 0);
});

test('parallel setup calls create one entry and preserve other project writes', async () => {
  const before = (await caStore.listProjects()).length;
  const entries = await Promise.all(Array.from({ length: 10 }, () => architect.ensureProject(access.project)));
  assert.equal(new Set(entries.map((p) => p.id)).size, 1);
  await Promise.all(Array.from({ length: 5 }, (_, i) => architect.ensureProject({
    ...access.project, id: uuid(100 + i, 'conc'), url: `https://concurrent-${i}.example.com`,
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
  const separate = await architect.ensureProject({ ...access.project, id: uuid(200, 'other'), workspace_id: uuid(2, 'wsb') });
  assert.notEqual(separate.id, linked.id);
  assert.equal(await caStore.getFullAnalysis(separate.id), null);
});

test('project views and raw primary-domain rows both initialize the correct domain', async () => {
  const view = await architect.ensureProject({ id: uuid(201, 'view'), workspaceId: uuid(3, 'wsc'), primaryDomain: { origin: 'https://view.example.com' } });
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
  const inputMock = mock.method(adapter, 'buildFromDiscovery', async () => ({
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
  const identityMock = mock.method(identity, 'resolveIdentity', async () => ({ workspaceId: WORKSPACE_A }));
  const workspaceMock = mock.method(projectAccess, 'requireWorkspace', async () => access);
  const projectMock = mock.method(projectAccess, 'requireProject', async () => access);
  const listMock = mock.method(projectsStore, 'listProjects', async () => []);
  // The duplicate-domain check. It used to scan listProjects() in JavaScript;
  // it now asks the database directly, which this suite's fakeDb deliberately
  // refuses (only crawl_runs and project_module_runs may be touched here, so
  // that Content Architect setup staying off other paths is provable).
  const clashMock = mock.method(projectsStore, 'projectTrackingOrigin', async () => null);
  const createMock = mock.method(projectsStore, 'createProject', async () => ({
    id: access.project.id, workspaceId: WORKSPACE_A, primaryDomain: { origin: access.project.url },
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
    id: access.project.id, workspaceId: WORKSPACE_A, primaryDomain: { origin: access.project.url },
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
      user: { id: access.userId }, crawlWorkspaceId: WORKSPACE_A, db: {},
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

// A row the way scripts/importFileStores.js writes one whose links it could not
// resolve: `data` exactly as it was on disk, the columns only what it could
// keep. Written straight into the table because no store call produces this
// shape — which is the point.
function importedRow(tag, { platform = null, workspace = null, domain } = {}) {
  const row = {
    id: `proj_${tag}`,
    platform_project_id: platform,
    workspace_id: workspace,
    data: {
      id: `proj_${tag}`,
      domain,
      name: new URL(domain).host,
      // The ids the file held. Neither exists in this database.
      platformProjectId: uuid(900, tag),
      workspaceId: workspace || uuid(901, tag),
      workflowState: 'analyzed',
    },
    created_at: '2026-09-01T00:00:00.000Z',
  };
  tables.content_architect_projects.push(row);
  return row;
}

test('an imported analysis whose platform project was dropped opens as a standalone one', async () => {
  // The Acalvio failure. The access check read the old id out of `data`, found
  // no such project, and answered "Project not found" — and the list hid the
  // row for the same reason, so it could not be reached at all.
  const row = importedRow('orphan', { domain: 'https://orphan.example.com' });
  const denial = mock.method(projectAccess, 'requireProject', async () => {
    throw Object.assign(new Error('Project not found.'), { status: 404 });
  });
  try {
    const project = await caStore.getProject(row.id);
    assert.equal(project.platformProjectId, null, 'the column decides, not the copy in data');
    assert.equal(project.workspaceId, null);
    assert.equal(project.workflowState, 'analyzed', 'the rest of the record is intact');

    const caRoutes = require('../../contentArchitect/routes');
    let allowed = false;
    await caRoutes.params.id[0]({ method: 'GET' }, response(), () => { allowed = true; }, row.id);
    assert.equal(allowed, true);
    assert.equal(denial.mock.callCount(), 0, 'no platform project to check');

    const list = response();
    await handler(caRoutes, 'get', '/projects')({}, list);
    assert.ok(list.body.some((p) => p.id === row.id));
  } finally { denial.mock.restore(); }
});

test('an unlinked analysis still in a workspace stays with that workspace', async () => {
  const OTHER = uuid(4, 'wsd');
  const row = importedRow('kept', { workspace: OTHER, domain: 'https://kept.example.com' });
  const outsider = mock.method(projectAccess, 'requireWorkspace', async (req, workspaceId) => {
    assert.equal(workspaceId, OTHER);
    throw Object.assign(new Error('Workspace not found.'), { status: 404 });
  });
  try {
    const caRoutes = require('../../contentArchitect/routes');
    const detail = response();
    let allowed = false;
    await caRoutes.params.id[0]({ method: 'GET' }, detail, () => { allowed = true; }, row.id);
    assert.equal(allowed, false, 'a non-member must not open it');
    assert.equal(detail.statusCode, 404);

    const list = response();
    await handler(caRoutes, 'get', '/projects')({}, list);
    assert.ok(!list.body.some((p) => p.id === row.id), 'nor see it listed');
  } finally { outsider.mock.restore(); }

  // Adoption follows the same line. A project elsewhere tracking the same site
  // gets its own entry; one in the analysis's own workspace takes it over.
  access.project.url = 'https://kept.example.com';
  const elsewhere = await architect.ensureProject(access.project);
  assert.notEqual(elsewhere.id, row.id, 'another workspace does not inherit it');

  const home = await architect.ensureProject({
    ...access.project, id: uuid(300, 'home'), workspace_id: OTHER,
  });
  assert.equal(home.id, row.id);
  assert.equal(home.platformProjectId, uuid(300, 'home'));
});

test('a finished run whose result is gone says so, and Retry runs it again', async () => {
  // The run is on record for the latest crawl, but the analysis it wrote went
  // to a file on a machine that no longer has it. "Has not started" would be
  // untrue, and no automatic catch-up follows a run that already happened.
  const crawl = completedCrawl();
  tables.project_module_runs.push({
    project_id: access.project.id, module_key: 'hub_spoke', status: 'completed',
    payload: { crawlRunId: crawl.id },
    created_at: '2026-09-08T12:30:00.000Z', started_at: '2026-09-08T12:30:00.000Z',
  });
  const result = await architect.connect({ access });
  assert.equal(result.ready, false);
  assert.equal(result.state, 'not_started');
  assert.match(result.note, /no longer stored/);
  assert.equal(result.canStartRun, true);
  assert.equal(tables.project_module_runs.length, 1, 'nothing queued by itself');

  assert.equal((await architect.connect({ access, retry: true })).state, 'queued');
  assert.equal(tables.project_module_runs.length, 2);
});

// ── Informational pages only ─────────────────────────────────────────────────

// What crawlToArchitect.buildFromCrawl returns when a crawl has too few
// informational pages to cluster.
function tooFewInformational() {
  return {
    tooFewInformational: true,
    pageCount: 2,
    crawledPageCount: 590,
    minimum: 5,
    selection: {
      summary: {
        scope: 'informational',
        version: 1,
        method: 'ai',
        excludedByReason: [
          { code: 'location', label: 'Location page', count: 216 },
          { code: 'people', label: 'People page', count: 121 },
        ],
        limitations: [],
        aiChecks: { failed: 0, outOfTime: 0 },
      },
    },
    meta: { capped: false, incompleteReason: null, urlCap: 1000 },
  };
}

async function runHubSpoke() {
  return require('../moduleRunners').RUNNERS.hub_spoke({ project: access.project, domains: [] });
}

test('too few informational pages is its own answer, and the crawl still counts as attempted', async () => {
  const crawl = completedCrawl();
  const adapter = require('../crawlToArchitect');
  const inputMock = mock.method(adapter, 'buildFromDiscovery', async () => tooFewInformational());
  try {
    const result = await runHubSpoke();
    assert.equal(result.status, 'insufficient_data');
    assert.equal(result.payload.reason, 'too_few_informational_pages');
    // status() reads this to know the crawl was already attempted — without it
    // every visit to the tool page would queue the same run again.
    assert.equal(result.payload.crawlRunId, crawl.id);
    assert.equal(result.payload.pagesCrawled, 590);
    assert.equal(result.payload.informationalPageCount, 2);
    assert.match(result.note, /Only 2 informational page\(s\)/);
    assert.match(result.note, /location page \(216\)/);
    assert.match(result.payload.cardNote, /too few to cluster/);

    tables.project_module_runs.push({
      project_id: access.project.id, module_key: 'hub_spoke', status: 'insufficient_data',
      payload: { ...result.payload, note: result.note },
      created_at: '2026-09-08T12:30:00.000Z', started_at: '2026-09-08T12:30:00.000Z',
    });
    const connection = await architect.connect({ access });
    assert.equal(connection.state, 'insufficient_data');
    assert.match(connection.note, /informational/);
    assert.equal(tables.project_module_runs.length, 1, 'no re-queue of an attempted crawl');
  } finally {
    inputMock.mock.restore();
  }
});

test('an analysis built from every crawled page is cleared when the new rule finds too few', async () => {
  completedCrawl();
  const linked = await architect.ensureProject(access.project);
  // The pre-selection analysis: location clusters, no `selection`.
  await caStore.saveFullAnalysis(linked.id, { pages: [], clusters: [{ name: 'Rock Hill SC Dental Services' }], unassignedPages: [] });
  const adapter = require('../crawlToArchitect');
  const inputMock = mock.method(adapter, 'buildFromDiscovery', async () => tooFewInformational());
  try {
    await runHubSpoke();
    assert.equal(await caStore.getFullAnalysis(linked.id), null);
  } finally {
    inputMock.mock.restore();
  }
});

test('a previous informational analysis is kept when a later crawl finds too few', async () => {
  completedCrawl();
  const linked = await architect.ensureProject(access.project);
  const informational = {
    pages: [], clusters: [{ name: 'Teeth Whitening Guide' }], unassignedPages: [],
    selection: { version: 1, summary: { scope: 'informational' }, verdicts: { version: 1, templates: {}, urls: {} } },
  };
  await caStore.saveFullAnalysis(linked.id, informational);
  const adapter = require('../crawlToArchitect');
  const inputMock = mock.method(adapter, 'buildFromDiscovery', async () => tooFewInformational());
  try {
    await runHubSpoke();
    assert.deepEqual(await caStore.getFullAnalysis(linked.id), informational, 'older, not wrong');
  } finally {
    inputMock.mock.restore();
  }
});

test('the previous analysis hands its selection verdicts to the next run', async () => {
  completedCrawl();
  const linked = await architect.ensureProject(access.project);
  const verdicts = { version: 1, templates: { '/articles/{slug}': { category: 'informational', decidedAt: '2026-09-20T00:00:00Z' } }, urls: {} };
  await caStore.saveFullAnalysis(linked.id, { pages: [], clusters: [], unassignedPages: [], selection: { verdicts } });
  const adapter = require('../crawlToArchitect');
  let seen = null;
  const inputMock = mock.method(adapter, 'buildFromDiscovery', async (runId, opts) => {
    seen = opts;
    return tooFewInformational();
  });
  try {
    await runHubSpoke();
    assert.deepEqual(seen.selectionCache, verdicts);
  } finally {
    inputMock.mock.restore();
  }
});

test('a clustered run reports informational and crawled counts separately', async () => {
  completedCrawl();
  const linked = await architect.ensureProject(access.project);
  const pipeline = require('../../contentArchitect/fullAnalysis');
  const adapter = require('../crawlToArchitect');
  const selectionSummary = {
    scope: 'informational',
    version: 1,
    method: 'ai',
    crawledPageCount: 590,
    analysedPageCount: 103,
    excludedByReason: [{ code: 'location', label: 'Location page', count: 216 }],
    limitations: [],
  };
  const analysis = {
    pages: Array.from({ length: 103 }, (_, i) => ({ id: `p${i}`, flags: [] })),
    clusters: [{ id: 'c1', name: 'Teeth Whitening Guide', isGap: false, spokeIds: ['p1', 'p2'], health: 70 }],
    unassignedPages: [],
    excludedUrls: Array.from({ length: 487 }, (_, i) => ({ url: `https://x.test/${i}`, reason: 'Location page' })),
  };
  const inputMock = mock.method(adapter, 'buildFromDiscovery', async () => ({
    crawlResult: { pages: [] },
    linkGraph: {},
    meta: { pageCount: 103, crawledPageCount: 590, capped: false, urlCap: 1000 },
    limitations: [],
    selection: { summary: selectionSummary },
  }));
  const pipelineMock = mock.method(pipeline, 'analyzeCrawledPages', async () => analysis);
  try {
    const result = await runHubSpoke();
    assert.equal(result.payload.scope, 'informational');
    assert.equal(result.payload.pagesCrawled, 590);
    assert.equal(result.payload.pagesAnalyzed, 103);
    assert.equal(result.payload.pagesExcluded, 487);
    assert.equal(result.payload.selectionVersion, 1);
    assert.match(result.payload.cardNote, /103 informational page\(s\) of 590 found/);
    assert.match(result.note, /^Clustered 103 informational page\(s\)/);
    const saved = await caStore.getProject(linked.id);
    assert.equal(saved.stats.urlsFound, 590);
    assert.equal(saved.stats.urlsSelected, 103);
    assert.equal(saved.stats.urlsExcluded, 487);
  } finally {
    inputMock.mock.restore();
    pipelineMock.mock.restore();
  }
});
