// ── The team workspace: who lands where ─────────────────────────────────────
//
// Everyone with a Position2 email shares one workspace and works in it by
// default; anyone else keeps a personal one (identityStore.ensureHomeWorkspace,
// migration 0039). These tests pin the routing decision with the database
// mocked, so they run anywhere. The merge script's refusals are pinned too:
// it must not run against a schema it does not fully understand.
//
// Run: node services/__tests__/teamWorkspace.test.js

const test = require('node:test');
const assert = require('node:assert');

const db = require('../db');
const auditEvents = require('../auditEvents');
const platformAdmin = require('../platformAdmin');
const identityStore = require('../identityStore');
const consolidate = require('../../scripts/consolidateTeamWorkspace');

const TEAM = { id: 'ws-team', name: 'Position2', auto_join_domain: 'position2.com', lifecycle_status: 'active' };
const PERSONAL = { id: 'ws-personal', name: "x's workspace", is_personal: true, lifecycle_status: 'active' };

// Answers each identityStore query by what it is asking for.
function fakeDb(t, { team = TEAM, member = false, personal = PERSONAL, teamError = null } = {}) {
  const inserted = [];
  t.mock.method(db, 'maybeOne', async (sql) => {
    if (/auto_join_domain = \$1/.test(sql)) { if (teamError) throw teamError; return team; }
    if (/from workspace_members where workspace_id/.test(sql)) return member ? { user_id: 'u' } : null;
    if (/is_personal = true/.test(sql)) return personal;
    throw new Error(`unexpected query: ${sql}`);
  });
  t.mock.method(db, 'tx', async (fn) => fn({
    maybeOne: async (sql, params) => { inserted.push({ sql, params }); return { role: params[2] }; },
    query: async (sql, params) => { inserted.push({ sql, params }); return { rows: [] }; },
  }));
  t.mock.method(auditEvents, 'record', async () => true);
  return inserted;
}

test('emailDomain reads the domain, lowercased, and nothing for a non-email', () => {
  assert.equal(identityStore.emailDomain('Someone@Position2.com '), 'position2.com');
  assert.equal(identityStore.emailDomain('a@b@acme.com'), 'acme.com');
  assert.equal(identityStore.emailDomain('no-at-sign'), '');
  assert.equal(identityStore.emailDomain(null), '');
});

test('a Position2 user who is not a member yet joins the team workspace as approver', async (t) => {
  const writes = fakeDb(t);
  t.mock.method(platformAdmin, 'isPlatformAdmin', async () => false);

  const ws = await identityStore.ensureHomeWorkspace('user-1', 'someone@position2.com');
  assert.equal(ws.id, TEAM.id);

  const join = writes.find((w) => /insert into workspace_members/.test(w.sql));
  assert.deepEqual(join.params, [TEAM.id, 'user-1', 'approver']);
  const event = writes.find((w) => /insert into workspace_member_events/.test(w.sql));
  assert.ok(event, 'the join is on the membership history');
  assert.match(event.params.at(-1), /Joined automatically/);
});

test('a platform administrator joins as owner, so the workspace always has one', async (t) => {
  const writes = fakeDb(t);
  t.mock.method(platformAdmin, 'isPlatformAdmin', async () => true);

  await identityStore.ensureHomeWorkspace('admin-1', 'admin@position2.com');
  const join = writes.find((w) => /insert into workspace_members/.test(w.sql));
  assert.equal(join.params[2], 'owner');
});

test('an existing member is left alone — no write, whatever their role', async (t) => {
  const writes = fakeDb(t, { member: true });
  t.mock.method(platformAdmin, 'isPlatformAdmin', async () => true);

  const ws = await identityStore.ensureHomeWorkspace('user-1', 'someone@position2.com');
  assert.equal(ws.id, TEAM.id);
  assert.equal(writes.length, 0);
});

test('someone outside Position2 keeps their personal workspace', async (t) => {
  const writes = fakeDb(t, { team: null });
  const ws = await identityStore.ensureHomeWorkspace('user-2', 'client@acme.com');
  assert.equal(ws.id, PERSONAL.id);
  assert.equal(writes.length, 0, 'no team workspace is created for a domain without one');
});

test('the synthetic platform-embed account is never put in the team workspace', async (t) => {
  fakeDb(t);
  const ws = await identityStore.ensureHomeWorkspace('platform', identityStore.PLATFORM_EMAIL);
  assert.equal(ws.id, PERSONAL.id);
});

// Last on purpose: the missing-column state is sticky for the process.
test('before migration 0039 is applied, everyone falls back to a personal workspace', async (t) => {
  const missing = Object.assign(new Error('column "auto_join_domain" does not exist'), { code: '42703' });
  const writes = fakeDb(t, { teamError: missing });
  t.mock.method(console, 'warn', () => {});
  const ws = await identityStore.ensureHomeWorkspace('user-1', 'someone@position2.com');
  assert.equal(ws.id, PERSONAL.id);
  assert.equal(writes.length, 0, 'it must not try to create the team workspace on a schema without the column');
});

// ── The merge script's refusals ─────────────────────────────────────────────

function schemaQ(tables, { has0039 = true } = {}) {
  return async (sql) => {
    if (/column_name = 'workspace_id'/.test(sql)) return { rows: tables.map((table_name) => ({ table_name })) };
    if (/column_name = 'auto_join_domain'/.test(sql)) return { rows: has0039 ? [{ '?column?': 1 }] : [] };
    throw new Error(`stopped after the schema check: ${sql.slice(0, 40)}`);
  };
}

test('the merge script refuses a schema with a workspace_id table it does not know', async () => {
  const tables = [...consolidate.MOVED_TABLES, ...Object.keys(consolidate.LEFT_IN_PLACE), 'brand_new_table'];
  await assert.rejects(consolidate.buildPlan(schemaQ(tables)), /brand_new_table/);
});

test('the merge script refuses to run before migration 0039', async () => {
  const tables = [...consolidate.MOVED_TABLES, ...Object.keys(consolidate.LEFT_IN_PLACE)];
  await assert.rejects(consolidate.buildPlan(schemaQ(tables, { has0039: false })), /0039/);
});

test('the merge script never moves the append-only audit trail', () => {
  assert.ok(!consolidate.MOVED_TABLES.includes('audit_events'));
  assert.ok('audit_events' in consolidate.LEFT_IN_PLACE);
});

test('merge script arguments', () => {
  const a = consolidate.parseArgs(['--apply', '--retire-duplicates', '--keep', 'p1, p2', '--skip', 'w1', '--by', 'x@position2.com']);
  assert.deepEqual(a, { apply: true, retireDuplicates: true, allowBusy: false, skip: ['w1'], keep: ['p1', 'p2'], by: 'x@position2.com' });
  assert.equal(consolidate.parseArgs([]).apply, false, 'a plan run is the default');
});
