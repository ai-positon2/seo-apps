// ── Generic Supabase-backed store adapter ────────────────────────────────────
// Mirrors the JSON file-store API used across the app (see
// locationPageBuilder/store.js and modules/*/store.js) so each module's store
// can be reimplemented on top of Supabase with NO change to its exported
// function names, route handlers, or client code.
//
// Table convention: every collection maps to a table with the columns
//   id text primary key, data jsonb not null,
//   created_at timestamptz default now(), updated_at timestamptz default now()
// The FULL record lives in `data` (so record shape is identical to the old
// JSON files); id/created_at/updated_at are mirrored to columns for primary
// key, ordering, and expression-indexed filters (e.g. data->>'project_id').

const crypto = require('crypto');
const { getSupabase } = require('./supabase');

function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

function nowIso() {
  return new Date().toISOString();
}

function fail(op, table, error) {
  throw new Error(`[supabaseStore.${op} ${table}] ${error.message || error}`);
}

// ── Reads ────────────────────────────────────────────────────────────────────

// filter: shallow equality on record fields (matched via data->>key).
// opts.order: { column: 'created_at', ascending: true } (default), or a field
//   inside data via { field: 'name', ascending: true }. opts.limit caps rows.
async function list(table, filter = {}, opts = {}) {
  let q = getSupabase().from(table).select('data');
  for (const [k, v] of Object.entries(filter)) {
    if (v === undefined || v === null) continue;
    q = q.eq(`data->>${k}`, String(v));
  }
  const ascending = opts.ascending !== undefined ? opts.ascending : true;
  if (opts.orderField) {
    q = q.order(`data->>${opts.orderField}`, { ascending });
  } else {
    q = q.order(opts.orderColumn || 'created_at', { ascending });
  }
  if (opts.limit) q = q.limit(opts.limit);
  const { data, error } = await q;
  if (error) fail('list', table, error);
  return data.map(r => r.data);
}

async function get(table, id) {
  const { data, error } = await getSupabase()
    .from(table).select('data').eq('id', id).maybeSingle();
  if (error) fail('get', table, error);
  return data ? data.data : null;
}

