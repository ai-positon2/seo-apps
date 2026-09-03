// ── Keyword Research Pipeline, Stages 1–6 (Spec §6) ──────────────────────────
// Each stage is a discrete, independently testable function with a clear I/O
// contract. Reuses the app's existing googleSearch + semrush services. Billed
// API calls (SERP, SEMrush, LLM) are cached so re-runs / refresh don't re-bill
// (Spec §14).

const OpenAI = require('openai');
const store = require('./store');
const config = require('./config');
const { getGeo } = require('./geo');
const { chatParams } = require('./llmParams');
const { searchGoogle } = require('../services/googleSearch');
const { getUrlKeywords } = require('../services/semrush');

// ── Stage 1 — Select Scope & Check Eligibility (Spec §6 Stage 1, §15.1) ──────
async function checkEligibility({ client, service, location }) {
  if (!location) return { eligible: false, gbp_backed: false, reason: 'Location not found.' };
  if (!service) return { eligible: false, gbp_backed: false, reason: 'Service not found.' };

  const gbpBacked = !!location.verified; // GBP-backed (Spec §15.1)
  const offeredHere = (location.services_available_ids || []).includes(service.id);

  if (!gbpBacked) {
    return { eligible: false, gbp_backed: false, reason: `Location "${location.location_name}" is not GBP-verified. Doorway-page guardrail blocks generation (§15.1).` };
  }
  if (!offeredHere) {
    return { eligible: false, gbp_backed: true, reason: `"${service.name}" is not offered at ${location.location_name}. Page would be a doorway page (§15.1).` };
  }
  return { eligible: true, gbp_backed: true, reason: 'GBP-verified location offering this service.' };
}

// ── Stage 2 — Seed Keyword Generation (Spec §6 Stage 2) ──────────────────────
function generateSeeds({ service, location }) {
  const svc = service.name;
  const geo = getGeo(location);
  const city = location.city;
  const state = geo.state;
  const nearby = location.nearby_areas || [];
  const variants = service.semantic_variants || [];
  const modifiers = ['best', 'affordable', 'emergency', '24-hour', 'provider', 'clinic', 'treatment'];

  const seeds = new Set();
  const add = (s) => s && seeds.add(s.replace(/\s+/g, ' ').trim().toLowerCase());

  // [service] [city] family
  add(`${svc} ${city}`);
  add(`${svc} in ${city}`);
  add(`${svc} in ${city}, ${state}`);
  // near me family
  add(`${svc} near me`);
  add(`${svc} services near me`);
  nearby.forEach(area => add(`${svc} near ${area}`));
  // region / metro / state
  if (geo.metro && geo.metro !== city) add(`${svc} ${geo.metro}`);
  if (geo.region && geo.region !== geo.metro) add(`${svc} ${geo.region}`);
  add(`${svc} ${state}`);
  // commercial modifiers
  modifiers.forEach(m => add(`${m} ${svc} ${city}`));
  // semantic variants / sub-services
  variants.forEach(v => { add(`${v} ${city}`); add(`${v} near me`); });

  return [...seeds];
}

// ── Stage 3 — SERP + Competitor URL Ranking (simplified v1; Spec §6 Stage 3) ─
// v1 simplification (per spec): pull organic results, auto-tag directories /
// own-domain, score with the tunable rubric, take top-N into model_after, and
// let a human confirm. Location forcing approximated via gl/hl + geo-modified
// query (true uule deferred to the DataForSEO adapter — Spec §18).
function domainOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; }
}

