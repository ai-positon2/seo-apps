-- ═══════════════════════════════════════════════════════════════════════════
-- lpb_feedbackrules / lpb_feedbackbatches — client feedback, made enforceable.
--
-- A client reviews pages and sends notes: "CBH does not provide medication",
-- "never ask about switching to telehealth", "stress pages open with this
-- line". Each note becomes a RULE (lpb_feedbackrules) that the brief planner,
-- the writer and field regen are given, and that QC checks every newly
-- generated page against. The client's words are kept verbatim in the batch
-- they arrived in (lpb_feedbackbatches), along with any code-change action
-- items no rule can express.
--
-- Same shape as lpb_briefs: one jsonb `data` blob per row, read and written
-- through locationPageBuilder/store.js. See locationPageBuilder/cbhFeedback.js
-- for the rule format.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists lpb_feedbackrules (
  id          text primary key,
  data        jsonb not null,             -- { key, client_id, batch_id, status,
                                          --   title, quote, kind, severity, scope{},
                                          --   stages[], instruction, checks[],
                                          --   version, history[] }
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists lpb_feedbackrules_client_idx on lpb_feedbackrules ((data->>'client_id'));
create index if not exists lpb_feedbackrules_key_idx    on lpb_feedbackrules ((data->>'key'));

alter table lpb_feedbackrules enable row level security;

create table if not exists lpb_feedbackbatches (
  id          text primary key,
  data        jsonb not null,             -- { client_id, key?, title, received_at,
                                          --   raw_text, rule_keys[], action_items[],
                                          --   proposed_revisions[] }
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists lpb_feedbackbatches_client_idx on lpb_feedbackbatches ((data->>'client_id'));

alter table lpb_feedbackbatches enable row level security;
