// ── Everything made from a Hub & Spoke report, gathered back onto it ─────────
//
// Three tools produce work from the report, and each stores it its own way:
//
//   keyword research   content_architect_keyword_research, per (cluster, topic)
//   article drafts     content_writer_articles, per PLATFORM project; the
//                      document's `origin` names the topic it was started for
//   page enhancements  content_architect_enhancements, per (project, page URL)
//
// GET /projects/:id/work reads all three as light summaries, so the report can
// mark every hub, spoke and suggested topic with what exists for it while its
// cluster is still collapsed; the full article or enhancement is fetched only
// when opened.
//
// Articles written before `origin` existed are matched by keyword instead: an
// article in the linked project whose keyword is a saved topic's primary
// keyword was written for that topic (Recommend Article hands over exactly
// that keyword).

const db = require('../../services/db');
const projectAccess = require('../../services/projectAccess');
const keywordResearchStore = require('./keywordResearchStore');
const enhancementsStore = require('./enhancementsStore');
const { cleanHtml } = require('../contentWriter/document');

const norm = (s) => String(s || '').trim().toLowerCase();

const iso = (v) => (v instanceof Date ? v.toISOString() : v);

// Words in the draft, counted in SQL so the list never ships the HTML.
const ARTICLE_COLUMNS = `id, project_id, updated_at,
  document->>'keyword' as keyword,
  document->'brief'->>'title' as title,
  document->'origin' as origin,
  coalesce(jsonb_array_length(case when jsonb_typeof(document->'brief'->'sections') = 'array'
    then document->'brief'->'sections' end), 0) as sections,
  coalesce(array_length(regexp_split_to_array(nullif(btrim(regexp_replace(
    coalesce(document->>'draftHtml', ''), '<[^>]+>', ' ', 'g')), ''), '\\s+'), 1), 0) as words`;

/**
 * Attach each article to the topic it belongs to. Pure, so it is unit-tested.
 * @returns {Array} the articles that belong to this project, each with
 *   { clusterId, topic, linkedBy: 'origin' | 'keyword' }
 */
function linkArticles(articles, keywordTopics, { caProjectId, platformProjectId }) {
  const byPrimary = new Map();
  for (const t of keywordTopics) {
    for (const [i, k] of t.primary.entries()) {
      const key = norm(k.keyword);
      // The first primary wins a tie: it is the keyword Recommend Article sends.
      const existing = byPrimary.get(key);
      if (!existing || i < existing.rank) byPrimary.set(key, { topic: t, rank: i });
    }
  }
  const linked = [];
  for (const a of articles) {
    const origin = a.origin && typeof a.origin === 'object' ? a.origin : null;
    if (origin?.caProjectId === caProjectId && origin.clusterId && origin.topic) {
      linked.push({ ...a, clusterId: origin.clusterId, topic: origin.topic, linkedBy: 'origin' });
      continue;
    }
    if (origin || !platformProjectId || a.projectId !== platformProjectId) continue;
    const hit = byPrimary.get(norm(a.keyword));
    if (hit) linked.push({ ...a, clusterId: hit.topic.clusterId, topic: hit.topic.topic, linkedBy: 'keyword' });
  }
  return linked;
}

function toArticle(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    keyword: row.keyword || '',
    title: row.title || '',
    origin: row.origin || null,
    sections: row.sections || 0,
    words: row.words || 0,
    stage: row.words > 0 ? 'draft' : row.sections > 0 ? 'brief' : 'started',
    updatedAt: iso(row.updated_at),
  };
}

// An article saved under a platform project other than this analysis's own
// is listed only if the viewer can see that project.
async function visibleTo(req, rows, platformProjectId) {
  const verdicts = new Map();
  const out = [];
  for (const row of rows) {
    if (row.project_id === platformProjectId) { out.push(row); continue; }
    if (!verdicts.has(row.project_id)) {
      verdicts.set(row.project_id, projectAccess.requireProject(req, row.project_id, 'view').then(() => true, () => false));
    }
    if (await verdicts.get(row.project_id)) out.push(row);
  }
  return out;
}

async function listArticles(req, project) {
  if (!db.isDatabaseConfigured()) return [];
  const rows = await db.rows(
    `select ${ARTICLE_COLUMNS} from content_writer_articles
      where document->'origin'->>'caProjectId' = $1
         or ($2::uuid is not null and project_id = $2::uuid and document->'origin' is null)
      order by updated_at desc limit 500`,
    [project.id, project.platformProjectId || null],
  );
  return (await visibleTo(req, rows, project.platformProjectId)).map(toArticle);
}

/** The whole project's work, as summaries. */
async function projectWork(req, project) {
  const [keywordResearch, articles, enhancements] = await Promise.all([
    keywordResearchStore.listSummaries(project.id),
    listArticles(req, project),
    enhancementsStore.listSummaries(project.id),
  ]);
  return {
    keywordResearch,
    articles: linkArticles(articles, keywordResearch, { caProjectId: project.id, platformProjectId: project.platformProjectId }),
    enhancements,
  };
}

/** One article, in full, if it belongs to this project's report. */
async function getArticle(req, project, articleId) {
  if (!db.isDatabaseConfigured()) return null;
  if (!/^[0-9a-f-]{36}$/i.test(articleId)) return null;
  const row = await db.maybeOne(
    `select ${ARTICLE_COLUMNS}, document->'brief' as brief, document->>'draftHtml' as draft_html,
            document->'options'->>'secondaryKeywords' as secondary_keywords
       from content_writer_articles where id = $1`,
    [articleId],
  );
  if (!row) return null;
  const [visible] = await visibleTo(req, [row], project.platformProjectId);
  if (!visible) return null;
  const summaries = await keywordResearchStore.listSummaries(project.id);
  const [linked] = linkArticles([toArticle(row)], summaries, { caProjectId: project.id, platformProjectId: project.platformProjectId });
  if (!linked) return null;
  return {
    ...linked,
    brief: row.brief || null,
    // Sanitized on every write, and again here because the report renders it
    // as HTML (contentWriter/document.js cleanHtml: fixed tags, http(s) links).
    draftHtml: cleanHtml(row.draft_html || ''),
    secondaryKeywords: row.secondary_keywords || '',
  };
}

module.exports = { projectWork, getArticle, linkArticles };
