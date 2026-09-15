// ── Content-gap spoke suggestions ────────────────────────────────────────────
// Everything upstream of this file answers "how is the site's EXISTING content
// structured" (clustering, hub selection, diagnostics). This answers a
// different question: what topics does a hub NOT cover yet that it should —
// content the site has never published, not a page it forgot to link to.
//
// Four signals, each independent and gracefully degrading on its own:
//   - real keyword search volume for this domain (SEMrush), filtered to the
//     hub's topic by term overlap
//   - real competitor keyword GAPS (SEMrush) — keywords tracked competitors
//     rank for that this domain doesn't, the same computeKeywordGap the
//     standalone Competitor Research tool uses, just scoped to this hub's
//     topic instead of the whole site
//   - real "People also ask" questions from a live search on the hub's topic
//     (googleSearch.js's Serper path — see that file for why Google's own
//     Custom Search API can't provide this)
//   - the LLM's own reasoning about the competitive landscape, grounded in
//     the above rather than guessing blind
// A single LLM call turns whatever signals came back into a short, ranked,
// human-readable list — same graceful-fallback shape as llmNaming.js: if the
// LLM call fails or no key is configured, the raw signals are still returned
// as a mechanical (unranked-by-AI, but real-data) list rather than nothing.
//
// Every candidate pool is biased toward SPECIFICITY, not raw volume: a head
// term ("dental implants", 450,000/mo) will always outrank a genuinely
// useful long-tail angle ("same-day dental implants recovery time", a
// fraction of the volume) on volume alone, but the head term is usually
// already the hub itself, not a missing spoke. Multi-word phrases are
// preferred first; short head terms only fill remaining slots.
//
// Triggered per-hub, on demand, from the Domains-analogous "Suggested spokes"
// panel — never automatically as part of a full analysis. It spends SEMrush
// units and a search API call, same reasoning as competitor auto-discovery
// (moduleRunners.js) and Competitor Research being their own explicit action.
const { getKeywordsFull } = require('../../services/semrushCA');
const { hasSemrushKey } = require('../competitorAnalysis/provider');
const { computeKeywordGap } = require('../competitorAnalysis/gapAnalysis');
const { searchGoogle } = require('../../services/googleSearch');
const { createLlmClient, DEFAULT_MODEL_ID } = require('../../services/llmProviders');
const { getDatabase } = require('../../utils/countryToDatabase');
const { tokenizeWords, cleanTokens, deriveBrandTokens } = require('./termProfile');
const { titleCase } = require('./clusterEngine');

// OpenAI rather than a hardcoded Claude model — DEFAULT_MODEL_ID is whatever
// this app's other LLM call sites already default to (llmNaming.js's cluster
// naming included), so this only ever needs the ONE key this whole app leans
// on, not a second one (ANTHROPIC_API_KEY) that's frequently left unset. A
// missing LLM key here doesn't error — it silently drops to the mechanical,
// keyword-only fallback below, which reads as "irrelevant, not a real topic"
// exactly because it has no language model behind it at all.
const MODEL = DEFAULT_MODEL_ID;
const MAX_SUGGESTIONS = 8;
// Domain-wide, not per-hub — one fetch's worth of a site's whole keyword
// footprint, then filtered per-hub by term overlap below. Modest limit keeps
// this well under domain_organic's 10-units-per-row cost even at the top of
// its range (unitCosts.js documents the same discipline for discovery.js).
const KEYWORD_FETCH_LIMIT = 150;
// Competitor fetches are per-domain, so this is capped tighter (and to only
// the first few tracked competitors) — 3 competitors x 100 rows x 10 units
// (domain_organic's cost, unitCosts.js) is 3,000 units, on top of 1,500 for
// the domain's own fetch, comparable to what a single Competitor Research
// run already spends per competitor.
const COMPETITOR_FETCH_LIMIT = 100;
const MAX_COMPETITORS_QUERIED = 3;
const MAX_KEYWORD_CANDIDATES = 20;
const MAX_PAA_QUESTIONS = 10;
const MIN_LONGTAIL_WORDS = 3;

function hasLlmKey() {
  const k = process.env.OPENAI_API_KEY;
  return !!k && k !== 'your_openai_api_key_here';
}

