// ── Approved keyword selections, keyed by (client, service, location) ───────
// The SEO team's approved primary/secondary picks, saved the MOMENT they are
// approved rather than only as a byproduct of generating a page. Two reasons:
// approving and navigating away used to lose the work outright, and re-opening
// a saved page had nothing to rehydrate from, so it silently re-ran the BILLED
// research call.
//
// Extracted from dentalWizard.js unchanged when the template-driven engine
// (lsWizard) needed the same records. Nothing in here was ever dental-specific
// — it is a tuple-keyed upsert with a deterministic id — and the id scheme and
// stray-row self-heal below are subtle enough that a second copy would be a
// liability. dentalWizard re-exports these so its own module API is unchanged.

const crypto = require('crypto');
const store = require('./store');

// tuple_key exists as its own column so the store's single-field upsertBy and
// removeWhere can match a row by tuple without parsing the id.
function tupleKey({ clientId, serviceId, locationId }) {
  return `${clientId}|${serviceId}|${locationId}`;
}

// The row id is a pure function of the tuple, so concurrent writers (the
// client saving an approval while a generate call records its own) address the
// SAME row and upsert converges instead of inserting a duplicate. A read-then-
// write upsert cannot guarantee that -- and a duplicate would be worse than no
// record at all, since reads would then pick between them arbitrarily.
function selectionId(tuple) {
  return `kws_${crypto.createHash('sha1').update(tupleKey(tuple)).digest('hex').slice(0, 16)}`;
}

// Full candidate objects are stored, not bare keyword strings, so the keyword
// step's table (volume / difficulty / intent / source columns) renders
// identically on reload instead of degrading to zero-volume rows.
// `approved` distinguishes a deliberate human approval from the pool that gets
// saved automatically after a research run. Both are worth persisting (the
// automatic one is what stops a revisit from re-billing research), but only the
// first is an actual sign-off, and the two must not be conflated.
async function saveSelection({ clientId, serviceId, locationId, primary, secondary, candidates, approved = true }) {
  const tuple = { clientId, serviceId, locationId };
  const id = selectionId(tuple);
  const previous = await store.get('keywordSelections', id);
  const record = {
    id,
    tuple_key: tupleKey(tuple),
    client_id: clientId, service_id: serviceId, location_id: locationId,
    primary: primary || [],
    secondary: secondary || [],
    candidates: candidates || [],
    approved: !!approved,
    // Preserve the moment of the FIRST real approval; an automatic save must
    // never stamp (or clear) it.
    approved_at: approved ? store.nowIso() : (previous?.approved_at || null),
  };
  const saved = await store.upsertById('keywordSelections', record, 'kws');

  // Self-heal: drop any row for this tuple left behind under a
  // non-deterministic id (written before this id scheme, or by an earlier
  // duplicate-producing race). Best-effort -- never fail a save over cleanup.
  try {
    const strays = await store.list('keywordSelections', { tuple_key: record.tuple_key });
    for (const row of strays) {
      if (row.id !== id) await store.remove('keywordSelections', row.id);
    }
  } catch (e) {
    console.error('[LPB] Failed to clean duplicate keyword selections:', e.message);
  }
  return saved;
}

// Reads by the deterministic id first so the result is unambiguous even if a
// stray legacy row for the same tuple still exists.
async function getSelection({ clientId, serviceId, locationId }) {
  const tuple = { clientId, serviceId, locationId };
  const byId = await store.get('keywordSelections', selectionId(tuple));
  if (byId) return byId;
  return store.findOne('keywordSelections', { tuple_key: tupleKey(tuple) });
}

// Re-records an approval from keyword STRINGS, reusing the rich candidate
// objects (volume/difficulty/intent/source) already stored for the same
// keywords. Without the rehydrate, generating a page would flatten a
// just-approved selection back to bare zero-volume keywords.
//
// Non-fatal by contract: callers use this as bookkeeping alongside a generated
// page, and a page must never be lost over a bookkeeping write.
async function recordApproval({ clientId, serviceId, locationId, primary, secondary }) {
  const tuple = { clientId, serviceId, locationId };
  const existing = await getSelection(tuple);
  const known = new Map(
    [...(existing?.primary || []), ...(existing?.secondary || []), ...(existing?.candidates || [])]
      .filter(c => c && c.keyword)
      .map(c => [c.keyword, c]),
  );
  const hydrate = k => known.get(k) || { keyword: k };
  return saveSelection({
    clientId, serviceId, locationId,
    primary: (primary || []).map(hydrate),
    secondary: (secondary || []).map(hydrate),
    candidates: existing?.candidates || [],
    approved: true, // generating a page IS the approval
  });
}

module.exports = { tupleKey, selectionId, saveSelection, getSelection, recordApproval };
