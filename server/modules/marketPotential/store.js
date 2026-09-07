// ── File-based persistence (Section 7 schema) ─────────────────────────────────
// This app has no Postgres, so the Section 7 relational schema is mapped onto the
// same atomic-JSON store pattern used by the robotsMonitor / hubSpoke modules.
//
//   services.json     [{ id, name, status, createdAt }]
//   baskets.json      [{ id, serviceId, version, status, frozenAt, terms[] }]
//                     status: 'draft' (proposed, editable) | 'active' (frozen v_n)
//                     terms:  [{ id, term, intentTag, isGeoTemplate }]
//   volumeCache.json  { "<geoId>__<yearMonth>": { fetchedAt, source, terms: {
//                         "<term>": { searchVolume, cpc, competition, monthlySearches[] } } } }
//                     One row per (geo, month) — a single DataForSEO call covers the
//                     whole basket (Section 5), so the cache key is per region+month.
//   scenarios.json    [{ id, userId, name, serviceId, basketVersion,
//                         homeGeoIds[], comparedGeoIds[], createdAt }]
//
// geo_constants live in geoData.js (static seed), not here.

const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

const { resolveDataRoot } = require('../../services/dataRoot');

// Ephemeral inside the image on a container platform; see services/dataRoot.js.
const DATA_DIR = resolveDataRoot(
  'market-potential', path.join(__dirname, 'data'), 'MARKET_POTENTIAL_DATA_ROOT',
);
const SERVICES_PATH = path.join(DATA_DIR, 'services.json');
const BASKETS_PATH = path.join(DATA_DIR, 'baskets.json');
const CACHE_PATH = path.join(DATA_DIR, 'volumeCache.json');
const SCENARIOS_PATH = path.join(DATA_DIR, 'scenarios.json');
const SUMMARIES_PATH = path.join(DATA_DIR, 'summaries.json');

