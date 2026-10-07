// ── Healthcare Market Potential — API routes (Beta) ───────────────────────────
// User flow (Section 3):
//   1. Enter home market(s) + service → geo resolve + load/propose basket
//   2. Agent suggests adjacent regions (pure geometry)
//   3. User curates (approve / remove / add — each add re-resolved, same geo unit)
//   4. Fetch + rank (cache-first), index to home = 100, render table + map

const express = require('express');
const crypto = require('crypto');
const router = express.Router();

// Express 4 does not pass a rejected handler promise to next(), and this router
// registers no error middleware, so an unguarded throw wrote no response at all
// and the request hung until the client timed out — logged by server.js's
// process-level unhandledRejection handler, which is why it never looked like a
// fault. Reachable here through the provider clients (SEMrush / DataForSEO) and
// through the store's writes under MARKET_POTENTIAL_DATA_ROOT, which
// services/dataRoot.js warns is ephemeral inside a container image.
//
// Same shape as routes/lsPages.js, modules/crawlScope/api/routes.js,
// modules/contentArchitect/routes.js and modules/competitorAnalysis/routes.js.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch((e) => {
  console.error(`[marketPotential] ${req.method} ${req.originalUrl} failed:`, e.message);
  if (!res.headersSent) res.status(500).json({ error: 'Something went wrong handling that request.' });
});

const store = require('./store');
const geo = require('./geoData');
const { proposeBasket } = require('./basketAgent');
const { suggestAdjacent, buildComparison } = require('./ranking');
const { getProvider, unitTrackingActive } = require('./provider');
const { makeClassifier } = require('./competitorTaxonomy');
const { generateSummary } = require('./summaryAgent');
const usage = require('./usageStore');

// Current refresh bucket — volume changes monthly, so cache keys on year-month.
function currentYearMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// Max candidate regions a user may add to one comparison. Bounds worst-case API
// spend per run regardless of how large the metro pool is.
function maxCompareRegions() {
  return Math.max(1, parseInt(process.env.MP_MAX_COMPARE_REGIONS) || 10);
}

// ── Meta / status ──────────────────────────────────────────────────────────────

router.get('/meta', wrap(async (req, res) => {
  const provider = getProvider();
  const trackUnits = unitTrackingActive();
  const dataSource = provider.name === 'semrush'
    ? (provider.hasKey() ? 'semrush' : 'demo')
    : (provider.hasCredentials && provider.hasCredentials() ? 'dataforseo' : 'demo');
  res.json({
    dataSource,
    method: provider.name === 'semrush' ? 'templated' : 'geo-targeted',
    geoUnit: geo.GEO_UNIT,
    metroCount: geo.getAllGeos().length,
    maxCompareRegions: maxCompareRegions(),
    yearMonth: currentYearMonth(),
    units: trackUnits ? { enabled: true, ...(await usage.getStatus()) } : { enabled: false },
    // Density cost model so the client cost preview matches the server (Item 3).
    density: {
      enabled: provider.name === 'semrush' && trackUnits && Math.max(0, parseInt(process.env.MP_DENSITY_TERMS ?? '1')) > 0,
      terms: Math.max(0, parseInt(process.env.MP_DENSITY_TERMS ?? '1')),
      topN: Math.min(Math.max(parseInt(process.env.MP_DENSITY_TOPN) || 10, 1), 20),
    },
  });
}));

// Live usage snapshot — for the UI banner / cost preview after a run.
router.get('/usage', wrap(async (req, res) => {
  res.json({ enabled: unitTrackingActive(), ...(await usage.getStatus()) });
}));

// ── Geo resolution (Section 9) ────────────────────────────────────────────────
// Never auto-pick on ambiguity — return all candidates, the user confirms.

router.get('/geo/search', (req, res) => {
  const q = req.query.q || '';
  const candidates = geo.searchGeos(q).map((g) => ({
    id: g.id, displayName: g.displayName, geoUnit: g.geoUnit, population: g.population,
  }));
  res.json({ query: q, candidates });
});

router.get('/geo/all', (req, res) => {
  res.json({
    geoUnit: geo.GEO_UNIT,
    regions: geo.getAllGeos().map((g) => ({
      id: g.id, displayName: g.displayName, population: g.population,
      centroidLat: g.centroidLat, centroidLng: g.centroidLng,
    })),
  });
});

// ── Services + baskets (Sections 1.7, 8) ──────────────────────────────────────

