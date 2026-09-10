// ── Generic Postgres-backed store adapter ────────────────────────────────────
// Mirrors the JSON file-store API used across the app (see
// locationPageBuilder/store.js and modules/*/store.js) so each module's store
// can be reimplemented on top of Postgres with NO change to its exported
// function names, route handlers, or client code.
//
// Table convention: every collection maps to a table with the columns
//   id text primary key, data jsonb not null,
//   created_at timestamptz default now(), updated_at timestamptz default now()
// The FULL record lives in `data` (so record shape is identical to the old
// JSON files); id/created_at/updated_at are mirrored to columns for primary
// key, ordering, and expression-indexed filters (e.g. data->>'project_id').
//
// Formerly supabaseStore.js, talking to PostgREST. The table convention and
// every exported signature are unchanged; only the transport is different.

const crypto = require('crypto');
const db = require('./db');

// Table names come from module code, never from a request, but they are
// interpolated into SQL, so they are validated rather than trusted.
function table(name) {
  if (!/^[a-z_][a-z0-9_]*$/i.test(name)) throw new Error(`unsafe table name: ${name}`);
  return `"${name}"`;
}

// Record fields addressed inside `data`. These are written as SQL literals
// rather than bound as parameters on purpose: `data->>'client_id'` is indexed
// on eleven collections (migrations 0009 and 0026), and a bound key makes the
// expression opaque to the planner, so every one of those index scans would
// silently become a sequential scan. Field names come from module code, never
// from a request, and this rejects anything that is not a plain identifier.
function jsonKey(field) {
  if (typeof field !== 'string' || !/^[a-z_][a-z0-9_]*$/i.test(field)) {
    throw new Error(`unsafe json field: ${field}`);
  }
  return `'${field}'`;
}

function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

function nowIso() {
  return new Date().toISOString();
}

function fail(op, tableName, error) {
  throw new Error(`[recordStore.${op} ${tableName}] ${error.message || error}`);
}

// ── Reads ────────────────────────────────────────────────────────────────────

// filter: shallow equality on record fields (matched via data->>key).
// opts.order: { column: 'created_at', ascending: true } (default), or a field
//   inside data via { orderField: 'name', ascending: true }. opts.limit caps rows.
async function list(tableName, filter = {}, opts = {}) {
  const p = [];
  const where = [];
  for (const [k, v] of Object.entries(filter)) {
    if (v === undefined || v === null) continue;
    p.push(String(v));
    where.push(`data->>${jsonKey(k)} = $${p.length}`);
  }

  const ascending = opts.ascending !== undefined ? opts.ascending : true;
  const dir = ascending ? 'asc' : 'desc';
  let orderBy;
  if (opts.orderField) {
    orderBy = `data->>${jsonKey(opts.orderField)} ${dir}`;
  } else {
    const col = opts.orderColumn || 'created_at';
    if (!/^[a-z_][a-z0-9_]*$/i.test(col)) throw new Error(`unsafe order column: ${col}`);
    orderBy = `"${col}" ${dir}`;
  }

  let sql = `select data from ${table(tableName)}`;
  if (where.length) sql += ` where ${where.join(' and ')}`;
  sql += ` order by ${orderBy}`;
  if (opts.limit) {
    p.push(opts.limit);
    sql += ` limit $${p.length}`;
  }

  try {
    return (await db.rows(sql, p)).map((r) => r.data);
  } catch (error) {
    fail('list', tableName, error);
  }
}

async function get(tableName, id) {
  try {
    const row = await db.maybeOne(`select data from ${table(tableName)} where id = $1`, [id]);
    return row ? row.data : null;
  } catch (error) {
    fail('get', tableName, error);
  }
}

async function findOne(tableName, filter) {
  const found = await list(tableName, filter, { limit: 1 });
  return found[0] || null;
}

// ── Writes ───────────────────────────────────────────────────────────────────

function rowFor(record) {
  return {
    id: record.id,
    data: record,
    created_at: record.created_at,
    updated_at: record.updated_at,
  };
}

async function insert(tableName, data, idPrefix) {
  const record = {
    id: data.id || newId(idPrefix || tableName.slice(0, 3)),
    created_at: data.created_at || nowIso(),
    updated_at: nowIso(),
    ...data,
  };
  // ensure id/timestamps are the canonical ones even if data omitted/overrode
  record.id = data.id || record.id;
  record.created_at = data.created_at || record.created_at;
  record.updated_at = nowIso();
  const row = rowFor(record);
  try {
    await db.query(
      `insert into ${table(tableName)} (id, data, created_at, updated_at) values ($1, $2, $3, $4)`,
      [row.id, db.json(row.data), row.created_at, row.updated_at]
    );
  } catch (error) {
    fail('insert', tableName, error);
  }
  return record;
}

