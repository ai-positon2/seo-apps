// ── Waiting for a chat answer ───────────────────────────────────────────────
//
// Neither ChatGPT nor Gemini emits a "generation finished" event a scraper can
// read, so the only signal is the answer text going quiet. Both surfaces used
// to do that inline, identically, and both were wrong in the same way:
//
//     const len = await page.evaluate(() => document.body.innerText.length);
//     if (len === last) stable += 1; else { stable = 0; last = len; }
//
// That watches the WHOLE PAGE. A page that never received the question is
// perfectly still, so after five quiet polls it satisfied the condition and
// reported success — and the surface then harvested an empty answer and
// recorded it as a failed capture blamed on rate limiting. A page that was
// never asked anything was indistinguishable from a finished answer.
//
// Two rules fix it, and they live here so the next engine adapter inherits
// them instead of copying the broken loop a third time:
//
//   1. Stabilise on the ANSWER's length, not the page's.
//   2. Stillness only counts once there IS an answer. No answer means keep
//      waiting until the real deadline, then say so.
//
// A capture that genuinely got nothing now reports `timedOut: true`, which is
// what the surfaces' `if (!answerText && timedOut)` guard has always needed in
// order to fire.

const DEFAULT_POLL_MS = 2_000;
const DEFAULT_STABLE_TICKS = 5;

/**
 * Wait for an answer to appear and stop growing.
 *
 * @param {object} input
 * @param {object} input.page                puppeteer page
 * @param {Function} input.readAnswer        async () => string|null, the
 *                                           surface's own extractor. Reading
 *                                           through the extractor means the
 *                                           thing being waited on is exactly
 *                                           the thing that will be harvested.
 * @param {number} input.maxWaitMs
 * @param {number} [input.pollMs]
 * @param {number} [input.stableTicks]
 * @returns {Promise<{answerText: string|null, timedOut: boolean, waitedMs: number,
 *                    sawAnswer: boolean, ticks: number}>}
 */
async function settleOnAnswer({
  page,
  readAnswer,
  maxWaitMs,
  pollMs = DEFAULT_POLL_MS,
  stableTicks = DEFAULT_STABLE_TICKS,
}) {
  const started = Date.now();
  const deadline = started + maxWaitMs;

  let last = -1;
  let stable = 0;
  let answerText = null;
  let sawAnswer = false;

  while (Date.now() < deadline && stable < stableTicks) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => { setTimeout(r, pollMs); });

    // eslint-disable-next-line no-await-in-loop
    const current = await readAnswer().catch(() => null);
    const len = typeof current === 'string' ? current.length : 0;

    if (len > 0) {
      answerText = current;
      sawAnswer = true;
      if (len === last) stable += 1;
      else { stable = 0; last = len; }
    } else {
      // Deliberately NOT counted as stable. An unchanging nothing is the exact
      // state this function exists to stop reporting as a finished answer.
      stable = 0;
      last = -1;
    }
  }

  return {
    answerText,
    timedOut: stable < stableTicks,
    waitedMs: Date.now() - started,
    sawAnswer,
    ticks: stable,
  };
}

/**
 * Wait for the engine to echo the question back into the conversation.
 *
 * Proof that the question was actually submitted. Without it, a swallowed
 * keystroke looks exactly like a slow answer, and the capture spends the whole
 * answer timeout waiting for a reply to a question nobody was asked.
 *
 * @param {object} input
 * @param {Function} input.readEcho   async () => string|null
 * @param {number} input.timeoutMs
 * @param {number} [input.pollMs]
 * @returns {Promise<boolean>} whether the prompt was seen on the page
 */
async function waitForEcho({ readEcho, timeoutMs, pollMs = 1_000 }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    const echo = await readEcho().catch(() => null);
    if (typeof echo === 'string' && echo.trim()) return true;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => { setTimeout(r, pollMs); });
  }
  return false;
}

/**
 * Put the caret in the composer, immediately before the keypress that submits.
 *
 * The reason this exists at all: on ChatGPT the two clicks that force web
 * search leave DOM focus on the web-search BUTTON, so Enter re-activates that
 * instead of submitting and the question is never asked. Gemini has the same
 * shape for a different reason — it focuses the editor when typing, then waits
 * 800ms, and a re-render in that window drops focus.
 *
 * Lived in both surfaces as a near-copy and had already drifted (one had lost
 * its comment, the other renamed a variable). It is the same page trick and
 * belongs beside the other shared page helpers.
 *
 * @returns {Promise<boolean>} whether focus actually landed in the composer
 */
function focusComposer(page, selector) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    el.focus();
    // A contenteditable needs the caret INSIDE it, not merely focus on the node.
    if (el.isContentEditable) {
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    }
    return document.activeElement === el || el.contains(document.activeElement);
  }, selector).catch(() => false);
}

/**
 * Read the page and pull the echoed question out of it.
 *
 * Both chat surfaces had this as a two-line near-copy differing only in which
 * element they read from, which is exactly the shape that drifts.
 *
 * @param {object} page
 * @param {Function} extractEcho  (mainText) => string|null, the surface's own
 * @param {boolean} [fromMain]    read <main> where the surface has one
 */
function readEchoFrom(page, extractEcho, { fromMain = false } = {}) {
  return page
    .evaluate((useMain) => (useMain
      ? (document.querySelector('main') || document.body).innerText
      : document.body.innerText), fromMain)
    .then((t) => extractEcho(t))
    .catch(() => null);
}

module.exports = {
  DEFAULT_POLL_MS,
  DEFAULT_STABLE_TICKS,
  settleOnAnswer,
  waitForEcho,
  focusComposer,
  readEchoFrom,
};
