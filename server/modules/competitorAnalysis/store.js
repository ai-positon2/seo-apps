// ── Persistence — backed by Postgres ─────────────────────────────────────────
// Was clients.json plus a snapshot and a content-analysis file per client. Now
// competitor_analysis_clients and competitor_analysis_artifacts; see
// supabase/migrations/0033_competitor_analysis_to_postgres.sql for why.
//
// Every exported name, argument, return shape and thrown message is unchanged,
// so routes.js and the client need no changes.
//
// What the move fixed beyond durability: addCompetitor()'s four-competitor cap
// and removeCompetitor() were read-modify-write over a whole JSON file, so two
// requests arriving together could both read three competitors and both append
// — a fifth competitor past a cap that had just been checked, or one request's
// removal undone by the other's write. Both are single statements now, and the
// cap is enforced inside the one that does the appending.

const db = require('../../services/db');
const crypto = require('crypto');

const MAX_COMPETITORS = 4;

function genId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${crypto.randomBytes(4).toString('hex')}`;
}

// The tables are created by the migration runner (scripts/migrate.js), so there
// is nothing to make on boot. Kept because server.js and the routes call it,
// and because "this module needs no setup" is worth saying once rather than
// leaving callers to discover a missing export.
async function init() {}

const stripScheme = (domain) => String(domain).replace(/^https?:\/\//, '').replace(/\/$/, '');

// ── Clients ──────────────────────────────────────────────────────────────────

async function getClients() {
  const found = await db.rows(
    `select data from competitor_analysis_clients order by created_at asc, id asc`
  );
  return found.map((r) => r.data);
}

async function getClient(clientId) {
  const row = await db.maybeOne(
    `select data from competitor_analysis_clients where id = $1`, [clientId]
  );
  return row ? row.data : null;
}

async function createClient({ name, domain, country, brandName }) {
  if (!name || !domain) throw new Error('name and domain are required');
  const client = {
    id: genId('client'),
    name,
    domain: stripScheme(domain),
    country: country || 'United States',
    brandName: brandName || name,
    competitors: [],
    createdAt: new Date().toISOString(),
  };
  await db.query(
    `insert into competitor_analysis_clients (id, data, created_at, updated_at)
     values ($1, $2, $3, $3)`,
    [client.id, db.json(client), client.createdAt]
  );
  return client;
}

async function updateClient(clientId, patch) {
  // id and competitors are pinned exactly as the file version pinned them: a
  // patch may not rename the record or edit the competitor list through the
  // back door (addCompetitor/removeCompetitor own that).
  const safe = { ...patch };
  delete safe.id;
  delete safe.competitors;

  const row = await db.maybeOne(
    `update competitor_analysis_clients
        set data = data || $2::jsonb, updated_at = now()
      where id = $1
    returning data`,
    [clientId, db.json(safe)]
  );
  if (!row) throw new Error('Client not found');
  return row.data;
}

async function deleteClient(clientId) {
  // The snapshot and the content analysis go with it: ON DELETE CASCADE in
  // 0033. assertSafeFileId is gone with the paths it was guarding — clientId
  // arrived here from req.params and was interpolated into two file paths.
  await db.query(`delete from competitor_analysis_clients where id = $1`, [clientId]);
}

// ── Competitors ──────────────────────────────────────────────────────────────

async function addCompetitor(clientId, { domain, label }) {
  if (!domain) throw new Error('domain is required');
  const competitor = {
    id: genId('comp'),
    domain: stripScheme(domain),
    label: label || domain,
    addedAt: new Date().toISOString(),
  };

  // The cap is part of the UPDATE, so it is evaluated against the list as it is
  // at the moment of the append rather than against a copy read earlier.
  const row = await db.maybeOne(
    `update competitor_analysis_clients
        set data = jsonb_set(
              data, '{competitors}',
              coalesce(data->'competitors', '[]'::jsonb) || jsonb_build_array($2::jsonb)
            ),
            updated_at = now()
      where id = $1
        and jsonb_array_length(coalesce(data->'competitors', '[]'::jsonb)) < $3
    returning data`,
    [clientId, db.json(competitor), MAX_COMPETITORS]
  );

  // No row means either no such client or a full list, and the two have
  // different messages. Only asked when the append did not happen.
  if (!row) {
    const client = await getClient(clientId);
    if (!client) throw new Error('Client not found');
    throw new Error(`Maximum of ${MAX_COMPETITORS} competitors per client`);
  }
  return competitor;
}

async function removeCompetitor(clientId, competitorId) {
  const row = await db.maybeOne(
    `update competitor_analysis_clients
        set data = jsonb_set(
              data, '{competitors}',
              coalesce(
                (select jsonb_agg(entry)
                   from jsonb_array_elements(coalesce(data->'competitors', '[]'::jsonb)) entry
                  where entry->>'id' is distinct from $2),
                '[]'::jsonb
              )
            ),
            updated_at = now()
      where id = $1
    returning data`,
    [clientId, competitorId]
  );
  if (!row) throw new Error('Client not found');
}

// ── Per-client artifacts ─────────────────────────────────────────────────────

async function getArtifact(clientId, kind) {
  const row = await db.maybeOne(
    `select data from competitor_analysis_artifacts where client_id = $1 and kind = $2`,
    [clientId, kind]
  );
  return row ? row.data : null;
}

async function saveArtifact(clientId, kind, payload) {
  await db.query(
    `insert into competitor_analysis_artifacts (client_id, kind, data)
     values ($1, $2, $3)
     on conflict (client_id, kind)
       do update set data = excluded.data, updated_at = now()`,
    [clientId, kind, db.json(payload)]
  );
}

const getSnapshot = (clientId) => getArtifact(clientId, 'snapshot');
const saveSnapshot = (clientId, snapshot) => saveArtifact(clientId, 'snapshot', snapshot);

// Kept apart from the main SEMrush snapshot since it can carry its own sizable
// page-type data.
const getContentAnalysis = (clientId) => getArtifact(clientId, 'content_analysis');
const saveContentAnalysis = (clientId, data) => saveArtifact(clientId, 'content_analysis', data);

module.exports = {
  init,
  MAX_COMPETITORS,
  getClients, getClient, createClient, updateClient, deleteClient,
  addCompetitor, removeCompetitor,
  getSnapshot, saveSnapshot,
  getContentAnalysis, saveContentAnalysis,
};
