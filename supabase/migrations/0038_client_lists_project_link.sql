-- ── One client, everywhere: give each rival client list a project ───────────
--
-- docs/design-audit/02-plan-one-client.md, step 2 ("add the reference").
--
-- Three tools keep a client list of their own, and none of them says which
-- project (crawl_projects) a record belongs to, so the app header's client
-- cannot drive them. Until now the only link was a best-effort domain match
-- done in the browser (CompetitorAnalysisDashboardPage.jsx, linkedClient).
--
--   competitor_analysis_clients  Competitor Analysis  data->>'domain'
--   robots_monitor_clients       Robots Monitor       data->'domains'[*]->>'url'
--   lpb_clients                  Location Pages       data->'brand_static'->>'base_url'
--
-- The Knowledge Base is the fourth list, but it is a file index
-- (knowledge-base/_index.json), not a table; its entries get a `project_id`
-- field in that index instead (same plan, step 2).
--
-- What this migration does and does not do:
--   * adds a NULLABLE project_id to each table. Nothing reads it yet, so
--     applying it changes no behaviour.
--   * does NOT fill it in. The values come from the reviewed match report
--     (server/scripts/clientListInventory.js), applied as a separate, reviewed
--     step — some records will not match any project and must be assigned by
--     hand ("needs assigning").
--   * `on delete set null`: deleting a project must not delete a tool's history;
--     the record goes back to "needs assigning" instead.
--
-- Rollback: drop the three columns (they hold nothing until the fill step).

alter table competitor_analysis_clients
  add column if not exists project_id uuid references crawl_projects(id) on delete set null;
create index if not exists idx_competitor_analysis_clients_project
  on competitor_analysis_clients (project_id);

alter table robots_monitor_clients
  add column if not exists project_id uuid references crawl_projects(id) on delete set null;
create index if not exists idx_robots_monitor_clients_project
  on robots_monitor_clients (project_id);

alter table lpb_clients
  add column if not exists project_id uuid references crawl_projects(id) on delete set null;
create index if not exists idx_lpb_clients_project
  on lpb_clients (project_id);

comment on column competitor_analysis_clients.project_id is
  'the project this tracker client belongs to; null = needs assigning (docs/design-audit/02-plan-one-client.md)';
comment on column robots_monitor_clients.project_id is
  'the project whose domains this monitor watches; null = needs assigning';
comment on column lpb_clients.project_id is
  'the project this location-page client belongs to; null = needs assigning';
