// ── Hidden Tech Audit checks ("Exclude check") ──────────────────────────────
//
// What is worth asserting offline:
//   • the stored list is cleaned and its ids normalised;
//   • hide / restore write ONLY settings.hiddenChecks, with a jsonb merge on
//     the row's current settings, and are idempotent;
//   • the gate is approver and up;
//   • the crawl-health cache key carries the hidden set, so hiding recomputes,
//     and the statements receive it as their exclusion list;
//   • the per-rule rollup leaves hidden rules out and the card's tallies drop
//     their findings; with nothing hidden every figure is what it was;
//   • Ask SEO Studio's working names the hidden checks.
// The SQL itself runs against a real database in siteHealthDb.test.js.
//
// Run: node --test modules/projects/__tests__/hiddenChecks.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../../../services/db');

const hidden = require('../hiddenChecks');

test('the stored list is cleaned: well-formed ids, one entry per rule', () => {
  const list = hidden.hiddenChecksOf({
    hiddenChecks: [
      { ruleId: 'page-4xx', hiddenBy: 'a@x.com', hiddenAt: '2026-11-01T00:00:00Z' },
      { ruleId: 'page-4xx', hiddenBy: 'b@x.com' },
      { ruleId: 'drop table;' },
      null,
      { ruleId: ' broken-internal-links ', reason: 'r'.repeat(900) },
    ],
  });
  assert.deepEqual(list.map((h) => h.ruleId), ['page-4xx', 'broken-internal-links']);
  assert.equal(list[0].hiddenBy, 'a@x.com');
  assert.equal(list[1].reason.length, hidden.MAX_REASON);
  assert.deepEqual(hidden.hiddenChecksOf({}), []);
  assert.deepEqual(hidden.hiddenChecksOf({ hiddenChecks: 'nope' }), []);
});

test('hiddenRuleIds reads settings, a project, a view or a list — sorted and unique', () => {
  assert.deepEqual(hidden.hiddenRuleIds({ settings: { hiddenChecks: [{ ruleId: 'b' }, { ruleId: 'a' }] } }), ['a', 'b']);
  assert.deepEqual(hidden.hiddenRuleIds({ hiddenChecks: [{ ruleId: 'z' }, { ruleId: 'z' }] }), ['z']);
  assert.deepEqual(hidden.hiddenRuleIds(['y', 'x', '', null]), ['x', 'y']);
  assert.deepEqual(hidden.hiddenRuleIds(null), []);
});

test('excludeHidden and subtractHidden are no-ops when nothing is hidden', () => {
  const rows = [{ ruleId: 'a' }, { ruleId: 'b' }];
  assert.equal(hidden.excludeHidden(rows, []), rows);
  assert.deepEqual(hidden.excludeHidden(rows, ['a']), [{ ruleId: 'b' }]);
  assert.deepEqual(hidden.excludeHidden([{ rule_id: 'a' }], new Set(['a']), 'rule_id'), []);

  const counts = { error: 5, warning: 3, notice: 1, info: 2 };
  assert.deepEqual(hidden.subtractHidden(counts, []), counts);
  assert.deepEqual(
    hidden.subtractHidden(counts, [{ stored_severity: 'error', count: 2 }, { severity: 'notice', count: 9 }]),
    { error: 3, warning: 3, notice: 0, info: 2 },
  );
});

test('the run SQL fragment reads the run\'s project settings under the given placeholder', () => {
  const sql = hidden.HIDDEN_RULES_FOR_RUN('$7');
  assert.match(sql, /hr\.id = \$7/);
  assert.match(sql, /settings->'hiddenChecks'/);
  assert.match(sql, /'\{\}'::text\[\]/);
});

// ── store: hide / restore ──────────────────────────────────────────────────

function withStubbedDb(stubs, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(stubs)) { saved[k] = db[k]; db[k] = v; }
  return Promise.resolve().then(fn).finally(() => { Object.assign(db, saved); });
}

const access = (settings = {}) => ({
  workspaceId: 'w1',
  userId: 'u1',
  actorEmail: 'me@x.com',
  role: 'approver',
  project: { id: 'p1', workspace_id: 'w1', settings },
});

