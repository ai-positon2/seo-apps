-- ═══════════════════════════════════════════════════════════════════════════
-- 0017 — ai_visibility: the prompt set becomes something a person approves
--
-- Why this exists
-- ───────────────
-- 0016 shipped a prompt set anybody could write to and a runner that generated
-- its own set when the table was empty (aiVisibility/run.js) and then measured
-- it in the same breath. Each ChatGPT capture is 25-110 seconds and costs real
-- money, so that path spent a client's budget on questions nobody chose. This
-- migration makes the set reviewable:
--
--   draft ──▶ approved ──▶ retired
--       └───▶ rejected ──▶ draft (re-proposed)
--                          retired ──▶ approved (restored)
--
-- Only 'approved' is measured. That rule lives in aiVisibility/run.js; this
-- table gives it something to stand on.
--
-- It also adds a second axis. A flat list of twenty commercial questions is
-- not a measured brand, it is one question measured twenty ways — so every
-- prompt now carries WHAT it is about (topic_kind/topic_label/target_url) as
-- well as HOW it is asked (slot, which 0016 called intent alone). A page-
-- backed topic's target_url is what lets a report say "you have an Invisalign
-- page and nobody names you for Invisalign questions" instead of a percentage.
--
-- Three defects in 0016 are closed here as well:
--
--   1. The unique index normalised text differently from the code that fed it.
--      promptBuilder.normalise collapsed interior whitespace; the index's
--      lower(btrim(text)) did not. "best dentist  boston" and "best dentist
--      boston" were the same prompt to one and two prompts to the other.
--
--   2. The index covered retired rows, so retiring a prompt permanently
--      blocked ever re-adding that question. There was also no un-retire path
--      anywhere in the module.
--
--   3. `active` and `retired_at` were two flags for one fact.
--
-- Additive where it can be. NOT re-runnable in one respect: it drops a column
-- and rebuilds an index. Both steps are guarded, and re-running the whole file
-- is a no-op. No RLS: every query carries its own project filter, as in
-- 0012-0016.
--
-- ── Before you run this ────────────────────────────────────────────────────
-- The new unique index is on the CODE'S normalisation (promptLifecycle.
-- normalise), which collapses interior whitespace; 0016's index did not. If
-- two live prompts in one project collapse to the same string, section 5's
-- index creation fails. Section 4 retires all but the oldest of each colliding
-- group first, so a clean run handles this on its own — but to see what it
-- WOULD touch before running:
--
--   select project_id,
--          lower(regexp_replace(btrim(text), '\s+', ' ', 'g')) as norm,
--          count(*), array_agg(id order by created_at)
--     from ai_visibility_prompts
--    where retired_at is null and active
--    group by 1, 2 having count(*) > 1;
-- ═══════════════════════════════════════════════════════════════════════════


-- ── 1. Let a prompt-generation run exist ───────────────────────────────────
--
-- Generating a draft calls an LLM and (optionally) paid DataForSEO demand
-- endpoints. That is minutes of work that spends money, so it needs a durable
-- row written BEFORE the spend — which is what project_module_runs already
-- is. It reuses that table under its own key rather than a new one.
--
-- 'ai_visibility_prompts' is deliberately NOT added to moduleRunners.RUNNABLE,
-- DEFAULT_AUDIT_MODULES or overview.MODULES: it is not a module with a card
-- and a score, it is a job whose progress happens to be readable the same way
-- moduleEvidence already reads module progress.
--
-- 'on_page' stays for the reason 0016 gave: historical rows carry it.

do $$
begin
  if exists (
    select 1 from pg_constraint where conname = 'project_module_runs_module_check'
  ) then
    alter table project_module_runs drop constraint project_module_runs_module_check;
  end if;

  alter table project_module_runs add constraint project_module_runs_module_check
    check (module_key in (
      'on_page', 'seo_geo', 'agent_readiness', 'competitor', 'hub_spoke',
      'ai_visibility', 'ai_visibility_prompts'
    ));
end $$;


-- ── 2. The review lifecycle and the topic axis ─────────────────────────────
--
-- The default is 'approved' HERE and changed to 'draft' in section 3. That is
-- the backfill: every row already in this table was written by the
-- pre-review world and has either been measured or was next in line to be.
-- Landing them as drafts would stop every existing client's next run dead.
-- Doing it via the column default rather than an UPDATE also makes re-running
-- this file safe — a second run cannot re-stamp a legitimately drafted prompt
-- back to approved.

