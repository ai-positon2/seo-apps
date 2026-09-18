// ── Working out what the business actually is ────────────────────────────────
//
// Step one of the one-click flow. Reads the site and answers: who is this, what
// do they sell, what would a model call them, and where do they operate.
//
// Everything downstream depends on getting this right. The questions are
// written from it, and — more quietly — the BRAND ALIASES it produces are what
// mention matching runs against. A business whose model-facing name differs
// from its domain stem is invisible to a matcher that only knows the domain,
// and that failure is indistinguishable from a genuine zero. "brushandfloss.com
// is never mentioned" and "Brush and Floss is never mentioned" are different
// findings and only one of them is true.
//
// ── Read the site, do not guess from the domain ────────────────────────────
//
// The homepage plus a handful of pages it links to as products or services. A
// domain stem tells you nothing: `clearbh.com` could be behavioural health or
// a windscreen company, and a profile built on that guess produces ten
// confidently wrong questions that all get measured.
//
// Page reading reuses v1's `readableFromHtml` — the same extraction that feeds
// v1's prompt generation, so both modules see a page the same way.

const { readableFromHtml } = require('../aiVisibility/pagePrompts');
const { createLlmClient } = require('../../services/llmProviders');
const { chatParams } = require('../../locationPageBuilder/llmParams');

// Named explicitly rather than inherited from the app default, for the reason
// pagePrompts.js gives: this is a small, cheap, once-per-project job and the
// choice of a mini model is the point, not an incidental default that drifts.
const MODEL = process.env.AIVL_PROFILE_MODEL || 'gpt-4o-mini';

// The homepage plus at most this many linked pages. Each is a fetch; the
// marginal page after the first few tells the model nothing it does not already
// know about what the business sells.
const MAX_PAGES = 5;

const MAX_CONTENT_CHARS = 4_000;
const FETCH_TIMEOUT_MS = 12_000;

// A real browser UA. A page served a bot-shaped response is a page we would be
// profiling a business from without having seen it.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Link text or href that suggests a page saying what the business sells. Not
// exhaustive and does not need to be — this only orders which pages to read.
const KEY_PAGE_PATTERN = /service|product|treatment|solution|what-we-do|offerings|specialt|practice-area|menu|pricing|plans|about/i;

// Pages that describe the company rather than the offer. Read last.
const WEAK_PAGE_PATTERN = /about|contact|team|career|blog|news|privacy|terms/i;

/**
 * Fetch one page and keep the HTML.
 *
 * v1's `fetchPage` is not reused here for one reason: it returns extracted
 * content and discards the markup, and this step needs the anchors to decide
 * which pages to read next. The extraction itself IS reused, below.
 */
async function fetchHtml(url, { timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' },
    });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };

    const type = res.headers.get('content-type') || '';
    if (!/text\/html|application\/xhtml/i.test(type)) {
      return { ok: false, reason: `not HTML (${type.split(';')[0] || 'unknown'})` };
    }
    const html = await res.text();
    return { ok: true, html, finalUrl: res.url || url };
  } catch (e) {
    return { ok: false, reason: e.name === 'AbortError' ? 'timed out' : e.message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Same-origin links worth reading, best first.
 *
 * Off-site links are dropped: a franchise page linking to its parent brand
 * would otherwise pull the parent's services into this client's profile.
 */
function keyLinksFrom(html, baseUrl) {
  let origin;
  try { origin = new URL(baseUrl).origin; } catch { return []; }

  const anchors = [...String(html).matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)];
  const scored = new Map();

  for (const [, href, inner] of anchors) {
    let abs;
    try { abs = new URL(href, baseUrl); } catch { continue; }
    if (abs.origin !== origin) continue;
    // Fragments and the homepage itself add nothing — it is already being read.
    abs.hash = '';
    const url = abs.toString().replace(/\/$/, '');
    if (url === baseUrl.replace(/\/$/, '')) continue;
    if (/\.(pdf|jpe?g|png|gif|svg|zip|mp4|webp)$/i.test(abs.pathname)) continue;

    const text = inner.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const haystack = `${abs.pathname} ${text}`;
    if (!KEY_PAGE_PATTERN.test(haystack)) continue;

    // A services page beats an about page. Shallow beats deep — a top-level
    // /services says what the business does, /services/x/y/z is one detail.
    const score = (WEAK_PAGE_PATTERN.test(haystack) ? 0 : 10)
      - abs.pathname.split('/').filter(Boolean).length;
    if (!scored.has(url) || scored.get(url) < score) scored.set(url, score);
  }

  return [...scored.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_PAGES - 1)
    .map(([url]) => url);
}

const SYSTEM = `You identify businesses from their own website copy for a market-research tool.

You are given the readable text of a company's homepage and a few of its key pages.
Report ONLY what the pages actually say. Do not infer an industry from the domain
name, do not invent services the pages do not mention, and do not embellish.

If the pages do not support a field, return an empty array or null for it. An
empty answer is correct and useful; a plausible guess is neither.`;

const RESPONSE_FORMAT = `Return ONLY raw JSON, no markdown fences, in exactly this shape:

{
  "business_name": "the name the company calls itself",
  "summary": "one or two plain sentences: what they do and who for",
  "products": ["concrete things they sell"],
  "services": ["concrete services they provide"],
  "brand_aliases": ["every name a person might write for this company"],
  "competitors": ["named competitors, ONLY if the pages name them"],
  "locations": ["cities or regions they say they serve"]
}

brand_aliases is the most important field, and the easiest to get wrong. It is a
list of NAMES ONLY: what the company is called, and what its products are
called. "Acalvio", "ShadowPlex".

Never put any of these in brand_aliases:
  - a page title ("Acalvio | Cyber Deception Technology")
  - a tagline or product description ("AI-Powered Cyber Deception Platform")
  - a name with its category appended ("ShadowPlex Advanced Threat Defense" —
    write "ShadowPlex")
  - generic industry words on their own ("cyber deception", "security platform")
  - the bare domain, unless the company writes it as their name

A name is usually one or two words. If it reads like a description, it belongs
in summary, products or services — not here.`;

function parseReply(raw) {
  const text = String(raw || '').trim().replace(/^```(?:json)?|```$/g, '').trim();
  return JSON.parse(text);
}

/**
 * Keep only things that are actually NAMES.
 *
 * The system prompt asks for names, and a model hands back page titles anyway.
 * That is not a cosmetic problem: promptValidator's brand guard tokenises every
 * alias and treats each token as "this reads as the brand", so one alias of
 * "Acalvio | Cyber Deception Technology for Preemptive Cybersecurity" puts
 * `cyber`, `deception`, `technology`, `platform`, `security` — and `for` — into
 * the brand token set. Every question about the category then reads as naming
 * the client and is rejected, and the project gets zero questions with no error
 * anywhere. That is exactly what happened on the first real run.
 *
 * So the prompt asks, and this enforces:
 *   - no title/tagline punctuation — a name does not contain | : — or ·
 *   - at most four words: "ShadowPlex Identity Protection" is a product line
 *     written out, and the name in it is "ShadowPlex"
 *   - nothing sentence-like
 */
function nameLike(value) {
  const s = String(value || '').trim();
  if (!s || s.length > 60) return false;
  // Separators only ever appear in titles and taglines.
  if (/[|:•·—–]/.test(s)) return false;
  if (/[.!?]$/.test(s)) return false;
  const words = s.split(/\s+/).filter(Boolean);
  if (words.length > 4) return false;
  // "for", "and", "the" in the middle means a phrase, not a name.
  if (words.length > 1 && /\b(for|and|the|with|your|our)\b/i.test(s)) return false;
  return true;
}

/** Trim, drop blanks and duplicates, cap the length. Never returns null. */
function cleanList(value, cap = 12) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  for (const item of value) {
    const s = String(item || '').trim();
    if (!s || s.length > 120) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length >= cap) break;
  }
  return out;
}

