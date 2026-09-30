// ── Inline keyword research results, per topic ─────────────────────────────
//
// The Hub & Spoke report's keyword research (HubSpokeReport.jsx) runs the
// standalone /api/keyword-research pipeline on a suggested topic. This keeps
// what that run produced and what the user picked from it, so the result
// survives collapsing the row or reloading the page — see migration 0040.
// Same shape and failure policy as spokeSuggestionsStore.js.

const db = require('../../services/db');

const TABLE = 'content_architect_keyword_research';

/** True when the schema (migration 0040) has not been applied yet. */
function isMissingTable(error) {
  return error?.code === '42P01' || /relation .* does not exist/i.test(error?.message || '');
}

function toRecord(row) {
  return {
    clusterId: row.cluster_id,
    topic: row.topic,
    intent: row.intent,
    result: row.result,
    selection: row.selection || null,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
  };
}

/** Every saved topic for one cluster of a project. */
async function listForCluster(projectId, clusterId) {
  if (!db.isDatabaseConfigured()) return [];
  try {
    const found = await db.rows(
      `select cluster_id, topic, intent, result, selection, updated_at
         from ${TABLE} where project_id = $1 and cluster_id = $2
        order by updated_at desc`,
      [projectId, clusterId],
    );
    return found.map(toRecord);
  } catch (error) {
    if (isMissingTable(error)) return [];
    throw new Error(`[keywordResearchStore.listForCluster] ${error.message}`);
  }
}

const picks = (list) => (Array.isArray(list) ? list : [])
  .map((k) => ({ keyword: k?.keyword || '', volume: k?.volume || 0 })).filter((k) => k.keyword);

/**
 * Every saved topic in a project, without the heavy pool and sources: the
 * seed and the current primary and secondary picks — enough for the
 * report to mark which topics have keywords, and to match an article back to
 * the topic whose primary keyword it was written for.
 */
async function listSummaries(projectId) {
  if (!db.isDatabaseConfigured()) return [];
  try {
    const found = await db.rows(
      `select cluster_id, topic, intent, updated_at,
              result->>'keyword' as seed,
              coalesce(selection->'primary', result->'result'->'primary', '[]'::jsonb) as primary_picks,
              coalesce(selection->'secondary', result->'result'->'secondary', '[]'::jsonb) as secondary_picks
         from ${TABLE} where project_id = $1
        order by updated_at desc`,
      [projectId],
    );
    return found.map((row) => ({
      clusterId: row.cluster_id,
      topic: row.topic,
      intent: row.intent,
      seed: row.seed || '',
      primary: picks(row.primary_picks),
      secondary: picks(row.secondary_picks),
      updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
    }));
  } catch (error) {
    if (isMissingTable(error)) return [];
    throw new Error(`[keywordResearchStore.listSummaries] ${error.message}`);
  }
}

/**
 * Save (or replace) one topic's run. `selection` may be omitted to keep the
 * stored one — a fresh run always sends it, a pick change sends only it via
 * saveSelection below.
 */
async function saveResult(projectId, clusterId, { topic, intent, result, selection }) {
  if (!db.isDatabaseConfigured()) return { saved: false, reason: 'not_configured' };
  try {
    await db.upsert(
      TABLE,
      {
        project_id: projectId,
        cluster_id: clusterId,
        topic,
        intent: intent === 'commercial' ? 'commercial' : 'informational',
        result,
        selection: selection || null,
        updated_at: new Date().toISOString(),
      },
      ['project_id', 'cluster_id', 'topic'],
    );
    return { saved: true };
  } catch (error) {
    return failure(error);
  }
}

/** Update only the picks for an already-saved topic. */
async function saveSelection(projectId, clusterId, topic, selection) {
  if (!db.isDatabaseConfigured()) return { saved: false, reason: 'not_configured' };
  try {
    const { rowCount } = await db.query(
      `update ${TABLE} set selection = $4::jsonb, updated_at = now()
        where project_id = $1 and cluster_id = $2 and topic = $3`,
      [projectId, clusterId, topic, JSON.stringify(selection || null)],
    );
    return rowCount ? { saved: true } : { saved: false, reason: 'not_found' };
  } catch (error) {
    return failure(error);
  }
}

function failure(error) {
  if (isMissingTable(error)) {
    console.warn(
      `[keywordResearchStore] ${TABLE} does not exist yet — apply `
      + 'supabase/migrations/0040_content_architect_keyword_research.sql.',
    );
    return { saved: false, reason: 'table_missing' };
  }
  console.error('[keywordResearchStore] could not persist keyword research:', error.message);
  return { saved: false, reason: 'write_failed' };
}

module.exports = { listForCluster, listSummaries, saveResult, saveSelection };
