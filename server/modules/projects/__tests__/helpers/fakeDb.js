// ── An in-memory stand-in for services/db ───────────────────────────────────
//
// Used by the project tests that are about MODULE behaviour — does setup queue
// one run or two, does a second caller duplicate it, may a viewer start work —
// where the database is incidental state rather than the thing under test.
// Those tests were written against an in-memory fake of the old PostgREST
// builder and are kept offline for the same reason: they run in CI on every
// commit.
//
// Tests whose assertions are ABOUT SQL semantics do NOT use this. The queue's
// atomic claim, the NULL-heartbeat reaper arm and the budget SUM are all
// statements about what Postgres does, and they run against a real database
// (see services/__tests__/moduleQueue.test.js and
// modules/aiVisibility/__tests__/budgetRetention.test.js) — a fake could only
// restate the assumption being tested.
//
// ── The one rule here ───────────────────────────────────────────────────────
// It THROWS on any statement shape it does not fully understand. A fake that
// guesses returns plausible wrong data, and a test that passes against wrong
// data is worse than no test. If a module starts emitting SQL this does not
// cover, the suite fails loudly and this file gets taught the new shape.

const assert = require('node:assert/strict');

const IDENT = '"?([a-z_][a-z0-9_]*)"?';

function unsupported(sql) {
  throw new Error(`[fakeDb] unsupported statement:\n${sql.trim()}`);
}

// A value slot: a bound parameter, or a literal written straight into the SQL
// (`'queued'`, `0`, `true`, `null`) — statements here mix the two freely.
function readValue(slot, params, sql) {
  const text = slot.trim();

  const idx = /^\$(\d+)$/.exec(text);
  if (idx) {
    const value = params[Number(idx[1]) - 1];
    // jsonb params arrive pre-encoded (db.json); tests read objects.
    if (typeof value === 'string' && /^[[{]/.test(value)) {
      try { return JSON.parse(value); } catch { return value; }
    }
    return value;
  }

  const str = /^'([^']*)'$/.exec(text);
  if (str) return str[1];
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
  if (/^true$/i.test(text)) return true;
  if (/^false$/i.test(text)) return false;
  if (/^null$/i.test(text)) return null;
  if (/^now\(\)$/i.test(text)) return new Date().toISOString();

  return unsupported(sql);
}

// Strips parentheses only when they wrap the WHOLE expression. Blindly removing
// a leading "(" and a trailing ")" also ate the one on `module_key = any($3)`,
// which then matched nothing and read as an unsupported predicate.
function unwrap(text) {
  let out = text.trim();
  while (out.startsWith('(') && out.endsWith(')')) {
    let depth = 0;
    let wraps = true;
    for (let i = 0; i < out.length; i += 1) {
      if (out[i] === '(') depth += 1;
      else if (out[i] === ')') {
        depth -= 1;
        if (depth === 0 && i < out.length - 1) { wraps = false; break; }
      }
    }
    if (!wraps || depth !== 0) break;
    out = out.slice(1, -1).trim();
  }
  return out;
}