async function update(tableName, id, patch) {
  const existing = await get(tableName, id);
  if (!existing) return null;
  const record = { ...existing, ...patch, id, updated_at: nowIso() };
  const row = rowFor(record);
  try {
    await db.query(
      `update ${table(tableName)} set id = $1, data = $2, created_at = $3, updated_at = $4 where id = $5`,
      [row.id, db.json(row.data), row.created_at, row.updated_at, id]
    );
  } catch (error) {
    fail('update', tableName, error);
  }
  return record;
}

async function remove(tableName, id) {
  try {
    const r = await db.query(`delete from ${table(tableName)} where id = $1`, [id]);
    return r.rowCount > 0;
  } catch (error) {
    fail('remove', tableName, error);
  }
}

// Race-free write for records whose id is a deterministic function of their
// natural key. upsertBy below does a read-then-write, so two concurrent writers
// can both see "no existing row" and each insert one -- producing duplicates
// that later reads then pick between arbitrarily. A single upsert on the
// primary key makes concurrent writers converge on ONE row instead.
async function upsertById(tableName, data, idPrefix) {
  const id = data.id || newId(idPrefix || tableName.slice(0, 3));
  // Best-effort: keep the original creation time rather than resetting it on
  // every save. A lost race here only mis-stamps created_at, never duplicates.
  let created_at = data.created_at;
  if (!created_at) {
    const existing = await get(tableName, id);
    created_at = existing?.created_at || nowIso();
  }
  const record = { ...data, id, created_at, updated_at: nowIso() };
  const row = rowFor(record);
  try {
    await db.query(
      `insert into ${table(tableName)} (id, data, created_at, updated_at) values ($1, $2, $3, $4)
         on conflict (id) do update set
           data = excluded.data, created_at = excluded.created_at, updated_at = excluded.updated_at`,
      [row.id, db.json(row.data), row.created_at, row.updated_at]
    );
  } catch (error) {
    fail('upsertById', tableName, error);
  }
  return record;
}

// Upsert by a natural key (idempotent seeding / caches keyed by a field).
async function upsertBy(tableName, keyField, data, idPrefix) {
  const existing = await findOne(tableName, { [keyField]: data[keyField] });
  if (!existing) return insert(tableName, data, idPrefix);
  return update(tableName, existing.id, data);
}

// Replace an entire collection with exactly the given rows. The wipe and the
// reinsert go in one transaction so a failure halfway cannot leave the
// collection empty -- the PostgREST version issued two independent requests
// and could.
async function replaceAll(tableName, list_, idPrefix) {
  const stamped = list_.map((r) => ({
    id: r.id || newId(idPrefix || tableName.slice(0, 3)),
    created_at: r.created_at || nowIso(),
    updated_at: nowIso(),
    ...r,
  }));
  try {
    await db.tx(async (t) => {
      await t.query(`delete from ${table(tableName)}`);
      for (const record of stamped) {
        const row = rowFor(record);
        await t.query(
          `insert into ${table(tableName)} (id, data, created_at, updated_at) values ($1, $2, $3, $4)`,
          [row.id, db.json(row.data), row.created_at, row.updated_at]
        );
      }
    });
  } catch (error) {
    fail('replaceAll', tableName, error);
  }
  return stamped;
}

// Delete every row matching a filter (e.g. all children of a parent id).
async function removeWhere(tableName, filter = {}) {
  const p = [];
  const where = [];
  for (const [k, v] of Object.entries(filter)) {
    p.push(String(v));
    where.push(`data->>${jsonKey(k)} = $${p.length}`);
  }
  let sql = `delete from ${table(tableName)}`;
  if (where.length) sql += ` where ${where.join(' and ')}`;
  try {
    const r = await db.query(sql, p);
    return r.rowCount || 0;
  } catch (error) {
    fail('removeWhere', tableName, error);
  }
}

// ── TTL cache (used by locationPageBuilder) ─────────────────────────────────
// Backed by the `cache` table: id text pk (the key), data jsonb = { at, value }.

async function cacheGet(key, ttlMs) {
  const hit = await get('cache', key);
  if (!hit) return null;
  if (ttlMs && Date.now() - hit.at > ttlMs) return null;
  return hit.value;
}

