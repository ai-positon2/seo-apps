// ── Article enhancements saved against a Content Architect page ─────────────
//
// Article Enhancement writes its finished result here when it was started from
// the Hub & Spoke report (routes/articleEnhancement.js), and the report reads
// it back beside the hub or spoke it belongs to — see migration 0041. Same
// failure policy as spokeSuggestionsStore.js: a missing table or database
// never breaks the tool that is saving.

const db = require('../../services/db');

const TABLE = 'content_architect_enhancements';

function isMissingTable(error) {
  return error?.code === '42P01' || /relation .* does not exist/i.test(error?.message || '');
}

const iso = (v) => (v instanceof Date ? v.toISOString() : v);

/**
 * Save (or replace) the enhancement of one page.
 * @param {object} e { projectId, clusterId, url, contentType, title, result, createdBy }
 *   result: { recommendations, enhancedText, coverage, articleMeta }
 */
async function saveEnhancement(e) {
  if (!db.isDatabaseConfigured()) return { saved: false, reason: 'not_configured' };
  try {
    await db.upsert(
      TABLE,
      {
        project_id: e.projectId,
        cluster_id: e.clusterId || null,
        url: e.url,
        content_type: e.contentType || 'article',
        title: e.title || null,
        result: e.result,
        created_by: e.createdBy || null,
        updated_at: new Date().toISOString(),
      },
      ['project_id', 'url'],
    );
    return { saved: true };
  } catch (error) {
    if (isMissingTable(error)) {
      console.warn(`[enhancementsStore] ${TABLE} does not exist yet — apply supabase/migrations/0041_content_architect_enhancements.sql.`);
      return { saved: false, reason: 'table_missing' };
    }
    console.error('[enhancementsStore] could not save enhancement:', error.message);
    return { saved: false, reason: 'write_failed' };
  }
}

/** A light summary of every saved enhancement in a project, for the report. */
async function listSummaries(projectId) {
  if (!db.isDatabaseConfigured()) return [];
  try {
    const found = await db.rows(
      `select cluster_id, url, content_type, title, created_by, updated_at,
              (result->'coverage'->>'covered')::int as covered,
              (result->'coverage'->>'total')::int as coverage_total,
              coalesce(length(result->>'enhancedText'), 0) as enhanced_chars,
              (select count(*) from regexp_matches(coalesce(result->>'enhancedText', ''), '\\[NEW\\]', 'g'))::int as additions
         from ${TABLE} where project_id = $1
        order by updated_at desc`,
      [projectId],
    );
    return found.map((r) => ({
      clusterId: r.cluster_id,
      url: r.url,
      contentType: r.content_type,
      title: r.title,
      createdBy: r.created_by,
      updatedAt: iso(r.updated_at),
      coverage: Number.isFinite(r.covered) ? { covered: r.covered, total: r.coverage_total || 12 } : null,
      additions: r.additions || 0,
      hasText: r.enhanced_chars > 0,
    }));
  } catch (error) {
    if (isMissingTable(error)) return [];
    throw new Error(`[enhancementsStore.listSummaries] ${error.message}`);
  }
}

/** The full saved enhancement of one page, or null. */
async function getEnhancement(projectId, url) {
  if (!db.isDatabaseConfigured()) return null;
  try {
    const row = await db.maybeOne(
      `select cluster_id, url, content_type, title, result, created_by, updated_at
         from ${TABLE} where project_id = $1 and url = $2`,
      [projectId, url],
    );
    if (!row) return null;
    return {
      clusterId: row.cluster_id,
      url: row.url,
      contentType: row.content_type,
      title: row.title,
      result: row.result,
      createdBy: row.created_by,
      updatedAt: iso(row.updated_at),
    };
  } catch (error) {
    if (isMissingTable(error)) return null;
    throw new Error(`[enhancementsStore.getEnhancement] ${error.message}`);
  }
}

module.exports = { saveEnhancement, listSummaries, getEnhancement };
