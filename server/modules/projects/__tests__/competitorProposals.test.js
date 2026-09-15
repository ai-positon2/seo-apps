// ── Deciding a proposed competitor (PRD §7.2) ───────────────────────────────
//
// A contributor holds 'propose' on manageCompetitors, so their competitor lands
// as status='proposed'. For a long time that was a one-way door: every read
// filtered `status = 'active'` in SQL, no route listed proposals, none accepted
// them — and no role that could have accepted one was assignable, because the
// members API coerced every role to owner or member. The row was written and
// then invisible to everyone, including the person who proposed it.
//
// These tests pin the way out, and the guards around it: a decision applies only
// to something actually awaiting one, only to a competitor, and only on the
// project named in the URL.
//
// Run: node modules/projects/__tests__/competitorProposals.test.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const { test } = require('node:test');

const { createFakeDb } = require('./helpers/fakeDb');

const tables = { project_domains: [], audit_events: [], crawl_projects: [] };
const fakeDb = createFakeDb(tables);

const dbPath = require.resolve('../../../services/db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: fakeDb };

const store = require('../store');

const PROJECT = { id: 'project-1', workspace_id: 'ws-1', url: 'https://client.example' };

const access = {
  project: PROJECT,
  workspaceId: 'ws-1',
  userId: 'approver-1',
  actorEmail: 'approver@position2.com',
  role: 'approver',
  can: () => true,
};

function seed(over = {}) {
  tables.project_domains = [{
    id: 'domain-1',
    project_id: PROJECT.id,
    workspace_id: 'ws-1',
    role: 'competitor',
    status: 'proposed',
    normalized_origin: 'https://rival.example',
    host: 'rival.example',
    scheme: 'https',
    source: 'user_entered',
    created_by: 'contributor-9',
    created_at: new Date().toISOString(),
    ...over,
  }];
  tables.audit_events = [];
}

// ── Approving ───────────────────────────────────────────────────────────────

test('approving a proposal marks it tracked', async () => {
  seed();
  const domain = await store.decideCompetitorProposal({
    access, domainId: 'domain-1', decision: 'approve',
  });
  assert.equal(domain.status, 'active');
  assert.equal(tables.project_domains[0].status, 'active');
});

test('approving writes an audit row naming the approver and who proposed it', async () => {
  seed();
  await store.decideCompetitorProposal({
    access, domainId: 'domain-1', decision: 'approve', reason: 'Direct competitor',
  });

  assert.equal(tables.audit_events.length, 1, 'exactly one audit row');
  const event = tables.audit_events[0];
  assert.equal(event.action, 'project_domain.proposal_approved');
  assert.equal(event.actor_user_id, 'approver-1');
  assert.equal(event.actor_role, 'approver');
  assert.equal(event.reason, 'Direct competitor');
  assert.equal(event.entity_id, 'domain-1');
  // Approving releases metered SEMrush spend, so the trail has to say who
  // proposed it as well as who accepted it.
  assert.equal(event.old_state.proposedBy, 'contributor-9');
  assert.equal(event.new_state.status, 'active');
});

// ── Rejecting ───────────────────────────────────────────────────────────────

test('rejecting retires the row rather than deleting it', async () => {
  seed();
  const domain = await store.decideCompetitorProposal({
    access, domainId: 'domain-1', decision: 'reject', reason: 'Not a competitor',
  });
  // 'removed', not gone: what was proposed and turned down is part of the
  // project's history, and the partial unique index frees the origin so the
  // same domain can be proposed again later.
  assert.equal(domain.status, 'removed');
  assert.equal(tables.project_domains.length, 1);
  assert.equal(tables.audit_events[0].action, 'project_domain.proposal_rejected');
});

// ── Guards ──────────────────────────────────────────────────────────────────

test('a domain that is already tracked is not awaiting a decision', async () => {
  seed({ status: 'active' });
  await assert.rejects(
    store.decideCompetitorProposal({ access, domainId: 'domain-1', decision: 'approve' }),
    (e) => e.status === 400 && /already tracked/.test(e.message),
  );
  assert.equal(tables.audit_events.length, 0, 'a refused decision writes no audit row');
});

test('an already-rejected proposal cannot be decided twice', async () => {
  seed({ status: 'removed' });
  await assert.rejects(
    store.decideCompetitorProposal({ access, domainId: 'domain-1', decision: 'approve' }),
    (e) => e.status === 400 && /not awaiting a decision/.test(e.message),
  );
});

test('the primary domain cannot be approved as a competitor', async () => {
  seed({ role: 'primary' });
  await assert.rejects(
    store.decideCompetitorProposal({ access, domainId: 'domain-1', decision: 'approve' }),
    (e) => e.status === 400 && /Only a proposed competitor/.test(e.message),
  );
});

// AC-001: knowing an id must not confirm it exists. A domain on someone else's
// project answers 404, the same as one that was never there.
test("a domain id from another project is a 404, not a forbidden", async () => {
  seed({ project_id: 'project-2' });
  await assert.rejects(
    store.decideCompetitorProposal({ access, domainId: 'domain-1', decision: 'approve' }),
    (e) => e.status === 404,
  );
});

test('an unknown domain id is a 404', async () => {
  seed();
  await assert.rejects(
    store.decideCompetitorProposal({ access, domainId: 'nope', decision: 'approve' }),
    (e) => e.status === 404,
  );
});

// ── Reading proposals back ──────────────────────────────────────────────────

test('proposals are invisible to the default read and visible when asked for', async () => {
  seed();
  const activeOnly = await store.listDomains(PROJECT.id);
  assert.equal(activeOnly.length, 0, 'the runners must not see a proposal as tracked');

  const withProposals = await store.listDomains(PROJECT.id, {
    statuses: store.ACTIVE_AND_PROPOSED,
  });
  assert.equal(withProposals.length, 1);
  assert.equal(withProposals[0].status, 'proposed');
});

// ── Setting the primary domain ──────────────────────────────────────────────
//
// The route and the store function both existed and no screen called either, so
// this path was never exercised — which is how it came to contain a query that
// could not match. Phase 4 wires the UI to it; these pin the behaviour it now
// depends on.

function seedProject({ projectOver = {}, domains = [] } = {}) {
  tables.crawl_projects = [{
    id: PROJECT.id,
    workspace_id: 'ws-1',
    owner: 'user-1',
    url: 'https://client.example',
    site_verified_at: '2026-01-01T00:00:00Z',
    robots_override: true,
    ...projectOver,
  }];
  tables.project_domains = domains;
  tables.audit_events = [];
}

const primaryRow = (over = {}) => ({
  id: 'primary-1',
  project_id: PROJECT.id,
  workspace_id: 'ws-1',
  role: 'primary',
  status: 'active',
  normalized_origin: 'https://client.example',
  host: 'client.example',
  scheme: 'https',
  source: 'user_entered',
  created_by: 'user-1',
  created_at: new Date().toISOString(),
  ...over,
});

test('changing the primary domain retires the old one and re-points the crawler', async () => {
  seedProject({ domains: [primaryRow()] });
  const editAccess = { ...access, project: tables.crawl_projects[0] };

  await store.setPrimaryDomain({ access: editAccess, domain: 'newsite.example' });

  const retired = tables.project_domains.find((d) => d.id === 'primary-1');
  assert.equal(retired.status, 'removed', 'the old primary is retired, not deleted');

  const current = tables.project_domains.find(
    (d) => d.role === 'primary' && d.status === 'active');
  assert.equal(current.normalized_origin, 'https://newsite.example');

  // crawl_projects.url is the compatibility projection the CrawlScope worker
  // and scheduler still read, so it has to follow the domain.
  assert.equal(tables.crawl_projects[0].url, 'https://newsite.example');
});

test('a domain change clears site verification and any robots override', async () => {
  seedProject({ domains: [primaryRow()] });
  const editAccess = { ...access, project: tables.crawl_projects[0] };

  await store.setPrimaryDomain({ access: editAccess, domain: 'newsite.example' });

  // Both described the PREVIOUS site. Carrying them over would let an override
  // granted for a verified site apply to one nobody has verified.
  assert.equal(tables.crawl_projects[0].site_verified_at, null);
  assert.equal(tables.crawl_projects[0].robots_override, false);
});

// Covers the JS path for a workspace-less project: normalization, the domain
// rows, and the crawl_projects update all behave with workspace_id NULL.
//
// It does NOT reproduce the bug this path was blocked on, and cannot. That bug
// was SQL semantics: the UPDATE carried `and workspace_id = $3`, and in Postgres
// `workspace_id = NULL` evaluates to NULL rather than true, so it matched zero
// rows and db.one threw. fakeDb compares with `(row[col] ?? null) === want`,
// where null === null is true — so this test passes with or without the fix.
// See the header of helpers/fakeDb.js: assertions ABOUT SQL semantics do not
// belong here, because a fake can only restate the assumption being tested.
// The real check is the "no workspace_id predicate" assertion below, plus
// scripts/verifyNullPredicate.js against a live database.
test('setting the primary domain works on a project with no workspace', async () => {
  seedProject({ projectOver: { workspace_id: null }, domains: [] });
  const legacyAccess = {
    ...access,
    project: tables.crawl_projects[0],
    workspaceId: null,
    role: 'owner',
  };

  const result = await store.setPrimaryDomain({ access: legacyAccess, domain: 'orphan.example' });
  assert.equal(result.primaryDomain.origin, 'https://orphan.example');
  assert.equal(tables.crawl_projects[0].url, 'https://orphan.example');
});

// The regression guard that actually holds, since the defect was the presence
// of a predicate rather than a behaviour a fake can model. If someone re-adds
// `and workspace_id = $n` to this UPDATE, a workspace-less project goes back to
// 500ing on exactly the action it needs most — and this fails loudly instead.
test('the primary-domain UPDATE carries no workspace_id predicate', () => {
  const source = fs.readFileSync(require.resolve('../store'), 'utf8');
  const update = /update crawl_projects\s+set url = \$1[\s\S]*?returning \*/.exec(source);
  assert.ok(update, 'the setPrimaryDomain UPDATE should be findable in the source');
  assert.ok(
    !/workspace_id/.test(update[0]),
    'setPrimaryDomain must key on id alone — requireProject has already authorised '
    + 'the caller against this project\'s workspace, and `workspace_id = NULL` '
    + 'matches zero rows in Postgres.',
  );
});

test('a domain already proposed as a competitor cannot become the primary', async () => {
  seedProject({
    domains: [
      primaryRow(),
      {
        ...primaryRow(),
        id: 'domain-2', role: 'competitor', status: 'proposed',
        normalized_origin: 'https://rival.example', host: 'rival.example',
      },
    ],
  });
  const editAccess = { ...access, project: tables.crawl_projects[0] };

  // The unique index is partial (`where status = 'active'`), so it would not
  // have caught this — the clash would surface later, when the proposal was
  // approved, pointing at the wrong action.
  await assert.rejects(
    store.setPrimaryDomain({ access: editAccess, domain: 'rival.example' }),
    (e) => e.status === 400 && /proposed as a competitor/.test(e.message),
  );
});
