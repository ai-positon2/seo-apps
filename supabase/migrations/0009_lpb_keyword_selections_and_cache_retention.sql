-- ═══════════════════════════════════════════════════════════════════════════
-- Location Page Builder — durable keyword approvals + enforceable cache
-- retention.
--
-- 1. lpb_keywordselections. Until now the SEO team's APPROVED primary/secondary
--    keywords were persisted only as a side effect of generating a page (as
--    bare strings on page_object) — approve and navigate away before
--    generating and the work was lost, and re-opening a saved page re-ran the
--    BILLED research call. This gives the approval its own permanent record,
--    keyed by the same (client, service, location) tuple the page row uses.
--    Generic jsonb collection shape (matches the supabaseStore adapter and
--    every other lpb_* table): rows are fetched by tuple and listed, never
--    filtered at scale, so no typed columns are warranted.
--
-- 2. cache.kind / cache.expires_at. The cache table is keyed by an opaque sha1
--    with TTL applied ON READ only (supabaseStore.cacheGet), so nothing is
--    ever physically deleted and the table grows without bound — every
--    superseded hand-bumped key ('dental-kw-adapter-v8' and friends) is still
--    a live row. created_at can't be used for age-based cleanup either,
--    because cacheSet rewrites it on every upsert. These two columns make
--    retention both attributable (which rows are the billed SEMrush pulls?)
--    and enforceable (see server/jobs/cachePurge.js).
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists lpb_keywordselections (
  id          text primary key,
  data        jsonb not null,             -- { tuple_key, client_id, service_id,
                                          --   location_id, primary[], secondary[],
                                          --   candidates[], approved_at }
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- tuple_key is what store.upsertBy matches on (one selection per
-- client+service+location, mirroring the one-page-per-tuple rule).
create index if not exists lpb_kwsel_tuple_idx  on lpb_keywordselections ((data->>'tuple_key'));
create index if not exists lpb_kwsel_client_idx on lpb_keywordselections ((data->>'client_id'));

alter table lpb_keywordselections enable row level security;

-- ── Cache retention ────────────────────────────────────────────────────────
alter table cache add column if not exists kind       text;
alter table cache add column if not exists expires_at timestamptz;

-- Partial index: the purge job only ever scans rows that carry an expiry.
create index if not exists cache_expires_idx on cache (expires_at) where expires_at is not null;
create index if not exists cache_kind_idx    on cache (kind)       where kind is not null;
