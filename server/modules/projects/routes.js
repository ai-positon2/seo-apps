// ── Projects API (PRD §18.1, §18.2) ─────────────────────────────────────────
//   POST   /api/projects
//   GET    /api/projects
//   GET    /api/projects/:projectId
//   PATCH  /api/projects/:projectId
//   DELETE /api/projects/:projectId
//   POST   /api/projects/:projectId/restore
//   GET    /api/projects/:projectId/domains
//   POST   /api/projects/:projectId/domains/competitors
//   DELETE /api/projects/:projectId/domains/:domainId
//   POST   /api/projects/:projectId/verify-site
//   POST   /api/projects/:projectId/robots-override
//   GET    /api/projects/:projectId/overview
//   GET    /api/projects/:projectId/pages
//   POST   /api/projects/:projectId/pages/sync
//   GET    /api/projects/:projectId/pages/:pageId
//   PATCH  /api/projects/:projectId/pages/:pageId
//   POST   /api/projects/:projectId/pages/:pageId/exclude
//   POST   /api/projects/:projectId/pages/:pageId/include
//   GET    /api/projects/:projectId/pages/:pageId/history
//   GET    /api/projects/:projectId/insights
//   POST   /api/projects/:projectId/insights/promote
//   POST   /api/projects/:projectId/modules/:moduleKey/run
//   GET    /api/projects/:projectId/modules/:moduleKey/runs
//   GET    /api/projects/:projectId/modules/runs/:runId
//   GET    /api/projects/:projectId/modules/:moduleKey/detail
//   GET    /api/projects/:projectId/modules/pages/:pageRunId
//   POST   /api/projects/:projectId/audit            run every connected module
//   GET    /api/projects/:projectId/recommendations
//   POST   /api/projects/:projectId/recommendations
//   POST   /api/projects/:projectId/recommendations/from-findings
//   PATCH  /api/projects/:projectId/recommendations/:id
//   POST   /api/projects/:projectId/recommendations/:id/status
//   GET    /api/projects/:projectId/report.xlsx
//
// Every handler derives and verifies workspace access server-side through
// services/projectAccess.js (§18.1, first bullet) — there is no route here that
// takes a workspace id from the client and trusts it.

const express = require('express');
const store = require('./store');
const domainsLib = require('./domains');
const projectAccess = require('../../services/projectAccess');
const overview = require('./overview');
const moduleEvidence = require('./moduleEvidence');
const moduleRunners = require('./moduleRunners');
const moduleDetail = require('./moduleDetail');
const insights = require('./insights');
const pages = require('./pages');
const crawledPages = require('./crawledPages');
const recommendations = require('./recommendations');
const report = require('./report');
const adminLimits = require('../../services/adminLimits');
const featureFlags = require('../../services/featureFlags');
const auditEvents = require('../../services/auditEvents');
const identityStore = require('../../services/identityStore');
const { resolveIdentity } = require('../../services/workspaceContext');
const { isSupabaseConfigured } = require('../../services/supabase');

const router = express.Router();

// Errors carry { status, code } from the services. Anything without a status is
// a bug, not a user mistake, so it answers 500 and is logged in full.
function handleError(res, e, where) {
  if (e && e.status) {
    return res.status(e.status).json({ error: e.message, code: e.code || undefined });
  }
  console.error(`[projects.${where}]`, e?.stack || e?.message || e);
  res.status(500).json({ error: 'Something went wrong handling that project request.' });
}

function requireConfigured(res) {
  if (isSupabaseConfigured()) return true;
  res.status(503).json({
    error: 'Projects need Supabase configured (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY).',
    code: 'not_configured',
    projects: [],
  });
  return false;
}

// ── Collection ──────────────────────────────────────────────────────────────

// GET /api/projects — every project in every workspace the caller belongs to,
// plus the capabilities and flags the UI needs to render itself correctly.
router.get('/', async (req, res) => {
  if (!requireConfigured(res)) return;
  try {
    const userId = req.user?.userId;
    if (!userId) return res.json({ projects: [], workspaces: [], capabilities: {}, flags: {} });

    const [workspaceIds, identity] = await Promise.all([
      projectAccess.accessibleWorkspaceIds(userId),
      resolveIdentity(req),
    ]);

    const requested = req.query.workspaceId || null;
    // A workspace id in the query is still membership-checked: it narrows the
    // scope, it never widens it.
    if (requested && !workspaceIds.includes(requested)) {
      return res.status(404).json({ error: 'Workspace not found.' });
    }

    const [projects, workspaces] = await Promise.all([
      store.listProjects({
        workspaceIds,
        workspaceId: requested,
        includeDeleted: req.query.includeDeleted === '1',
        limit: req.query.limit,
      }),
      identityStore.listWorkspacesForUser(userId).catch(() => []),
    ]);

    const activeWorkspaceId = requested || identity.workspaceId || workspaceIds[0] || null;
    const role = activeWorkspaceId
      ? await projectAccess.workspaceRole(activeWorkspaceId, userId)
      : null;
    const platformAdmin = require('../../services/platformAdmin');
    const isAdmin = await platformAdmin.isPlatformAdmin({ email: req.user?.username, userId });

    res.json({
      projects,
      activeWorkspaceId,
      workspaces: workspaces.map((w) => ({
        id: w.id,
        name: w.name,
        isPersonal: Boolean(w.is_personal),
        myRole: projectAccess.normalizeRole(w.myRole),
        lifecycleStatus: w.lifecycle_status || 'active',
      })),
      capabilities: projectAccess.capabilityMap(role, { platformAdmin: isAdmin }),
      isPlatformAdmin: isAdmin,
      // So the UI can compare against project.createdBy and explain the one
      // action a workspace member still can't take — see store.projectView.
      viewerUserId: userId,
      flags: await featureFlags.resolveAll({ workspaceId: activeWorkspaceId, userId }),
      // The effective caps for the active workspace, so the setup form can state
      // the real URL cap rather than the platform default (§8.3).
      limits: activeWorkspaceId
        ? (await adminLimits.effectiveLimits({ workspaceId: activeWorkspaceId })).limits
        : adminLimits.DEFAULT_LIMITS,
      countryRequired: true,
    });
  } catch (e) { handleError(res, e, 'list'); }
});

