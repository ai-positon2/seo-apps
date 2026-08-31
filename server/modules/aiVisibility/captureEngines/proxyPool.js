// ── The proxy pool ──────────────────────────────────────────────────────────
//
// A rotating pool with per-proxy cooldown, sticky sessions, health tracking and
// geo pinning. Provider-agnostic: it takes a list of proxies from config and
// does not care who sold them.
//
// WHAT THIS IS ACTUALLY FOR, which is not what it looks like.
//
// Phase 0 measured the cause of Google's hard block, and it was NOT
// fingerprinting or bot detection. It was a LOCALE MISMATCH: `gl=us` sent from
// a non-US exit IP is refused outright, and the same browser without that one
// parameter was served an AI Overview. So the proxy's primary job here is
// GEOGRAPHIC HONESTY — making a US query genuinely originate in the US — and
// only secondarily rate spreading.
//
// That reframes the failure mode. A proxy mislabelled as US that actually exits
// in Frankfurt does not just fail; it SUCCEEDS and returns a German-localised
// answer that we then record as a US measurement. Nothing downstream can detect
// that, and it silently corrupts every metric built on those captures.
//
// Hence the rule this file is built around, which is the same rule as
// `mentioned: null`:
//
//   If no proxy in the required country is available, the capture FAILS.
//   It never falls back to another country, and never to a direct connection.
//
// A missing measurement is recoverable. A wrong one that looks right is not.

const CONFIG_ENV = 'AIV_PROXIES';

// How long a proxy rests after use, per engine. Google's tolerance is
// per-request-rate from one address (Phase 0: a second search inside the
// cooldown is refused), so it rests longest. The others are politeness rather
// than a measured limit.
const COOLDOWN_MS = {
  google_ai_overview: Number(process.env.AIV_PROXY_COOLDOWN_GOOGLE_MS) || 90_000,
  google_ai_mode: Number(process.env.AIV_PROXY_COOLDOWN_GOOGLE_MS) || 90_000,
  chatgpt: Number(process.env.AIV_PROXY_COOLDOWN_MS) || 20_000,
  gemini: Number(process.env.AIV_PROXY_COOLDOWN_MS) || 20_000,
};
const DEFAULT_COOLDOWN_MS = 30_000;

// A proxy that got walled is burned for this long. Long, because coming back
// too early on a burned address is how a soft block becomes a hard one.
// Read when used rather than at require time, so a config change takes effect
// on the next capture instead of the next deploy.
const burnMs = () => Number(process.env.AIV_PROXY_BURN_MS) || 30 * 60_000;

// Consecutive failures before a proxy is burned. One failure is noise — a
// timeout, a slow page. Three in a row is the address.
const failuresToBurn = () => Number(process.env.AIV_PROXY_FAILURES_TO_BURN) || 3;

// Sticky sessions held per pool. Far more than any run needs; the cap exists so
// a long-lived worker cannot accumulate one entry per prompt for ever.
const maxSessions = () => Number(process.env.AIV_PROXY_MAX_SESSIONS) || 500;

/**
 * Parse one proxy from the two formats every provider hands out.
 *
 *   http://user:pass@host:port      (URL form)
 *   host:port:user:pass             (list form, what most dashboards export)
 *
 * An optional `#US` or `#us-east` suffix tags the country. Tagging is REQUIRED
 * for geo-pinned work — see `lease`. A provider that gives country-specific
 * endpoints (`us.provider.com:8000`) should be tagged explicitly rather than
 * inferred from the hostname, because inferring it is exactly the confident
 * wrong answer this module exists to avoid.
 */
function parseProxy(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;

  const [addr, tag] = text.split('#');
  const country = tag ? tag.trim().slice(0, 2).toLowerCase() : null;

  try {
    if (/^\w+:\/\//.test(addr)) {
      const u = new URL(addr);
      if (!u.hostname || !u.port) return null;
      return {
        id: `${u.hostname}:${u.port}`,
        url: `${u.protocol}//${u.hostname}:${u.port}`,
        username: u.username ? decodeURIComponent(u.username) : null,
        password: u.password ? decodeURIComponent(u.password) : null,
        country,
      };
    }
  } catch { return null; }

  const parts = addr.split(':');
  if (parts.length < 2) return null;
  const [host, port, username, password] = parts;
  if (!host || !/^\d+$/.test(port)) return null;
  return {
    id: `${host}:${port}`,
    url: `http://${host}:${port}`,
    username: username || null,
    password: password || null,
    country,
  };
}

/** Parse a newline- or comma-separated list. Bad entries are dropped, not fatal. */
function parseList(text) {
  return String(text || '')
    .split(/[\n,]+/)
    .map(parseProxy)
    .filter(Boolean);
}

class ProxyPool {
  constructor(proxies = []) {
    this.proxies = proxies.map((p) => ({
      ...p,
      cooldownUntil: 0,
      // Set by _take; initialised here so a proxy released without ever being
      // leased falls back to a real number rather than undefined.
      leasedFor: DEFAULT_COOLDOWN_MS,
      burnedUntil: 0,
      failures: 0,
      successes: 0,
      lastUsedAt: 0,
      uses: 0,
    }));
    // sessionKey -> proxy id, so a multi-step conversation keeps one exit IP.
    // Bounded: entries are only dropped when a proxy is burned or goes
    // ineligible, so a long-lived worker measuring thousands of prompts would
    // otherwise hold every key it ever saw.
    this.sessions = new Map();
  }

  get size() { return this.proxies.length; }

  countries() {
    return [...new Set(this.proxies.map((p) => p.country).filter(Boolean))];
  }

