-- ═══════════════════════════════════════════════════════════════════════════
-- 0018 — ai_visibility: the extracted entities the nine reports are built on
--
-- Why this exists
-- ───────────────
-- 0016 stores one row per capture and records, of the whole answer, only:
-- did OUR brand appear (a boolean), and roughly where (a character offset).
-- That is enough for a single visibility percentage and nothing else.
--
-- METRICS.md needs, per capture: every brand named with its ORDINAL, mention
-- count and sentiment; every citation with inline-vs-retrieved, position and
-- classification; and perception attribute terms. Eight of the nine reports
-- are aggregations over those three things. None of them can be computed from
-- what 0016 stores, and none can be recovered later by re-reading a boolean.
--
--   project_brands      the measured set — client + competitors, with the
--                       alias sets that make matching possible at all
--   capture_mention     one row per (capture, brand) actually named
--   capture_citation    one row per (capture, source) cited or retrieved
--   capture_attribute   one row per (capture, brand, perception term)
--
-- Extraction happens ONCE at ingest and is stored (METRICS.md §2). Nothing
-- here is computed by scanning answer_text at query time — a report that
-- re-parsed answers on every load would give different numbers as the parser
-- changed, and could not reproduce a past period at all.
--
-- Additive and re-runnable. No RLS: every query carries its own project
-- filter, and that filter IS the tenancy check (see 0012-0017).
--
-- ── The nullable columns that matter ───────────────────────────────────────
-- `sentiment_score` is NULLABLE and that is load-bearing. The decision on
-- record is to ship sentiment UNCALIBRATED and tune later, with the metric
-- hidden from client-facing views until METRICS.md §3.6's 100-capture audit
-- is done. NULL means "not scored", which is a different claim from 50
-- ("neutral") — and §3.6 is explicit that bare directory listings must land
-- 50, so a default of 50 would silently manufacture that verdict.
--
-- `capture_citation.url` is NULLABLE because it genuinely depends on the
-- engine. Measured: Google exposes full destination URLs; ChatGPT exposes
-- the source DOMAIN only (its citations are favicon chips, not links). So
-- METRICS.md §5.2/§6, which key on domain, work everywhere, while §5.4's
-- URLs report is only answerable from the Google surfaces. Storing a guessed
-- URL to fill the column would make that gap invisible.
-- ═══════════════════════════════════════════════════════════════════════════


-- ── 1. The measured set ────────────────────────────────────────────────────
--
-- METRICS.md §3.4 defines share of voice over "the client + the competitors
-- configured for the client", with everything else in an `other` bucket that
-- is EXCLUDED from the denominator. That set has to be an explicit, stable
-- list — deriving it per run from project_domains would silently move the
-- denominator every time somebody edits a domain.
--
-- Aliases are the reason this table is not just a view over project_domains.
-- §2.1 needs legal name, trading name, misspellings and location-suffixed
-- variants to match at all, and competitor "names" today are domain stems
-- ("aspendental", not "Aspen Dental"). Those are DERIVED then human-approved,
-- so the row carries a review state of its own.

