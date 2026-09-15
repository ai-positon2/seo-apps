// ── Identifier guard for file-backed stores ─────────────────────────────────
// The file-backed modules name their files after an id that arrives from the
// request — `${id}.json`, `${id}_patterns.json`, `${clientId}.json`. path.join
// resolves `..` silently, so an id of `../../x` does not fail: it produces a
// path outside the module's data root, and the store then reads, writes or
// unlinks there.
//
// Suffixes limit the damage (you can only reach files ending in `.json`,
// `_patterns.json`, …) but they do not contain it, and a DELETE route that
// unlinks four sidecars turns into an arbitrary file delete with a known
// suffix. The ids these modules generate are `proj_<base36><hex>`,
// `aud_<hex>` and similar, so a strict character class costs them nothing.
//
// Same principle as recordStore.table() and recordStore.jsonKey(): the value is
// interpolated into something consequential, so it is validated at the point of
// interpolation rather than trusted to have been checked upstream. Validating
// inside the path builders means no caller can skip it — including the module's
// own internal callers, which is where an upstream-only check would leak.

class UnsafeIdError extends Error {
  constructor(id) {
    super(`Unsafe identifier: ${JSON.stringify(String(id))}`);
    this.name = 'UnsafeIdError';
    this.status = 400;
    this.code = 'unsafe_id';
  }
}

// Letters, digits, underscore, hyphen and dot — but never a path separator, and
// never a segment that is entirely dots (which is what makes `..` traversal).
const SAFE = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/;

/**
 * Returns the id unchanged, or throws UnsafeIdError.
 * @param {string} id
 * @param {string} [what] label for the error message
 */
function assertSafeFileId(id, what = 'id') {
  const s = String(id == null ? '' : id);
  if (!s || s.length > 128 || !SAFE.test(s)) throw new UnsafeIdError(`${what}=${s}`);
  return s;
}

/** Non-throwing form, for callers that would rather skip than fail. */
function isSafeFileId(id) {
  try { assertSafeFileId(id); return true; } catch { return false; }
}

module.exports = { assertSafeFileId, isSafeFileId, UnsafeIdError };
