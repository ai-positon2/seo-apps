-- ═══════════════════════════════════════════════════════════════════════════
-- 0026 — the ten Location Page Builder collection tables this repo never created
--
-- What was broken
-- ────────────────
-- Every Location + Service Pages screen failed on its first read:
--
--     [supabaseStore.list lpb_clients] Could not find the table
--     'public.lpb_clients' in the schema cache
--
-- Not a stale PostgREST cache, and not a botched project transfer: the table
-- genuinely did not exist, because nothing in supabase/migrations/ creates it.
-- locationPageBuilder/store.js pointed at `0001_init.sql` for these tables,
-- but this repo's migration set begins at 0006 and `git log --all
-- --diff-filter=A` shows 0001_init.sql was never committed here at all.
-- Applying every migration in this directory to an empty database has always
-- produced a database this module cannot start against.
--
-- Why 0006 missed them
-- ─────────────────────
-- 0006_missing_prerequisites.sql exists to recover this same loss, and claimed
-- `cache` and `settings` were "the complete set of what 0001-0006 still owed
-- us, not a partial guess". That was wrong, and the reason is worth recording
-- so the mistake is not repeated: the audit behind it grepped for literal
-- `.from('<table>')` call sites. These ten table names are computed at runtime,
-- in store.js:
--
--     function tableFor(collection) {
--       return `lpb_${String(collection).toLowerCase()}`;
--     }
--
-- from the COLLECTIONS array — so the string "lpb_clients" appears NOWHERE in
-- the source tree, and a literal-name audit cannot see it. Only
-- lpb_keywordselections survived, and only because 0009 happened to recreate
-- it for its own reasons. 0006's comment has been corrected in place.
--
-- Verified against the live project before writing this: all ten 404 from
-- PostgREST, while lpb_keywordselections, lpb_keyword_universe, cache and
-- settings are present.
--
-- Shape
-- ──────
-- The generic jsonb collection shape — id/data/created_at/updated_at — exactly
-- as supabaseStore documents its table convention and as lpb_keywordselections
-- (0009) already uses. The FULL record lives in `data`; the columns exist for
-- the primary key, ordering, and expression-indexed filters. No typed columns:
-- unlike lpb_keyword_universe (0007), these are reference and working data
-- read one client at a time, not filtered at scale.
--
-- `data->>'client_id'` is indexed on the nine collections that are read per
-- client. lpb_clients gets no such index: it is the top of the tree and is
-- only ever listed whole (`store.list('clients')`). The index serves deletes
-- as well as reads — replaceAllForClient() clears one client's rows via
-- removeWhere({ client_id }) before reinserting.
--
-- RLS is enabled with no policies, matching every other table in this schema:
-- the app reaches Postgres through the service-role key, which bypasses RLS,
-- so an anon caller hitting PostgREST directly sees nothing. Leaving RLS off
-- would expose all ten to the publishable key.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── L1: brand ──────────────────────────────────────────────────────────────

create table if not exists lpb_clients (
  id          text primary key,           -- e.g. 'client_neuro_wellness_spa'
  data        jsonb not null,             -- { name, brand_static{logo, org_schema,
                                          --   sameAs[], base_url, stats},
                                          --   brand_rules{ymyl,
                                          --   prohibited_claims[],
                                          --   licensing_language},
                                          --   global_template_id }
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists lpb_globaltemplates (
  id          text primary key,           -- e.g. 'gt_neuro_location_service'
  data        jsonb not null,             -- { client_id, page_type,
                                          --   section_order[], section_layouts,
                                          --   seo_head_structure
                                          --   {meta_title_pattern, h1_pattern},
                                          --   schema_skeletons }
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists lpb_toneprofiles (
  id          text primary key,           -- e.g. 'tone_neuro'
  data        jsonb not null,             -- { client_id, voice, reading_level,
                                          --   avg_sentence_length,
                                          --   vocabulary_notes, cta_phrasing[],
                                          --   formatting_habits,
                                          --   structural_signals, sample_urls[],
                                          --   confirmed }
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ── L2: the service × location catalog ─────────────────────────────────────

create table if not exists lpb_services (
  id          text primary key,           -- 'svc_<slug>'
  data        jsonb not null,             -- { client_id, name, slug, category,
                                          --   parent_service_url,
                                          --   related_service_ids[],
                                          --   conditions_treated[],
                                          --   symptoms_addressed[],
                                          --   treatment_process[],
                                          --   available_in_person,
                                          --   available_virtual, teen_available,
                                          --   service_disclaimers }
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists lpb_locations (
  id          text primary key,           -- 'loc_<city-slug>'
  data        jsonb not null,             -- { client_id, location_name, city,
                                          --   state, state_abbreviation,
                                          --   street_address, zip_code,
                                          --   phone_number, latitude, longitude,
                                          --   location_slug, location_page_url,
                                          --   appointment_url, gbp_url,
                                          --   hero_image_url, hero_image_alt,
                                          --   parking_info, nearby_areas[] }
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ── Supporting reference data composed into a page ─────────────────────────

create table if not exists lpb_providers (
  id          text primary key,           -- 'prov_<name>'
  data        jsonb not null,             -- { client_id, name, credentials, title,
                                          --   specialty, bio, image_url,
                                          --   linkedin_url, location_ids[],
                                          --   service_ids[] }
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists lpb_reviews (
  id          text primary key,           -- 'rev_<location>_<n>'
  data        jsonb not null,             -- { client_id, location_id,
                                          --   reviewer_name, rating, text, date,
                                          --   source, approved }
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists lpb_insurancesets (
  id          text primary key,           -- 'ins_<scope>'
  data        jsonb not null,             -- { client_id, location_id (null =
                                          --   brand-wide),
                                          --   providers[{name, logo_url,
                                          --   alt_text}], copy, disclaimer }
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists lpb_resources (
  id          text primary key,           -- 'res_<n>'
  data        jsonb not null,             -- { client_id, title, url, image_url,
                                          --   related_service_ids[],
                                          --   related_condition_tags[],
                                          --   published_date }
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ── The pages themselves ───────────────────────────────────────────────────
-- One row per (client, service, location) tuple. Sub-objects (keyword_set,
-- page_object, qa_result, approvals, versions, comments) are embedded rather
-- than joined — the file-store convention pageService.js was written against.

create table if not exists lpb_pages (
  id          text primary key,           -- 'page_<random>'
  data        jsonb not null,             -- { client_id, service_id, location_id,
                                          --   assignee_id, target_date, status,
                                          --   eligibility, _ymyl, keyword_set,
                                          --   competitor_analysis[], page_object,
                                          --   qa_result, approval_status,
                                          --   approval_records[],
                                          --   section_comments[], versions[],
                                          --   cost_estimate }
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ── Per-client read/delete paths ───────────────────────────────────────────

create index if not exists lpb_globaltemplates_client_idx on lpb_globaltemplates ((data->>'client_id'));
create index if not exists lpb_toneprofiles_client_idx    on lpb_toneprofiles    ((data->>'client_id'));
create index if not exists lpb_services_client_idx        on lpb_services        ((data->>'client_id'));
create index if not exists lpb_locations_client_idx       on lpb_locations       ((data->>'client_id'));
create index if not exists lpb_providers_client_idx       on lpb_providers       ((data->>'client_id'));
create index if not exists lpb_reviews_client_idx         on lpb_reviews         ((data->>'client_id'));
create index if not exists lpb_insurancesets_client_idx   on lpb_insurancesets   ((data->>'client_id'));
create index if not exists lpb_resources_client_idx       on lpb_resources       ((data->>'client_id'));
create index if not exists lpb_pages_client_idx           on lpb_pages           ((data->>'client_id'));

-- ── RLS ────────────────────────────────────────────────────────────────────

alter table lpb_clients         enable row level security;
alter table lpb_globaltemplates enable row level security;
alter table lpb_toneprofiles    enable row level security;
alter table lpb_services        enable row level security;
alter table lpb_locations       enable row level security;
alter table lpb_providers       enable row level security;
alter table lpb_reviews         enable row level security;
alter table lpb_insurancesets   enable row level security;
alter table lpb_resources       enable row level security;
alter table lpb_pages           enable row level security;