async function rankCompetitors({ client, service, location, seeds, onProgress }) {
  // Fail fast (and clearly) if the SERP provider isn't configured — otherwise
  // the calls error one-by-one and look like a hang (Spec §14 resilience).
  if (!process.env.GOOGLE_API_KEY || !process.env.GOOGLE_CX) {
    throw new Error('Google Custom Search is not configured on the server (GOOGLE_API_KEY / GOOGLE_CX). Set these in the environment to run the SERP stage.');
  }

  const weights = config.serpScoreWeights;
  const ownDomain = domainOf(client?.brand_static?.base_url || '');
  const city = (location.city || '').toLowerCase();
  const state = (location.state || '').toLowerCase();
  const nearby = (location.nearby_areas || []).map(a => a.toLowerCase());
  const svcTokens = service.name.toLowerCase().split(/\s+/).concat((service.semantic_variants || []).map(v => v.toLowerCase()));

  // Use a focused subset of geo-bearing seeds to control SERP spend.
  const querySeeds = seeds.filter(s => s.includes(city) || s.includes('near me')).slice(0, 6);
  const list = querySeeds.length ? querySeeds : seeds.slice(0, 4);
  const byUrl = new Map();

  // Run the SERP queries in parallel (not sequentially) so one slow/timing-out
  // call doesn't stall the whole stage. Transient errors yield empty results;
  // a quota error surfaces immediately.
  let completed = 0;
  const perSeed = await Promise.all(list.map(async (seed) => {
    const cacheK = store.cacheKey('serp', seed, 'us');
    let data = await store.cacheGet(cacheK, config.cache.serpTtlMs);
    if (!data) {
      try {
        data = await searchGoogle(seed);
        await store.cacheSet(cacheK, data, { kind: 'serp', ttlMs: config.cache.serpTtlMs });
      } catch (e) {
        if (e.code === 'QUOTA_EXCEEDED') throw e;
        data = { results: [] }; // transient error → skip this seed
      }
    }
    completed += 1;
    if (onProgress) onProgress(completed, list.length);
    return { seed, data };
  }));

  perSeed.forEach(({ seed, data }) => {
    (data.results || []).forEach(r => {
      const dom = domainOf(r.url);
      if (!dom) return;
      const existing = byUrl.get(r.url) || {
        url: r.url, domain: dom, title: r.title || '', snippet: r.snippet || '',
        seeds: [], best_position: r.position || 99, ranking_count: 0,
      };
      existing.ranking_count += 1;
      existing.seeds.push(seed);
      existing.best_position = Math.min(existing.best_position, r.position || 99);
      byUrl.set(r.url, existing);
    });
  });

  // Score each URL with the tunable rubric.
  const scored = [...byUrl.values()].map(u => {
    const hay = `${u.url} ${u.title} ${u.snippet}`.toLowerCase();
    const isOwn = ownDomain && u.domain.includes(ownDomain);
    const isDirectory = config.serp.directoryDomains.some(d => u.domain.includes(d));
    const localMatch = hay.includes(city) || hay.includes(state) || nearby.some(a => hay.includes(a));
    const serviceMatch = svcTokens.some(t => t && hay.includes(t));
    const conversionIntent = /\b(call|book|appointment|schedule|contact|consultation|quote)\b/.test(hay);
    const pageTypeMatch = serviceMatch && localMatch && !isDirectory;
    const conventionalSchema = false; // schema quality requires fetch — deferred to full engine

    let score = 0;
    if (u.ranking_count > 1) score += weights.rankingFrequency;
    if (pageTypeMatch) score += weights.pageTypeMatch;
    if (localMatch) score += weights.localIntentMatch;
    if (serviceMatch) score += weights.serviceIntentMatch;
    if (conversionIntent) score += weights.conversionIntent;
    if (u.best_position <= 3) score += weights.organicPosition;
    else if (u.best_position <= 10) score += Math.round(weights.organicPosition / 2);
    if (conventionalSchema) score += weights.schemaQuality;

    let bucket = 'model_after';
    if (isOwn) bucket = 'own_footprint';
    else if (isDirectory) bucket = 'discovery_only';

    return {
      url: u.url, domain: u.domain, page_type: pageTypeMatch ? 'service_page' : 'other',
      ranking_count: u.ranking_count, average_position: u.best_position,
      location_match: localMatch, service_match: serviceMatch, conversion_intent: conversionIntent,
      is_directory: isDirectory, is_own_domain: !!isOwn, final_score: score, bucket,
      title: u.title, seeds: u.seeds,
    };
  });

  // Cap ~2 URLs per domain (Spec §6 Stage 3 guardrail).
  const perDomain = {};
  const capped = scored
    .sort((a, b) => b.final_score - a.final_score)
    .filter(u => {
      perDomain[u.domain] = (perDomain[u.domain] || 0) + 1;
      return perDomain[u.domain] <= config.serp.maxPerDomain;
    });

  const modelAfter = capped.filter(u => u.bucket === 'model_after').slice(0, config.serp.modelAfterCount);
  const discoveryOnly = capped.filter(u => u.bucket === 'discovery_only');

  return { competitor_urls: capped, modelAfter, discoveryOnly };
}

// ── Stage 4 — SEMrush Keyword Extraction (Spec §6 Stage 4) ───────────────────
async function extractKeywords({ urls }) {
  const apiKey = process.env.SEMRUSH_API_KEY;
  if (!apiKey) throw new Error('SEMRUSH_API_KEY not configured on server.');

  const pool = [];
  // modest concurrency, matching the app's keywordResearch route pattern
  const CONCURRENCY = 3;
  for (let i = 0; i < urls.length; i += CONCURRENCY) {
    const batch = urls.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(async (u) => {
      const cacheK = store.cacheKey('semrush', u.url, config.semrush.keywordsPerUrl);
      let kws = await store.cacheGet(cacheK, config.cache.semrushTtlMs);
      if (!kws) {
        try {
          kws = await getUrlKeywords(u.url, apiKey, config.semrush.keywordsPerUrl);
          await store.cacheSet(cacheK, kws, { kind: 'semrush', ttlMs: config.cache.semrushTtlMs });
        } catch (e) {
          if (e.message && e.message.includes('Invalid SEMrush')) throw e;
          kws = [];
        }
      }
      return kws.map(k => ({ ...k, source_url: u.url, source_bucket: u.bucket }));
    }));
    pool.push(...results.flat());
  }

  // Dedupe by keyword string → master pool. Flag hyper-local/near-me low-volume.
  const map = new Map();
  for (const k of pool) {
    const key = (k.keyword || '').toLowerCase();
    if (!key) continue;
    if (!map.has(key)) {
      map.set(key, {
        ...k,
        low_data_locally_relevant: (k.volume === 0 || k.volume < 10) && /near me|near |[a-z]+,? [a-z]{2}\b/.test(key),
      });
    }
  }
  return [...map.values()];
}

