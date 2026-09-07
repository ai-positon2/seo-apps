// ── The schema invariant that made project deletion impossible ──────────────
//
// A static check over supabase/migrations. It exists because of a real bug that
// survived eleven migrations undetected.
//
// 0011 declared:
//
//   audit_events.project_id uuid references crawl_projects(id) ON DELETE SET NULL
//
// and, twenty lines later:
//
//   create trigger audit_events_append_only before update or delete
//     on audit_events for each row execute function platform_reject_mutation();
//
// ON DELETE SET NULL is implemented as an UPDATE on the child row, and the
// trigger rejects every UPDATE. The two cancel out, so the referential action
// can never fire and the PARENT row can never be deleted:
//
//   audit_events is append-only: UPDATE rejected. Write a new row instead.
//
// Because audit_events also had SET NULL keys to workspaces and app_users, no
// project, workspace or user row could be deleted at all — from the moment it
// was created, since creating one writes an audit event. Nothing caught it
// because nothing ever tried: every "delete" in the product is a status change.
// It surfaced only when store.purgeProject() attempted a real DELETE.
//
// 0023 drops those three foreign keys and keeps the trigger. This test asserts
// the pair can never be reintroduced.
//
// It reads the migration files rather than the database, so it needs no
// connection and runs in CI. That is also its limitation: it checks what the
// migrations declare, not what a given database actually has.
//
// Run: node services/__tests__/appendOnlySchema.test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0; let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}

const DIR = path.join(__dirname, '../../../supabase/migrations');

/**
 * Reads every migration and returns what it declares.
 *
 * Comments are stripped first. This codebase documents its own schema
 * decisions at length — 0023 quotes the exact forbidden pattern in its header
 * — and a commented-out example must not be read as a live declaration.
 */
function readSchema() {
  const appendOnly = new Set();
  const setNull = new Map();
  const droppedConstraints = new Set();

  for (const file of fs.readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort()) {
    const raw = fs.readFileSync(path.join(DIR, file), 'utf8');
    const sql = raw
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n');

    // Tables guarded by the append-only trigger.
    const trigger = /create\s+trigger\s+\w+\s+before\s+[^;]*?on\s+(\w+)[^;]*?platform_reject_mutation/gis;
    for (const m of sql.matchAll(trigger)) appendOnly.add(m[1]);

    // Inline `<col> uuid ... on delete set null` inside a CREATE TABLE.
    const table = /create\s+table\s+if\s+not\s+exists\s+(\w+)\s*\(([\s\S]*?)\n\);/gi;
    for (const m of sql.matchAll(table)) {
      const name = m[1];
      const column = /^[ \t]*(\w+)[ \t]+uuid[^,\n]*?on\s+delete\s+set\s+null/gim;
      for (const c of m[2].matchAll(column)) {
        if (!setNull.has(name)) setNull.set(name, new Set());
        setNull.get(name).add(c[1]);
      }
    }

    // ALTER TABLE ... ADD CONSTRAINT ... ON DELETE SET NULL, for completeness.
    const added = /alter\s+table\s+(\w+)[\s\S]{0,400}?foreign\s+key\s*\(\s*(\w+)\s*\)[\s\S]{0,200}?on\s+delete\s+set\s+null/gi;
    for (const m of sql.matchAll(added)) {
      if (!setNull.has(m[1])) setNull.set(m[1], new Set());
      setNull.get(m[1]).add(m[2]);
    }

    const dropped = /alter\s+table\s+(\w+)\s+drop\s+constraint\s+(?:if\s+exists\s+)?(\w+)/gi;
    for (const m of sql.matchAll(dropped)) droppedConstraints.add(`${m[1]}.${m[2]}`);
  }

  return { appendOnly, setNull, droppedConstraints };
}

console.log('\nAppend-only tables and referential actions');

test('the scan actually finds the append-only tables', () => {
  // A guard on the guard. If the trigger syntax is ever reformatted the regex
  // above could quietly match nothing, and this whole file would pass by
  // finding no tables to check.
  const { appendOnly } = readSchema();
  assert.ok(
    appendOnly.has('audit_events'),
    `audit_events was not recognised as append-only — the trigger pattern has `
    + `drifted and this test is no longer checking anything. Found: `
    + `${[...appendOnly].join(', ') || 'nothing'}`,
  );
});

test('no append-only table has a live ON DELETE SET NULL foreign key', () => {
  const { appendOnly, setNull, droppedConstraints } = readSchema();

  const offenders = [];
  for (const table of appendOnly) {
    for (const column of setNull.get(table) || []) {
      // Postgres names an inline `references` constraint <table>_<column>_fkey,
      // which is how 0023 drops them.
      if (droppedConstraints.has(`${table}.${table}_${column}_fkey`)) continue;
      offenders.push(`${table}.${column}`);
    }
  }

  assert.deepStrictEqual(
    offenders, [],
    'ON DELETE SET NULL on an append-only table is an UPDATE that the table\'s '
    + 'own trigger rejects, so the PARENT row can never be deleted. Either drop '
    + 'the foreign key (see migration 0023) or do not guard the table. '
    + `Offending: ${offenders.join(', ')}`,
  );
});

test('0023 drops all three of audit_events’ foreign keys', () => {
  // Named explicitly rather than left to the check above, which would also
  // pass if someone deleted 0011's declarations instead of dropping the
  // constraints — leaving already-migrated databases still broken.
  const { droppedConstraints } = readSchema();
  for (const column of ['project_id', 'workspace_id', 'actor_user_id']) {
    assert.ok(
      droppedConstraints.has(`audit_events.audit_events_${column}_fkey`),
      `audit_events.${column}'s foreign key is never dropped, so a database `
      + 'that already ran 0011 still cannot delete the parent row',
    );
  }
});

test('the append-only trigger itself is still installed', () => {
  // 0023's whole argument is that the trigger is the correct half of the pair.
  // If a later migration "fixes" this by removing the trigger instead, the
  // audit trail stops being append-only and this must fail.
  const { appendOnly } = readSchema();
  assert.ok(appendOnly.has('audit_events'), 'audit_events is no longer append-only');
  assert.ok(
    appendOnly.has('admin_limit_policies'),
    'admin_limit_policies is no longer append-only',
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
