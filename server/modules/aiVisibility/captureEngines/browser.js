// ── The browser the capture engines drive ───────────────────────────────────
//
// Deliberately small. Phase 2 replaces the internals with Crawlee's
// BrowserPool + SessionPool (proxy rotation, fingerprints tied to proxy URLs);
// the exported surface here is the seam that makes that swap a one-file change.
//
// What this is NOT: services/scraper.js. That one announces itself as
// `Screaming Frog SEO Spider/23.1`, which is an instant block on the targets
// here, and it launches and closes a browser per call. This keeps one warm
// browser and hands out pages, because a capture run is hundreds of sequential
// prompts and paying Chrome's startup cost each time is minutes of wasted wall
// clock per client per day.

const fs = require('fs');
const puppeteer = require('puppeteer-core');

// A current, ordinary desktop Chrome. The single most important line in this
// file — the default puppeteer UA and the crawler's Screaming Frog UA are both
// immediate tells.
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

const VIEWPORT = { width: 1400, height: 1600 };

const LAUNCH_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  // Removes the navigator.webdriver tell. Verified in the Phase 0 spike:
  // logged-out chatgpt.com served a normal page with no Cloudflare challenge.
  '--disable-blink-features=AutomationControlled',
  '--window-size=1400,1600',
  '--lang=en-US,en',
];

function findLocalBrowser() {
  const candidates = [
    process.env.CHROME_PATH,
    process.env.PUPPETEER_EXECUTABLE_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  return candidates.find((p) => { try { return fs.existsSync(p); } catch { return false; } }) || null;
}

let _browser = null;

/**
 * The shared browser, launched on first use.
 *
 * Takes NO proxy. It used to accept one and pass it as --proxy-server, which
 * was silently wrong twice over: the flag is browser-wide, so it pinned every
 * later capture to the first proxy seen; and on the memoized path — which is
 * every call after the first, since closeBrowser() is never called — the
 * argument was discarded entirely. A geo-pinned Google capture would then run
 * on a plain ISP address and be recorded as a US measurement, which is exactly
 * the "wrong one that looks right" proxyPool.js is built to prevent.
 *
 * The proxy now belongs to the CONTEXT (see newPage), which is per capture and
 * is what the pool actually leases.
 */
async function getBrowser({ headless = true } = {}) {
  if (_browser && _browser.connected !== false) return _browser;

  const executablePath = findLocalBrowser();
  if (!executablePath) {
    throw Object.assign(
      new Error('No Chrome/Chromium found. Set CHROME_PATH or PUPPETEER_EXECUTABLE_PATH.'),
      { code: 'no_browser' },
    );
  }

  _browser = await puppeteer.launch({
    executablePath,
    headless: headless ? 'new' : false,
    args: LAUNCH_ARGS,
  });
  return _browser;
}

// The ONLY images that carry data we need. Citations are rendered as favicons,
// and the destination survives nowhere else on the page:
//
//   ChatGPT     google.com/s2/favicons?domain=https%3A%2F%2Fwww.ada.org
//   Google AI   encrypted-tbn0.gstatic.com/faviconV2?url=https://foreondental.com
//
// Everything else — result thumbnails, map tiles, logos, sprites — is weight we
// pay for per gigabyte and never read.
const FAVICON_HOSTS = /(^|\.)(gstatic\.com|google\.com)$/i;
const FAVICON_PATH = /favicon/i;

function isCitationImage(url) {
  try {
    const u = new URL(url);
    return FAVICON_HOSTS.test(u.hostname) && FAVICON_PATH.test(u.pathname);
  } catch { return false; }
}

/**
 * A page with the identity bits already set.
 *
 * Citation favicons are `<img>` tags and their query string is how source
 * domains are recovered at all, so images cannot simply be blocked the way
 * services/scraper.js blocks them — that would silently delete every citation.
 *
 * `frugal` keeps exactly those and drops the rest. It is off by default because
 * request interception is itself a fingerprinting surface, and on a connection
 * that costs nothing there is no reason to take that risk. Through a metered
 * residential proxy the trade inverts: a Google SERP's thumbnails and map tiles
 * are the bulk of the page and none of them are ever read.
 */
async function newPage(browser, {
  proxyAuth = null, frugal = false, isolated = false, proxyUrl = null,
} = {}) {
  // An isolated context per capture.
  //
  // The default context persists cookies, localStorage, IndexedDB and service
  // workers for the whole worker-process lifetime — nothing ever calls
  // closeBrowser(). On chatgpt.com and gemini.google.com that meant a session
  // that aged across every run: Cloudflare's __cf_bm expires after ~30 minutes
  // idle, and a stale session serves a returning-visitor variant whose consent
  // and "stay logged out" modals swallow the Enter key. That produced captures
  // where the question was never submitted, which the old settle loop then
  // reported as a finished answer.
  //
  // googleAiScraped has done this per capture from the start, for the same
  // reason in its own words: "one poisoned session would condemn every capture
  // after it in the run". It lives here now so every surface gets it.
  // A proxy REQUIRES its own context — proxyServer is a context option, and
  // there is nowhere else to put it that is per capture. Asking for one
  // without context support is refused rather than quietly served direct.
  const wantsContext = isolated || Boolean(proxyUrl);
  const canContext = typeof browser.createBrowserContext === 'function';
  if (proxyUrl && !canContext) {
    throw Object.assign(
      new Error('This browser cannot isolate a context, so a proxy cannot be applied '
        + 'to one capture. Refusing rather than connecting directly.'),
      { code: 'no_context_proxy' },
    );
  }
  const context = wantsContext && canContext
    ? await browser.createBrowserContext(proxyUrl ? { proxyServer: proxyUrl } : undefined)
    : null;
  const page = context ? await context.newPage() : await browser.newPage();

  // Closing the page must close the context with it, or an isolated capture
  // leaks a context per capture and the browser grows without bound.
  if (context) {
    const closePage = page.close.bind(page);
    let closed = false;
    page.close = async (...args) => {
      if (closed) return;
      closed = true;
      try { await closePage(...args); } finally {
        // Logged, not swallowed: a context that will not close is a leaked
        // browser process, and the whole reason for isolating one per capture
        // is that they do not accumulate.
        await context.close().catch((e) => {
          console.warn('[aiVisibility.browser] context close failed:', e.message);
        });
      }
    };
  }
  await page.setUserAgent(USER_AGENT);
  await page.setViewport(VIEWPORT);
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
  if (proxyAuth?.username) await page.authenticate(proxyAuth);

  if (frugal) {
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const type = req.resourceType();
      if ((type === 'image' || type === 'media' || type === 'font')
          && !isCitationImage(req.url())) {
        req.abort().catch(() => {});
        return;
      }
      req.continue().catch(() => {});
    });
  }

  return page;
}

/**
 * Close the shared browser.
 *
 * Nothing calls this today — the worker exits the process instead — so the
 * browser lives as long as the worker. That is deliberate (launching Chrome
 * per capture is expensive), and it is safe now only because `isolated`
 * keeps per-site state from accumulating inside it.
 */
async function closeBrowser() {
  if (!_browser) return;
  try { await _browser.close(); } catch { /* already gone */ }
  _browser = null;
}

module.exports = {
  isCitationImage,
  USER_AGENT, VIEWPORT, LAUNCH_ARGS, findLocalBrowser, getBrowser, newPage, closeBrowser,
};