alter table ai_visibility_prompts
  add column if not exists status text not null default 'approved';

alter table ai_visibility_prompts
  -- Which coverage cell this prompt fills. A slot is HOW the question is
  -- asked (commercial, informational, a head-to-head comparison, ...) — see
  -- promptLifecycle.SLOTS for the full table and each slot's weight.
  add column if not exists slot text,
  -- Why this prompt, in a sentence, from whatever produced it. A reviewer
  -- approving forty prompts needs to judge each one without re-deriving it.
  add column if not exists rationale text,

  -- What the question is ABOUT: 'page' | 'cluster' | 'gap' | 'service' |
  -- 'brand'. A page-backed topic carries target_url; a gap topic (a cluster
  -- with no hub page yet) or a brand topic (comparison/navigational
  -- questions, which are about the company, not a subject) does not, and
  -- that absence is itself the finding.
  add column if not exists topic_kind text,
  -- The human-readable grouping label shown on the review screen and report —
  -- a page title stripped of boilerplate, or a cluster name.
  add column if not exists topic_label text,
  -- The crawled page this prompt is about, when it is about one. NOT a
  -- foreign key to project_pages: a URL should survive a re-crawl that drops
  -- or renames that row, and an approval has to stay interpretable against
  -- what was true when it was given, not against whatever the site looks
  -- like today.
  add column if not exists target_url text,

  -- Monthly search demand where it is known. NULL is unknown, never 0 — 0 is
  -- a measured absence of demand and is itself a reason to reject a prompt.
  add column if not exists demand_volume integer,
  add column if not exists demand_source text,
  -- The grounding this prompt was built from, snapshotted at generation time:
  -- which cluster/keyword/competitor/page/demand-query it came from. A
  -- snapshot, not a join — the next crawl changes the clusters, and an
  -- approval has to stay interpretable against what was true when given.
  add column if not exists evidence jsonb not null default '{}'::jsonb,
  add column if not exists generation_run_id uuid references project_module_runs(id) on delete set null,

  add column if not exists proposed_at timestamptz,
  add column if not exists approved_at timestamptz,
  add column if not exists approved_by uuid references app_users(id) on delete set null,
  add column if not exists rejected_at timestamptz,
  add column if not exists rejected_by uuid references app_users(id) on delete set null,
  add column if not exists rejection_reason text,
  add column if not exists retired_by uuid references app_users(id) on delete set null;


-- ── 3. Backfill, then flip the default ─────────────────────────────────────

do $mig$
begin
  -- Anything 0016 considered out of the set becomes 'retired'.
  update ai_visibility_prompts
     set status     = 'retired',
         -- A row with active=false and no retired_at would violate the CHECK
         -- in section 6. Its updated_at is the closest thing to when it
         -- happened.
         retired_at = coalesce(retired_at, updated_at, created_at)
   where status <> 'retired'
     and (retired_at is not null or active = false);

  -- A grandfathered approval has a timestamp but no approver — see section 6.
  update ai_visibility_prompts
     set approved_at = coalesce(approved_at, created_at)
   where status = 'approved' and approved_at is null;
end
$mig$;

-- Everything created from now on starts as a draft.
alter table ai_visibility_prompts alter column status set default 'draft';

-- `active` is now derivable from status and can only disagree with it. This
-- also drops idx_ai_visibility_prompts_active, which depends on it.
alter table ai_visibility_prompts drop column if exists active;


-- ── 4. Retire near-duplicates so the new index can be built ────────────────
--
-- Retired rather than deleted: a duplicate still has captures behind it, and
-- deleting it would silently rewrite the runs those numbers came from.
-- Retiring is also exactly what makes it stop colliding — the new index
-- excludes retired rows, so the repair and the exclusion are one mechanism.

do $dedupe$
declare
  victim record;
  n int := 0;
