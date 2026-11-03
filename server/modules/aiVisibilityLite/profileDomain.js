// ── Is the business profile about the project's current domain? ────────────
//
// The profile and its questions are built once, from the primary domain at
// setup. Changing the domain afterwards restarted Competitor Research only, so
// AI Visibility kept asking about the old business and filed the answers under
// the new one: Soteri Skin, moved from position2.com to soteriskin.com, scored
// 0 on 90 answers about Position².
//
// Worked out on read from what the profile already stores (the pages it was
// built from), so no migration is needed and an old profile is caught too.

/** "https://www.Example.com/a" → "example.com"; null when it is not a URL. */
function hostOf(value) {
  if (!value) return null;
  const text = String(value).trim();
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
    return url.hostname.toLowerCase().replace(/^www\./, '') || null;
  } catch {
    return null;
  }
}

/**
 * The name a host is registered under, without its ending: "nike" for
 * nike.com, nike.in and www.nike.co.uk. A profile built from a country site of
 * the same brand (Nike's came from nike.in) is the same business, not a stale
 * one; the market mismatch is a separate problem.
 */
function siteName(host) {
  const parts = String(host || '').split('.').filter(Boolean);
  if (parts.length < 2) return parts[0] || null;
  const last = parts[parts.length - 1];
  const second = parts[parts.length - 2];
  // co.uk, com.au, org.in…: a short second level under a country ending.
  const compound = last.length === 2 && second.length <= 3 && parts.length >= 3;
  return compound ? parts[parts.length - 3] : second;
}

/** The same site: equal hosts, a subdomain, or the same name on another ending. */
function sameSite(a, b) {
  if (!a || !b) return false;
  if (a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`)) return true;
  return siteName(a) === siteName(b);
}

/**
 * True when the profile was built from the given domain — or when it cannot
 * tell (a profile with no recorded sources is never called stale).
 *
 * @param {{sourceUrls?: string[]}|null} profile
 * @param {string|null} domain  the project's primary host
 */
function profileMatchesDomain(profile, domain) {
  const current = hostOf(domain);
  const sources = (profile?.sourceUrls || []).map(hostOf).filter(Boolean);
  if (!current || !sources.length) return true;
  return sources.some((h) => sameSite(h, current));
}

/** The domain the profile was built from, for "built for X" wording. */
function profileDomain(profile) {
  return (profile?.sourceUrls || []).map(hostOf).find(Boolean) || null;
}

module.exports = { hostOf, siteName, profileMatchesDomain, profileDomain };