create table if not exists project_brands (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references crawl_projects(id) on delete cascade,
  workspace_id  uuid references workspaces(id) on delete set null,

  name          text not null,
  domain        text,
  -- Exactly one brand per project should be the client. Enforced by a partial
  -- unique index below rather than a CHECK, which cannot see other rows.
  is_client     boolean not null default false,

  -- Match forms, longest-first at match time. Stored as given so a reviewer
  -- can see precisely what will be matched on.
  aliases       jsonb not null default '[]'::jsonb,

  -- Derived aliases are proposed, never used until approved: a wrong alias
  -- silently corrupts visibility and share of voice for that client, and does
  -- it invisibly, which is the worst failure mode this module has.
  status        text not null default 'proposed'
                check (status in ('proposed', 'approved', 'rejected')),
  alias_source  text check (alias_source in ('derived', 'manual', 'imported')),
  approved_at   timestamptz,
  approved_by   uuid references app_users(id) on delete set null,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create unique index if not exists uq_project_brand_name
  on project_brands (project_id, lower(btrim(name)));

-- One client per project. Partial, so competitors are unconstrained.
create unique index if not exists uq_project_single_client
  on project_brands (project_id) where is_client;

create index if not exists idx_project_brands_measured
  on project_brands (project_id) where status = 'approved';


-- ── 2. Mentions ────────────────────────────────────────────────────────────
--
-- One row per brand actually named in a capture. A brand NOT named has no
-- row — absence is the absence of a row, never a row with zero, so that a
-- count of rows is directly the numerator §3.2 asks for.

create table if not exists capture_mention (
  id            uuid primary key default gen_random_uuid(),
  capture_id    uuid not null references ai_visibility_captures(id) on delete cascade,
  brand_id      uuid not null references project_brands(id) on delete cascade,
  project_id    uuid not null references crawl_projects(id) on delete cascade,

  -- §3.5: rank of this brand's FIRST mention among the distinct brands in the
  -- answer, ordered by char_offset. 1 = named first. For a map/card answer the
  -- card's position IS the ordinal, which is a truer reading than a character
  -- offset into prose.
  ordinal       integer not null check (ordinal >= 1),
  char_offset   integer check (char_offset >= 0),
  mention_count integer not null default 1 check (mention_count >= 1),

  -- 0-100, or NULL for "not scored" — see the header. Never defaulted to 50.
  sentiment_score integer check (sentiment_score between 0 and 100),

  -- §2.1 rule 3: "not affiliated with X", "unlike X", "X has closed". A
  -- negated mention is stored rather than dropped, because "the model warned
  -- against this client" is a finding, not an absence — but it must not count
  -- toward visibility.
  negated       boolean not null default false,
  is_client     boolean not null default false,

  -- The verbatim clause the extractor matched on. §2.1's anti-hallucination
  -- guard: a brand whose evidence is not a literal substring of answer_text
  -- is discarded, and keeping the evidence is what makes that auditable after
  -- the fact.
  evidence      text,

  created_at    timestamptz not null default now()
);

create unique index if not exists uq_capture_mention
  on capture_mention (capture_id, brand_id);
create index if not exists idx_capture_mention_brand
  on capture_mention (brand_id, created_at desc);
create index if not exists idx_capture_mention_project
  on capture_mention (project_id, created_at desc);


-- ── 3. Citations ───────────────────────────────────────────────────────────
--
-- §2.2: deduplicated per capture by normalised URL — one capture citing the
-- same URL three times is ONE row. Where only a domain is available (ChatGPT),
-- the honest equivalent is one row per host, with `occurrences` carrying the
-- repetition instead of inventing distinct pages.

create table if not exists capture_citation (
  id            uuid primary key default gen_random_uuid(),
  capture_id    uuid not null references ai_visibility_captures(id) on delete cascade,
  project_id    uuid not null references crawl_projects(id) on delete cascade,

  -- NULL when the engine exposes no path — see the header.
  url           text,
  -- Registrable domain (public-suffix aware: bbc.co.uk, not co.uk).
  domain        text not null,
  -- Full hostname, so adanews.ada.org and ada.org stay distinguishable in the
  -- Hosts view (§5.1).
  host          text not null,

  -- §2.2: two different questions. inline = a source the reader can see and
  -- click; retrieved = the model fetched or was served it, surfaced or not.
  -- §4's average_citation counts INLINE only, §5's retrieval metrics count
  -- everything, and conflating them changes both numbers.
  is_inline_cited boolean not null default false,
  is_retrieved    boolean not null default false,
  position        integer check (position >= 0),
  occurrences     integer not null default 1 check (occurrences >= 1),

  -- §5.3/§5.4. Stored AS OF INGEST, never recomputed at query time: a past
  -- period's percentages must stay reproducible, so the ruleset that produced
  -- them travels with the row.
  url_type      text check (url_type in ('homepage','profile','category','product','article','listicle','discussion','other')),
  domain_type   text check (domain_type in ('you','competitor','corporate','institutional','ugc','editorial','reference','other')),
  ruleset_version text,

  title         text,
  created_at    timestamptz not null default now()
);

-- One row per source per capture. COALESCE so a NULL url (domain-only
-- engines) still dedupes on host rather than inserting unbounded duplicates.
create unique index if not exists uq_capture_citation
  on capture_citation (capture_id, coalesce(url, host));
create index if not exists idx_capture_citation_domain
  on capture_citation (project_id, domain, created_at desc);
create index if not exists idx_capture_citation_type
  on capture_citation (project_id, domain_type) where domain_type is not null;


-- ── 4. Perception attributes ───────────────────────────────────────────────
--
-- §7.1. The term → attribute assignment is an embedding-similarity match a
-- human reviews, so both the raw term and the mapping version are stored:
-- historical association scores must not move when the mapping is retuned.

create table if not exists capture_attribute (
  id            uuid primary key default gen_random_uuid(),
  capture_id    uuid not null references ai_visibility_captures(id) on delete cascade,
  brand_id      uuid not null references project_brands(id) on delete cascade,
  project_id    uuid not null references crawl_projects(id) on delete cascade,

  term          text not null,          -- the exact word/phrase the model used
  attribute_id  text,                   -- the bucket it rolls into, null = unmapped
  occurrences   integer not null default 1 check (occurrences >= 1),
  mapping_version text,

  created_at    timestamptz not null default now()
);

create unique index if not exists uq_capture_attribute
  on capture_attribute (capture_id, brand_id, lower(btrim(term)));
create index if not exists idx_capture_attribute_rollup
  on capture_attribute (project_id, attribute_id) where attribute_id is not null;


-- ── 5. Columns the reports need on existing tables ─────────────────────────

alter table ai_visibility_captures
  -- §2.1 rule 3: an answer about the wrong market ("if you mean Hanover,
  -- Germany…"). EXCLUDED from visibility but COUNTED in coverage — it is a
  -- successful capture of an irrelevant answer, not a failed one.
  add column if not exists off_geo boolean not null default false,
  -- §2.3, straight from the provider payload, never inferred from text:
  -- web_search | map | shopping | images | fanout | prose.
  --
  -- `map` is not decorative. A local query returns a map of business cards
  -- rather than prose, and prose-only reading records a FALSE ABSENCE on
  -- exactly the queries a local business cares about. Flagging the shape is
  -- what lets map and prose answers be reported separately rather than
  -- silently averaged.
  add column if not exists features text[] not null default '{}',
  -- Which extraction ruleset produced this row's entities (§11).
  add column if not exists extraction_version text,
  add column if not exists extracted_at timestamptz;

create index if not exists idx_captures_unextracted
  on ai_visibility_captures (project_id, captured_at)
  where extracted_at is null;

alter table ai_visibility_prompts
  -- §8 prompt metadata. Set at creation and editable, never derived per
  -- period — deriving it would rewrite history every time a period is
  -- recomputed.
  add column if not exists location text,
  add column if not exists branding text check (branding is null or branding in ('branded', 'non_branded')),
  add column if not exists tags text[] not null default '{}';


-- ── 6. updated_at ──────────────────────────────────────────────────────────
drop trigger if exists project_brands_touch on project_brands;
create trigger project_brands_touch
  before update on project_brands
  for each row execute function platform_touch_updated_at();


-- ═══════════════════════════════════════════════════════════════════════════
-- Verification
-- ═══════════════════════════════════════════════════════════════════════════
-- Only one client per project:
--   insert into project_brands (project_id, name, is_client) values ('<pid>','A',true);
--   insert into project_brands (project_id, name, is_client) values ('<pid>','B',true);
--   -- expected: second violates uq_project_single_client
--
-- A brand cannot be counted twice in one capture:
--   insert the same (capture_id, brand_id) twice
--   -- expected: violates uq_capture_mention
--
-- Sentiment must stay unscored rather than defaulting to neutral:
--   insert into capture_mention (...) with no sentiment_score
--   select sentiment_score from capture_mention where id = '<id>';
--   -- expected: NULL, never 50
--
-- Rollback (development only — discards every extracted entity):
--   drop table if exists capture_attribute, capture_citation, capture_mention;
--   drop table if exists project_brands;
--   alter table ai_visibility_captures
--     drop column off_geo, drop column features,
--     drop column extraction_version, drop column extracted_at;
--   alter table ai_visibility_prompts
--     drop column location, drop column branding, drop column tags;
-- ═══════════════════════════════════════════════════════════════════════════
