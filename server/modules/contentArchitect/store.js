// ── Persistence ───────────────────────────────────────────────────────────────
// Same pattern as the other modules in this app: one shared list file, plus
// per-project sidecar files, all atomic (temp-file-then-rename).
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_ROOT = path.join(__dirname, 'data');

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

async function listProjects() {
  return readJson(projectsFile(), []);
}

async function getProject(id) {
  const all = await listProjects();
  return all.find((p) => p.id === id) || null;
}

async function createProject({ domain, host }) {
  const all = await listProjects();
  const project = {
    id: genId('proj'),
    domain, // canonical origin, e.g. "https://www.example.com"
    name: host,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    workflowState: 'created',
    vertical: null,
    // Set once (Domains-style input, not asked again per spoke-suggestion
    // request) and reused automatically by spokeSuggestions.js's competitive
    // signal — see routes.js PUT /projects/:id/competitors.
    competitors: [],
    sitemapSource: null,
    crawlMode: null,
    stats: { urlsFound: 0, urlsSelected: 0, urlsAnalyzed: 0, urlsExcluded: 0, clusterCount: 0, gapHubCount: 0, orphanCount: 0, unassignedCount: 0, meanHealth: null },
  };
  all.push(project);
  await writeAtomic(projectsFile(), all);
  return project;
}

async function updateProject(id, patch) {
  const all = await listProjects();
  const idx = all.findIndex((p) => p.id === id);
  if (idx === -1) throw new Error('Project not found');
  all[idx] = { ...all[idx], ...patch, updatedAt: new Date().toISOString() };
  await writeAtomic(projectsFile(), all);
  return all[idx];
}

async function deleteProject(id) {
  const all = await listProjects();
  await writeAtomic(projectsFile(), all.filter((p) => p.id !== id));
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
  listProjects, getProject, createProject, updateProject, deleteProject,
  getPatterns, savePatterns, getUrls, saveUrls, getClusters, saveClusters,
  getFullAnalysis, saveFullAnalysis,
};
