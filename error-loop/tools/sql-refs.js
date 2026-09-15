#!/usr/bin/env node
/**
 * Detector 5 — SQL in server code that names a table or column no migration
 * defines.
 *
 * The server connects as the database owner and builds SQL as strings, so a
 * table renamed in a migration and missed in one query fails only when that
 * query runs — which for a rarely-taken branch can be a long time after the
 * merge that broke it. Nothing in the test suite executes real SQL.
 *
 * Deliberately conservative, to keep false positives near zero:
 *   - TABLE names are checked wherever they are unambiguous: `from X`,
 *     `join X`, `insert into X`, `update X set`, `delete from X`.
 *   - COLUMN names are checked only in `insert into T (a, b, c)` lists, which
 *     are well delimited. Columns in select lists and where clauses are NOT
 *     checked: aliases, expressions, CTEs and joins make them unreliable.
 *   - CTE names (`with x as (...)`) are collected and treated as valid tables.
 *   - information_schema / pg_catalog references are ignored.
 *
 * A hit is a strong signal but still needs reading — a table may be created
 * outside supabase/migrations (see the --extra flag note below).
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const toPosix = (p) => p.split(path.sep).join(String.fromCharCode(47));
const TARGETS = process.argv.slice(2).length ? process.argv.slice(2) : ['server'];

// ── 1. Schema from migrations ───────────────────────────────────────────────
const schema = new Map(); // table -> Set(columns)
const MIG = path.join(ROOT, 'supabase/migrations');

function addTable(t) {
  if (!schema.has(t)) schema.set(t, new Set());
  return schema.get(t);
}

for (const f of fs.readdirSync(MIG).filter((n) => n.endsWith('.sql')).sort()) {
  const sql = fs.readFileSync(path.join(MIG, f), 'utf8')
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ');

  // create table [if not exists] name ( ... )
  for (const m of sql.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?([A-Za-z_][\w.]*)\s*\(/gi)) {
    const table = m[1].replace(/^public\./i, '');
    const cols = addTable(table);
    // Read the column definitions: first identifier of each top-level comma group.
    let depth = 0, i = m.index + m[0].length - 1, start = -1;
    for (; i < sql.length; i++) {
      if (sql[i] === '(') { depth++; if (depth === 1) start = i + 1; continue; }
      if (sql[i] === ')') { depth--; if (depth === 0) break; continue; }
    }
    const body = sql.slice(start, i);
    let d = 0, buf = '';
    const parts = [];
    for (const ch of body) {
      if (ch === '(') d++;
      else if (ch === ')') d--;
      if (ch === ',' && d === 0) { parts.push(buf); buf = ''; continue; }
      buf += ch;
    }
    parts.push(buf);
    for (const p of parts) {
      const t = p.trim();
      if (!t) continue;
      if (/^(primary|foreign|unique|check|constraint|exclude|like)\b/i.test(t)) continue;
      const name = (t.match(/^"?([A-Za-z_][\w]*)"?/) || [])[1];
      if (name) cols.add(name.toLowerCase());
    }
  }

  // One `alter table` may carry many comma-separated `add column` clauses:
  //   alter table t add column a int, add column b text, add column c timestamptz;
  // Matching `alter table X ... add column Y` in a single regex catches only the
  // first clause, which made every later column look undefined (attempts and
  // scheduled_for in 0019 both reported as missing). Take the whole statement up
  // to its semicolon, then find every clause inside it.
  for (const m of sql.matchAll(/alter\s+table\s+(?:if\s+exists\s+)?([A-Za-z_][\w.]*)([\s\S]*?);/gi)) {
    const table = addTable(m[1].replace(/^public\./i, ''));
    for (const c of m[2].matchAll(/add\s+column\s+(?:if\s+not\s+exists\s+)?"?([A-Za-z_][\w]*)"?/gi)) {
      table.add(c[1].toLowerCase());
    }
  }
  for (const m of sql.matchAll(/alter\s+table\s+(?:if\s+exists\s+)?([A-Za-z_][\w.]*)\s+rename\s+to\s+"?([A-Za-z_][\w]*)"?/gi)) {
    const from = m[1].replace(/^public\./i, '');
    addTable(m[2]);
    if (schema.has(from)) for (const c of schema.get(from)) addTable(m[2]).add(c);
  }
  for (const m of sql.matchAll(/alter\s+table\s+(?:if\s+exists\s+)?([A-Za-z_][\w.]*)\s+rename\s+(?:column\s+)?"?([A-Za-z_][\w]*)"?\s+to\s+"?([A-Za-z_][\w]*)"?/gi)) {
    const t = addTable(m[1].replace(/^public\./i, ''));
    t.delete(m[2].toLowerCase());
    t.add(m[3].toLowerCase());
  }
  for (const m of sql.matchAll(/create\s+(?:or\s+replace\s+)?view\s+(?:if\s+not\s+exists\s+)?([A-Za-z_][\w.]*)/gi)) {
    addTable(m[1].replace(/^public\./i, ''));
  }
  for (const m of sql.matchAll(/create\s+(?:unique\s+)?(?:materialized\s+)?view\s+([A-Za-z_][\w.]*)/gi)) {
    addTable(m[1].replace(/^public\./i, ''));
  }
}

// ── 2. SQL strings in server code ───────────────────────────────────────────
function walk(dir, out = []) {
  let es; try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of es) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

const files = [];
for (const t of TARGETS) {
  const abs = path.join(ROOT, t);
  if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) walk(abs, files);
  else if (fs.existsSync(abs)) files.push(abs);
}

const IGNORE_SCHEMAS = /^(information_schema|pg_catalog|pg_)/i;
const badTables = [];
const badColumns = [];

for (const file of files) {
  if (/__tests__/.test(file)) continue;
  const raw = fs.readFileSync(file, 'utf8');
  const rel = toPosix(path.relative(ROOT, file));
  const lineOf = (i) => raw.slice(0, i).split('\n').length;

  // Template literals and quoted strings that look like SQL.
  for (const m of raw.matchAll(/`([^`]*)`|'([^'\n]*)'|"([^"\n]*)"/g)) {
    const sql = m[1] ?? m[2] ?? m[3] ?? '';
    if (sql.length < 12) continue;
    // Merely CONTAINING a SQL keyword is not enough: this repo is full of
    // natural-language prompt strings ("select the best pages from the list"),
    // which produced tables called 'the', 'an', 'top' and 'each'. Real SQL here
    // either begins with the verb or carries a $N placeholder.
    const looksLikeSql =
      /^\s*(with|select|insert\s+into|update|delete\s+from)\b/i.test(sql)
      || (/\$\d/.test(sql) && /\b(select|insert\s+into|update|delete\s+from)\b/i.test(sql));
    if (!looksLikeSql) continue;
    const at = m.index;

    // CTEs and aliases declared inside this statement are legitimate names.
    const local = new Set();
    for (const c of sql.matchAll(/\bwith\s+([A-Za-z_][\w]*)\s+as\s*\(/gi)) local.add(c[1].toLowerCase());
    for (const c of sql.matchAll(/\)\s*,\s*([A-Za-z_][\w]*)\s+as\s*\(/gi)) local.add(c[1].toLowerCase());

    const refs = [];
    for (const r of sql.matchAll(/\b(?:from|join)\s+(?:only\s+)?([A-Za-z_][\w.]*)/gi)) refs.push(r[1]);
    for (const r of sql.matchAll(/\binsert\s+into\s+([A-Za-z_][\w.]*)/gi)) refs.push(r[1]);
    for (const r of sql.matchAll(/\bupdate\s+(?:only\s+)?([A-Za-z_][\w.]*)\s+set\b/gi)) refs.push(r[1]);
    for (const r of sql.matchAll(/\bdelete\s+from\s+(?:only\s+)?([A-Za-z_][\w.]*)/gi)) refs.push(r[1]);

    for (const ref of refs) {
      const t = ref.replace(/^public\./i, '').toLowerCase();
      if (IGNORE_SCHEMAS.test(t) || t.includes('.')) continue;
      if (local.has(t)) continue;
      if (/^\$\{/.test(ref)) continue;
      if (!schema.has(t)) badTables.push({ file: rel, line: lineOf(at), table: t });
    }

    // insert into T (a, b, c)
    for (const r of sql.matchAll(/\binsert\s+into\s+([A-Za-z_][\w.]*)\s*\(([^)]*)\)/gi)) {
      const t = r[1].replace(/^public\./i, '').toLowerCase();
      if (!schema.has(t)) continue;
      const known = schema.get(t);
      if (!known.size) continue;
      for (const c of r[2].split(',')) {
        const name = c.trim().replace(/^"|"$/g, '').toLowerCase();
        if (!name || name.includes('${') || !/^[a-z_][\w]*$/.test(name)) continue;
        if (!known.has(name)) badColumns.push({ file: rel, line: lineOf(at), table: t, column: name });
      }
    }
  }
}

fs.writeFileSync(
  path.join(ROOT, 'error-loop/reports/sql-refs.json'),
  JSON.stringify({
    generatedAt: new Date().toISOString(),
    targets: TARGETS,
    tablesKnown: schema.size,
    badTables, badColumns,
  }, null, 2),
);

console.log(`tables defined by migrations: ${schema.size}`);
console.log(`SQL referencing an unknown table: ${badTables.length}`);
for (const b of badTables) console.log(`  ${b.file}:${b.line}  table '${b.table}'`);
console.log(`insert column not in that table: ${badColumns.length}`);
for (const b of badColumns) console.log(`  ${b.file}:${b.line}  ${b.table}.${b.column}`);
process.exitCode = (badTables.length || badColumns.length) ? 1 : 0;
