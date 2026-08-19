// ── Per-user tool run history ────────────────────────────────────────────────
// Backs the "save my runs" history shown across every tool. One row per
// completed run in `tool_runs` (see supabase/migrations/0008_identity_workspaces.sql
// + 0009_tool_runs_title.sql). Typed columns queried directly via getSupabase(),
// same convention as identityStore.js.
//
// saveRun() is called from each tool's route handler right after it produces
// a result, and must NEVER be allowed to break that tool's own response —
// every failure is caught and logged, not thrown, and a run with no
// identifiable user is silently skipped rather than stored as orphaned data.

const { getSupabase, isSupabaseConfigured } = require('./supabase');

function fail(op, error) {
  throw new Error(`[runsStore.${op}] ${error.message || error}`);
}

async function saveRun({ userId, workspaceId, toolId, title, input, output, status = 'completed' }) {
  if (!userId || !isSupabaseConfigured()) return null;
  try {
    const { data, error } = await getSupabase()
      .from('tool_runs')
      .insert({
        user_id: userId,
        workspace_id: workspaceId || null,
        tool_id: toolId,
        title: title || null,
        status,
        input: input ?? null,
        output: output ?? null,
        completed_at: new Date().toISOString(),
      })
      .select('id')
      .single();
    if (error) fail('saveRun', error);
    return data;
  } catch (e) {
    console.error('[runsStore.saveRun]', e.message);
    return null;
  }
}

async function listRuns({ userId, toolId, limit = 50 }) {
  let q = getSupabase()
    .from('tool_runs')
    .select('id, tool_id, title, status, input, created_at, completed_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (toolId) q = q.eq('tool_id', toolId);
  const { data, error } = await q;
  if (error) fail('listRuns', error);
  return data;
}

async function getRun(id, userId) {
  const { data, error } = await getSupabase()
    .from('tool_runs').select('*').eq('id', id).eq('user_id', userId).maybeSingle();
  if (error) fail('getRun', error);
  return data;
}

async function deleteRun(id, userId) {
  const { error, count } = await getSupabase()
    .from('tool_runs').delete({ count: 'exact' }).eq('id', id).eq('user_id', userId);
  if (error) fail('deleteRun', error);
  return (count || 0) > 0;
}

module.exports = { saveRun, listRuns, getRun, deleteRun };
