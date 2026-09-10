// ── Location Page Builder persistence — backed by Postgres ───────────────────
// Was JSON files on disk; now delegates to the shared record store adapter.
// The public API (list/get/findOne/insert/update/remove/upsertBy/replaceAll +
// cache*) is unchanged, so routes and the seeder need no changes. Each
// collection maps to a table named `lpb_<lowercased collection>` (see
// supabase/migrations/0026_lpb_collections.sql).
//
// That pointer used to read 0001_init.sql, which does not exist in this repo
// and never did — so these tables were absent from every database built from
// these migrations, and the module died on its first read until 0026 created
// them. Note that tableFor() below builds the names at runtime, so a grep for
// a literal table name finds nothing; 0026's header explains what that cost us.

const crypto = require('crypto');
const config = require('./config');
const store = require('../services/recordStore');

const ROOT = config.dataRoot; // kept for backward-compat exports (unused for IO)

// Top-level collections (L1/L2 reference data + pages).
const COLLECTIONS = [
  'clients', 'globalTemplates', 'services', 'locations', 'providers',
  'reviews', 'insuranceSets', 'resources', 'toneProfiles', 'pages',
  // Approved primary/secondary keywords, saved the moment they're approved
  // (not just when a page is generated) -> lpb_keywordselections.
  'keywordSelections',
];

function tableFor(collection) {
  return `lpb_${String(collection).toLowerCase()}`;
}

function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

function nowIso() {
  return new Date().toISOString();
}

// ── Generic CRUD (delegates to the record store adapter) ─────────────────────

async function list(collection, filter = {}) {
  return store.list(tableFor(collection), filter);
}

async function get(collection, id) {
  return store.get(tableFor(collection), id);
}

async function findOne(collection, filter) {
  return store.findOne(tableFor(collection), filter);
}

async function insert(collection, data, idPrefix) {
  return store.insert(tableFor(collection), data, idPrefix || collection.slice(0, 3));
}

async function update(collection, id, patch) {
  return store.update(tableFor(collection), id, patch);
}

async function remove(collection, id) {
  return store.remove(tableFor(collection), id);
}

async function replaceAll(collection, rows) {
  return store.replaceAll(tableFor(collection), rows, collection.slice(0, 3));
}

// Deterministic-id upsert: safe against concurrent writes for the same record
// (see recordStore.upsertById).
async function upsertById(collection, data, idPrefix) {
  return store.upsertById(tableFor(collection), data, idPrefix || collection.slice(0, 3));
}

async function upsertBy(collection, keyField, data, idPrefix) {
  return store.upsertBy(tableFor(collection), keyField, data, idPrefix || collection.slice(0, 3));
}

async function removeWhere(collection, filter) {
  return store.removeWhere(tableFor(collection), filter);
}

// Replace only the rows belonging to one client, leaving other clients'
// rows in the same (shared) table untouched. Use this instead of
// `replaceAll` for any multi-client collection (services/locations/etc.) —
// `replaceAll` wipes the WHOLE table, which would delete every other
// client's rows too.
async function replaceAllForClient(collection, clientId, rows) {
  await removeWhere(collection, { client_id: clientId });
  const inserted = [];
  for (const row of rows) {
    inserted.push(await insert(collection, row, collection.slice(0, 3)));
  }
  return inserted;
}

// ── Cache (Spec §14): keyed JSON blobs with TTL ──────────────────────────────

const cacheGet = (key, ttlMs) => store.cacheGet(key, ttlMs);
const cacheSet = (key, value, opts) => store.cacheSet(key, value, opts);
const cacheKey = (...parts) => store.cacheKey(...parts);

// Best-effort variants. The underlying cache is database-backed and THROWS
// when the database isn't configured (recordStore.fail), and call sites
// typically read the cache OUTSIDE the try/catch that guards their expensive
// work — so an unwrapped miss propagates and kills the whole run over a cache
// outage. Every caller that treats caching as an optimization rather than a
// requirement should use these instead of hand-rolling the same try/catch.
const cacheGetSafe = async (key, ttlMs) => {
  try { return await cacheGet(key, ttlMs); } catch { return null; }
};
const cacheSetSafe = async (key, value, opts) => {
  try { await cacheSet(key, value, opts); } catch { /* non-fatal */ }
};

module.exports = {
  ROOT, COLLECTIONS, newId, nowIso,
  list, get, findOne, insert, update, remove, upsertBy, upsertById, replaceAll,
  removeWhere, replaceAllForClient,
  cacheGet, cacheSet, cacheKey, cacheGetSafe, cacheSetSafe,
};
