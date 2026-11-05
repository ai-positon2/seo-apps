// ── Is this a bot wall rather than the site's page? ─────────────────────────
//
// Bot protection answers an unknown visitor with a holding page — Cloudflare's
// "Just a moment…", Vercel's "Security Checkpoint" — instead of the content.
// Audited, that page was scored as the site: 8x8's entire SEO & GEO score (45)
// is a Vercel checkpoint page, and a Cloudflare "Just a moment…" page scoring
// 15 pulled an Eventgroove site from 86 to 72. Such a page is "blocked — not
// measured", never a score.
//
// Recognised by what the page says as well as its status: a challenge can be
// served with 200, and a 429 is not always one.

// Whole-title matches only. Unanchored phrases flagged real pages: "Free
// Checking Your Way | Acme Bank" matched /checking your/, and "Security
// Checkpoint Software | Acme" matched /security checkpoint/.
const CHALLENGE_TITLES = [
  /^just a moment(\.{3}|…)?$/i,                                   // Cloudflare
  /^attention required!? \| cloudflare$/i,
  /^please wait(\.{3}|…)? \| cloudflare$/i,
  /^checking your browser before accessing\b/i,
  /^(vercel )?security checkpoint$/i,                              // Vercel
  /^verifying (your )?connection(\.{3}|…)?$/i,
  /^verify(ing)? (that )?you are (a )?human\b/i,
  /^(human verification|are you a (human|robot)\??|robot check|bot check)$/i,
  /^one moment, please(\.{3}|…)?$/i,
  /^ddos[- ]guard$/i,
  /^pardon our interruption\.?$/i,                                 // Imperva / Distil
  /^request unsuccessful\. incapsula incident id\b/i,
  /^request unsuccessful\.?$/i,
  /^access to this page has been denied\.?$/i,                     // PerimeterX
  /^access denied$/i,                                              // Akamai
  /^captcha$/i,
];

// Markers only a challenge/interstitial carries (not the sensor scripts these
// vendors also load on ordinary pages).
const BODY_MARKERS = /_cf_chl_opt|captcha-delivery\.com|id=["']?px-captcha|bm-verify|sec-if-cpt|vercel-challenge/i;
const MITIGATED_HEADERS = ['cf-mitigated', 'x-vercel-mitigated'];

// A refusal status with next to no content is a wall even without a known title.
const REFUSAL_STATUSES = new Set([401, 403, 429, 503]);
const NEAR_EMPTY_WORDS = 50;
// A 200 page with a challenge title is a wall only when it is this thin (or
// carries a challenge marker): a real page can share a title, not its size.
const THIN_WORDS = 500;

function hasMarkers(html, headers) {
  const h = headers || {};
  const header = (name) => (typeof h.get === 'function' ? h.get(name) : h[name] ?? h[name.toLowerCase()]);
  if (MITIGATED_HEADERS.some((n) => /challenge|deny/i.test(String(header(n) || '')))) return true;
  return typeof html === 'string' && BODY_MARKERS.test(html.slice(0, 200000));
}

/**
 * @param {{ title?: string|null, wordCount?: number|null, status?: number|null,
 *           html?: string|null, headers?: object|null }} page
 *   wordCount null = unknown (a title alone, as the sitemap crawler has).
 * @returns {string|null} why it is a bot wall, or null when it is a real page
 */
function challengeReason({ title = null, wordCount = null, status = null, html = null, headers = null } = {}) {
  const t = String(title || '').trim();
  const titled = Boolean(t) && CHALLENGE_TITLES.some((re) => re.test(t));
  const words = wordCount === null || wordCount === undefined || wordCount === '' ? NaN : Number(wordCount);
  const known = Number.isFinite(words);
  const thin = !known || words < THIN_WORDS;
  const refused = REFUSAL_STATUSES.has(Number(status));
  const marked = hasMarkers(html, headers);

  if (titled && (refused || thin || marked)) {
    return `The page is a bot-protection wall ("${t}"), not the site's content.`;
  }
  // A recognised interstitial marker on a thin page, whatever its title.
  if (marked && known && words < THIN_WORDS) {
    return "The page is a bot-protection challenge, not the site's content.";
  }
  if (refused && known && words < NEAR_EMPTY_WORDS) {
    return `The site refused the request (HTTP ${status}) with an almost empty page.`;
  }
  return null;
}

/** The title and word count an SEO & GEO audit stored (checks A1 and F1). */
function pageFacts(findings) {
  const checks = Array.isArray(findings?.checks) ? findings.checks : [];
  const value = (id) => checks.find((c) => c && c.id === id)?.value ?? null;
  const words = parseInt(String(value('F1') ?? ''), 10);
  return {
    title: value('A1'),
    wordCount: Number.isFinite(words) ? words : null,
    status: Number(findings?.meta?.http_status) || null,
  };
}

module.exports = { challengeReason, pageFacts };