// POST /api/projects — primary domain and country are both required (AC-004).
router.post('/', async (req, res) => {
  if (!requireConfigured(res)) return;
  try {
    const { name, primaryDomain, country, competitors, schedule, recipients, crawlOptions, autoFindCompetitors } = req.body || {};

    if (!primaryDomain) {
      return res.status(400).json({ error: 'A primary domain is required.', field: 'primaryDomain' });
    }
    if (!country) {
      return res.status(400).json({
        error: 'A country is required — it is the market every rank and GSC comparison is measured in.',
        field: 'country',
      });
    }

    // Which workspace the project lands in: the caller's active workspace
    // (resolved and membership-checked by workspaceContext), or an explicitly
    // named one they belong to.
    const identity = await resolveIdentity(req);
    const workspaceId = req.body.workspaceId || identity.workspaceId;
    if (!workspaceId) {
      return res.status(400).json({ error: 'No workspace is active for this session.' });
    }
    const access = await projectAccess.requireWorkspace(req, workspaceId, 'editProjectSettings');

    // PRD §18.2: a duplicate domain in the same workspace warns and needs
    // confirmation rather than being rejected outright.
    const normalized = domainsLib.normalizeOrigin(primaryDomain);
    const existing = await store.listProjects({ workspaceIds: [workspaceId] });
    const clash = existing.find((p) => p.primaryDomain?.origin === normalized.normalizedOrigin);
    if (clash && req.body.confirmDuplicate !== true) {
      return res.status(409).json({
        error: `"${clash.name}" already tracks ${normalized.host} in this workspace.`,
        code: 'duplicate_domain',
        needsConfirmation: true,
        existingProjectId: clash.id,
      });
    }

    const project = await store.createProject({
      access, name, primaryDomain, country, competitors, schedule, recipients, crawlOptions,
      autoFindCompetitors: Boolean(autoFindCompetitors),
    });
    res.status(201).json({ project });
  } catch (e) { handleError(res, e, 'create'); }
});

// ── Single project ──────────────────────────────────────────────────────────

router.get('/:projectId', async (req, res) => {
  if (!requireConfigured(res)) return;
  try {
    const access = await projectAccess.requireProject(req, req.params.projectId, 'view', {
      includeDeleted: req.query.includeDeleted === '1',
    });
    const project = await store.getProject(access.project);
    res.json({
      project,
      capabilities: access.capabilities,
      role: access.role,
      limits: (await adminLimits.effectiveLimits({ workspaceId: access.workspaceId })).limits,
    });
  } catch (e) { handleError(res, e, 'get'); }
});

router.patch('/:projectId', async (req, res) => {
  if (!requireConfigured(res)) return;
  try {
    const access = await projectAccess.requireProject(req, req.params.projectId, 'editProjectSettings');
    const project = await store.updateProject({ access, patch: req.body || {} });
    res.json({ project });
  } catch (e) { handleError(res, e, 'update'); }
});

router.delete('/:projectId', async (req, res) => {
  if (!requireConfigured(res)) return;
  try {
    const access = await projectAccess.requireProject(req, req.params.projectId, 'editProjectSettings');
    const project = await store.deleteProject({ access, reason: req.body?.reason });
    res.json({ project });
  } catch (e) { handleError(res, e, 'delete'); }
});

router.post('/:projectId/restore', async (req, res) => {
  if (!requireConfigured(res)) return;
  try {
    const access = await projectAccess.requireProject(req, req.params.projectId, 'editProjectSettings', {
      includeDeleted: true,
    });
    const project = await store.restoreProject({ access });
    res.json({ project });
  } catch (e) { handleError(res, e, 'restore'); }
});

// ── Domains ─────────────────────────────────────────────────────────────────

router.get('/:projectId/domains', async (req, res) => {
  if (!requireConfigured(res)) return;
  try {
    const access = await projectAccess.requireProject(req, req.params.projectId, 'view');
    const project = await store.getProject(access.project);
    res.json({ primary: project.primaryDomain, competitors: project.competitors });
  } catch (e) { handleError(res, e, 'domains'); }
});

// POST /api/projects/:projectId/domains/competitors
// A contributor may only *propose* a competitor (§7.2), so this route branches
// on the capability verdict rather than refusing them outright.
router.post('/:projectId/domains/competitors', async (req, res) => {
  if (!requireConfigured(res)) return;
  try {
    const access = await projectAccess.requireProject(req, req.params.projectId);
    const verdict = access.can('manageCompetitors');
    if (!verdict) {
      return res.status(403).json({ error: 'Your role cannot add competitor domains.' });
    }
    const domain = await store.addCompetitor({
      access,
      domain: req.body?.domain,
      status: verdict === 'propose' ? 'proposed' : 'active',
    });
    res.status(201).json({
      domain,
      proposed: verdict === 'propose',
      message: verdict === 'propose'
        ? 'Proposed. An approver or administrator has to accept it before it is tracked.'
        : undefined,
    });
  } catch (e) { handleError(res, e, 'addCompetitor'); }
});

