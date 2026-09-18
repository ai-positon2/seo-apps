// ── The three API surfaces ───────────────────────────────────────────────────
//
// A deliberately small mirror of modules/aiVisibility/surfaces/index.js, and
// the reason it is separate rather than shared is worth stating plainly:
//
// v1's registry is the list of surfaces v1 RUNS. Adding these three to it would
// put API surfaces inside a module whose every run, report and default surface
// set is about scraped consumer UIs — and the brief for this module is that v1
// is not to be touched. A second registry costs eleven lines and keeps the two
// modules independent, which is the property that matters going forward.
//
// The surface CONTRACT is shared, not copied: these three return exactly the
// shape v1 documents, which is what lets measure.js reuse v1's matchers and the
// whole metrics layer read the resulting rows unchanged.

const openaiApi = require('./openaiApi');
const anthropicApi = require('./anthropicApi');
const googleApi = require('./googleApi');

// Keyed `engine:provider`, the same convention v1 uses, so a surface id read off
// a stored row means the same thing in both modules.
const SURFACES = {
  [`${openaiApi.ENGINE}:${openaiApi.PROVIDER}`]: openaiApi,
  [`${anthropicApi.ENGINE}:${anthropicApi.PROVIDER}`]: anthropicApi,
  [`${googleApi.ENGINE}:${googleApi.PROVIDER}`]: googleApi,
};

// Every run measures all three. Unlike v1 — where the surface set is a real
// choice between a cheap SERP surface and an expensive chat one — the whole
// point here is comparing what the three models say about the same brand, and a
// run missing one of them is not comparable with a run that had it.
const ALL_SURFACE_IDS = Object.keys(SURFACES);

/** Every surface id, e.g. 'openai:api'. */
function surfaceIds() {
  return [...ALL_SURFACE_IDS];
}

/** One surface, or null for an id we do not serve. Never throws on a typo. */
function surfaceFor(id) {
  return SURFACES[id] || null;
}

/**
 * Which surfaces can run right now, and why the others cannot.
 *
 * A missing key is reported rather than attempted. A run that fires three calls
 * and stores three identical "not configured" failures has spent a run from the
 * project's 30 and measured nothing — so the caller gets to decide before
 * spending, and the reason is a sentence a person can act on.
 */
function availability() {
  return ALL_SURFACE_IDS.map((id) => {
    const surface = SURFACES[id];
    const ready = surface.hasKey();
    return {
      id,
      engine: surface.ENGINE,
      label: surface.LABEL,
      ready,
      reason: ready ? null
        : `${surface.ENGINE.toUpperCase()} is not configured on the server — its API key is missing.`,
    };
  });
}

/** The ids that can actually run. */
function readySurfaceIds() {
  return availability().filter((s) => s.ready).map((s) => s.id);
}

module.exports = {
  SURFACES, ALL_SURFACE_IDS, surfaceIds, surfaceFor, availability, readySurfaceIds,
};
