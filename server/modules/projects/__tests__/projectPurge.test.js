// ── Tests for permanent project deletion (store.purgeProject) ───────────────
// This is the only operation in the system with nothing behind it: no restore,
// no grace period, no soft-deleted copy. So the things worth testing are not
// the happy path but the guards and the ORDER, because each failure mode is
// silent and permanent:
//
//   - purging a live project, or the wrong one, destroys a client's history;
//   - deleting crawl_projects before crawl_runs orphans every run instead of
//     removing it (crawl_runs.project_id is `on delete set null`), leaving data
//     nothing points at and nothing can find;
//   - scoping the crawl_runs delete by workspace_id would skip runs whose
//     workspace was purged earlier — the very orphan the ordering prevents;
//   - a dropped audit row makes an irreversible act unaccountable.
//
// None of that needs a real database, so it runs in CI on every commit: the
// database layer is faked, and the fake records every delete it is asked for.
//
// Run: node modules/projects/__tests__/projectPurge.test.js

const assert = require('assert');

// ── Fakes, installed before store.js is loaded ──────────────────────────────
// store.js takes the db module at require time, so the stub has to be in the
// module cache first.

const dbPath = require.resolve('../../../services/db');
const auditPath = require.resolve('../../../services/auditEvents');

const holder = { tx: null };

function stub(path, exports) {
  require.cache[path] = { id: path, filename: path, loaded: true, exports };
}

stub(dbPath, {
  isDatabaseConfigured: () => true,
  // purgeProject runs its whole ordered delete inside one transaction, so this
  // is the only entry point it uses.
  tx: (fn) => holder.tx(fn),
  json: (v) => (v === null || v === undefined ? null : JSON.stringify(v)),
});

// The real ACTIONS vocabulary, so a missing PROJECT_PURGED fails here rather
// than writing `undefined` as an action name into the trail.
const { ACTIONS } = require('../../../services/auditEvents');
const audit = { calls: [], fail: false };
stub(auditPath, {
  ACTIONS,
  record: async (event, opts) => {
    audit.calls.push({ event, opts });
    if (audit.fail) throw new Error('audit write failed');
    return true;
  },
});

const store = require('../store');

/**
 * A transaction stand-in that records each delete as
 * { table, eqs: { column: value } } in call order.
 *
 * The SQL shape is this module's own (see purgeProject), so it is parsed rather
 * than guessed at: `delete from "<table>" where "<col>" = $n [and <col> = $n]`.
 */
function fakeTx(recorder, { failOn = null, rowCount = 2 } = {}) {
  return async (fn) => {
    const t = {
      query(sql, params = []) {
        const table = /delete from "([a-z_]+)"/i.exec(sql)?.[1];
        assert.ok(table, `unexpected statement in purge: ${sql}`);

        const call = { table, eqs: {} };
        const conds = /where\s+(.*)$/is.exec(sql)?.[1] || '';
        for (const m of conds.matchAll(/"?([a-z_]+)"?\s*=\s*\$(\d+)/gi)) {
          call.eqs[m[1]] = params[Number(m[2]) - 1];
        }
        recorder.push(call);

        if (failOn === table) throw new Error('boom');
        return Promise.resolve({ rowCount });
      },
    };
    return fn(t);
  };
}

const PROJECT = {
  id: 'proj-1',
  workspace_id: 'ws-1',
  name: 'Gentle Dental',
  url: 'https://www.gentledental.com',
  lifecycle_status: 'deleted',
  deleted_at: '2026-08-21T00:00:00.000Z',
};

function access(overrides = {}) {
  return {
    project: { ...PROJECT, ...(overrides.project || {}) },
    userId: 'user-1',
    actorEmail: 'admin@example.com',
    role: 'owner',
  };
}

function reset() {
  audit.calls = [];
  audit.fail = false;
}

let passed = 0, failed = 0;
async function test(name, fn) {
  reset();
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}

async function rejects(promise, predicate) {
  try {
    await promise;
  } catch (e) {
    assert.ok(predicate(e), `error did not match: ${e.message} (code ${e.code}, status ${e.status})`);
    return e;
  }
  throw new Error('expected a rejection, got none');
}

