// ── Gemini, as a signed-out consumer sees it ────────────────────────────────
//
// Guest access at gemini.google.com works without an account, but on a REDUCED
// MODEL — recon observed "Flash-Lite". That is a weaker claim than "we measured
// Gemini", so the label says guest and the exact model travels on every row.
// A client asking "which Gemini?" gets a straight answer.

const browserLib = require('../captureEngines/browser');
const extract = require('../captureEngines/geminiExtract');
const settle = require('../captureEngines/settle');

const ENGINE = 'gemini';
const PROVIDER = 'scraped';
const LABEL = 'Gemini (consumer UI · guest session · self-hosted)';

// How the answer was obtained, as opposed to who served it. Travels onto
// every stored capture so a reader can tell our own browser from a vendor
// API without inferring it from the provider name.
const ACCESS = 'scraped';

const NAV_TIMEOUT_MS = 45_000;
const SETTLE_POLL_MS = 2_500;
const SETTLE_STABLE_TICKS = 5;
const MAX_ANSWER_WAIT_MS = 120_000;

// Long enough for a submitted question to echo, short enough that a swallowed
// one is retried rather than waited out.
const ECHO_WAIT_MS = 12_000;

const COMPOSER_SELECTOR = 'rich-textarea .ql-editor, div[contenteditable="true"], textarea';

/** The question as the page echoed it, or null if it was never submitted. */
const readEcho = (page) => settle.readEchoFrom(page, extract.echoedPromptFromMainText);

async function capture(prompt, { proxyUrl = null, proxyAuth = null } = {}) {
  const text = String(prompt || '').trim();
  if (!text) throw new Error('An empty prompt cannot be measured.');

  const browser = await browserLib.getBrowser();
  // Isolated: Google consent and session cookies otherwise carry between
  // captures and across runs, and a stale session serves a variant whose
  // dialogs swallow the Enter key.
  const page = await browserLib.newPage(browser, { proxyAuth, proxyUrl, isolated: true });

  try {
    await page.goto('https://gemini.google.com/app', { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
    await new Promise((r) => setTimeout(r, 4500));

    const pre = await page.evaluate(() => ({
      mainText: document.body ? document.body.innerText.slice(0, 3000) : '',
      title: document.title,
      url: location.href,
    }));
    const blocked = extract.blockReason(pre);
    if (blocked) throw Object.assign(new Error(`gemini.google.com refused the session (${blocked})`), { code: blocked });

    // Gemini's composer is a Quill editor, not a textarea — setting .value on
    // it does nothing, so write innerText and fire an input event.
    const typed = await page.evaluate((p) => {
      const el = document.querySelector('rich-textarea .ql-editor, div[contenteditable="true"], textarea');
      if (!el) return false;
      el.focus();
      if ('value' in el) el.value = p; else el.innerText = p;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    }, text);
    if (!typed) throw new Error('No composer on the page — the guest layout may have changed.');

    await new Promise((r) => setTimeout(r, 800));
    await settle.focusComposer(page, COMPOSER_SELECTOR);
    await page.keyboard.press('Enter');

    // Proof the question went in. Gemini echoes it as "You said <prompt>";
    // without that, waiting for an answer is waiting for a reply to a question
    // nobody was asked.
    let submitted = await settle.waitForEcho({
      readEcho: () => readEcho(page),
      timeoutMs: ECHO_WAIT_MS,
    });
    let resent = false;

    if (!submitted) {
      resent = true;
      await settle.focusComposer(page, COMPOSER_SELECTOR);
      await page.keyboard.press('Enter');
      submitted = await settle.waitForEcho({
        readEcho: () => readEcho(page),
        timeoutMs: ECHO_WAIT_MS,
      });
    }

    if (!submitted) {
      throw Object.assign(
        new Error('the question was never submitted — the composer did not accept it'),
        { code: 'prompt_not_submitted' },
      );
    }

    // Settle on the ANSWER, never the page. A still page with no answer is not
    // a finished answer — that conflation is what recorded real Gemini
    // captures as empty while the reply was still rendering.
    const settled = await settle.settleOnAnswer({
      page,
      readAnswer: () => page
        .evaluate(() => document.body.innerText)
        .then((t) => extract.answerFromMainText(t)),
      maxWaitMs: MAX_ANSWER_WAIT_MS,
      pollMs: SETTLE_POLL_MS,
      stableTicks: SETTLE_STABLE_TICKS,
    });
    const timedOut = settled.timedOut;

    // Sources sit behind an affordance; opening it is the only way to get real
    // outbound links rather than publisher names alone.
    await page.evaluate(() => {
      [...document.querySelectorAll('button,[role="button"]')]
        .filter((b) => /view sources|sources|show more/i.test(b.innerText || b.getAttribute('aria-label') || ''))
        .slice(0, 3)
        .forEach((b) => b.click());
    }).catch(() => {});
    await new Promise((r) => setTimeout(r, 2500));

    const dom = await page.evaluate(() => {
      const unwrap = (h) => {
        try {
          const u = new URL(h);
          if (/google\./.test(u.hostname)) return u.searchParams.get('q') || u.searchParams.get('url') || h;
          return h;
        } catch { return h; }
      };
      return {
        mainText: document.body.innerText,
        title: document.title,
        url: location.href,
        // Attribution chips render as "<Publisher> + N".
        chipTexts: [...document.querySelectorAll('button,[role="button"],div')]
          .map((e) => (e.innerText || '').replace(/\s+/g, ' ').trim())
          .filter((t) => t && t.length < 70 && /\+\s*\d+$/.test(t)),
        anchors: [...document.querySelectorAll('a[href^="http"]')]
          .map((a) => unwrap(a.href))
          .filter((h) => h && !/gemini\.google|google\.com\/intl|g\.co\/|policies\.google|support\.google|accounts\.google/.test(h)),
      };
    });

    const lateBlock = extract.blockReason(dom);
    if (lateBlock) throw Object.assign(new Error(`gemini blocked mid-answer (${lateBlock})`), { code: lateBlock });

    const answerText = extract.answerFromMainText(dom.mainText);
    if (!answerText && timedOut) throw new Error('No answer within 120s — treated as not measured, not as an absence.');

    const citations = extract.citationsFromChips(dom.chipTexts, dom.anchors);
    const searched = extract.didSearchWeb(dom.mainText);

    return {
      engine: ENGINE,
      provider: PROVIDER,
      surfaceLabel: LABEL,
      access: 'scraped',
      answerText,
      citations,
      webQueries: [],
      providerBrands: [],
      modelVersion: extract.modelFromText(dom.mainText),
      taskCost: null,
      capturedAt: new Date().toISOString(),
      raw: {
        mainText: dom.mainText,
        chipTexts: dom.chipTexts,
        features: [searched ? 'web_search' : null, answerText ? 'prose' : null].filter(Boolean),
        settleTimedOut: timedOut,
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
