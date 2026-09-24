"use strict";

// ── Does the site need JavaScript to show its content? ──────────────────────
//
// The crawler reads the HTML a server sends. A site that builds its navigation,
// its text or its title/canonical/robots tags in the browser is audited on what
// it sends, which is not what Google indexes: Google renders the page. The
// crawler already said so for the one unmissable case (a start page with no
// links at all); a site that sends real HTML and then adds most of its links
// with JavaScript read as a smaller, emptier site than it is, with nothing to
// say why.
//
// This renders a small sample of the crawled pages in headless Chromium and
// compares each with what the crawler parsed from the same page.
//
// Every request the browser makes is answered by the crawler's own fetch —
// the one the hosted service guards against private and internal addresses at
// connect time — through request interception, so a page's scripts cannot
// reach anything a crawl could not. The browser itself is pointed at a proxy
// that does not exist, so whatever interception cannot see (a WebSocket) has
// nowhere to go, and WebSocket and WebRTC are removed from the page.

const fs = require("node:fs");

const RENDER_TIMEOUT_MS = 15_000;
// The whole sample, so rendering never holds a crawl's completion for long.
const RENDER_BUDGET_MS = 90_000;
const RENDER_CONCURRENCY = 2;
const MAX_REQUESTS_PER_PAGE = 200;
const MAX_RESPONSE_BYTES = 5_000_000;
// The DOM does not need these to be built, and they are most of a page's bytes.
const SKIPPED_RESOURCES = new Set(["image", "media", "font"]);
// Request headers passed on to the crawler's fetch; the rest are the browser's
// own business or ones fetch will not send.
const FORWARDED_HEADERS = new Set([
  "accept",
  "accept-language",
  "content-type",
  "cookie",
  "origin",
  "referer",
  "user-agent",
  "x-requested-with",
]);
// Response headers the browser must not see: the crawler's fetch has already
// decoded the body, so passing its encoding on would have it decoded twice.
const DROPPED_RESPONSE_HEADERS = new Set([
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
]);

function findBrowserExecutable(env = process.env) {
  const candidates = [
    env.CRAWLSCOPE_CHROME_PATH,
    env.CHROME_PATH,
    env.PUPPETEER_EXECUTABLE_PATH,
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter(Boolean);
  return candidates.find((candidate) => {
    try {
      return fs.existsSync(candidate);
    } catch {
      return false;
    }
  }) || null;
}

// A headless browser, or null when none can be found here. Hosted (Railway,
// Render) uses the bundled @sparticuz/chromium the rest of the app uses.
async function launchBrowser(env = process.env) {
  const puppeteer = require("puppeteer-core");
  const args = [
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--no-first-run",
    "--mute-audio",
    "--disable-background-networking",
    "--proxy-server=http://127.0.0.1:9",
    "--proxy-bypass-list=<-loopback>",
    "--webrtc-ip-handling-policy=disable_non_proxied_udp",
    "--force-webrtc-ip-handling-policy",
  ];
  let executablePath = findBrowserExecutable(env);
  let headless = true;
  if (!executablePath && (env.RAILWAY_ENVIRONMENT || env.RENDER)) {
    const chromium = require("@sparticuz/chromium");
    executablePath = await chromium.executablePath();
    args.unshift(...chromium.args);
    headless = chromium.headless;
  }
  if (!executablePath) return null;
  return puppeteer.launch({ executablePath, headless, args });
}

async function readCapped(response, limit = MAX_RESPONSE_BYTES) {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) throw new Error("response too large to render");
      chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks);
}

function responseHeaders(headers) {
  const out = {};
  for (const [name, value] of headers) {
    if (DROPPED_RESPONSE_HEADERS.has(name.toLowerCase())) continue;
    out[name] = name in out ? `${out[name]}\n${value}` : value;
  }
  return out;
}

