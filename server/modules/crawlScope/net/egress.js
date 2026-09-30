// Pluggable outbound fetch for the hosted crawler.
//
// Returns a `fetch`-compatible function whose transport is chosen by config/env:
//
//   direct  (default) — undici Agent with a rebinding-safe guarded DNS lookup.
//   proxy             — undici ProxyAgent pointed at PROXY_URL. Residential pools
//                       and managed "unblocker" services (Bright Data Web Unlocker,
//                       Zyte, ScraperAPI, Oxylabs) all expose a user:pass@host:port
//                       endpoint, so switching provider is one env var, no code change.
//
// Anti-blocking reality: a plain fetch client has a fixed TLS/HTTP fingerprint that
// Cloudflare Bot Management can detect regardless of IP or headers. Direct egress
// keeps a single Railway IP well-behaved (see the per-host politeness + backoff in
// crawler.js) but will still be challenged by Cloudflare-protected sites. To pass
// those, set EGRESS_MODE=proxy with a residential/unblocker PROXY_URL.

const { Agent, ProxyAgent, fetch: undiciFetch } = require("undici");
const { guardedLookup, assertPublicUrl } = require("./guard");
const { utf8HeaderValue } = require("../http-redirect");

const DEFAULT_CONNECT_TIMEOUT = 10_000;
const DEFAULT_KEEPALIVE = 4_000;
// The Fetch standard's limit, the one undici applied when it followed them.
const MAX_REDIRECTS = 20;

// A response reached through redirects followed here reports the URL it came
// from and that it was redirected, as undici's own following did.
function withFinalUrl(response, url, redirected) {
  if (!redirected) return response;
  Object.defineProperty(response, "url", { value: url, configurable: true });
  Object.defineProperty(response, "redirected", { value: true, configurable: true });
  return response;
}

function resolveConfig(config = {}) {
  return {
    mode: config.mode || process.env.EGRESS_MODE || "direct",
    proxyUrl: config.proxyUrl || process.env.PROXY_URL || "",
    // SSRF guarding is on by default; the desktop app opts out for localhost audits.
    allowPrivateHosts: config.allowPrivateHosts === true,
    connectTimeout: config.connectTimeout || DEFAULT_CONNECT_TIMEOUT,
  };
}

function createFetch(config = {}) {
  const cfg = resolveConfig(config);
  const lookup = cfg.allowPrivateHosts ? undefined : guardedLookup;
  const connect = { timeout: cfg.connectTimeout };
  if (lookup) connect.lookup = lookup;

  let dispatcher;
  if (cfg.mode === "proxy") {
    if (!cfg.proxyUrl) {
      throw new Error("EGRESS_MODE=proxy requires PROXY_URL to be set.");
    }
    dispatcher = new ProxyAgent({
      uri: cfg.proxyUrl,
      keepAliveTimeout: DEFAULT_KEEPALIVE,
      connect,
    });
  } else {
    dispatcher = new Agent({ keepAliveTimeout: DEFAULT_KEEPALIVE, connect });
  }

  async function egressFetch(url, options = {}) {
    if (cfg.allowPrivateHosts) return undiciFetch(url, { dispatcher, ...options });
    // Pre-flight URL check. With a proxy the real DNS happens at the proxy, but a
    // local resolve still catches obvious internal literals/hostnames cheaply.
    const first = typeof url === "string" ? url : url.url || String(url);
    await assertPublicUrl(first);
    if ((options.redirect || "follow") !== "follow") return undiciFetch(url, { dispatcher, ...options });
    return followChecked(first, options);
  }

  // Redirects are followed here, one hop at a time, each hop checked like the
  // first URL. Left to undici, only the first URL was checked: a hop to an IP
  // literal never reaches the connect-time lookup (Node skips DNS for an IP),
  // so a robots.txt, sitemap or llms.txt answering "302 Location:
  // http://169.254.169.254/" was fetched, and its status leaked into the report.
  async function followChecked(start, options) {
    let current = start;
    let method = String(options.method || "GET").toUpperCase();
    let body = options.body;
    for (let hops = 0; ; hops += 1) {
      const response = await undiciFetch(current, {
        dispatcher,
        ...options,
        method,
        body,
        redirect: "manual",
      });
      const location = utf8HeaderValue(response.headers.get("location") || "");
      if (![301, 302, 303, 307, 308].includes(response.status) || !location) {
        return withFinalUrl(response, current, hops > 0);
      }
      await response.body?.cancel().catch(() => {});
      if (hops >= MAX_REDIRECTS) throw new TypeError(`fetch failed: more than ${MAX_REDIRECTS} redirects`);
      const next = new URL(location, current).href;
      await assertPublicUrl(next);
      // The Fetch standard's method rewrite: a 303, or a 301/302 answering a
      // POST, continues as a bodiless GET.
      if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === "POST")) {
        if (method !== "HEAD") method = "GET";
        body = undefined;
      }
      current = next;
    }
  }

  egressFetch.dispatcher = dispatcher;
  egressFetch.mode = cfg.mode;
  egressFetch.close = () => dispatcher.close();
  return egressFetch;
}

module.exports = { createFetch };
