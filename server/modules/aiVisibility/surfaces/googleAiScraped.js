// ── Google AI Overview and AI Mode, self-hosted ─────────────────────────────
//
// One file, two surfaces: they share a host, a bot wall, and a link-wrapping
// scheme, and differ only in the URL and the container to read. Exported as
// `google_ai_overview:scraped` and `google_ai_mode:scraped`.
//
// ── What actually causes Google to refuse us ───────────────────────────────
// The first refusals here were NOT fingerprinting. Testing six strategies in
// isolation showed a single cause: forcing `gl=us` from a non-US IP. Same
// browser, same session, dropping that one parameter turned a hard block into
// a served AI Overview.
//
//   forced gl=us          → BLOCKED (/sorry/index)
//   no locale forcing     → AI Overview served
//   + homepage warm-up    → AI Overview served
//
// So locale must come from WHERE THE REQUEST EXITS, never from a URL parameter
// contradicting it. To measure US markets, exit through a US residential proxy
// and let Google infer the locale — which is also the only way the answer is
// really a US answer rather than a localised one wearing a US label.
//
// AI Mode (`udm=50`) stays refused even without the parameter — it is defended
// harder than plain search — so it remains proxy-gated.
//
// A refusal is raised with a `code` so capture.js records `failed` with a
// reason, never a brand that was absent.
//
// Unlike ChatGPT, Google exposes FULL destination URLs, so these surfaces can
// feed METRICS.md §5.4 (the URLs report) that ChatGPT cannot.

const browserLib = require('../captureEngines/browser');
const extract = require('../captureEngines/googleExtract');

const NAV_TIMEOUT_MS = 45_000;
const SETTLE_MS = 6_000;

// AI Overview generates after paint; AI Mode streams. Both get a settle pass.
const AI_CONTAINER_SELECTORS = [
  '[data-attrid*="AIOverview" i]',
  'div[aria-label*="AI Overview" i]',
  'div[aria-label*="AI Mode" i]',
  '#m-x-content',
  '[data-async-type*="ai" i]',
];