// ── Stage 5 — LLM Relevance & Prioritization (Spec §6 Stage 5) ───────────────
const RELEVANCE_SCHEMA_HINT = `{
  "keywords": [
    { "keyword": "string", "relevance": 0-100, "intent_class": "conversion|transactional|commercial|informational|navigational", "local_intent": true|false, "priority_score": 0-100 }
  ],
  "primary": ["string", "string"],
  "secondary": ["string", ...up to 10],
  "buckets": {
    "local_modifier": ["string"], "semantic": ["string"], "faq": ["string"],
    "internal_linking": ["string"], "informational_low": ["string"], "excluded": ["string"]
  }
}`;

async function classifyKeywords({ service, location, keywordPool }) {
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY not configured on server.');
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const geo = getGeo(location);

  const pool = keywordPool.slice(0, config.llm.maxKeywordsToClassify);
  const cacheK = store.cacheKey('llm-relevance', service.id, location.id, pool.map(k => k.keyword).sort());
  const cached = await store.cacheGet(cacheK, config.cache.llmTtlMs);
  if (cached) return cached;

  const list = pool.map((k, i) => `${i}. ${k.keyword} | vol:${k.volume || 0} | kd:${k.difficulty || 0}`).join('\n');

  const system = `You classify keywords for a SINGLE Location+Service web page. Respond ONLY with JSON matching the schema. No prose.
Schema:
${RELEVANCE_SCHEMA_HINT}
Rules:
- Page context: service "${service.name}" (category: ${service.category}) in ${location.city}, ${geo.state}.
- priority_score: weighted blend with CONVERSION intent highest, then commercial/transactional, plus volume and relevance; informational down-weighted.
- Collapse near-duplicates.
- primary: EXACTLY up to 2. At least one MUST be location-bearing ("[service] [city]"). The second may be a strong "near me" or head term — do NOT force two near-identical geo strings.
- secondary: up to 10 complementary/supporting/long-tail terms.
- Place each keyword into exactly one bucket where applicable.`;

  const example = `Example (truncated): {"keywords":[{"keyword":"talk therapy brea","relevance":95,"intent_class":"commercial","local_intent":true,"priority_score":92}],"primary":["talk therapy brea","talk therapy near me"],"secondary":["therapist brea ca"],"buckets":{"local_modifier":["talk therapy brea"],"semantic":["psychotherapy brea"],"faq":["how much does talk therapy cost"],"internal_linking":["medication management brea"],"informational_low":["what is talk therapy"],"excluded":["betterhelp"]}}`;

  let parsed = null;
  for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
    const completion = await openai.chat.completions.create({
      model: config.llm.classificationModel,
      // temperature 0 (Spec §6 Stage 5) — only sent to models that accept it.
      ...chatParams(config.llm.classificationModel, { temperature: config.llm.classificationTemperature }),
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: `${example}\n\nClassify these keywords:\n${list}\n\nReturn JSON only.` },
      ],
    });
    try {
      const raw = JSON.parse(completion.choices[0].message.content);
      if (raw && Array.isArray(raw.primary) && Array.isArray(raw.secondary)) parsed = raw;
    } catch { /* retry once on schema-invalid output */ }
  }
  if (!parsed) throw new Error('LLM returned invalid keyword classification JSON after retry.');

  // Enforce caps + attach volume/difficulty from the pool.
  const volByKw = new Map(pool.map(k => [k.keyword.toLowerCase(), k]));
  const enrich = (kw) => {
    const src = volByKw.get((kw || '').toLowerCase()) || {};
    return { keyword: kw, volume: src.volume || 0, difficulty: src.difficulty || 0 };
  };

  const result = {
    primary: (parsed.primary || []).slice(0, config.keywords.maxPrimary).map(enrich),
    secondary: (parsed.secondary || []).slice(0, config.keywords.maxSecondary).map(enrich),
    local_modifier: (parsed.buckets?.local_modifier || []).map(enrich),
    semantic: (parsed.buckets?.semantic || []).map(enrich),
    faq: parsed.buckets?.faq || [],
    internal_linking: (parsed.buckets?.internal_linking || []).map(enrich),
    informational_low: (parsed.buckets?.informational_low || []).map(enrich),
    excluded: parsed.buckets?.excluded || [],
    candidate_pool: (parsed.keywords || []).map(k => ({ ...k, ...enrich(k.keyword) })),
  };
  await store.cacheSet(cacheK, result, { kind: 'llm', ttlMs: config.cache.llmTtlMs });
  return result;
}

module.exports = {
  checkEligibility, generateSeeds, rankCompetitors,
  extractKeywords, classifyKeywords, domainOf,
};