function hostOf(domain) {
  return String(domain || '').replace(/^https?:\/\//i, '').replace(/^www\./i, '').split('/')[0];
}

// A keyword is "about" this hub if it shares at least one STEMMED word with
// the hub's own top TF-IDF terms — run through the exact same tokenize+stem
// pipeline termProfile.js used to build those terms in the first place (§32:
// one engine, not a second implementation that drifts). An earlier version
// compared raw prefix strings instead and let unrelated high-volume keywords
// ("bangalore capital of karnataka") through purely because a short raw word
// happened to prefix-match a term — stemmed set overlap doesn't have that
// failure mode. topTerms are themselves space-joined n-grams of stemmed
// words, so splitting on space recovers the individual stemmed words to
// match against.
// Excludes brand/navigational queries ("idfc", "idfc first bank login") —
// someone already knows to search for the site by name; that is not a
// content gap. Same brand-token derivation buildCorpusTermProfiles already
// uses to strip brand noise from clustering.
//
// Also excludes account-management / support intent ("...login", "customer
// care", "toll free number"...) regardless of brand — "milestone credit card
// login" isn't a content gap either, it's someone who already has the
// product looking for the sign-in page. No article closes that gap; it's not
// a topic, it's a UX/support problem. These matter most in the no-LLM
// fallback below, which otherwise has nothing else filtering out non-topics.
const NAVIGATIONAL_TERMS = new Set([
  'login', 'log', 'signin', 'sign', 'logout', 'password', 'otp',
  'helpline', 'toll', 'free', 'complaint', 'complaints', 'grievance',
  'customer', 'care', 'support', 'nearest', 'branch', 'timing', 'timings',
  'download', 'app', 'apk', 'statement', 'balance', 'check',
]);
function isNavigationalKeyword(keyword) {
  const words = cleanTokens(tokenizeWords(keyword));
  return words.some((w) => NAVIGATIONAL_TERMS.has(w));
}

// Exact match only ("idfcfirst") misses shorter brand forms actually used in
// content and search ("idfc") — a multi-word domain SLD like "idfcfirst"
// rarely has a delimiter to split on, so a prefix check (either direction,
// 4+ chars to avoid short-word false positives) catches the common case
// without needing a hand-maintained per-brand alias list.
function isBrandWord(word, brandTokens) {
  if (brandTokens.has(word)) return true;
  if (word.length < 4) return false;
  return [...brandTokens].some((b) => b.length >= 4 && (b.startsWith(word) || word.startsWith(b)));
}

function keywordsRelevantToTopic(keywords, topTerms, domain) {
  const termWords = new Set(topTerms.flatMap((t) => t.split(' ')));
  const brandTokens = deriveBrandTokens(domain);
  return keywords.filter((k) => {
    if (isNavigationalKeyword(k.keyword)) return false;
    const kwWords = cleanTokens(tokenizeWords(k.keyword));
    if (kwWords.some((w) => isBrandWord(w, brandTokens))) return false;
    return kwWords.some((w) => termWords.has(w));
  });
}

// Long-tail (3+ real words) first, each group by volume descending. A raw
// word count would count "in"/"for"/"the" — cleanTokens already strips those,
// so "cost of dental implants without insurance" (5 content words) correctly
// outranks "dental implants" (2) even though the head term has far more
// volume. This is the actual fix for suggestions reading as bare head terms:
// the OLD code sorted by volume alone, and volume overwhelmingly favors
// short, generic terms over specific ones.
function rankBySpecificity(keywords) {
  const withWordCount = keywords.map((k) => ({ ...k, _words: cleanTokens(tokenizeWords(k.keyword)).length }));
  const longTail = withWordCount.filter((k) => k._words >= MIN_LONGTAIL_WORDS).sort((a, b) => b.volume - a.volume);
  const headTerms = withWordCount.filter((k) => k._words < MIN_LONGTAIL_WORDS).sort((a, b) => b.volume - a.volume);
  return [...longTail, ...headTerms].map(({ _words, ...k }) => k);
}

async function fetchOwnKeywords(domain, country) {
  if (!hasSemrushKey()) return { keywords: [], available: false, error: null };
  try {
    const database = getDatabase(country);
    const keywords = await getKeywordsFull(hostOf(domain), database, KEYWORD_FETCH_LIMIT, 'nq_desc');
    return { keywords, available: true, error: null };
  } catch (e) {
    return { keywords: [], available: false, error: e.message };
  }
}

// The same computeKeywordGap the standalone Competitor Research tool uses
// (competitorAnalysis/gapAnalysis.js) — "missing" is keywords a tracked
// competitor ranks top-10 for that this domain doesn't rank for at all.
// Capped to a few competitors and a modest per-competitor row limit (see the
// constants above) since this is a per-domain SEMrush fetch, not free.
async function fetchCompetitorGapKeywords(ownKeywords, competitorDomains, country) {
  if (!hasSemrushKey() || !competitorDomains.length) return { keywords: [], queried: [] };
  const database = getDatabase(country);
  const queried = competitorDomains.slice(0, MAX_COMPETITORS_QUERIED);
  const entries = await Promise.all(queried.map(async (domain) => {
    try {
      const keywords = await getKeywordsFull(hostOf(domain), database, COMPETITOR_FETCH_LIMIT, 'nq_desc');
      return { domain, keywords };
    } catch (e) {
      console.error(`[content-architect] competitor keyword fetch failed for ${domain}:`, e.message);
      return { domain, keywords: [] };
    }
  }));
  const gap = computeKeywordGap(ownKeywords, entries);
  // A competitor's OWN brand ranks #1 for their OWN brand name by default —
  // "HDFC Net Banking" showing up as a "gap" is not a content opportunity,
  // it's just HDFC's navigational traffic. No article on IDFC's site will
  // ever outrank hdfcbank.com for their own name. Filtered per-candidate
  // against the SPECIFIC competitor that ranks for it (bestCompetitorDomain),
  // not just this project's own brand.
  const competitorBrandTokens = new Map(queried.map((d) => [d, deriveBrandTokens(d)]));
  const notCompetitorBrand = (g) => {
    const brandTokens = competitorBrandTokens.get(g.bestCompetitorDomain);
    if (!brandTokens) return true;
    const words = cleanTokens(tokenizeWords(g.keyword));
    return !words.some((w) => isBrandWord(w, brandTokens));
  };
  // Normalized to the same {keyword, volume} shape fetchOwnKeywords produces,
  // so keywordsRelevantToTopic/rankBySpecificity work on either without a
  // second code path — gap rows use searchVolume/bestCompetitorDomain instead.
  const keywords = gap.missing.filter(notCompetitorBrand).map((g) => ({
    keyword: g.keyword, volume: g.searchVolume || 0, competitorDomain: g.bestCompetitorDomain,
  }));
  return { keywords, queried };
}

async function fetchPeopleAlsoAsk(topic) {
  try {
    const result = await searchGoogle(topic);
    return result.peopleAlsoAsk.slice(0, MAX_PAA_QUESTIONS);
  } catch {
    return [];
  }
}

// Not real question-mining — a labeled substitute for when Serper has
// nothing (PAA boxes don't appear for every query) or isn't configured. Kept
// deliberately separate from fetchPeopleAlsoAsk's output rather than merged
// in silently, since the LLM prompt and the mechanical fallback both need to
// know which questions are real search behavior and which are inferred.
async function generateLikelyQuestions(topic, vertical) {
  if (!hasLlmKey()) return [];
  try {
    const client = createLlmClient(MODEL);
    const completion = await client.chat.completions.create({
      model: client.model,
      // No custom temperature, and max_completion_tokens (not max_tokens) —
      // this app's default OpenAI model is a reasoning model that only
      // supports its default temperature and rejects max_tokens outright
      // (see articleEnhancement.js's calls against the same model for the
      // established convention this follows).
      max_completion_tokens: 512,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: 'You suggest the questions real customers most commonly ask about a topic, for a '
            + (vertical && vertical !== 'other' ? `${vertical} ` : '') + 'business. '
            + 'Return valid JSON only: {"questions": ["...", ...]}, 5-8 items, no markdown fences.',
        },
        { role: 'user', content: `Topic: ${topic}` },
      ],
    });
    const parsed = JSON.parse(completion.choices[0]?.message?.content || '{}');
    return Array.isArray(parsed.questions) ? parsed.questions.filter((q) => typeof q === 'string' && q.trim()) : [];
  } catch {
    return [];
  }
}

