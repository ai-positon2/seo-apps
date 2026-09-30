const assert = require('node:assert/strict');
const { test, beforeEach, afterEach, mock } = require('node:test');

const { createFakeDb } = require('./helpers/fakeDb');

// ── Who may attach a crawl to a project, and who may edit one ────────────────
//
// Two Site Crawler routes that used to decide access on their own terms:
//
//   POST  /api/crawl-scope/runs          stored body.projectId exactly as sent,
//                                        so anyone signed in could attach a crawl
//                                        to any project's dashboard.
//   PATCH /api/crawl-scope/projects/:id  wrote the new site straight to `url`,
//                                        leaving the primary domain on the old
//                                        one, and filtered the write on `owner`,
//                                        so a teammate's edit silently did nothing.
//
// Both now go through projectAccess.requireProject, and a site change goes
// through store.setPrimaryDomain. No database: every collaborator is mocked, and
// the fake below throws if anything reaches it unexpectedly.

const dbPath = require.resolve('../../../services/db');
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true, exports: createFakeDb({}),
};

const projectAccess = require('../../../services/projectAccess');
const adminLimits = require('../../../services/adminLimits');
const projectsStore = require('../store');
const repo = require('../../crawlScope/db/repo');
const routes = require('../../crawlScope/api/routes');

const PROJECT = {
  id: 'project-a', owner: 'someone-else', workspace_id: 'workspace-project',
  url: 'https://example.com/', cron: '0 8 * * 1', timezone: 'UTC', enabled: true,
};

let created;
let updated;
let limitsAskedFor;

