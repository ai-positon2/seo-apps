// ── Persistence (Section 7 schema) — backed by Postgres ──────────────────────
// This module's store opened with "This app has no Postgres, so the Section 7
// relational schema is mapped onto the same atomic-JSON store pattern used by
// the robotsMonitor / hubSpoke modules". It has one now, and the schema is
// where it was designed to go — see
// supabase/migrations/0036_market_potential_to_postgres.sql.
//
//   market_potential_services       was services.json
//   market_potential_baskets        was baskets.json
//   market_potential_volume_cache   was volumeCache.json  (one row per geo+month)
//   market_potential_scenarios      was scenarios.json
//   market_potential_summaries      was summaries.json
//
// geo_constants still live in geoData.js (static seed), not here.
//
// Every exported name, argument, return shape and thrown message is unchanged.
// The in-process write lock (withWriteLock) is gone: it existed to stop
// overlapping read-modify-write cycles losing each other's updates within ONE
// process, which is not the same as preventing it. Each mutator is now a single
// statement, and the two invariants the module states in prose — one draft
// basket per service, one active version per number — are unique indexes.

const crypto = require('crypto');
const db = require('../../services/db');

function genId(prefix = 'id') {
  return `${prefix}_${Date.now().toString(36)}${crypto.randomBytes(4).toString('hex')}`;
}

// Tables are created by the migration runner; nothing to make on boot.
async function init() {}

const nameKey = (name) => (name || '').trim().toLowerCase();

// ── Services ───────────────────────────────────────────────────────────────────

async function getServices() {
  const found = await db.rows(
    `select data from market_potential_services order by created_at asc, id asc`
  );
  return found.map((r) => r.data);
}

async function getService(id) {
  const row = await db.maybeOne(
    `select data from market_potential_services where id = $1`, [id]
  );
  return row ? row.data : null;
}

async function findServiceByName(name) {
  const row = await db.maybeOne(
    `select data from market_potential_services where name_key = $1`, [nameKey(name)]
  );
  return row ? row.data : null;
}

async function createService(name, ownDomain) {
  const key = nameKey(name);
  const next = ownDomain !== undefined && ownDomain ? String(ownDomain).trim() : null;

  const service = {
    id: genId('svc'),
    name: (name || '').trim(),
    ownDomain: next,
    status: 'active',
    createdAt: new Date().toISOString(),
  };

  // Insert-or-return-existing in one statement, on the unique name key. The
  // own-domain update keeps its Phase 2 rule: only when the caller supplied one.
  //
  // `do update` rather than `do nothing` because `do nothing` returns no row,
  // which would mean a second query to find out what is already there.
  const row = await db.one(
    `insert into market_potential_services (id, data, name_key, created_at, updated_at)
     values ($1, $2, $3, $4, $4)
     on conflict (name_key) do update set
       data = case
                when $5::boolean
                 and market_potential_services.data->>'ownDomain' is distinct from $6
                then jsonb_set(market_potential_services.data, '{ownDomain}', to_jsonb($6::text))
                else market_potential_services.data
              end,
       updated_at = now()
     returning data`,
    [
      service.id, db.json(service), key, service.createdAt,
      ownDomain !== undefined, next,
    ]
  );
  return row.data;
}

// ── Keyword baskets ──────────────────────────────────────────────────────────
// Exactly one active (frozen) version per service. Drafts are editable.

async function getBaskets() {
  const found = await db.rows(
    `select data from market_potential_baskets order by created_at asc, id asc`
  );
  return found.map((r) => r.data);
}

async function getBasket(id) {
  const row = await db.maybeOne(
    `select data from market_potential_baskets where id = $1`, [id]
  );
  return row ? row.data : null;
}

async function getActiveBasket(serviceId) {
  const row = await db.maybeOne(
    `select data from market_potential_baskets
      where service_id = $1 and status = 'active'
      order by version desc nulls last
      limit 1`,
    [serviceId]
  );
  return row ? row.data : null;
}

