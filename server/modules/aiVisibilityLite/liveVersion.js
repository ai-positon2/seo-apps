// ── When the live report last changed, per project ───────────────────────────
//
// The dashboard card keeps the live report's score for a few minutes
// (projects/overview.js liveAiVisibilityTerminal), keyed by the newest finished
// run. Some things change the report without finishing a run — a question
// added, edited or removed, setup rewriting the profile, the background read of
// stored answers landing — and the card kept the old figure until the cache
// ran out. Each of those bumps this project's number, and the number is part
// of the card's cache key, so the next read builds afresh.
//
// In-process only, which is enough: those changes happen in the web process
// that serves the card. A run finishing elsewhere still busts the cache through
// its own run id.

const versions = new Map();

/** Mark the project's live report as changed. */
function bump(projectId) {
  if (!projectId) return;
  const key = String(projectId);
  versions.set(key, (versions.get(key) || 0) + 1);
}

/** The project's current number (0 until something changed). */
function current(projectId) {
  return versions.get(String(projectId)) || 0;
}

module.exports = { bump, current };
