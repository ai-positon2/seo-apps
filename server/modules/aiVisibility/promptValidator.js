// ── Enforcing in code what 0016 only asked the model to do ──────────────────
//
// Pure. The generator's system prompt has always said "do not name the
// brand, except in a comparison" — but nothing in code ever checked, and the
// deterministic templates violated the rule themselves. This file is the
// enforcement: a brand-name guard, a near-duplicate check, and a shape check,
// run over every candidate before it reaches the database.

const lifecycle = require('./promptLifecycle');

const MAX_WORDS = 25;

// Generic industry words a brand name often contains but that do not, on
// their own, identify the brand — "Dental" in "Gentle Dental" must not make
// every prompt containing the word "dental" read as a brand mention.
const GENERIC_WORDS = new Set([
  'the', 'and', 'of', 'inc', 'llc', 'co', 'company', 'corp', 'corporation',
  'group', 'associates', 'partners', 'center', 'centre', 'clinic', 'clinics',
  'dental', 'dentist', 'dentistry', 'law', 'firm', 'office', 'offices',
  'care', 'health', 'healthcare', 'services', 'service', 'medical', 'practice',
]);

function tokenize(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The brand-detection profile for one build. A token or phrase found in a
 * candidate means "this reads as the brand". Tokens shared with a competitor
 * name are subtracted — a similarly-named competitor must not get an
 * innocent prompt rejected just because it echoes a syllable of the brand.
 *
 * `strength` tells the caller how much to trust the guard: 'strict' when
 * distinctive tokens survive, 'weak' when only the full phrase is left (a
 * brand name that is entirely generic words), 'none' when there is no brand
 * name at all.
 */
function brandTokens(brand, competitors = []) {
  const name = String(brand?.name || '').trim();
  const nameTokens = tokenize(name).filter((t) => t.length > 1);
  const distinctive = nameTokens.filter((t) => !GENERIC_WORDS.has(t));

  const competitorTokens = new Set();
  for (const c of competitors) {
    for (const t of tokenize(c?.name || '')) competitorTokens.add(t);
  }

  const tokens = new Set(distinctive.filter((t) => !competitorTokens.has(t)));

  for (const alias of brand?.aliases || []) {
    for (const t of tokenize(alias)) {
      if (t.length > 1 && !GENERIC_WORDS.has(t) && !competitorTokens.has(t)) tokens.add(t);
    }
  }

  // De-spaced name and domain stem catch "GentleDental"-style concatenations
  // of a MULTI-word name — guarded against GENERIC_WORDS too, or a one-word
  // brand made entirely of a generic industry term (e.g. a client literally
  // named "Dental") would smuggle that word back in as a token here even
  // though the check above just filtered it out for being generic.
  const deSpaced = name.replace(/\s+/g, '').toLowerCase();
  if (deSpaced.length > 2 && !GENERIC_WORDS.has(deSpaced) && !competitorTokens.has(deSpaced)) tokens.add(deSpaced);

  const domainStem = String(brand?.domain || '').split('.')[0].toLowerCase();
  if (domainStem.length > 2 && !GENERIC_WORDS.has(domainStem) && !competitorTokens.has(domainStem)) tokens.add(domainStem);

  const phrases = name ? [name.toLowerCase()] : [];
  const strength = tokens.size > 0 ? 'strict' : (phrases.length ? 'weak' : 'none');

  return { tokens, phrases, strength };
}

function matchesBrand(text, brandTokenInfo) {
  const lower = String(text || '').toLowerCase();
  for (const phrase of brandTokenInfo.phrases) {
    if (phrase && new RegExp(`\\b${escapeRegex(phrase)}\\b`).test(lower)) return true;
  }
  const words = tokenize(lower);
  return words.some((w) => brandTokenInfo.tokens.has(w));
}

// ── Shape ────────────────────────────────────────────────────────────────

const URL_RE = /https?:\/\/|www\./i;
const EMAIL_RE = /[\w.+-]+@[\w-]+\.[a-z]{2,}/i;
const MARKDOWN_RE = /[*_#`[\]]/;
const LIST_NUMBER_RE = /^\s*\d+[.)]\s+/;
// A question is either shaped like one (starts with a wh-word/auxiliary or
// ends in '?') or a plain keyword phrase (2-12 tokens). Real ChatGPT prompts
// are frequently noun phrases ("best invisalign provider boston"), so a
// question mark is never required — an over-tight shape rule silently kills
// whole batches, which is worse than accepting a slightly loose prompt.
const QUESTION_START_RE = /^(what|how|why|which|who|where|when|is|are|does|can|should|do)\b/i;

function shapeOk(text) {
  if (URL_RE.test(text)) return false;
  if (EMAIL_RE.test(text)) return false;
  if (/[\r\n]/.test(text)) return false;
  if (MARKDOWN_RE.test(text)) return false;
  if (LIST_NUMBER_RE.test(text)) return false;
  if (/^["'].*["']$/.test(text.trim())) return false;
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  const looksLikeQuestion = QUESTION_START_RE.test(text.trim()) || text.trim().endsWith('?');
  const looksLikeKeywordPhrase = wordCount >= 2 && wordCount <= 12;
  return looksLikeQuestion || looksLikeKeywordPhrase;
}

/**
 * @param {{text: string, slot?: string}} candidate
 * @param {object} opts
 * @param {object} opts.brandTokenInfo  from brandTokens()
 * @param {boolean} opts.allowBrand     true for comparison/navigational_alternatives
 * @returns {{ok: boolean, code: string|null, reason: string|null, text: string}}
 */
function validateOne(candidate, { brandTokenInfo, allowBrand }) {
  const text = String(candidate?.text || '').trim();
  if (!text) return { ok: false, code: 'empty', reason: 'Empty text.', text };
  if (text.length < lifecycle.MIN_PROMPT_CHARS) {
    return { ok: false, code: 'too_short', reason: `Shorter than ${lifecycle.MIN_PROMPT_CHARS} characters.`, text };
  }
  if (text.length > lifecycle.MAX_PROMPT_CHARS) {
    return { ok: false, code: 'too_long', reason: `Longer than ${lifecycle.MAX_PROMPT_CHARS} characters.`, text };
  }
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  if (wordCount > MAX_WORDS) {
    return { ok: false, code: 'too_many_words', reason: `${wordCount} words — not a plausible single query.`, text };
  }
  if (!shapeOk(text)) {
    return { ok: false, code: 'bad_shape', reason: 'Not shaped like a question or search query.', text };
  }
  if (!allowBrand && matchesBrand(text, brandTokenInfo)) {
    return { ok: false, code: 'brand_leak', reason: 'Names the brand, so it proves nothing about whether an engine finds you.', text };
  }
  return {
    ok: true, code: null, reason: null, text,
  };
}

// ── Near-duplicate detection ─────────────────────────────────────────────
//
// Token-set Jaccard with an inverted index, plus exact-on-normalised and a
// strict-containment rule. Three worked cases this is pinned against (see the
// test file): "best dental implants boston" vs "best dental implant boston"
// → 1.0, reject (stemming makes them identical); vs "dental implants cost
// boston" → 0.60, KEEP (different intent — cost is a real distinction); vs
// "best dental implants boston cost" → containment, reject regardless of
// score. "best" is deliberately NOT stripped — it carries commercial-intent
// signal that the second example above depends on to stay below threshold.

const DUP_STOPWORDS = new Set(['the', 'a', 'an', 'is', 'are', 'of', 'for', 'in', 'on', 'to', 'and']);

function stem(word) {
  return word.length > 3 && word.endsWith('s') ? word.slice(0, -1) : word;
}

function tokenSet(text) {
  return new Set(tokenize(text).filter((w) => w.length > 2 && !DUP_STOPWORDS.has(w)).map(stem));
}

function jaccard(a, b) {
  if (!a.size && !b.size) return 1;
  let intersection = 0;
  for (const x of a) if (b.has(x)) intersection += 1;
  const union = a.size + b.size - intersection;
  return union ? intersection / union : 0;
}

/** An inverted index over a set of existing prompt texts, so a candidate is
 *  only compared against prompts sharing at least one token — this matters
 *  for the STORED set, which grows over a project's life. */
function makeIndex(texts = []) {
  const byToken = new Map();
  const items = [];
  function add(text) {
    const item = { text, norm: lifecycle.normalise(text), set: tokenSet(text) };
    items.push(item);
    for (const t of item.set) {
      if (!byToken.has(t)) byToken.set(t, []);
      byToken.get(t).push(item);
    }
    return item;
  }
  for (const t of texts) add(t);
  return { add, items, byToken };
}

function isNearDuplicate(text, index, { threshold = 0.72 } = {}) {
  const norm = lifecycle.normalise(text);
  for (const item of index.items) {
    if (item.norm === norm) return {
      dup: true, against: item.text, score: 1, rule: 'exact',
    };
  }

  const set = tokenSet(text);
  const candidates = new Set();
  for (const t of set) {
    for (const item of index.byToken.get(t) || []) candidates.add(item);
  }

  let best = null;
  for (const item of candidates) {
    const smaller = set.size <= item.set.size ? set : item.set;
    const larger = set.size <= item.set.size ? item.set : set;
    if (smaller.size >= 3) {
      let contained = true;
      for (const x of smaller) { if (!larger.has(x)) { contained = false; break; } }
      if (contained) return {
        dup: true, against: item.text, score: 1, rule: 'containment',
      };
    }
    const score = jaccard(set, item.set);
    if (!best || score > best.score) best = { item, score };
  }

  if (best && best.score >= threshold) {
    return {
      dup: true, against: best.item.text, score: best.score, rule: 'jaccard',
    };
  }
  return {
    dup: false, against: null, score: best ? best.score : 0, rule: null,
  };
}

// ── Batch ────────────────────────────────────────────────────────────────

// Naming the brand is only ever legal in a head-to-head question, and nothing
// generates those now. Kept as an explicit per-candidate flag so a future
// generator has to opt in deliberately, rather than inherit the exemption from
// a slot name it happened to be carrying.

/**
 * Validates a batch of generated candidates against shape, the brand guard,
 * and near-duplication — both within the batch and against `existing`
 * (which must include retired/rejected texts: a prompt a human deliberately
 * retired should not be silently regenerated).
 *
 * @param {Array<{text, slot, source, sourceRef, intent, ...}>} candidates
 * @param {object} opts
 * @param {object} opts.brand
 * @param {Array}  opts.competitors
 * @param {string[]} [opts.existing]
 * @returns {{
 *   accepted: Array, rejected: Array<{text, code, reason, slot}>,
 *   filledBySlot: Map<string, number>, brandGuard: 'strict'|'weak'|'none'
 * }}
 */
function validateBatch(candidates, { brand, competitors = [], existing = [] } = {}) {
  const brandTokenInfo = brandTokens(brand, competitors);
  const index = makeIndex(existing);
  const filledBySlot = new Map();
  const accepted = [];
  const rejected = [];

  for (const candidate of candidates) {
    const allowBrand = candidate.allowBrand === true;
    const shape = validateOne(candidate, { brandTokenInfo, allowBrand });
    if (!shape.ok) {
      rejected.push({
        text: candidate.text, code: shape.code, reason: shape.reason, slot: candidate.slot,
      });
      continue;
    }

    const dup = isNearDuplicate(shape.text, index);
    if (dup.dup) {
      rejected.push({
        text: shape.text,
        code: 'duplicate',
        reason: `Too similar to an existing prompt (${dup.rule}, score ${dup.score.toFixed(2)}): "${dup.against}"`,
        slot: candidate.slot,
      });
      continue;
    }

    index.add(shape.text);
    accepted.push({ ...candidate, text: shape.text });
    filledBySlot.set(candidate.slot || null, (filledBySlot.get(candidate.slot || null) || 0) + 1);
  }

  return {
    accepted, rejected, filledBySlot, brandGuard: brandTokenInfo.strength,
  };
}

module.exports = {
  brandTokens,
  matchesBrand,
  shapeOk,
  validateOne,
  tokenSet,
  jaccard,
  makeIndex,
  isNearDuplicate,
  validateBatch,
};