// POST /api/projects/:projectId/domains/competitors/discover
// "Find competitors for me", available after setup too — not just as the
// Project Setup toggle. Runs the same SEMrush + AI discovery
// moduleRunners.runCompetitor falls back to automatically, but on demand and
// regardless of the project's autoFindCompetitors setting or current
// competitor count, so a project that already has one or two tracked can
// still ask for more suggestions. Same capability gate and propose/accept
// split as manual add (§7.2) — a contributor's picks land as 'proposed'.
//
// THIS COSTS SEMRUSH UNITS (unitCosts.js: estimateDiscoveryCost), so it is
// its own explicit action, never bundled into a page load or another mutation.
router.post('/:projectId/domains/competitors/discover', async (req, res) => {
  if (!requireConfigured(res)) return;
  try {
    const access = await projectAccess.requireProject(req, req.params.projectId);
    const verdict = access.can('manageCompetitors');
    if (!verdict) {
      return res.status(403).json({ error: 'Your role cannot add competitor domains.' });
    }

    const rows = await store.listDomains(access.project.id);
    const primary = rows.find((d) => d.role === 'primary' && d.status === 'active');
    const existingCompetitors = rows
      .filter((d) => d.role === 'competitor')
      .map((d) => d.host || d.normalized_origin)
      .filter(Boolean);

    const discovered = await moduleRunners.autoDiscoverCompetitors({
      access, project: access.project, primary, existingCompetitors,
    });
    res.status(discovered.competitors.length ? 201 : 200).json({
      competitors: discovered.competitors,
      proposed: discovered.reason === 'competitors_pending_approval',
      message: discovered.note,
    });
  } catch (e) { handleError(res, e, 'discoverCompetitors'); }
});

router.post('/:projectId/domains/primary', async (req, res) => {
  if (!requireConfigured(res)) return;
  try {
    const access = await projectAccess.requireProject(req, req.params.projectId, 'editProjectSettings');
    const project = await store.setPrimaryDomain({
      access, domain: req.body?.domain, reason: req.body?.reason,
    });
    res.json({
      project,
      note: 'Site verification and any robots.txt override were cleared — they applied to the previous domain.',
    });
  } catch (e) { handleError(res, e, 'setPrimary'); }
});

router.delete('/:projectId/domains/:domainId', async (req, res) => {
  if (!requireConfigured(res)) return;
  try {
    const access = await projectAccess.requireProject(req, req.params.projectId, 'manageCompetitors');
    const domain = await store.removeDomain({
      access, domainId: req.params.domainId, reason: req.body?.reason,
    });
    res.json({ domain });
  } catch (e) { handleError(res, e, 'removeDomain'); }
});

// ── Site verification + robots policy ───────────────────────────────────────

// POST /api/projects/:projectId/verify-site
// Records that an administrator has confirmed ownership of the primary site.
// This is the gate on the robots override (§3.1.4) — an override without a
// verified site is refused by the store, not just hidden in the UI.
//
// The proof mechanism (DNS TXT / file drop / GSC property match) is phase 7
// alongside the GSC integration; until then this records a deliberate,
// audited administrator assertion and says so.
router.post('/:projectId/verify-site', async (req, res) => {
  if (!requireConfigured(res)) return;
  try {
    const access = await projectAccess.requireProject(req, req.params.projectId, 'editProjectSettings');
    const method = String(req.body?.method || 'administrator_assertion');
    if (method !== 'administrator_assertion') {
      return res.status(501).json({
        error: 'Automated ownership proof (DNS, file, or GSC property match) is not implemented yet.',
        code: 'not_implemented',
        supportedMethods: ['administrator_assertion'],
      });
    }
    if (!req.body?.reason) {
      return res.status(400).json({ error: 'Recording verification requires a note saying how ownership was confirmed.' });
    }

    const { getSupabase } = require('../../services/supabase');
    const { data, error } = await getSupabase()
      .from('crawl_projects')
      .update({ site_verified_at: new Date().toISOString(), site_verified_by: access.userId })
      .eq('id', access.project.id)
      .eq('workspace_id', access.project.workspace_id)
      .select('*')
      .single();
    if (error) throw new Error(error.message);

    await auditEvents.recordFor(req, {
      action: auditEvents.ACTIONS.PROJECT_VERIFIED,
      workspaceId: access.workspaceId,
      projectId: access.project.id,
      actorRole: access.role,
      entityType: 'project',
      entityId: access.project.id,
      reason: req.body.reason,
      newState: { method, verifiedAt: data.site_verified_at },
      source: 'api.projects',
    }, { strict: true });

    res.json({ project: await store.getProject(data) });
  } catch (e) { handleError(res, e, 'verifySite'); }
});

router.post('/:projectId/robots-override', async (req, res) => {
  if (!requireConfigured(res)) return;
  try {
    const access = await projectAccess.requireProject(req, req.params.projectId, 'overrideRobotsPolicy');
    const project = await store.setRobotsOverride({
      access, enabled: req.body?.enabled, reason: req.body?.reason,
    });
    res.json({ project });
  } catch (e) { handleError(res, e, 'robotsOverride'); }
});

// ── Overview (backs the home dashboard) ─────────────────────────────────────

