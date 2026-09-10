// ── Postgres data layer (Neon) ───────────────────────────────────────────────
// The app talks to Postgres directly over the wire. This replaces the former
// Supabase/PostgREST client: there is no REST hop, no service-role key and no
// RLS in the picture — Express is the only thing that opens a connection, and
// every query here is parameterised.
//
// Lazy singleton pool: created on first use (not at import) so the server still
// boots for the stateless-proxy modules before DATABASE_URL is configured. The
// first query throws a clear, actionable error instead.
//
// ── Why the type parsers below matter ────────────────────────────────────────
// PostgREST handed every row to the app as JSON, so the app has always seen
// timestamps as ISO strings and bigint/numeric as JS numbers. node-postgres
// decodes the same columns differently by default — Date objects for
// timestamps, and STRINGS for bigint and numeric, because either can exceed
// what a double represents exactly. Left alone that difference is silent and
// everywhere: `score * 2` becomes string repetition, `id === 41` stops
// matching, and a timestamp lands in JSON as a Date. The parsers restore the
// representation the rest of the codebase was written against.

const { Pool, types } = require('pg');

// ── Wire-format parsers (process-wide, set once) ─────────────────────────────

// Postgres renders timestamptz in the session time zone; every connection is
// pinned to UTC below, so the text always carries a "+00" offset. PostgREST
// spelled the same instant "2026-09-10T10:02:13.263456+00:00", so match that:
// swap the date/time separator and pad the offset to a full "+00:00". Keeping
// the text (rather than going through a Date) preserves the microseconds that
// Date would round away to milliseconds.
const toIsoTimestamptz = (v) =>
  v === null ? null : v.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00');

// timestamp WITHOUT time zone carries no offset to normalise.
const toIsoTimestamp = (v) => (v === null ? null : v.replace(' ', 'T'));

// bigint and numeric arrive as text. Every bigint column in this schema is a
// row id (see the id columns on activity_log, audit_events, crawl_run_*), all
// far below 2^53, and the numeric columns are scores and small dollar amounts —
// so Number is exact for the data we hold and matches what the app expects.
const toNumber = (v) => (v === null ? null : Number(v));

types.setTypeParser(types.builtins.TIMESTAMPTZ, toIsoTimestamptz);
types.setTypeParser(types.builtins.TIMESTAMP, toIsoTimestamp);
types.setTypeParser(types.builtins.DATE, (v) => v); // 'YYYY-MM-DD', as PostgREST sent it
types.setTypeParser(types.builtins.INT8, toNumber);
types.setTypeParser(types.builtins.NUMERIC, toNumber);

// ── Pool ─────────────────────────────────────────────────────────────────────

let pool = null;

function connectionString() {
  return process.env.DATABASE_URL || '';
}

// True when a connection string is present — lets callers gate optional
// persistence without triggering the throw in getPool().
function isDatabaseConfigured() {
  return Boolean(connectionString());
}

