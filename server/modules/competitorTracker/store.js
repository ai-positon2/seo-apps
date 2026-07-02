const fs = require('fs').promises;
const path = require('path');

const DATA_DIR      = path.join(__dirname, 'data');
const CLIENTS_PATH   = path.join(DATA_DIR, 'clients.json');
const CONFIG_PATH    = path.join(DATA_DIR, 'config.json');
const SEMRUSH_BUDGET_PATH = path.join(DATA_DIR, 'semrushBudget.json');
const SNAPSHOTS_DIR  = path.join(DATA_DIR, 'snapshots');
const INSIGHTS_DIR   = path.join(DATA_DIR, 'insights');
const AI_VISIBILITY_DIR = path.join(DATA_DIR, 'aiVisibility');

function genId(prefix) {
  return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2);
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeAtomic(filePath, data) {
  const tmp = filePath + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await fs.rename(tmp, filePath);
}

// ── Startup init ─────────────────────────────────────────────────────────────

async function init() {
  await ensureDir(DATA_DIR);
  await ensureDir(SNAPSHOTS_DIR);
  await ensureDir(INSIGHTS_DIR);
  await ensureDir(AI_VISIBILITY_DIR);
  try { await fs.access(CLIENTS_PATH); } catch { await fs.writeFile(CLIENTS_PATH, '[]', 'utf8'); }
  try { await fs.access(CONFIG_PATH); }  catch { await fs.writeFile(CONFIG_PATH, '{}', 'utf8'); }
}

// ── Clients ───────────────────────────────────────────────────────────────────

async function getClients() {
  return readJson(CLIENTS_PATH, []);
}

async function getClient(clientId) {
  const clients = await getClients();
  return clients.find(c => c.id === clientId) || null;
}

async function saveClients(clientsArray) {
  await writeAtomic(CLIENTS_PATH, clientsArray);
}

async function addClient({ name, domain, country, brandName }) {
  const clients = await getClients();
  const client = {
    id: genId('client'),
    name,
    domain: domain || '',
    country: country || 'United States',
    brandName: brandName || name,
    competitors: [],
    createdAt: new Date().toISOString(),
  };
  clients.push(client);
  await saveClients(clients);
  return client;
}

async function updateClient(clientId, fields) {
  const clients = await getClients();
  const idx = clients.findIndex(c => c.id === clientId);
  if (idx === -1) throw new Error(`Client "${clientId}" not found`);
  Object.assign(clients[idx], fields);
  await saveClients(clients);
  return clients[idx];
}

async function deleteClient(clientId) {
  const clients = await getClients();
  const idx = clients.findIndex(c => c.id === clientId);
  if (idx === -1) throw new Error(`Client "${clientId}" not found`);
  clients.splice(idx, 1);
  await saveClients(clients);

  for (const dir of [SNAPSHOTS_DIR, INSIGHTS_DIR, AI_VISIBILITY_DIR]) {
    try { await fs.unlink(path.join(dir, `${clientId}.json`)); } catch { /* ignore */ }
  }
}

// ── Competitors ───────────────────────────────────────────────────────────────

async function addCompetitor(clientId, { domain, label }) {
  const clients = await getClients();
  const client = clients.find(c => c.id === clientId);
  if (!client) throw new Error(`Client "${clientId}" not found`);
  const competitor = {
    id: genId('comp'),
    domain,
    label: label || domain,
    addedAt: new Date().toISOString(),
  };
  client.competitors.push(competitor);
  await saveClients(clients);
  return competitor;
}

async function updateCompetitor(clientId, competitorId, fields) {
  const clients = await getClients();
  const client = clients.find(c => c.id === clientId);
  if (!client) throw new Error(`Client "${clientId}" not found`);
  const competitor = client.competitors.find(c => c.id === competitorId);
  if (!competitor) throw new Error(`Competitor "${competitorId}" not found`);
  Object.assign(competitor, fields);
  await saveClients(clients);
  return competitor;
}

async function deleteCompetitor(clientId, competitorId) {
  const clients = await getClients();
  const client = clients.find(c => c.id === clientId);
  if (!client) throw new Error(`Client "${clientId}" not found`);
  const idx = client.competitors.findIndex(c => c.id === competitorId);
  if (idx === -1) throw new Error(`Competitor "${competitorId}" not found`);
  client.competitors.splice(idx, 1);
  await saveClients(clients);
}

// ── Dashboard snapshot (one per client, holds client + all competitors) ───────

async function getDashboardSnapshot(clientId) {
  return readJson(path.join(SNAPSHOTS_DIR, `${clientId}.json`), null);
}

async function saveDashboardSnapshot(clientId, snapshot) {
  await ensureDir(SNAPSHOTS_DIR);
  await writeAtomic(path.join(SNAPSHOTS_DIR, `${clientId}.json`), snapshot);
}

// ── Cached insights (Observation + Recommendation per module) ────────────────

async function getInsights(clientId) {
  return readJson(path.join(INSIGHTS_DIR, `${clientId}.json`), {});
}

async function saveInsights(clientId, insights) {
  await ensureDir(INSIGHTS_DIR);
  await writeAtomic(path.join(INSIGHTS_DIR, `${clientId}.json`), insights);
}

// ── AI Visibility (manually entered — no public SEMrush API for this) ────────

async function getAIVisibility(clientId) {
  return readJson(path.join(AI_VISIBILITY_DIR, `${clientId}.json`), null);
}

async function saveAIVisibility(clientId, data) {
  await ensureDir(AI_VISIBILITY_DIR);
  await writeAtomic(path.join(AI_VISIBILITY_DIR, `${clientId}.json`), { ...data, updatedAt: new Date().toISOString() });
}

// ── Run config (cron schedule) ────────────────────────────────────────────────

async function getRunConfig() {
  const config = await readJson(CONFIG_PATH, {});
  return {
    scheduleTime: config.scheduleTime || '06:00',
    timezone: config.timezone || 'UTC',
    enabled: config.enabled !== false,
  };
}

async function saveRunConfig(config) {
  await writeAtomic(CONFIG_PATH, config);
}

// ── SEMrush credit budget state ───────────────────────────────────────────────

async function getSemrushBudgetState() {
  return readJson(SEMRUSH_BUDGET_PATH, null);
}

async function saveSemrushBudgetState(state) {
  await writeAtomic(SEMRUSH_BUDGET_PATH, state);
}

module.exports = {
  init,
  getClients, getClient, saveClients, addClient, updateClient, deleteClient,
  addCompetitor, updateCompetitor, deleteCompetitor,
  getDashboardSnapshot, saveDashboardSnapshot,
  getInsights, saveInsights,
  getAIVisibility, saveAIVisibility,
  getRunConfig, saveRunConfig,
  getSemrushBudgetState, saveSemrushBudgetState,
};
