// ── Reading an answer out of the logged-out chatgpt.com DOM ─────────────────
//
// Pure functions over strings the browser hands back, so every parsing rule
// here is testable without launching Chrome. The browser half lives in
// ../surfaces/chatgptScraped.js and does nothing but collect these inputs.
//
// Everything below was derived from six live capture runs against the
// logged-out UI. Two findings shape it, and both are easy to get wrong:
//
//   1. Logged-out serves an `unauth-mweb` variant that has NONE of the
//      `data-message-author-role` / `.markdown` selectors that signed-in
//      examples use. The reliable seam is main's innerText split on the
//      "ChatGPT said:" divider.
//
//   2. A LOCAL query ("best dentist in boston") does not return prose at all.
//      It returns a map with business cards. The brand names are present as
//      text but in a wholly different shape, so a prose-only reader records
//      `mentioned: false` — a FALSE ABSENCE on exactly the query type a local
//      business cares about. Map cards are parsed here as a first-class answer.

// The divider chatgpt.com puts between the echoed prompt and the reply.
const ANSWER_DIVIDER = /ChatGPT said:/i;
const PROMPT_DIVIDER = /You said:/i;

// Chrome the sidebar always contributes; stripped so it can never be scanned
// for a brand name or counted toward answer length.
const CHROME_LINES = new Set([
  'new chat', 'search chats', 'images', 'plugins', 'deep research',
  'see plans and pricing', 'settings', 'help', 'log in', 'sign up for free',
  'chatgpt', 'get responses tailored to you', 'where should we begin?',
  'chat with chatgpt', 'ask chatgpt', 'sources', 'scroll to bottom',
  'chatgpt is ai and can make mistakes.',
]);

/**
 * The assistant's reply, or null when there isn't one.
 *
 * Null rather than '' on purpose: capture.js treats a missing answer as
 * NO_ANSWER (measured, brand genuinely not present) and an empty string would
 * be scanned for the brand and scored as a real absence. Those are different
 * claims — see 0016's header.
 */
function answerFromMainText(mainText) {
  const text = String(mainText || '');
  if (!text.trim()) return null;

  const parts = text.split(ANSWER_DIVIDER);
  if (parts.length < 2) return null;

  // Everything after the LAST divider — a multi-turn page would otherwise
  // return the first reply rather than the one we just asked for.
  const tail = parts[parts.length - 1];

  const cleaned = tail
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !CHROME_LINES.has(l.toLowerCase()))
    // The login prompt block the logged-out UI appends under every answer.
    .filter((l) => !/^log in to get answers based on saved chats/i.test(l))
    .filter((l) => !/^by using it, you agree to our terms/i.test(l))
    .join('\n')
    .trim();

  return cleaned || null;
}

/** The prompt as the page echoed it back — used to confirm what was actually asked. */
function echoedPromptFromMainText(mainText) {
  const text = String(mainText || '');
  const afterYou = text.split(PROMPT_DIVIDER)[1];
  if (!afterYou) return null;
  const beforeAnswer = afterYou.split(ANSWER_DIVIDER)[0] || '';
  const line = beforeAnswer.split('\n').map((l) => l.trim()).find(Boolean);
  return line || null;
}

// A business card renders as:
//     Devonshire Dental of Boston
//     ★ 5.0
//     •
//     Dentist
//     Closed
// Rating, category and status are each optional in practice, so only the name
// plus at least one following signal is required.
const RATING_LINE = /^★\s*([\d.]+)$/;
const BULLET_LINE = /^[•·]$/;
const STATUS_LINE = /^(open|closed|opens|closes|open 24 hours|temporarily closed)\b/i;

/**
 * Business cards from a map answer, in the order the model listed them.
 *
 * `position` is the card's rank, which is a truer "named Nth" than a character
 * offset into prose — METRICS.md §3.5 wants the ordinal, and for a map answer
 * this IS the ordinal.
 */