function response() {
  return { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
}
function handler(route, method) {
  return routes.stack.find((l) => l.route?.path === route && l.route.methods[method]).route.stack[0].handle;
}
// asyncRoute hands a thrown error to next(); capture it rather than rethrow, so
// a test can assert on the status the router's error handler would send.
async function call(route, method, req) {
  const res = response();
  let error = null;
  await handler(route, method)(
    { user: { id: 'user-a', userId: 'user-a' }, crawlWorkspaceId: 'workspace-active', db: {}, params: {}, ...req },
    res,
    (e) => { error = e; },
  );
  return { res, error };
}
function denied() {
  return Object.assign(new Error('Project not found.'), { status: 404, code: 'not_found' });
}
function allowAccess() {
  const access = { project: { ...PROJECT }, userId: 'user-a', can: () => true };
  return mock.method(projectAccess, 'requireProject', async () => access);
}

beforeEach(() => {
  created = null;
  updated = null;
  limitsAskedFor = [];
  mock.method(adminLimits, 'effectiveLimits', async ({ workspaceId }) => {
    limitsAskedFor.push(workspaceId);
    return adminLimits.baseLimits();
  });
  mock.method(repo, 'createRun', async (_db, run) => { created = run; return { id: 'run-1', ...run }; });
  mock.method(repo, 'updateProject', async (_db, id, patch, owner) => {
    updated = { id, patch, owner };
    return { ...PROJECT, ...patch };
  });
  mock.method(routes.manager, 'execute', async () => {});
});
afterEach(() => mock.restoreAll());

// ── POST /runs ──────────────────────────────────────────────────────────────

test('a crawl naming a project the caller cannot reach is refused, and nothing is stored', async () => {
  mock.method(projectAccess, 'requireProject', async () => { throw denied(); });
  const { error } = await call('/runs', 'post', {
    body: { url: 'https://example.com/', projectId: 'someone-elses-project' },
  });
  assert.equal(error?.status, 404);
  assert.equal(created, null);
});

test('a crawl naming a reachable project is checked for startRun and filed under that project', async () => {
  const check = allowAccess();
  const { res, error } = await call('/runs', 'post', {
    body: { url: 'https://example.com/', projectId: PROJECT.id },
  });
  assert.equal(error, null);
  assert.equal(res.statusCode, 201);
  assert.deepEqual(check.mock.calls[0].arguments.slice(1), [PROJECT.id, 'startRun']);
  assert.equal(created.project_id, PROJECT.id);
  // The project's workspace, not the caller's active one — where the project's
  // own crawls are filed, and whose limits they run under.
  assert.equal(created.workspace_id, 'workspace-project');
  assert.deepEqual(limitsAskedFor, ['workspace-project']);
});

test('a crawl with no project needs no project check and lands in the active workspace', async () => {
  const check = mock.method(projectAccess, 'requireProject', async () => { throw new Error('should not be asked'); });
  const { res, error } = await call('/runs', 'post', { body: { url: 'https://example.com/' } });
  assert.equal(error, null);
  assert.equal(res.statusCode, 201);
  assert.equal(check.mock.callCount(), 0);
  assert.equal(created.project_id, null);
  assert.equal(created.workspace_id, 'workspace-active');
});

// ── PATCH /projects/:id ─────────────────────────────────────────────────────

test('editing needs editProjectSettings, and a refusal writes nothing', async () => {
  const forbidden = Object.assign(new Error('Your role (contributor) is not allowed to edit project settings.'), { status: 403 });
  mock.method(projectAccess, 'requireProject', async () => { throw forbidden; });
  const setPrimary = mock.method(projectsStore, 'setPrimaryDomain', async () => ({}));
  const { error } = await call('/projects/:id', 'patch', {
    params: { id: PROJECT.id }, body: { url: 'https://other.example/' },
  });
  assert.equal(error?.status, 403);
  assert.equal(setPrimary.mock.callCount(), 0);
  assert.equal(updated, null);
});

test('a teammate allowed to edit is not filtered out by who created the project', async () => {
  const check = allowAccess();
  const { res, error } = await call('/projects/:id', 'patch', {
    params: { id: PROJECT.id }, body: { enabled: false },
  });
  assert.equal(error, null);
  assert.deepEqual(check.mock.calls[0].arguments.slice(1), [PROJECT.id, 'editProjectSettings']);
  // No owner argument: the old owner filter is what made a teammate's edit a
  // silent no-op on a project someone else created.
  assert.equal(updated.owner, undefined);
  assert.equal(res.body.project.enabled, false);
});

test('changing the site moves the primary domain through setPrimaryDomain', async () => {
  allowAccess();
  const setPrimary = mock.method(projectsStore, 'setPrimaryDomain', async () => ({}));
  const { error } = await call('/projects/:id', 'patch', {
    params: { id: PROJECT.id }, body: { url: 'https://new-site.example/' },
  });
  assert.equal(error, null);
  assert.equal(setPrimary.mock.callCount(), 1);
  assert.equal(setPrimary.mock.calls[0].arguments[0].domain, 'https://new-site.example/');
  assert.equal(updated.patch.url, 'https://new-site.example/');
});

test('saving the same site, or a new path on it, leaves the primary domain alone', async () => {
  allowAccess();
  const setPrimary = mock.method(projectsStore, 'setPrimaryDomain', async () => ({}));
  // The form sends `url` back on every save, schedule-only saves included.
  await call('/projects/:id', 'patch', { params: { id: PROJECT.id }, body: { url: 'https://example.com/', dayOfWeek: 2, hour: 9 } });
  await call('/projects/:id', 'patch', { params: { id: PROJECT.id }, body: { url: 'https://example.com/blog/' } });
  assert.equal(setPrimary.mock.callCount(), 0);
  assert.equal(updated.patch.url, 'https://example.com/blog/');
});

test('a list-mode save never moves the primary domain', async () => {
  allowAccess();
  const setPrimary = mock.method(projectsStore, 'setPrimaryDomain', async () => ({}));
  const { error } = await call('/projects/:id', 'patch', {
    params: { id: PROJECT.id },
    body: { url: 'https://other.example/', urls: ['https://other.example/a', 'https://other.example/b'] },
  });
  assert.equal(error, null);
  assert.equal(setPrimary.mock.callCount(), 0);
});