async function findOne(table, filter) {
  const rows = await list(table, filter, { limit: 1 });
  return rows[0] || null;
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

async function insert(table, data, idPrefix) {
  const record = {
    id: data.id || newId(idPrefix || table.slice(0, 3)),
    created_at: data.created_at || nowIso(),
    updated_at: nowIso(),
    ...data,
  };
  // ensure id/timestamps are the canonical ones even if data omitted/overrode
  record.id = data.id || record.id;
  record.created_at = data.created_at || record.created_at;
  record.updated_at = nowIso();
  const { error } = await getSupabase().from(table).insert(rowFor(record));
  if (error) fail('insert', table, error);
  return record;
}

async function update(table, id, patch) {
  const existing = await get(table, id);
  if (!existing) return null;
  const record = { ...existing, ...patch, id, updated_at: nowIso() };
  const { error } = await getSupabase().from(table).update(rowFor(record)).eq('id', id);
  if (error) fail('update', table, error);
  return record;
}

async function remove(table, id) {
  const { error, count } = await getSupabase()
    .from(table).delete({ count: 'exact' }).eq('id', id);
  if (error) fail('remove', table, error);
  return (count || 0) > 0;
}

// Race-free write for records whose id is a deterministic function of their
// natural key. upsertBy below does a read-then-write, so two concurrent writers
// can both see "no existing row" and each insert one -- producing duplicates
// that later reads then pick between arbitrarily. A single upsert on the
// primary key makes concurrent writers converge on ONE row instead.
async function upsertById(table, data, idPrefix) {
  const id = data.id || newId(idPrefix || table.slice(0, 3));
  // Best-effort: keep the original creation time rather than resetting it on
  // every save. A lost race here only mis-stamps created_at, never duplicates.
  let created_at = data.created_at;
  if (!created_at) {
    const existing = await get(table, id);
    created_at = existing?.created_at || nowIso();
  }
  const record = { ...data, id, created_at, updated_at: nowIso() };
  const { error } = await getSupabase().from(table).upsert(rowFor(record), { onConflict: 'id' });
  if (error) fail('upsertById', table, error);
  return record;
}

// Upsert by a natural key (idempotent seeding / caches keyed by a field).
async function upsertBy(table, keyField, data, idPrefix) {
  const existing = await findOne(table, { [keyField]: data[keyField] });
  if (!existing) return insert(table, data, idPrefix);
  return update(table, existing.id, data);
}

// Replace an entire collection with exactly the given rows.
async function replaceAll(table, rows, idPrefix) {
  const stamped = rows.map(r => ({
    id: r.id || newId(idPrefix || table.slice(0, 3)),
    created_at: r.created_at || nowIso(),
    updated_at: nowIso(),
    ...r,
  }));
  const sb = getSupabase();
  // wipe then bulk insert (neq on a value no id ever takes = delete all)
  const del = await sb.from(table).delete().neq('id', '__never__');
  if (del.error) fail('replaceAll(clear)', table, del.error);
  if (stamped.length) {
    const ins = await sb.from(table).insert(stamped.map(rowFor));
    if (ins.error) fail('replaceAll(insert)', table, ins.error);
  }
  return stamped;
}

// Delete every row matching a filter (e.g. all children of a parent id).
async function removeWhere(table, filter = {}) {
  let q = getSupabase().from(table).delete({ count: 'exact' });
  for (const [k, v] of Object.entries(filter)) {
    q = q.eq(`data->>${k}`, String(v));
  }
  const { error, count } = await q;
  if (error) fail('removeWhere', table, error);
  return count || 0;
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
  // PostgREST schema-cache miss (PGRST204) / Postgres undefined_column (42703).
  return error && (error.code === 'PGRST204' || error.code === '42703'
    || /column .* does not exist|Could not find the '.*' column/i.test(error.message || ''));
}

async function cacheSet(key, value, opts = {}) {
  const sb = getSupabase();
  const base = {
    id: key,
    data: { at: Date.now(), value },
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  const withRetention = {
    ...base,
    kind: opts.kind || null,
    expires_at: opts.ttlMs ? new Date(Date.now() + opts.ttlMs).toISOString() : null,
  };

  if (cacheHasRetentionColumns) {
    const { error } = await sb.from('cache').upsert(withRetention, { onConflict: 'id' });
    if (!error) return;
    if (!isUnknownColumn(error)) fail('cacheSet', 'cache', error);
    cacheHasRetentionColumns = false;
    console.warn('[supabaseStore] cache.kind/expires_at missing - apply migration 0009; '
      + 'writing without retention metadata until then.');
  }

  const { error } = await sb.from('cache').upsert(base, { onConflict: 'id' });
  if (error) fail('cacheSet', 'cache', error);
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
  const sb = getSupabase();

  const expired = await sb.from('cache').delete({ count: 'exact' })
    .not('expires_at', 'is', null).lt('expires_at', nowIso());
  // Nothing to purge until the retention migration has been applied.
  if (expired.error && isUnknownColumn(expired.error)) return { expired: 0, stale: 0, skipped: true };
  if (expired.error) fail('purgeExpired', 'cache', expired.error);

  // created_at is rewritten on every upsert (see cacheSet), so age has to come
  // from the payload's own `at` stamp.
  const cutoff = Date.now() - maxAgeMs;
  const stale = await sb.from('cache').delete({ count: 'exact' })
    .is('expires_at', null).lt('data->at', cutoff);
  if (stale.error) fail('purgeExpired', 'cache', stale.error);

  return { expired: expired.count || 0, stale: stale.count || 0 };
}

function cacheKey(...parts) {
  const raw = parts.map(p => (typeof p === 'string' ? p : JSON.stringify(p))).join('|');
  return crypto.createHash('sha1').update(raw).digest('hex');
}

// ── Key/value settings (shared) ──────────────────────────────────────────────
// Backed by the `settings` table: key text pk, value jsonb, updated_at.

async function getSetting(key, fallback = null) {
  const { data, error } = await getSupabase()
    .from('settings').select('value').eq('key', key).maybeSingle();
  if (error) fail('getSetting', 'settings', error);
  return data ? data.value : fallback;
}

async function setSetting(key, value) {
  const { error } = await getSupabase()
    .from('settings').upsert({ key, value, updated_at: nowIso() }, { onConflict: 'key' });
  if (error) fail('setSetting', 'settings', error);
  return value;
}

module.exports = {
  newId, nowIso,
  list, get, findOne,
  insert, update, remove, upsertBy, upsertById, replaceAll, removeWhere,
  cacheGet, cacheSet, cacheKey, purgeExpired,
  getSetting, setSetting,
};