const SYSTEM_PROMPT = `You are an SEO content strategist. You are given one content HUB (a pillar
page's topic) on a client's site, its EXISTING spoke pages, and whatever real-world signals were
available: keyword search volume for this domain, real competitor keyword GAPS (keywords named
competitors rank for that this domain does not, from SEMrush — a real, not guessed, sign that a
competitor already covers something this hub doesn't), real "People also ask" questions, and named
competitor domains in this market. Suggest NEW spoke article topics that would deepen this hub's
topical authority — subjects the site does not already publish on.

Rules:
- LONG-TAIL AND SPECIFIC, not a head term. The hub itself already owns the broad head term (a "Dental
  Implants" hub does not need a spoke ALSO called "Dental Implants" or "Dental Implant Cost" — that's
  the hub's own territory, not a gap). A spoke should answer one specific question a head term can't:
  a sub-audience ("dental implants for diabetics"), a specific comparison ("implants vs. bridges for
  a missing molar"), a specific scenario ("same-day implants recovery timeline"), or a specific
  concern a competitor_gap or people_also_ask signal actually raised. If every candidate signal is a
  bare 1-2 word head term, use "reasoning" to propose the specific angle a real article would take on
  it — never hand the head term back as the title.
- Do NOT suggest a topic that duplicates or is a close variant of an existing spoke listed below, OR
  of the hub's own topic — check the general subject, not just the exact title.
- Ground suggestions in the provided signals over generic guesses. When a suggestion is supported by
  a signal, name it in "basedOn": "keyword_volume" (real search demand), "competitor_gap" (a named
  competitor ranks for something related and this hub doesn't — name the competitor in the
  rationale), "people_also_ask" (a real question searchers ask), or "reasoning" (topical judgment
  with no specific signal behind it — use sparingly, only when it fills a real coverage gap).
- "title" is a TOPIC — what a person would write and publish — never a raw search query echoed back.
  A keyword like "personal loans" or "milestone credit card login" is evidence a topic matters, not
  itself a title. If a keyword signal is purely navigational or account-management intent (a login
  page, a helpline number, a balance check) with no real subject behind it, do not suggest it at all
  — that's not a content gap, it's someone looking for a different page entirely.
- Each suggestion needs a concrete, publishable article title (not a vague category like "More
  content") and a one-sentence rationale.
- Return 3-8 suggestions, ranked by expected value, best first.
- Return valid JSON only: {"suggestions":[{"title":"...","rationale":"...","basedOn":["..."]}]}. No
  markdown fences, no preamble.`;

