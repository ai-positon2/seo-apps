const fs = require('fs').promises;
const path = require('path');

const { resolveDataRoot } = require('../../services/dataRoot');

// Ephemeral inside the image on a container platform; see services/dataRoot.js.
const DATA_DIR    = resolveDataRoot(
  'robots-monitor', path.join(__dirname, 'data'), 'ROBOTS_MONITOR_DATA_ROOT',
);
const CLIENTS_PATH = path.join(DATA_DIR, 'clients.json');
const SLACK_PATH   = path.join(DATA_DIR, 'slackConfig.json');
const HISTORY_DIR  = path.join(DATA_DIR, 'history');

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
  await ensureDir(HISTORY_DIR);
  try { await fs.access(CLIENTS_PATH); } catch { await fs.writeFile(CLIENTS_PATH, '[]', 'utf8'); }
  try { await fs.access(SLACK_PATH); }  catch { await fs.writeFile(SLACK_PATH,  '{}', 'utf8'); }
}

// ── Clients ───────────────────────────────────────────────────────────────────

async function getClients() {
  return readJson(CLIENTS_PATH, []);
}

async function saveClients(clientsArray) {
  await writeAtomic(CLIENTS_PATH, clientsArray);
}

async function addClient({ name }) {
  const clients = await getClients();
  const client = {
    id: genId('client'),
    name,
    createdAt: new Date().toISOString(),
    domains: [],
  };
  clients.push(client);
  await saveClients(clients);
  return client;
}

async function updateClient(clientId, { name }) {
  const clients = await getClients();
  const idx = clients.findIndex(c => c.id === clientId);
  if (idx === -1) throw new Error(`Client "${clientId}" not found`);
  clients[idx].name = name;
  await saveClients(clients);
  return clients[idx];
}

async function deleteClient(clientId) {
  const clients = await getClients();
  const idx = clients.findIndex(c => c.id === clientId);
  if (idx === -1) throw new Error(`Client "${clientId}" not found`);
  clients.splice(idx, 1);
  await saveClients(clients);
}

async function addDomain(clientId, { url, env, auth = null }) {
  const clients = await getClients();
  const client = clients.find(c => c.id === clientId);
  if (!client) throw new Error(`Client "${clientId}" not found`);
  const domain = {
    id: genId('dom'),
    url,
    env,
    auth: auth || null,
    enabled: true,
    addedAt: new Date().toISOString(),
  };
  client.domains.push(domain);
  await saveClients(clients);
  return domain;
}

async function updateDomain(clientId, domainId, fields) {
  const clients = await getClients();
  const client = clients.find(c => c.id === clientId);
  if (!client) throw new Error(`Client "${clientId}" not found`);
  const dom = client.domains.find(d => d.id === domainId);
  if (!dom) throw new Error(`Domain "${domainId}" not found`);
  Object.assign(dom, fields);
  await saveClients(clients);
  return dom;
}

async function deleteDomain(clientId, domainId) {
  const clients = await getClients();
  const client = clients.find(c => c.id === clientId);
  if (!client) throw new Error(`Client "${clientId}" not found`);
  const idx = client.domains.findIndex(d => d.id === domainId);
  if (idx === -1) throw new Error(`Domain "${domainId}" not found`);
  client.domains.splice(idx, 1);
  await saveClients(clients);
}

// ── Slack config ──────────────────────────────────────────────────────────────

async function getSlackConfig() {
  return readJson(SLACK_PATH, {});
}

async function saveSlackConfig(config) {
  await writeAtomic(SLACK_PATH, config);
}

// ── History ───────────────────────────────────────────────────────────────────

async function saveRunHistory(runObject) {
  await ensureDir(HISTORY_DIR);
  const filePath = path.join(HISTORY_DIR, `${runObject.runId}.json`);
  await fs.writeFile(filePath, JSON.stringify(runObject, null, 2), 'utf8');
}

async function getRunHistory({ limit = 30 } = {}) {
  await ensureDir(HISTORY_DIR);
  let files;
  try {
    files = await fs.readdir(HISTORY_DIR);
  } catch {
    return [];
  }
  const jsonFiles = files.filter(f => f.endsWith('.json')).sort().reverse();
  const sliced = jsonFiles.slice(0, limit);

  const results = [];
  for (const file of sliced) {
    try {
      const raw = JSON.parse(await fs.readFile(path.join(HISTORY_DIR, file), 'utf8'));
      results.push({
        runId: raw.runId,
        triggeredBy: raw.triggeredBy,
        startedAt: raw.startedAt,
        completedAt: raw.completedAt,
        durationMs: raw.durationMs,
        summary: raw.summary,
      });
    } catch {
      // skip corrupt files
    }
  }
  return results;
}

async function getRunById(runId) {
  const filePath = path.join(HISTORY_DIR, `${runId}.json`);
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch {
    return null;
  }
}

async function pruneHistory(daysToKeep = 90) {
  await ensureDir(HISTORY_DIR);
  let files;
  try {
    files = await fs.readdir(HISTORY_DIR);
  } catch {
    return;
  }
  const cutoff = Date.now() - daysToKeep * 24 * 60 * 60 * 1000;
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    // filename: run_YYYYMMDD_HHmm.json
    const m = file.match(/run_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})/);
    if (!m) continue;
    const fileDate = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00Z`).getTime();
    if (fileDate < cutoff) {
      try { await fs.unlink(path.join(HISTORY_DIR, file)); } catch { /* ignore */ }
    }
  }
}

module.exports = {
  init,
  getClients, saveClients, addClient, updateClient, deleteClient,
  addDomain, updateDomain, deleteDomain,
  getSlackConfig, saveSlackConfig,
  saveRunHistory, getRunHistory, getRunById, pruneHistory,
};
