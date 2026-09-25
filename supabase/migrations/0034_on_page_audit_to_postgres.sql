-- ── On-Page Audit: saved audits, in the database ────────────────────────────
--
-- The third of the six file-backed modules in server/services/dataRoot.js. No
-- dashboard card links into this one, so it never produced the dangling-report
-- 404 that 0032 and 0033 fix — its failure was quieter: the audit list simply
-- came back empty after a deploy, with nothing to say that a hundred saved
-- audits had been in it.
--
-- One row per audit, keyed by the "audit_..." id the module already generates.
create table if not exists on_page_audits (
  id         text primary key,
  -- The saved audit exactly as the JSON file held it, raw page HTML already
  -- stripped by the store (saveAudit drops `_html`).
  data       jsonb not null,
  -- Mirrored out of the record so the list can be ordered and capped by the
  -- database. listAudits() read EVERY file, parsed each one, sorted the lot in
  -- memory and then kept the newest 50 — work proportional to all audits ever
  -- saved, to render a page that shows fifty.
  audit_date timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_on_page_audits_audit_date
  on on_page_audits (audit_date desc nulls last);

comment on table on_page_audits is
  'On-Page Audit saved audits. Was one JSON file per audit under server/modules/onPageAudit/data/.';
