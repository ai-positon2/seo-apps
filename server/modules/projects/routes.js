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
//   GET    /api/projects/:projectId/executive-summary
//   GET    /api/projects/:projectId/executive-summary/trend
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
const moduleQueue = require('../../services/moduleQueue');
const competitorAutostart = require('./competitorAutostart');
const contentArchitect = require('./contentArchitect');
const homepageAutostart = require('./homepageAutostart');
const crawlAutostart = require('./crawlAutostart');
const aiVisibilityLiteAutostart = require('./aiVisibilityLiteAutostart');
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
const { isDatabaseConfigured } = require('../../services/db');

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

/**
 * Queue Competitor Research after a route has changed a project's domains.
 *
 * Reads the domains back rather than taking the caller's copy: the row that was
 * just written has to be in the set, and a competitor added by a different
 * request a second ago has to be too — that is what makes one queued run cover
 * everything tracked when it starts.
 *
 * Never throws. The domain write the caller was asked for has already
 * succeeded, and failing its response because a follow-on could not be queued
 * would report the opposite of what happened.
 */
async function autostartAfterDomainChange(access, delayMs) {
  try {
    const domains = await store.listDomains(access.project.id);
    return await competitorAutostart.scheduleCompetitorResearch({ access, domains, delayMs });
  } catch (e) {
    console.error('[projects] competitor autostart skipped:', e.message);
    return { scheduled: false, reason: 'not_started', runId: null, note: null };
  }
}