test('hideCheck merges only the hiddenChecks key, on the row\'s current settings', async () => {
  const store = require('../store');
  const calls = [];
  await withStubbedDb({
    isDatabaseConfigured: () => true,
    maybeOne: async (sql, params) => {
      calls.push({ sql, params });
      const entry = JSON.parse(params[3]);
      return { settings: { pageKeywords: [{ url: 'u' }], archivedClusters: ['c'], hiddenChecks: [entry] } };
    },
  }, async () => {
    const out = await store.hideCheck({ access: access({ pageKeywords: [] }), ruleId: 'page-4xx', reason: ' n/a ' });
    assert.equal(out.changed, true);
    assert.deepEqual(out.hiddenChecks.map((h) => h.ruleId), ['page-4xx']);
    assert.equal(out.entry.hiddenBy, 'me@x.com');
    assert.equal(out.entry.reason, 'n/a');
  });
  assert.equal(calls.length, 1);
  // A jsonb merge on the stored value, never a whole settings blob from here.
  assert.match(calls[0].sql, /settings = coalesce\(settings, '\{\}'::jsonb\) \|\| jsonb_build_object\('hiddenChecks'/);
  assert.match(calls[0].sql, /where id = \$1 and workspace_id = \$2/);
  assert.deepEqual(calls[0].params.slice(0, 3), ['p1', 'w1', 'page-4xx']);
});

test('hiding a hidden check, or restoring a visible one, writes nothing', async () => {
  const store = require('../store');
  let writes = 0;
  await withStubbedDb({
    isDatabaseConfigured: () => true,
    maybeOne: async () => { writes += 1; return null; },
  }, async () => {
    const settings = { hiddenChecks: [{ ruleId: 'page-4xx', hiddenBy: 'a@x.com', hiddenAt: 't' }] };
    const again = await store.hideCheck({ access: access(settings), ruleId: 'page-4xx' });
    assert.equal(again.changed, false);
    assert.equal(again.entry.hiddenBy, 'a@x.com');
    const none = await store.unhideCheck({ access: access(settings), ruleId: 'broken-internal-links' });
    assert.equal(none.changed, false);
  });
  assert.equal(writes, 0);
});

test('unhideCheck removes one entry and keeps the rest of settings', async () => {
  const store = require('../store');
  let call = null;
  await withStubbedDb({
    isDatabaseConfigured: () => true,
    maybeOne: async (sql, params) => {
      call = { sql, params };
      return { settings: { pageKeywords: [], hiddenChecks: [{ ruleId: 'b' }] } };
    },
  }, async () => {
    const out = await store.unhideCheck({
      access: access({ hiddenChecks: [{ ruleId: 'a' }, { ruleId: 'b' }] }),
      ruleId: 'a',
    });
    assert.equal(out.changed, true);
    assert.equal(out.entry.ruleId, 'a');
    assert.deepEqual(out.hiddenChecks.map((h) => h.ruleId), ['b']);
  });
  assert.match(call.sql, /\|\| jsonb_build_object\('hiddenChecks'/);
  assert.match(call.sql, /<> \$3/);
  assert.deepEqual(call.params, ['p1', 'w1', 'a']);
});

test('a malformed rule id is refused before any write', async () => {
  const store = require('../store');
  await withStubbedDb({
    isDatabaseConfigured: () => true,
    maybeOne: async () => { throw new Error('must not write'); },
  }, async () => {
    await assert.rejects(store.hideCheck({ access: access(), ruleId: "x'; drop" }), (e) => e.status === 400);
    await assert.rejects(store.unhideCheck({ access: access(), ruleId: '' }), (e) => e.status === 400);
  });
});

test('the project view carries the cleaned list', () => {
  const store = require('../store');
  const view = store.projectView({ id: 'p1', settings: { hiddenChecks: [{ ruleId: 'page-4xx' }] } }, []);
  assert.deepEqual(view.hiddenChecks.map((h) => h.ruleId), ['page-4xx']);
  assert.deepEqual(store.projectView({ id: 'p2', settings: {} }, []).hiddenChecks, []);
});

test('hiding is approver and up: the same gate as overriding a machine outcome', () => {
  const { capabilityFor } = require('../../../services/projectAccess');
  assert.equal(capabilityFor('contributor', 'overrideMachineOutcome'), false);
  for (const role of ['approver', 'admin', 'owner']) {
    assert.equal(capabilityFor(role, 'overrideMachineOutcome'), true, role);
  }
  const routes = require('fs').readFileSync(require('path').join(__dirname, '../routes.js'), 'utf8');
  assert.match(routes, /const HIDE_CHECK_CAPABILITY = 'overrideMachineOutcome'/);
  assert.match(routes, /router\.post\('\/:projectId\/hidden-checks'/);
  assert.match(routes, /router\.delete\('\/:projectId\/hidden-checks\/:ruleId'/);
});

// ── overview: the aggregates, the rollup and the card ──────────────────────

test('the crawl-health cache key carries the hidden set, and the statement excludes it', async () => {
  const overview = require('../overview');
  let hiddenNow = [];
  const statementParams = [];
  await withStubbedDb({
    maybeOne: async (sql) => {
      assert.match(sql, /from crawl_runs r/);
      return {
        status: 'completed', finished_at: 't', instances: 3, last_instance: 9, reviews: 0, reviewed_at: null,
        hidden: hiddenNow,
      };
    },
    boundedRead: async (ms, fn) => fn({
      maybeOne: async (sql, params) => {
        statementParams.push(params);
        assert.match(sql, /<> all\(\$8::text\[\]\)/);
        return {
          html_pages: 2, error_pages: params[7].length ? 0 : 1, warning_pages: 0, notice_pages: 0,
          error_loss: params[7].length ? 0 : 40, warning_loss: 0, notice_loss: 0, site_rules: [], costing: [],
        };
      },
    }),
  }, async () => {
    const runId = 'hidden-cache-run';
    const before = await overview.crawlHealthAggregates(runId);
    assert.equal(before.loss.error_pages, 1);
    assert.deepEqual(statementParams[0][7], []);
    // Unchanged: served from the cache.
    await overview.crawlHealthAggregates(runId);
    assert.equal(statementParams.length, 1);
    // Hiding a check changes the key: recomputed, with the exclusion.
    hiddenNow = ['page-4xx'];
    const after = await overview.crawlHealthAggregates(runId);
    assert.equal(statementParams.length, 2);
    assert.deepEqual(statementParams[1][7], ['page-4xx']);
    assert.equal(after.loss.error_pages, 0);
  });
});

test('findingsForRun leaves hidden rules out and carries them as hiddenRows', async () => {
  const overview = require('../overview');
  await withStubbedDb({
    rows: async (sql) => {
      assert.match(sql, /rule_id = any\(/);
      return [
        { rule_id: 'page-4xx', severity: 'error', stored_severity: 'error', category: 'c', count: 4, detail: {}, hidden: true },
        { rule_id: 'missing-title', severity: 'warning', stored_severity: 'warning', category: 'c', count: 2, detail: {}, hidden: false },
      ];
    },
  }, async () => {
    const rows = await overview.findingsForRun('r1');
    assert.deepEqual(rows.map((r) => r.rule_id), ['missing-title']);
    assert.equal('hidden' in rows[0], false);
    assert.deepEqual(rows.hiddenRows.map((r) => r.rule_id), ['page-4xx']);
    // Not enumerable: a JSON body or a spread never carries it.
    assert.equal(JSON.stringify(rows).includes('page-4xx'), false);
  });
});

test('the Tech Audit card drops hidden findings from its tallies, and says so', () => {
  const overview = require('../overview');
  const runs = [{ id: 'r1', status: 'completed', finished_at: '2026-11-01', summary: { counts: { error: 5, warning: 2, notice: 1 }, resultCount: 10 } }];
  const visible = [{ rule_id: 'missing-title', severity: 'warning', count: 2, detail: {} }];
  const plain = overview.technicalCard(runs, visible, 10, 10, [], null, 0);
  assert.deepEqual(plain.evidence.counts, { error: 5, warning: 2, notice: 1, info: 0 });

  const withHidden = [...visible];
  Object.defineProperty(withHidden, 'hiddenRows', {
    value: [{ rule_id: 'page-4xx', severity: 'error', stored_severity: 'error', count: 5 }],
    enumerable: false,
  });
  const card = overview.technicalCard(runs, withHidden, 10, 10, [], null, 0);
  assert.deepEqual(card.evidence.counts, { error: 0, warning: 2, notice: 1, info: 0 });
  assert.match(card.detail, /0 error · 2 warning · 1 notice findings listed/);

  const noted = overview.withHiddenChecks(card, [{ ruleId: 'page-4xx' }]);
  assert.match(noted.detail, /1 check hidden — excluded from this score/);
  assert.deepEqual(noted.hiddenChecks, ['page-4xx']);
  // Nothing hidden: the very same card.
  assert.equal(overview.withHiddenChecks(plain, []), plain);
});

test('findingInstancesForRun leaves hidden rules out, read fresh past the cache', async () => {
  const overview = require('../overview');
  let hiddenNow = [];
  await withStubbedDb({
    rows: async (sql) => {
      if (/row_number\(\) over/.test(sql)) return [{ id: 1, n: 1 }];
      return [{ ruleId: 'page-4xx', url: 'a' }, { ruleId: 'missing-title', url: 'b' }];
    },
    maybeOne: async (sql) => {
      assert.match(sql, /hiddenChecks/);
      return { hidden: hiddenNow };
    },
  }, async () => {
    const runId = 'hidden-instances-run';
    assert.equal((await overview.findingInstancesForRun(runId)).length, 2);
    hiddenNow = ['page-4xx'];
    const after = await overview.findingInstancesForRun(runId);
    assert.deepEqual(after.map((r) => r.ruleId), ['missing-title']);
  });
});

// ── Ask SEO Studio ───────────────────────────────────────────────────────────────

test('the Tech Audit working names the hidden checks, and only when there are some', () => {
  const { buildWorking } = require('../../reportChat/working');
  const base = { score: 80, pagesScored: 10, rules: [], bands: [] };
  const none = buildWorking('tech', base);
  assert.equal('hiddenChecks' in none, false);
  const some = buildWorking('tech', {
    ...base,
    hiddenChecks: [{ ruleId: 'page-4xx', rule: '4XX pages', occurrences: 12 }],
  });
  assert.deepEqual(some.hiddenChecks, [{ ruleId: 'page-4xx', rule: '4XX pages', occurrencesInThisCrawl: 12 }]);
  assert.match(some.hiddenChecksNote, /1 check is hidden for this client and excluded from this score: 4XX pages/);

  const { methodologyFor } = require('../../reportChat/methodology');
  assert.match(methodologyFor('tech'), /Hidden checks/);
});
