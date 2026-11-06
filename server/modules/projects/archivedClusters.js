// ── Archived Hub and Spoke topics, applied on read ──────────────────────────
//
// A Hub and Spoke module run stores the score, findings and payload worked out
// when the analysis ran; an archive is made later (projects/store.js
// archiveCluster). Rather than re-running anything, every reader of that run
// passes it through here: the figures are recomputed from the project's saved
// Content Architect analysis with the archived clusters left out
// (contentArchitect/archivedClusters.js), by the same functions the runner
// itself uses (moduleRunners.hubSpokeFacts / hubSpokeFindings).
//
// A project with nothing archived — or whose archives match no cluster of the
// current analysis — gets the row it passed in back, the same object, so its
// numbers cannot move. The settings are read with one small query; the
// analysis is loaded only when something is archived, and the figures are kept
// per (analysis version, archive list) so a dashboard poll does not reload it.

const db = require('../../services/db');
const { excludeArchived, meanHealth, archivedPhrase } = require('../contentArchitect/archivedClusters');

const COMPLETED = ['completed', 'completed_with_errors'];
const CACHE_MAX = 50;
const CACHE_MS = 10 * 60_000;
const cache = new Map();

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * The project's archive entries and the Content Architect analysis they apply
 * to: { entries, caId, analysisAt }. Never throws; nothing archived on error.
 */
async function archiveState(projectId) {
  if (!projectId || !db.isDatabaseConfigured()) return { entries: [], caId: null, analysisAt: null };
  try {
    const row = await db.maybeOne(
      `select p.settings->'archivedClusters' as archived, a.ca_id, a.updated_at
         from crawl_projects p
         left join lateral (
           select ca.id as ca_id, art.updated_at
             from content_architect_projects ca
             join content_architect_artifacts art on art.project_id = ca.id and art.kind = 'full_analysis'
            where ca.platform_project_id = p.id
            order by art.updated_at desc
            limit 1) a on true
        where p.id = $1`,
      [projectId],
    );
    const entries = Array.isArray(row?.archived) ? row.archived.filter((e) => e && e.key && e.anchor) : [];
    return { entries, caId: row?.ca_id || null, analysisAt: row?.updated_at || null };
  } catch (e) {
    console.error('[projects.archivedClusters.state]', e.message);
    return { entries: [], caId: null, analysisAt: null };
  }
}

/**
 * Everything a reader needs about the analysis with archived topics left out,
 * from the filtered analysis alone. `matched` is how many archives named a
 * cluster of this analysis; with 0 nothing changes anywhere.
 */
function summarize(filtered, archived) {
  const { hubSpokeFacts, hubSpokeFindings } = require('./moduleRunners');
  const { normalizeFinding } = require('./moduleEvidence');
  const facts = hubSpokeFacts(filtered);
  const capped = Boolean(filtered.orphanDetectionWithheld);
  const pageById = new Map((filtered.pages || []).map((p) => [p.id, p]));
  return {
    matched: archived.filter((a) => a.inAnalysis).length,
    archived,
    meanHealth: facts.meanHealth,
    clusterCount: facts.clusters.length,
    gapCount: facts.gapClusters.length,
    pagesAnalyzed: facts.pages.length,
    unassignedCount: facts.unassigned.length,
    orphanCount: capped ? null : facts.orphans.length,
    pagesWithNoInboundLink: facts.pages
      .filter((p) => facts.hasFlag(p, 'orphan') || p.inboundLinkCount === 0).length,
    findings: hubSpokeFindings(facts, { capped }).map(normalizeFinding),
    // The payload's own cluster list shape (runHubSpoke).
    payloadClusters: facts.clusters.slice(0, 20).map((c) => ({
      name: c.name,
      isGap: c.isGap,
      ...(c.referenceIndexUrl ? { referenceIndexUrl: c.referenceIndexUrl } : {}),
      spokes: (c.spokeIds || []).length,
      health: c.health ?? null,
      hubConfidence: c.hubConfidence ?? null,
    })),
    // The downloads' structure section's shape (report.js hubSpokeStructure).
    structureRows: facts.clusters.map((c) => ({
      name: c.name,
      health: c.health ?? null,
      gap: Boolean(c.isGap),
      spokes: (c.spokeIds || []).length,
      hub: pageById.get(c.hubPageId)?.url || null,
    })),
  };
}

/**
 * The figures for one project with its archived topics left out, or null when
 * nothing archived applies (nothing archived, no saved analysis, or no archive
 * names a cluster of it).
 */
