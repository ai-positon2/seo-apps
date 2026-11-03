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

const CHALLENGE_TITLES = [
  /^just a moment/i,
  /security checkpoint/i,
  /checking (your|if the site connection is secure|the site connection)/i,
  /attention required/i,
  /verifying (your )?connection/i,
  /verify(ing)? (that )?you are (a )?human/i,
  /are you a (human|robot)/i,
  /please wait while we (verify|check)/i,
  /ddos[- ](guard|protection)/i,
  /pardon our interruption/i,
  /request unsuccessful/i,
  /^access denied$/i,
  /^captcha/i,
];

// A refusal status with next to no content is a wall even without a known title.
const REFUSAL_STATUSES = new Set([401, 403, 429, 503]);
const NEAR_EMPTY_WORDS = 50;

/**
 * @param {{ title?: string|null, wordCount?: number|null, status?: number|null }} page
 * @returns {string|null} why it is a bot wall, or null when it is a real page
 */
function challengeReason({ title = null, wordCount = null, status = null } = {}) {
  const t = String(title || '').trim();
  const hit = t && CHALLENGE_TITLES.find((re) => re.test(t));
  if (hit) return `The page is a bot-protection wall ("${t}"), not the site's content.`;
  const words = Number(wordCount);
  if (REFUSAL_STATUSES.has(Number(status)) && Number.isFinite(words) && words < NEAR_EMPTY_WORDS) {
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