function mapCardsFromText(answerText) {
  const lines = String(answerText || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const cards = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // Structural lines never start a card, and a bare number is a map marker.
    if (RATING_LINE.test(line) || BULLET_LINE.test(line) || STATUS_LINE.test(line) || /^\d+$/.test(line)) {
      i += 1;
      continue;
    }

    // Walk forward over the lines that belong to THIS card. Consuming them is
    // what stops a card's own category ("Dentist") being re-read as the next
    // business name — it would otherwise find the following card's "Closed"
    // and duplicate every entry.
    let j = i + 1;
    let rating = null;
    let category = null;
    let status = null;
    let sawBullet = false;

    while (j < lines.length) {
      const next = lines[j];
      if (RATING_LINE.test(next)) { rating = Number(RATING_LINE.exec(next)[1]); j += 1; continue; }
      if (BULLET_LINE.test(next)) { sawBullet = true; j += 1; continue; }
      if (STATUS_LINE.test(next)) { status = next; j += 1; continue; }
      // Exactly one free-text line is allowed, and only directly after the
      // bullet — that is the category.
      if (sawBullet && category === null) { category = next; j += 1; continue; }
      break;
    }

    // A name with no rating and no status is just prose, not a card.
    if (rating === null && status === null) { i += 1; continue; }

    cards.push({
      name: line, rating, category, status, position: cards.length + 1,
    });
    i = j;
  }

  return cards;
}

/**
 * Source domains, read off the favicon images ChatGPT renders beside each
 * citation chip.
 *
 * Citations logged-out are spans/buttons, NOT anchors — four spike runs
 * reported zero citations purely because they looked for `<a href>`. The
 * favicon `?domain=` parameter is the reliable carrier.
 *
 * Full URLs (with path) are not exposed here; they sit behind the "Sources"
 * sheet. Domain-level is sufficient for METRICS.md §5.2 and §6, which key on
 * domain; the URLs report (§5.4) needs more and is deferred.
 */
function citationsFromFaviconSrcs(srcs) {
  const byHost = new Map();

  for (const src of srcs || []) {
    const match = /[?&]domain=([^&]+)/.exec(String(src || ''));
    if (!match) continue;
    let host;
    try {
      host = decodeURIComponent(match[1]).replace(/^https?:\/\//i, '').replace(/\/.*$/, '').toLowerCase();
    } catch { continue; }
    if (!host) continue;

    const existing = byHost.get(host);
    if (existing) { existing.occurrences += 1; continue; }
    byHost.set(host, {
      url: null,                                   // not exposed logged-out
      title: null,
      host,
      domain: host.replace(/^www\./, ''),
      isInlineCited: true,                         // these chips sit in the answer body
      // How many times the answer leaned on this source. METRICS.md §2.2
      // dedupes per capture by normalised URL; without full URLs the honest
      // equivalent is per host, so this counts chip appearances rather than
      // distinct pages — the closest available proxy for §5.2's `retrievals`,
      // and better than discarding the repetition entirely.
      occurrences: 1,
      index: byHost.size,
    });
  }

  return [...byHost.values()];
}

/**
 * Did the page hand us a bot wall rather than an answer?
 *
 * Recorded as a FAILED capture with a reason, never as an absent brand — a
 * block tells us nothing about the client's visibility (§16.11, and 0016's
 * header on why `mentioned` is nullable).
 */
function blockReason({ mainText = '', title = '', url = '' } = {}) {
  const haystack = `${title}\n${mainText}`;
  if (/just a moment|verify you are human|checking your browser|enable javascript and cookies/i.test(haystack)) {
    return 'cloudflare_interstitial';
  }
  if (/access denied|you have been blocked|rate limit|too many requests/i.test(haystack)) {
    return 'blocked_or_rate_limited';
  }
  if (/\/auth\/login/.test(url) && !/chatgpt\.com\/?(\?|$)/.test(url)) {
    return 'redirected_to_login';
  }
  return null;
}

/** Which answer shape came back — stored so map and prose answers are never
 *  silently averaged together (METRICS.md §2.3 lists `map` as a feature). */
function answerFeatures({ answerText, mapCards, citations }) {
  const features = [];
  if (mapCards && mapCards.length) features.push('map');
  if (citations && citations.length) features.push('web_search');
  if (answerText && !(mapCards && mapCards.length)) features.push('prose');
  return features;
}

module.exports = {
  answerFromMainText,
  echoedPromptFromMainText,
  mapCardsFromText,
  citationsFromFaviconSrcs,
  blockReason,
  answerFeatures,
  CHROME_LINES,
};
