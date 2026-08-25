-- ═══════════════════════════════════════════════════════════════════════════
-- 0015 — project_pages: give a page an identity
--
-- Why this exists
-- ───────────────
-- The app is full of URLs and nothing owns one. Every index on a URL in the
-- schema before this migration is scoped to a run:
--
--   idx_crawl_run_links_to    (run_id, to_url)
--   idx_crawl_run_links_from  (run_id, from_url)
--   project_module_page_runs  unique (run_id, url)
--
-- So a page exists only as a row inside a run, and four things follow from that:
--
--   • No history. "How has this page changed since March" is unanswerable. The
--     data sits in three runs and nothing links the three rows as one page.
--   • String matching instead of joins. Comparing pages across runs means
--     comparing URL spellings, and every one of those is a chance to miss
--     silently. The insight layer had to build canonicalKey() and use it in
--     four places for exactly this reason.
--   • Nothing durable can attach to a page. No owner, no "we fixed this", no
--     note, and no exclusion — so an audit re-reports the client's legal pages
--     forever because the page cannot remember being told not to.
--   • Recommendations attach to findings, not pages, so "who is fixing
--     /services/implants" has no answer.
--
-- This table makes a page the product's central noun instead of a run, which is
-- the noun a marketing team actually works in.
--
-- Additive and re-runnable. No RLS: every query carries its own project filter,
-- and that filter IS the tenancy check.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function platform_touch_updated_at()
returns trigger language plpgsql as $fn$
begin
  new.updated_at = now();
  return new;
end;
$fn$;


create table if not exists project_pages (
  id              uuid primary key default gen_random_uuid(),

  project_id      uuid not null references crawl_projects(id) on delete cascade,
  -- Denormalised so a page can be read and authorised without joining up to the
  -- project. Same reasoning as project_module_page_runs.
  workspace_id    uuid references workspaces(id) on delete set null,

  -- ── Identity versus display ──────────────────────────────────────────────
  -- canonical_key is host + path + query, normalised by crawledPages.canonicalKey:
  -- fragment stripped, trailing slash removed, host lowercased. It is what makes
  -- two spellings of one page one row.
  --
  -- url is the spelling most recently seen, which is what a human reads. Keeping
  -- both means the join never misses on a trailing slash and the UI never shows
  -- a mangled URL.
  --
  -- Note the key deliberately excludes the scheme: http://x/a and https://x/a
  -- are the same page, and a site moving to https must not orphan its history.
  -- It DOES include the host, so www and non-www are different pages until
  -- somebody decides otherwise — that difference is usually a real redirect bug.
  canonical_key   text not null,
  url             text not null,

  first_seen_at   timestamptz not null default now(),
  last_seen_at    timestamptz not null default now(),
  first_seen_run  uuid references crawl_runs(id) on delete set null,
  last_seen_run   uuid references crawl_runs(id) on delete set null,

  -- ── Last observed crawl facts ────────────────────────────────────────────
  -- Denormalised on purpose: a page inventory has to render without joining
  -- three run-scoped tables. Every one of these is nullable because "we did not
  -- observe this" is a real state and must not arrive as a zero (§16.11).
  depth           integer,
  inbound_links   integer,
  title           text,
  status_code     integer,
  is_indexable    boolean,

  -- ── State that outlives a run: the reason this table exists ──────────────
  owner_email     text,
  notes           text,

  -- An excluded page is one somebody has decided not to audit — a legal notice,
  -- a paginated archive, a landing page owned by another team. Its findings stop
  -- reaching the backlog, and the backlog says how many it dropped, because an
  -- exclusion that hides work silently is worse than no exclusion at all.
  excluded_at     timestamptz,
  excluded_reason text,
  excluded_by     text,

  -- ── Retirement ───────────────────────────────────────────────────────────
  -- A page the latest crawl did not find. NEVER a delete: the owner, the notes,
  -- the exclusion and the audit history all have to survive it, and a page that
  -- 404s this week may be back next week.
  --
  -- Critically, absence is only evidence when the crawl was NOT capped. A crawl
  -- that stopped at its URL limit never reached some pages, so absence proves
  -- nothing and retirement is withheld — see pages.syncFromCrawl. Getting this
  -- backwards would retire half a site the first time somebody lowered the limit.
  retired_at      timestamptz,
  retired_reason  text,

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- One row per page per project. This is the constraint that makes the whole
-- table worth having.
create unique index if not exists uq_project_pages_key
  on project_pages (project_id, canonical_key);

-- The default read: the pages that currently exist, most recently seen first.
create index if not exists idx_project_pages_active
  on project_pages (project_id, last_seen_at desc)
  where retired_at is null;

-- Excluded pages are read on every backlog build, to subtract them.
create index if not exists idx_project_pages_excluded
  on project_pages (project_id)
  where excluded_at is not null;

-- Pages with an owner, for "what is assigned to whom".
create index if not exists idx_project_pages_owner
  on project_pages (project_id, owner_email)
  where owner_email is not null;

drop trigger if exists trg_project_pages_touch on project_pages;
create trigger trg_project_pages_touch
  before update on project_pages
  for each row execute function platform_touch_updated_at();


-- ── Per-page audit runs point at the page ───────────────────────────────────
--
-- With this, a page's audit history is a join rather than a URL-string match
-- across runs. Nullable because rows written before this migration have no page
-- to point at, and backfilling them by string match would reintroduce exactly
-- the fragility this table removes.
alter table project_module_page_runs
  add column if not exists page_id uuid references project_pages(id) on delete set null;

create index if not exists idx_pmpr_page
  on project_module_page_runs (page_id, created_at desc);


-- ── Recommendations can name a page ─────────────────────────────────────────
--
-- A recommendation has always attached to a finding, so "who is fixing
-- /services/implants" had no answer and one page appearing in six modules'
-- findings produced six unrelated records. Optional: a template-wide
-- recommendation is genuinely not about one page, and forcing one would be a lie.
alter table recommendations
  add column if not exists page_id uuid references project_pages(id) on delete set null;

create index if not exists idx_recommendations_page
  on recommendations (page_id) where page_id is not null;
