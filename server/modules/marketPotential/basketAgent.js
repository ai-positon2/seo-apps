// ── Basket-generation agent ───────────────────────────────────────────────────
// Runs ONCE per service to PROPOSE a basket; a human then approves + freezes it
// (store.freezeBasket). The agent does not freeze anything itself.
//
// SEMrush-only reality: the data source is national, so metro signal comes ONLY
// from the city in the query. Therefore every basket term is a SERVICE phrase that
// the provider combines with a city → "[service phrase] [city]" (e.g. "dental
// implants phoenix"). We deliberately EXCLUDE:
//   - "near me" variants  — national data, no geo; and after templating they
//                           collapse onto the base term and double-count it.
//   - generic / broad non-service terms and informational queries.
// Every term must read naturally with a US city name appended.
//
// Uses OpenAI when OPENAI_API_KEY is set; otherwise a deterministic heuristic.

const { hasOpenAI, chat } = require('./openaiClient');
const { INFORMATIONAL_RE, NEAR_ME_RE } = require('../../services/intentVocabulary');

const VALID_TAGS = ['commercial-local', 'commercial-cost', 'commercial-general'];

function sanitizeTerms(raw, service) {
  const seen = new Set();
  const out = [];
  for (const t of raw) {
    let term = (t.term || '').trim().toLowerCase().replace(/\s+/g, ' ');
    if (!term || term.length < 3) continue;
    if (INFORMATIONAL_RE.test(term)) continue;          // drop informational
    if (NEAR_ME_RE.test(term)) continue;                // drop "near me" — no geo signal
    if (term.includes('[city]')) term = term.replace(/\s*\[city\]\s*/g, '').trim(); // city is appended by provider
    if (!term || seen.has(term)) continue;
    seen.add(term);
    // No commercial-local without "near me"; fold any local tag into general.
    let intentTag = VALID_TAGS.includes(t.intentTag) ? t.intentTag : 'commercial-general';
    if (intentTag === 'commercial-local') intentTag = 'commercial-general';
    out.push({ term, intentTag, isGeoTemplate: false }); // all terms are city-combined at fetch time
  }
  return out.slice(0, 25);
}

// ── Heuristic fallback ─────────────────────────────────────────────────────────

function heuristicBasket(service) {
  const s = service.trim().toLowerCase();
  const terms = [];
  const add = (term, intentTag) => terms.push({ term, intentTag });

  // Service + commercial modifiers only — each becomes "[term] [city]" at fetch.
  // No "near me", no generic/broad non-service terms.
  add(`${s}`, 'commercial-general');
  add(`best ${s}`, 'commercial-general');
  add(`top rated ${s}`, 'commercial-general');
  add(`${s} specialist`, 'commercial-general');
  add(`${s} clinic`, 'commercial-general');
  add(`${s} center`, 'commercial-general');
  add(`${s} consultation`, 'commercial-general');
  add(`${s} reviews`, 'commercial-general');
  add(`affordable ${s}`, 'commercial-cost');
  add(`${s} cost`, 'commercial-cost');
  add(`${s} price`, 'commercial-cost');
  add(`${s} cost without insurance`, 'commercial-cost');

  return sanitizeTerms(terms, service);
}

// ── LLM path ───────────────────────────────────────────────────────────────────

async function llmBasket(service) {
  const prompt = `You are building a frozen keyword basket to measure COMMERCIAL search demand for a healthcare service across US metro markets, using SEMrush.

Service: "${service}"

IMPORTANT: SEMrush only provides NATIONAL search data. Metro-level signal comes ONLY from the CITY in the query. Each term you propose will be automatically combined with a city name to form a "[term] [city]" search (e.g. "${service.trim().toLowerCase()} phoenix"). So propose the SERVICE PHRASE part only — do NOT add a city yourself.

Propose 15-25 commercial-intent SERVICE phrases a prospective patient would type (with a city) when ready to find, choose, or price this service.

Rules:
- Every term must read naturally when a US city name is appended (e.g. "affordable ${service.trim().toLowerCase()}" → "affordable ${service.trim().toLowerCase()} austin").
- Tag each with intent_tag: "commercial-cost" (price/cost/affordable) or "commercial-general" (everything else).
- DO NOT include "near me", "nearby", "in my area" or similar — national data has no geo signal and they duplicate the base term.
- DO NOT include generic/broad non-service terms (e.g. "dentist", "clinic" alone), informational queries ("what is…", "how does… work"), or branded/competitor names.
- Prefer specific service variations + commercial modifiers: the service name, synonyms, "best/top ${service.trim().toLowerCase()}", "${service.trim().toLowerCase()} cost/price", "affordable ${service.trim().toLowerCase()}", "${service.trim().toLowerCase()} specialist/clinic/center".

Return ONLY valid JSON, no markdown:
{"terms":[{"term":"...","intent_tag":"commercial-general"}]}`;

  const text = await chat([
    { role: 'system', content: 'You are a precise SEO keyword strategist. Respond with valid JSON only.' },
    { role: 'user', content: prompt },
  ], { maxTokens: 1500, json: true }) || '{}';
  const parsed = JSON.parse(text);
  const raw = (parsed.terms || []).map((t) => ({
    term: t.term,
    intentTag: t.intent_tag,
  }));
  const cleaned = sanitizeTerms(raw, service);
  if (cleaned.length < 10) throw new Error('LLM returned too few usable terms');
  return cleaned;
}

// Propose a basket for a service. Returns { terms, source }.
async function proposeBasket(service) {
  if (hasOpenAI()) {
    try {
      const terms = await llmBasket(service);
      return { terms, source: 'openai' };
    } catch (err) {
      console.warn(`[market-potential] LLM basket failed (${err.message}) — using heuristic`);
    }
  }
  return { terms: heuristicBasket(service), source: 'heuristic' };
}

module.exports = { proposeBasket, VALID_TAGS };
