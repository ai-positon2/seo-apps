// ── Primary keyword relevance check (Claude Sonnet) ─────────────────────────
// The wizard's keyword adapter (keywordAdapter.js) picks Primary/Secondary by
// raw SEMrush volume alone. That regularly promotes keywords that are
// off-location (a bigger-market competitor's own city bleeding through), not
// real search phrases at all (a bare domain SEMrush attributes volume to),
// or simply generic (no location mentioned at all) ahead of correctly-scoped
// candidates already sitting in the same pool.
//
// Primary specifically has a hard rule: every entry must literally name both
// the service and the location — "is topically relevant" isn't enough (that
// let a generic, non-location-bearing keyword like "dental care for sleep
// apnea" through as Primary). Claude Sonnet reviews the volume-sorted
// proposal plus the full candidate pool (which already includes the
// client's imported keyword-universe rows) and picks replacements that
// satisfy the rule; a deterministic code-side gate enforces it regardless of
// what the model returns, and synthesizes a "{service} {city}"-style
// keyword for any Primary slot nothing in the pool can fill.
//
// Two LLM passes, deliberately separate:
//   1. selectPrimaryAndSecondary — chooses 2 Primary + 10 Secondary from the pool
//   2. reviewSelection           — an independent critic that only judges the picks
// A single call asked to both choose and vouch for its choice reliably
// self-approves, which is why the verdict comes from a fresh call.

const store = require('./store');
const config = require('./config');
const { createLlmClient } = require('../services/llmProviders');
const { chatParams } = require('./llmParams');

// A cache read/write must never be fatal here — see the note on these in
// store.js. Degrade to "recompute" rather than killing keyword research over
// a cache outage.
const { cacheGetSafe, cacheSetSafe } = store;

function serviceWords(service) {
  return String(service || '').toLowerCase().split(/\s+/).filter(w => w.length > 3);
}

// Mechanical, code-enforced gate — not left to the model's judgment — for
// the one rule that must always hold: a Primary keyword names the service
// AND the location.
function isPrimaryEligible(keyword, city, relevanceTerms, service) {
  const lower = String(keyword || '').toLowerCase();
  const hasLocation = !!city && lower.includes(city.toLowerCase().trim());
  const hasService = relevanceTerms?.length
    ? relevanceTerms.some(t => lower.includes(t))
    : serviceWords(service).some(w => lower.includes(w));
  return hasLocation && hasService;
}

// Human-readable list of the place names Secondary may legitimately mention
// (the office's broader region and its state) — everything else geographic is
// a rival location and stays invalid.
function regionClause(regionTerms) {
  const terms = (regionTerms || []).filter(Boolean);
  if (!terms.length) return '';
  return terms.map(t => `"${t}"`).join(' or ');
}

function buildPrompt({ service, city, state, regionTerms, proposedPrimary, proposedSecondary, pool, maxPrimary, maxSecondary }) {
  const poolList = pool.map((k, i) => `${i}. ${k.keyword} | vol:${k.volume || 0}`).join('\n');
  const allowed = regionClause(regionTerms);
  const schemaHint = `{
  "primary": ["string", ...exactly ${maxPrimary}],
  "secondary": ["string", ...up to ${maxSecondary}],
  "rejected": [{ "keyword": "string", "reason": "string" }]
}`;
  const system = `You vet keyword picks for a single Location+Service landing page: "${service}" in ${city}, ${state}.
HARD RULE for "primary" specifically: every primary keyword MUST literally name both the service and ${city} (or ${city}, ${state}) — a generic, non-location-bearing keyword (e.g. just "${service}") is INVALID for primary even if it's on-topic.
A candidate (primary or secondary) is also INVALID if it:
- names a different city/town than ${city} (e.g. a bigger-market competitor's own city bleeding into this pool),
- is a bare domain/URL, brand name, or otherwise not a real search phrase a person would type,
- is off-topic for "${service}".
${allowed ? `BROADER-REGION EXCEPTION (secondary only): a secondary keyword MAY name ${allowed} — that is this office's own broader region/state, not a rival location, and it is legitimate reach for this page. Primary still requires ${city} itself.` : ''}
Respond ONLY with JSON matching this schema (no prose, no markdown):
${schemaHint}
Rules:
- Start from the proposed primary/secondary lists. Keep every candidate that is valid (primary additionally needs the location named explicitly).
- Replace each INVALID primary candidate with the best still-unused pool keyword that names both the service and ${city} (prefer higher volume among valid options). If no such replacement exists in the pool, leave that primary slot out — it will be filled deterministically elsewhere, don't guess.
- Replace each INVALID secondary candidate similarly (secondary does not require an explicit location mention, only topical/geo validity). If no valid replacement exists, drop it rather than keep an invalid one.
- "secondary" should be topically related keywords, up to ${maxSecondary} entries.
- List every candidate you rejected (from the original proposed lists) in "rejected" with a short reason.
- Never invent a keyword that isn't in the proposed lists or the extended pool.`;

  const user = `Proposed primary: ${JSON.stringify(proposedPrimary)}
Proposed secondary: ${JSON.stringify(proposedSecondary)}

Extended pool (index | keyword | volume):
${poolList}

Return JSON only.`;

  return { system, user };
}

