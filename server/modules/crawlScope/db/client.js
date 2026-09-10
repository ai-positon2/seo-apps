// ── Database handle for CrawlScope ───────────────────────────────────────────
// Ported from the standalone CrawlScope app, where this module owned its own
// Supabase clients and identity came from Supabase Auth (auth.users + RLS). In
// this app there is no such session to scope a client to: users sign in with
// Google against our own `app_users` table and carry a JWT we sign ourselves
// (server/routes/auth.js), so RLS had nothing to key off and CrawlScope's own
// explicit `owner` filtering does the scoping instead — which is how every
// other module in this app already works. repo.js already took `owner` as a
// parameter on every read, so that was a narrowing of trust, not a removal.
//
// Now that the app speaks Postgres directly this is simply the shared pool.
// It stays a FUNCTION rather than a bare export because the callers — the
// RunManager, the worker, run/report.js — expect a factory they can call
// lazily, so the server still boots with DATABASE_URL unset; and repo.js still
// takes the handle as its first argument, so a caller can be given a
// transaction-scoped handle instead of the pool.
//
// Formerly db/supabase.js.

const db = require('../../../services/db');

function serviceClient() {
  return db;
}

function isDatabaseConfigured() {
  return db.isDatabaseConfigured();
}

module.exports = { serviceClient, isDatabaseConfigured };