// ── Analyze another page ——————————————————————————@
//
// These three modules audit five pages by default: the homepage and four chosen
// to cover different page types. That is a starting point, not a verdict — the
// page somebody actually cares about is often not one of the five, and until now
// there was no way to say so short of re-running the whole audit.
//
// The page is audited exactly the way an automatically-chosen one is, joins the
// same run, and the run's average is recomputed from its pages rather than
// adjusted, so the headline score always equals the mean of what is listed
// under it.
//
// Two guards worth naming:
//
//   The URL must be on the project's own site. This page's score goes into the
//   site's average; a competitor's URL would move a number that claims to
//   describe this client's site.
//
//   Auditing a page already in the report returns what is stored rather than
//   running it again. Re-running is a separate, explicit action — a duplicate
//   here would add a second row for one page and skew the mean toward it.
router.post('/:projectId/modules/:moduleKey/pages', async (req, res) => {
  try {
    // 'startRun', not 'runModule' — the latter is not a capability, and
    // capabilityFor() denies unknown names by design ("a typo must not open a
    // door"), so this endpoint refused everyone including the project's owner.
    const access = await projectAccess.requireProject(req, req.params.projectId, 'startRun');
    const moduleKey = req.params.moduleKey;

    if (!moduleEvidence.PAGE_MODULE_KEYS.includes(moduleKey)
      || !moduleRunners.PAGE_AUDITS[moduleKey]) {
      return res.status(400).json({
        error: `${moduleKey} does not audit individual pages, so a page cannot be added to it.`,
      });
    }

    const project = await store.getProject(access.project);

    // ── Validate the URL ────────────────────────────────────────────────────
    const raw = String(req.body?.url || '').trim();
    if (!raw) return res.status(400).json({ error: 'A URL is required.' });

    let target;
    try {
      target = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    } catch {
      return res.status(400).json({ error: 'That is not a valid URL.' });
    }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      return res.status(400).json({ error: 'Only http and https URLs can be audited.' });
    }

    const siteHost = project.primaryDomain?.host
      || (() => { try { return new URL(project.legacyUrl).host; } catch { return null; } })();
    if (siteHost) {
      const host = target.host.toLowerCase();
      const site = siteHost.toLowerCase();
      const sameSite = host === site
        || host.endsWith(`.${site}`)
        || site.endsWith(`.${host}`);
      if (!sameSite) {
        return res.status(400).json({
          error: `That URL is on ${target.host}, not ${siteHost}. This page's score is averaged `
            + `into this client's site score, so it has to be a page of their site.`,
        });
      }
    }

    // ── Find the run to add it to ───────────────────────────────────────────
    //
    // Newest first, but not blindly runs[0]. Two states have to be handled
    // rather than written into:
    //
    //   running  — followCrawl closes the run with a rollup built from the pages
    //             IT audited. A page added mid-flight would leave a child row the
    //             parent's payload never lists and the score never counts, so the
    //             report would disagree with its own rows.
    //   failed   — recomputing an aggregate over a failed run's pages would give
    //             it a score and make it look like it succeeded.
    const runs = await moduleEvidence.listRuns(access.project.id, moduleKey, { limit: 10 });

    if (runs[0] && runs[0].status === 'running') {
      return res.status(409).json({
        error: 'An audit is running for this module right now. Adding a page would be '
          + 'overwritten when it finishes — wait for it to complete, then add the page.',
        code: 'run_in_flight',
      });
    }

    const run = runs.find((r) => !['running', 'failed'].includes(r.status)) || null;
    if (!run) {
      return res.status(409).json({
        error: runs.length
          ? 'The last runs of this module all failed, so there is no report to add a page to. '
            + 'Re-run it first.'
          : 'This module has not run for this client yet, so there is no report to add a '
            + 'page to. Run it once first.',
      });
    }

    // ── Already in the report? ──────────────────────────────────────────────
    const existingPages = await moduleEvidence.pageRunsForRun(run.id);
    const key = crawledPages.canonicalKey(target.toString());
    const already = existingPages.find((p) => crawledPages.canonicalKey(p.url) === key);
    if (already) {
      return res.json({
        page: already,
        added: false,
        reason: 'That page is already in this report.',
      });
    }

    // ── Audit it ────────────────────────────────────────────────────────────
    const url = target.toString();
    const pageRun = await moduleEvidence.startPageRun({
      access,
      runId: run.id,
      moduleKey,
      url,
      ordinal: existingPages.length,
      pageId: (await pages.keyToId(access.project.id).catch(() => new Map())).get(key) || null,
    });

    let page;
    try {
      const keywords = (project.settings?.pageKeywords || [])
        .find((entry) => entry.url === url)?.keywords || [];
      const result = await moduleRunners.PAGE_AUDITS[moduleKey]({ url, keywords, project });
      page = await moduleEvidence.completePageRun({
        pageRunId: pageRun.id,
        status: result.status || 'completed',
        score: result.score ?? null,
        scoreMax: result.scoreMax ?? 100,
        band: result.band ?? null,
        findings: result.findings || [],
        payload: result.payload || null,
      });
    } catch (e) {
      // A failed page is recorded as a failed page, not swallowed: it is part of
      // the report's coverage story even though it contributes no score.
      page = await moduleEvidence.completePageRun({
        pageRunId: pageRun.id, status: 'failed', error: e.message,
      });
    }

    const { rollup } = await moduleEvidence.refreshRunAggregate(run.id, {
      basis: moduleRunners.SCORE_BASIS[moduleKey] || null,
    });

    res.status(201).json({
      page,
      added: true,
      score: rollup.mean,
      pagesScored: rollup.scoredPages,
      pagesAudited: rollup.totalPages,
    });
  } catch (e) { handleError(res, e, 'addModulePage'); }
});

// The live crawl alone. Cheap enough for the app shell to poll from any screen,
// which is what keeps a running crawl visible after you navigate away from the
// dashboard. See overview.liveCrawlStatus for why this is not just /overview.
router.get('/:projectId/crawl-status', async (req, res) => {
  try {
    const access = await projectAccess.requireProject(req, req.params.projectId);
    res.json({ crawlStatus: await overview.liveCrawlStatus(access.project.id) });
  } catch (e) { handleError(res, e, 'crawlStatus'); }
});

router.get('/:projectId/overview', async (req, res) => {
  if (!requireConfigured(res)) return;
  try {
    const access = await projectAccess.requireProject(req, req.params.projectId, 'view');
    res.json(await overview.buildOverview({ access }));
  } catch (e) { handleError(res, e, 'overview'); }
});

// ── Pages ───────────────────────────────────────────────────────────────────
//
// The project's page inventory. Before project_pages existed, a URL lived only
// inside a crawl run, so none of these routes had anything to address.

// GET /api/projects/:projectId/pages
router.get('/:projectId/pages', async (req, res) => {
  if (!requireConfigured(res)) return;
  try {
    const access = await projectAccess.requireProject(req, req.params.projectId, 'view');
    res.json(await pages.listPages(access.project.id, {
      includeRetired: req.query.retired === 'true',
      includeExcluded: req.query.excluded !== 'false',
    }));
  } catch (e) { handleError(res, e, 'listPages'); }
});

