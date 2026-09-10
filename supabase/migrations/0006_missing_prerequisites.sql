-- ═══════════════════════════════════════════════════════════════════════════
-- Prerequisites that migrations 0001-0006 created, and which this repo lost.
--
-- The migration set here begins at 0007. Whatever created the app's two
-- generic key/value tables was in the missing files, so applying this repo to
-- an EMPTY database used to die three files in:
--
--     0009_lpb_keyword_selections_and_cache_retention.sql
--     relation "cache" does not exist
--
-- because 0009 does `alter table cache add column ...` against a table nothing
-- here creates. That failure is the whole reason this file exists.
--
-- Two tables are recovered here. An audit of every `.from('<table>')` call in
-- server/ against every `create table` in this directory found exactly these
-- two queried-but-never-created — the other 33 are all accounted for.
--
-- CORRECTION (see 0026_lpb_collections.sql): this file used to claim that made
-- the above "the complete set of what 0001-0006 still owed us, not a partial
-- guess". It was a partial guess. The audit could only see table names written
-- as literals, and the Location Page Builder's ten collection tables are named
-- at runtime by store.js's tableFor() — `lpb_${collection.toLowerCase()}` — so
-- the string "lpb_clients" occurs nowhere in server/ for a grep to find. All
-- ten were missing too, and every Location + Service Pages screen was dead on
-- its first read until 0026 created them. Do not treat the count above as a
-- clean bill of health, and do not audit this schema by grepping for literal
-- table names.
--
-- The column shapes are recovered from the only consumer of either table,
-- server/services/supabaseStore.js:
--
--   cache     cacheSet() upserts { id, data, created_at, updated_at } on
--             conflict of `id`, where `id` is a sha1 hex digest (cacheKey())
--             and `data` is { at: <epoch ms>, value: <payload> }. purgeExpired()
--             filters on `data->at`. The `kind` and `expires_at` columns are
--             deliberately NOT created here — 0009 adds them, and duplicating
--             them would make that migration's `add column if not exists` a
--             silent no-op, hiding a real ordering problem later.
--
--   settings  getSetting()/setSetting() read `value` by `key` and upsert
--             { key, value, updated_at } on conflict of `key`.
--
-- RLS is enabled with no policies, matching the rest of this schema: the app
-- reaches Postgres only through the service-role key, which bypasses RLS, so
-- an anon caller hitting PostgREST directly sees nothing. Leaving RLS off
-- would expose both tables to the publishable key.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists cache (
  id          text primary key,          -- sha1 hex from supabaseStore.cacheKey()
  data        jsonb not null,            -- { at: <epoch ms>, value: <payload> }
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- `value` stays nullable: setSetting(key, null) is a legitimate way to clear a
-- setting, and a not-null constraint would turn that into a write failure.
create table if not exists settings (
  key         text primary key,
  value       jsonb,
  updated_at  timestamptz not null default now()
);

alter table cache    enable row level security;
alter table settings enable row level security;
