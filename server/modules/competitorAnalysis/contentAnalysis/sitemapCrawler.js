// ── Sitemap-based site structure crawler ────────────────────────────────────
// Adapted from server/modules/robotsMonitor/sitemapCrawler.js's robots.txt
// discovery + sitemap-index resolution, but for a different purpose: that
// crawler samples ~100 random URLs for index-health spot-checks; this one
// needs the FULL URL set (up to a safety cap) to produce accurate page-type
// counts — a random sample would badly distort a "340 location pages vs 12"
// comparison.
const axios = require('axios');
const { XMLParser } = require('fast-xml-parser');
const { challengeReason } = require('../../../checks/challengePage');

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
const EXCLUDED_EXTENSIONS = /\.(pdf|jpe?g|png|gif|webp|svg|zip|css|js)$/i;

// Sane crawl limits so one bloated competitor sitemap can't hang the run.
const MAX_CHILD_SITEMAPS = 50;
const MAX_TOTAL_URLS = 20000;
const FETCH_TIMEOUT_MS = 15000;

// A bot-identifying User-Agent gets blocked outright by some sites' WAF/CDN
// bot protection (Cloudflare et al. return 403/406) — a realistic browser
// header set avoids that false negative. Matches the header set already used
// by articleEnhancement.js's crawler for the same reason.
function axiosConfig() {
  return {
    timeout: FETCH_TIMEOUT_MS,
    maxRedirects: 5,
    responseType: 'text',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  };
}

function stripWww(hostname) {
  return hostname.replace(/^www\./i, '');
}

// Client/competitor domains are sometimes stored with a scheme and/or
// trailing slash (e.g. a user pastes a full URL when adding a client)
// rather than a bare hostname. Without this, a domain already containing
// "https://" turned every candidate URL below into
// "https://https://example.com/...", which fails outright — surfacing as
// a false "no accessible sitemap found" for a domain that has one.
function stripScheme(url) {
  return url.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
}

// A refusal status, or a bot-protection holding page served in place of the
// file (Cloudflare "Just a moment...", Vercel "Security Checkpoint"), means we
// could not look — not that the site has no sitemap. 8x8 (429 checkpoint on
// robots.txt) and vonage.com (403 challenge on its sitemap) were both reported
// as "no sitemap" and the AI summary called that their biggest gap.
const BLOCK_STATUSES = new Set([401, 403, 429, 503]);

function htmlTitle(body) {
  const m = /<title[^>]*>([^<]*)<\/title>/i.exec(String(body || '').slice(0, 20000));
  return m ? m[1].trim() : null;
}

function isBlockedResponse(res) {
  if (!res) return false;
  if (BLOCK_STATUSES.has(res.status)) return true;
  const mitigated = res.headers && (res.headers['cf-mitigated'] || res.headers['x-vercel-mitigated']);
  if (mitigated && /challenge|deny/i.test(String(mitigated))) return true;
  const title = htmlTitle(res.data);
  return !!(title && challengeReason({ title }));
}

// Fetches one URL and records the outcome on `log` (status per URL, and
// whether it was a block). Returns the response body, or null on any failure.
async function fetchRecorded(url, log) {
  try {
    const res = await axios.get(url, axiosConfig());
    const blocked = isBlockedResponse(res);
    log.push({ url, status: res.status ?? 200, blocked });
    return blocked ? null : res.data;
  } catch (err) {
    const res = err.response;
    const status = res?.status ?? null;
    log.push({
      url, status, blocked: isBlockedResponse(res),
      error: status ? `HTTP ${status}` : (err.code || err.message || 'request failed'),
    });
    return null;
  }
}

async function fetchXml(url, log) {
  const body = await fetchRecorded(url, log);
  if (body === null || body === undefined) return null;
  try { return parser.parse(body); } catch { return null; }
}

function isValidSitemapXml(parsed) {
  return !!(parsed && (parsed.urlset || parsed.sitemapindex));
}

function extractUrlsFromUrlset(parsed) {
  const urlset = parsed.urlset;
  if (!urlset || !urlset.url) return [];
  const urls = Array.isArray(urlset.url) ? urlset.url : [urlset.url];
  return urls.map((u) => (typeof u === 'string' ? u : u.loc)).filter(Boolean);
}

// The Sitemap: lines a robots.txt declares, de-duplicated in file order. A
// failed or blocked robots.txt is recorded on `log`, so it is never mistaken
// for one that simply declares nothing.
async function extractSitemapUrlsFromRobots(baseUrl, log = []) {
  const body = await fetchRecorded(`${baseUrl}/robots.txt`, log);
  if (typeof body !== 'string') return [];
  const matches = body.match(/^Sitemap:\s*(.+)$/gim) || [];
  return [...new Set(matches.map((line) => line.replace(/^Sitemap:\s*/i, '').trim()).filter(Boolean))];
}

function newState() {
  return { urls: new Set(), sitemapsFetched: 0, capped: false, failedChildren: 0, log: [] };
}

function budgetSpent(state) {
  return state.urls.size >= MAX_TOTAL_URLS || state.sitemapsFetched >= MAX_CHILD_SITEMAPS;
}

