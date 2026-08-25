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

const DEFAULT_CONNECT_TIMEOUT = 10_000;
const DEFAULT_KEEPALIVE = 4_000;

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
    // Pre-flight URL check. With a proxy the real DNS happens at the proxy, but a
    // local resolve still catches obvious internal literals/hostnames cheaply.
    if (!cfg.allowPrivateHosts) {
      await assertPublicUrl(typeof url === "string" ? url : url.url || String(url));
    }
    return undiciFetch(url, { dispatcher, ...options });
  }

  egressFetch.dispatcher = dispatcher;
  egressFetch.mode = cfg.mode;
  egressFetch.close = () => dispatcher.close();
  return egressFetch;
}

module.exports = { createFetch };
