// ── Stage 0: domain input ────────────────────────────────────────────────────
// Accepts whatever shape the user typed (example.com, https://example.com,
// www.example.com/) and resolves it to one canonical origin by actually
// requesting it — trusting a HEAD/GET response's final URL (after redirects)
// rather than guessing protocol or www from the input string alone, since
// either could be wrong (a bare domain might redirect to www, or vice versa;
// http might redirect to https, or a site might only serve http).
const { fetchSafe, UnsafeUrlError } = require('./urlSafety');

function stripScheme(input) {
  return input.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
}

async function tryReach(origin) {
  try {
    const res = await fetchSafe(origin, { method: 'head', timeout: 10000 });
    return { ok: true, finalUrl: res.finalUrl };
  } catch (err) {
    if (err instanceof UnsafeUrlError) throw err;
    // Some servers reject HEAD outright (405/501) — a real site can still be
    // up. Retry with GET before giving up on this origin.
    try {
      const res = await fetchSafe(origin, { method: 'get', timeout: 10000 });
      return { ok: true, finalUrl: res.finalUrl };
    } catch {
      return { ok: false };
    }
  }
}

class UnreachableDomainError extends Error {
  constructor(input) {
    super(`Could not reach "${input}". Check the domain is correct and the site is publicly accessible.`);
    this.name = 'UnreachableDomainError';
  }
}

// Returns { canonicalOrigin, host } — canonicalOrigin is the scheme+host the
// rest of the pipeline should use everywhere (e.g. "https://www.example.com").
async function resolveDomain(rawInput) {
  if (!rawInput || !rawInput.trim()) throw new Error('Domain is required.');
  const bareHost = stripScheme(rawInput);
  if (!bareHost || /\s/.test(bareHost)) throw new Error(`"${rawInput}" doesn't look like a valid domain.`);

  // Try https first (the common case today), then http, before failing.
  for (const scheme of ['https', 'http']) {
    const result = await tryReach(`${scheme}://${bareHost}`);
    if (result.ok) {
      const u = new URL(result.finalUrl);
      return { canonicalOrigin: `${u.protocol}//${u.hostname}`, host: u.hostname };
    }
  }
  throw new UnreachableDomainError(rawInput);
}

module.exports = { resolveDomain, UnreachableDomainError, stripScheme };