// POST /api/projects/:projectId/pages/sync
//
// Bring the inventory in line with the latest completed crawl. Normally called
// automatically when a crawl finishes; exposed so it can be re-run by hand after
// applying the migration to an existing project.
router.post('/:projectId/pages/sync', async (req, res) => {
  if (!requireConfigured(res)) return;
  try {
    const access = await projectAccess.requireProject(
      req, req.params.projectId, 'editProjectSettings',
    );
    const result = await pages.syncFromCrawl({ access });
    await auditEvents.recordFor(req, {
      action: auditEvents.ACTIONS.PAGES_SYNCED,
      workspaceId: access.workspaceId,
      projectId: access.project.id,
      actorRole: access.role,
      entityType: 'project',
      entityId: access.project.id,
      newState: result,
    }).catch(() => {});
    res.json(result);
  } catch (e) { handleError(res, e, 'syncPages'); }
});

// GET /api/projects/:projectId/pages/:pageId/history
//
// Every audit that has touched this page. The question the product could not
// answer at all before pages had identity.
router.get('/:projectId/pages/:pageId/history', async (req, res) => {
  if (!requireConfigured(res)) return;
  try {
    const access = await projectAccess.requireProject(req, req.params.projectId, 'view');
    res.json(await pages.pageHistory(access.project.id, req.params.pageId));
  } catch (e) { handleError(res, e, 'pageHistory'); }
});

// GET /api/projects/:projectId/pages/:pageId
router.get('/:projectId/pages/:pageId', async (req, res) => {
  if (!requireConfigured(res)) return;
  try {
    const access = await projectAccess.requireProject(req, req.params.projectId, 'view');
    const page = await pages.getPage(access.project.id, req.params.pageId);
    if (!page) return res.status(404).json({ error: 'Page not found.' });
    res.json({ page });
  } catch (e) { handleError(res, e, 'getPage'); }
});

// PATCH /api/projects/:projectId/pages/:pageId — owner and notes.
router.patch('/:projectId/pages/:pageId', async (req, res) => {
  if (!requireConfigured(res)) return;
  try {
    const access = await projectAccess.requireProject(
      req, req.params.projectId, 'editProjectSettings',
    );
    res.json({
      page: await pages.updatePage(access.project.id, req.params.pageId, req.body || {}),
    });
  } catch (e) { handleError(res, e, 'updatePage'); }
});

// POST /api/projects/:projectId/pages/:pageId/exclude
//
// Stop auditing one page. A reason is required, for the same reason a rejected
// recommendation needs one: an exclusion nobody explained is indistinguishable
// from a mistake six months later.
router.post('/:projectId/pages/:pageId/exclude', async (req, res) => {
  if (!requireConfigured(res)) return;
  try {
    const access = await projectAccess.requireProject(
      req, req.params.projectId, 'editProjectSettings',
    );
    const page = await pages.excludePage(access.project.id, req.params.pageId, {
      reason: req.body?.reason,
      by: access.identity?.email || null,
    });
    await auditEvents.recordFor(req, {
      action: auditEvents.ACTIONS.PAGE_EXCLUDED,
      workspaceId: access.workspaceId,
      projectId: access.project.id,
      actorRole: access.role,
      entityType: 'project_page',
      entityId: page.id,
      // The reason is the point of the record: "why did we stop checking this"
      // is the question a handover asks.
      reason: page.excludedReason,
      newState: { url: page.url, excluded: true },
    }).catch(() => {});
    res.json({ page });
  } catch (e) { handleError(res, e, 'excludePage'); }
});

// POST /api/projects/:projectId/pages/:pageId/include
router.post('/:projectId/pages/:pageId/include', async (req, res) => {
  if (!requireConfigured(res)) return;
  try {
    const access = await projectAccess.requireProject(
      req, req.params.projectId, 'editProjectSettings',
    );
    const page = await pages.includePage(access.project.id, req.params.pageId);
    await auditEvents.recordFor(req, {
      action: auditEvents.ACTIONS.PAGE_INCLUDED,
      workspaceId: access.workspaceId,
      projectId: access.project.id,
      actorRole: access.role,
      entityType: 'project_page',
      entityId: page.id,
      newState: { url: page.url, excluded: false },
    }).catch(() => {});
    res.json({ page });
  } catch (e) { handleError(res, e, 'includePage'); }
});

// GET /api/projects/:projectId/insights
//
// What the six modules say when read together: the ranked backlog, the
// cross-module insights, what changed since the previous run, and an explicit
// account of what is not measured. Reads stored evidence only — it runs no
// audits, so two calls against an unchanged project return the same answer.
router.get('/:projectId/insights', async (req, res) => {
  if (!requireConfigured(res)) return;
  try {
    const access = await projectAccess.requireProject(req, req.params.projectId, 'view');
    res.json(await insights.buildInsights({ access }));
  } catch (e) { handleError(res, e, 'insights'); }
});

