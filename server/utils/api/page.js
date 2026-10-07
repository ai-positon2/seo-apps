// ── Lists: paging, booleans and sorting in query strings ─────────────────────
//
//   GET …?limit=50&offset=100&sort=-createdAt&retired=true
//   → { "<plural>": [...], "page": { limit, offset, total, nextOffset } }
//
// A list that has no limit today passes `unbounded: true`, so calling it
// without `limit` still returns every row.

const { badRequest } = require('./errors');

function toInt(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

/** '1' | 'true' | 'yes' → true; '0' | 'false' | 'no' → false; anything else → undefined. */
function parseBool(value) {
  if (value === undefined || value === null) return undefined;
  const s = String(value).trim().toLowerCase();
  if (s === '1' || s === 'true' || s === 'yes') return true;
  if (s === '0' || s === 'false' || s === 'no') return false;
  return undefined;
}

function parsePage(query = {}, { defaultLimit = 50, maxLimit = 200, unbounded = false } = {}) {
  const askedLimit = toInt(query.limit);
  let limit;
  if (askedLimit === null) limit = unbounded ? null : defaultLimit;
  else limit = Math.min(Math.max(askedLimit, 1), maxLimit);
  const offset = Math.max(toInt(query.offset) ?? 0, 0);
  return { limit, offset };
}

function pageMeta({ limit, offset = 0, returned = 0, total }) {
  const knownTotal = total ?? (limit === null ? offset + returned : null);
  const more = limit !== null && returned >= limit && (knownTotal === null || offset + returned < knownTotal);
  return { limit, offset, total: knownTotal, nextOffset: more ? offset + returned : null };
}

/** 'name' → asc, '-name' → desc; fields outside `allowed` are a 400. */
function parseSort(value, allowed, fallback) {
  const raw = value === undefined || value === null || value === '' ? fallback : String(value).trim();
  const direction = raw.startsWith('-') ? 'desc' : 'asc';
  const field = raw.replace(/^[-+]/, '');
  if (!allowed.includes(field)) {
    throw badRequest(`Cannot sort by "${field}". Allowed: ${allowed.join(', ')}.`);
  }
  return { field, direction };
}

module.exports = { parseBool, parsePage, pageMeta, parseSort };
