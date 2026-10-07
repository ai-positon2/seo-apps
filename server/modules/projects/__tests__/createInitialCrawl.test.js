const assert = require('node:assert/strict');
const { test, beforeEach, afterEach, mock } = require('node:test');

const { createFakeDb } = require('./helpers/fakeDb');

// ── The crawl a new project starts itself runs under the workspace's limits ──
//
// POST /api/projects hands the just-created project to
// crawlAutostart.scheduleInitialCrawl. That project is store.projectView's
// camelCase shape, but the call passed `crawlOptions: project.options` and the
// autostart read `project.workspace_id` — both undefined on a view. So the
// initial crawl ignored what the project asked for, and resolveLimits(undefined)
// skipped the workspace's admin policy, falling back to the platform defaults.
//
// No database: services/db is the in-memory fake (which throws on anything it
// was not taught), every collaborator around the create is mocked, and the
// real scheduleInitialCrawl + parseCrawlRequest run against a mocked
// adminLimits so the clamp is the real one.

const dbPath = require.resolve('../../../services/db');
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true, exports: createFakeDb({}),
};

// routes.js destructures resolveIdentity at load, so it is replaced up front.
const workspaceContextPath = require.resolve('../../../services/workspaceContext');
const realWorkspaceContext = require(workspaceContextPath);
require.cache[workspaceContextPath].exports = {
  ...realWorkspaceContext,
  async resolveIdentity() {
    return { userId: 'user-a', workspaceId: 'ws-1', actorEmail: 'a@position2.com' };
  },
};

const projectAccess = require('../../../services/projectAccess');
const adminLimits = require('../../../services/adminLimits');
const store = require('../store');
const contentArchitect = require('../contentArchitect');
const homepageAutostart = require('../homepageAutostart');
const competitorAutostart = require('../competitorAutostart');
const aiVisibilityLiteAutostart = require('../aiVisibilityLiteAutostart');
const crawlAutostart = require('../crawlAutostart');
const repo = require('../../crawlScope/db/repo');
const crawlScopeRoutes = require('../../crawlScope/api/routes');
const routes = require('../routes');

const realScheduleInitialCrawl = crawlAutostart.scheduleInitialCrawl;

const ROW = {
  id: '11111111-1111-4111-8111-111111111111',
  owner: 'user-a',
  workspace_id: 'ws-1',
  name: 'Example',
  url: 'https://example.com',
  country_code: 'US',
  options: { maxUrls: 50 },
  cron: '0 8 * * 1',
  timezone: 'UTC',
  enabled: false,
  lifecycle_status: 'active',
  recipients: [],
  settings: {},
};
const DOMAINS = [{
  id: 'dom-1', workspace_id: 'ws-1', project_id: ROW.id, role: 'primary', status: 'active',
  normalized_origin: 'https://example.com', host: 'example.com', scheme: 'https',
}];

let scheduleCalls;
let createdRun;
let limitsAskedFor;

function response() {
  return {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}
function handler(path, method) {
  return routes.stack.find((l) => l.route?.path === path && l.route.methods[method]).route.stack[0].handle;
}

beforeEach(() => {
  delete process.env.CRAWL_AUTOSTART;
  scheduleCalls = [];
  createdRun = null;
  limitsAskedFor = [];

  const access = { workspaceId: 'ws-1', userId: 'user-a', role: 'owner', can: () => true, project: ROW };
  mock.method(projectAccess, 'requireWorkspace', async () => access);
  mock.method(projectAccess, 'requireProject', async () => access);
  mock.method(store, 'projectTrackingOrigin', async () => null);
  mock.method(store, 'createProject', async () => store.projectView(ROW, DOMAINS));
  mock.method(store, 'listDomains', async () => DOMAINS);
  mock.method(contentArchitect, 'ensureProject', async () => null);
  mock.method(homepageAutostart, 'scheduleForProject', async () => ({ scheduled: false }));
  mock.method(competitorAutostart, 'scheduleCompetitorResearch', async () => ({ scheduled: false }));
  mock.method(aiVisibilityLiteAutostart, 'scheduleForProject', async () => ({ scheduled: false }));

  // The admin policy for ws-1 caps a crawl at 20 pages; anything else gets the
  // platform defaults.
  mock.method(adminLimits, 'effectiveLimits', async ({ workspaceId }) => {
    limitsAskedFor.push(workspaceId);
    const base = adminLimits.baseLimits();
    if (workspaceId !== 'ws-1') return base;
    return {
      limits: { ...base.limits, maxUrlsPerCrawl: 20 },
      sources: { ...base.sources, maxUrlsPerCrawl: 'workspace' },
    };
  });
  mock.method(crawlAutostart, 'scheduleInitialCrawl', async (input) => {
    scheduleCalls.push(input);
    return realScheduleInitialCrawl(input);
  });
  mock.method(repo, 'createRun', async (_db, run) => { createdRun = run; return { id: 'run-1', ...run }; });
  mock.method(crawlScopeRoutes.manager, 'execute', async () => {});
});
afterEach(() => mock.restoreAll());

test('POST /api/projects starts the initial crawl with the project\'s own options and workspace', async () => {
  const res = response();
  await handler('/', 'post')(
    {
      body: { primaryDomain: 'example.com', country: 'US', crawlOptions: { maxUrls: 50 } },
      headers: {}, user: { userId: 'user-a' },
    },
    res,
    (e) => { throw e; },
  );
  assert.equal(res.statusCode, 201, JSON.stringify(res.body));
  assert.equal(scheduleCalls.length, 1);
  const call = scheduleCalls[0];
  assert.deepEqual(call.crawlOptions, { maxUrls: 50 });
  assert.equal(call.project.workspaceId, 'ws-1');
  assert.equal(res.body.initialCrawl.scheduled, true, JSON.stringify(res.body.initialCrawl));
});

test('the initial crawl run is clamped to the workspace admin cap and filed under the workspace', async () => {
  const res = response();
  await handler('/', 'post')(
    {
      body: { primaryDomain: 'example.com', country: 'US', crawlOptions: { maxUrls: 50 } },
      headers: {}, user: { userId: 'user-a' },
    },
    res,
    (e) => { throw e; },
  );
  assert.equal(res.statusCode, 201, JSON.stringify(res.body));
  assert.ok(createdRun, 'no crawl run was created');
  assert.deepEqual(limitsAskedFor, ['ws-1']);
  assert.equal(createdRun.workspace_id, 'ws-1');
  assert.equal(createdRun.project_id, ROW.id);
  assert.equal(createdRun.options.maxUrls, 20);
  assert.equal(createdRun.trigger, 'initial');
});

test('scheduleInitialCrawl still accepts a raw crawl_projects row (snake_case)', async () => {
  const result = await realScheduleInitialCrawl({
    project: ROW, domains: DOMAINS, ownerId: 'user-a', crawlOptions: { maxUrls: 50 },
  });
  assert.equal(result.scheduled, true);
  assert.equal(createdRun.workspace_id, 'ws-1');
  assert.equal(createdRun.options.maxUrls, 20);
});

test('a view with no active primary domain falls back to its legacy url', async () => {
  const view = store.projectView(ROW, []);
  const result = await realScheduleInitialCrawl({ project: view, domains: [], crawlOptions: {} });
  assert.equal(result.scheduled, true, JSON.stringify(result));
  assert.match(createdRun.url, /^https:\/\/example\.com\/?$/);
});
