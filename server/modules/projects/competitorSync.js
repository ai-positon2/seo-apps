// ── Competitor Analysis screen → project competitors ────────────────────────
//
// The standalone Competitor Analysis screen keeps its own client records, and
// until now only the project → screen direction was mirrored (moduleRunners
// runCompetitor). A competitor added or removed on the screen never reached the
// project, so the project's Competitor Research card kept comparing against the
// old set — or against nothing — and never re-ran.
//
// This applies the screen's change to every project, in a workspace the caller
// belongs to, that tracks the same site, and then queues that project's
// comparison exactly as adding a competitor on the project itself does
// (competitorAutostart, coalesced). Authorization is the project's own: the
// same manageCompetitors / startRun checks as the project routes, so a
// contributor's addition lands as a proposal and starts nothing.
//
// Never throws: the screen's own write already succeeded, and the follow-on
// must not turn that into an error.

const store = require('./store');
const projectAccess = require('../../services/projectAccess');
const competitorAutostart = require('./competitorAutostart');

const siteOf = (value) => String(value || '')
  .replace(/^https?:\/\//i, '').replace(/^www\./i, '').split('/')[0].toLowerCase();

async function matchingProjects(req, clientDomain) {
  const userId = req.user?.userId;
  if (!userId) return [];
  const workspaceIds = await projectAccess.accessibleWorkspaceIds(userId);
  const projects = await store.listProjects({ workspaceIds });
  const site = siteOf(clientDomain);
  return projects.filter((p) => site && siteOf(p.primaryDomain?.host || p.legacyUrl) === site);
}

/**
 * @param {object} req              the screen's request (requireAuth has run)
 * @param {object} change
 * @param {string} change.clientDomain  the screen client's site
 * @param {string} [change.added]       a competitor domain just added on the screen
 * @param {string} [change.removed]     a competitor domain just removed on the screen
 * @param {boolean} [change.rerun]      the screen just ran: refresh the project's card from it
 * @param {string[]} [change.clientCompetitors]  the screen's competitor domains (with rerun)
 */
async function syncFromCompetitorTool(req, { clientDomain, added = null, removed = null, rerun = false, clientCompetitors = [] }) {
  let projects;
  try {
    projects = await matchingProjects(req, clientDomain);
  } catch (e) {
    console.error('[competitorSync] could not find matching projects:', e.message);
    return;
  }

  for (const project of projects) {
    try {
      const access = await projectAccess.requireProject(req, project.id, 'view');
      const verdict = access.can('manageCompetitors');
      let changed = false;

      // After the screen ran: refresh the card only when the project compares
      // against exactly the screen's competitors. Then the project run reuses the
      // screen's snapshot and costs nothing; with a different set it would fetch
      // afresh and spend units nobody asked this click to spend.
      if (rerun && !added && !removed) {
        const tracked = (await store.listDomains(project.id))
          .filter((d) => d.role === 'competitor' && d.status === 'active')
          .map((d) => siteOf(d.host || d.normalized_origin)).sort();
        const screen = clientCompetitors.map(siteOf).sort();
        changed = tracked.length === screen.length && tracked.every((d, i) => d === screen[i]);
      }

      if (added && verdict) {
        try {
          await store.addCompetitor({
            access, domain: added, status: verdict === 'propose' ? 'proposed' : 'active', source: 'user_entered',
          });
          changed = true;
        } catch (e) {
          // Already tracked (409) is the outcome wanted; anything else is logged.
          if (e.status !== 409) console.warn(`[competitorSync] ${project.name}: could not add ${added}: ${e.message}`);
        }
      }

      if (removed && verdict === true) {
        const domains = await store.listDomains(project.id);
        const row = domains.find((d) => d.role === 'competitor' && siteOf(d.host || d.normalized_origin) === siteOf(removed));
        if (row) {
          await store.removeDomain({ access, domainId: row.id, reason: 'Removed on the Competitor Analysis screen' });
          changed = true;
        }
      }

      if (changed) {
        const domains = await store.listDomains(project.id);
        await competitorAutostart.scheduleCompetitorResearch({ access, domains });
      }
    } catch (e) {
      console.error(`[competitorSync] ${project.name}:`, e.message);
    }
  }
}

module.exports = { syncFromCompetitorTool };
