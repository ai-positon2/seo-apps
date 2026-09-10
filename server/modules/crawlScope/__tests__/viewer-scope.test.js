const test = require("node:test");
const assert = require("node:assert/strict");
const { canViewRow, viewerScope } = require("../db/repo");

// Who may read a crawl run.
//
// These two functions are the tenancy boundary for every crawl screen. There is
// no RLS behind them: if canViewRow says yes, the row is served. So the cases
// below are the security model written down, not incidental coverage.

const WS_A = "2a58b854-96ec-46f1-b0ec-88906dc8e6cf";
const WS_B = "4796774d-2f5b-4c1a-9f3e-1b2c3d4e5f60";
const USER = "bf8be24d-1c79-4584-a264-48ee2d5ef368";
const OTHER = "2d031e65-1111-2222-3333-444455556666";

const viewer = { userId: USER, workspaceIds: [WS_A] };

test("a row in the viewer's workspace is readable, whoever created it", () => {
  assert.equal(canViewRow({ workspace_id: WS_A, owner: OTHER }, viewer), true);
});

test("a row in another workspace is not readable, even by its own creator", () => {
  // The workspace is the boundary, not authorship: leaving a workspace has to
  // actually remove access to the work done inside it.
  assert.equal(canViewRow({ workspace_id: WS_B, owner: USER }, viewer), false);
});

test("a pre-workspace row stays with the user who created it", () => {
  assert.equal(canViewRow({ workspace_id: null, owner: USER }, viewer), true);
  assert.equal(canViewRow({ workspace_id: null, owner: OTHER }, viewer), false);
});

test("a missing row and a missing viewer are both 'no'", () => {
  assert.equal(canViewRow(null, viewer), false);
  assert.equal(canViewRow({ workspace_id: WS_A, owner: USER }, null), false);
  assert.equal(canViewRow({ workspace_id: null, owner: USER }, { workspaceIds: [WS_A] }), false);
});

test("viewerScope covers both branches", () => {
  const scope = viewerScope(viewer);
  // Workspace membership, and the pre-workspace rows the viewer created.
  assert.match(scope.sql, /workspace_id = any\(\$1\)/);
  assert.match(scope.sql, /workspace_id is null and owner = \$2/);
  assert.deepEqual(scope.params, [[WS_A], USER]);
});

test("viewerScope is null for a viewer with no identity", () => {
  // Null MUST mean "no rows" to the caller. A caller that treated it as "no
  // filter" would read the entire table, so this is asserted rather than assumed.
  assert.equal(viewerScope({}), null);
  assert.equal(viewerScope({ workspaceIds: [] }), null);
  assert.equal(viewerScope(null), null);
});

test("viewerScope drops anything that is not a uuid", () => {
  // Ids are bound as parameters now, so a malformed one cannot become query
  // syntax. It is still dropped: a viewer whose only ids are junk must come back
  // with NO rows, and removing them here is what makes that an empty scope
  // rather than a clause that happens to match nothing.
  assert.equal(viewerScope({ workspaceIds: ["' or 1=1--"], userId: null }), null);
  assert.equal(viewerScope({ workspaceIds: [], userId: "not-a-uuid" }), null);

  const scope = viewerScope({ workspaceIds: [WS_A, "bogus"], userId: null });
  assert.deepEqual(scope.params, [[WS_A]]);
  assert.doesNotMatch(scope.sql, /owner/);
});
