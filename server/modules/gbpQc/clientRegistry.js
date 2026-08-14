// Reads per-client GBP brand-guideline JSON files from clients/ — pure data,
// no persistence layer needed since new clients are onboarded by hand-adding
// a JSON file here, exactly as in the original standalone tool this was
// ported from.
const fs = require('fs');
const path = require('path');

const CLIENTS_DIR = path.join(__dirname, 'clients');

function listClients() {
  const clients = [];
  for (const file of fs.readdirSync(CLIENTS_DIR).sort()) {
    if (!file.endsWith('.json')) continue;
    try {
      const data = JSON.parse(fs.readFileSync(path.join(CLIENTS_DIR, file), 'utf8'));
      clients.push({ id: data.client_id, name: data.client_name });
    } catch {
      continue;
    }
  }
  return clients;
}

function loadClient(clientId) {
  const filepath = path.join(CLIENTS_DIR, `${clientId}.json`);
  if (!fs.existsSync(filepath)) {
    throw new Error(`No guidelines file found for client: ${clientId}`);
  }
  return JSON.parse(fs.readFileSync(filepath, 'utf8'));
}

module.exports = { listClients, loadClient };
