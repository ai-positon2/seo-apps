// ── Finding brands in an answer ─────────────────────────────────────────────
//
// Pure, and deliberately deterministic-first (METRICS.md §2.1): the alias
// matcher decides what was named, and the LLM pass only confirms, scores
// sentiment and flags negation. A model deciding membership on its own would
// make the headline number unreproducible.
//
// Normalisation here is LENGTH-PRESERVING on purpose. `char_offset` is what
// `ordinal` is derived from, and ordinal is the number §3.5 reports as
// "position" — so an offset that drifted from the original string would
// silently reorder the brands. Curly quotes, dashes and case all map 1:1;
// nothing that changes length (NFKC folding, markdown stripping) is applied to
// the string offsets are taken against.

const CURLY = /[‘’‚‛]/g;         // ' ' ‚ ‛
const DQUOTE = /[“”„‟]/g;        // " " „ ‟
const DASHES = /[‐-―−]/g;             // ‐ ‑ ‒ – — ― −
const NBSP = /[   ]/g;

/** Lowercase and fold punctuation variants, WITHOUT changing string length. */
function normaliseKeepingLength(text) {
  const original = String(text || '');
  const folded = original
    .replace(CURLY, "'")
    .replace(DQUOTE, '"')
    .replace(DASHES, '-')
    .replace(NBSP, ' ');
  const lowered = folded.toLowerCase();
  // toLowerCase is NOT always length-preserving: U+0130 (İ) lowercases to two
  // code units. char_offset is what ordinal derives from and ordinal is what
  // §3.5 reports as position, so a single such character in an answer would
  // shift every offset after it. Keep the case rather than the invariant.
  return lowered.length === folded.length ? lowered : folded;
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Spans that are citations or code, not prose mentions (§2.1 rule 3).
 *
 * A brand named only inside a URL has not been recommended — it has been
 * linked. Counting it would turn every cited domain into a mention and make
 * visibility and share of voice agree by construction.
 */
function excludedSpans(text) {
  const spans = [];
  const push = (re) => {
    let m;
    const rx = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
    // eslint-disable-next-line no-cond-assign
    while ((m = rx.exec(text)) !== null) {
      spans.push([m.index, m.index + m[0].length]);
      if (m[0].length === 0) rx.lastIndex += 1;
    }
  };
  push(/https?:\/\/\S+/g);            // bare URLs
  push(/\]\([^)]*\)/g);               // markdown link targets
  push(/`[^`]*`/g);                   // inline code
  push(/```[\s\S]*?```/g);            // fenced code
  push(/\b[\w.+-]+@[\w-]+\.[a-z]{2,}\b/gi); // emails
  return spans;
}

const inSpan = (spans, at, end) => spans.some(([s, e]) => at >= s && end <= e);

/** Does `needle` appear in `hay` on both-side word boundaries? */
function hasWholeWord(hay, needle) {
  if (!needle) return false;
  const rx = new RegExp(
    `(^|[^\\p{L}\\p{N}])${escapeRegex(needle)}(?=[^\\p{L}\\p{N}]|$)`, 'u',
  );
  return rx.test(hay);
}

/**
 * Every match of one alias, as [start, end] pairs, on word boundaries.
 *
 * Word boundaries are Unicode-aware rather than \b: \b is ASCII-only, so a
 * brand ending in an accented character would match inside a longer word.
 */
function findAlias(haystack, alias, excluded) {
  const needle = normaliseKeepingLength(alias);
  if (!needle.trim()) return [];
  const rx = new RegExp(`(^|[^\\p{L}\\p{N}])(${escapeRegex(needle)})(?=[^\\p{L}\\p{N}]|$)`, 'giu');
  const out = [];
  let m;
  // eslint-disable-next-line no-cond-assign
  while ((m = rx.exec(haystack)) !== null) {
    const start = m.index + m[1].length;
    const end = start + m[2].length;
    if (!inSpan(excluded, start, end)) out.push([start, end]);
    rx.lastIndex = end;
  }
  return out;
}

/**
 * Which brands an answer names, with ordinal, offset and count.
 *
 * @param {object} input
 * @param {string} input.answerText
 * @param {Array}  input.brands      [{ id, name, aliases[], isClient, domain }]
 * @param {Array}  [input.mapCards]  from a map answer — the card ORDER is the
 *   ordinal, which is truer than a character offset into surrounding prose
 * @returns {Array} [{ brandId, name, isClient, ordinal, charOffset,
 *   mentionCount, evidence, source }]
 */
function extractMentions({ answerText, brands = [], mapCards = [] } = {}) {
  const original = String(answerText || '');
  if (!original.trim() || !brands.length) return [];

  const hay = normaliseKeepingLength(original);
  const excluded = excludedSpans(hay);

  // Longest alias first, so a specific brand claims a span before a shorter
  // name nested inside it can ("Aspen Dental Care Group" before "Aspen").
  const candidates = [];
  for (const brand of brands) {
    const aliases = [...new Set([brand.name, ...(brand.aliases || [])].filter(Boolean))]
      .sort((a, b) => b.length - a.length);
    for (const alias of aliases) {
      for (const [start, end] of findAlias(hay, alias, excluded)) {
        candidates.push({
          brand, alias, start, end, len: end - start,
        });
      }
    }
  }

  // Resolve overlaps: the longest match at a position wins, so a brand whose
  // name is a substring of another brand's does not steal the mention.
  candidates.sort((a, b) => b.len - a.len || a.start - b.start);
  const taken = [];
  const kept = [];
  for (const c of candidates) {
    if (taken.some(([s, e]) => c.start < e && c.end > s)) continue;
    taken.push([c.start, c.end]);
    kept.push(c);
  }

  // Fold to one row per brand: first offset wins, occurrences counted.
  const byBrand = new Map();
  for (const c of kept) {
    const existing = byBrand.get(c.brand.id);
    if (existing) {
      existing.mentionCount += 1;
      if (c.start < existing.charOffset) existing.charOffset = c.start;
      continue;
    }
    byBrand.set(c.brand.id, {
      brandId: c.brand.id,
      name: c.brand.name,
      isClient: Boolean(c.brand.isClient),
      charOffset: c.start,
      mentionCount: 1,
      // Verbatim from the ORIGINAL string, so §2.1's anti-hallucination guard
      // ("evidence must be a literal substring of answer_text") holds.
      evidence: original.slice(Math.max(0, c.start - 60), Math.min(original.length, c.end + 60)).trim(),
      source: 'text',
    });
  }

  // A map answer's card order is the real ranking. Where a brand appears as a
  // card, that position overrides any prose offset — a business listed first
  // in the map is named first, whatever the surrounding text does.
  const cardOrdinalByBrand = new Map();
  // The highest card position seen, whether or not it belongs to one of our
  // brands. Prose mentions rank AFTER every card, and "after" has to mean
  // after the cards that exist — not after the ones we happened to match.
  let maxCardPosition = 0;
  for (const card of mapCards || []) {
    if (Number.isFinite(card?.position)) {
      maxCardPosition = Math.max(maxCardPosition, card.position);
    }
    const cardName = normaliseKeepingLength(card?.name);
    if (!cardName.trim()) continue;
    for (const brand of brands) {
      if (cardOrdinalByBrand.has(brand.id)) continue;
      const forms = [brand.name, ...(brand.aliases || [])].filter(Boolean).map(normaliseKeepingLength);
      // Whole-word containment, not raw `includes`. A generic alias like
      // "dental" matched every card on the page as a substring, handing an
      // unrelated business's rank to the client.
      // A card with no usable position cannot supply an ordinal; leaving it
      // undefined made the final `a.ordinal - b.ordinal` sort NaN, which is
      // implementation-defined ordering for the whole result.
      if (!Number.isFinite(card?.position)) continue;
      if (forms.some((f) => f && (cardName === f || hasWholeWord(cardName, f)))) {
        cardOrdinalByBrand.set(brand.id, card.position);
        if (!byBrand.has(brand.id)) {
          byBrand.set(brand.id, {
            brandId: brand.id,
            name: brand.name,
            isClient: Boolean(brand.isClient),
            charOffset: null,
            mentionCount: 1,
            evidence: card.name,
            source: 'map_card',
          });
        } else {
          byBrand.get(brand.id).source = 'map_card';
        }
      }
    }
  }

  const rows = [...byBrand.values()];

  // Ordinal: card position where there is one, otherwise rank by first offset.
  const byOffset = rows
    .filter((r) => !cardOrdinalByBrand.has(r.brandId))
    .sort((a, b) => (a.charOffset ?? Infinity) - (b.charOffset ?? Infinity));

  // Rank prose mentions after the LAST card, not after the number of cards we
  // recognised. With 32 cards and one of ours at position 30, numbering from
  // the matched count gave a prose-only brand ordinal 2 — ranking it above a
  // brand the engine actually listed 30th, and feeding both into §3.5's mean
  // position as if they were the same scale.
  byOffset.forEach((r, i) => { r.ordinal = maxCardPosition + i + 1; });
  for (const r of rows) {
    if (cardOrdinalByBrand.has(r.brandId)) r.ordinal = cardOrdinalByBrand.get(r.brandId);
  }

  return rows.sort((a, b) => a.ordinal - b.ordinal);
}

module.exports = {
  normaliseKeepingLength, excludedSpans, findAlias, extractMentions,
};
