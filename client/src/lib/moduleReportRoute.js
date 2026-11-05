import { readActiveProjectId, withProjectParam } from './activeProject.js';

// ── Where a module's own report lives ────────────────────────────────────────
//
// Opening a module from its dashboard card goes straight to that module's report.
// Two kinds of module, one answer each:
//
//   • Site Crawler, Content Architect and Competitor Research keep their report
//     on a route of their own, so there is a path to go to.
//   • SEO & GEO, On-Page and Agent Readiness render their report from page
//     state, so the answer is the tool page itself — the project panel there
//     hands the stored run to that page's own report view on open.
//
// Either way the destination shows the module's real report rather than a
// summary of it, and neither the card nor the panel composes a path of its own:
// two copies of this would drift the moment one of these modules changed route.

/** The id a module's own report is keyed by, from what the card carries. */
function reportRefFor(module) {
  // Site Crawler's report is a crawl run, and the card already carries its id.
  if (module.key === 'technical') return module.runId || null;
  // The rest store the id their report is keyed by when the run is recorded.
  return module.reportRef || null;
}

/**
 * @param {object} module a dashboard card (overview.evidenceCard / technicalCard)
 * @returns {{ path: string, label: string, isReport: boolean }}
 *   `isReport` is false when this only reaches the tool, not a stored report —
 *   used to keep the button honest about what the click does.
 */
// Every route carries the client it is about (?project=<id>). Without it a
// copied report link opened whichever client the READER last picked: LogicGate's
// SEO & GEO link showed Position2's report, with nothing in the URL that could
// have said otherwise. The shell adopts ?project= on arrival (MacWindow).
//
// `projectId` defaults to the card's own, then this tab's active client — the
// dashboard only ever shows cards for that one.
export function moduleReportRoute(module, { projectId } = {}) {
  const pid = projectId ?? module.projectId ?? readActiveProjectId();
  const route = baseRoute(module);
  return { ...route, path: route.path ? withProjectParam(route.path, pid) : route.path };
}

function baseRoute(module) {
  const ref = reportRefFor(module);

  if (ref) {
    if (module.key === 'technical') {
      return { path: `/crawl-scope/runs/${ref}`, label: 'View report', isReport: true };
    }
    if (module.key === 'hub_spoke') {
      return { path: `/content-architect/${ref}`, label: 'View report', isReport: true };
    }
    if (module.key === 'competitor') {
      return { path: `/competitor-analysis?client=${ref}`, label: 'View report', isReport: true };
    }
  }

  // The in-page modules: the tool page IS the report once its panel hydrates.
  // A module with evidence but no ref lands here too, which is correct — the
  // panel shows what was stored and says if there is no report to open.
  // 'View report' only when there is evidence to render. A module that ran and
  // found nothing to measure has a note to read, not a report to view, and
  // promising one would be the same overstatement the cards avoid elsewhere.
  return {
    path: module.toolPath,
    label: module.evidence ? 'View report' : 'Open',
    isReport: Boolean(module.evidence),
  };
}

export default moduleReportRoute;

/**
 * A crawl run's report, carrying the client it belongs to. `projectId` is the
 * run's own client when the caller has it (run.project_id); otherwise this
 * tab's client, which is the one every list of runs here is about. The run page
 * also switches the header to the run's own client once it has loaded.
 */
export function runReportPath(runId, projectId) {
  if (!runId) return '/crawl-scope';
  return withProjectParam(`/crawl-scope/runs/${runId}`, projectId || readActiveProjectId());
}