function requireConfigured(res) {
  if (isDatabaseConfigured()) return true;
  res.status(503).json({
    error: 'Projects need the database configured (DATABASE_URL).',
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
    // 'createProject', not 'editProjectSettings': every member of a workspace
    // may add a project to it. See the capability table for why the two are
    // deliberately separate.
    const access = await projectAccess.requireWorkspace(req, workspaceId, 'createProject');

    // PRD §18.2: a duplicate domain in the same workspace warns and needs
    // confirmation rather than being rejected outright.
    const normalized = domainsLib.normalizeOrigin(primaryDomain);
    const clash = await store.projectTrackingOrigin({
      workspaceId, normalizedOrigin: normalized.normalizedOrigin,
    });
    if (clash && req.body.confirmDuplicate !== true) {
      return res.status(409).json({
        error: `"${clash.name || clash.url}" already tracks ${normalized.host} in this workspace.`,
        code: 'duplicate_domain',
        needsConfirmation: true,
        existingProjectId: clash.id,
      });
    }

    const project = await store.createProject({
      access, name, primaryDomain, country, competitors, schedule, recipients, crawlOptions,
      autoFindCompetitors: Boolean(autoFindCompetitors),
    });

    // Create the module entry immediately; its analysis is queued by the crawl
    // completion hook once pages exist. A failed projection can heal on open.
    await contentArchitect.ensureProject(project).catch((e) => {
      console.error('[projects.create] Content Architect setup failed:', e.message);
    });

    const homepageAudits = await homepageAutostart.scheduleForProject(req, project.id);

    // The comparison starts itself: a project with a primary domain and
    // something to compare it against has everything Competitor Research needs,
    // and a card that says "not run yet" next to a button whose only job is to
    // say "yes, now" is a step nobody chose. It is queued, not run here — this
    // is a metered module (see competitorAutostart.js for what that costs and
    // how it is kept from being spent twice for one setup).
    //
    // Re-authorized through requireProject rather than reusing the
    // workspace-level context above: `startRun` is a different capability from
    // the one that created the project, and the runner needs the raw project
    // row that context does not carry.
    // Both autostarts below need the same domain list and neither needs the
    // other's result, but they were awaited in series and each fetched the
    // domains itself. Against the configured database a round trip is ~260ms,
    // so that was one redundant fetch plus two scheduling passes laid end to
    // end on a request somebody is watching a spinner for. Read once, run both
    // together. Each keeps its own catch, so one failing still cannot fail the
    // other or the response -- the project is already created by this point.
    const domains = await store.listDomains(project.id);

    // AI Visibility Lite is the one-click module: entering a domain and pressing
    // Save is meant to be the whole interaction, so it identifies the business
    // and writes its questions here rather than behind a button. It needs the
    // projectView (for the primary domain) and its own access context, since
    // writing prompts is 'editProjectSettings' rather than the capability that
    // created the project.
    const aiVisibilityLite = await projectAccess
      .requireProject(req, project.id, 'editProjectSettings')
      .then((setupAccess) => (
        aiVisibilityLiteAutostart.scheduleForProject({
          access: setupAccess,
          project: store.projectView(project, domains),
        })
      ))
      .catch((e) => {
        // The project exists. Failing the response because a module could not
        // start would report the opposite of what happened.
        console.error('[projects.create] AI Visibility Lite autostart skipped:', e.message);
        return { scheduled: false, reason: 'not_started', note: null };
      });

    const [competitorResearch, initialCrawl] = await Promise.all([
    projectAccess
      .requireProject(req, project.id, 'startRun')
      .then((runAccess) => (
        competitorAutostart.scheduleCompetitorResearch({
          access: runAccess,
          domains,
          delayMs: competitorAutostart.SETUP_DELAY_MS,
        })
      ))
      .catch((e) => {
        // Creating the project succeeded. Failing the response because the
        // comparison could not be queued would report the opposite.
        console.error('[projects.create] competitor autostart skipped:', e.message);
        return { scheduled: false, reason: 'not_started', note: null };
      }),

    // The initial crawl starts itself too — Hub and Spoke is itself waiting on
    // a crawl finishing (hubSpokeAutostart.js), and homepageAutostart above
    // only reaches the homepage, not the rest of the site — so a project with
    // no crawl yet is the actual reason those cards used to sit on "no data
    // yet" forever.
    crawlAutostart.scheduleInitialCrawl({
        project, domains, ownerId: identity.userId, crawlOptions,
      })
      .catch((e) => {
        console.error('[projects.create] initial crawl autostart skipped:', e.message);
        return { scheduled: false, reason: 'not_started', runId: null };
      }),
    ]);

    res.status(201).json({ project, competitorResearch, homepageAudits, initialCrawl, aiVisibilityLite });
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

router.get('/:projectId/content-architect', async (req, res) => {
  if (!requireConfigured(res)) return;
  try {
    const access = await projectAccess.requireProject(req, req.params.projectId, 'view');
    const domains = await store.listDomains(access.project.id);
    res.json(await contentArchitect.status({ access, domains }));
  } catch (e) { handleError(res, e, 'contentArchitect'); }
});

router.post('/:projectId/content-architect', async (req, res) => {
  if (!requireConfigured(res)) return;
  try {
    const access = await projectAccess.requireProject(req, req.params.projectId,
      req.body?.retry === true ? 'startRun' : 'view');
    const domains = await store.listDomains(access.project.id);
    res.json(await contentArchitect.connect({ access, domains, retry: req.body?.retry === true }));
  } catch (e) { handleError(res, e, 'contentArchitect'); }
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

// POST, not DELETE: the DELETE verb on this resource is already the recoverable
// soft delete (§4.3.1), and overloading it on a body flag would make the
// difference between "hidden" and "gone forever" a payload detail. A purge is a
// distinct, named act with its own capability and its own URL.
//
// `confirmName` must equal the project's name and the project must already be
// soft-deleted — both enforced in store.purgeProject, which explains why.
router.post('/:projectId/purge', async (req, res) => {
  if (!requireConfigured(res)) return;
  try {
    const access = await projectAccess.requireProject(req, req.params.projectId, 'purgeProject', {
      includeDeleted: true,
    });
    const result = await store.purgeProject({
      access,
      reason: req.body?.reason,
      confirmName: req.body?.confirmName,
    });
    res.json(result);
  } catch (e) { handleError(res, e, 'purge'); }
});

// ── Domains ─────────────────────────────────────────────────────────────────

router.get('/:projectId/domains', async (req, res) => {
  if (!requireConfigured(res)) return;
  try {
    const access = await projectAccess.requireProject(req, req.params.projectId, 'view');
    const project = await store.getProject(access.project);
    res.json({
      primary: project.primaryDomain,
      competitors: project.competitors,
      // Proposals are returned to everyone who can view the project, not only
      // to those who can decide them: a contributor needs to see that what they
      // proposed is still waiting, and the alternative is a domain that
      // vanishes on submit.
      proposedCompetitors: project.proposedCompetitors,
      canDecideProposals: access.can('manageCompetitors') === true,
    });
  } catch (e) { handleError(res, e, 'domains'); }
});

// POST /api/projects/:projectId/domains/:domainId/approve
// POST /api/projects/:projectId/domains/:domainId/reject
//
// The other half of the propose/accept split (§7.2). A contributor's competitor
// lands as 'proposed' and — until these existed — stayed there permanently:
// nothing listed proposals, nothing accepted them, and no role that could have
// accepted one was assignable. All three of those are fixed; this is the part
// that actually moves the row.
//
// Gated on the full verdict, not the 'propose' one: assertCapability already
// refuses a 'propose' grant with a message saying an approver has to apply it,
// which is exactly right here.
for (const decision of ['approve', 'reject']) {
  router.post(`/:projectId/domains/:domainId/${decision}`, async (req, res) => {
    if (!requireConfigured(res)) return;
    try {
      const access = await projectAccess.requireProject(req, req.params.projectId, 'manageCompetitors');
      const domain = await store.decideCompetitorProposal({
        access, domainId: req.params.domainId, decision, reason: req.body?.reason,
      });

      // Approving makes the domain tracked, which is the condition Competitor
      // Research was waiting on — the same autostart every other route that
      // changes domains fires. Rejecting changes nothing measurable, so it
      // starts nothing.
      const competitorResearch = decision === 'approve'
        ? await autostartAfterDomainChange(access)
        : { scheduled: false, reason: 'proposal_rejected', runId: null, note: null };

      res.json({
        domain,
        competitorResearch,
        message: decision === 'approve'
          ? `${domain.host} is now tracked. ${competitorResearch.note || ''}`.trim()
          : `${domain.host} was not accepted. It can be proposed again later.`,
      });
    } catch (e) { handleError(res, e, `${decision}Proposal`); }
  });
}

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

    // Same rule as at setup: the comparison starts itself once there is
    // something to compare against. Queued with a coalescing window, so adding
    // three competitors in a row produces one run that compares all three
    // rather than three runs that each bill the full amount. A proposed
    // competitor is not tracked yet and starts nothing — the decision, and the
    // sentence explaining it, are in competitorAutostart.js.
    const competitorResearch = await autostartAfterDomainChange(access);

    res.status(201).json({
      domain,
      proposed: verdict === 'propose',
      competitorResearch,
      message: verdict === 'propose'
        ? 'Proposed. An approver or administrator has to accept it before it is tracked.'
        : competitorResearch.note || undefined,
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

    // Proposals included. moduleRunners.autoDiscoverCompetitors documents this
    // list as "hosts already tracked or proposed", but listDomains returned
    // active rows only — so a domain already waiting for approval was offered
    // up again as a fresh discovery, and the second copy was refused by the
    // duplicate check after the SEMrush units for it had already been spent.
    const rows = await store.listDomains(access.project.id, { statuses: store.ACTIVE_AND_PROPOSED });
    const primary = rows.find((d) => d.role === 'primary' && d.status === 'active');
    const existingCompetitors = rows
      .filter((d) => d.role === 'competitor')
      .map((d) => d.host || d.normalized_origin)
      .filter(Boolean);

    const discovered = await moduleRunners.autoDiscoverCompetitors({
      access, project: access.project, primary, existingCompetitors,
    });

    // Discovery just added the domains, so the comparison has what it needs.
    const competitorResearch = discovered.competitors.length
      ? await autostartAfterDomainChange(access)
      : { scheduled: false, reason: discovered.reason || 'no_competitors_tracked', note: null };

    res.status(discovered.competitors.length ? 201 : 200).json({
      competitors: discovered.competitors,
      proposed: discovered.reason === 'competitors_pending_approval',
      competitorResearch,
      message: `${discovered.note || ''}${competitorResearch.note || ''}`.trim() || undefined,
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

    // The comparison starts itself here too, and this is the route where that
    // matters most. Autostart needs a primary domain AND something to compare
    // against; a project set up with competitors but no domain yet is declined
    // with 'no_primary_domain', and THIS is the request that satisfies the
    // condition it was declined for. Without this call nothing ever re-asked, so
    // a project whose domain arrived second never started a comparison at all —
    // the card sat at "not run yet" beside a project that had everything it
    // needed, and the only way out was pressing Run by hand.
    //
    // `access` was authorised for editProjectSettings; scheduleCompetitorResearch
    // checks startRun itself, so a role that may rename a project but not start
    // runs still gets the domain written and a reason back instead of a run.
    //
    // Changing an EXISTING domain lands here too, which is correct: the stored
    // comparison measured the old site and is now about a domain this project no
    // longer tracks.
    const competitorResearch = await autostartAfterDomainChange(access);

    res.json({
      project,
      competitorResearch,
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

    const db = require('../../services/db');
    const data = await db.one(
      `update crawl_projects
          set site_verified_at = $1, site_verified_by = $2
        where id = $3 and workspace_id = $4
        returning *`,
      [new Date().toISOString(), access.userId, access.project.id, access.project.workspace_id]
    );

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
// The backlog's totals: how much there is to fix, how much of it is one template
// change, how many pages it touches, how many were crawled. Reads stored
// evidence only — it runs no audits, so two calls against an unchanged project
// return the same answer.
//
// The ranked items themselves are NOT sent. They are built — POST
// insights/promote rebuilds the same backlog to verify the item somebody clicked
// is still in it — but the dashboard reads four numbers off `totals` and nothing
// else, and shipping 41 fully-worded actions to be discarded on arrival cost
// 123KB a load on the live Palo Alto project. Restoring them is one line here,
// for whatever renders them next.
router.get('/:projectId/insights', async (req, res) => {
  if (!requireConfigured(res)) return;
  try {
    const access = await projectAccess.requireProject(req, req.params.projectId, 'view');
    const built = await insights.buildInsights({ access });
    res.json({
      project: built.project,
      backlog: { totals: built.backlog.totals, ranking: built.backlog.ranking },
      crawl: built.crawl,
      generatedAt: built.generatedAt,
    });
  } catch (e) { handleError(res, e, 'insights'); }
});

// GET /api/projects/:projectId/executive-summary
//
// The same stored evidence the dashboard already reads, composed into the four
// answers the person who signs off on the work arrives with — is it in trouble,
// what is the one thing worth doing, how much does it cover, and what is this
// NOT telling me. See insights/executive.js for what it is forbidden to invent.
//
// Runs no audits and spends nothing, exactly like /insights. It costs one extra
// composition over reads that were already happening, so it is safe on the
// dashboard's path — which the trend below is NOT.
router.get('/:projectId/executive-summary', async (req, res) => {
  if (!requireConfigured(res)) return;
  try {
    const access = await projectAccess.requireProject(req, req.params.projectId, 'view');
    // Both reads in parallel. They share no state and the overview is the slower
    // of the two, so serialising them would add the backlog's latency to a page
    // that is already three round trips deep.
    const [overviewData, built] = await Promise.all([
      overview.buildOverview({ access }),
      insights.buildInsights({ access }),
    ]);
    res.json({
      project: built.project,
      ...insights.executive.buildExecutiveSummary({
        overview: overviewData,
        backlog: built.backlog,
      }),
    });
  } catch (e) { handleError(res, e, 'executiveSummary'); }
});

// GET /api/projects/:projectId/executive-summary/trend
//
// Which way the site is moving, from insights/changes.js — the comparison layer
// that has always been built, tested and rendered by nothing.
//
// Its own endpoint because it is the expensive one: it walks every module's last
// two runs and their per-page reports, measured at 2.4s of a 3.7s response on
// the live Palo Alto project, which is why it was taken off the dashboard's path
// to begin with. The summary above renders without it and this fills in when it
// lands, so a slow comparison delays one line rather than the page.
router.get('/:projectId/executive-summary/trend', async (req, res) => {
  if (!requireConfigured(res)) return;
  try {
    const access = await projectAccess.requireProject(req, req.params.projectId, 'view');
    const changes = await insights.changes.buildChanges({ access });
    res.json({
      trend: insights.executive.summariseTrend(changes),
      generatedAt: changes.generatedAt,
    });
  } catch (e) { handleError(res, e, 'executiveSummaryTrend'); }
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
// capture (10-35 minutes for a full set) — nothing this route can hold open.
// It goes on the QUEUE, and services/moduleWorker.js executes it.
//
// It used to run here instead, detached: the request opened a `running` row
// and left an in-process promise working on it. That shape is not merely
// redundant now the worker exists, it is actively broken by it. Only a
// worker's claim stamps `worker_id`/`heartbeat_at`, so a row opened here
// heartbeats NEVER — which is exactly what moduleQueue.reap()'s second arm
// (running, heartbeat_at IS NULL, started_at older than the threshold) exists
// to catch. The threshold is ten minutes and a real measurement is 10-35, so
// EVERY manual run was reclaimed while it was still working:
//
//   • the row went back to `queued`, so the dashboard's poll saw the module
//     leave `running` and reported "Measuring finished" with nothing measured
//   • the worker then claimed the requeued row and captured the whole set a
//     SECOND time, billing the client twice for one click
//   • three reclaims burned `attempts` and failed the run for good, with an
//     error blaming a worker that had never been near it
//
// Enqueuing puts the one mechanism that heartbeats in charge of the one
// module that runs long enough to need it, and makes a manual run take the
// same path the scheduler already uses (services/moduleScheduler.js).
// ai_visibility_lite is here for a weaker version of the same reason: a run is
// minutes rather than half an hour, but still far longer than a request should
// be held open, and the queue is what gives it a heartbeat and a reaper.
const QUEUED_MODULES = ['ai_visibility', 'ai_visibility_lite'];

// Modules that may run in this process when nothing is consuming the queue.
//
// `MODULE_WORKER=off` is a supported configuration, and under it an enqueued
// row is never claimed: the run sits at `queued`, the dashboard reports it as
// in-flight forever, and there is no error anywhere because an unclaimed row is
// not a failure. That is exactly what a first AI Visibility Lite run did.
//
// Only the API module is on this list. The scraped `ai_visibility` must STAY
// queued whatever the worker setting: a run is 10-35 minutes, and the comment
// above records what happened when manual runs did not have a heartbeat —
// reclaimed mid-measurement, billed twice, then failed with an error blaming a
// worker that was never involved. Better a queued row somebody can see than
// that, so it is deliberately excluded.
const IN_PROCESS_FALLBACK = ['ai_visibility_lite'];

/** Will anything claim a queued run? Same switch, same default, as server.js. */
const queueHasConsumer = () => String(process.env.MODULE_WORKER || 'in-process').toLowerCase() !== 'off';

router.post('/:projectId/modules/:moduleKey/run', async (req, res) => {
  if (!requireConfigured(res)) return;
  try {
    const access = await projectAccess.requireProject(req, req.params.projectId, 'startRun');
    const { moduleKey } = req.params;

    const queueThis = QUEUED_MODULES.includes(moduleKey)
      && (queueHasConsumer() || !IN_PROCESS_FALLBACK.includes(moduleKey));

    if (queueThis) {
      // Checked here rather than left to the worker: an unrunnable key has to
      // fail the click. Queued, it would sit there until something claimed it
      // and threw, and the person who clicked would be told nothing.
      if (!moduleRunners.RUNNABLE.includes(moduleKey)) {
        return res.status(400).json({
          error: `${moduleKey} cannot be run from here. `
            + `Runnable modules: ${moduleRunners.RUNNABLE.join(', ')}.`,
          code: 'module_not_runnable',
        });
      }

      const run = await moduleQueue.enqueue({
        projectId: access.project.id,
        workspaceId: access.project.workspace_id || null,
        moduleKey,
        trigger: 'manual',
        createdBy: access.userId || null,
        countryCode: access.project.country_code || null,
      });

      // 202 with the run still `queued`. The caller polls the overview, which
      // reports a queued run as `running` (moduleEvidence classes anything
      // non-terminal as in-flight) — so a click reads as under way from the
      // moment it lands, whether or not a worker has picked it up yet.
      return res.status(202).json({
        run,
        poll: `/api/projects/${req.params.projectId}/modules/${moduleKey}/runs?limit=1`,
      });
    }

    // The queue's job, done here because nothing is consuming it. Detached and
    // 202, not awaited and 201: a measurement is minutes and a request held
    // open that long dies at whatever proxy is in front of this. The client
    // already polls a 202 from the queued branch, so the two are the same shape
    // from the outside.
    if (QUEUED_MODULES.includes(moduleKey)) {
      if (!moduleRunners.RUNNABLE.includes(moduleKey)) {
        return res.status(400).json({
          error: `${moduleKey} cannot be run from here. `
            + `Runnable modules: ${moduleRunners.RUNNABLE.join(', ')}.`,
          code: 'module_not_runnable',
        });
      }
      const fallbackDomains = await store.listDomains(req.params.projectId);
      const started = moduleRunners.runModule({
        access, moduleKey, domains: fallbackDomains, trigger: 'manual', keywords: null,
      });
      started.catch((e) => {
        // runModule closes the run row as failed itself; this only stops the
        // rejection becoming an unhandled one.
        console.error(`[projects.runModule] ${moduleKey} failed:`, e.message);
      });
      return res.status(202).json({
        run: null,
        poll: `/api/projects/${req.params.projectId}/modules/${moduleKey}/runs?limit=1`,
      });
    }

    const domains = await store.listDomains(req.params.projectId);
    const run = await moduleRunners.runModule({
      access,
      moduleKey,
      domains,
      trigger: 'manual',
      keywords: req.body?.keywords || null,
    });
    res.status(201).json({ run });
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

    // The long ones go on the queue and leave this loop alone.
    //
    // ai_visibility is in the default audit set and takes 10-35 minutes. Run in
    // the loop below it opens a `running` row nothing heartbeats, and
    // moduleQueue.reap() reclaims exactly that after ten minutes — requeueing a
    // run that is still working, which then executes a second time on the
    // worker. Same defect as the single-module route above, same fix: the
    // module that runs long enough to need a heartbeat is run by the thing that
    // stamps one.
    const queued = requested.filter((m) => QUEUED_MODULES.includes(m));
    const inline = requested.filter((m) => !QUEUED_MODULES.includes(m));

    for (const moduleKey of queued) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await moduleQueue.enqueue({
          projectId: access.project.id,
          workspaceId: access.project.workspace_id || null,
          moduleKey,
          trigger: 'audit_all',
          createdBy: access.userId || null,
          countryCode: access.project.country_code || null,
        });
      } catch (e) {
        // One module that could not be queued must not sink the rest of the
        // audit — the others are still worth running.
        console.error(`[projects.audit] could not queue ${moduleKey}:`, e.message);
      }
    }

    const perPage = inline.filter((m) => moduleEvidence.PAGE_MODULE_KEYS.includes(m));
    const siteLevel = inline.filter((m) => !moduleEvidence.PAGE_MODULE_KEYS.includes(m));
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