async function synthesizeWithLlm(payload) {
  const client = createLlmClient(MODEL);
  const completion = await client.chat.completions.create({
    model: client.model,
    // See generateLikelyQuestions above: no custom temperature, and
    // max_completion_tokens rather than max_tokens.
    max_completion_tokens: 1536,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: JSON.stringify(payload) },
    ],
  });
  const parsed = JSON.parse(completion.choices[0]?.message?.content || '{}');
  if (!Array.isArray(parsed.suggestions)) throw new Error('response missing "suggestions" array');
  return parsed.suggestions
    .filter((s) => s && typeof s.title === 'string' && s.title.trim())
    .slice(0, MAX_SUGGESTIONS)
    .map((s) => ({
      title: s.title.trim(),
      rationale: typeof s.rationale === 'string' ? s.rationale.trim() : '',
      basedOn: Array.isArray(s.basedOn) ? s.basedOn.filter((b) => typeof b === 'string') : [],
      source: 'llm',
    }));
}

// Real data, no AI judgment — what's left if the LLM call fails or isn't
// configured. Competitor gaps first (the strongest signal: a named
// competitor already ranks for this, this domain does not), then the
// domain's own keyword candidates, topped up with real PAA questions if
// there's room. Never invents anything.
//
// Without an LLM there's no way to turn "personal loans" into an actual
// article angle like "Personal Loan Options for Salaried Employees" — that
// needs real language generation. Title-casing is the honest ceiling here;
// the rationale says plainly that this is a keyword, not a finished topic,
// so the Keyword Research button next to it (not a "recommend article"
// shortcut) is clearly the right next step.
function mechanicalFallback({ competitorGapCandidates, keywordCandidates, paaQuestions }) {
  const fromGaps = competitorGapCandidates.slice(0, MAX_SUGGESTIONS).map((k) => ({
    title: titleCase(k.keyword),
    rationale: `Keyword idea, not a finished topic — ${k.competitorDomain || 'a tracked competitor'} ranks for this`
      + `${k.volume ? ` (${k.volume.toLocaleString('en-US')} monthly searches)` : ''} and this site doesn't. Use Keyword Research to shape this into an article angle.`,
    basedOn: ['competitor_gap'],
    source: 'mechanical',
  }));
  let remaining = Math.max(0, MAX_SUGGESTIONS - fromGaps.length);
  const fromKeywords = keywordCandidates.slice(0, remaining).map((k) => ({
    title: titleCase(k.keyword),
    rationale: `Keyword idea, not a finished topic — ${k.volume.toLocaleString('en-US')} monthly searches for this domain's market. Use Keyword Research to shape this into an article angle.`,
    basedOn: ['keyword_volume'],
    source: 'mechanical',
  }));
  remaining = Math.max(0, remaining - fromKeywords.length);
  const fromPaa = paaQuestions.slice(0, remaining).map((q) => ({
    title: q.question,
    rationale: 'A real question people ask about this topic.',
    basedOn: ['people_also_ask'],
    source: 'mechanical',
  }));
  return [...fromGaps, ...fromKeywords, ...fromPaa];
}