begin
  for victim in
    select id from (
      select id,
             row_number() over (
               partition by project_id,
                            lower(regexp_replace(btrim(text), '\s+', ' ', 'g'))
               order by created_at, id
             ) as rn
        from ai_visibility_prompts
       where status in ('draft', 'approved')
    ) ranked where rn > 1
  loop
    update ai_visibility_prompts
       set status = 'retired', retired_at = now()
     where id = victim.id;
    n := n + 1;
  end loop;
  if n > 0 then
    raise notice '0017: retired % near-duplicate prompt(s) that differed only by whitespace or case', n;
  end if;
end
$dedupe$;


-- ── 5. The index that finally matches the code ─────────────────────────────
--
-- Same expression as promptLifecycle.normalise(): trim, collapse interior
-- whitespace, lower. regexp_replace/btrim/lower are all IMMUTABLE, so this is
-- indexable.
--
-- Partial on the LIVE set. Uniqueness is a property of the questions
-- currently in play, not of everything ever written: retiring a prompt must
-- not permanently forbid the question, and re-proposing something previously
-- rejected must be possible (the store layer flags that case rather than the
-- database refusing it outright).

create unique index if not exists uq_ai_visibility_prompt_live
  on ai_visibility_prompts (project_id, lower(regexp_replace(btrim(text), '\s+', ' ', 'g')))
  where status in ('draft', 'approved');

-- Only after the replacement exists. If section 4 or 5 failed, the old guard
-- is still standing and this line is simply skipped by never being reached.
drop index if exists uq_ai_visibility_prompt;

create index if not exists idx_ai_visibility_prompts_status
  on ai_visibility_prompts (project_id, status, created_at);

-- The runner's read: "what may I measure".
create index if not exists idx_ai_visibility_prompts_measurable
  on ai_visibility_prompts (project_id) where status = 'approved';

-- The review screen's read: the set grouped by coverage slot or by topic.
create index if not exists idx_ai_visibility_prompts_slot
  on ai_visibility_prompts (project_id, slot) where status in ('draft', 'approved');
create index if not exists idx_ai_visibility_prompts_topic
  on ai_visibility_prompts (project_id, topic_label) where status in ('draft', 'approved');


-- ── 6. The invariants ──────────────────────────────────────────────────────

do $mig$
begin
  if not exists (select 1 from pg_constraint where conname = 'ai_visibility_prompts_status_check') then
    alter table ai_visibility_prompts add constraint ai_visibility_prompts_status_check
      check (status in ('draft', 'approved', 'rejected', 'retired'));
  end if;

  if not exists (select 1 from pg_constraint where conname = 'ai_visibility_prompts_slot_check') then
    alter table ai_visibility_prompts add constraint ai_visibility_prompts_slot_check
      check (slot is null or slot in (
        'category_commercial', 'cluster_informational', 'cost_pricing',
        'local_geo', 'comparison', 'navigational_alternatives', 'demand_verbatim'
      ));
  end if;

  if not exists (select 1 from pg_constraint where conname = 'ai_visibility_prompts_topic_kind_check') then
    alter table ai_visibility_prompts add constraint ai_visibility_prompts_topic_kind_check
      check (topic_kind is null or topic_kind in ('page', 'cluster', 'gap', 'service', 'brand'));
  end if;

  -- WEAKER THAN 0013 ON PURPOSE, and this is the one place to notice it.
  --
  -- recommendations_approved_by_check requires an approver for anything
  -- approved, so no automated path can quietly become the approver. That
  -- constraint cannot be applied here: section 3 grandfathers every pre-0017
  -- row into 'approved' with nobody to name as its approver, and inventing
  -- one would be a worse lie than admitting the gap.
  --
  -- So the DATABASE requires only a timestamp, and the SERVICE
  -- (aiVisibility/store.transitionPrompt) refuses a NEW approval with no
  -- access.userId. A future migration can tighten this to match 0013 once no
  -- approved_by-null rows remain.
  if not exists (select 1 from pg_constraint where conname = 'ai_visibility_prompts_approved_check') then
    alter table ai_visibility_prompts add constraint ai_visibility_prompts_approved_check
      check (status <> 'approved' or approved_at is not null);
  end if;

  -- A rejection with no reason is not a decision anybody can learn from, and
  -- the generator would re-propose the same prompt next month without one.
  if not exists (select 1 from pg_constraint where conname = 'ai_visibility_prompts_rejected_check') then
    alter table ai_visibility_prompts add constraint ai_visibility_prompts_rejected_check
      check (status <> 'rejected' or (rejected_at is not null and rejection_reason is not null));
  end if;

  -- retired_at is the WHEN of the retired status. Neither can exist alone.
  if not exists (select 1 from pg_constraint where conname = 'ai_visibility_prompts_retired_check') then
    alter table ai_visibility_prompts add constraint ai_visibility_prompts_retired_check
      check ((status = 'retired') = (retired_at is not null));
  end if;

  if not exists (select 1 from pg_constraint where conname = 'ai_visibility_prompts_demand_check') then
    alter table ai_visibility_prompts add constraint ai_visibility_prompts_demand_check
      check (demand_volume is null or demand_volume >= 0);
  end if;

  -- 500 is dataForSeoClient.MAX_PROMPT_CHARS / promptLifecycle.MAX_PROMPT_CHARS
  -- — the surfaces' own cap, not a style preference. NOT VALID because a
  -- pre-0017 row could exceed it, and a migration that refuses to apply over
  -- one bad row helps nobody. Validate separately once the offenders are
  -- edited or retired:
  --   select id, char_length(text) from ai_visibility_prompts
  --    where char_length(btrim(text)) > 500 or btrim(text) = '';
  --   alter table ai_visibility_prompts
  --     validate constraint ai_visibility_prompts_text_check;
  if not exists (select 1 from pg_constraint where conname = 'ai_visibility_prompts_text_check') then
    alter table ai_visibility_prompts add constraint ai_visibility_prompts_text_check
      check (char_length(btrim(text)) between 1 and 500) not valid;
  end if;
