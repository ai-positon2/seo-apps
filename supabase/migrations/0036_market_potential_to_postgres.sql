-- ── Market Potential: services, baskets, cache, scenarios, in the database ──
--
-- The fifth and sixth of the file-backed stores in server/services/dataRoot.js
-- (this module has two: store.js and usageStore.js). Its own header opened with
-- "This app has no Postgres, so the Section 7 relational schema is mapped onto
-- the same atomic-JSON store pattern" — that has not been true for some time,
-- and this migration puts the Section 7 schema where it was designed to go.
--
-- The SEMrush unit ledger in usageStore.js is the part that matters most, and
-- it is the last table here. See its own comment.

create table if not exists market_potential_services (
  id         text primary key,
  data       jsonb not null,
  -- createService() dedupes on the trimmed, lowercased name by scanning the
  -- list and appending when it finds nothing. Two requests naming the same
  -- service at once therefore created it twice, and every later lookup picked
  -- whichever came first. Unique here instead, so the second one collides.
  name_key   text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists market_potential_baskets (
  id         text primary key,
  service_id text not null
    references market_potential_services(id) on delete cascade,
  -- 'draft' (proposed, editable) | 'active' (frozen v_n)
  status     text not null check (status in ('draft', 'active')),
  -- null while a draft; assigned on freeze.
  version    integer,
  data       jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- "Exactly one active (frozen) version per service. Drafts are editable" — the
-- module's own words, now enforced rather than assumed.
create unique index if not exists uq_market_potential_baskets_draft
  on market_potential_baskets (service_id)
  where status = 'draft';

-- freezeBasket() takes max(version)+1 for the service. Read and write were two
-- steps over a JSON file, so two freezes could both read version 3 and both
-- become version 4. This makes the second one fail instead.
create unique index if not exists uq_market_potential_baskets_version
  on market_potential_baskets (service_id, version)
  where status = 'active';

create index if not exists idx_market_potential_baskets_service
  on market_potential_baskets (service_id);

-- One row per (geo, month): a single DataForSEO call covers the whole basket,
-- so that is the grain the cache is keyed at. Was volumeCache.json, a single
-- object that every read parsed in full to look up one key.
create table if not exists market_potential_volume_cache (
  id         text primary key,          -- "<geoId>__<yearMonth>"
  data       jsonb not null,
  fetched_at timestamptz not null default now()
);

create table if not exists market_potential_scenarios (
  id         text primary key,
  user_id    text,
  data       jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_market_potential_scenarios_user
  on market_potential_scenarios (user_id, created_at desc);

-- Executive-summary cache, keyed by a hash of (service, basket version, region
-- set, month, weights). The file version kept it under 500 entries by deleting
-- whichever key happened to be first in object order; this keeps the same bound
-- on a column that actually records age.
create table if not exists market_potential_summaries (
  key        text primary key,
  data       jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_market_potential_summaries_created_at
  on market_potential_summaries (created_at);

-- ── The SEMrush unit ledger ─────────────────────────────────────────────────
--
-- usageStore.js enforces a per-run cap (default 10,000 units) and a system-wide
-- daily cap (default 200,000, resetting at 00:00 UTC) from semrushUsage.json.
-- Two problems, and the second one is the expensive one:
--
--   * On a container platform without a mounted volume the file vanished on
--     every deploy, and the day's recorded spend reset to zero with it. The cap
--     silently stopped being a cap.
--   * Its own header says: "All ledger mutations run through an in-process async
--     mutex -> atomic within this Node process. (A multi-instance deployment
--     would need an external lock; noted.)" This app runs a web process and a
--     module worker, so that caveat was already being violated — two processes
--     could each reserve against the same remaining budget.
--
-- One row per UTC day. reserve() adds its upper-bound estimate and reconcile()
-- refunds the difference, both as single statements, so the total is correct
-- under concurrency across every process sharing this database.
create table if not exists market_potential_semrush_usage (
  day          date primary key,
  -- Units reserved and not yet refunded. A plain numeric so the reserve is one
  -- atomic `set used = used + $1` rather than a read, an add and a write.
  used_units   numeric not null default 0,
  -- The bounded audit trail the file kept as a `runs` array.
  runs         jsonb not null default '[]'::jsonb,
  updated_at   timestamptz not null default now()
);

comment on table market_potential_semrush_usage is
  'SEMrush API unit ledger, one row per UTC day. Was server/modules/marketPotential/data/semrushUsage.json.';