async function run({
  engine, label, buildUrl, prompt, proxyUrl, proxyAuth, warmUp = false,
}) {
  const text = String(prompt || '').trim();
  if (!text) throw new Error('An empty prompt cannot be measured.');

  const browser = await browserLib.getBrowser();
  // An isolated context per capture: Google's consent and session cookies
  // otherwise carry between prompts, so one poisoned session would condemn
  // every capture after it in the run. This surface had that from the start
  // and hand-rolled it; newPage now owns it, and owns applying the proxy to
  // the same context — which is the part that was silently missing.
  const page = await browserLib.newPage(browser, { proxyAuth, proxyUrl, isolated: true });

  try {
    // NO homepage warm-up by default, and this is counter-intuitive enough to
    // be worth stating: warming up made things WORSE. Measured directly —
    //
    //   search only                    → AI Overview served
    //   homepage, then search (5s)     → second request refused
    //
    // Google's tolerance here is per-request-rate, not per-session-shape, so a
    // warm-up simply spends the allowance before the request that matters.
    // Left behind a flag because through a rotating proxy — where each capture
    // exits from a different address — the trade may invert.
    if (warmUp) {
      await page.goto('https://www.google.com/', { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
      await new Promise((r) => setTimeout(r, 1800));
      await page.evaluate(() => {
        const b = [...document.querySelectorAll('button,div[role="button"]')]
          .find((x) => /accept all|i agree|agree to the use/i.test(x.innerText || ''));
        if (b) b.click();
      }).catch(() => {});
      await new Promise((r) => setTimeout(r, 1200));
    }

    await page.goto(buildUrl(text), { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
    await new Promise((r) => setTimeout(r, 3000));

    let state = await page.evaluate(() => ({
      mainText: document.body ? document.body.innerText.slice(0, 4000) : '',
      title: document.title,
      url: location.href,
    }));

    const blocked = extract.blockReason(state);
    if (blocked) {
      throw Object.assign(
        new Error(`google refused the request (${blocked}) — this surface needs rotating residential proxies`),
        { code: blocked },
      );
    }

    // The AI block is generated asynchronously; give it time, expand it, and
    // scroll so anything lazy-loaded (including source links) actually renders.
    await new Promise((r) => setTimeout(r, SETTLE_MS));
    await page.evaluate(async () => {
      // The overview ships collapsed, and the hidden half is exactly where the
      // later citations live.
      [...document.querySelectorAll('div[role="button"],button')]
        .filter((b) => /show more|more about|expand/i.test(b.innerText || ''))
        .slice(0, 5).forEach((b) => b.click());
      await new Promise((r) => setTimeout(r, 1200));
      const step = Math.floor(window.innerHeight * 0.8);
      for (let y = 0; y < document.body.scrollHeight; y += step) {
        window.scrollTo(0, y);
        await new Promise((r) => setTimeout(r, 250));
      }
      window.scrollTo(0, 0);
    }).catch(() => {});
    await new Promise((r) => setTimeout(r, 1500));

    const dom = await page.evaluate((sels) => {
      const container = sels.map((s) => document.querySelector(s)).find(Boolean);
      const scope = container || document.querySelector('#search') || document.body;
      return {
        matchedSelector: sels.find((s) => document.querySelector(s)) || null,
        containerText: scope ? scope.innerText : '',
        mainText: document.body.innerText,
        title: document.title,
        url: location.href,
        // Scope first, then the whole page: the overview's own source links
        // are rendered outside the block that holds its text.
        hrefs: [...new Set([
          ...[...scope.querySelectorAll('a[href]')].map((a) => a.getAttribute('href') || a.href),
          ...[...document.querySelectorAll('#search a[href], #rso a[href]')].map((a) => a.getAttribute('href') || a.href),
        ])],
        // The real carrier. An AI Mode answer contains ZERO outbound anchors —
        // every source is a text chip beside a favicon, and the favicon's
        // query string is the only place the destination survives.
        faviconSrcs: [...document.querySelectorAll('img[src*="favicon" i]')]
          .map((i) => i.getAttribute('src') || '')
          .filter(Boolean),
      };
    }, AI_CONTAINER_SELECTORS);

    const lateBlock = extract.blockReason(dom);
    if (lateBlock) throw Object.assign(new Error(`google blocked mid-read (${lateBlock})`), { code: lateBlock });

    // Prefer the anchored reads: recon showed the answer is reliably in the
    // body but NOT inside any stable container, and the selector-based attempt
    // returned the "Show more" button rather than the answer. AI Overview
    // anchors on its heading; AI Mode has none, so it anchors on the echoed
    // query.
    const answerText = (engine === 'google_ai_mode'
      ? extract.aiModeFromBodyText(dom.mainText, text)
      : extract.aiOverviewFromBodyText(dom.mainText))
      || extract.answerFromContainerText(dom.containerText);

    // An AI block that is present but unreadable is a PARSING failure, not an
    // absent brand. Letting it through as an empty answer would store
    // `mentioned: false` — asserting the client was missing from an answer
    // nobody actually read.
    if (!answerText && extract.hasAiBlock(dom.mainText)) {
      throw new Error('An AI block was on the page but could not be parsed — recorded as not measured, not as an absence.');
    }

    // Both carriers, merged: links give a full URL where they exist, favicons
    // catch the sources that are chips rather than anchors. The merge keeps
    // the richer row so one domain never appears twice at different levels of
    // completeness.
    const citations = extract.mergeCitations(
      extract.citationsFromLinks(dom.hrefs),
      extract.citationsFromFavicons(dom.faviconSrcs),
    );

    return {
      engine,
      provider: 'scraped',
      surfaceLabel: label,
      access: 'scraped',
      // Null when Google showed no AI block for this query — a real and common
      // outcome, and a different claim from a failed capture.
      answerText,
      citations,
      webQueries: [],
      providerBrands: [],
      modelVersion: null,
      taskCost: null,
      capturedAt: new Date().toISOString(),
      raw: {
        mainText: dom.mainText,
        matchedSelector: dom.matchedSelector,
        features: [citations.length ? 'web_search' : null, answerText ? 'prose' : null].filter(Boolean),
        url: dom.url,
      },
    };
  } finally {
    // newPage wraps page.close() so it tears the context down too.
    await page.close().catch(() => {});
  }
}

// NO `gl=`. Forcing a locale that contradicts the exit IP is what produced
// every early refusal — see the header. Geo targeting belongs on the proxy.
const aiOverview = {
  ENGINE: 'google_ai_overview',
  PROVIDER: 'scraped',
  LABEL: 'Google AI Overview (SERP · self-hosted)',
  capture: (prompt, opts = {}) => run({
    engine: 'google_ai_overview',
    label: aiOverview.LABEL,
    buildUrl: (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}`,
    prompt,
    ...opts,
  }),
};

const aiMode = {
  ENGINE: 'google_ai_mode',
  PROVIDER: 'scraped',
  LABEL: 'Google AI Mode (SERP · self-hosted)',
  capture: (prompt, opts = {}) => run({
    engine: 'google_ai_mode',
    label: aiMode.LABEL,
    // udm=50 is AI Mode. Still refused from a plain ISP address even with the
    // locale parameter removed — defended harder than plain search, so this
    // one genuinely needs a proxy.
    buildUrl: (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}&udm=50`,
    prompt,
    ...opts,
  }),
};

// How the answer was obtained. Both of these drive a real browser, same as the
// chat surfaces; the two DataForSEO surfaces declare 'api'. Every registered
// surface must set this — store.js reads it and the column is constrained.
const ACCESS = 'scraped';

module.exports = {
  aiOverview: { ...aiOverview, ACCESS },
  aiMode: { ...aiMode, ACCESS },
};