function getPool() {
  if (pool) return pool;

  const url = connectionString();
  if (!url) {
    throw new Error(
      'The database is not configured. Set DATABASE_URL in your .env (see ' +
      '.env.example) to a Postgres connection string. This is server-side only ' +
      '— it must never be exposed to the browser.'
    );
  }

  pool = new Pool({
    connectionString: url,
    // Neon terminates idle connections on its own; keep the pool small and let
    // it drain so a mostly-idle web process is not holding compute open.
    max: Number(process.env.DATABASE_POOL_MAX || 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 15_000,
    // Long-running module work (crawl completion writes, evidence rollups) can
    // legitimately outlast a default timeout, so no statement_timeout is set
    // here; the slow paths that need a bound set their own.
  });

  // A pooled connection that dies in the background must not take the process
  // with it — pg emits 'error' on idle clients when the server hangs up.
  pool.on('error', (err) => {
    console.error('postgres idle client error:', err.message);
  });

  // Pin every connection to UTC so the timestamptz parser above always sees a
  // "+00" offset regardless of the host's local zone.
  pool.on('connect', (client) => {
    client.query("set time zone 'UTC'").catch(() => {});
  });

  return pool;
}

async function end() {
  if (!pool) return;
  const p = pool;
  pool = null;
  await p.end();
}

// ── Query helpers ────────────────────────────────────────────────────────────

// Returns the full pg result ({ rows, rowCount, ... }).
function query(text, params) {
  return getPool().query(text, params);
}

// The common case: just the rows.
async function rows(text, params) {
  return (await query(text, params)).rows;
}

// Exactly one row or null — the direct replacement for .maybeSingle().
async function maybeOne(text, params) {
  const r = await query(text, params);
  if (r.rows.length > 1) {
    throw new Error(`expected at most one row, got ${r.rows.length}`);
  }
  return r.rows[0] ?? null;
}

// Exactly one row, or throw — the direct replacement for .single().
async function one(text, params) {
  const r = await query(text, params);
  if (r.rows.length !== 1) {
    throw new Error(`expected exactly one row, got ${r.rows.length}`);
  }
  return r.rows[0];
}

// A single scalar from the first column of the first row.
async function value(text, params) {
  const r = await query(text, params);
  if (!r.rows.length) return null;
  return r.rows[0][r.fields[0].name];
}

// Row count for a COUNT(*) query, as a number.
async function count(text, params) {
  const n = await value(text, params);
  return Number(n || 0);
}

// Runs fn inside a transaction on one dedicated connection. fn receives a
// client exposing the same helpers, so nested calls stay on that connection.
async function tx(fn) {
  const client = await getPool().connect();
  const scoped = {
    query: (t, p) => client.query(t, p),
    rows: async (t, p) => (await client.query(t, p)).rows,
    maybeOne: async (t, p) => {
      const r = await client.query(t, p);
      if (r.rows.length > 1) throw new Error(`expected at most one row, got ${r.rows.length}`);
      return r.rows[0] ?? null;
    },
    one: async (t, p) => {
      const r = await client.query(t, p);
      if (r.rows.length !== 1) throw new Error(`expected exactly one row, got ${r.rows.length}`);
      return r.rows[0];
    },
    value: async (t, p) => {
      const r = await client.query(t, p);
      return r.rows.length ? r.rows[0][r.fields[0].name] : null;
    },
  };
  try {
    await client.query('begin');
    const out = await fn(scoped);
    await client.query('commit');
    return out;
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ── jsonb binding ────────────────────────────────────────────────────────────
// node-postgres turns a JS array into a POSTGRES ARRAY LITERAL ("{1,2,3}"), not
// into JSON. Bound to one of this schema's 60 jsonb columns that is exactly the
// wrong thing: "invalid input syntax for type json". PostgREST took arrays
// natively, so the app is full of array-valued jsonb writes (citations,
// competitors_mentioned, findings, aliases, provider_ids, settings.value …) that
// would each fail. Meanwhile five columns really are Postgres text[]
// (ai_visibility_captures.features, ai_visibility_prompts.tags,
// crawl_projects.recipients, page_category.secondary_categories and
// .signals_matched) and MUST keep being passed as JS arrays.
//
// So the distinction cannot be guessed from the value — it has to come from the
// column. Use json() when hand-writing SQL; the builders below look the column
// type up themselves so a rewrite cannot forget.

// Serialise a value for a jsonb parameter. A string is assumed to be JSON
// already and passed through, so double-encoding is impossible.
function json(value) {
  if (value === null || value === undefined) return null;
  return typeof value === 'string' ? value : JSON.stringify(value);
}

// table -> Map(column -> data_type), read from the catalog once per process.
const columnTypeCache = new Map();

async function jsonColumns(table) {
  if (columnTypeCache.has(table)) return columnTypeCache.get(table);
  const found = await rows(
    `select column_name from information_schema.columns
      where table_schema = 'public' and table_name = $1 and data_type in ('jsonb', 'json')`,
    [table]
  );
  const set = new Set(found.map((r) => r.column_name));
  columnTypeCache.set(table, set);
  return set;
}

// ── Statement builders ───────────────────────────────────────────────────────
// Writes are overwhelmingly "here is an object, persist it", and hand-writing
// the column list and placeholder run for each one is where transcription bugs
// live. These build ordinary parameterised SQL from a plain object — they are
// not a query language: reads, joins, filtering and ordering are written as
// SQL at the call site.

const ident = (name) => {
  if (!/^[a-z_][a-z0-9_]*$/i.test(name)) throw new Error(`unsafe identifier: ${name}`);
  return `"${name}"`;
};

// insertOne('project_pages', { project_id, url }) -> inserted row
// Pass { returning: false } for a write whose result is not read.
async function insertOne(table, row, { returning = '*', client = null } = {}) {
  const cols = Object.keys(row);
  if (!cols.length) throw new Error(`insertOne(${table}): nothing to insert`);
  const jsonCols = await jsonColumns(table);
  const sql =
    `insert into ${ident(table)} (${cols.map(ident).join(', ')}) ` +
    `values (${cols.map((_, i) => `$${i + 1}`).join(', ')})` +
    (returning ? ` returning ${returning}` : '');
  const run = client || { query };
  const r = await run.query(sql, cols.map((c) => (jsonCols.has(c) ? json(row[c]) : row[c])));
  return returning ? r.rows[0] : r.rowCount;
}

// Multi-row insert. Every row must share one column set; missing keys become
// NULL rather than shifting columns.
async function insertMany(table, list, { returning = null, client = null } = {}) {
  if (!list.length) return returning ? [] : 0;
  const cols = [...new Set(list.flatMap((r) => Object.keys(r)))];
  const jsonCols = await jsonColumns(table);
  const params = [];
  const tuples = list.map((row) => {
    const slots = cols.map((c) => {
      const v = row[c] === undefined ? null : row[c];
      params.push(jsonCols.has(c) ? json(v) : v);
      return `$${params.length}`;
    });
    return `(${slots.join(', ')})`;
  });
  const sql =
    `insert into ${ident(table)} (${cols.map(ident).join(', ')}) values ${tuples.join(', ')}` +
    (returning ? ` returning ${returning}` : '');
  const run = client || { query };
  const r = await run.query(sql, params);
  return returning ? r.rows : r.rowCount;
}

// upsert('user_profiles', row, ['user_id']) — ON CONFLICT DO UPDATE across the
// non-conflict columns, which is what the PostgREST upsert did. Pass
// { merge: false } for DO NOTHING.
async function upsert(table, list, conflictCols, { returning = null, merge = true, client = null } = {}) {
  const arr = Array.isArray(list) ? list : [list];
  if (!arr.length) return returning ? [] : 0;
  const cols = [...new Set(arr.flatMap((r) => Object.keys(r)))];
  const jsonCols = await jsonColumns(table);
  const params = [];
  const tuples = arr.map((row) => {
    const slots = cols.map((c) => {
      const v = row[c] === undefined ? null : row[c];
      params.push(jsonCols.has(c) ? json(v) : v);
      return `$${params.length}`;
    });
    return `(${slots.join(', ')})`;
  });
  const updatable = cols.filter((c) => !conflictCols.includes(c));
  const action =
    merge && updatable.length
      ? `do update set ${updatable.map((c) => `${ident(c)} = excluded.${ident(c)}`).join(', ')}`
      : 'do nothing';
  const sql =
    `insert into ${ident(table)} (${cols.map(ident).join(', ')}) values ${tuples.join(', ')} ` +
    `on conflict (${conflictCols.map(ident).join(', ')}) ${action}` +
    (returning ? ` returning ${returning}` : '');
  const run = client || { query };
  const r = await run.query(sql, params);
  if (!returning) return r.rowCount;
  return Array.isArray(list) ? r.rows : r.rows[0] ?? null;
}

// updateWhere('crawl_runs', { status: 'done' }, { id }) — equality-only WHERE.
// Anything richer belongs in SQL at the call site.
async function updateWhere(table, patch, where, { returning = null, client = null } = {}) {
  const setCols = Object.keys(patch);
  const whereCols = Object.keys(where);
  if (!setCols.length) throw new Error(`updateWhere(${table}): empty patch`);
  if (!whereCols.length) throw new Error(`updateWhere(${table}): refusing to update every row`);
  const jsonCols = await jsonColumns(table);
  const params = [];
  const sets = setCols.map((c) => {
    params.push(jsonCols.has(c) ? json(patch[c]) : patch[c]);
    return `${ident(c)} = $${params.length}`;
  });
  const conds = whereCols.map((c) => {
    if (where[c] === null) return `${ident(c)} is null`;
    params.push(where[c]);
    return `${ident(c)} = $${params.length}`;
  });
  const sql =
    `update ${ident(table)} set ${sets.join(', ')} where ${conds.join(' and ')}` +
    (returning ? ` returning ${returning}` : '');
  const run = client || { query };
  const r = await run.query(sql, params);
  return returning ? r.rows : r.rowCount;
}

// deleteWhere('cache', { id }) — equality-only WHERE, same reasoning.
async function deleteWhere(table, where, { returning = null, client = null } = {}) {
  const whereCols = Object.keys(where);
  if (!whereCols.length) throw new Error(`deleteWhere(${table}): refusing to delete every row`);
  const params = [];
  const conds = whereCols.map((c) => {
    if (where[c] === null) return `${ident(c)} is null`;
    if (Array.isArray(where[c])) {
      params.push(where[c]);
      return `${ident(c)} = any($${params.length})`;
    }
    params.push(where[c]);
    return `${ident(c)} = $${params.length}`;
  });
  const sql =
    `delete from ${ident(table)} where ${conds.join(' and ')}` +
    (returning ? ` returning ${returning}` : '');
  const run = client || { query };
  const r = await run.query(sql, params);
  return returning ? r.rows : r.rowCount;
}

module.exports = {
  getPool,
  isDatabaseConfigured,
  end,
  query,
  rows,
  one,
  maybeOne,
  value,
  count,
  tx,
  json,
  insertOne,
  insertMany,
  upsert,
  updateWhere,
  deleteWhere,
};