// Runs in the page: what an indexer reads from the rendered document.
/* istanbul ignore next */
function readRenderedDocument() {
  const meta = (name) =>
    document.querySelector(`meta[name="${name}" i]`)?.getAttribute("content") || "";
  const text = (document.body?.innerText || "").trim();
  return {
    title: (document.title || "").trim(),
    metaDescription: meta("description").trim(),
    robots: [meta("robots"), meta("googlebot")].filter(Boolean).join(", "),
    canonical: document.querySelector('head link[rel~="canonical" i]')?.href || "",
    h1Count: document.querySelectorAll("h1").length,
    words: text ? text.split(/\s+/).length : 0,
    links: [...new Set(
      [...document.querySelectorAll("a[href], area[href]")]
        .map((link) => link.href)
        .filter((href) => /^https?:/i.test(href)),
    )],
  };
}

// Opens `url` in a fresh page with every request answered by `fetch` (see the
// header), runs `read(page)` once the network is idle, and closes the page.
// `document`, when given, is the response already fetched for `url` itself
// ({ status, contentType, body }), served to the browser instead of fetching
// the page a second time.
async function withRenderedPage(browser, url, { fetch, userAgent, timeout = RENDER_TIMEOUT_MS, document = null }, read) {
  const page = await browser.newPage();
  try {
    await page.setBypassServiceWorker(true);
    if (userAgent) await page.setUserAgent(userAgent);
    await page.evaluateOnNewDocument(() => {
      for (const name of ["WebSocket", "RTCPeerConnection", "webkitRTCPeerConnection"]) {
        try {
          Object.defineProperty(window, name, { value: undefined, configurable: false, writable: false });
        } catch {
          // Already locked down.
        }
      }
    });
    await page.setRequestInterception(true);
    let requests = 0;
    let servedDocument = false;
    page.on("request", (request) => {
      const answer = async () => {
        const target = request.url();
        // data: and blob: never touch the network.
        if (/^(data|blob):/i.test(target)) return request.continue();
        if (!/^https?:/i.test(target)) return request.abort("blockedbyclient");
        if (SKIPPED_RESOURCES.has(request.resourceType())) {
          return request.respond({ status: 204, headers: {}, body: "" });
        }
        if (document && request.isNavigationRequest() && target === url && !servedDocument) {
          servedDocument = true;
          return request.respond({
            status: document.status || 200,
            headers: { "content-type": document.contentType || "text/html; charset=utf-8" },
            body: Buffer.from(String(document.body ?? ""), "utf8"),
          });
        }
        requests += 1;
        if (requests > MAX_REQUESTS_PER_PAGE) return request.abort("blockedbyclient");
        const headers = {};
        for (const [name, value] of Object.entries(request.headers())) {
          if (FORWARDED_HEADERS.has(name.toLowerCase())) headers[name] = value;
        }
        const method = request.method();
        const response = await fetch(target, {
          method,
          headers,
          body: ["GET", "HEAD"].includes(method) ? undefined : request.postData(),
          redirect: "manual",
          signal: AbortSignal.timeout(timeout),
        });
        const body = method === "HEAD" ? Buffer.alloc(0) : await readCapped(response);
        return request.respond({ status: response.status, headers: responseHeaders(response.headers), body });
      };
      answer().catch(() => {
        if (!request.isInterceptResolutionHandled()) request.abort("failed").catch(() => {});
      });
    });
    await page.goto(url, { waitUntil: "networkidle2", timeout });
    return await read(page);
  } finally {
    await page.close().catch(() => {});
  }
}

const renderPage = (browser, url, options) =>
  withRenderedPage(browser, url, options, (page) => page.evaluate(readRenderedDocument));

/**
 * The page's HTML as the browser holds it after its scripts have run, for a
 * crawl that audits rendered pages ("Render JavaScript"). `document` is the
 * response the crawler already fetched for it, so the page is not requested
 * twice; its scripts, styles and data requests go through `fetch`.
 */
function renderHtml(browser, url, { fetch, userAgent, timeout, document }) {
  return withRenderedPage(browser, url, { fetch, userAgent, timeout, document }, (page) => page.content());
}

const sameText = (a, b) => String(a || "").trim().replace(/\s+/g, " ") === String(b || "").trim().replace(/\s+/g, " ");
const robotsTokens = (value) =>
  new Set(String(value || "").toLowerCase().split(/[\s,]+/).filter(Boolean));
const sameRobots = (a, b) => {
  const x = robotsTokens(a);
  const y = robotsTokens(b);
  return x.size === y.size && [...x].every((token) => y.has(token));
};