async function getDraftBasket(serviceId) {
  const row = await db.maybeOne(
    `select data from market_potential_baskets
      where service_id = $1 and status = 'draft'`,
    [serviceId]
  );
  return row ? row.data : null;
}

// Create / replace the draft for a service from a list of proposed terms.
async function saveDraftBasket(serviceId, terms) {
  const normTerms = terms.map((t) => ({
    id: genId('term'),
    term: t.term,
    intentTag: t.intentTag || 'commercial-general',
    isGeoTemplate: !!t.isGeoTemplate,
  }));

  const existing = await getDraftBasket(serviceId);
  const draft = {
    id: existing ? existing.id : genId('basket'),
    serviceId,
    version: null,        // assigned on freeze
    status: 'draft',
    frozenAt: null,
    terms: normTerms,
    createdAt: existing ? existing.createdAt : new Date().toISOString(),
  };

  // Keyed on the draft's own id, so replacing a draft replaces that row rather
  // than racing the partial unique index on (service_id) where status='draft'.
  const row = await db.one(
    `insert into market_potential_baskets
       (id, service_id, status, version, data, created_at, updated_at)
     values ($1, $2, 'draft', null, $3, $4, now())
     on conflict (id) do update set
       data = excluded.data, updated_at = now()
     returning data`,
    [draft.id, serviceId, db.json(draft), draft.createdAt]
  );
  return row.data;
}

// Freeze the draft → next version number; becomes the sole active basket.
async function freezeBasket(serviceId) {
  const draft = await getDraftBasket(serviceId);
  if (!draft) throw new Error('No draft basket to freeze for this service.');
  if (!draft.terms.length) throw new Error('Cannot freeze an empty basket.');

  // max(version)+1 and the write are ONE statement. Two freezes arriving
  // together used to be able to read the same maximum and both claim it; now
  // the second either sees the first's row in its subquery or collides with
  // uq_market_potential_baskets_version.
  const frozenAt = new Date().toISOString();
  const row = await db.one(
    `update market_potential_baskets
        set status = 'active',
            version = (
              select coalesce(max(version), 0) + 1
                from market_potential_baskets
               where service_id = $1 and status = 'active'
            ),
            data = data
                   || jsonb_build_object('status', 'active', 'frozenAt', $2::text)
                   || jsonb_build_object('version', (
                        select coalesce(max(version), 0) + 1
                          from market_potential_baskets
                         where service_id = $1 and status = 'active'
                      )),
            updated_at = now()
      where id = $3 and status = 'draft'
    returning data`,
    [serviceId, frozenAt, draft.id]
  );
  return row.data;
}

// ── Volume cache ────────────────────────────────────────────────────────────

function cacheKey(geoId, yearMonth) {
  return `${geoId}__${yearMonth}`;
}

async function getCachedRegion(geoId, yearMonth) {
  const row = await db.maybeOne(
    `select data from market_potential_volume_cache where id = $1`,
    [cacheKey(geoId, yearMonth)]
  );
  return row ? row.data : null;
}

async function setCachedRegion(geoId, yearMonth, source, terms) {
  const entry = { fetchedAt: new Date().toISOString(), source, terms };
  await db.query(
    `insert into market_potential_volume_cache (id, data, fetched_at)
     values ($1, $2, now())
     on conflict (id) do update set data = excluded.data, fetched_at = now()`,
    [cacheKey(geoId, yearMonth), db.json(entry)]
  );
}

// Merge a partial patch (e.g. competitor density) into an existing cache entry
// without clobbering the volume payload. Used when density is fetched separately.
async function mergeCachedRegion(geoId, yearMonth, patch) {
  const merged = { ...patch, fetchedAt: new Date().toISOString() };
  await db.query(
    `insert into market_potential_volume_cache (id, data, fetched_at)
     values ($1, $2, now())
     on conflict (id) do update set
       data = market_potential_volume_cache.data || $2::jsonb,
       fetched_at = now()`,
    [cacheKey(geoId, yearMonth), db.json(merged)]
  );
}

