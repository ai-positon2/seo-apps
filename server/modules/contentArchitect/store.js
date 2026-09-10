// ── Persistence ───────────────────────────────────────────────────────────────
// Same pattern as the other modules in this app: one shared list file, plus
// per-project sidecar files, all atomic (temp-file-then-rename).
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const crypto = require('crypto');

const { resolveDataRoot } = require('../../services/dataRoot');

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

async function writeAtomic(filePath, data) {
  await ensureDataRoot();
  const tmp = `${filePath}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await fs.rename(tmp, filePath);
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
const patternsFile = (id) => path.join(DATA_ROOT, `${id}_patterns.json`);
const urlsFile = (id) => path.join(DATA_ROOT, `${id}_urls.json`);
const clustersFile = (id) => path.join(DATA_ROOT, `${id}_clusters.json`); // Stage 3 draft clusters only
const fullAnalysisFile = (id) => path.join(DATA_ROOT, `${id}_full_analysis.json`); // Stage 4-7 real analysis

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
