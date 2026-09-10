// ── Platform administration API (PRD §18.7, §20.10, AC-003) ─────────────────
//   GET    /api/admin/limits                      effective limits + their source
//   GET    /api/admin/limits/policies             version history
//   POST   /api/admin/limits/versions             new version (never an update)
//   GET    /api/admin/feature-flags
//   PATCH  /api/admin/feature-flags               set one assignment
//   GET    /api/admin/grants                      platform-admin grants
//   POST   /api/admin/grants                      grant admin to an email
//   DELETE /api/admin/grants/:grantId             revoke
//   GET    /api/admin/audit-events                the immutable trail
//
// Every route is behind requirePlatformAdmin, which reads the persisted grant
// (services/platformAdmin.js) — not a JWT claim, not a header, and not anything
// the browser supplies. A patched frontend that decides it is an admin gets 403
// from here (AC-002: "frontend changes cannot grant admin").

const express = require('express');
const platformAdmin = require('../services/platformAdmin');
const adminLimits = require('../services/adminLimits');
const featureFlags = require('../services/featureFlags');
const auditEvents = require('../services/auditEvents');
const { isDatabaseConfigured } = require('../services/db');

const router = express.Router();

router.use(platformAdmin.requirePlatformAdmin);

function handleError(res, e, where) {
  if (e && e.status) return res.status(e.status).json({ error: e.message, code: e.code });
  console.error(`[admin.${where}]`, e?.stack || e?.message || e);
  res.status(500).json({ error: 'Something went wrong handling that admin request.' });
}

function requireConfigured(res) {
  if (isDatabaseConfigured()) return true;
  res.status(503).json({
    error: 'Platform administration needs the database configured (DATABASE_URL).',
    code: 'not_configured',
  });
  return false;
}

// ── Limits ──────────────────────────────────────────────────────────────────

// GET /api/admin/limits?workspaceId=&tier=
// Returns the effective value AND where each one came from, because "why is
// this workspace capped at 500 URLs" is the question this screen exists to
// answer (PRD §10.2, last line).
router.get('/limits', async (req, res) => {
  try {
    const { limits, sources, policies } = await adminLimits.effectiveLimits({
      workspaceId: req.query.workspaceId || null,
      tier: req.query.tier || null,
    });
    res.json({
      limits,
      sources,
      policies,
      defaults: adminLimits.DEFAULT_LIMITS,
      direction: adminLimits.DIRECTION,
      keys: adminLimits.LIMIT_KEYS,
      databaseConfigured: isDatabaseConfigured(),
    });
  } catch (e) { handleError(res, e, 'getLimits'); }
});

router.get('/limits/policies', async (req, res) => {
  if (!requireConfigured(res)) return;
  try {
    res.json({
      policies: await adminLimits.listPolicies({
        scope: req.query.scope || null,
        scopeRef: req.query.scopeRef || null,
        limit: req.query.limit,
      }),
    });
  } catch (e) { handleError(res, e, 'listPolicies'); }
});

// POST /api/admin/limits/versions { scope, scopeRef, limits, note }
// Appends version N+1. Historical effective limits stay readable (§20.10).
router.post('/limits/versions', async (req, res) => {
  if (!requireConfigured(res)) return;
  try {
    const policy = await adminLimits.createVersion({
      scope: req.body?.scope,
      scopeRef: req.body?.scopeRef || null,
      limits: req.body?.limits,
      note: req.body?.note,
      actorUserId: req.user?.userId,
      actorEmail: req.user?.username,
    });
    res.status(201).json({ policy });
  } catch (e) { handleError(res, e, 'createLimitVersion'); }
});

// ── Feature flags ───────────────────────────────────────────────────────────

router.get('/feature-flags', async (req, res) => {
  try {
    res.json({
      flags: Object.values(featureFlags.FLAGS),
      assignments: await featureFlags.listAssignments({ flagKey: req.query.flagKey || null }),
      scopes: featureFlags.SCOPES,
    });
  } catch (e) { handleError(res, e, 'listFlags'); }
});

router.patch('/feature-flags', async (req, res) => {
  if (!requireConfigured(res)) return;
  try {
    const assignment = await featureFlags.setAssignment({
      flagKey: req.body?.flagKey,
      scope: req.body?.scope,
      scopeRef: req.body?.scopeRef || null,
      enabled: req.body?.enabled,
      note: req.body?.note,
      actorUserId: req.user?.userId,
      actorEmail: req.user?.username,
    });
    res.json({ assignment });
  } catch (e) { handleError(res, e, 'setFlag'); }
});

// ── Platform-admin grants ───────────────────────────────────────────────────

router.get('/grants', async (req, res) => {
  try {
    res.json({
      grants: await platformAdmin.listGrants({ includeRevoked: req.query.includeRevoked === '1' }),
      bootstrapEmails: platformAdmin.bootstrapEmails(),
      initialAdmin: platformAdmin.INITIAL_PLATFORM_ADMIN,
    });
  } catch (e) { handleError(res, e, 'listGrants'); }
});

router.post('/grants', async (req, res) => {
  if (!requireConfigured(res)) return;
  try {
    const grant = await platformAdmin.grantAdmin({
      email: req.body?.email,
      note: req.body?.note,
      actorUserId: req.user?.userId,
      actorEmail: req.user?.username,
    });
    res.status(201).json({ grant });
  } catch (e) { handleError(res, e, 'grantAdmin'); }
});

router.delete('/grants/:grantId', async (req, res) => {
  if (!requireConfigured(res)) return;
  try {
    const grant = await platformAdmin.revokeAdmin({
      grantId: req.params.grantId,
      reason: req.body?.reason,
      actorUserId: req.user?.userId,
      actorEmail: req.user?.username,
    });
    res.json({ grant });
  } catch (e) { handleError(res, e, 'revokeAdmin'); }
});

// ── Audit trail ─────────────────────────────────────────────────────────────

router.get('/audit-events', async (req, res) => {
  if (!requireConfigured(res)) return;
  try {
    if (!req.query.workspaceId) {
      return res.status(400).json({ error: 'workspaceId is required.' });
    }
    res.json({
      events: await auditEvents.listForWorkspace(req.query.workspaceId, {
        limit: req.query.limit,
        action: req.query.action || null,
      }),
      actions: auditEvents.ACTIONS,
    });
  } catch (e) { handleError(res, e, 'auditEvents'); }
});

module.exports = router;
