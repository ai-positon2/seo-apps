-- ═══════════════════════════════════════════════════════════════════════════
-- Adds a human-readable label to tool_runs (see 0008_identity_workspaces.sql)
-- so the generic /api/runs list endpoint can render a run without every
-- caller re-deriving one from the tool-specific `input` shape.
-- ═══════════════════════════════════════════════════════════════════════════

alter table tool_runs add column if not exists title text;