/**
 * Read the site and describe the business.
 *
 * @param {object} input
 * @param {string} input.domain   the project's primary domain, with or without scheme
 * @returns {Promise<object>} the profile, plus `sourceUrls` and `modelVersion`
 * @throws when the homepage itself cannot be read — a profile guessed from a
 *   domain is worse than no module, because everything downstream trusts it.
 */
async function build({ domain }) {
  const root = /^https?:\/\//i.test(domain) ? domain : `https://${domain}`;

  const home = await fetchHtml(root);
  if (!home.ok) {
    throw Object.assign(
      new Error(`Could not read ${root} (${home.reason}). The business cannot be identified without it.`),
      { status: 422, code: 'homepage_unreadable' },
    );
  }

  const pages = [{ url: home.finalUrl, content: readableFromHtml(home.html) }];
  const links = keyLinksFrom(home.html, home.finalUrl);

  // Sequential rather than parallel: this is a client's own site, it runs once
  // per project, and four extra connections at once is a rude way to introduce
  // ourselves. The whole step is under ten seconds either way.
  /* eslint-disable no-await-in-loop */
  for (const url of links) {
    const page = await fetchHtml(url);
    if (!page.ok) continue;
    pages.push({ url, content: readableFromHtml(page.html) });
  }
  /* eslint-enable no-await-in-loop */

  const payload = {
    domain: new URL(root).hostname,
    pages: pages.map((p) => ({
      url: p.url,
      title: p.content.title,
      meta_description: p.content.description,
      headings: p.content.headings,
      text: String(p.content.body || '').slice(0, MAX_CONTENT_CHARS),
    })),
  };

  const client = createLlmClient(MODEL);
  const res = await client.chat.completions.create({
    model: client.model,
    response_format: { type: 'json_object' },
    ...chatParams(client.model, { maxTokens: 1200, temperature: 0.2 }),
    messages: [
      { role: 'system', content: `${SYSTEM}\n\n${RESPONSE_FORMAT}` },
      { role: 'user', content: JSON.stringify(payload) },
    ],
  });

  let parsed;
  try {
    parsed = parseReply(res.choices?.[0]?.message?.content);
  } catch (e) {
    throw Object.assign(
      new Error(`The business-identification step returned unreadable JSON: ${e.message}`),
      { status: 502, code: 'profile_unparseable' },
    );
  }

  const businessName = String(parsed?.business_name || '').trim();
  if (!businessName) {
    throw Object.assign(
      new Error('The site did not yield a business name. Add one by hand before measuring.'),
      { status: 422, code: 'profile_incomplete' },
    );
  }

  // The business name is always an alias of itself. The model usually includes
  // it; when it does not, every mention of the company by its own name would go
  // unmatched — the single most damaging thing this step can get wrong.
  //
  // Filtered to names — see nameLike. The business name itself is exempt: it is
  // the one alias that has to survive whatever shape it is in, because without
  // it nothing matches at all.
  const aliases = cleanList([
    businessName,
    ...(parsed?.brand_aliases || []).filter(nameLike),
  ]);

  return {
    businessName,
    summary: String(parsed?.summary || '').trim() || null,
    products: cleanList(parsed?.products),
    services: cleanList(parsed?.services),
    brandAliases: aliases,
    competitors: cleanList(parsed?.competitors),
    locations: cleanList(parsed?.locations, 8),
    sourceUrls: pages.map((p) => p.url),
    modelVersion: MODEL,
  };
}

module.exports = {
  MODEL, MAX_PAGES, build, fetchHtml, keyLinksFrom, cleanList, parseReply, nameLike,
};