// ── Step 3: independent review of the selection (second LLM pass) ───────────
// A fresh critic that sees ONLY the final picks plus the rules — not the pool,
// not the volume ordering, not its own earlier reasoning.
function buildReviewPrompt({ service, city, state, regionTerms, primary, secondary }) {
  const allowed = regionClause(regionTerms);
  const system = `You are reviewing a finished keyword selection for a single Location+Service landing page: "${service}" in ${city}, ${state}. Judge it against the rules; do not propose replacements.
RULES
- Every PRIMARY keyword must literally name both the service and ${city}. A keyword that omits ${city} fails, even if on-topic.
- No keyword may name a different city/town than ${city}.
${allowed ? `- EXCEPTION (secondary only): naming ${allowed} is allowed — that is this office's own broader region/state, not a rival location.` : ''}
- No keyword may be a bare domain/URL, a brand name, or anything that isn't a real search phrase a person would type.
- No keyword may be off-topic for "${service}".
- SECONDARY keywords must be topically related to "${service}".
Respond ONLY with JSON (no prose, no markdown):
{ "ok": boolean, "failures": [{ "keyword": "string", "slot": "primary" | "secondary", "reason": "string" }] }
Set "ok" to true only when EVERY keyword in both lists passes every rule. List one entry in "failures" per failing keyword, naming which slot it came from. If nothing fails, "failures" must be an empty array.`;

  const user = `Primary: ${JSON.stringify(primary.map(c => c.keyword))}
Secondary: ${JSON.stringify(secondary.map(c => c.keyword))}

Return JSON only.`;

  return { system, user };
}

// Returns { ok, failures: [{ keyword, slot, reason }] }.
// Fails OPEN: an LLM outage must not block keyword research, so an error or
// unparseable response is treated as "no objection" rather than a rejection.
async function reviewSelection({ service, city, state, regionTerms, primary, secondary }) {
  if (!primary.length && !secondary.length) return { ok: true, failures: [] };

  // regionTerms changes the rules the critic applies, so it belongs in the key.
  const cacheK = store.cacheKey(
    'dental-kw-review-v2', service, city, state, (regionTerms || []).slice().sort(),
    primary.map(c => c.keyword).sort(), secondary.map(c => c.keyword).sort(),
  );
  const cached = await cacheGetSafe(cacheK, config.cache.llmTtlMs);
  if (cached) return cached;

  const { system, user } = buildReviewPrompt({ service, city, state, regionTerms, primary, secondary });

  let parsed = null;
  try {
    const llm = createLlmClient(config.llm.generationModel);
    for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
      const completion = await llm.chat.completions.create({
        model: llm.model,
        ...chatParams(llm.model, { maxTokens: 4000 }),
        response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      });
      try {
        const raw = JSON.parse(completion.choices[0].message.content);
        if (raw && typeof raw.ok === 'boolean') parsed = raw;
      } catch { /* retry once on schema-invalid output */ }
    }
  } catch (e) {
    console.error('[keywordRelevance] review pass failed, accepting selection as-is:', e.message);
    return { ok: true, failures: [] };
  }
  if (!parsed) return { ok: true, failures: [] };

  // Re-derive `ok` from the failures list rather than trusting the flag — the
  // model has been observed setting ok:true while still listing failures.
  const failures = (Array.isArray(parsed.failures) ? parsed.failures : [])
    .filter(f => f && f.keyword)
    .map(f => ({
      keyword: String(f.keyword),
      slot: f.slot === 'primary' ? 'primary' : 'secondary',
      reason: String(f.reason || 'unspecified'),
    }));
  const result = { ok: !failures.length, failures };
  await cacheSetSafe(cacheK, result, { kind: 'llm', ttlMs: config.cache.llmTtlMs });
  return result;
}

// candidates: full volume-sorted KeywordCandidate[] from keywordAdapter.
// relevanceTerms: this service's topical substrings (keywordUniverseMap.js), or null.
// regionTerms: place names Secondary may legitimately mention (region + state).
// Returns { primary, secondary, rejected, reviewFailures, lowVolume }.
// `lowVolume` is true when Primary is the synthesized "{service} {city}" pair
// rather than real discovered keywords — the UI MUST say searches are low.
async function selectPrimaryAndSecondary({ service, city, state, region, candidates, relevanceTerms, regionTerms }) {
  const maxPrimary = config.keywords.maxPrimary;
  const maxSecondary = config.keywords.maxSecondary;
  const eligible = c => isPrimaryEligible(c.keyword, city, relevanceTerms, service);
  const allowedRegion = regionTerms || [region, state].filter(Boolean);
  const withLowVolume = r => ({ ...r, lowVolume: r.primary.some(c => c.source === 'synthesized') });

  const proposedPrimary = candidates.slice(0, maxPrimary).map(c => c.keyword);
  const proposedSecondary = candidates.slice(maxPrimary, maxPrimary + maxSecondary).map(c => c.keyword);

  // Primary is eligibility-filtered, so a positional slice for Secondary would
  // re-list the same keywords (the LLM path dedupes via usedKeys; this path has
  // to do it explicitly). Exclude whatever Primary took.
  const fallbackPrimary = candidates.filter(eligible).slice(0, maxPrimary);
  const fallbackPrimaryKeys = new Set(fallbackPrimary.map(c => c.keyword.toLowerCase()));
  const fallback = {
    primary: fallbackPrimary,
    secondary: candidates
      .filter(c => !fallbackPrimaryKeys.has(c.keyword.toLowerCase()))
      .slice(0, maxSecondary),
    rejected: [],
    reviewFailures: [],
  };
  fillPrimaryFromSynthetic({
    primary: fallback.primary,
    usedKeys: new Set(fallback.primary.map(c => c.keyword.toLowerCase())),
    service, city, state, maxPrimary,
  });
  if (!candidates.length) return withLowVolume(fallback);

  // v7: bumped after keywordizeService changed the synthesized keywords a
  // cached result can contain ("cavity prevention (curodont) manchester" ->
  // "cavity prevention manchester"), and after a flagged Primary began
  // replacing only its own slot instead of the whole list. v6 added the region
  // exception, the second review pass, and the lowVolume flag.
  const cacheK = store.cacheKey('dental-kw-primary-check-v7', service, city, state, allowedRegion, candidates.map(c => c.keyword).sort());
  const cached = await cacheGetSafe(cacheK, config.cache.llmTtlMs);
  if (cached) return cached;

  // Extended pool for replacements — everything beyond the proposed lists,
  // capped to keep the prompt bounded.
  const pool = candidates.slice(0, config.llm.maxKeywordsToClassify);
  const { system, user } = buildPrompt({ service, city, state, regionTerms: allowedRegion, proposedPrimary, proposedSecondary, pool, maxPrimary, maxSecondary });

  let parsed = null;
  try {
    const llm = createLlmClient(config.llm.generationModel);
    for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
      const completion = await llm.chat.completions.create({
        model: llm.model,
        // Budget generously: a tight cap makes Claude spend its whole budget
        // reasoning and return finish_reason:"length" with empty content
        // (see the same note in contentGenerator.js).
        ...chatParams(llm.model, { maxTokens: 8000 }),
        response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      });
      try {
        const raw = JSON.parse(completion.choices[0].message.content);
        if (raw && Array.isArray(raw.primary) && Array.isArray(raw.secondary)) parsed = raw;
      } catch { /* retry once on schema-invalid output */ }
    }
  } catch (e) {
    // LLM unavailable/misconfigured — fall back to the raw volume sort
    // rather than blocking keyword research entirely.
    console.error('[keywordRelevance] Claude Sonnet primary check failed, falling back to volume sort:', e.message);
    return withLowVolume(fallback);
  }
  if (!parsed) return withLowVolume(fallback);

  const byKeyword = new Map(candidates.map(c => [c.keyword.toLowerCase(), c]));
  const resolve = (kw) => byKeyword.get(String(kw || '').toLowerCase());
  // The model doesn't reliably keep "secondary" consistent with its own
  // "rejected" verdicts (it has echoed a keyword in both) — re-derive
  // validity in code instead of trusting the raw list.
  const rejected = Array.isArray(parsed.rejected) ? parsed.rejected : [];
  const rejectedKeys = new Set(rejected.map(r => String(r.keyword || '').toLowerCase()));
  const toCandidates = (list, max, { requirePrimaryEligible = false } = {}) => {
    const out = [];
    const used = new Set();
    for (const kw of list) {
      const key = String(kw || '').toLowerCase();
      if (rejectedKeys.has(key) || used.has(key)) continue;
      const c = resolve(kw);
      if (!c) continue;
      // Same hard gate applied to whatever the model proposes — never trust
      // "the model said it's fine" for the one rule that must always hold.
      if (requirePrimaryEligible && !eligible(c)) continue;
      used.add(key);
      out.push(c);
      if (out.length >= max) break;
    }
    return out;
  };

  const primary = toCandidates(parsed.primary, maxPrimary, { requirePrimaryEligible: true });
  const usedKeys = new Set(primary.map(c => c.keyword.toLowerCase()));
  const secondary = toCandidates(parsed.secondary.filter(kw => !usedKeys.has(String(kw || '').toLowerCase())), maxSecondary);

  // The discovered pool won't always contain enough valid, location-bearing
  // candidates to fill Primary (a thin/heavily-filtered pool, e.g. a niche
  // service in a small market) — Primary must still carry the page's actual
  // service+location, even at 0 volume, rather than come up short.
  fillPrimaryFromSynthetic({ primary, usedKeys, service, city, state, maxPrimary });

  // ── Step 3 + 4: review the selection, then act on the verdict ─────────────
  // Synthesized entries are deterministic by construction: there is nothing
  // better to swap them for, so sending them to the critic only wastes a call
  // and produces a self-contradictory result (it rejects "invisalign
  // brookline" as not a real search phrase, and the only replacement
  // available is "invisalign brookline"). Review discovered keywords only.
  const discoveredPrimary = primary.filter(c => c.source !== 'synthesized');
  const review = await reviewSelection({
    service, city, state, regionTerms: allowedRegion,
    primary: discoveredPrimary, secondary,
  });

  // Discard any verdict naming a keyword that was never submitted. The critic
  // can echo a keyword it wasn't shown (or mislabel which slot one came from),
  // and acting on that churns Primary — dropping an entry only for
  // fillPrimaryFromSynthetic to re-add it in a different order. Same
  // philosophy as the Primary eligibility gate: re-derive in code, never
  // trust the model's bookkeeping.
  const submitted = new Set(
    [...discoveredPrimary, ...secondary].map(c => c.keyword.toLowerCase()),
  );
  const failures = review.failures.filter(f => submitted.has(f.keyword.toLowerCase()));

  // A flagged SECONDARY is simply dropped — it's supplementary reach.
  const secondaryFailed = new Set(
    failures.filter(f => f.slot === 'secondary').map(f => f.keyword.toLowerCase()),
  );
  const reviewedSecondary = secondary.filter(c => !secondaryFailed.has(c.keyword.toLowerCase()));

  // A flagged PRIMARY is dropped and its slot refilled from the deterministic
  // "{service} {city}" pair at zero volume. Only the flagged entries go — a
  // keyword the critic passed is real, location-bearing demand and keeping it
  // beats replacing it with a zero-volume synonym. lowVolume then drives the
  // explicit "searches are low" notice in the wizard.
  const primaryFailed = new Set(
    failures.filter(f => f.slot === 'primary').map(f => f.keyword.toLowerCase()),
  );
  const finalPrimary = primary.filter(c => !primaryFailed.has(c.keyword.toLowerCase()));
  fillPrimaryFromSynthetic({
    primary: finalPrimary,
    usedKeys: new Set(finalPrimary.map(c => c.keyword.toLowerCase())),
    service, city, state, maxPrimary,
  });

  const result = withLowVolume({
    primary: finalPrimary,
    secondary: reviewedSecondary,
    rejected,
    reviewFailures: failures,
  });
  await cacheSetSafe(cacheK, result, { kind: 'llm', ttlMs: config.cache.llmTtlMs });
  return result;
}

// Service names carry punctuation that never appears in a search query:
// "Crowns & Bridges", "Cavity Prevention (Curodont)", "TMD/TMJ Treatment",
// "Diabetes & Oral Health", "Partial & Full Dentures". Dropped straight into a
// synthesized keyword they produce "cavity prevention (curodont) manchester",
// which is what the SEO team then sees as the page's stated Primary target.
// (The QC gates themselves strip punctuation, so this is keyword quality, not
// a failing page.) Normalize to something a person could plausibly type.
function keywordizeService(service) {
  return String(service || '')
    .replace(/\([^)]*\)/g, ' ')   // drop parentheticals: "(Curodont)"
    .replace(/&/g, ' and ')        // "Crowns & Bridges" -> "crowns and bridges"
    .replace(/[\/]/g, ' ')         // "TMD/TMJ" -> "tmd tmj"
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function fillPrimaryFromSynthetic({ primary, usedKeys, service, city, state, maxPrimary }) {
  const svc = keywordizeService(service);
  const synthetic = [
    `${svc} ${city}`.trim(),
    `${svc} ${city} ${state}`.trim(),
  ].map(kw => kw.toLowerCase());

  for (const kw of synthetic) {
    if (primary.length >= maxPrimary) break;
    if (usedKeys.has(kw)) continue;
    usedKeys.add(kw);
    primary.push({ keyword: kw, volume: 0, difficulty: 0, intent: 'commercial', source: 'synthesized' });
  }
}

module.exports = { selectPrimaryAndSecondary, reviewSelection, isPrimaryEligible, keywordizeService };