// Drop cached rows for a (geo, month) — used by the monthly refresh job.
// TODO (V2 §5.5): wire a monthly refresh scheduler that invalidates last month's
// cache on the 1st, following the robotsMonitor scheduler pattern. Not built here.
async function invalidateRegion(geoId, yearMonth) {
  await db.query(
    `delete from market_potential_volume_cache where id = $1`,
    [cacheKey(geoId, yearMonth)]
  );
}

// ── Scenarios ────────────────────────────────────────────────────────────────

async function getScenarios(userId) {
  const found = userId
    ? await db.rows(
      `select data from market_potential_scenarios
        where user_id = $1 order by created_at asc, id asc`, [userId])
    : await db.rows(
      `select data from market_potential_scenarios order by created_at asc, id asc`);
  return found.map((r) => r.data);
}

async function getScenario(id) {
  const row = await db.maybeOne(
    `select data from market_potential_scenarios where id = $1`, [id]
  );
  return row ? row.data : null;
}

async function saveScenario({ userId, name, serviceId, serviceName, basketVersion, homeGeoIds, comparedGeoIds, weightsUsed, assumptions, yearMonth }) {
  const scenario = {
    id: genId('scn'),
    userId: userId || 'anon',
    name: name || 'Untitled scenario',
    serviceId,
    serviceName: serviceName || null,   // convenience for the list/reload (Phase 4)
    basketVersion: basketVersion ?? null,
    homeGeoIds: homeGeoIds || [],
    comparedGeoIds: comparedGeoIds || [],
    weightsUsed: weightsUsed || null,   // reproduce the exact ranking on reload
    assumptions: assumptions || null,   // reproduce the dollar model on reload
    yearMonth: yearMonth || null,       // month the run was saved in → cold-fetch guard
    createdAt: new Date().toISOString(),
  };
  await db.query(
    `insert into market_potential_scenarios (id, user_id, data, created_at)
     values ($1, $2, $3, $4)`,
    [scenario.id, scenario.userId, db.json(scenario), scenario.createdAt]
  );
  return scenario;
}

async function deleteScenario(id) {
  const result = await db.query(
    `delete from market_potential_scenarios where id = $1`, [id]
  );
  return result.rowCount > 0;
}

// ── Executive-summary cache (Phase 3) ─────────────────────────────────────────
// Keyed by a hash of (service, basket version, region set, month, weights) so a
// repeat view of the same run is free. Bounded to keep the table small.

async function getCachedSummary(key) {
  const row = await db.maybeOne(
    `select data from market_potential_summaries where key = $1`, [key]
  );
  return row ? row.data : null;
}

async function setCachedSummary(key, value) {
  const entry = { ...value, at: new Date().toISOString() };
  await db.query(
    `insert into market_potential_summaries (key, data)
     values ($1, $2)
     on conflict (key) do update set data = excluded.data, created_at = now()`,
    [key, db.json(entry)]
  );
  // Same 500-entry bound as the file version, but it evicts the OLDEST rather
  // than whichever key happened to come first in JSON object order.
  await db.query(
    `delete from market_potential_summaries
      where key in (
        select key from market_potential_summaries
         order by created_at desc, key desc
         offset 500
      )`
  );
}

module.exports = {
  init,
  // services
  getServices, getService, findServiceByName, createService,
  // baskets
  getBaskets, getBasket, getActiveBasket, getDraftBasket, saveDraftBasket, freezeBasket,
  // cache
  getCachedRegion, setCachedRegion, mergeCachedRegion, invalidateRegion,
  // scenarios
  getScenarios, getScenario, saveScenario, deleteScenario,
  // summaries
  getCachedSummary, setCachedSummary,
};