// Recursively resolves a sitemap (or sitemap index) into every URL across
// every child sitemap, up to MAX_CHILD_SITEMAPS files and MAX_TOTAL_URLS
// URLs. Sets `state.capped = true` the moment either limit is hit, so the
// caller can flag the result as a partial sample rather than a true total.
// The state is shared across every sitemap a domain declares, so the caps
// are one budget for the whole domain, not one per robots.txt entry.
async function resolveAll(entryUrl, state, depth = 0) {
  if (budgetSpent(state)) {
    state.capped = true;
    return;
  }
  // Only the top-level fetches are kept as per-candidate checks; a child
  // that fails is counted, so the total can be flagged as partial.
  const log = depth === 0 ? state.log : [];
  const parsed = await fetchXml(entryUrl, log);
  if (!parsed) {
    if (depth > 0) state.failedChildren++;
    return; // unreachable sitemap — skip it, don't fail the whole crawl
  }
  state.sitemapsFetched++;
  if (!isValidSitemapXml(parsed)) return;

  if (parsed.sitemapindex) {
    const raw = parsed.sitemapindex.sitemap;
    const entries = Array.isArray(raw) ? raw : [raw].filter(Boolean);
    const locs = entries.map((e) => (typeof e === 'string' ? e : e?.loc)).filter(Boolean);
    for (const loc of locs) {
      if (budgetSpent(state)) { state.capped = true; break; }
      await resolveAll(loc, state, depth + 1);
    }
    return;
  }

  for (const u of extractUrlsFromUrlset(parsed)) {
    if (state.urls.size >= MAX_TOTAL_URLS) { state.capped = true; break; }
    if (!EXCLUDED_EXTENSIONS.test(u)) state.urls.add(u);
  }
}

// Discovers the domain's sitemap(s) via robots.txt (falling back to common
// well-known paths when robots.txt is missing or has no Sitemap: directive),
// then crawls every one — recursing through sitemap indexes — to produce the
// full declared URL set for that domain.
//
// Every Sitemap: line counts. Nike's robots.txt declares seven sitemaps and
// the first is its help centre; stopping at the first one that resolved
// reported Nike as a 113-page site with "virtually no shopping architecture".
// All declared sitemaps now feed one shared URL set under one budget, and
// the result says when it is partial (budget spent, or a declared sitemap or
// child could not be read). The well-known paths are only a fallback: they
// are usually alternative names for the same file, so the first that
// resolves is used.
//
// Each top-level fetch (robots.txt and every candidate) is returned in
// `checks` with its HTTP status. When nothing could be read and any of those
// was a refusal or a bot wall, the status is 'blocked' with totalUrls null —
// "we could not look", never "0 pages".
//
// Tries both the bare domain and its www-prefixed variant as the base for
// robots.txt/sitemap discovery: some sites 404/redirect-loop on one but not
// the other (e.g. a legacy Apache redirect rule on the bare-domain path),
// and hostname matching is done www-agnostic, since it's common for a site
// tracked without "www." to declare all its sitemap URLs with it (or vice
// versa) — treating that as "no same-host URLs" would silently discard a
// perfectly good sitemap.
async function crawlDomain(domain) {
  const bareHost = stripWww(stripScheme(domain));
  const targetHost = stripWww(bareHost); // normalized comparison target
  const baseVariants = [`https://${bareHost}`, `https://www.${bareHost}`];
  const checks = [];
  const seenRobots = new Set();

  const sameHostOf = (state) => [...state.urls].filter((u) => {
    try { return stripWww(new URL(u).hostname) === targetHost; } catch { return false; }
  });
  const found = (state, sitemapUrls, partial) => {
    const sameHost = sameHostOf(state);
    return {
      sitemapUrl: sitemapUrls[0],
      sitemapUrls,
      sitemapStatus: 'found',
      urls: sameHost,
      totalUrls: sameHost.length,
      capped: state.capped,
      partial: state.capped || state.failedChildren > 0 || partial,
      checks,
      error: null,
    };
  };

  for (const base of baseVariants) {
    const robotsLog = [];
    const fromRobots = await extractSitemapUrlsFromRobots(base, robotsLog);
    checks.push(...robotsLog);

    // Both base variants usually declare the same list; crawl it once.
    const key = fromRobots.join('\n');
    if (fromRobots.length && !seenRobots.has(key)) {
      seenRobots.add(key);
      const state = newState();
      const resolved = [];
      let unread = 0;
      for (const sitemap of fromRobots) {
        if (budgetSpent(state)) { state.capped = true; unread++; continue; }
        const before = state.sitemapsFetched;
        await resolveAll(sitemap, state);
        if (state.sitemapsFetched > before) resolved.push(sitemap);
        else unread++;
      }
      checks.push(...state.log);
      if (resolved.length && sameHostOf(state).length) return found(state, resolved, unread > 0);
    }

    const fallbacks = [
      `${base}/sitemap_index.xml`,
      `${base}/sitemap.xml`,
      `${base}/sitemap-index.xml`,
      `${base}/wp-sitemap.xml`,
    ];
    for (const candidate of fallbacks) {
      const state = newState();
      await resolveAll(candidate, state);
      checks.push(...state.log);
      if (state.sitemapsFetched === 0) continue; // candidate never resolved — try the next one
      if (!sameHostOf(state).length) continue;
      return found(state, [candidate], false);
    }
  }

  const block = checks.find((c) => c.blocked);
  if (block) {
    return {
      sitemapUrl: null,
      sitemapUrls: [],
      sitemapStatus: 'blocked',
      urls: [],
      totalUrls: null,
      capped: false,
      partial: false,
      checks,
      error: `Site blocked our request${block.status ? ` (HTTP ${block.status})` : ''}.`,
    };
  }

  return {
    sitemapUrl: null,
    sitemapUrls: [],
    sitemapStatus: 'not-found',
    urls: [],
    totalUrls: 0,
    capped: false,
    partial: false,
    checks,
    error: 'No accessible sitemap found via robots.txt or common paths (tried with and without www).',
  };
}

module.exports = { crawlDomain, isBlockedResponse, MAX_TOTAL_URLS, MAX_CHILD_SITEMAPS };