/**
 * @param {object} input
 * @param {string} input.domain               project's canonical origin
 * @param {string} [input.country]             ISO code or name; defaults to 'us' (getDatabase)
 * @param {string} [input.vertical]
 * @param {string} input.hubTitle              the hub page's title, or the cluster name if no hub exists
 * @param {string[]} input.topTerms            topTermsForCluster(...) output
 * @param {string[]} input.existingSpokeTitles for dedup — what NOT to re-suggest
 * @param {string[]} [input.competitorDomains] real domain names, if the project has them tracked
 */
async function suggestSpokes({
  domain, country, vertical, hubTitle, topTerms, existingSpokeTitles = [], competitorDomains = [],
}) {
  const topic = hubTitle || topTerms.slice(0, 3).join(' ');

  const [ownKeywords, paa] = await Promise.all([
    fetchOwnKeywords(domain, country),
    fetchPeopleAlsoAsk(topic),
  ]);
  // Competitor gap needs the domain's own FULL keyword list as the baseline
  // to diff against (computeKeywordGap decides "missing" by whether THIS
  // domain ranks for it at all, site-wide) — so it runs after fetchOwnKeywords
  // resolves, not in the same Promise.all.
  const competitorGap = await fetchCompetitorGapKeywords(ownKeywords.keywords, competitorDomains, country);

  const keywordCandidates = rankBySpecificity(keywordsRelevantToTopic(ownKeywords.keywords, topTerms, domain))
    .slice(0, MAX_KEYWORD_CANDIDATES);
  const competitorGapCandidates = rankBySpecificity(keywordsRelevantToTopic(competitorGap.keywords, topTerms, domain))
    .slice(0, MAX_KEYWORD_CANDIDATES);

  const paaQuestions = paa.length ? paa : (await generateLikelyQuestions(topic, vertical)).map((q) => ({ question: q, snippet: '' }));
  const paaIsReal = paa.length > 0;

  const signals = {
    semrushAvailable: ownKeywords.available,
    semrushError: ownKeywords.error,
    keywordCandidateCount: keywordCandidates.length,
    competitorGapCandidateCount: competitorGapCandidates.length,
    competitorsQueried: competitorGap.queried,
    paaQuestionCount: paaQuestions.length,
    paaIsReal,
    competitorDomains,
    llmAvailable: hasLlmKey(),
  };

  if (!hasLlmKey()) {
    return { suggestions: mechanicalFallback({ competitorGapCandidates, keywordCandidates, paaQuestions }), signals };
  }

  const payload = {
    hub: { topic, existingSpokes: existingSpokeTitles.slice(0, 40) },
    signals: {
      keywordVolume: keywordCandidates.map((k) => ({ keyword: k.keyword, monthlySearchVolume: k.volume })),
      competitorGaps: competitorGapCandidates.map((k) => ({
        keyword: k.keyword, monthlySearchVolume: k.volume, competitorThatRanksForThis: k.competitorDomain,
      })),
      peopleAlsoAsk: paaIsReal ? paaQuestions.map((q) => q.question) : [],
      competitorDomains,
    },
  };

  try {
    const suggestions = await synthesizeWithLlm(payload);
    if (suggestions.length) return { suggestions, signals };
  } catch (e) {
    console.error('[content-architect] spoke suggestion LLM call failed, using mechanical fallback:', e.message);
  }
  return { suggestions: mechanicalFallback({ competitorGapCandidates, keywordCandidates, paaQuestions }), signals };
}

module.exports = { suggestSpokes };
