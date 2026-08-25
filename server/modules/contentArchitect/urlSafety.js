// ── SSRF protection ──────────────────────────────────────────────────────────
// Every outbound request in this module — the Stage 0 reachability check, the
// Stage 1 sitemap/robots fetches, and (later) the Stage 4 crawler — must route
// through fetchSafe() rather than calling axios directly. It resolves the
// hostname itself, rejects private/loopback/link-local/reserved ranges before
// connecting, and follows redirects manually (maxRedirects: 0 on the
// underlying request) so every hop gets the same check — a public URL that
// redirects to an internal address is exactly the attack this exists to stop.
const net = require('net');
const dns = require('dns').promises;
const axios = require('axios');
const { MAX_REDIRECT_HOPS, FETCH_TIMEOUT_MS } = require('./config');

const USER_AGENT = 'Mozilla/5.0 (compatible; ContentArchitectBot/1.0; +internal)';

function ipv4ToInt(ip) {
  const parts = ip.split('.').map(Number);
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function inRange(intIp, base, bits) {
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (intIp & mask) === (ipv4ToInt(base) & mask);
}

// CIDR blocks covering loopback, private, link-local, CGNAT, and the
// documentation/benchmarking ranges — anything that should never be treated
// as "the public internet" for an outbound fetch initiated by this server.
const BLOCKED_V4_RANGES = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

function isBlockedV4(ip) {
  const intIp = ipv4ToInt(ip);
  return BLOCKED_V4_RANGES.some(([base, bits]) => inRange(intIp, base, bits));
}

function isBlockedV6(ip) {
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower === '::') return true;
  if (lower.startsWith('fe80:') || lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) return true; // fe80::/10
  if (/^f[cd][0-9a-f]{2}:/.test(lower)) return true; // fc00::/7 (unique local)
  // IPv4-mapped ("::ffff:a.b.c.d") — check the embedded v4 address too
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isBlockedV4(mapped[1]);
  return false;
}

function isBlockedIp(ip) {
  const family = net.isIP(ip);
  if (family === 4) return isBlockedV4(ip);
  if (family === 6) return isBlockedV6(ip);
  return true; // not a recognizable IP at all — fail closed
}

class UnsafeUrlError extends Error {
  constructor(message, url) {
    super(message);
    this.name = 'UnsafeUrlError';
    this.url = url;
  }
}

// Resolves the hostname and throws UnsafeUrlError if it lands on a blocked
// range. Every literal-IP hostname is checked directly (no DNS round trip
// needed); every name is resolved and ALL returned addresses are checked —
// a DNS response mixing a public and a private address is still unsafe.
async function assertPublicHost(hostname) {
  if (net.isIP(hostname)) {
    if (isBlockedIp(hostname)) throw new UnsafeUrlError(`Blocked private/reserved address: ${hostname}`, hostname);
    return;
  }
  let addresses;
  try {
    addresses = await dns.resolve(hostname, 'A').catch(() => []);
    const v6 = await dns.resolve(hostname, 'AAAA').catch(() => []);
    addresses = [...addresses, ...v6];
  } catch {
    addresses = [];
  }
  if (!addresses.length) throw new UnsafeUrlError(`Could not resolve host: ${hostname}`, hostname);
  for (const addr of addresses) {
    if (isBlockedIp(addr)) throw new UnsafeUrlError(`Host resolves to a private/reserved address: ${hostname} -> ${addr}`, hostname);
  }
}

// GET (or HEAD) with manual redirect validation. Never lets axios follow
// redirects itself (maxRedirects: 0) — each Location header is re-validated
// as its own request before being followed, capped at MAX_REDIRECT_HOPS.
async function fetchSafe(url, { method = 'get', timeout = FETCH_TIMEOUT_MS, responseType = 'text', headers = {} } = {}) {
  let currentUrl = url;
  for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
    const parsed = new URL(currentUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new UnsafeUrlError(`Unsupported protocol: ${parsed.protocol}`, currentUrl);
    }
    await assertPublicHost(parsed.hostname);

    const res = await axios.request({
      url: currentUrl,
      method,
      timeout,
      responseType,
      maxRedirects: 0,
      validateStatus: (s) => (s >= 200 && s < 400),
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        ...headers,
      },
    });

    if (res.status >= 300 && res.status < 400 && res.headers.location) {
      if (hop === MAX_REDIRECT_HOPS) throw new Error(`Too many redirects (>${MAX_REDIRECT_HOPS}) fetching ${url}`);
      currentUrl = new URL(res.headers.location, currentUrl).href;
      continue;
    }
    return { data: res.data, status: res.status, headers: res.headers, finalUrl: currentUrl };
  }
  throw new Error(`Too many redirects fetching ${url}`);
}

module.exports = { fetchSafe, assertPublicHost, isBlockedIp, UnsafeUrlError, USER_AGENT };
