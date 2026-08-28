// ── Reading an answer out of a provider response ─────────────────────────────
//
// Derived from Elmo (MIT) — see ./LICENSE-elmo.md.
//
// The one distinction here that is a correctness issue rather than a detail:
//
//   result.sources        the sources the answer actually cited     → citations
//   result.search_results the results the model was SHOWN           → ignored
//
// Counting `search_results` as citations would materially overstate every
// brand's presence, because a model is shown far more than it cites. A report
// that did that would tell a client they are winning when they are not.

/** Array or nothing. Never throws on a shape we did not expect. */
function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function firstResult(raw) {
  return raw?.tasks?.[0]?.result?.[0] || null;
}

/**
 * The answer text from an LLM Scraper response (ChatGPT, Gemini).
 *
 * Prefers the whole-response `markdown`. Older or partial responses populate
 * only the per-item blocks, which are separate markdown blocks — joined with a
 * blank line, because a single newline is a soft break and would render
 * consecutive blocks as one run-on paragraph.
 *
 * Returns null, not a placeholder string, when there is nothing. The caller has
 * to be able to tell "no answer" from "an answer that says no": a placeholder
 * would be scanned for the brand name and scored as a real absence.
 */
function textFromScraper(raw) {
  const result = firstResult(raw);
  if (!result) return null;

  const markdown = result.markdown;
  if (typeof markdown === 'string' && markdown.trim()) return markdown.trim();

  const blocks = [];
  for (const item of asArray(result.items)) {
    if (typeof item?.markdown === 'string' && item.markdown.trim()) {
      blocks.push(item.markdown.trim());
    }
  }
  return blocks.length ? blocks.join('\n\n') : null;
}

/**
 * The answer text from a Google SERP response (AI Overview / AI Mode).
 *
 * The AI Overview arrives as an `items[]` entry of type `ai_overview`, whose own
 * `items[]` carry the text. Both nesting levels are walked because DataForSEO
 * has shipped both shapes.
 */
function textFromGoogle(raw) {
  const result = firstResult(raw);
  if (!result) return null;

  const blocks = [];
  const collect = (node) => {
    if (!node) return;
    if (typeof node.text === 'string' && node.text.trim()) blocks.push(node.text.trim());
    if (typeof node.markdown === 'string' && node.markdown.trim()) blocks.push(node.markdown.trim());
    for (const child of asArray(node.items)) collect(child);
  };

  for (const item of asArray(result.items)) {
    if (item?.type === 'ai_overview' || item?.type === 'ai_mode') collect(item);
  }
  // Some AI Mode responses put the answer at the top level rather than under a
  // typed item.
  if (!blocks.length) for (const item of asArray(result.items)) collect(item);

  return blocks.length ? [...new Set(blocks)].join('\n\n') : null;
}

const { isGoogleRedirect } = require('./resolveRedirects');

/**
 * Normalise one source into a citation, or null if the URL is unusable.
 *
 * `publisher` is the provider's own name for the source ("Mayo Clinic"). It is
 * kept alongside the domain because on Google AI Overview it is the ONLY
 * trustworthy identity at capture time — the url is a redirect and the
 * provider's `domain` field says google.com for every single reference.
 *
 * A redirect gets `domain: null` and `resolved: false` rather than the
 * redirector's hostname. Storing google.com there would be a confident wrong
 * answer, and every AI Overview would report google.com as its only source.
 */
function toCitation(url, title, index, publisher) {
  if (typeof url !== 'string' || !url.trim()) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    const redirect = isGoogleRedirect(url);
    return {
      url,
      title: (typeof title === 'string' && title.trim()) ? title.trim() : null,
      publisher: (typeof publisher === 'string' && publisher.trim()) ? publisher.trim() : null,
      domain: redirect ? null : parsed.hostname.replace(/^www\./i, '').toLowerCase(),
      redirect,
      resolved: !redirect,
      index,
    };
  } catch {
    return null;
  }
}

/** Dedupe by URL, keeping first-seen order — citation order carries meaning. */
function collect(sources) {
  const seen = new Set();
  const out = [];
  for (const source of sources) {
    const url = source?.url;
    if (typeof url !== 'string' || seen.has(url)) continue;
    // Google AI Overview names the publisher in `source`; the ChatGPT scraper
    // calls the same thing `source_name`. One field name per surface, one value.
    const citation = toCitation(url, source?.title, out.length, source?.source || source?.source_name);
    if (!citation) continue;
    seen.add(url);
    out.push(citation);
  }
  return out;
}

/**
 * Citations from an LLM Scraper response.
 *
 * `result.sources` is the deduplicated set the answer cited; `items[].sources`
 * repeats the same entries. `search_results` is deliberately absent from this
 * list — see the note at the top of the file.
 */
function citationsFromScraper(raw) {
  const result = firstResult(raw);
  if (!result) return [];
  return collect([
    ...asArray(result.sources),
    ...asArray(result.items).flatMap((item) => asArray(item?.sources)),
  ]);
}

/** Citations from a Google SERP response — references hang off the AI block. */
function citationsFromGoogle(raw) {
  const result = firstResult(raw);
  if (!result) return [];

  const sources = [];
  const walk = (node) => {
    if (!node) return;
    for (const ref of asArray(node.references)) sources.push(ref);
    for (const ref of asArray(node.sources)) sources.push(ref);
    for (const child of asArray(node.items)) walk(child);
  };
  for (const item of asArray(result.items)) walk(item);
  return collect(sources);
}

/**
 * The queries the model actually ran, when the provider exposes them.
 *
 * DataForSEO calls these `fan_out_queries`. Returns an empty array when absent —
 * and never falls back to echoing the prompt, which would look like evidence of
 * a search that may not have happened.
 */
function fanOutQueries(raw) {
  const result = firstResult(raw);
  return asArray(result?.fan_out_queries)
    .filter((q) => typeof q === 'string' && q.trim())
    .map((q) => q.trim());
}

/**
 * Brand entities, where the provider identifies them itself.
 *
 * DataForSEO's ChatGPT scraper returns `brand_entities`. Used only to
 * corroborate our own name matching, never as the sole signal: it is their
 * extraction, with their own recall characteristics, and a brand absent from it
 * has not been proven absent from the answer.
 */
function brandEntities(raw) {
  const result = firstResult(raw);
  return asArray(result?.brand_entities)
    .map((b) => (typeof b === 'string' ? b : b?.name))
    .filter((name) => typeof name === 'string' && name.trim())
    .map((name) => name.trim());
}

module.exports = {
  asArray,
  firstResult,
  textFromScraper,
  textFromGoogle,
  citationsFromScraper,
  citationsFromGoogle,
  fanOutQueries,
  brandEntities,
  toCitation,
};