// POST /api/projects/:projectId/insights/promote
//
// Turns one backlog item into a recommendation draft.
//
// This is the path the recommendations board never had: its lifecycle has always
// worked and nothing in the product could put anything into it, so the board sat
// empty while telling people to fill it from somewhere that did not exist.
//
// A draft, never a proposal — a person decides what is worth advising on, and
// auto-proposing a ranked list would make the approval queue meaningless.
router.post('/:projectId/insights/promote', async (req, res) => {
  if (!requireConfigured(res)) return;
  try {
    const access = await projectAccess.requireProject(
      req, req.params.projectId, 'editRecommendation',
    );
    const { key } = req.body || {};
    if (!key) return res.status(400).json({ error: 'key is required.' });

    // Rebuilt rather than trusted from the request: the client sends an
    // identifier, not the evidence. A body that could carry its own numbers would
    // let a recommendation be created claiming a reach nothing measured.
    const built = await insights.buildInsights({ access });
    const item = [...built.backlog.actions, ...built.backlog.needsReview]
      .find((i) => i.key === key);
    if (!item) {
      return res.status(404).json({
        error: 'That item is not in the current backlog. It may have been fixed, or its module '
          + 'may have been re-run since the page loaded.',
      });
    }

    const created = await recommendations.create({
      access,
      moduleKey: item.moduleKey,
      // recommendations.source_run_id has a foreign key to project_module_runs.
      // The crawl's runs live in crawl_runs, so a crawl-sourced item must NOT put
      // its run id here — doing so violated the constraint and returned a 500 on
      // every Tech Audit item, which is most of a typical backlog. The column's
      // own migration comment says null is a legitimate state; the run is still
      // recorded, in `evidence` below, where nothing constrains it.
      sourceRunId: item.sourceRunKind === 'crawl' ? null : item.sourceRunId,
      ruleId: item.ruleId,
      title: item.title,
      // The advice, then what makes it worth doing. Both come from stored
      // evidence; nothing here is generated.
      body: [
        item.recommendation,
        item.detectedValue ? `Detected: ${item.detectedValue}` : null,
        item.recommendedValue ? `Should be: ${item.recommendedValue}` : null,
        item.basisLine,
      ].filter(Boolean).join('\n\n'),
      // Severity is NOT mapped to priority here, for the reason recommendations.js
      // gives: an error on one page can matter less than a notice on six hundred.
      // A human sets it.
      priority: 'medium',
      effort: item.effortHint,
      evidence: {
        // The run this came from, whichever table it lives in.
        sourceRun: item.sourceRunId,
        sourceRunKind: item.sourceRunKind,
        severity: item.severity,
        sourcePriority: item.priority,
        priorityBasis: item.priorityBasis,
        scope: item.scope,
        pageCount: item.pageCount,
        pagesPartial: item.pagesPartial,
        instanceCount: item.instanceCount,
        pages: item.pages.slice(0, 50),
        basis: item.basisLine,
        rankedBy: built.backlog.ranking.basis,
        capturedAt: new Date().toISOString(),
      },
    });

    res.status(201).json({ recommendation: created });
  } catch (e) { handleError(res, e, 'insightsPromote'); }
});

// GET /api/projects/:projectId/audit-events — the project's audit trail.
router.get('/:projectId/audit-events', async (req, res) => {
  if (!requireConfigured(res)) return;
  try {
    const access = await projectAccess.requireProject(req, req.params.projectId, 'view');
    const events = await auditEvents.listForWorkspace(access.workspaceId, {
      projectId: access.project.id,
      limit: req.query.limit,
    });
    res.json({ events });
  } catch (e) { handleError(res, e, 'auditEvents'); }
});

// ── Module runs (PRD phase 3) ───────────────────────────────────────────────

// POST /api/projects/:projectId/modules/:moduleKey/run
//
// Runs ONE module and (for most modules) waits for it. A single module is
// tens of seconds at worst (measured: seo_geo ~2-4s, agent_readiness
// ~45-55s, on_page ~20-40s), which one request can carry. Running all of
// them in one request cannot — see the audit route below.
//
// ai_visibility is the one exception: its own runner documents 25-110s PER
// capture, run serially (10-35 minutes for a full set) — nothing this route
// can hold open. A real run against a client with approved prompts was
// confirmed to fail exactly this way: it does the real work and then dies
// trying to answer a request whose connection a proxy already gave up on
// (this repo's dev Vite proxy times out at 120s; a production load balancer
// usually sooner), which reads as "Something went wrong" even though the
// measurement itself succeeded. Detached, like the audit route below.
//
// The evidence row is opened before the work starts, so a request that dies
// mid-flight still leaves a run the sweeper can fail honestly.
const DETACHED_MODULES = ['ai_visibility'];

router.post('/:projectId/modules/:moduleKey/run', async (req, res) => {
  if (!requireConfigured(res)) return;
  try {
    const access = await projectAccess.requireProject(req, req.params.projectId, 'startRun');
    const domains = await store.listDomains(req.params.projectId);
    const detached = DETACHED_MODULES.includes(req.params.moduleKey);
    const run = await moduleRunners.runModule({
      access,
      moduleKey: req.params.moduleKey,
      domains,
      trigger: 'manual',
      keywords: req.body?.keywords || null,
      detached,
    });
    res.status(detached ? 202 : 201).json({
      run,
      ...(detached ? {
        poll: `/api/projects/${req.params.projectId}/modules/${req.params.moduleKey}/runs?limit=1`,
      } : {}),
    });
  } catch (e) { handleError(res, e, 'runModule'); }
});

