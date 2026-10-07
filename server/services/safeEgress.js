// ── Outbound requests to user-supplied URLs ──────────────────────────────────
// The tool routes fetch whatever URL a signed-in user types, and a headless
// browser loads it. Two gaps made that a way into this server's own network:
//
//   • Only the first hostname was checked (assertPublicHost), and then axios
//     followed up to five redirects on its own. A public page answering
//     "302 Location: http://169.254.169.254/" was fetched, and some routes
//     return the body.
//   • Chromium was handed the URL with no scheme check at all, so file:// read
//     the local disk.
//
// This builds on CrawlScope's guard (modules/crawlScope/net/guard.js), which is
// the stronger of the two checks in the codebase: it refuses at DNS-connect
// time, so a rebinding answer (public for the check, private for the connect)
// is still caught. Node skips the lookup for an IP literal, which is why
// redirect hops to a literal are checked separately in beforeRedirect.

const net = require('node:net');
const dns = require('node:dns').promises;
const axios = require('axios');
const { guardedLookup, assertPublicUrl, isPublicAddress, SsrfError } = require('../modules/crawlScope/net/guard');

const WEB_PROTOCOLS = new Set(['http:', 'https:']);
// Inline resources a page builds for itself; nothing leaves the browser.
const INLINE_PROTOCOLS = new Set(['data:', 'blob:', 'about:']);

const bareHost = (hostname) => String(hostname || '').replace(/^\[/, '').replace(/\]$/, '');

/**
 * follow-redirects calls this before each hop. Throwing aborts the request.
 * Hostnames are left to the guarded lookup at connect time; literals never
 * reach a lookup, so they are judged here.
 */
function assertRedirectAllowed(options) {
  if (!WEB_PROTOCOLS.has(options.protocol)) {
    throw new SsrfError(`Redirect to a non-http URL is not allowed (${options.protocol})`);
  }
  const host = bareHost(options.hostname);
  if (net.isIP(host) && !isPublicAddress(host)) {
    throw new SsrfError(`Refusing to follow a redirect to non-public address ${host}`);
  }
}

/** An axios config that refuses non-public destinations on every hop. */
function safeAxiosConfig(config = {}) {
  const callerHook = config.beforeRedirect;
  return {
    ...config,
    lookup: guardedLookup,
    beforeRedirect: (options, responseDetails) => {
      assertRedirectAllowed(options);
      if (callerHook) callerHook(options, responseDetails);
    },
    // An environment proxy would resolve the destination itself, out of the
    // guard's sight.
    proxy: false,
  };
}

/** axios.get with the destination checked before sending and on every redirect. */
async function safeGet(url, config = {}) {
  await assertPublicUrl(url);
  return axios.get(url, safeAxiosConfig(config));
}

/**
 * For a headless browser's request interception: may this request go out?
 * `cache` is a Map kept per page, so a page loading fifty assets from one host
 * resolves it once.
 */
async function isBrowserRequestAllowed(url, cache = new Map()) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (INLINE_PROTOCOLS.has(parsed.protocol)) return true;
  if (!WEB_PROTOCOLS.has(parsed.protocol)) return false;

  const host = bareHost(parsed.hostname);
  if (net.isIP(host)) return isPublicAddress(host);

  if (!cache.has(host)) {
    cache.set(host, dns.lookup(host, { all: true, verbatim: true })
      .then((addresses) => addresses.length > 0 && addresses.every((a) => isPublicAddress(a.address)))
      .catch(() => false));
  }
  return cache.get(host);
}

/**
 * Turns on request interception for a puppeteer page and refuses every request
 * (navigation, redirect hop, iframe, XHR, asset) bound for a non-public host or
 * a non-web scheme. `block(req)` is the caller's own filter, e.g. skipping
 * images; it shares this one handler because puppeteer allows each intercepted
 * request to be resolved exactly once.
 *
 * Chromium does its own DNS, so a rebinding answer between this check and its
 * connect is not caught here; the pre-flight on the page URL and this check
 * together stop the direct forms.
 */
async function guardPage(page, { block } = {}) {
  const cache = new Map();
  await page.setRequestInterception(true);
  page.on('request', async (req) => {
    let allowed = false;
    try {
      allowed = await isBrowserRequestAllowed(req.url(), cache);
    } catch {
      allowed = false;
    }
    try {
      if (!allowed || (block && block(req))) await req.abort();
      else await req.continue();
    } catch {
      // The page closed while the check was in flight; nothing left to resolve.
    }
  });
}

module.exports = {
  safeGet,
  safeAxiosConfig,
  assertRedirectAllowed,
  isBrowserRequestAllowed,
  guardPage,
  assertPublicUrl,
  SsrfError,
};
