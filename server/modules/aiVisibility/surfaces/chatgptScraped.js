// ── ChatGPT, scraped by us rather than by a vendor ──────────────────────────
//
// Same measurement question as surfaces/dataForSeoChatGpt.js — what a consumer
// sees on chatgpt.com — but driven from our own browser, so the raw answer and
// its provenance stay in this system. Both surfaces are registered; which one
// runs is a per-run choice (`chatgpt:scraped` vs `chatgpt:dataforseo`).
//
// LOGGED OUT, by decision. Three consequences, all measured in Phase 0 rather
// than assumed:
//
//   • Web search is available and can be forced through the composer control,
//     so answers do browse and do cite. But it is a UI affordance, not an API
//     parameter — if OpenAI moves it, this breaks loudly (a capture with no
//     citations), which is why `web_search` is recorded per capture rather
//     than presumed.
//   • Citations expose the source DOMAIN only. Full URLs sit behind the
//     "Sources" sheet and are not read yet, so `url` is null and the URLs
//     report (METRICS.md §5.4) is deferred. Domain is enough for §5.2/§6.
//   • A LOCAL query returns a map of business cards instead of prose. Those
//     cards ARE the answer, and are captured as such — reading only prose
//     would report every local client as absent from answers they appear in.

const browserLib = require('../captureEngines/browser');
const extract = require('../captureEngines/chatgptExtract');
const settle = require('../captureEngines/settle');

const ENGINE = 'chatgpt';
const PROVIDER = 'scraped';

// What the report may call this. Names the access path, because a logged-out
// session is a weaker claim than a signed-in one and the label has to survive
// a client asking how the number was obtained (PRD §6.2, §30).
const LABEL = 'ChatGPT (consumer UI · logged out · self-hosted)';

// How the answer was obtained, as opposed to who served it. Travels onto
// every stored capture so a reader can tell our own browser from a vendor
// API without inferring it from the provider name.
const ACCESS = 'scraped';

const NAV_TIMEOUT_MS = 45_000;
const SETTLE_POLL_MS = 2_000;
const SETTLE_STABLE_TICKS = 5;      // ~10s of no growth before calling it done
const MAX_ANSWER_WAIT_MS = 150_000;

// How long to wait for the page to echo the question back before deciding it
// was never submitted. Short on purpose: a question that HAS been asked shows
// up within a second or two, so a longer wait only delays the resend.
const ECHO_WAIT_MS = 12_000;

const COMPOSER_SELECTOR = '#prompt-textarea, div[contenteditable="true"], textarea';

const clickByLabel = (page, wanted) => page.evaluate((w) => {
  const el = [...document.querySelectorAll('button,[role="button"],[role="menuitem"],[role="menuitemradio"],[tabindex]')]
    .map((b) => ({ b, t: (b.getAttribute('aria-label') || b.textContent || '').replace(/\s+/g, ' ').trim() }))
    .filter((c) => c.t.toLowerCase() === w || (w.endsWith('*') && c.t.toLowerCase().startsWith(w.slice(0, -1))))
    .sort((a, c) => a.t.length - c.t.length)[0];
  if (!el) return false;
  el.b.click();
  return true;
}, wanted.toLowerCase());

/** The question as the page echoed it, or null if it was never submitted. */
const readEcho = (page) => settle.readEchoFrom(
  page, extract.echoedPromptFromMainText, { fromMain: true },
);

/**
 * Ask ChatGPT one prompt and read the answer back.
 *
 * Throws on a block or a broken page — capture.js turns that into a FAILED row
 * with the reason, which is a different claim from "the brand was absent".
 *
 * @param {string} prompt
 * @param {object} [opts]
 * @param {string} [opts.proxyUrl]
 * @param {object} [opts.proxyAuth]  { username, password }
 * @returns {Promise<object>} the surface contract — see ./index.js
 */
