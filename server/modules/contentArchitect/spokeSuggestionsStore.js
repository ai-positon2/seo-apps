// ── Suggested spokes, durably — in Postgres, not the file store ────────────
//
// server/modules/contentArchitect/store.js keeps the rest of a project's state
// as JSON on disk (see server/services/dataRoot.js) — fine for most of it, but
// a suggestion here spends real money (a SEMrush unit, a search API call, an
// LLM call) to produce, so losing it to a redeploy or a misconfigured volume
// is a bill paid twice. This table is the durable copy: routes.js still writes
// the result onto the file-backed full analysis too (so an environment with no
// database configured keeps working exactly as before), but this is now the
// source of truth GET /full-analysis merges back in — see mergeInto below.
//
// project_id is a contentArchitect store id (e.g. "proj_..."), not a Postgres
// row, so it is stored as plain text with no foreign key, same relationship
// crawl_run_results has to crawl_runs.

const db = require('../../services/db');

const TABLE = 'content_architect_spoke_suggestions';

/** True when the schema (migration 0029) has not been applied yet. */
function isMissingTable(error) {
  return error?.code === '42P01' || /relation .* does not exist/i.test(error?.message || '');
}

/** All persisted suggestions for a project, as { [clusterId]: payload }. */
async function getSpokeSuggestions(projectId) {
  if (!db.isDatabaseConfigured()) return {};
  let found;
  try {
    found = await db.rows(
      `select cluster_id, payload from ${TABLE} where project_id = $1`,
      [projectId],
    );
  } catch (error) {
    if (isMissingTable(error)) return {};
    throw new Error(`[spokeSuggestionsStore.getSpokeSuggestions] ${error.message}`);
  }
  return Object.fromEntries(found.map((row) => [row.cluster_id, row.payload]));
}

/** Persist (or replace) one cluster's suggestion. Never throws — see routes.js. */
async function saveSpokeSuggestion(projectId, clusterId, payload) {
  if (!db.isDatabaseConfigured()) return { saved: false, reason: 'not_configured' };
  try {
    await db.upsert(
      TABLE,
      { project_id: projectId, cluster_id: clusterId, payload, updated_at: new Date().toISOString() },
      ['project_id', 'cluster_id'],
    );
    return { saved: true };
  } catch (error) {
    if (isMissingTable(error)) {
      console.warn(
        `[spokeSuggestionsStore] ${TABLE} does not exist yet — apply `
        + 'supabase/migrations/0029_content_architect_spoke_suggestions.sql. '
        + 'The suggestion is still saved to the file-backed analysis meanwhile.',
      );
      return { saved: false, reason: 'table_missing' };
    }
    console.error('[spokeSuggestionsStore] could not persist suggestion:', error.message);
    return { saved: false, reason: 'write_failed' };
  }
}

/**
 * Overlays persisted DB suggestions onto an analysis object's
 * spokeSuggestionsByCluster, DB winning on a conflict — it is the durable
 * copy, so a stale file-store value must not shadow it.
 */
function mergeInto(analysis, dbSuggestions) {
  if (!dbSuggestions || !Object.keys(dbSuggestions).length) return analysis;
  return {
    ...analysis,
    spokeSuggestionsByCluster: {
      ...(analysis.spokeSuggestionsByCluster || {}),
      ...dbSuggestions,
    },
  };
}

module.exports = { getSpokeSuggestions, saveSpokeSuggestion, mergeInto };
