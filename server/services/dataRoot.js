// ── Where the file-backed modules keep their data ───────────────────────────
//
// Six modules predate Supabase and still store their state as JSON on disk:
// competitorAnalysis, contentArchitect, marketPotential (twice), onPageAudit and
// robotsMonitor. Each computed its own root as `path.join(__dirname, 'data')` —
// a path INSIDE the deployed code tree, with no way to point it anywhere else.
//
// That is invisible on a laptop and destroys data on a container platform. The
// image is rebuilt on every deploy and `data` is in .dockerignore, so the
// directory ships empty and every restart is a factory reset. The symptom is not
// an error, which is what makes it expensive to diagnose: a module runs, reports
// success, writes its result — and its screen says "nothing here yet" after the
// next deploy, because the run's evidence row survived in Postgres and the JSON
// beside it did not.
//
// So the root is resolved through here instead:
//
//   APP_DATA_ROOT unset  ->  the historical in-tree path, unchanged. Local
//                            development and existing checkouts behave exactly
//                            as before, including data already on disk.
//   APP_DATA_ROOT set    ->  <APP_DATA_ROOT>/<slug>, which on a container
//                            platform is a mounted volume that survives deploys.
//
// The per-module override (LPB_DATA_ROOT, and the others named below) still wins
// over both, because a deployment that has already pinned one must not have it
// moved by adding APP_DATA_ROOT.
//
// This does NOT migrate anything. Pointing an existing deployment at a new root
// gives it an empty one; the modules all treat "no file" as "nothing stored yet"
// rather than as an error, so they start clean rather than failing.

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