// Load (or set up) a service + its basket. If a frozen basket exists → return it.
// Otherwise create the service, propose a draft via the agent, and return it for
// human approval. (Step 1.)
router.post('/service/resolve', async (req, res) => {
  try {
    const name = (req.body.service || '').trim();
    if (!name) return res.status(400).json({ error: 'service is required' });
    // Optional "your domain" (Phase 2) — persisted on the service for youRankHere.
    const ownDomain = typeof req.body.ownDomain === 'string' ? req.body.ownDomain.trim() : undefined;

    const service = await store.createService(name, ownDomain);
    const active = await store.getActiveBasket(service.id);
    if (active) {
      return res.json({ service, basket: active, basketState: 'active' });
    }

    let draft = await store.getDraftBasket(service.id);
    let source = 'existing-draft';
    if (!draft) {
      const proposed = await proposeBasket(name);
      draft = await store.saveDraftBasket(service.id, proposed.terms);
      source = proposed.source;
    }
    res.json({ service, basket: draft, basketState: 'draft', proposalSource: source });
  } catch (err) {
    console.error('[market-potential] service/resolve:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Re-propose a fresh draft (regenerate terms) for a service.
router.post('/service/:serviceId/basket/propose', async (req, res) => {
  try {
    const service = await store.getService(req.params.serviceId);
    if (!service) return res.status(404).json({ error: 'Service not found' });
    const proposed = await proposeBasket(service.name);
    const draft = await store.saveDraftBasket(service.id, proposed.terms);
    res.json({ basket: draft, proposalSource: proposed.source });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Save edits to the draft basket (human curation before freeze). Editing terms is
// what bumps the version on the next freeze (Section 8).
router.put('/service/:serviceId/basket/draft', async (req, res) => {
  try {
    const service = await store.getService(req.params.serviceId);
    if (!service) return res.status(404).json({ error: 'Service not found' });
    const terms = Array.isArray(req.body.terms) ? req.body.terms : [];
    if (!terms.length) return res.status(400).json({ error: 'terms array is required' });
    const draft = await store.saveDraftBasket(service.id, terms);
    res.json({ basket: draft });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Approve → freeze the draft at the next version (Section 8 freeze mechanism).
router.post('/service/:serviceId/basket/freeze', async (req, res) => {
  try {
    const service = await store.getService(req.params.serviceId);
    if (!service) return res.status(404).json({ error: 'Service not found' });
    const frozen = await store.freezeBasket(service.id);
    res.json({ basket: frozen, basketState: 'active' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── Adjacency suggestions (Section 10, Step 2) ────────────────────────────────

router.post('/adjacency', (req, res) => {
  try {
    const homeGeoIds = req.body.homeGeoIds || [];
    const homeGeos = homeGeoIds.map((id) => geo.getGeo(id)).filter(Boolean);
    if (!homeGeos.length) return res.status(400).json({ error: 'At least one valid home geo id is required' });

    const radiusMiles = Math.min(Math.max(parseInt(req.body.radiusMiles) || 350, 50), 1200);
    const limit = Math.min(Math.max(parseInt(req.body.limit) || 8, 1), 20);

    const suggestions = suggestAdjacent(homeGeos, geo.getAllGeos(), { radiusMiles, limit })
      .map((s) => ({
        id: s.geo.id, displayName: s.geo.displayName, population: s.geo.population,
        centroidLat: s.geo.centroidLat, centroidLng: s.geo.centroidLng,
        distanceMiles: s.distanceMiles,
      }));
    res.json({ radiusMiles, suggestions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Fetch + rank (Section 10, Step 4) ─────────────────────────────────────────
// Cache-first per (geo, year-month). One DataForSEO call per region covers the
// whole frozen basket (Section 5).

router.post('/compare', async (req, res) => {
  try {
    const { serviceId } = req.body;
    const homeGeoIds = req.body.homeGeoIds || [];
    const comparedGeoIds = req.body.comparedGeoIds || [];

    const service = await store.getService(serviceId);
    if (!service) return res.status(404).json({ error: 'Service not found' });

    // Cap candidate regions per run (bounds worst-case API spend).
    const maxCompare = maxCompareRegions();
    if (comparedGeoIds.length > maxCompare) {
      return res.status(400).json({
        error: `You can compare at most ${maxCompare} regions at once (received ${comparedGeoIds.length}). Remove some to continue.`,
        reason: 'too_many_regions', maxCompareRegions: maxCompare,
      });
    }

    const basket = await store.getActiveBasket(serviceId);
    if (!basket) return res.status(400).json({ error: 'No frozen basket for this service. Approve a basket first.' });

    const allIds = [...new Set([...homeGeoIds, ...comparedGeoIds])];
    const geos = allIds.map((id) => geo.getGeo(id)).filter(Boolean);
    if (!geos.length) return res.status(400).json({ error: 'No valid regions to compare' });

    // Hard rule (Decisions 5): every region must share the same geo unit.
    const units = new Set(geos.map((g) => g.geoUnit));
    if (units.size > 1) {
      return res.status(400).json({ error: `Mixed geo units in comparison (${[...units].join(', ')}). All regions must use the same unit.` });
    }

    const yearMonth = currentYearMonth();
    const provider = getProvider();
    const trackUnits = unitTrackingActive();

    // Rank only on un-templated terms (Method A / Decision 4). For SEMrush the
    // templated method only makes sense on those bare terms (it city-templates
    // them itself), so it fetches the rankable set; DataForSEO fetches everything.
    const rankableTerms = basket.terms.filter((t) => !t.isGeoTemplate);
    const fetchTerms = provider.name === 'semrush' ? rankableTerms : basket.terms;

    // Competitor density (Item 3). phrase_organic is the dominant unit cost, so we
    // query only a few HEAD terms per metro (MP_DENSITY_TERMS, default 1) × topN.
    const densityCfg = {
      terms: Math.max(0, parseInt(process.env.MP_DENSITY_TERMS ?? '1')),
      topN: Math.min(Math.max(parseInt(process.env.MP_DENSITY_TOPN) || 10, 1), 20),
    };
    const densityEnabled = provider.name === 'semrush' && provider.hasKey() && densityCfg.terms > 0;
    const densityTerms = densityEnabled ? rankableTerms.slice(0, densityCfg.terms) : [];

    // Cache-first: work out what each region still needs (volume and/or density).
    const cachedMap = {};
    const need = {};
    for (const g of geos) {
      const c = await store.getCachedRegion(g.id, yearMonth);
      cachedMap[g.id] = c || null;
      need[g.id] = {
        vol: !c || !c.terms,
        // Re-fetch density when the cached entry predates the domain-list feature
        // (has a count but no densityDomains array) so the domain drill-down works.
        dens: densityEnabled && !(c && c.densityFetched && Array.isArray(c.densityDomains)),
      };
    }

    // ── SEMrush unit caps (per-run 10k, daily 200k system-wide) ────────────────
    // Estimate is the upper bound. Per uncached region: volume = terms lines,
    // density = (headTerms × topN) lines. Reserve atomically; block whole run if over.
    const cfg = usage.config();
    const volLines = fetchTerms.length;
    const densLines = densityTerms.length * densityCfg.topN;
    let estimate = 0;
    if (trackUnits) {
      for (const g of geos) estimate += ((need[g.id].vol ? volLines : 0) + (need[g.id].dens ? densLines : 0)) * cfg.rate;
    }
    let reservation = null;
    if (trackUnits && estimate > 0) {
      const userId = req.user?.username || 'anon';
      const r = await usage.reserve({ userId, estimate, regions: geos.length });
      if (!r.ok) {
        if (r.reason === 'per_run') {
          return res.status(400).json({
            error: `This run needs ~${estimate.toLocaleString()} SEMrush units, over the ${r.perRunCap.toLocaleString()}/run limit. Reduce the number of regions or basket terms.`,
            reason: 'per_run', estimate, perRunCap: r.perRunCap,
          });
        }
        return res.status(429).json({
          error: `Daily SEMrush limit reached (${r.dailyUsed.toLocaleString()}/${r.dailyCap.toLocaleString()} units, ${r.dailyRemaining.toLocaleString()} left). This run needs ~${estimate.toLocaleString()}. Try again after the 00:00 UTC reset.`,
          reason: 'daily', estimate, dailyUsed: r.dailyUsed, dailyCap: r.dailyCap, dailyRemaining: r.dailyRemaining,
        });
      }
      reservation = r;
    }

    // ── Fetch (cache-first) + accumulate actual units ──────────────────────────
    let cacheHits = 0, apiCalls = 0, densityCalls = 0, actualUnits = 0;
    const regionData = [];
    try {
      for (const g of geos) {
        const entry = cachedMap[g.id] ? { ...cachedMap[g.id] } : {};
        if (need[g.id].vol) {
          const fresh = await provider.fetchRegionVolume(fetchTerms, g);
          await store.setCachedRegion(g.id, yearMonth, fresh.source, fresh.terms);
          entry.terms = fresh.terms; entry.source = fresh.source;
          apiCalls++;
          if (trackUnits) actualUnits += (fresh.linesReturned || 0) * cfg.rate;
        } else {
          cacheHits++;
        }
        if (need[g.id].dens) {
          const d = await provider.fetchCompetitorDensity(densityTerms, g, densityCfg.topN);
          await store.mergeCachedRegion(g.id, yearMonth, { density: d.count, densityDomains: d.domains || [], densityFetched: true });
          entry.density = d.count;
          entry.densityDomains = d.domains || [];
          densityCalls++;
          if (trackUnits) actualUnits += (d.linesReturned || 0) * cfg.rate;
        }
        regionData.push({
          geo: g,
          terms: entry.terms || {},
          source: entry.source || 'demo',
          density: entry.density == null ? null : entry.density,
          densityDomains: entry.densityDomains || [],
        });
      }
    } catch (fetchErr) {
      if (reservation) await usage.release(reservation); // give back the reservation
      throw fetchErr;
    }

    // Settle the reservation down to what was actually consumed.
    let usageAfter = null;
    if (reservation) {
      await usage.reconcile({ date: reservation.date, reservationId: reservation.reservationId, actual: actualUnits });
      usageAfter = await usage.getStatus();
    }

    const homeSet = new Set(homeGeoIds);
    // Classify density domains against the client's own site (Phase 2) → competitorBreakdown.
    const { rows, homeBase, warnings } = buildComparison(regionData, rankableTerms, homeSet, makeClassifier(service.ownDomain));
    const srcSet = new Set(regionData.map((r) => r.source));
    const dataSource = srcSet.has('semrush') ? 'semrush'
      : srcSet.has('dataforseo') ? 'dataforseo'
      : [...srcSet][0] || 'demo';

    res.json({
      service: { id: service.id, name: service.name, ownDomain: service.ownDomain || null },
      basketVersion: basket.version,
      yearMonth,
      dataSource,
      method: provider.name === 'semrush' ? 'templated' : 'geo-targeted',
      stats: {
        cacheHits, apiCalls, densityCalls, regions: geos.length,
        rankableTerms: rankableTerms.length, totalTerms: basket.terms.length,
        densityEnabled, densityTerms: densityTerms.length, densityTopN: densityCfg.topN,
        unitsEstimated: estimate, unitsUsed: actualUnits,
      },
      usage: usageAfter,
      homeBase,
      warnings: warnings || [],
      rows,
    });
  } catch (err) {
    console.error('[market-potential] compare:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Executive summary (Phase 3) — grounded, cached, deterministic fallback ────
// The client sends exactly the (scored) rows it rendered; we summarise them with
// OpenAI when a key exists, else a template. Cached by run signature so repeat
// views are free and never re-bill tokens.

router.post('/summary', async (req, res) => {
  try {
    const { serviceId, yearMonth, rows, weightsUsed } = req.body;
    if (!serviceId || !Array.isArray(rows) || !rows.length) {
      return res.status(400).json({ error: 'serviceId and a non-empty rows array are required' });
    }
    const service = await store.getService(serviceId);
    if (!service) return res.status(404).json({ error: 'Service not found' });

    const basket = await store.getActiveBasket(serviceId);
    const basketVersion = basket?.version ?? null;
    const homeRow = rows.find((r) => r.isHome);
    const homeName = (homeRow?.region || 'your home market').split(',')[0].trim();

    // Cache key: same run signature → same summary (spec §4.2).
    const geoIds = rows.map((r) => r.geoId).filter(Boolean).sort();
    const keyObj = { serviceId, basketVersion, yearMonth: yearMonth || null, geoIds, weights: weightsUsed || null };
    const hash = crypto.createHash('sha1').update(JSON.stringify(keyObj)).digest('hex').slice(0, 16);

    const cached = await store.getCachedSummary(hash);
    if (cached) return res.json({ summary: cached.summary, source: cached.source, cached: true });

    const { summary, source } = await generateSummary({ service: service.name, homeName, rows, weightsUsed });
    await store.setCachedSummary(hash, { summary, source });
    res.json({ summary, source, cached: false });
  } catch (err) {
    console.error('[market-potential] summary:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Scenarios (Section 7, M5) — save/version for reproducibility ──────────────

router.get('/scenarios', wrap(async (req, res) => {
  const userId = req.user?.username || 'anon';
  res.json({ scenarios: await store.getScenarios(userId) });
}));

router.post('/scenarios', async (req, res) => {
  try {
    const userId = req.user?.username || 'anon';
    const { name, serviceId, serviceName, basketVersion, homeGeoIds, comparedGeoIds, weightsUsed, assumptions, yearMonth } = req.body;
    if (!serviceId) return res.status(400).json({ error: 'serviceId is required' });
    const scenario = await store.saveScenario({
      userId, name, serviceId, serviceName, basketVersion, homeGeoIds, comparedGeoIds, weightsUsed, assumptions, yearMonth,
    });
    res.json({ scenario });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/scenarios/:id', wrap(async (req, res) => {
  const ok = await store.deleteScenario(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Scenario not found' });
  res.json({ ok: true });
}));

module.exports = router;
