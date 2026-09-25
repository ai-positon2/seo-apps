-- ── Competitor Research: clients and snapshots, in the database ─────────────
--
-- The second of the two modules whose report id was stored in Postgres while
-- the report itself lived on the server's disk. project_module_runs.payload
-- carries reportRef = a competitor-analysis CLIENT id
-- (server/modules/projects/moduleRunners.js), the dashboard card links to
-- /competitor-analysis?client=<that id>, and the id was then resolved against
-- clients.json on whichever machine happened to serve the request. When it was
-- not there the screen said "Client not found" under a card that was showing a
-- score — the same failure Content Architect had in 0032, with a different noun.
--
-- Ids keep their "client_..." / "comp_..." shape for the same reason as 0032:
-- they are already referenced from project_module_runs payloads and from URLs.

create table if not exists competitor_analysis_clients (
  id         text primary key,
  -- The whole client record, competitors array included. The competitors stay
  -- NESTED rather than becoming their own table: every read wants the client
  -- with its competitors, the cap is four, and updateClient()'s contract is
  -- that a patch cannot disturb them — which is one jsonb_set here and a
  -- join plus a guard if they were split out.
  data       jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- The module lists clients by name, and the project dashboard looks one up by
-- the domain it tracks.
create index if not exists idx_competitor_analysis_clients_domain
  on competitor_analysis_clients ((data->>'domain'));

-- ── The two per-client payloads ─────────────────────────────────────────────
-- snapshots/<id>.json and content-analysis/<id>.json. One row each, keyed by
-- the pair, for the same reason 0032 keeps Content Architect's four that way.
--
-- Kept out of the client row itself because a SEMrush snapshot is large and the
-- client list is read on every screen in the module.
create table if not exists competitor_analysis_artifacts (
  client_id  text not null
    references competitor_analysis_clients(id) on delete cascade,
  kind       text not null check (kind in ('snapshot', 'content_analysis')),
  data       jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (client_id, kind)
);

comment on table competitor_analysis_clients is
  'Competitor Research clients and their tracked competitors. Was server/modules/competitorAnalysis/data/clients.json.';
comment on table competitor_analysis_artifacts is
  'Competitor Research per-client payloads: the SEMrush snapshot and the page-type content analysis.';
