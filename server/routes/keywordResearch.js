const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const OpenAI = require('openai');
const { searchGoogle } = require('../services/googleSearch');
const { getUrlKeywords } = require('../services/semrush');
const { loadKBContext } = require('../services/kbLoader');
const { getConversionIntentScore } = require('../services/intentVocabulary');

// In-memory session store (token → params, expires in 2 min)
const sessions = new Map();

// SERP result cache: query → { results, ts }
const serpCache = new Map();
const SERP_CACHE_TTL = 24 * 60 * 60 * 1000; // 24h

const MAX_VARIANTS = 5; // original + 5 variants = 6 total SERP queries

const DIRECTORY_DOMAINS = new Set([
  'yelp.com', 'healthgrades.com', 'zocdoc.com', 'vitals.com', 'ratemds.com',
  'angieslist.com', 'homeadvisor.com', 'thumbtack.com', 'tripadvisor.com',
  'yellowpages.com', 'bbb.org', 'findlaw.com', 'avvo.com', 'lawyers.com',
  'martindale.com', 'nolo.com', 'expertise.com',
]);

function generateToken() {
  return crypto.randomBytes(16).toString('hex');
}

function getRootDomain(url) {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, '');
    const parts = hostname.split('.');
    return parts.slice(-2).join('.');
  } catch { return url; }
}

function isDirectoryDomain(url) {
  try { return DIRECTORY_DOMAINS.has(getRootDomain(url)); }
  catch { return false; }
}