async function archivedSummary(projectId) {
  const state = await archiveState(projectId);
  if (!state.entries.length || !state.caId) return null;
  const at = state.analysisAt instanceof Date ? state.analysisAt.toISOString() : String(state.analysisAt || '');
  const key = `${state.caId}:${at}:${state.entries.map((e) => e.key).join(',')}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;

  const caStore = require('../contentArchitect/store');
  const analysis = await caStore.getFullAnalysis(state.caId);
  let value = null;
  if (analysis) {
    const { analysis: filtered, archived } = excludeArchived(analysis, state.entries);
    const summary = summarize(filtered, archived);
    value = summary.matched ? summary : null;
  }
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, { at: Date.now(), value });
  return value;
}

/** Forgets the cached figures for a project's archives (after archive/restore). */
function forget() {
  cache.clear();
}

function bandFor(s) {
  return (s.clusterCount ? plural(s.clusterCount, 'cluster') : 'No clusters')
    + (s.unassignedCount ? ` · ${plural(s.unassignedCount, 'page')} not in any topic` : '')
    + ` · ${archivedPhrase(s.matched)}`;
}

/** The stored payload with the archived topics left out of its figures. */
function applyToPayload(payload, s) {
  if (!payload || typeof payload !== 'object' || !s) return payload;
  const cardNote = typeof payload.cardNote === 'string'
    ? payload.cardNote.replace(/\d+ cluster\(s\), \d+ without a hub$/,
      `${s.clusterCount} cluster(s), ${s.gapCount} without a hub · ${archivedPhrase(s.matched)}`)
    : payload.cardNote;
  return {
    ...payload,
    pagesAnalyzed: s.pagesAnalyzed,
    clusterCount: s.clusterCount,
    gapHubCount: s.gapCount,
    orphanCount: payload.orphanCount === null || payload.orphanCount === undefined ? payload.orphanCount : s.orphanCount,
    pagesWithNoInboundLink: s.pagesWithNoInboundLink,
    unassignedCount: s.unassignedCount,
    meanHealth: s.meanHealth,
    clusters: s.payloadClusters,
    cardNote,
    archivedClusters: s.archived,
    archivedClusterCount: s.matched,
  };
}

/**
 * One Hub and Spoke run row (a latestByModule row, or a full row with its
 * payload) with archived topics left out. Any other row, an unfinished or
 * unscored one, or a project with nothing archived: returned as is.
 */
async function applyToRun(projectId, row, { summary } = {}) {
  if (!row || row.module_key !== 'hub_spoke' || !COMPLETED.includes(row.status) || row.reportMissing) return row;
  if (row.score === null || row.score === undefined) return row;
  const s = summary === undefined ? await archivedSummary(projectId).catch((e) => {
    console.error('[projects.archivedClusters]', e.message);
    return null;
  }) : summary;
  if (!s) return row;

  const { countsFor } = require('./moduleEvidence');
  const phrase = archivedPhrase(s.matched);
  const out = {
    ...row,
    score: s.meanHealth,
    score_max: s.meanHealth === null ? null : (row.score_max ?? 100),
    score_basis: s.meanHealth === null ? null
      : `${row.score_basis || 'Content Architect: mean cluster health'} — ${phrase} for this client, left out`,
    band: bandFor(s),
    findings: s.findings,
    counts: countsFor(s.findings),
    archivedClusters: s.archived,
    archivedClusterCount: s.matched,
  };
  if (typeof row.cardNote === 'string' && row.cardNote) {
    out.cardNote = row.cardNote.replace(/\d+ cluster\(s\), \d+ without a hub$/,
      `${s.clusterCount} cluster(s), ${s.gapCount} without a hub · ${phrase}`);
  }
  if (typeof row.note === 'string' && row.note) {
    out.note = `${row.note} ${phrase[0].toUpperCase()}${phrase.slice(1)} for this client `
      + `${s.matched === 1 ? 'is' : 'are'} left out of the score, counts and findings.`;
  }
  if ('payload' in row) out.payload = applyToPayload(row.payload, s);
  return out;
}

/**
 * report.js's structure section (hubSpokeStructure) with archived topics left
 * out; the same object back when none apply. `cap` is that section's row cap.
 */
async function structureFor(projectId, structure, { cap = 50 } = {}) {
  if (!structure) return structure;
  const s = await archivedSummary(projectId);
  if (!s) return structure;
  return {
    ...structure,
    pages: s.pagesAnalyzed,
    clusters: s.clusterCount,
    gaps: s.gapCount,
    unassigned: s.unassignedCount,
    meanHealth: s.meanHealth,
    clusterRows: s.structureRows.slice(0, cap)
      .sort((a, b) => (Number(b.spokes) || 0) - (Number(a.spokes) || 0)),
    archivedClusters: s.archived,
    archivedClusterCount: s.matched,
  };
}

module.exports = {
  archiveState, archivedSummary, summarize, applyToRun, applyToPayload, structureFor, forget, meanHealth,
};