end
$mig$;


-- ── 7. Column comments ─────────────────────────────────────────────────────
comment on column ai_visibility_prompts.status is
  'draft | approved | rejected | retired. Only approved prompts are measured.';
comment on column ai_visibility_prompts.topic_kind is
  'What the question is about: page | cluster | gap | service | brand. Determines whether target_url is meaningful.';
comment on column ai_visibility_prompts.evidence is
  'Grounding snapshot at generation time: cluster, keyword+volume, competitor, page, demand, PAA. Never joined live.';
comment on column ai_visibility_prompts.demand_volume is
  'Monthly searches where known. NULL = unknown; 0 = measured no demand.';


-- ═══════════════════════════════════════════════════════════════════════════
-- Verification
-- ═══════════════════════════════════════════════════════════════════════════
-- Retired must carry a timestamp:
--   update ai_visibility_prompts set status='retired' where id='<id>';
--   -- expected: violates ai_visibility_prompts_retired_check
--
-- A rejection must carry a reason:
--   update ai_visibility_prompts set status='rejected', rejected_at=now() where id='<id>';
--   -- expected: violates ai_visibility_prompts_rejected_check
--
-- Whitespace near-duplicates must now collide:
--   insert into ai_visibility_prompts (project_id, text) values ('<pid>','best  DENTIST ');
--   insert into ai_visibility_prompts (project_id, text) values ('<pid>','best dentist');
--   -- expected: second one violates uq_ai_visibility_prompt_live
--
-- A retired prompt must NOT block re-adding its text:
--   update ai_visibility_prompts set status='retired', retired_at=now() where id='<id>';
--   insert into ai_visibility_prompts (project_id, text) values ('<pid>','<same text>');
--   -- expected: succeeds
--
-- Rollback (development only — discards every review decision made since):
--   alter table ai_visibility_prompts add column active boolean not null default true;
--   update ai_visibility_prompts set active = (status = 'approved');
--   alter table ai_visibility_prompts
--     drop column status, drop column slot, drop column rationale,
--     drop column topic_kind, drop column topic_label, drop column target_url,
--     drop column demand_volume, drop column demand_source, drop column evidence,
--     drop column generation_run_id, drop column proposed_at,
--     drop column approved_at, drop column approved_by,
--     drop column rejected_at, drop column rejected_by, drop column rejection_reason,
--     drop column retired_by;
--   drop index if exists uq_ai_visibility_prompt_live;
--   create unique index uq_ai_visibility_prompt on ai_visibility_prompts (project_id, lower(btrim(text)));
-- ═══════════════════════════════════════════════════════════════════════════
