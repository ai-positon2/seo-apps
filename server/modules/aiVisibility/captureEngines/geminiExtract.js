// ── Reading an answer out of the logged-out gemini.google.com DOM ───────────
//
// Pure functions, same contract as chatgptExtract.js. Derived from live recon
// runs against the guest (signed-out) experience.
//
// Gemini differs from ChatGPT in two ways that matter:
//
//   1. Sources are PUBLISHER NAMES, not favicon domains. A chip reads
//      "American Dental Association + 1" — a human-readable name with a count
//      of collapsed extras. There is no ?domain= parameter to decode, so a
//      capture yields attributions we can name but not always resolve to a
//      host. Recorded honestly: `domain` stays null unless a real link is
//      found, rather than guessing a domain from a brand name.
//
//   2. Guest sessions are served a reduced model — observed as "Flash-Lite",
//      below even the 2.0 Flash the public docs describe for signed-out use.
//      That is captured per answer, because a metric compared across engines
//      has to be honest about which model produced it.

const ANSWER_DIVIDER = /Gemini said/i;

// Gemini echoes the question as "You said <prompt>" — no colon, unlike
// ChatGPT's "You said:". Matching both keeps one shape of bug from being
// engine-specific.
const PROMPT_DIVIDER = /You said:?/i;

const CHROME_LINES = new Set([
  'about gemini', 'get gemini app', 'subscriptions', 'for business', 'sign in',
  'conversation with gemini', 'gemini', 'report legal issue', 'view sources',
  'see response details', 'gemini is ai and can make mistakes.', 'searching the web',
  'ask gemini', 'show more', 'show less',
]);

/** The reply, or null when there isn't one. Null, never '' — see chatgptExtract. */
function answerFromMainText(mainText) {
  const text = String(mainText || '');
  if (!text.trim()) return null;

  const parts = text.split(ANSWER_DIVIDER);
  if (parts.length < 2) return null;

  const cleaned = parts[parts.length - 1]
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !CHROME_LINES.has(l.toLowerCase()))
    .filter((l) => !/^(flash|pro|flash-lite|gemini \d)/i.test(l))
    .join('\n')
    .trim();

  return cleaned || null;
}

/**
 * The question, as the page echoed it back.
 *
 * Proof that the prompt was actually submitted. A swallowed keystroke leaves a
 * page that looks calm and finished, which is precisely what the surfaces used
 * to mistake for a completed answer; the presence of the echo is what tells
 * the two apart before any time is spent waiting for a reply.
 *
 * Returns null on a page that only shows landing chrome.
 */
function echoedPromptFromMainText(mainText) {
  const text = String(mainText || '');
  const afterYou = text.split(PROMPT_DIVIDER)[1];
  if (!afterYou) return null;
  const beforeAnswer = afterYou.split(ANSWER_DIVIDER)[0] || '';
  const line = beforeAnswer
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l && !CHROME_LINES.has(l.toLowerCase()));
  return line || null;
}

/**
 * Which model answered.
 *
 * Guest sessions get a reduced tier and the UI names it in a corner chip. The
 * surfaceLabel says "guest"; this says exactly which model, so a cross-engine
 * comparison can be qualified rather than quietly conflating tiers.
 */
function modelFromText(mainText) {
  const m = /\b(Flash-Lite|Flash Lite|2\.5 Flash|2\.0 Flash|1\.5 Flash|Flash|Pro)\b/.exec(String(mainText || ''));
  return m ? m[1] : null;
}

/** Did Gemini browse for this answer? The UI says so explicitly. */
function didSearchWeb(mainText) {
  return /searching the web|sources|from the web/i.test(String(mainText || ''));
}

const NAME_WITH_EXTRAS = /^(.+?)\s*\+\s*(\d+)$/;

/**
 * Attribution chips.
 *
 * `chipTexts` are the rendered strings ("American Dental Association + 1");
 * `anchors` are any real outbound links found after opening "View sources".
 * Where an anchor's host can be matched to a chip we keep both; where it
 * cannot, `domain` stays null — an unresolved attribution, which
 * capture.js's three-valued `cited` already models correctly (an unresolved
 * citation makes "not cited" unknown rather than false).
 */
function citationsFromChips(chipTexts = [], anchors = []) {
  const hosts = [];
  for (const a of anchors) {
    try {
      const host = new URL(a).hostname.toLowerCase();
      if (!/google\.|gstatic|youtube\.com\/about/.test(host)) hosts.push(host);
    } catch { /* not a URL */ }
  }

  const out = [];
  const seen = new Set();

  for (const raw of chipTexts) {
    const text = String(raw || '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const m = NAME_WITH_EXTRAS.exec(text);
    const name = (m ? m[1] : text).trim();
    const extras = m ? Number(m[2]) : 0;
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());

    // A chip that IS a bare host ("www.heart.org") resolves itself.
    const looksLikeHost = /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(name);
    const matched = looksLikeHost
      ? name.toLowerCase()
      : hosts.find((h) => h.replace(/^www\./, '').split('.')[0].toLowerCase()
        === name.toLowerCase().replace(/[^a-z0-9]/gi, '').slice(0, 20)) || null;

    out.push({
      url: null,
      title: looksLikeHost ? null : name,
      host: matched,
      domain: matched ? matched.replace(/^www\./, '') : null,
      isInlineCited: true,
      // "+ 1" means one more source was collapsed behind this chip.
      occurrences: 1 + extras,
      index: out.length,
    });
  }

  // Anchors that no chip claimed are still real retrieved sources.
  for (const host of hosts) {
    if (out.some((c) => c.host === host)) continue;
    out.push({
      url: null,
      title: null,
      host,
      domain: host.replace(/^www\./, ''),
      isInlineCited: false,
      occurrences: 1,
      index: out.length,
    });
  }

  return out;
}

function blockReason({ mainText = '', title = '', url = '' } = {}) {
  const haystack = `${title}\n${mainText}`;
  if (/unusual traffic|not a robot|recaptcha|verify you are human/i.test(haystack)) return 'google_captcha';
  if (/sign in to continue|sign in to use gemini/i.test(haystack)) return 'signin_required';
  if (/\/sorry\/index/.test(url)) return 'google_captcha';
  return null;
}

module.exports = {
  answerFromMainText, echoedPromptFromMainText, modelFromText, didSearchWeb,
  citationsFromChips, blockReason, CHROME_LINES,
};
