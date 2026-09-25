// ── Where the file-backed modules keep their data ───────────────────────────
//
// Almost nothing, now. This file used to resolve the data directory for six
// modules that predated Postgres and still stored their state as JSON on disk:
// competitorAnalysis, contentArchitect, marketPotential (twice), onPageAudit and
// robotsMonitor. All six moved into the database in migrations 0032-0036; see
// scripts/importFileStores.js for the one-time move of the files themselves.
//
// ── Why they moved ──────────────────────────────────────────────────────────
// Each computed its own root as `path.join(__dirname, 'data')` — a path INSIDE
// the deployed code tree, with no way to point it anywhere else. That is
// invisible on a laptop and destroys data on a container platform: the image is
// rebuilt on every deploy and `data` is in .dockerignore, so the directory
// shipped empty and every restart was a factory reset.
//
// The first fix was this file: APP_DATA_ROOT relocated all six to a mounted
// volume. That stopped the deploy-time loss, but not the deeper problem, which
// was never really about deploys — a per-machine filesystem cannot hold state
// that a shared database refers to:
//
//   * project_module_runs.payload->>'reportRef' held a Content Architect project
//     id and a Competitor Research client id. The dashboard card linked to them.
//     Resolve that id against the local disk and, on any machine that did not
//     run the job, the card showed a score whose report answered "Project not
//     found" / "Client not found".
//   * marketPotential's SEMrush unit ledger enforced a daily spend cap from a
//     file, with an in-process mutex its own header admitted was not enough for
//     a multi-process deployment. This app runs a web process and a worker.
//   * robotsMonitor's clients.json WAS the list of what to monitor, so an empty
//     data root did not show an empty screen — it monitored nothing, quietly.
//
// None of that is fixed by moving the directory. It is fixed by the state
// living where the references to it live.
//
// ── What still uses this ────────────────────────────────────────────────────
// Two things, both deliberate:
//
//   * modules/crawlScope/run/report.js — the generated .xlsx audit workbooks.
//     These are large binaries, they are derived data, and the download route
//     REBUILDS one that has gone missing. Losing them costs time, not data, so
//     they stay on disk. APP_DATA_ROOT / REPORT_STORAGE_ROOT should still point
//     at a mounted volume on a container platform, to avoid paying the rebuild.
//   * locationPageBuilder/config.js — vestigial. That module's store moved to
//     Postgres in 0026 and the value is kept only for backward-compatible
//     exports; it does no IO.
//
// services/kbStore.js reads markdown from KB_ROOT / MODULES_ROOT and does NOT
// come through here. That is repo content rather than application state, so it
// is versioned with the code.

const path = require('path');

/**
 * Resolve one module's data directory.
 *
 * @param {string} slug        stable directory name under APP_DATA_ROOT
 * @param {string} legacyPath  the in-tree path this module used before
 * @param {string} [overrideEnv] name of a module-specific env var that wins outright
 * @returns {string} absolute path
 */
function resolveDataRoot(slug, legacyPath, overrideEnv = null) {
  if (overrideEnv) {
    const pinned = String(process.env[overrideEnv] || '').trim();
    if (pinned) return pinned;
  }

  const shared = String(process.env.APP_DATA_ROOT || '').trim();
  if (shared) return path.join(shared, slug);

  return legacyPath;
}

module.exports = { resolveDataRoot };