function genId(prefix = 'id') {
  return `${prefix}_${Date.now().toString(36)}${crypto.randomBytes(4).toString('hex')}`;
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function writeAtomic(filePath, data) {
  // Unique temp name so overlapping writes never collide on the same .tmp file.
  const tmp = `${filePath}.${process.pid}.${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  // Windows: renaming over an existing file transiently fails with EPERM/EBUSY
  // when AV / the search indexer briefly holds a handle on it — common under the
  // rapid successive writes the compare loop makes. Retry with short backoff.
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(tmp, filePath);
      return;
    } catch (err) {
      if (['EPERM', 'EBUSY', 'EACCES'].includes(err.code) && attempt < 10) {
        await sleep(20 * (attempt + 1));
        continue;
      }
      try { await fs.unlink(tmp); } catch { /* best effort */ }
      throw err;
    }
  }
}

// Serialize read-modify-write mutators so concurrent requests can't lose updates
// (and can't overlap renames on the same file).
let _writeChain = Promise.resolve();
function withWriteLock(fn) {
  const next = _writeChain.then(fn, fn);
  _writeChain = next.then(() => {}, () => {});
  return next;
}

async function init() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  for (const [p, init] of [
    [SERVICES_PATH, '[]'],
    [BASKETS_PATH, '[]'],
    [CACHE_PATH, '{}'],
    [SCENARIOS_PATH, '[]'],
    [SUMMARIES_PATH, '{}'],
  ]) {
    try { await fs.access(p); } catch { await fs.writeFile(p, init, 'utf8'); }
  }
}

// ── Services ───────────────────────────────────────────────────────────────────

async function getServices() {
  return readJson(SERVICES_PATH, []);
}

async function getService(id) {
  return (await getServices()).find((s) => s.id === id) || null;
}

async function findServiceByName(name) {
  const norm = (name || '').trim().toLowerCase();
  return (await getServices()).find((s) => s.name.trim().toLowerCase() === norm) || null;
}

async function createService(name, ownDomain) {
  const services = await getServices();
  const norm = (name || '').trim().toLowerCase();
  const existing = services.find((s) => s.name.trim().toLowerCase() === norm);
  if (existing) {
    // Update the stored own-domain when the caller supplies one (Phase 2).
    if (ownDomain !== undefined) {
      const next = ownDomain ? String(ownDomain).trim() : null;
      if (next !== (existing.ownDomain ?? null)) {
        existing.ownDomain = next;
        await writeAtomic(SERVICES_PATH, services);
      }
    }
    return existing;
  }
  const service = {
    id: genId('svc'), name: name.trim(),
    ownDomain: ownDomain ? String(ownDomain).trim() : null,
    status: 'active', createdAt: new Date().toISOString(),
  };
  services.push(service);
  await writeAtomic(SERVICES_PATH, services);
  return service;
}

// ── Keyword baskets ──────────────────────────────────────────────────────────
// Exactly one active (frozen) version per service. Drafts are editable.

async function getBaskets() {
  return readJson(BASKETS_PATH, []);
}

async function getBasket(id) {
  return (await getBaskets()).find((b) => b.id === id) || null;
}

async function getActiveBasket(serviceId) {
  const baskets = await getBaskets();
  return baskets
    .filter((b) => b.serviceId === serviceId && b.status === 'active')
    .sort((a, b) => b.version - a.version)[0] || null;
}

async function getDraftBasket(serviceId) {
  return (await getBaskets()).find((b) => b.serviceId === serviceId && b.status === 'draft') || null;
}

// Create / replace the draft for a service from a list of proposed terms.
async function saveDraftBasket(serviceId, terms) {
  const baskets = await getBaskets();
  const idx = baskets.findIndex((b) => b.serviceId === serviceId && b.status === 'draft');
  const normTerms = terms.map((t) => ({
    id: genId('term'),
    term: t.term,
    intentTag: t.intentTag || 'commercial-general',
    isGeoTemplate: !!t.isGeoTemplate,
  }));
  const draft = {
    id: idx >= 0 ? baskets[idx].id : genId('basket'),
    serviceId,
    version: null,        // assigned on freeze
    status: 'draft',
    frozenAt: null,
    terms: normTerms,
    createdAt: idx >= 0 ? baskets[idx].createdAt : new Date().toISOString(),
  };
  if (idx >= 0) baskets[idx] = draft; else baskets.push(draft);
  await writeAtomic(BASKETS_PATH, baskets);
  return draft;
}

// Freeze the draft → next version number; becomes the sole active basket.
async function freezeBasket(serviceId) {
  const baskets = await getBaskets();
  const draft = baskets.find((b) => b.serviceId === serviceId && b.status === 'draft');
  if (!draft) throw new Error('No draft basket to freeze for this service.');
  if (!draft.terms.length) throw new Error('Cannot freeze an empty basket.');

  const maxVersion = baskets
    .filter((b) => b.serviceId === serviceId && b.status === 'active')
    .reduce((m, b) => Math.max(m, b.version || 0), 0);

  draft.status = 'active';
  draft.version = maxVersion + 1;
  draft.frozenAt = new Date().toISOString();

  await writeAtomic(BASKETS_PATH, baskets);
  return draft;
}

// ── Volume cache ────────────────────────────────────────────────────────────

function cacheKey(geoId, yearMonth) {
  return `${geoId}__${yearMonth}`;
}

async function getCachedRegion(geoId, yearMonth) {
  const cache = await readJson(CACHE_PATH, {});
  return cache[cacheKey(geoId, yearMonth)] || null;
}

async function setCachedRegion(geoId, yearMonth, source, terms) {
  return withWriteLock(async () => {
    const cache = await readJson(CACHE_PATH, {});
    cache[cacheKey(geoId, yearMonth)] = { fetchedAt: new Date().toISOString(), source, terms };
    await writeAtomic(CACHE_PATH, cache);
  });
}

// Merge a partial patch (e.g. competitor density) into an existing cache entry
// without clobbering the volume payload. Used when density is fetched separately.
async function mergeCachedRegion(geoId, yearMonth, patch) {
  return withWriteLock(async () => {
    const cache = await readJson(CACHE_PATH, {});
    const key = cacheKey(geoId, yearMonth);
    cache[key] = { ...(cache[key] || {}), ...patch, fetchedAt: new Date().toISOString() };
    await writeAtomic(CACHE_PATH, cache);
  });
}

// Drop cached rows for a (geo, month) — used by the monthly refresh job.
// TODO (V2 §5.5): wire a monthly refresh scheduler that invalidates last month's
// cache on the 1st, following the robotsMonitor scheduler pattern. Not built here.
async function invalidateRegion(geoId, yearMonth) {
  return withWriteLock(async () => {
    const cache = await readJson(CACHE_PATH, {});
    delete cache[cacheKey(geoId, yearMonth)];
    await writeAtomic(CACHE_PATH, cache);
  });
}

// ── Scenarios ────────────────────────────────────────────────────────────────

async function getScenarios(userId) {
  const all = await readJson(SCENARIOS_PATH, []);
  return userId ? all.filter((s) => s.userId === userId) : all;
}

async function getScenario(id) {
  return (await readJson(SCENARIOS_PATH, [])).find((s) => s.id === id) || null;
}

async function saveScenario({ userId, name, serviceId, serviceName, basketVersion, homeGeoIds, comparedGeoIds, weightsUsed, assumptions, yearMonth }) {
  const scenarios = await readJson(SCENARIOS_PATH, []);
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
  scenarios.push(scenario);
  await writeAtomic(SCENARIOS_PATH, scenarios);
  return scenario;
}

async function deleteScenario(id) {
  const scenarios = await readJson(SCENARIOS_PATH, []);
  const next = scenarios.filter((s) => s.id !== id);
  await writeAtomic(SCENARIOS_PATH, next);
  return next.length !== scenarios.length;
}

// ── Executive-summary cache (Phase 3) ─────────────────────────────────────────
// Keyed by a hash of (service, basket version, region set, month, weights) so a
// repeat view of the same run is free. Bounded to keep the file small.

async function getCachedSummary(key) {
  const all = await readJson(SUMMARIES_PATH, {});
  return all[key] || null;
}

async function setCachedSummary(key, value) {
  return withWriteLock(async () => {
    const all = await readJson(SUMMARIES_PATH, {});
    all[key] = { ...value, at: new Date().toISOString() };
    const keys = Object.keys(all);
    if (keys.length > 500) delete all[keys[0]]; // FIFO bound
    await writeAtomic(SUMMARIES_PATH, all);
  });
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
