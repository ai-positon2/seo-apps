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

/**
 * Would following this URL reach our own network?
 *
 * A redirect target is chosen by whoever controls the page being cited, so
 * without this a citation could steer this server at its own private range or
 * at cloud metadata. Hostname-only: the DNS layer can still resolve a public
 * name to a private address, so this is a cheap first cut rather than a
 * complete defence — but it stops the direct forms outright.
 */
function isPrivateAddress(url) {
  let host;
  try { host = new URL(url).hostname.toLowerCase(); } catch { return true; }
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal')) return true;
  if (host === '[::1]' || host === '::1') return true;

  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!v4) return false;
  const [a, b] = v4.slice(1).map(Number);
  if ([a, b].some((n) => !Number.isFinite(n) || n > 255)) return true;
  return a === 10
    || a === 127
    || a === 0
    || (a === 192 && b === 168)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 169 && b === 254)   // link-local, and cloud metadata at 169.254.169.254
    || (a === 100 && b >= 64 && b <= 127); // carrier-grade NAT
}

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
      // HEAD first — only the Location header is ever read, and a GET pulls a
      // body from a third-party host for nothing. But HEAD is optional in
      // practice: plenty of redirectors answer 405 or 501, and taking that at
      // face value would leave the citation permanently unresolved, which reads
      // downstream as "we do not know what this source is".
      const send = (method) => fetch(current, {
        method,
        redirect: 'manual',
        signal: AbortSignal.timeout(HOP_TIMEOUT_MS),
        headers: { 'User-Agent': USER_AGENT },
      });

      response = await send('HEAD');
      if (response.status === 405 || response.status === 501
        || (!response.headers.get('location') && response.status >= 400)) {
        response = await send('GET');
      }
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

    // A redirect target is chosen by a third party. Following one into a
    // private range would let a citation steer this server at its own network.
    if (isPrivateAddress(current)) return null;

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
  isPrivateAddress,
  isGoogleRedirect,
  resolveOne,
  resolveCitations,
  CONCURRENCY,
  MAX_HOPS,
  HOP_TIMEOUT_MS,
};