(async () => {
  // ── The purge order ───────────────────────────────────────────────────────

  console.log('\nPurge order — the shape that prevents orphans');

  await test('crawl_runs is deleted before the project row', () => {
    const order = store.PROJECT_PURGE_ORDER.map((e) => e.table);
    assert.deepStrictEqual(order, ['crawl_runs', 'crawl_projects']);
  });

  await test('crawl_runs is matched on project_id and NOT workspace-scoped', () => {
    const runs = store.PROJECT_PURGE_ORDER.find((e) => e.table === 'crawl_runs');
    assert.strictEqual(runs.column, 'project_id');
    // crawl_runs.workspace_id is itself `on delete set null`, so a workspace
    // predicate here would skip runs of an already-purged workspace.
    assert.ok(!runs.workspaceScoped);
  });

  await test('the project row is workspace-scoped', () => {
    const proj = store.PROJECT_PURGE_ORDER.find((e) => e.table === 'crawl_projects');
    assert.strictEqual(proj.column, 'id');
    assert.strictEqual(proj.workspaceScoped, true);
  });

  // ── Guards ────────────────────────────────────────────────────────────────

  console.log('\nGuards — a purge must be deliberate and unambiguous');

  await test('an active project cannot be purged, even with the right name', async () => {
    const calls = [];
    holder.tx = fakeTx(calls);
    await rejects(
      store.purgeProject({
        access: access({ project: { lifecycle_status: 'active' } }),
        confirmName: 'Gentle Dental',
      }),
      (e) => e.code === 'not_deleted' && e.status === 409,
    );
    assert.strictEqual(calls.length, 0, 'nothing may be deleted');
    assert.strictEqual(audit.calls.length, 0, 'and nothing recorded');
  });

  await test('an archived project cannot be purged either', async () => {
    const calls = [];
    holder.tx = fakeTx(calls);
    await rejects(
      store.purgeProject({
        access: access({ project: { lifecycle_status: 'archived' } }),
        confirmName: 'Gentle Dental',
      }),
      (e) => e.code === 'not_deleted',
    );
    assert.strictEqual(calls.length, 0);
  });

  await test('a wrong, empty or absent name is refused', async () => {
    for (const confirmName of [undefined, null, '', 'gentle dental', 'Gentle Dentl', 'Riccobene']) {
      const calls = [];
      holder.tx = fakeTx(calls);
      // eslint-disable-next-line no-await-in-loop
      await rejects(
        store.purgeProject({ access: access(), confirmName }),
        (e) => e.code === 'confirm_name_mismatch' && e.status === 400,
      );
      assert.strictEqual(calls.length, 0, `deleted something for ${JSON.stringify(confirmName)}`);
    }
  });

  await test('the confirmation is case-sensitive but tolerates surrounding space', async () => {
    holder.tx = fakeTx([]);
    await rejects(
      store.purgeProject({ access: access(), confirmName: 'GENTLE DENTAL' }),
      (e) => e.code === 'confirm_name_mismatch',
    );

    const calls = [];
    holder.tx = fakeTx(calls);
    const result = await store.purgeProject({ access: access(), confirmName: '  Gentle Dental  ' });
    assert.strictEqual(result.purged, true);
    assert.strictEqual(calls.length, 2);
  });

  await test('the refusal names the expected project, so a mismatch is fixable', async () => {
    holder.tx = fakeTx([]);
    const e = await rejects(
      store.purgeProject({ access: access(), confirmName: 'wrong' }),
      () => true,
    );
    assert.ok(e.message.includes('Gentle Dental'), e.message);
  });

  // ── The purge itself ──────────────────────────────────────────────────────

  console.log('\nPurge — what it deletes, and in what order');

  await test('deletes crawl_runs then the project, each correctly scoped', async () => {
    const calls = [];
    holder.tx = fakeTx(calls);

    const result = await store.purgeProject({
      access: access(), confirmName: 'Gentle Dental', reason: 'client offboarded',
    });

    assert.deepStrictEqual(calls, [
      { table: 'crawl_runs', eqs: { project_id: 'proj-1' } },
      { table: 'crawl_projects', eqs: { id: 'proj-1', workspace_id: 'ws-1' } },
    ]);
    assert.strictEqual(result.purged, true);
    assert.strictEqual(result.id, 'proj-1');
    assert.strictEqual(result.name, 'Gentle Dental');
    assert.deepStrictEqual(result.deleted, { crawl_runs: 2, crawl_projects: 2 });
  });

  await test('a legacy project with no workspace is purged, not silently skipped', async () => {
    // Pre-0011 projects are authorized by their creator and carry no
    // workspace_id. A `workspace_id = NULL` predicate matches nothing — so the
    // predicate has to be left off rather than deleting no row and reporting
    // success.
    const calls = [];
    holder.tx = fakeTx(calls);

    const result = await store.purgeProject({
      access: access({ project: { workspace_id: null } }),
      confirmName: 'Gentle Dental',
    });

    assert.deepStrictEqual(calls, [
      { table: 'crawl_runs', eqs: { project_id: 'proj-1' } },
      { table: 'crawl_projects', eqs: { id: 'proj-1' } },
    ]);
    assert.strictEqual(result.purged, true);
  });

  await test('a purge that deletes no project row throws instead of claiming success', async () => {
    // The silent-failure case: the delete succeeds but matches nothing. Callers
    // must not be told the data is gone while it is still there.
    const calls = [];
    holder.tx = fakeTx(calls, { rowCount: 0 });

    await rejects(
      store.purgeProject({ access: access(), confirmName: 'Gentle Dental' }),
      (e) => /still exists after its purge/.test(e.message),
    );
    assert.deepStrictEqual(calls.map((c) => c.table), ['crawl_runs', 'crawl_projects']);
  });

  await test('a failure on the project row surfaces as a purge failure', async () => {
    holder.tx = fakeTx([], { failOn: 'crawl_projects' });
    await rejects(
      store.purgeProject({ access: access(), confirmName: 'Gentle Dental' }),
      (e) => /purgeProject/.test(e.message) && /boom/.test(e.message),
    );
  });

  await test('a failure on crawl_runs stops before the project row is touched', async () => {
    const calls = [];
    holder.tx = fakeTx(calls, { failOn: 'crawl_runs' });
    await rejects(
      store.purgeProject({ access: access(), confirmName: 'Gentle Dental' }),
      (e) => /purgeProject/.test(e.message),
    );
    assert.deepStrictEqual(calls.map((c) => c.table), ['crawl_runs'],
      'the project row must survive a failed run delete, or the runs are orphaned');
  });

  await test('the whole purge is one transaction, so a partial delete cannot stand', async () => {
    // The ordering above protects against orphans within a successful purge;
    // this is what protects against a purge that dies halfway. Over independent
    // requests — all PostgREST could do — a crash after crawl_runs left a
    // project whose history was gone and whose row was not.
    let sawTransaction = false;
    holder.tx = async (fn) => {
      sawTransaction = true;
      return fakeTx([])(fn);
    };
    await store.purgeProject({ access: access(), confirmName: 'Gentle Dental' });
    assert.ok(sawTransaction, 'purgeProject must run its deletes inside db.tx');
  });

  // ── The audit trail ───────────────────────────────────────────────────────

  console.log('\nAudit — the only remaining evidence afterwards');

  await test('the event is recorded strictly, before anything is deleted', async () => {
    const calls = [];
    holder.tx = fakeTx(calls);
    audit.calls = [];

    // Recorded first: the fake pushes deletes as they happen, and the audit
    // stub captured nothing yet at the moment the first delete ran.
    let deletesAtAuditTime = null;
    const auditModule = require.cache[auditPath].exports;
    const original = auditModule.record;
    auditModule.record = async (event, opts) => {
      deletesAtAuditTime = calls.length;
      return original(event, opts);
    };

    await store.purgeProject({ access: access(), confirmName: 'Gentle Dental' });
    auditModule.record = original;

    assert.strictEqual(deletesAtAuditTime, 0, 'audit must precede the deletes');
    assert.strictEqual(audit.calls.length, 1);
    assert.strictEqual(audit.calls[0].opts.strict, true);
  });

  await test('the event carries the action, actor and a name snapshot', async () => {
    holder.tx = fakeTx([]);
    await store.purgeProject({
      access: access(), confirmName: 'Gentle Dental', reason: 'client offboarded',
    });

    const { event } = audit.calls[0];
    assert.strictEqual(event.action, 'project.purged');
    assert.strictEqual(event.action, ACTIONS.PROJECT_PURGED);
    assert.strictEqual(event.workspaceId, 'ws-1');
    assert.strictEqual(event.projectId, 'proj-1');
    assert.strictEqual(event.actorUserId, 'user-1');
    assert.strictEqual(event.actorEmail, 'admin@example.com');
    assert.strictEqual(event.reason, 'client offboarded');
    // The snapshot is the point: in a moment these exist nowhere else.
    assert.strictEqual(event.oldState.name, 'Gentle Dental');
    assert.strictEqual(event.oldState.url, 'https://www.gentledental.com');
  });

  await test('a failed audit write aborts the purge — nothing is deleted', async () => {
    const calls = [];
    holder.tx = fakeTx(calls);
    audit.fail = true;

    await rejects(
      store.purgeProject({ access: access(), confirmName: 'Gentle Dental' }),
      (e) => /audit write failed/.test(e.message),
    );
    assert.strictEqual(calls.length, 0,
      'an unrecordable irreversible act must not proceed');
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})();
