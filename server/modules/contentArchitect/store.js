// ── Persistence ───────────────────────────────────────────────────────────────
// Same pattern as the other modules in this app: one shared list file, plus
// per-project sidecar files, all atomic (temp-file-then-rename).
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const crypto = require('crypto');

const { resolveDataRoot } = require('../../services/dataRoot');
const { assertSafeFileId } = require('../../services/safeFileId');

// Ephemeral inside the image on a container platform; see services/dataRoot.js.
const DATA_ROOT = resolveDataRoot(
  'content-architect', path.join(__dirname, 'data'), 'CONTENT_ARCHITECT_DATA_ROOT',
);

function genId(prefix = 'id') {
  return `${prefix}_${Date.now().toString(36)}${crypto.randomBytes(4).toString('hex')}`;
}

async function ensureDataRoot() {
  if (!fsSync.existsSync(DATA_ROOT)) await fs.mkdir(DATA_ROOT, { recursive: true });
}

// Windows refuses a rename onto a path another handle still holds open, and a
// virus scanner or search indexer takes one for a few milliseconds after a file
// is written. That is transient by nature, so it is retried rather than failed.
const RENAME_RETRIES = 5;
const RENAME_BACKOFF_MS = 20;

async function writeAtomic(filePath, data) {
  await ensureDataRoot();

  // The temp name is unique per write, not a shared `${filePath}.tmp`.
  //
  // With a shared name, two concurrent writes to the same file race on one temp
  // path: both write it, both try to rename it, and the loser either fails with
  // EPERM (Windows) or silently renames the winner's half-written bytes over the
  // destination (POSIX). mutateProjects() serializes writes to projects.json,
  // but nothing serializes the per-project sidecars, and two requests touching
  // one project's analysis is ordinary. A unique temp path makes the rename the
  // only contended step, which is the one step the filesystem makes atomic.
  const tmp = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');

  let lastError;
  for (let attempt = 0; attempt < RENAME_RETRIES; attempt += 1) {
    try {
      await fs.rename(tmp, filePath);
      return;
    } catch (error) {
      lastError = error;
      if (error.code !== 'EPERM' && error.code !== 'EACCES' && error.code !== 'EBUSY') break;
      await new Promise((r) => setTimeout(r, RENAME_BACKOFF_MS * 2 ** attempt));
    }
  }

  // Never leave the temp file behind: the data root is listed elsewhere, and a
  // stray `.tmp` there reads as a real sidecar with a corrupt name.
  await fs.rm(tmp, { force: true }).catch(() => {});
  throw lastError;
}

async function readJson(filePath, fallback) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

const projectsFile = () => path.join(DATA_ROOT, 'projects.json');
// Every sidecar path is built from an id that reaches this module straight from
// req.params. path.join resolves `..` silently, so `../../x` yielded a path
// OUTSIDE DATA_ROOT and the store then read, wrote or unlinked there — and
// deleteProject() unlinks all four of these, which made DELETE
// /projects/:id an arbitrary file delete for anything ending in these suffixes.
// Validated here, at the interpolation itself, so no caller can bypass it.
const sid = (id) => assertSafeFileId(id, 'projectId');
const patternsFile = (id) => path.join(DATA_ROOT, `${sid(id)}_patterns.json`);
const urlsFile = (id) => path.join(DATA_ROOT, `${sid(id)}_urls.json`);
const clustersFile = (id) => path.join(DATA_ROOT, `${sid(id)}_clusters.json`); // Stage 3 draft clusters only
const fullAnalysisFile = (id) => path.join(DATA_ROOT, `${sid(id)}_full_analysis.json`); // Stage 4-7 real analysis

// Creation, background analysis and UI requests can update the list together.
// Serialize read/modify/write operations so one does not erase another's entry.
let projectWrites = Promise.resolve();
function mutateProjects(change) {
  const operation = projectWrites.then(async () => {
    const all = await listProjects();
    const result = await change(all);
    await writeAtomic(projectsFile(), all);
    return result;
  });
  projectWrites = operation.catch(() => {});
  return operation;
}

async function listProjects() {
  return readJson(projectsFile(), []);
}

async function getProject(id) {
  const all = await listProjects();
  return all.find((p) => p.id === id) || null;
}