// Splits a WHERE clause into predicates over a row. Only the forms this
// codebase actually emits are accepted.
function parseWhere(clause, params, sql) {
  if (!clause || !clause.trim()) return [];
  const preds = [];
  // `and` is the only connective used; anything else is out of scope.
  if (/\bor\b/i.test(clause)) unsupported(sql);

  for (const part of clause.split(/\s+and\s+/i)) {
    const text = unwrap(part.trim());
    if (!text) continue;

    let m;
    // col = any($n)   /  col <> all($n)
    if ((m = new RegExp(`^${IDENT}\\s*=\\s*any\\(\\$(\\d+)\\)$`, 'i').exec(text))) {
      const [, col, i] = m;
      const set = params[Number(i) - 1] || [];
      preds.push((r) => set.includes(r[col]));
      continue;
    }
    if ((m = new RegExp(`^${IDENT}\\s*<>\\s*all\\(\\$(\\d+)\\)$`, 'i').exec(text))) {
      const [, col, i] = m;
      const set = params[Number(i) - 1] || [];
      preds.push((r) => !set.includes(r[col]));
      continue;
    }
    // col in ('a', 'b')
    if ((m = new RegExp(`^${IDENT}\\s+in\\s*\\(([^)]*)\\)$`, 'i').exec(text))) {
      const [, col, list] = m;
      const set = list.split(',').map((s) => s.trim().replace(/^'|'$/g, ''));
      preds.push((r) => set.includes(r[col]));
      continue;
    }
    // col is [not] null
    if ((m = new RegExp(`^${IDENT}\\s+is\\s+not\\s+null$`, 'i').exec(text))) {
      const [, col] = m;
      preds.push((r) => r[col] !== null && r[col] !== undefined);
      continue;
    }
    if ((m = new RegExp(`^${IDENT}\\s+is\\s+null$`, 'i').exec(text))) {
      const [, col] = m;
      preds.push((r) => r[col] === null || r[col] === undefined);
      continue;
    }
    // col is not distinct from $n
    if ((m = new RegExp(`^${IDENT}\\s+is\\s+not\\s+distinct\\s+from\\s+\\$(\\d+)$`, 'i').exec(text))) {
      const [, col, i] = m;
      const want = params[Number(i) - 1] ?? null;
      preds.push((r) => (r[col] ?? null) === want);
      continue;
    }
    // col = $n  |  col <> $n  |  col = 'literal'  |  col <> 'literal'
    if ((m = new RegExp(`^${IDENT}\\s*(=|<>)\\s*(?:\\$(\\d+)|'([^']*)'|(true|false))$`, 'i').exec(text))) {
      const [, col, op, idx, lit, bool] = m;
      let want;
      if (idx !== undefined) want = params[Number(idx) - 1];
      else if (lit !== undefined) want = lit;
      else want = bool.toLowerCase() === 'true';
      preds.push((r) => (op === '=' ? r[col] === want : r[col] !== want));
      continue;
    }
    unsupported(sql);
  }
  return preds;
}

function applyOrder(rows, clause, sql) {
  if (!clause) return rows;
  const keys = clause.split(',').map((part) => {
    const m = new RegExp(`^${IDENT}\\s*(asc|desc)?(?:\\s+nulls\\s+(first|last))?$`, 'i')
      .exec(part.trim());
    if (!m) unsupported(sql);
    return { col: m[1], desc: (m[2] || 'asc').toLowerCase() === 'desc' };
  });
  return [...rows].sort((a, b) => {
    for (const { col, desc } of keys) {
      const x = a[col];
      const y = b[col];
      if (x === y) continue;
      // Nulls sort last in both directions here; no test distinguishes them.
      if (x === null || x === undefined) return 1;
      if (y === null || y === undefined) return -1;
      const cmp = x < y ? -1 : 1;
      return desc ? -cmp : cmp;
    }
    return 0;
  });
}

/**
 * @param {object} tables  { tableName: [] } — the only tables that may be
 *   touched. Reading or writing anything else throws, which is how a test
 *   asserts "this path must not go near that table".
 * @param {object} [hooks]
 * @param {Function} [hooks.beforeInsert] (table, row) => void, may throw to
 *   simulate a write failure.
 * @param {Function} [hooks.onQuery]      (table, sql) => void
 */
