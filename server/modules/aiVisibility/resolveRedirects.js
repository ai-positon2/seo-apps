// ── Recovering the real source behind a Google redirect ─────────────────────
//
// Google AI Overview references do not carry the source URL. Every one arrives
// looking like this:
//
//   { source: "Mayo Clinic",
//     domain: "google.com",                       <- DataForSEO's field, useless
//     url:    "https://google.com/goto?url=CAESeAHrOz...",
//     title:  "Dental implant surgery - Mayo Clinic" }
//
// Taking `domain` at face value makes every citation on every AI Overview read
// as google.com, which would quietly destroy the most actionable thing this
// module produces — "which sources get cited instead of you". It would also
// make a brand's own domain unfindable, so `cited` would be false for everyone,
// forever, and look entirely plausible.
//
// The redirect does resolve, in two hops:
//
//   google.com/goto?url=...  ->  www.google.com/goto?url=...  ->  mayoclinic.org/...
//
// The opaque `url=` payload is a protobuf-ish blob, not a URL, so it cannot be
// decoded locally — following the redirect is the only route. These links are
// short-lived, so it happens at capture time, not at read time.
//
// Same problem and the same remedy as Elmo's Vertex grounding-redirect handling
// (MIT — see ./LICENSE-elmo.md); the host and hop count differ.

const REDIRECT_HOSTS = /^(www\.)?google\.[a-z.]+$/i;
const MAX_HOPS = 5;
const HOP_TIMEOUT_MS = 8000;

// Resolved in parallel, but not all at once: a 9-citation AI Overview firing
// nine simultaneous requests at Google is exactly the shape that earns a rate
// limit, and a rate limit here costs the whole capture's citation data.
const CONCURRENCY = 4;

// A desktop UA. Not evasion — a bare Node fetch is refused outright by this
// endpoint, and the redirect target legitimately varies by client.
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** Is this a Google redirector rather than a real source? */
function isGoogleRedirect(url) {
  try {
    const parsed = new URL(url);
    return REDIRECT_HOSTS.test(parsed.hostname) && parsed.pathname.startsWith('/goto');
  } catch {
    return false;
  }
}

/**
 * Follow one redirect chain to its destination.
 *
 * Returns the final URL, or null when it cannot be resolved — null, not the
 * redirect URL, so the caller can tell "this is mayoclinic.org" from "we do not
 * know what this is". Those must not collapse into the same value.
 */
async function resolveOne(url) {
  let current = url;
  for (let hop = 0; hop < MAX_HOPS; hop += 1) {
    let response;
    try {
      response = await fetch(current, {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(HOP_TIMEOUT_MS),
        headers: { 'User-Agent': USER_AGENT },
      });
    } catch {
      return null;
    }

    const location = response.headers.get('location');
    if (!location) return null;

    try {
      current = location.startsWith('http') ? location : new URL(location, current).toString();
    } catch {
      return null;
    }

    // Landed somewhere that is not the redirector — that is the source.
    if (!isGoogleRedirect(current)) return current;
  }
  return null;
}

/**
 * Fill in the real domain on every citation that is hiding behind a redirect.
 *
 * Mutates and returns the array. Citations that are already real URLs are left
 * untouched and cost nothing.
 *
 * A citation that cannot be resolved keeps `domain: null` and `resolved: false`.
 * That is what lets `citesDomain` answer "unknown" instead of "no" — see the
 * note there about why a partial resolution must not read as an absence.
 */
async function resolveCitations(citations) {
  const pending = citations.filter((c) => c.redirect && !c.resolved);
  if (!pending.length) return citations;

  // Dedupe: the same source often appears twice in one overview.
  const byUrl = new Map();
  for (const citation of pending) {
    if (!byUrl.has(citation.url)) byUrl.set(citation.url, []);
    byUrl.get(citation.url).push(citation);
  }

  const urls = [...byUrl.keys()];
  const resolved = new Map();

  for (let i = 0; i < urls.length; i += CONCURRENCY) {
    const batch = urls.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map((url) => resolveOne(url)));
    batch.forEach((url, n) => resolved.set(url, results[n]));
  }

  for (const [url, group] of byUrl) {
    const finalUrl = resolved.get(url);
    for (const citation of group) {
      if (!finalUrl) continue;
      try {
        citation.url = finalUrl;
        citation.domain = new URL(finalUrl).hostname.replace(/^www\./i, '').toLowerCase();
        citation.resolved = true;
      } catch {
        // Leave it unresolved rather than storing a half-parsed value.
      }
    }
  }

  return citations;
}

module.exports = {
  isGoogleRedirect,
  resolveOne,
  resolveCitations,
  CONCURRENCY,
  MAX_HOPS,
  HOP_TIMEOUT_MS,
};