function newProject({ domain, host, platformProjectId = null, workspaceId = null }) {
  return {
    id: genId('proj'),
    platformProjectId,
    workspaceId,
    domain, // canonical origin, e.g. "https://www.example.com"
    name: host,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    workflowState: platformProjectId ? 'waiting_for_crawl' : 'created',
    vertical: null,
    // Set once (Domains-style input, not asked again per spoke-suggestion
    // request) and reused automatically by spokeSuggestions.js's competitive
    // signal — see routes.js PUT /projects/:id/competitors.
    competitors: [],
    sitemapSource: null,
    crawlMode: null,
    stats: { urlsFound: 0, urlsSelected: 0, urlsAnalyzed: 0, urlsExcluded: 0, clusterCount: 0, gapHubCount: 0, orphanCount: 0, unassignedCount: 0, meanHealth: null },
  };
}

async function createProject(input) {
  return mutateProjects((all) => {
    const project = newProject(input);
    all.push(project);
    return project;
  });
}

/** A stable module entry per platform project, including before its first crawl. */
async function ensureProject({ platformProjectId, workspaceId, domain, host }) {
  if (!platformProjectId) throw new Error('A platform project is required.');
  const existing = (await listProjects()).find((p) => p.platformProjectId === platformProjectId);
  if (existing) return existing;
  return mutateProjects((all) => {
    const linked = all.find((p) => p.platformProjectId === platformProjectId);
    if (linked) return linked;
    // Legacy standalone analyses can be reused once. Never share a linked
    // record between projects/workspaces that happen to track the same site.
    const site = (value) => {
      try { return new URL(value).host.toLowerCase().replace(/^www\./, ''); }
      catch { return null; }
    };
    const legacy = all.find((p) => !p.platformProjectId && site(domain)
      && site(p.domain) === site(domain));
    if (legacy) {
      Object.assign(legacy, { platformProjectId, workspaceId, updatedAt: new Date().toISOString() });
      return legacy;
    }
    const project = newProject({ domain, host, platformProjectId, workspaceId });
    all.push(project);
    return project;
  });
}

async function updateProject(id, patch) {
  return mutateProjects((all) => {
    const idx = all.findIndex((p) => p.id === id);
    if (idx === -1) throw new Error('Project not found');
    all[idx] = { ...all[idx], ...patch, updatedAt: new Date().toISOString() };
    return all[idx];
  });
}

async function deleteProject(id) {
  await mutateProjects((all) => {
    const idx = all.findIndex((p) => p.id === id);
    if (idx !== -1) all.splice(idx, 1);
  });
  await fs.unlink(patternsFile(id)).catch(() => {});
  await fs.unlink(urlsFile(id)).catch(() => {});
  await fs.unlink(clustersFile(id)).catch(() => {});
  await fs.unlink(fullAnalysisFile(id)).catch(() => {});
}

async function getPatterns(id) {
  return readJson(patternsFile(id), null);
}

async function savePatterns(id, patterns) {
  await writeAtomic(patternsFile(id), patterns);
}

// The raw discovered/crawled URL list ({ url, lastmod }[]), persisted once at
// discovery time. Stage 2's pattern table only keeps 3 example URLs per
// pattern (see patternClassifier.js) — Stage 3 needs every confirmed URL and
// must make no network calls, so the full list has to live on disk rather
// than being re-fetched or re-derived from examples alone.
async function getUrls(id) {
  return readJson(urlsFile(id), null);
}

async function saveUrls(id, urls) {
  await writeAtomic(urlsFile(id), urls);
}

async function getClusters(id) {
  return readJson(clustersFile(id), null);
}

async function saveClusters(id, clusters) {
  await writeAtomic(clustersFile(id), clusters);
}

async function getFullAnalysis(id) {
  return readJson(fullAnalysisFile(id), null);
}

async function saveFullAnalysis(id, analysis) {
  await writeAtomic(fullAnalysisFile(id), analysis);
}

module.exports = {
  listProjects, getProject, createProject, ensureProject, updateProject, deleteProject,
  getPatterns, savePatterns, getUrls, saveUrls, getClusters, saveClusters,
  getFullAnalysis, saveFullAnalysis,
};
