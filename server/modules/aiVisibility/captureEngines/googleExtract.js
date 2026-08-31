// ── Reading Google's AI Overview and AI Mode ────────────────────────────────
//
// Pure functions shared by both Google surfaces. They render differently but
// share Google's chrome, its outbound-link wrapping, and its bot wall.
//
// RECON REALITY, recorded so nobody re-learns it the hard way:
//
//   • The early hard blocks were caused by forcing `gl=us` from a non-US IP,
//     not by fingerprinting. Dropping that parameter turned `/sorry/index`
//     into a served answer. Locale must come from where the request EXITS.
//   • A homepage "warm-up" made things WORSE: Google's tolerance is
//     per-request-rate, so the extra request spent the allowance before the
//     one that mattered.
//   • Roughly one search per cooldown from a single address. Both surfaces
//     answer reliably with ~120s spacing; rotating residential proxies are
//     what remove that ceiling.
//
// A refusal is still a refusal, so blockReason is precise: it must be recorded
// as `failed`, never as a brand that was absent.

// Google's own furniture, stripped so it is never scanned for a brand name.
const CHROME_LINES = new Set([
  'skip to main content', 'accessibility help', 'accessibility feedback',
  'ai mode', 'all', 'images', 'videos', 'news', 'shopping', 'more', 'tools',
  'sign in', 'search results', 'about this result', 'feedback', 'settings',
  'privacy', 'terms', 'google apps', 'filters and topics', 'search',
  'people also ask', 'related searches', 'show more', 'show less',
  'ai responses may include mistakes', 'learn more',
]);

/**
 * A Google refusal, or null.
 *
 * `/sorry/index` is the redirect target for the interstitial; the text tells
 * are kept too because the redirect is not always followed before the body
 * is read.
 */
function blockReason({ mainText = '', title = '', url = '' } = {}) {
  if (/\/sorry\/(index|image)/.test(url)) return 'google_captcha';
  const haystack = `${title}\n${mainText}`;
  if (/unusual traffic|not a robot|recaptcha|detected unusual/i.test(haystack)) return 'google_captcha';
  if (/our systems have detected/i.test(haystack)) return 'google_captcha';
  return null;
}

/** Google wraps outbound links as /url?q=… — recover the real destination. */
function unwrapGoogleUrl(href) {
  try {
    const u = new URL(href);
    if (/(^|\.)google\./.test(u.hostname)) {
      const inner = u.searchParams.get('q') || u.searchParams.get('url') || u.searchParams.get('imgurl');
      if (inner && /^https?:/.test(inner)) return inner;
    }
    return href;
  } catch { return href; }
}

/** Citations from whatever outbound links the AI block exposed. */
function citationsFromLinks(hrefs = []) {
  const byHost = new Map();
  for (const raw of hrefs) {
    const real = unwrapGoogleUrl(String(raw || ''));
    let u;
    try { u = new URL(real); } catch { continue; }
    const host = u.hostname.toLowerCase();
    // Google's own properties are chrome, not sources.
    if (/(^|\.)(google|gstatic|googleusercontent|youtube)\.com$/.test(host)) continue;
    if (!/^https?:$/.test(u.protocol)) continue;

    const existing = byHost.get(host);
    if (existing) { existing.occurrences += 1; continue; }
    byHost.set(host, {
      // Unlike ChatGPT, Google DOES give the full destination URL — so the
      // URLs report (METRICS.md §5.4) is viable from these surfaces even
      // though it is not from ChatGPT.
      url: real,
      title: null,
      host,
      domain: host.replace(/^www\./, ''),
      isInlineCited: true,
      occurrences: 1,
      index: byHost.size,
    });
  }
  return [...byHost.values()];
}

/**
 * The AI answer text, with Google's chrome removed.
 *
 * There is no reliable "AI said:" divider the way ChatGPT and Gemini have, so
 * the caller passes the AI container's own innerText where it could find one,
 * falling back to the page body. Chrome removal is what keeps a nav label from
 * being scored as part of an answer.
 */
function answerFromContainerText(containerText) {
  const text = String(containerText || '');
  if (!text.trim()) return null;

  const cleaned = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !CHROME_LINES.has(l.toLowerCase()))
    .filter((l) => !/^\d+$/.test(l))
    .join('\n')
    .trim();

  // Below this it is navigation furniture, not an answer.
  return cleaned.length > 40 ? cleaned : null;
}

// Google labels the block with a literal heading rather than a stable class or
// data-attribute, and the class names rotate. The heading is the durable seam.
const AI_OVERVIEW_MARKER = /^AI Overview$/im;

// Where the overview stops and the rest of the SERP begins.
const SECTION_END = /^(people also ask|people also search for|sponsored|related searches|videos|images|short videos|discussions and forums|more results|complementary results)$/i;

// Google renders a language-switch link and a location chip immediately around
// the heading; neither is answer text.
const NOISE_LINE = /^(ಕನ್ನಡ|choose area|∙ choose area|show more|show less|learn more|ai responses may include mistakes|generative ai is experimental)$/i;

/**
 * The AI Overview text, located by its heading rather than by a selector.
 *
 * Recon showed the overview reliably present in the page body but NOT inside
 * any stable container — the earlier selector-based attempt returned the
 * "Show more" disclosure button instead of the answer. Reading from the
 * heading to the next SERP section is what actually tracks the block.
 *
 * Returns null when there is no overview for this query, which is a real and
 * common outcome and a different claim from a failed capture.
 */
