// ── Addresses a CDN manages for the browser, not pages of the site ──────────
//
// Cloudflare's Email Address Obfuscation rewrites every mailto: link to
// /cdn-cgi/l/email-protection#<encoded>, which its script decodes in the
// browser. Fetched directly the address answers 404, so a crawler that followed
// it charged "Broken internal links" — an error — on every page with an email
// link: Piece of Cake lost 39 points (511 of 519 pages), Eventgroove 16.
// Treated like mailto: — not crawled, not a link target, never broken.

const CDN_EMAIL_PROTECTION = /\/cdn-cgi\/l\/email-protection/i;

/** True for an href or URL the crawler should treat like a mailto: link. */
function isCdnManagedLink(value) {
  return CDN_EMAIL_PROTECTION.test(String(value || ''));
}

module.exports = { isCdnManagedLink };
