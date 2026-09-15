const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

const { resolveDataRoot } = require('../../services/dataRoot');
// Traversal guard: clientId reaches these paths from req.params.
const { assertSafeFileId } = require('../../services/safeFileId');

// Ephemeral inside the image on a container platform; see services/dataRoot.js.
const DATA_ROOT = resolveDataRoot(
  'competitor-analysis', path.join(__dirname, 'data'), 'COMPETITOR_ANALYSIS_DATA_ROOT',
);
const SNAPSHOTS_DIR = path.join(DATA_ROOT, 'snapshots');
const CONTENT_ANALYSIS_DIR = path.join(DATA_ROOT, 'content-analysis');
const CLIENTS_FILE = path.join(DATA_ROOT, 'clients.json');
const MAX_COMPETITORS = 4;

function genId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${crypto.randomBytes(4).toString('hex')}`;
}

async function writeAtomic(filePath, data) {
  const tmp = filePath + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await fs.rename(tmp, filePath);
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

async function init() {
  await fs.mkdir(SNAPSHOTS_DIR, { recursive: true });
  await fs.mkdir(CONTENT_ANALYSIS_DIR, { recursive: true });
  try { await fs.access(CLIENTS_FILE); } catch { await writeAtomic(CLIENTS_FILE, []); }
}

// ── Clients ──────────────────────────────────────────────────────────────────

async function getClients() {
  return readJson(CLIENTS_FILE, []);
}

async function getClient(clientId) {
  const list = await getClients();
  return list.find((c) => c.id === clientId) || null;
}

async function createClient({ name, domain, country, brandName }) {
  if (!name || !domain) throw new Error('name and domain are required');
  const list = await getClients();
  const client = {
    id: genId('client'),
    name,
    domain: domain.replace(/^https?:\/\//, '').replace(/\/$/, ''),
    country: country || 'United States',
    brandName: brandName || name,
    competitors: [],
    createdAt: new Date().toISOString(),
  };
  list.push(client);
  await writeAtomic(CLIENTS_FILE, list);
  return client;
}

async function updateClient(clientId, patch) {
  const list = await getClients();
  const idx = list.findIndex((c) => c.id === clientId);
  if (idx === -1) throw new Error('Client not found');
  list[idx] = { ...list[idx], ...patch, id: list[idx].id, competitors: list[idx].competitors };
  await writeAtomic(CLIENTS_FILE, list);
  return list[idx];
}

async function deleteClient(clientId) {
  const list = await getClients();
  const next = list.filter((c) => c.id !== clientId);
  await writeAtomic(CLIENTS_FILE, next);
  await fs.rm(path.join(SNAPSHOTS_DIR, `${assertSafeFileId(clientId, 'clientId')}.json`), { force: true });
  await fs.rm(path.join(CONTENT_ANALYSIS_DIR, `${assertSafeFileId(clientId, 'clientId')}.json`), { force: true });
}

// ── Competitors ──────────────────────────────────────────────────────────────

async function addCompetitor(clientId, { domain, label }) {
  if (!domain) throw new Error('domain is required');
  const list = await getClients();
  const client = list.find((c) => c.id === clientId);
  if (!client) throw new Error('Client not found');
  if (client.competitors.length >= MAX_COMPETITORS) throw new Error(`Maximum of ${MAX_COMPETITORS} competitors per client`);
  const competitor = {
    id: genId('comp'),
    domain: domain.replace(/^https?:\/\//, '').replace(/\/$/, ''),
    label: label || domain,
    addedAt: new Date().toISOString(),
  };
  client.competitors.push(competitor);
  await writeAtomic(CLIENTS_FILE, list);
  return competitor;
}

async function removeCompetitor(clientId, competitorId) {
  const list = await getClients();
  const client = list.find((c) => c.id === clientId);
  if (!client) throw new Error('Client not found');
  client.competitors = client.competitors.filter((c) => c.id !== competitorId);
  await writeAtomic(CLIENTS_FILE, list);
}

// ── Snapshots ────────────────────────────────────────────────────────────────

async function getSnapshot(clientId) {
  return readJson(path.join(SNAPSHOTS_DIR, `${assertSafeFileId(clientId, 'clientId')}.json`), null);
}

async function saveSnapshot(clientId, snapshot) {
  await writeAtomic(path.join(SNAPSHOTS_DIR, `${assertSafeFileId(clientId, 'clientId')}.json`), snapshot);
}

// ── Content Analysis (separate file per client — kept apart from the main
// SEMrush snapshot since it can carry its own sizable page-type data) ───────

async function getContentAnalysis(clientId) {
  return readJson(path.join(CONTENT_ANALYSIS_DIR, `${assertSafeFileId(clientId, 'clientId')}.json`), null);
}

async function saveContentAnalysis(clientId, data) {
  await writeAtomic(path.join(CONTENT_ANALYSIS_DIR, `${assertSafeFileId(clientId, 'clientId')}.json`), data);
}

module.exports = {
  init,
  MAX_COMPETITORS,
  getClients, getClient, createClient, updateClient, deleteClient,
  addCompetitor, removeCompetitor,
  getSnapshot, saveSnapshot,
  getContentAnalysis, saveContentAnalysis,
};