// POST /api/projects/:projectId/audit
//
// "Run Full Audit": every connected module, started and then left to run.
//
// This answers 202 immediately instead of waiting. Measured end to end the five
// modules take around 100 seconds, and holding an HTTP request open that long
// does not work: the dev proxy gives up at 120s, a production load balancer
// usually sooner, and a browser tab sat on a spinner for a minute and a half
// looks broken whether or not it is. The client polls the overview instead —
// every module writes a 'running' row before it starts, so progress is readable
// from the database rather than from a held-open socket.
//
// Modules run SEQUENTIALLY, not in parallel: they all fetch the same site, and
// firing five audits at one host at once is the opposite of the politeness the
// crawler is careful about.
//
// One module failing does not abort the rest — each one closes its own row, and
// a partial audit is visible as exactly that.
router.post('/:projectId/audit', async (req, res) => {
  if (!requireConfigured(res)) return;
  try {
    const access = await projectAccess.requireProject(req, req.params.projectId, 'startRun');
    const domains = await store.listDomains(req.params.projectId);

    // Asked-for modules are honoured exactly, including metered ones — the
    // caller named them. With none named, the default set excludes anything that
    // spends a metered budget (see moduleRunners.DEFAULT_AUDIT_MODULES).
    const requested = Array.isArray(req.body?.modules) && req.body.modules.length
      ? req.body.modules.filter((m) => moduleRunners.RUNNABLE.includes(m))
      : moduleRunners.DEFAULT_AUDIT_MODULES;

    if (!requested.length) {
      return res.status(400).json({ error: 'No runnable modules were requested.' });
    }

    const keywords = req.body?.keywords || null;

    // A crawl to follow, queued by the caller before calling this. When present,
    // the three page-level modules audit pages AS that crawl discovers them
    // instead of reading the previous crawl's stored pages — which is what this
    // route used to do, silently reporting last week's pages as today's audit.
    const crawlRunId = req.body?.crawlRunId || null;

    const perPage = requested.filter((m) => moduleEvidence.PAGE_MODULE_KEYS.includes(m));
    const siteLevel = requested.filter((m) => !moduleEvidence.PAGE_MODULE_KEYS.includes(m));
    const following = Boolean(crawlRunId && perPage.length);

    // Detached on purpose. Nothing awaits this, and it must never reject into an
    // unhandled rejection: each runner closes its own evidence row, and anything
    // that escapes that is logged here.
    (async () => {
      // Site-level modules first: they are quick, and they do not compete with
      // the crawl for the client's server.
      for (const moduleKey of siteLevel) {
        try {
          await moduleRunners.runModule({
            access, moduleKey, domains, trigger: 'audit_all', keywords,
          });
        } catch (e) {
          // Already recorded as a failed run. Logged so an operator sees it
          // without reading the table.
          console.error(`[projects.audit] ${moduleKey} failed:`, e.message);
        }
      }

      if (!perPage.length) return;

      if (following) {
        try {
          await moduleRunners.runFollowingCrawl({
            access,
            project: access.project,
            crawlRunId,
            moduleKeys: perPage,
            keywords,
            trigger: 'audit_all',
          });
        } catch (e) {
          console.error('[projects.audit] streaming audit failed:', e.message);
        }
        return;
      }

      // No crawl to follow: the completed-crawl path, which ranks pages by how
      // many other pages link to them.
      for (const moduleKey of perPage) {
        try {
          await moduleRunners.runModule({
            access, moduleKey, domains, trigger: 'audit_all', keywords,
          });
        } catch (e) {
          console.error(`[projects.audit] ${moduleKey} failed:`, e.message);
        }
      }
    })().catch((e) => console.error('[projects.audit] sequence failed:', e.message));

    // What a caller would spend by asking for the metered modules too, so the UI
    // can offer it as a priced choice rather than hiding it.
    const competitorCount = domains
      .filter((d) => d.role === 'competitor' && d.status === 'active').length;
    const metered = Object.keys(moduleRunners.METERED)
      .filter((key) => !requested.includes(key))
      .map((key) => ({
        key,
        label: overview.MODULES.find((m) => m.key === key)?.label || key,
        ...moduleRunners.estimateCost(key, { competitorCount }),
      }));

    res.status(202).json({
      started: requested,
      // Whether the page audits are following a live crawl or reading the last
      // completed one. The two audit different sets of pages, so the caller is
      // told which happened rather than left to assume.
      followingLiveCrawl: following,
      crawlRunId: crawlRunId || null,
      // Excluded from the default run because they bill. Named so "full audit"
      // never quietly means "most of it".
      excludedBecauseMetered: metered,
      // How to watch it: the overview carries each module's status, and a module
      // still running reads as 'running' rather than as never-run.
      poll: `/api/projects/${req.params.projectId}/overview`,
      estimatedSeconds: requested.length * 25,
      notCovered: overview.MODULES
        .filter((m) => !moduleRunners.RUNNABLE.includes(m.key) && m.key !== 'technical')
        .map((m) => ({ key: m.key, label: m.label, phase: m.pendingPhase || null })),
      crawlNote:
        'The site crawl is queued separately through CrawlScope — it takes minutes rather than '
        + 'seconds, and its runs are creator-scoped today.',
    });
  } catch (e) { handleError(res, e, 'auditAll'); }
});

// GET /api/projects/:projectId/modules/:moduleKey/detail
//
// The expanded view behind a dashboard card: the same card object, plus every
// finding, the module's stored detail, its history, and what a run would cost.
// One shape for all six modules so the client needs one panel.
router.get('/:projectId/modules/:moduleKey/detail', async (req, res) => {
  if (!requireConfigured(res)) return;
  try {
    const access = await projectAccess.requireProject(req, req.params.projectId, 'view');
    const domains = await store.listDomains(req.params.projectId);
    res.json(await moduleDetail.buildModuleDetail({
      access,
      moduleKey: req.params.moduleKey,
      domains,
    }));
  } catch (e) { handleError(res, e, 'moduleDetail'); }
});

// GET /api/projects/:projectId/modules/pages/:pageRunId
//
// One page's stored report, in the module's own shape. Fetched a page at a time
// on purpose: a run over fifty pages holds several megabytes of reports, and the
// report UI shows one URL at a time.
router.get('/:projectId/modules/pages/:pageRunId', async (req, res) => {
  if (!requireConfigured(res)) return;
  try {
    await projectAccess.requireProject(req, req.params.projectId, 'view');
    const page = await moduleEvidence.getPageRun(req.params.projectId, req.params.pageRunId);
    if (!page) return res.status(404).json({ error: 'Page report not found.' });
    res.json({
      page: {
        id: page.id,
        url: page.url,
        moduleKey: page.module_key,
        status: page.status,
        score: page.score === null || page.score === undefined ? null : Number(page.score),
        band: page.band || null,
        counts: page.counts || {},
        findings: page.findings || [],
        error: page.error || null,
        finishedAt: page.finished_at,
        payloadTruncated: Boolean(page.payload_truncated),
        // The module's own report for this page.
        native: page.payload?.native || null,
        payload: page.payload || null,
      },
    });
  } catch (e) { handleError(res, e, 'modulePageRun'); }
});

// GET /api/projects/:projectId/modules/:moduleKey/runs — history for one module.
router.get('/:projectId/modules/:moduleKey/runs', async (req, res) => {
  if (!requireConfigured(res)) return;
  try {
    await projectAccess.requireProject(req, req.params.projectId, 'view');
    res.json({
      runs: await moduleEvidence.listRuns(req.params.projectId, req.params.moduleKey, {
        limit: req.query.limit,
      }),
    });
  } catch (e) { handleError(res, e, 'listModuleRuns'); }
});

