// ── Persistence — backed by Postgres ─────────────────────────────────────────
// Was clients.json, slackConfig.json and one file per run under history/. Now
// robots_monitor_clients, robots_monitor_runs and one row in the shared
// `settings` table; see supabase/migrations/0035_robots_monitor_to_postgres.sql.
//
// Every exported name, argument, return shape and thrown message is unchanged.
//
// Two things behave better than they read:
//
//   * The nested edits (addDomain, updateDomain, deleteDomain, updateClient)
//     were read-whole-file, mutate, write-whole-file. Two requests overlapping
//     meant the second write dropped whatever the first had just done — adding
//     a domain to two clients at once could lose one of them. Each is a single
//     statement now, touching one row.
//   * pruneHistory deletes by the run's recorded start time instead of parsing
//     it out of a filename, so a run whose id did not match the expected
//     `run_YYYYMMDD_HHmm` shape is now pruned rather than kept for ever.

const db = require('../../services/db');
const recordStore = require('../../services/recordStore');

const SLACK_SETTING_KEY = 'robots_monitor.slack';

function genId(prefix) {
  return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2);
}

// ── Startup init ─────────────────────────────────────────────────────────────
// The tables are created by the migration runner, and "no clients yet" is an
// empty result rather than a file that has to exist. Kept because the module's
// boot path calls it.
async function init() {}

// ── Clients ───────────────────────────────────────────────────────────────────

async function getClients() {
  const found = await db.rows(
    `select data from robots_monitor_clients order by created_at asc, id asc`
  );
  return found.map((r) => r.data);
}

// Replace the whole list. Kept because it is exported and callers use it, but
// it is the one operation here that still overwrites everything: in a
// transaction, so a failure part-way cannot leave the monitor with a half list
// and nothing to check.
async function saveClients(clientsArray) {
  await db.tx(async (t) => {
    await t.query(`delete from robots_monitor_clients`);
    for (const client of clientsArray) {
      await t.query(
        `insert into robots_monitor_clients (id, data, created_at, updated_at)
         values ($1, $2, coalesce($3::timestamptz, now()), now())`,
        [client.id, db.json(client), client.createdAt || null]
      );
    }
  });
}

async function addClient({ name }) {
  const client = {
    id: genId('client'),
    name,
    createdAt: new Date().toISOString(),
    domains: [],
  };
  await db.query(
    `insert into robots_monitor_clients (id, data, created_at, updated_at)
     values ($1, $2, $3, $3)`,
    [client.id, db.json(client), client.createdAt]
  );
  return client;
}

async function updateClient(clientId, { name }) {
  const row = await db.maybeOne(
    `update robots_monitor_clients
        set data = jsonb_set(data, '{name}', to_jsonb($2::text)), updated_at = now()
      where id = $1
    returning data`,
    [clientId, name]
  );
  if (!row) throw new Error(`Client "${clientId}" not found`);
  return row.data;
}

async function deleteClient(clientId) {
  const result = await db.query(
    `delete from robots_monitor_clients where id = $1`, [clientId]
  );
  if (!result.rowCount) throw new Error(`Client "${clientId}" not found`);
}

// ── Domains ───────────────────────────────────────────────────────────────────

async function addDomain(clientId, { url, env, auth = null }) {
  const domain = {
    id: genId('dom'),
    url,
    env,
    auth: auth || null,
    enabled: true,
    addedAt: new Date().toISOString(),
  };
  const row = await db.maybeOne(
    `update robots_monitor_clients
        set data = jsonb_set(
              data, '{domains}',
              coalesce(data->'domains', '[]'::jsonb) || jsonb_build_array($2::jsonb)
            ),
            updated_at = now()
      where id = $1
    returning data`,
    [clientId, db.json(domain)]
  );
  if (!row) throw new Error(`Client "${clientId}" not found`);
  return domain;
}

