-- ── Robots Monitor: clients, domains and run history, in the database ───────
--
-- The fourth of the six file-backed modules in server/services/dataRoot.js.
-- This one is a scheduled monitor, which makes losing its state worse than
-- losing a report: the clients.json it kept IS the list of what to check, so an
-- empty data root does not show an empty screen, it silently monitors nothing.
--
-- The Slack webhook configuration does not get a table. It is a single
-- key/value document and goes in the shared `settings` table that
-- services/recordStore.js already reads and writes.

create table if not exists robots_monitor_clients (
  id         text primary key,
  -- The client with its domains nested, exactly as clients.json held it. Same
  -- reasoning as 0033's competitors: every read wants the client and its
  -- domains together, and nothing queries domains across clients.
  data       jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists robots_monitor_runs (
  run_id     text primary key,
  data       jsonb not null,
  -- Mirrored out of the record so history can be ordered and pruned by the
  -- database. Both used to be done by parsing the FILENAME: getRunHistory
  -- sorted directory entries as strings, and pruneHistory picked the date out
  -- of `run_YYYYMMDD_HHmm.json` with a regex and skipped any file whose name
  -- did not match — so a run saved under any other name was never pruned and
  -- accumulated forever.
  started_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_robots_monitor_runs_started_at
  on robots_monitor_runs (started_at desc nulls last);

comment on table robots_monitor_clients is
  'Robots Monitor clients and the domains they watch. Was server/modules/robotsMonitor/data/clients.json.';
comment on table robots_monitor_runs is
  'Robots Monitor run history. Was one JSON file per run under data/history/.';
