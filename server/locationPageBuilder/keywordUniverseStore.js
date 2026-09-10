// ── Keyword universe store — queries the imported bulk keyword list ─────────
// See supabase/migrations/0007_keyword_universe.sql for the table and
// server/scripts/importKeywordUniverse.js for how rows get in it.

const db = require('../services/db');
const recordStore = require('../services/recordStore');
const config = require('./config');
const { universeFilterFor } = require('./keywordUniverseMap');

const TABLE = 'lpb_keyword_universe';
const KNOWN_CITIES_SETTING_KEY = clientId => `ku-cities:${clientId}`;

function norm(s) {
  return String(s || '').toLowerCase().trim();
}

// True once a client has actually imported a universe (avoids a wasted query
// + a database-not-configured throw for clients that never will).
async function hasUniverse(clientId) {
  if (!db.isDatabaseConfigured()) return false;
  try {
    const n = await db.count(
      `select count(*) from ${TABLE} where client_id = $1`, [clientId]);
    return n > 0;
  } catch {
    return false;
  }
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
  const params = [clientId, norm(city), 'Implicit Local (Near Me)'];

  // Either an exact cluster match or a keyword pattern match, never both —
  // the same either/or the PostgREST .in()/.or() branch expressed here.
  let match;
  if (filter.clusters) {
    params.push(filter.clusters);
    match = `cluster = any($${params.length})`;
  } else {
    params.push(filter.keywordLike);
    match = `keyword_norm ilike any($${params.length})`;
  }

  // Highest search volume first, then capped. Without an explicit order the
  // rows Postgres returns are arbitrary, so the cap would silently pick a
  // different (and often worthless) 100 keywords on every run.
  params.push(limit || config.keywords.universePoolSize);
  const sql =
    `select * from ${TABLE}
      where client_id = $1 and geo_detected_norm = $2 and geo_type <> $3 and ${match}
      order by semrush_sv desc
      limit $${params.length}`;

  let rows;
  try {
    rows = await db.rows(sql, params);
  } catch (error) {
    throw new Error(`[keywordUniverseStore.getUniverseCandidates] ${error.message}`);
  }

  return rows.map(r => ({
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
  return recordStore.getSetting(KNOWN_CITIES_SETTING_KEY(clientId), []);
}

module.exports = { getUniverseCandidates, hasUniverse, getKnownCities, KNOWN_CITIES_SETTING_KEY };