async function updateDomain(clientId, domainId, fields) {
  // Rebuilt rather than indexed into: the array position of a domain is not
  // stable across concurrent edits, and `jsonb_set(… '{domains,2}' …)` would
  // write over whichever domain happened to be third by the time it ran.
  const row = await db.maybeOne(
    `update robots_monitor_clients
        set data = jsonb_set(
              data, '{domains}',
              coalesce(
                (select jsonb_agg(
                          case when entry->>'id' = $2 then entry || $3::jsonb else entry end
                          order by ordinality)
                   from jsonb_array_elements(coalesce(data->'domains', '[]'::jsonb))
                        with ordinality as t(entry, ordinality)),
                '[]'::jsonb
              )
            ),
            updated_at = now()
      where id = $1
        and exists (
          select 1 from jsonb_array_elements(coalesce(data->'domains', '[]'::jsonb)) entry
           where entry->>'id' = $2
        )
    returning data`,
    [clientId, domainId, db.json(fields)]
  );

  // No row means no such client or no such domain, and those are different
  // messages. Only asked when the update did not land.
  if (!row) {
    const client = await getClientRecord(clientId);
    if (!client) throw new Error(`Client "${clientId}" not found`);
    throw new Error(`Domain "${domainId}" not found`);
  }
  return (row.data.domains || []).find((d) => d.id === domainId);
}

async function deleteDomain(clientId, domainId) {
  const row = await db.maybeOne(
    `update robots_monitor_clients
        set data = jsonb_set(
              data, '{domains}',
              coalesce(
                (select jsonb_agg(entry order by ordinality)
                   from jsonb_array_elements(coalesce(data->'domains', '[]'::jsonb))
                        with ordinality as t(entry, ordinality)
                  where entry->>'id' is distinct from $2),
                '[]'::jsonb
              )
            ),
            updated_at = now()
      where id = $1
        and exists (
          select 1 from jsonb_array_elements(coalesce(data->'domains', '[]'::jsonb)) entry
           where entry->>'id' = $2
        )
    returning data`,
    [clientId, domainId]
  );
  if (!row) {
    const client = await getClientRecord(clientId);
    if (!client) throw new Error(`Client "${clientId}" not found`);
    throw new Error(`Domain "${domainId}" not found`);
  }
}

async function getClientRecord(clientId) {
  const row = await db.maybeOne(
    `select data from robots_monitor_clients where id = $1`, [clientId]
  );
  return row ? row.data : null;
}

// ── Slack config ──────────────────────────────────────────────────────────────

async function getSlackConfig() {
  return (await recordStore.getSetting(SLACK_SETTING_KEY, {})) || {};
}

async function saveSlackConfig(config) {
  await recordStore.setSetting(SLACK_SETTING_KEY, config);
}

// ── History ───────────────────────────────────────────────────────────────────

async function saveRunHistory(runObject) {
  await db.query(
    `insert into robots_monitor_runs (run_id, data, started_at)
     values ($1, $2, $3::timestamptz)
     on conflict (run_id) do update set data = excluded.data, started_at = excluded.started_at`,
    [runObject.runId, db.json(runObject), runObject.startedAt || null]
  );
}

async function getRunHistory({ limit = 30 } = {}) {
  const found = await db.rows(
    `select data from robots_monitor_runs
      order by started_at desc nulls last, run_id desc
      limit $1`,
    [limit]
  );
  // The same summary the file version built. The full run record is available
  // through getRunById; the list does not need it.
  return found.map(({ data }) => ({
    runId: data.runId,
    triggeredBy: data.triggeredBy,
    startedAt: data.startedAt,
    completedAt: data.completedAt,
    durationMs: data.durationMs,
    summary: data.summary,
  }));
}

async function getRunById(runId) {
  const row = await db.maybeOne(
    `select data from robots_monitor_runs where run_id = $1`, [runId]
  );
  return row ? row.data : null;
}

async function pruneHistory(daysToKeep = 90) {
  const cutoff = new Date(Date.now() - daysToKeep * 24 * 60 * 60 * 1000).toISOString();
  // started_at null means the record never carried a start time. Those are kept
  // rather than deleted: the file version could not date them either, and
  // deleting what you cannot date is the wrong way round.
  await db.query(
    `delete from robots_monitor_runs where started_at is not null and started_at < $1`,
    [cutoff]
  );
}

module.exports = {
  init,
  getClients, saveClients, addClient, updateClient, deleteClient,
  addDomain, updateDomain, deleteDomain,
  getSlackConfig, saveSlackConfig,
  saveRunHistory, getRunHistory, getRunById, pruneHistory,
};