// GET /api/projects/:projectId/modules/runs/:runId — one stored run in full.
router.get('/:projectId/modules/runs/:runId', async (req, res) => {
  if (!requireConfigured(res)) return;
  try {
    await projectAccess.requireProject(req, req.params.projectId, 'view');
    const run = await moduleEvidence.getRun(req.params.projectId, req.params.runId);
    if (!run) return res.status(404).json({ error: 'Module run not found.' });
    res.json({ run });
  } catch (e) { handleError(res, e, 'getModuleRun'); }
});

// ── Recommendations (PRD phase 6) ───────────────────────────────────────────

// GET /api/projects/:projectId/recommendations?status=
router.get('/:projectId/recommendations', async (req, res) => {
  if (!requireConfigured(res)) return;
  try {
    const access = await projectAccess.requireProject(req, req.params.projectId, 'view');
    const [items, counts] = await Promise.all([
      recommendations.list(req.params.projectId, {
        status: req.query.status || null,
        limit: req.query.limit,
      }),
      recommendations.summary(req.params.projectId),
    ]);
    res.json({
      recommendations: items,
      summary: counts,
      // So the board can render only the actions this role can actually take,
      // instead of offering buttons that 403.
      capabilities: {
        edit: access.can('editRecommendation'),
        approve: access.can('approveRecommendation'),
        recordShipped: access.can('recordShippedDate'),
      },
      statuses: recommendations.STATUSES,
      priorities: recommendations.PRIORITIES,
    });
  } catch (e) { handleError(res, e, 'listRecommendations'); }
});

// POST /api/projects/:projectId/recommendations
router.post('/:projectId/recommendations', async (req, res) => {
  if (!requireConfigured(res)) return;
  try {
    const access = await projectAccess.requireProject(req, req.params.projectId, 'editRecommendation');
    const created = await recommendations.create({ access, ...(req.body || {}) });
    res.status(201).json({ recommendation: created });
  } catch (e) { handleError(res, e, 'createRecommendation'); }
});

// POST /api/projects/:projectId/recommendations/from-findings
//
// Turns the stored findings of one module run into drafts. Drafts, not
// proposals: a person decides which of forty findings is worth advising on, and
// auto-proposing all of them would make the approval queue meaningless.
router.post('/:projectId/recommendations/from-findings', async (req, res) => {
  if (!requireConfigured(res)) return;
  try {
    const access = await projectAccess.requireProject(req, req.params.projectId, 'editRecommendation');
    const { moduleRunId, ruleIds } = req.body || {};
    if (!moduleRunId) return res.status(400).json({ error: 'moduleRunId is required.' });

    const run = await moduleEvidence.getRun(req.params.projectId, moduleRunId);
    if (!run) return res.status(404).json({ error: 'Module run not found.' });

    const wanted = Array.isArray(ruleIds) && ruleIds.length ? new Set(ruleIds) : null;
    const findings = (Array.isArray(run.findings) ? run.findings : [])
      .filter((f) => !wanted || wanted.has(f.ruleId))
      // 'info' is a passing check. Advising somebody to fix something that is
      // already right is how a report loses credibility.
      .filter((f) => f.severity !== 'info');

    const created = [];
    for (const finding of findings) {
      const draft = recommendations.fromFinding(finding, {
        moduleKey: run.module_key,
        sourceRunId: run.id,
      });
      created.push(await recommendations.create({ access, ...draft }));
    }

    res.status(201).json({
      created,
      count: created.length,
      skippedInfoFindings: (run.findings || []).filter((f) => f.severity === 'info').length,
    });
  } catch (e) { handleError(res, e, 'recommendationsFromFindings'); }
});

// PATCH /api/projects/:projectId/recommendations/:id
router.patch('/:projectId/recommendations/:id', async (req, res) => {
  if (!requireConfigured(res)) return;
  try {
    const access = await projectAccess.requireProject(req, req.params.projectId, 'editRecommendation');
    const result = await recommendations.update({
      access, id: req.params.id, patch: req.body || {},
    });
    res.json(result);
  } catch (e) { handleError(res, e, 'updateRecommendation'); }
});

// POST /api/projects/:projectId/recommendations/:id/status  { to, reason, shippedAt }
//
// One route for every transition rather than /approve, /reject, /ship: the rules
// live in one transition table, and three routes would be three places for them
// to drift. The capability each transition needs is checked inside the service
// against the access context resolved here.
router.post('/:projectId/recommendations/:id/status', async (req, res) => {
  if (!requireConfigured(res)) return;
  try {
    // 'view' here, then the transition table decides what is really needed —
    // 'editRecommendation' would wrongly refuse an approver who cannot edit.
    const access = await projectAccess.requireProject(req, req.params.projectId, 'view');
    const updated = await recommendations.transition({
      access,
      id: req.params.id,
      to: req.body?.to,
      reason: req.body?.reason,
      shippedAt: req.body?.shippedAt,
    });
    res.json({ recommendation: updated });
  } catch (e) { handleError(res, e, 'transitionRecommendation'); }
});

// ── Report (PRD phase 7) ────────────────────────────────────────────────────

// GET /api/projects/:projectId/report.xlsx
//
// Assembled from stored rows only. It runs no audits and computes no scores, so
// two exports of the same unchanged project are identical — which is what makes
// it quotable in a client conversation.
router.get('/:projectId/report.xlsx', async (req, res) => {
  if (!requireConfigured(res)) return;
  try {
    const access = await projectAccess.requireProject(req, req.params.projectId, 'view');
    const { buffer, filename, sheets } = await report.build({ access });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', buffer.length);
    // Lets the browser show what it downloaded without opening the file.
    res.setHeader('X-Report-Sheets', sheets.join(', '));
    res.send(buffer);
  } catch (e) { handleError(res, e, 'report'); }
});

module.exports = router;