async function capture(prompt, { proxyUrl = null, proxyAuth = null } = {}) {
  const text = String(prompt || '').trim();
  if (!text) throw new Error('An empty prompt cannot be measured.');

  const browser = await browserLib.getBrowser();
  // Isolated: chatgpt.com cookies and service workers otherwise persist for the
  // whole worker-process lifetime, and a stale session serves a
  // returning-visitor variant whose modals swallow the Enter key.
  const page = await browserLib.newPage(browser, { proxyAuth, proxyUrl, isolated: true });

  try {
    // The prompt travels in the URL and lands pre-filled in the composer —
    // more reliable than typing into a contenteditable that React re-renders.
    await page.goto(`https://chatgpt.com/?prompt=${encodeURIComponent(text)}`, {
      waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS,
    });
    await page.waitForNetworkIdle({ idleTime: 1200, timeout: 15_000 }).catch(() => {});

    const preflight = await page.evaluate(() => ({
      mainText: document.body ? document.body.innerText.slice(0, 4000) : '',
      title: document.title,
      url: location.href,
      hasComposer: Boolean(document.querySelector('#prompt-textarea, div[contenteditable="true"], textarea')),
    }));

    const blocked = extract.blockReason(preflight);
    if (blocked) throw Object.assign(new Error(`chatgpt.com returned a bot wall (${blocked})`), { code: blocked });
    if (!preflight.hasComposer) throw new Error('No composer on the page — the logged-out layout may have changed.');

    // Force browsing. Left to itself the same prompt browses one day and
    // answers from weights the next, and a trend would be measuring that
    // coin-flip rather than the client (the reasoning behind DataForSEO's
    // force_web_search, reproduced here through the UI).
    await clickByLabel(page, 'add files and more');
    await new Promise((r) => setTimeout(r, 900));
    const webSearchOn = await clickByLabel(page, 'web search');
    await new Promise((r) => setTimeout(r, 900));

    // Dismiss the two overlays that can swallow the Enter key.
    await page.evaluate(() => {
      document.querySelectorAll('iframe[src*="accounts.google.com"]').forEach((f) => f.remove());
      [...document.querySelectorAll('button,a')]
        .filter((b) => /stay logged out|not now|dismiss/i.test(b.textContent || ''))
        .forEach((b) => b.click());
    });

    await settle.focusComposer(page, COMPOSER_SELECTOR);
    await page.keyboard.press('Enter');

    // Did the question actually go in?
    //
    // Waiting for an answer to a question that was never asked burns the whole
    // 150s timeout and then reports an empty answer. The echo is the cheap
    // proof, so it is checked before any of that time is spent.
    let submitted = await settle.waitForEcho({
      readEcho: () => readEcho(page),
      timeoutMs: ECHO_WAIT_MS,
    });
    let resent = false;

    if (!submitted) {
      // Second attempt by a different route: dismiss whatever appeared, then
      // click Send rather than pressing a key, since a swallowed keystroke is
      // the mechanism being worked around.
      resent = true;
      await page.evaluate(() => {
        document.querySelectorAll('iframe[src*="accounts.google.com"]').forEach((f) => f.remove());
        [...document.querySelectorAll('button,a')]
          .filter((b) => /stay logged out|not now|dismiss|continue|got it|accept|close/i.test(b.textContent || ''))
          .forEach((b) => b.click());
      }).catch(() => {});
      await settle.focusComposer(page, COMPOSER_SELECTOR);
      const clicked = await clickByLabel(page, 'send prompt') || await clickByLabel(page, 'send*');
      if (!clicked) await page.keyboard.press('Enter');
      submitted = await settle.waitForEcho({
        readEcho: () => readEcho(page),
        timeoutMs: ECHO_WAIT_MS,
      });
    }

    if (!submitted) {
      // Fail fast and name it. Sitting out the full answer timeout would cost
      // 150s to learn something already known.
      throw Object.assign(
        new Error('the question was never submitted — the composer did not accept it'),
        { code: 'prompt_not_submitted' },
      );
    }

    // No SSE 'done' event exists, so settle on the ANSWER's own length — never
    // the page's. A still page with no answer is not a finished answer.
    const settled = await settle.settleOnAnswer({
      page,
      readAnswer: () => page
        .evaluate(() => (document.querySelector('main') || document.body).innerText)
        .then((t) => extract.answerFromMainText(t)),
      maxWaitMs: MAX_ANSWER_WAIT_MS,
      pollMs: SETTLE_POLL_MS,
      stableTicks: SETTLE_STABLE_TICKS,
    });
    const timedOut = settled.timedOut;

    // Scroll the whole answer before harvesting.
    //
    // Citation favicons are lazy-loaded <img> tags, so anything below the fold
    // has no src until it is scrolled into view. Reading straight after the
    // text settles found 1 of the 3 sources a manual check showed — a silent
    // undercount that would have understated every domain and gap metric.
    await page.evaluate(async () => {
      const step = Math.floor(window.innerHeight * 0.8);
      for (let y = 0; y < document.body.scrollHeight; y += step) {
        window.scrollTo(0, y);
        await new Promise((r) => setTimeout(r, 250));
      }
      window.scrollTo(0, document.body.scrollHeight);
    }).catch(() => {});
    await new Promise((r) => setTimeout(r, 1500));

    const dom = await page.evaluate(() => ({
      mainText: (document.querySelector('main') || document.body).innerText,
      title: document.title,
      url: location.href,
      faviconSrcs: [...document.querySelectorAll('img[src*="s2/favicons"]')].map((i) => i.getAttribute('src')),
    }));

    // A wall can appear mid-generation, not just on load.
    const lateBlock = extract.blockReason(dom);
    if (lateBlock) throw Object.assign(new Error(`chatgpt.com blocked mid-answer (${lateBlock})`), { code: lateBlock });

    const answerText = extract.answerFromMainText(dom.mainText);
    const mapCards = extract.mapCardsFromText(answerText);
    const citations = extract.citationsFromFaviconSrcs(dom.faviconSrcs);

    if (!answerText && timedOut) throw new Error('No answer within 150s — treated as not measured, not as an absence.');

    // Map cards are the answer for a local query. Flattened into answerText so
    // the existing brand matcher in capture.js sees the business names it must
    // scan; the structured cards travel alongside for ordinal/rating use.
    const answerForMatching = mapCards.length
      ? [answerText, ...mapCards.map((c) => c.name)].filter(Boolean).join('\n')
      : answerText;

    return {
      engine: ENGINE,
      provider: PROVIDER,
      surfaceLabel: LABEL,
      access: 'scraped',
      answerText: answerForMatching,
      citations,
      // Not exposed logged-out; [] rather than a guess.
      webQueries: [],
      providerBrands: [],
      modelVersion: null,
      // Self-hosted: no per-capture vendor charge. Null, not 0 — the run's real
      // cost is proxy and compute, which this surface cannot attribute.
      taskCost: null,
      capturedAt: new Date().toISOString(),
      raw: {
        mainText: dom.mainText,
        mapCards,
        features: extract.answerFeatures({ answerText, mapCards, citations }),
        webSearchToggled: webSearchOn,
        echoedPrompt: extract.echoedPromptFromMainText(dom.mainText),
        settleTimedOut: timedOut,
        // The three facts that would have diagnosed this incident in minutes
        // instead of three wrong guesses: was the question submitted, did it
        // take a resend, and did an answer ever appear at all.
        submitted,
        resentToSubmit: resent,
        sawAnswer: settled.sawAnswer,
        settleWaitedMs: settled.waitedMs,
        url: dom.url,
      },
    };
  } finally {
    await page.close().catch(() => {});
  }
}

// A conversation ALWAYS produces a reply. An empty answer from a chat
// engine is a failure to READ it — a throttle, a layout change — never the
// engine saying nothing. Measured: six consecutive empty Gemini captures
// under rate limiting, which would otherwise have been stored as six
// absences. A SERP surface is different and does not set this: plenty of
// queries genuinely have no AI Overview.
const ALWAYS_ANSWERS = true;

module.exports = {
  capture, ENGINE, PROVIDER, LABEL, ACCESS, ALWAYS_ANSWERS,
};