/**
 * What JavaScript changed on one page: only differences large enough to change
 * what an indexer sees, not every extra word a script prints.
 *
 * @param {object} raw      { url, links: string[] (internal, normalized), words, title, metaDescription, canonical, robots }
 * @param {object} rendered readRenderedDocument() output
 * @param {{ normalize: Function, isInternal: (url, pageUrl) => boolean, same: Function }} identity
 * @returns {{ kind, raw, rendered }[]}
 */
function compareRendering(raw, rendered, { normalize, isInternal, same }) {
  const differences = [];
  const rawLinks = new Set((raw.links || []).map(normalize).filter(Boolean));
  const renderedLinks = new Set(
    (rendered.links || []).map(normalize).filter((url) => url && isInternal(url, raw.url)),
  );
  const added = [...renderedLinks].filter((url) => !rawLinks.has(url)).length;
  if (added >= Math.max(5, Math.ceil(rawLinks.size * 0.3))) {
    differences.push({ kind: "links", raw: rawLinks.size, rendered: renderedLinks.size });
  }
  const rawWords = Number(raw.words) || 0;
  const renderedWords = Number(rendered.words) || 0;
  if (renderedWords >= Math.max(rawWords * 1.5, rawWords + 150)) {
    differences.push({ kind: "words", raw: rawWords, rendered: renderedWords });
  }
  if (!sameText(raw.title, rendered.title)) {
    differences.push({ kind: "title", raw: raw.title || "", rendered: rendered.title || "" });
  }
  if (!sameText(raw.metaDescription, rendered.metaDescription)) {
    differences.push({ kind: "meta description", raw: raw.metaDescription || "", rendered: rendered.metaDescription || "" });
  }
  // An absent canonical reads as the page itself on both sides.
  const rawCanonical = raw.canonical || raw.url;
  const renderedCanonical = rendered.canonical || raw.url;
  if (!same(rawCanonical, renderedCanonical)) {
    differences.push({ kind: "canonical", raw: rawCanonical, rendered: renderedCanonical });
  }
  if (!sameRobots(raw.robots, rendered.robots)) {
    differences.push({ kind: "robots", raw: raw.robots || "", rendered: rendered.robots || "" });
  }
  return differences;
}

/**
 * Render `pages` and compare each with what the crawler parsed.
 *
 * @param {object[]} pages [{ url, raw }] with raw as compareRendering takes it
 * @param {object} options { fetch, userAgent, identity, launch?, budgetMs?, shouldStop? }
 * @returns {Promise<{ ran: boolean, reason?: string, sampled?: number, pages?: object[] }>}
 */
async function renderSample(pages, {
  fetch, userAgent, identity, launch = launchBrowser, budgetMs = RENDER_BUDGET_MS, shouldStop = () => false,
}) {
  if (!pages.length) return { ran: false, reason: "nothing-to-render" };
  let browser = null;
  try {
    browser = await launch();
  } catch (error) {
    return { ran: false, reason: "failed", error: String(error?.message || error).slice(0, 200) };
  }
  if (!browser) return { ran: false, reason: "no-browser" };
  const deadline = Date.now() + budgetMs;
  const out = [];
  try {
    let next = 0;
    const worker = async () => {
      for (;;) {
        const index = next++;
        if (index >= pages.length || Date.now() > deadline || shouldStop()) return;
        const { url, raw } = pages[index];
        try {
          const rendered = await renderPage(browser, url, { fetch, userAgent });
          out[index] = { url, differences: compareRendering({ ...raw, url }, rendered, identity) };
        } catch (error) {
          out[index] = { url, error: String(error?.message || error).slice(0, 200), differences: [] };
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(RENDER_CONCURRENCY, pages.length) }, worker));
  } finally {
    await browser.close().catch(() => {});
  }
  const rendered = out.filter(Boolean);
  const failed = rendered.filter((page) => page.error).length;
  if (rendered.length && failed === rendered.length) {
    return { ran: false, reason: "failed", error: rendered[0].error };
  }
  return { ran: true, sampled: rendered.length - failed, pages: rendered.filter((page) => !page.error) };
}

module.exports = { renderSample, renderHtml, compareRendering, launchBrowser, findBrowserExecutable };