function getPageTypeScore(url, title = '') {
  try {
    const path = new URL(url).pathname.toLowerCase();
    if (isDirectoryDomain(url)) return 0.2;
    if (/\/\d{4}[\/\-]\d{2}/.test(path)) return 0.4;
    if (/\/(blog|article|articles|news|post|posts|insights|resources|guide|guides|learn|education)\//i.test(path)) return 0.4;
    // Informational title signals — penalise even when the URL path looks like a service page
    const t = title.toLowerCase();
    if (/^(what is|how to|guide to|introduction to|understanding|the complete|everything (you|about))/i.test(t)) return 0.3;
    if (/(explained|: a guide| guide$|overview|tutorial|\bfaq\b|trends|challenges|what is|how to)/i.test(t)) return 0.45;
    return 1.0;
  } catch { return 0.5; }
}

function getPageTypeLabel(url, title = '') {
  if (isDirectoryDomain(url)) return 'directory';
  if (getPageTypeScore(url, title) < 0.5) return 'article';
  return 'page';
}

function getIntentAlignmentScore(titleSnippet, seedKeyword) {
  const seedWords = seedKeyword.toLowerCase().split(/\s+/).filter(w => w.length > 2);
  const text = titleSnippet.toLowerCase();
  const matches = seedWords.filter(w => text.includes(w));
  return seedWords.length > 0 ? matches.length / seedWords.length : 0;
}

function scoreUrl(urlObj, bestPosition, seedKeyword) {
  const posScore = 1 - (bestPosition - 1) / 10;
  const pageTypeScore = getPageTypeScore(urlObj.url, urlObj.title || '');
  const combined = (urlObj.title || '') + ' ' + (urlObj.snippet || '');
  const intentScore = getIntentAlignmentScore(combined, seedKeyword);
  const conversionScore = getConversionIntentScore(combined);
  return (
    0.35 * posScore +
    0.30 * pageTypeScore +
    0.20 * intentScore +
    0.15 * conversionScore
  );
}

// The TTL decides whether a hit is still fresh; on its own it never removed
// anything. A stale entry was only displaced if the exact same query came back,
// so the map grew by one retained SERP payload per distinct query for the life
// of the process — and each keyword issues up to MAX_VARIANTS + 1 queries, so a
// few thousand keywords is tens of thousands of entries that are never freed.
// Bounded and swept here, the same shape as the pending-input map in
// middleware/runTracking.js.
const SERP_CACHE_MAX = 2000;

function cacheSerp(query, results) {
  serpCache.set(query, { results, ts: Date.now() });
  if (serpCache.size <= SERP_CACHE_MAX) return;
  const cutoff = Date.now() - SERP_CACHE_TTL;
  for (const [key, entry] of serpCache) {
    if (entry.ts < cutoff) serpCache.delete(key);
  }
  // Still oversized (more live queries than the cap) — drop oldest first, which
  // is insertion order for a Map.
  while (serpCache.size > SERP_CACHE_MAX) {
    serpCache.delete(serpCache.keys().next().value);
  }
}

async function cachedSearch(query) {
  const cached = serpCache.get(query);
  if (cached && Date.now() - cached.ts < SERP_CACHE_TTL) {
    return { ...cached.results, fromCache: true };
  }
  const results = await searchGoogle(query);
  cacheSerp(query, results);
  return results;
}

// Step 1: Client POSTs keyword + optional client slug + intent, gets back a token
router.post('/init', (req, res) => {
  const { keyword, client, feedbackKbIds, intent } = req.body;
  if (!keyword?.trim()) return res.status(400).json({ error: 'keyword is required' });
  if (!process.env.SEMRUSH_API_KEY) return res.status(500).json({ error: 'SEMrush API key not configured on server.' });

  const token = generateToken();
  sessions.set(token, {
    keyword: keyword.trim(),
    client: client || null,
    feedbackKbIds: feedbackKbIds || null,
    intent: intent === 'informational' ? 'informational' : 'commercial',
  });
  setTimeout(() => sessions.delete(token), 120000);
  res.json({ token });
});

// Step 2: Client opens SSE stream with token
router.get('/stream/:token', async (req, res) => {
  const session = sessions.get(req.params.token);
  if (!session) return res.status(404).json({ error: 'Session not found or expired. Please try again.' });
  sessions.delete(req.params.token);

  const { keyword, client, feedbackKbIds, intent } = session;
  const semrushKey = process.env.SEMRUSH_API_KEY;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  let isClosed = false;
  res.on('close', () => { isClosed = true; });

  const emit = (event, data) => {
    if (isClosed) return;
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch (e) { isClosed = true; }
  };

  try {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    // ── Stage 0: Generate intent-focused query variants ──────────────────
    emit('step', { id: 'variants', status: 'active', message: `Generating ${intent} query variants for "${keyword}"…` });

    const intentDesc = intent === 'informational'
      ? 'informational/educational intent (how it works, procedure, recovery, comparisons, FAQs, risks, symptoms). Do not include any commercial or transactional queries such as cost, pricing, booking, or near me.'
      : 'commercial/transactional intent (cost, pricing, services, booking, near me, comparisons, best options). Do not include any informational or how-to queries.';

    const variantRes = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: 'You are an SEO query expansion assistant. Always respond with valid JSON only.' },
        {
          role: 'user',
          content: `Seed keyword: "${keyword}"
Generate exactly ${MAX_VARIANTS} search query variants that stay strictly within ${intentDesc}
Return JSON: { "variants": ["...", "...", "...", "...", "..."] }`,
        }
      ]
    });

    const rawVariants = JSON.parse(variantRes.choices[0].message.content).variants || [];
    const variants = rawVariants.slice(0, MAX_VARIANTS).filter(v => typeof v === 'string' && v.trim());
    const allQueries = [keyword, ...variants];

    emit('step', { id: 'variants', status: 'done', message: `Generated ${variants.length} ${intent} query variants` });
    emit('variants', { queries: allQueries });

    // ── Stage 1: Parallel SERP for all queries (batched, cache-aware) ────
    emit('step', { id: 'search', status: 'active', message: `Running ${allQueries.length} searches…` });

    const SERP_CONCURRENCY = 3;
    const allSerpResults = [];
    let cacheHits = 0;

    for (let i = 0; i < allQueries.length; i += SERP_CONCURRENCY) {
      if (isClosed) break;
      const batch = allQueries.slice(i, i + SERP_CONCURRENCY);
      const batchResults = await Promise.all(batch.map(async q => {
        const data = await cachedSearch(q);
        if (data.fromCache) cacheHits++;
        return { query: q, results: data.results || [], fromCache: data.fromCache || false };
      }));
      allSerpResults.push(...batchResults);
    }

    emit('step', { id: 'search', status: 'done', message: `Fetched ${allQueries.length} SERPs${cacheHits > 0 ? ` (${cacheHits} cached)` : ''}` });

    // ── Stage 1.5: URL Scoring + Selection ───────────────────────────────
    emit('step', { id: 'url_scoring', status: 'active', message: 'Scoring and selecting best competitor pages…' });

    // Aggregate per-URL: best position + query count
    const urlMap = new Map();
    for (const { results } of allSerpResults) {
      for (const r of results) {
        const existing = urlMap.get(r.url);
        if (!existing) {
          urlMap.set(r.url, { urlObj: r, bestPosition: r.position, queryCount: 1 });
        } else {
          existing.queryCount++;
          if (r.position < existing.bestPosition) existing.bestPosition = r.position;
        }
      }
    }

    // Domain cap: max 2 URLs per root domain
    const domainCount = new Map();
    const candidateUrls = [];
    for (const [, entry] of urlMap) {
      const root = getRootDomain(entry.urlObj.url);
      const count = domainCount.get(root) || 0;
      if (count >= 2) continue;
      domainCount.set(root, count + 1);
      candidateUrls.push(entry);
    }

    // Score and rank; take top 10
    const scoredUrls = candidateUrls.map(entry => ({
      ...entry.urlObj,
      rubricScore: Math.round(scoreUrl(entry.urlObj, entry.bestPosition, keyword) * 100) / 100,
      pageType: getPageTypeLabel(entry.urlObj.url, entry.urlObj.title || ''),
      queryCount: entry.queryCount,
      bestPosition: entry.bestPosition,
    }));
    scoredUrls.sort((a, b) => b.rubricScore - a.rubricScore);
    const top10 = scoredUrls.slice(0, 10);

    emit('step', { id: 'url_scoring', status: 'done', message: `Selected top ${top10.length} pages from ${urlMap.size} candidates` });
    emit('urls', { urls: top10, totalQueries: allQueries.length });

    // ── Stage 2: SEMrush per scored URL (parallel, max 3 concurrent) ────
    emit('step', { id: 'semrush', status: 'active', message: 'Fetching keyword rankings from SEMrush…' });

    const CONCURRENCY = 3;
    const allKeywordsRaw = [];

    for (let i = 0; i < top10.length; i += CONCURRENCY) {
      if (isClosed) break;
      const batch = top10.slice(i, i + CONCURRENCY);
      batch.forEach(urlObj => emit('url_status', { url: urlObj.url, title: urlObj.title, status: 'loading' }));

      const batchResults = await Promise.all(batch.map(async urlObj => {
        try {
          const keywords = await getUrlKeywords(urlObj.url, semrushKey, 30);
          emit('url_keywords', { url: urlObj.url, title: urlObj.title, keywords, status: 'done' });
          return keywords.map(k => ({ ...k, sourceUrl: urlObj.url }));
        } catch (err) {
          if (err.message.includes('Invalid SEMrush')) throw err;
          emit('url_keywords', { url: urlObj.url, title: urlObj.title, keywords: [], status: 'error', error: err.message });
          return [];
        }
      }));

      allKeywordsRaw.push(...batchResults.flat());
    }

    const rawCount = allKeywordsRaw.length;
    emit('step', { id: 'semrush', status: 'done', message: `Collected ${rawCount} keyword${rawCount !== 1 ? 's' : ''} across all pages` });

    if (rawCount === 0) {
      throw new Error('No keyword data returned from SEMrush. These pages may not have enough ranking history, or the API key may be incorrect.');
    }

    // ── Stage 2.5: Deduplicate + urlFrequency enrichment ─────────────────
    emit('step', { id: 'analysis', status: 'active', message: 'AI is filtering and shortlisting the best keywords…' });

    const kbContext = client ? await loadKBContext('keyword-research', client, feedbackKbIds || null) : null;

    // Deduplicate by keyword string; track unique source URLs per keyword
    const kwMap = new Map();
    for (const kw of allKeywordsRaw) {
      const key = kw.keyword.toLowerCase();
      if (!kwMap.has(key)) {
        kwMap.set(key, { kwObj: { ...kw }, urlSet: new Set([kw.sourceUrl]) });
      } else {
        const existing = kwMap.get(key);
        existing.urlSet.add(kw.sourceUrl);
        if ((kw.volume || 0) > (existing.kwObj.volume || 0)) existing.kwObj = { ...kw };
      }
    }

    const totalUrlsSelected = top10.length;
    const unique = [...kwMap.values()].map(({ kwObj, urlSet }) => ({
      ...kwObj,
      urlFrequency: urlSet.size,
      urlFreqScore: urlSet.size / totalUrlsSelected,
    }));

    // ── Stage 3: Composite scoring ────────────────────────────────────────
    emit('step', { id: 'scoring', status: 'active', message: 'Scoring keywords by alignment, URL frequency, and volume…' });

    const scoringRes = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: 'You are an SEO scoring assistant. Always respond with valid JSON only.' },
        {
          role: 'user',
          content: `Seed keyword: "${keyword}"

Rate each keyword below for semantic alignment to the seed keyword on a scale of 0–10.
0 = completely unrelated, 10 = directly targets the exact same topic and intent.

Keywords to score:
${unique.map((k, i) => `${i}. ${k.keyword}`).join('\n')}

Return JSON: { "scores": [<score for keyword 0>, <score for keyword 1>, ...] }
Return exactly ${unique.length} scores in the same order.`
        }
      ]
    });

    const rawScores = JSON.parse(scoringRes.choices[0].message.content).scores || [];
    // Map over `unique`, not `rawScores` — the model can return fewer scores than
    // requested for large pools, and indexing past a short array yields undefined.
    const alignmentScores = unique.map((_, i) => Math.min(Math.max(Number(rawScores[i]) || 0, 0), 10) / 10);

    const volumes = unique.map(k => k.volume || 0);
    const maxVol = Math.max(...volumes, 1);
    const volumeScores = volumes.map(v => v / maxVol);

    // New composite: 80% alignment + 20% volume
    const scored = unique.map((k, i) => ({
      ...k,
      alignmentScore: alignmentScores[i],
      volumeScore: volumeScores[i],
      compositeScore: 0.8 * alignmentScores[i] + 0.2 * volumeScores[i],
    }));
    scored.sort((a, b) => b.compositeScore - a.compositeScore);

    emit('step', { id: 'scoring', status: 'done', message: `Scored and ranked ${unique.length} keywords` });
    emit('allKeywords', { keywords: scored });

    const keywordList = scored.slice(0, 40).map(k =>
      `- ${k.keyword} | volume: ${k.volume || 'N/A'} | difficulty: ${k.difficulty || 'N/A'} | alignment: ${k.alignmentScore.toFixed(3)} | urlFreq: ${k.urlFreqScore.toFixed(2)} | composite: ${k.compositeScore.toFixed(3)}`
    ).join('\n');

    const kbSystemPrompt = 'You are an expert SEO strategist. Always respond with valid JSON only.'
      + (kbContext?.systemPromptSuffix || '');

    const completion = await openai.chat.completions.create({
      model: 'gpt-5.4-mini',
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: kbSystemPrompt },
        {
          role: 'user',
          content: `Seed keyword: "${keyword}"
Page intent: ${intent === 'informational' ? 'INFORMATIONAL / EDUCATIONAL' : 'COMMERCIAL / TRANSACTIONAL'}

${kbContext ? 'Brand context is available in your system prompt — use it as a low-priority secondary signal to prefer keywords that fit the brand\'s vertical, audience, and positioning, but do not let it override the core selection rules below.' : ''}

The keyword candidates below have been pre-ranked using a composite score:
  • 80% — semantic alignment to the seed keyword (alignment score, 0–1)
  • 20% — normalised search volume relative to the pool (0–1)
(urlFreq — how many of the top-scoring competitor pages rank for this keyword — is shown below for context only and is not part of the composite score)
Prefer higher composite-scored keywords when selecting primaries and secondaries, unless a hard rejection criterion applies.

Competitor keywords from top ranking pages (via SEMrush):
${keywordList}

---

PRIMARY SELECTION RULES (EXACTLY 2)

Each primary keyword must satisfy ALL of the following simultaneously:

1. Semantic core match — Directly targets the same core topic and intent as the seed keyword. Not a tangential subtopic or loose association. Pay special attention when the seed expresses a PROCESS, how-to, migration, or troubleshooting action (e.g. "How to Switch LLM Providers Without Downtime"): a keyword about COMPARING or CHOOSING BETWEEN options (e.g. "best llm", "compare llm models", "which llm is best for X") is NOT a valid match even though it shares the same topic noun — it serves a reader at the evaluation/selection stage, not a reader executing or troubleshooting the specific action the seed describes. Sharing a head noun (the product/technology/topic word) is not the same as sharing the seed's core intent.
2. Topical completeness — Must preserve ALL key topical dimensions of the seed keyword. If the seed combines two concepts (e.g. "fleet management" + "last mile delivery"), a primary that drops either concept entirely is not acceptable — even if it has high search volume. A subset of the seed topic is not the same topic. This also applies when the seed pairs a product/equipment with an industry, vertical, or use-case qualifier (e.g. "Forklifts for Chemical Industry"): a keyword about a component, accessory, or sub-part of that equipment (e.g. "forklift battery") is NOT a valid primary even if it shares a head word with the seed and has far higher volume — it drops the industry/vertical qualifier entirely and targets a different buyer intent.
3. Intent alignment — Must match the stated page intent (${intent === 'informational' ? 'informational/educational — avoid transactional modifiers like cost, pricing, booking, near me' : 'commercial/transactional — avoid purely informational or how-to terms'}).
4. Mutual distinctiveness — Both primaries must differ meaningfully from each other. Different modifier angle, different intent signal, or different funnel position. Near-duplicates are not permitted.

Each primary keyword must include a one-sentence reason that specifically justifies its selection against these criteria.

---

SECONDARY SELECTION RULES (EXACTLY 10)

Select exactly 10 keywords that collectively:
- Are complementary, supporting, or long-tail extensions of the seed keyword
- Remain consistent with the ${intent} intent
- Are viable for supporting sections on the same page, OR as separate pieces within the same topical cluster
- Match the seed's actual intent stage — if the seed expresses a PROCESS, how-to, migration, or troubleshooting action, do NOT fill the list with COMPARISON/SELECTION keywords (e.g. "best X", "compare X", "which X is best") just because they share a topic noun with the seed. A shared noun is not a shared intent.
${intent === 'commercial' ? `
SECONDARY COMMERCIAL ENFORCEMENT — reject any secondary keyword that:
- Starts with or contains "what is", "what does", "what are", "how to", "how long", "how does", "why", "when"
- Contains "news", "trends", "statistics", "report", "study"
- Contains "explained", "meaning", "definition", "overview", "introduction", "guide"
These are informational by nature and do not belong on a commercial page regardless of volume.` : `
SECONDARY INFORMATIONAL ENFORCEMENT — reject any secondary keyword that:
- Contains "pricing", "cost", "buy", "near me", "hire", "quote", "booking"
- Has clear transactional or purchase intent`}

---

HARD REJECTION CRITERIA

Discard any keyword that meets one or more of the following:
- Branded or competitor-branded terms (unless the seed keyword itself is branded)
- Navigational queries (user clearly looking for a specific website or brand)
- Intent mismatch — conflicts with the stated ${intent} intent
- Near-duplicate of an already-selected keyword (trivial pluralisation, word reorder, minor variation)
- Implausibly low search demand with no realistic audience at scale
- Excessively broad head terms with no realistic ranking pathway (volume traps)
- Out-of-vertical terms — keyword touches the industry loosely but does not serve the stated business or audience

---

Return this exact JSON:
{
  "primary": [
    {"keyword": "...", "volume": 0, "difficulty": 0, "reason": "one sentence justifying selection against the primary criteria above"}
  ],
  "secondary": [
    {"keyword": "...", "volume": 0, "difficulty": 0}
  ]
}

Use the actual volume and difficulty numbers from the input list. If data is missing, use 0.`
        }
      ]
    });

    const result = JSON.parse(completion.choices[0].message.content);
    emit('step', { id: 'analysis', status: 'done', message: 'Keyword shortlist ready' });

    // ── Stage 4: Primary + secondary keyword quality validation ──────────
    emit('step', { id: 'validation', status: 'active', message: 'Validating primary & secondary keyword match quality…' });

    try {
      const fullPoolList = scored.map(k =>
        `- ${k.keyword} | volume: ${k.volume || 'N/A'} | difficulty: ${k.difficulty || 'N/A'} | alignment: ${k.alignmentScore.toFixed(3)} | composite: ${k.compositeScore.toFixed(3)}`
      ).join('\n');

      const primaryListText = (result.primary || []).map((p, i) =>
        `${i + 1}. "${p.keyword}" | volume: ${p.volume || 'N/A'} | difficulty: ${p.difficulty || 'N/A'} | reason: ${p.reason || 'N/A'}`
      ).join('\n');

      const secondaryListText = (result.secondary || []).map((s, i) =>
        `${i + 1}. "${s.keyword}" | volume: ${s.volume || 'N/A'} | difficulty: ${s.difficulty || 'N/A'}`
      ).join('\n');

      const validationRes = await openai.chat.completions.create({
        model: 'gpt-5.4-mini',
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: 'You are an SEO quality-control assistant. Always respond with valid JSON only.' },
          {
            role: 'user',
            content: `Seed keyword: "${keyword}"
Page intent: ${intent === 'informational' ? 'INFORMATIONAL / EDUCATIONAL' : 'COMMERCIAL / TRANSACTIONAL'}

Currently selected primary keywords:
${primaryListText}

Currently selected secondary keywords:
${secondaryListText}

Full deduplicated keyword pool for this seed keyword, sorted by composite score (highest first):
${fullPoolList}

---

TASK

Judge whether the currently selected primary AND secondary keywords are a strong match for the seed keyword.

PRIMARY keywords (exactly 2) must satisfy ALL of:
1. Semantic core match — directly targets the same core topic and intent as the seed keyword. Pay special attention when the seed expresses a PROCESS, how-to, migration, or troubleshooting action (e.g. "How to Switch LLM Providers Without Downtime"): a keyword about COMPARING or CHOOSING BETWEEN options (e.g. "best llm", "compare llm models", "which llm is best for X") FAILS this rule even though it shares the same topic noun — it serves a reader at the evaluation/selection stage, not a reader executing or troubleshooting the specific action the seed describes.
2. Topical completeness — preserves ALL key topical dimensions of the seed keyword. Pay special attention when the seed pairs a product/equipment with an industry, vertical, or use-case qualifier (e.g. "Forklifts for Chemical Industry"): a keyword about a component, accessory, or sub-part of that equipment (e.g. "forklift battery") FAILS this rule even if it shares a head word with the seed and has far higher search volume — it drops the industry/vertical qualifier entirely and targets a different buyer.
3. Intent alignment — matches the stated page intent (${intent}).
4. Mutual distinctiveness — the two primaries differ meaningfully from each other.

Before deciding, explicitly re-check each currently selected primary word-by-word against the seed keyword: does it preserve every core noun, industry, and qualifier in the seed, not just the head product term? Does it match the seed's actual intent (process/how-to vs. comparison/selection), not just its topic noun? If it fails either check, it fails rules 1/2 regardless of volume, alignment score, or how many other pool candidates share the same flaw.

SECONDARY keywords (exactly 10) must collectively:
- Be complementary, supporting, or long-tail extensions of the seed keyword
- Remain consistent with the ${intent} intent
- Be viable for supporting sections on the same page, or as separate pieces within the same topical cluster
- Match the seed's actual intent stage — if the seed expresses a PROCESS, how-to, migration, or troubleshooting action, a slate dominated by COMPARISON/SELECTION keywords (e.g. "best X", "compare X", "which X is best") sharing only a topic noun with the seed FAILS this rule, even if that's most of what the candidate pool contains.
${intent === 'commercial'
  ? '- Not be informational by nature (e.g. "what is", "how to", "guide", "explained", "news", "trends", "statistics") regardless of volume'
  : '- Not carry transactional/purchase intent (e.g. "pricing", "cost", "buy", "near me", "hire", "quote", "booking")'}

- If everything currently selected satisfies its rules, return verdict "good" and return primary/secondary unchanged.
- If any keyword(s) fail, search the full keyword pool above for better-matching replacements that satisfy the relevant rules. Replace only the keyword(s) that failed; keep everything that already passes.
- If NO keyword in the full pool — including the ones currently selected — actually satisfies all the rules for a failing slot, do not settle for the least-bad option and call it "good". Return verdict "insufficient" instead, keep your best-available selections in place, and use "warning" to tell the user plainly why match quality is limited (e.g. the available keyword data has no options with adequate search volume for this specific angle, or the entire candidate pool skews toward an adjacent product/topic and lacks genuine coverage of the seed's full intent). Returning "insufficient" for a niche or narrow seed keyword is a normal, expected outcome — do not avoid it just because you found *some* keyword to fill the slot.

Return this exact JSON:
{
  "verdict": "good" | "replaced" | "insufficient",
  "primary": [
    {"keyword": "...", "volume": 0, "difficulty": 0, "reason": "..."}
  ],
  "secondary": [
    {"keyword": "...", "volume": 0, "difficulty": 0}
  ],
  "warning": null
}

"primary" must always contain exactly 2 keywords, "secondary" must always contain exactly 10. "warning" must be null unless verdict is "insufficient", in which case it must be a one-sentence explanation for the user.`
          }
        ]
      });

      const validation = JSON.parse(validationRes.choices[0].message.content);
      if (Array.isArray(validation.primary) && validation.primary.length === 2) {
        result.primary = validation.primary;
      }
      if (Array.isArray(validation.secondary) && validation.secondary.length === 10) {
        result.secondary = validation.secondary;
      }
      if (typeof validation.warning === 'string' && validation.warning.trim()) {
        result.warning = validation.warning.trim();
      }
      emit('step', { id: 'validation', status: 'done', message: result.warning ? 'Match quality warning issued' : 'Primary & secondary keywords verified' });
    } catch (err) {
      console.error('[keyword-research] Validation error:', err.message);
      emit('step', { id: 'validation', status: 'done', message: `Validation skipped (${err.message})` });
    }

    emit('result', result);

  } catch (err) {
    console.error('[keyword-research] Error:', err.message);
    emit('fail', { message: err.message });
  }

  emit('done', {});
  res.end();
});

module.exports = router;
