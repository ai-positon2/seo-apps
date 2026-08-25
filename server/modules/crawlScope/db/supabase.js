// ── Supabase client for CrawlScope ───────────────────────────────────────────
// Ported from the standalone CrawlScope app, where this module owned its own
// clients and identity came from Supabase Auth (auth.users + RLS). In this app
// there is no Supabase Auth session to scope a client to: users sign in with
// Google against our own `app_users` table and carry a JWT we sign ourselves
// (server/routes/auth.js), so `auth.uid()` is always NULL here and an RLS-
// scoped anon client could never see a row.
//
// So this delegates to the app's single service-role client and CrawlScope's
// own explicit `owner` filtering does the scoping instead — which is how every
// other module in this app already works (see services/supabase.js: "no RLS is
// relied upon"). repo.js already took `owner` as a parameter on every read, so
// this is a narrowing of trust, not a removal of it.
//
// `userClient` and `verifyToken` are deliberately gone: they existed only for
// the Supabase-Auth path in the old src/server/auth.js, which this port
// replaces with the app's requireAuth.

const { getSupabase, isSupabaseConfigured } = require('../../../services/supabase');

// Kept as a function (not a bare export) because the callers — RunManager, the
// worker, run/report.js — expect a factory they can call lazily, so the server
// still boots with SUPABASE_* unset.
function serviceClient() {
  return getSupabase();
}

module.exports = { serviceClient, isSupabaseConfigured };