  /**
   * Take a proxy for one capture.
   *
   * @param {object} input
   * @param {string} input.engine
   * @param {string} [input.country] two-letter code the answer must originate in
   * @param {string} [input.sessionKey] keeps a conversation on one exit IP
   * @param {number} [input.now]
   * @returns {{proxy}|{proxy: null, reason: string}}
   */
  lease({
    engine, country = null, sessionKey = null, now = Date.now(),
  } = {}) {
    if (!this.proxies.length) return { proxy: null, reason: 'no_proxies_configured' };

    const wanted = country ? String(country).slice(0, 2).toLowerCase() : null;

    // Geo pinning is not best-effort. A proxy with no country tag cannot be
    // proven to be in the right place, so it is not eligible for pinned work —
    // an untagged proxy that happens to be US is indistinguishable from one
    // that is not, and guessing is how a German answer becomes a US datapoint.
    const eligible = this.proxies.filter((p) => {
      if (p.burnedUntil > now) return false;
      if (wanted && p.country !== wanted) return false;
      return true;
    });

    if (!eligible.length) {
      const anyInCountry = wanted && this.proxies.some((p) => p.country === wanted);
      return {
        proxy: null,
        reason: wanted && !anyInCountry ? `no_proxy_for_country_${wanted}` : 'all_proxies_burned',
      };
    }

    // A session sticks to its proxy while that proxy is still eligible. An IP
    // that changes mid-conversation looks like a hijack to the engine and ends
    // the session.
    if (sessionKey && this.sessions.has(sessionKey)) {
      const held = eligible.find((p) => p.id === this.sessions.get(sessionKey));
      if (held) {
        this._take(held, engine, now);
        return { proxy: held };
      }
      this.sessions.delete(sessionKey);
    }

    const ready = eligible.filter((p) => p.cooldownUntil <= now);
    if (!ready.length) {
      const soonest = Math.min(...eligible.map((p) => p.cooldownUntil));
      return {
        proxy: null,
        reason: 'all_proxies_cooling',
        retryInMs: Math.max(0, soonest - now),
      };
    }

    // Least recently used first, so load spreads instead of hammering the head
    // of the list — which would burn one address while the rest sit idle.
    ready.sort((a, b) => a.lastUsedAt - b.lastUsedAt);
    const chosen = ready[0];
    this._take(chosen, engine, now);
    if (sessionKey) {
      // Oldest-first eviction, so the map cannot grow without bound.
      if (this.sessions.size >= maxSessions()) {
        const oldest = this.sessions.keys().next().value;
        this.sessions.delete(oldest);
      }
      this.sessions.set(sessionKey, chosen.id);
    }
    return { proxy: chosen };
  }

  _take(proxy, engine, now) {
    proxy.lastUsedAt = now;
    proxy.uses += 1;
    // Held, not rested, until release. Starting the cooldown at lease meant a
    // 110-second capture spent most of its own rest while still in flight, so
    // the address came back available almost immediately after finishing —
    // the opposite of the politeness this is for. A capture that never calls
    // release still cannot be re-leased before this floor.
    proxy.leasedFor = COOLDOWN_MS[engine] ?? DEFAULT_COOLDOWN_MS;
    proxy.cooldownUntil = now + proxy.leasedFor;
  }

  /**
   * Report how a capture went.
   *
   * `blocked` burns the address immediately rather than counting toward the
   * failure threshold: a wall is not noise, and one more request confirms
   * nothing while making the block worse.
   */
  release(proxy, { ok = false, blocked = false, now = Date.now() } = {}) {
    const held = this.proxies.find((p) => p.id === proxy?.id);
    if (!held) return;

    // The rest starts when the address stops being used, not when it started.
    held.cooldownUntil = now + (held.leasedFor ?? DEFAULT_COOLDOWN_MS);

    if (blocked) {
      held.burnedUntil = now + burnMs();
      held.failures = 0;
      for (const [key, id] of this.sessions) {
        if (id === held.id) this.sessions.delete(key);
      }
      return;
    }

    if (ok) { held.successes += 1; held.failures = 0; return; }

    held.failures += 1;
    if (held.failures >= failuresToBurn()) {
      held.burnedUntil = now + burnMs();
      held.failures = 0;
    }
  }

  /** What the pool looks like right now, for the operator view. */
  stats(now = Date.now()) {
    return {
      total: this.proxies.length,
      countries: this.countries(),
      ready: this.proxies.filter((p) => p.burnedUntil <= now && p.cooldownUntil <= now).length,
      cooling: this.proxies.filter((p) => p.burnedUntil <= now && p.cooldownUntil > now).length,
      burned: this.proxies.filter((p) => p.burnedUntil > now).length,
      proxies: this.proxies.map((p) => ({
        id: p.id,
        country: p.country,
        uses: p.uses,
        successes: p.successes,
        failures: p.failures,
        burned: p.burnedUntil > now,
        coolingForMs: Math.max(0, p.cooldownUntil - now),
      })),
    };
  }
}

// One pool per process, built from config on first use.
let _pool = null;

function getPool() {
  if (!_pool) _pool = new ProxyPool(parseList(process.env[CONFIG_ENV]));
  return _pool;
}

/** Test seam, and for reloading config without a restart. */
function setPool(proxies) {
  _pool = new ProxyPool(Array.isArray(proxies) ? proxies : parseList(proxies));
  return _pool;
}

function isConfigured() {
  return getPool().size > 0;
}

module.exports = {
  CONFIG_ENV,
  COOLDOWN_MS,
  burnMs,
  failuresToBurn,
  parseProxy,
  parseList,
  ProxyPool,
  getPool,
  setPool,
  isConfigured,
};
