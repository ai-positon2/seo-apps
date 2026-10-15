// ── The module's own score, on the snapshot this screen reads ───────────────
//
// The Competitor Research screen leads with the same 0-100 the dashboard card
// shows. It is computed here, server-side, by the dashboard's own function —
// imported, not reimplemented — so the screen and the card cannot disagree
// about a number that claims to be the same one.
//
// Required lazily: moduleRunners already requires this module's siblings
// lazily for the same reason, and a top-level require in both directions would
// hand one side a half-built module.

/**
 * @param {object|null} snapshot  a stored dashboard snapshot
 * @returns {object|null} the snapshot plus `trafficScore` (null when there is
 *   nothing to compare against — never 0)
 */
function withTrafficScore(snapshot) {
  if (!snapshot) return snapshot;
  const { competitorTrafficScore } = require('../projects/moduleRunners');
  return { ...snapshot, trafficScore: competitorTrafficScore(snapshot.domains) };
}

module.exports = { withTrafficScore };