// opts.kind tags what a row IS ('semrush' | 'serp' | 'llm'), since the key is
// an opaque sha1; opts.ttlMs stamps expires_at so retention is enforceable by
// the purge job rather than only filtered on read. Both are optional -- older
// two-arg callers still work, they just write untagged, never-expiring rows.
// The retention columns are added by a migration that is applied BY HAND (this
// repo has no migration runner), so the code must not assume they exist yet:
// without this fallback, deploying before running the migration would make
// every cache write fail -- and some callers treat a failed write as "no
// keywords found" rather than surfacing it. Latched per-process so the
// fallback costs one wasted round-trip, not one per write.
let cacheHasRetentionColumns = true;

function isUnknownColumn(error) {
  // Postgres undefined_column.
  return error && (error.code === '42703'
    || /column .* does not exist/i.test(error.message || ''));
}

async function cacheSet(key, value, opts = {}) {
  const base = {
    id: key,
    data: { at: Date.now(), value },
    created_at: nowIso(),
    updated_at: nowIso(),
  };

  if (cacheHasRetentionColumns) {
    try {
      await db.query(
        `insert into "cache" (id, data, created_at, updated_at, kind, expires_at)
           values ($1, $2, $3, $4, $5, $6)
         on conflict (id) do update set
           data = excluded.data, created_at = excluded.created_at,
           updated_at = excluded.updated_at, kind = excluded.kind,
           expires_at = excluded.expires_at`,
        [
          base.id, db.json(base.data), base.created_at, base.updated_at,
          opts.kind || null,
          opts.ttlMs ? new Date(Date.now() + opts.ttlMs).toISOString() : null,
        ]
      );
      return;
    } catch (error) {
      if (!isUnknownColumn(error)) fail('cacheSet', 'cache', error);
      cacheHasRetentionColumns = false;
      console.warn('[recordStore] cache.kind/expires_at missing - apply migration 0009; '
        + 'writing without retention metadata until then.');
    }
  }

  try {
    await db.query(
      `insert into "cache" (id, data, created_at, updated_at) values ($1, $2, $3, $4)
         on conflict (id) do update set
           data = excluded.data, created_at = excluded.created_at, updated_at = excluded.updated_at`,
      [base.id, db.json(base.data), base.created_at, base.updated_at]
    );
  } catch (error) {
    fail('cacheSet', 'cache', error);
  }
}

// Physically delete cache rows that no reader could still use. Two passes:
//   1. anything with an expires_at in the past;
//   2. legacy/untagged rows whose payload timestamp is older than maxAgeMs.
// Pass 2 is what finally clears rows orphaned by a hand-bumped key prefix
// (e.g. 'dental-kw-adapter-v7' after the bump to v8) -- they have no expiry and
// are unreachable, so they would otherwise sit in the table forever. Default
// floor is the longest TTL in the app (180d), so a row older than that is
// unusable to every reader regardless of which TTL it was written under.
async function purgeExpired({ maxAgeMs = 180 * 24 * 60 * 60 * 1000 } = {}) {
  let expired = 0;
  try {
    const r = await db.query(
      `delete from "cache" where expires_at is not null and expires_at < $1`, [nowIso()]);
    expired = r.rowCount || 0;
  } catch (error) {
    // Nothing to purge until the retention migration has been applied.
    if (isUnknownColumn(error)) return { expired: 0, stale: 0, skipped: true };
    fail('purgeExpired', 'cache', error);
  }

  // created_at is rewritten on every upsert (see cacheSet), so age has to come
  // from the payload's own `at` stamp.
  const cutoff = Date.now() - maxAgeMs;
  let stale = 0;
  try {
    const r = await db.query(
      `delete from "cache" where expires_at is null and (data->'at')::numeric < $1`, [cutoff]);
    stale = r.rowCount || 0;
  } catch (error) {
    fail('purgeExpired', 'cache', error);
  }

  return { expired, stale };
}

function cacheKey(...parts) {
  const raw = parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join('|');
  return crypto.createHash('sha1').update(raw).digest('hex');
}

// ── Key/value settings (shared) ──────────────────────────────────────────────
// Backed by the `settings` table: key text pk, value jsonb, updated_at.

async function getSetting(key, fallback = null) {
  try {
    const row = await db.maybeOne(`select value from "settings" where key = $1`, [key]);
    return row ? row.value : fallback;
  } catch (error) {
    fail('getSetting', 'settings', error);
  }
}

async function setSetting(key, value) {
  try {
    await db.query(
      `insert into "settings" (key, value, updated_at) values ($1, $2, $3)
         on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at`,
      [key, db.json(value), nowIso()]
    );
  } catch (error) {
    fail('setSetting', 'settings', error);
  }
  return value;
}

module.exports = {
  newId, nowIso,
  list, get, findOne,
  insert, update, remove, upsertBy, upsertById, replaceAll, removeWhere,
  cacheGet, cacheSet, cacheKey, purgeExpired,
  getSetting, setSetting,
};