function aiOverviewFromBodyText(bodyText) {
  const lines = String(bodyText || '').split('\n').map((l) => l.trim());
  const start = lines.findIndex((l) => AI_OVERVIEW_MARKER.test(l));
  if (start === -1) return null;

  const out = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line) continue;
    if (SECTION_END.test(line)) break;
    if (NOISE_LINE.test(line) || CHROME_LINES.has(line.toLowerCase())) continue;
    if (/^\d+$/.test(line)) continue;
    out.push(line);
  }

  const text = out.join('\n').trim();
  return text.length > 40 ? text : null;
}

/**
 * Citations from Google's favicon service.
 *
 * This is how the AI surfaces actually carry their sources, and why the
 * link-based extractor above found nothing: an AI Mode answer contains ZERO
 * outbound anchors. Every source is a text chip beside a favicon image, and
 * the favicon's query string is the only place the destination survives.
 *
 * Google uses a different service and parameter from ChatGPT's:
 *   ChatGPT   google.com/s2/favicons?domain=https%3A%2F%2Fwww.ada.org
 *   Google AI encrypted-tbn0.gstatic.com/faviconV2?url=https://foreondental.com
 *
 * Both are handled, so one function serves whichever surface calls it.
 */
function citationsFromFavicons(srcs = []) {
  const byHost = new Map();

  for (const raw of srcs) {
    const src = String(raw || '').replace(/&amp;/g, '&');
    const m = /[?&](?:url|domain)=([^&]+)/.exec(src);
    if (!m) continue;

    let host;
    try {
      const decoded = decodeURIComponent(m[1]);
      host = decoded.replace(/^https?:\/\//i, '').replace(/\/.*$/, '').toLowerCase();
    } catch { continue; }
    if (!host || !host.includes('.')) continue;
    // Google's own chrome favicons are not sources.
    if (/(^|\.)(google|gstatic|googleusercontent)\.com$/.test(host)) continue;

    const existing = byHost.get(host);
    if (existing) { existing.occurrences += 1; continue; }
    byHost.set(host, {
      url: null,
      title: null,
      host,
      domain: host.replace(/^www\./, ''),
      isInlineCited: true,
      occurrences: 1,
      index: byHost.size,
    });
  }

  return [...byHost.values()];
}

/**
 * Merge citations from several carriers into one deduplicated list.
 *
 * A source can appear as both a real link and a favicon chip; the richer row
 * wins (a real `url` beats a null one) rather than the page yielding the same
 * domain twice with different completeness.
 */
function mergeCitations(...lists) {
  const byHost = new Map();
  for (const list of lists) {
    for (const c of list || []) {
      const existing = byHost.get(c.host);
      if (!existing) { byHost.set(c.host, { ...c }); continue; }
      existing.occurrences += c.occurrences || 1;
      if (!existing.url && c.url) existing.url = c.url;
      if (!existing.title && c.title) existing.title = c.title;
      existing.isInlineCited = existing.isInlineCited || c.isInlineCited;
    }
  }
  return [...byHost.values()].map((c, i) => ({ ...c, index: i }));
}

/**
 * The AI Mode answer.
 *
 * AI Mode has no "AI Overview" heading — "AI Mode" appears only as a nav tab
 * label, so anchoring on it would find the navigation. The answer instead
 * follows the echoed query, after a "Search Results" marker. Anchor on the
 * query itself, which the caller knows.
 */
function aiModeFromBodyText(bodyText, prompt) {
  const lines = String(bodyText || '').split('\n').map((l) => l.trim());
  const needle = String(prompt || '').trim().toLowerCase();
  if (!needle) return null;

  // The last echo of the query, so a nav suggestion earlier in the page does
  // not win over the real one above the answer.
  let start = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i].toLowerCase() === needle) { start = i; break; }
  }
  if (start === -1) return null;

  const out = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line) continue;
    if (SECTION_END.test(line)) break;
    if (NOISE_LINE.test(line) || CHROME_LINES.has(line.toLowerCase())) continue;
    if (/^\d+$/.test(line)) continue;
    out.push(line);
  }

  const text = out.join('\n').trim();
  return text.length > 40 ? text : null;
}

/**
 * Was an AI block present on the page at all?
 *
 * The distinction this exists to protect: "Google showed no AI answer for this
 * query" is a measured absence, but "an AI answer was there and we failed to
 * read it" is a parsing failure. Collapsing the second into the first records
 * `mentioned: false` — a claim that the brand was absent from an answer nobody
 * actually read. The caller raises a failure for the second case.
 */
function hasAiBlock(bodyText) {
  const text = String(bodyText || '');
  return AI_OVERVIEW_MARKER.test(text) || /\bAI Mode\b/.test(text);
}

module.exports = {
  blockReason,
  unwrapGoogleUrl,
  citationsFromLinks,
  citationsFromFavicons,
  mergeCitations,
  answerFromContainerText,
  aiOverviewFromBodyText,
  aiModeFromBodyText,
  hasAiBlock,
  CHROME_LINES,
  AI_OVERVIEW_MARKER,
};