function createFakeDb(tables, hooks = {}) {
  let sequence = 0;
  const nextId = () => `row-${++sequence}`;

  function tableFor(name, sql) {
    assert.ok(name in tables, `[fakeDb] unexpected table "${name}" in:\n${sql.trim()}`);
    return tables[name];
  }

  function run(sql, params = []) {
    const text = sql.replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ').trim();

    // ── insert ──
    let m = /^insert into "?([a-z_]+)"? \(([^)]+)\) values (.+?)(?: returning (.+))?$/i.exec(text);
    if (m) {
      const [, name, colList, valuesPart, returning] = m;
      const store = tableFor(name, sql);
      const cols = colList.split(',').map((c) => c.trim().replace(/"/g, ''));

      // One or more (…) tuples of $n placeholders.
      const tuples = [...valuesPart.matchAll(/\(([^)]*)\)/g)].map((t) => t[1]);
      if (!tuples.length) unsupported(sql);

      const inserted = [];
      for (const tuple of tuples) {
        const slots = tuple.split(',').map((s) => s.trim());
        const row = { id: nextId(), created_at: new Date().toISOString() };
        slots.forEach((slot, i) => {
          row[cols[i]] = readValue(slot, params, sql);
        });
        if (hooks.beforeInsert) hooks.beforeInsert(name, row);
        store.push(row);
        inserted.push(row);
      }
      return { rows: returning ? inserted : [], rowCount: inserted.length };
    }

    // ── update ──
    m = /^update "?([a-z_]+)"? set (.+?) where (.+?)(?: returning (.+))?$/i.exec(text);
    if (m) {
      const [, name, setPart, wherePart, returning] = m;
      const store = tableFor(name, sql);
      const patch = {};
      for (const piece of setPart.split(',')) {
        const s = new RegExp(`^${IDENT}\\s*=\\s*(.+)$`, 'i').exec(piece.trim());
        if (!s) unsupported(sql);
        patch[s[1]] = readValue(s[2], params, sql);
      }
      const preds = parseWhere(wherePart, params, sql);
      const hit = store.filter((r) => preds.every((p) => p(r)));
      for (const row of hit) Object.assign(row, patch);
      return { rows: returning ? hit : [], rowCount: hit.length };
    }

    // ── delete ──
    m = /^delete from "?([a-z_]+)"?(?: where (.+?))?(?: returning (.+))?$/i.exec(text);
    if (m) {
      const [, name, wherePart, returning] = m;
      const store = tableFor(name, sql);
      const preds = parseWhere(wherePart, params, sql);
      const hit = store.filter((r) => preds.every((p) => p(r)));
      for (const row of hit) store.splice(store.indexOf(row), 1);
      return { rows: returning ? hit : [], rowCount: hit.length };
    }

    // ── select ──
    m = /^select (.+?) from "?([a-z_]+)"?(?: where (.+?))?(?: order by (.+?))?(?: limit (\$\d+|\d+))?(?: offset (\$\d+|\d+))?$/i
      .exec(text);
    if (m) {
      const [, cols, name, wherePart, orderPart, limitPart, offsetPart] = m;
      const store = tableFor(name, sql);
      if (hooks.onQuery) hooks.onQuery(name, sql);

      const preds = parseWhere(wherePart, params, sql);
      let rows = store.filter((r) => preds.every((p) => p(r)));
      rows = applyOrder(rows, orderPart, sql);

      const bound = (part) => {
        if (part === undefined) return undefined;
        const idx = /^\$(\d+)$/.exec(part);
        return Number(idx ? params[Number(idx[1]) - 1] : part);
      };
      const offset = bound(offsetPart) || 0;
      const limit = bound(limitPart);
      if (offset) rows = rows.slice(offset);
      if (limit !== undefined) rows = rows.slice(0, limit);

      // Projection, including `payload->>'key' as "alias"`.
      if (cols.trim() !== '*') {
        rows = rows.map((row) => {
          const out = {};
          for (const spec of cols.split(',')) {
            const piece = spec.trim();
            const json = new RegExp(`^${IDENT}->>'([a-z_A-Z]+)' as "([^"]+)"$`, 'i').exec(piece);
            if (json) {
              const [, col, key, alias] = json;
              const v = (row[col] || {})[key];
              out[alias] = v === undefined || v === null ? null : String(v);
              continue;
            }
            const jsonObj = new RegExp(`^${IDENT}->'([a-z_A-Z]+)' as "([^"]+)"$`, 'i').exec(piece);
            if (jsonObj) {
              const [, col, key, alias] = jsonObj;
              out[alias] = (row[col] || {})[key] ?? null;
              continue;
            }
            const plain = new RegExp(`^${IDENT}(?: as "?([a-z_]+)"?)?$`, 'i').exec(piece);
            if (!plain) unsupported(sql);
            out[plain[2] || plain[1]] = row[plain[1]] ?? null;
          }
          return out;
        });
      }
      return { rows, rowCount: rows.length };
    }

    return unsupported(sql);
  }

  const api = {
    isDatabaseConfigured: () => true,
    json: (v) => (v === null || v === undefined ? null : JSON.stringify(v)),
    query: async (sql, params) => run(sql, params),
    rows: async (sql, params) => run(sql, params).rows,
    maybeOne: async (sql, params) => {
      const r = run(sql, params);
      if (r.rows.length > 1) throw new Error(`expected at most one row, got ${r.rows.length}`);
      return r.rows[0] ?? null;
    },
    one: async (sql, params) => {
      const r = run(sql, params);
      if (r.rows.length !== 1) throw new Error(`expected exactly one row, got ${r.rows.length}`);
      return r.rows[0];
    },
    value: async (sql, params) => {
      const r = run(sql, params);
      if (!r.rows.length) return null;
      return Object.values(r.rows[0])[0];
    },
    count: async (sql, params) => Number((await api.value(sql, params)) || 0),
    tx: async (fn) => fn(api),

    insertOne: async (table, row, { returning = '*' } = {}) => {
      const cols = Object.keys(row);
      const r = run(
        `insert into "${table}" (${cols.join(', ')}) values (${cols.map((_, i) => `$${i + 1}`).join(', ')})`
        + (returning ? ` returning ${returning}` : ''),
        cols.map((c) => row[c]),
      );
      return returning ? r.rows[0] : r.rowCount;
    },
    insertMany: async (table, list, { returning = null } = {}) => {
      if (!list.length) return returning ? [] : 0;
      const cols = [...new Set(list.flatMap((r) => Object.keys(r)))];
      const params = [];
      const tuples = list.map((row) => `(${cols.map((c) => {
        params.push(row[c] === undefined ? null : row[c]);
        return `$${params.length}`;
      }).join(', ')})`);
      const r = run(
        `insert into "${table}" (${cols.join(', ')}) values ${tuples.join(', ')}`
        + (returning ? ` returning ${returning}` : ''),
        params,
      );
      return returning ? r.rows : r.rowCount;
    },
    updateWhere: async (table, patch, where, { returning = null } = {}) => {
      const params = [];
      const sets = Object.keys(patch).map((c) => {
        params.push(patch[c]);
        return `${c} = $${params.length}`;
      });
      const conds = Object.keys(where).map((c) => {
        if (where[c] === null) return `${c} is null`;
        params.push(where[c]);
        return `${c} = $${params.length}`;
      });
      const r = run(
        `update "${table}" set ${sets.join(', ')} where ${conds.join(' and ')}`
        + (returning ? ` returning ${returning}` : ''),
        params,
      );
      return returning ? r.rows : r.rowCount;
    },
    upsert: async (table, list, conflictCols, { returning = null } = {}) => {
      const arr = Array.isArray(list) ? list : [list];
      const store = tableFor(table, `upsert ${table}`);
      const out = [];
      for (const row of arr) {
        const existing = store.find((r) => conflictCols.every((c) => r[c] === row[c]));
        if (existing) { Object.assign(existing, row); out.push(existing); continue; }
        const created = { id: nextId(), created_at: new Date().toISOString(), ...row };
        store.push(created);
        out.push(created);
      }
      if (!returning) return out.length;
      return Array.isArray(list) ? out : out[0] ?? null;
    },
    deleteWhere: async (table, where) => {
      const params = [];
      const conds = Object.keys(where).map((c) => {
        params.push(where[c]);
        return Array.isArray(where[c]) ? `${c} = any($${params.length})` : `${c} = $${params.length}`;
      });
      return run(`delete from "${table}" where ${conds.join(' and ')}`, params).rowCount;
    },
    end: async () => {},
  };

  return api;
}

module.exports = { createFakeDb };
