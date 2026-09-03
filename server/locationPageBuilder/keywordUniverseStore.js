// ── Keyword universe store — queries the imported bulk keyword list ─────────
// See supabase/migrations/0007_keyword_universe.sql for the table and
// server/scripts/importKeywordUniverse.js for how rows get in it.

const { getSupabase, isSupabaseConfigured } = require('../services/supabase');
const supabaseStore = require('../services/supabaseStore');
const config = require('./config');
const { universeFilterFor } = require('./keywordUniverseMap');

const TABLE = 'lpb_keyword_universe';
const KNOWN_CITIES_SETTING_KEY = clientId => `ku-cities:${clientId}`;

function norm(s) {
  return String(s || '').toLowerCase().trim();
}

// True once a client has actually imported a universe (avoids a wasted query
// + a Supabase-not-configured throw for clients that never will).
async function hasUniverse(clientId) {
  if (!isSupabaseConfigured()) return false;
  const { count, error } = await getSupabase()
    .from(TABLE).select('id', { count: 'exact', head: true }).eq('client_id', clientId);
  if (error) return false;
  return (count || 0) > 0;
}

// Returns CandidateShape rows ({ keyword, volume, difficulty, intent, source })
// for a given client+service+city, matched via the static Cluster/Pillar map
// (see keywordUniverseMap.js) plus the city (or the geo-unspecific '-' rows,
// which apply to every location).
async function getUniverseCandidates({ clientId, serviceSlug, city, limit }) {
  const filter = universeFilterFor(serviceSlug);
  if (!filter || !clientId) return [];
  if (!(await hasUniverse(clientId))) return [];

  // Location-specific rows only — "near me"/implicit-local rows (Geo
  // Detected '-') are excluded on purpose (client wants city-tied keywords,
  // not generic near-me phrasing, even at the cost of lower volume).
  let q = getSupabase().from(TABLE).select('*').eq('client_id', clientId)
    .eq('geo_detected_norm', norm(city)).neq('geo_type', 'Implicit Local (Near Me)');
  q = filter.clusters
    ? q.in('cluster', filter.clusters)
    : q.or(filter.keywordLike.map(p => `keyword_norm.ilike.${p}`).join(','));

  // Highest search volume first, then capped. Without an explicit order the
  // rows Postgres returns are arbitrary, so the cap would silently pick a
  // different (and often worthless) 100 keywords on every run.
  const { data, error } = await q
    .order('semrush_sv', { ascending: false })
    .limit(limit || config.keywords.universePoolSize);
  if (error) throw new Error(`[keywordUniverseStore.getUniverseCandidates] ${error.message}`);

  return data.map(r => ({
    keyword: r.keyword,
    volume: r.semrush_sv || 0,
    difficulty: 0,
    source: 'universe',
  }));
}

// Every city the imported universe knows about (captured at import time —
// see importKeywordUniverse.js) — a richer place-name vocabulary than just
// this client's own office cities, used to exclude a competitor's
// other-city keywords from the live SERP+SEMrush pull.
async function getKnownCities(clientId) {
  if (!clientId) return [];
  return supabaseStore.getSetting(KNOWN_CITIES_SETTING_KEY(clientId), []);
}

module.exports = { getUniverseCandidates, hasUniverse, getKnownCities, KNOWN_CITIES_SETTING_KEY };
