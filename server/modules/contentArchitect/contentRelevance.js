// ── Content relevance assessment (retire/refresh/keep) ───────────────────────
// Word count and last-modified date are weak proxies for "should this be
// retired" — a real user found this directly: a short, timeless FAQ isn't
// worth retiring just for being brief, and a 9-month-old page isn't "stale"
// by any reasonable definition, while a page with genuinely obsolete content
// (e.g. COVID-era guidance) deserves retiring regardless of length or exact
// age. This reads the actual title/excerpt/headings and asks for a judgment,
// same "deterministic default, LLM refines" pattern as cluster naming — if
// the call fails or there's no API key, callers fall back to the mechanical
// thin/stale signal rather than losing the tab entirely.
const { createLlmClient, structuredTaskParams, assertNotTruncated } = require('../../services/llmProviders');

const BATCH_SIZE = 25;
const MAX_RETRIES = 2;
const CALL_TIMEOUT_MS = 60000;
// Claude Sonnet via the shared factory (services/llmProviders.js), which
// reinforces JSON-only output and strips markdown fences for providers whose
// compatible endpoint ignores response_format.
const MODEL = 'claude-sonnet-5';

// Cheap pre-filter so a long, well-linked, but topically obsolete page still
// gets reviewed even though the mechanical thin/stale check would never flag
// it — the exact "COVID page" case called out directly.
const STALE_TOPIC_PATTERN = /\b(covid|covid-19|coronavirus|pandemic|quarantine|lockdown|temporarily closed|social distancing)\b/i;

const SYSTEM_PROMPT = `You are a content auditor for a website. You will be given a list of pages, each with its title, an excerpt, headings, word count, and last-modified date.

For each page, judge based on the actual content — not just word count or age:
- "retire": the content is genuinely obsolete or actively misleading now — it references a past event or time-limited situation as if still current (e.g. COVID-19 restrictions, an expired offer or discount, a discontinued product or service, statistics or prices presented as current but clearly dated).
- "refresh": the content is still relevant and accurate, but is thin, could be expanded, or would benefit from an update.
- "keep": the content is fine as-is. Being short or a year or two old is NOT by itself a reason to flag something — a timeless FAQ, a definition, or evergreen advice is fine even if brief or not recently touched.

Word count and age are not reliable signals on their own — judge the topic and substance. A short page about a timeless topic is "keep"; a long, recently-updated page about an expired promotion is still "retire".

Rules:
- One sentence of reasoning per page, specific to what you actually saw in the title/excerpt/headings — never generic phrases like "low word count" or "not updated recently" as the sole reason.
- Return valid JSON only. No markdown fences, no preamble.`;

const RESPONSE_FORMAT_INSTRUCTION = 'Respond with JSON of the exact shape '
  + '{"pages":[{"id":"<same id as input>","action":"retire"|"refresh"|"keep","reason":"..."}]}. '
  + 'Echo back the same "id" value for each page you were given — do not omit it, invent one, or change it. Include every page, even ones you judge "keep".';

// Gates whether the judgement call is attempted. Without it, the deterministic
// thin/stale flags still stand on their own.
function hasNamingKey() {
  const k = process.env.ANTHROPIC_API_KEY;
  return !!k && k !== 'your_anthropic_api_key_here';
}

let _client = null;
function client() {
  if (!_client) _client = createLlmClient(MODEL);
  return _client;
}

function matchesStaleTopic(page) {
  const text = [page.title, page.firstParagraph, ...(page.h2s || [])].filter(Boolean).join(' ');
  return STALE_TOPIC_PATTERN.test(text);
}

// Candidates = mechanically thin/stale OR matching a known stale-topic
// pattern regardless of length/age — the union is what actually needs a
// human-quality read; everything else is left alone rather than spending an
// LLM call confirming what's already obviously fine. Pages that were never
// actually crawled (crawlStatus 'estimated'/'failed' — no title, no content)
// are excluded regardless: they have nothing for the model to judge, and on
// a sampled large site nearly all of them would mechanically read as "thin"
// (wordCount 0) despite having no real signal either way.
function selectCandidates(pages) {
  return pages.filter((p) => p.crawlStatus === 'crawled' && ((p.flags || []).includes('thin-or-stale') || matchesStaleTopic(p)));
}

async function callBatch(payload) {
  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const completion = await client().chat.completions.create({
        model: MODEL,
        temperature: 0.2,
        max_tokens: 8192,
        ...structuredTaskParams(client()),
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: `${RESPONSE_FORMAT_INSTRUCTION}\n\n${JSON.stringify({ pages: payload })}` },
        ],
      // This loop already retries; the SDK's own retries on top of it, at the
      // SDK's ten-minute default, let one hung call outlast the whole run.
      }, { timeout: CALL_TIMEOUT_MS, maxRetries: 0 });
      assertNotTruncated(completion);
      const raw = completion.choices[0]?.message?.content || '{}';
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed.pages)) throw new Error('response missing "pages" array');
      return parsed.pages;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

const VALID_ACTIONS = new Set(['retire', 'refresh', 'keep']);
const MS_PER_MONTH = 30.44 * 24 * 60 * 60 * 1000;

function monthsSince(dateStr, now) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  return Number.isNaN(d.getTime()) ? null : (now - d.getTime()) / MS_PER_MONTH;
}

// Mechanical fallback reason — only cites a signal if it actually triggered,
// unlike the earlier bug where the modified date was always shown even when
// recent (a page from 9 months ago was shown as if its date were a strike
// against it, which it plainly isn't against an 18-month staleness bar).
function mechanicalReason(page, { thinWordCount, staleMonths, now }) {
  const reasons = [];
  if ((page.wordCount || 0) < thinWordCount) reasons.push(`only ${page.wordCount || 0} words`);
  const age = monthsSince(page.modifiedAt, now);
  if (age !== null && age > staleMonths) reasons.push(`last updated ${Math.round(age)} months ago`);
  if (!reasons.length) reasons.push('flagged for review');
  return reasons.join('; ');
}

// Returns Map<pageId, {action: 'retire'|'refresh'|'keep', reason, source: 'llm'|'mechanical'}>
// for every candidate page. Pages not selected as candidates are absent from
// the map (callers treat that as "keep" implicitly).
async function assessRelevance(pages, { thinWordCount, staleMonths, now }) {
  const candidates = selectCandidates(pages);
  const results = new Map();
  for (const p of candidates) {
    const isOrphan = (p.flags || []).includes('orphan');
    const isThin = (p.flags || []).includes('thin-or-stale');
    results.set(p.id, {
      action: isThin && isOrphan ? 'retire' : (isThin ? 'refresh' : 'keep'),
      reason: mechanicalReason(p, { thinWordCount, staleMonths, now }),
      source: 'mechanical',
    });
  }

  if (!hasNamingKey() || candidates.length === 0) return results;

  for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
    const batch = candidates.slice(i, i + BATCH_SIZE);
    const payload = batch.map((p) => ({
      id: p.id,
      title: p.title || '(no title)',
      excerpt: p.firstParagraph || '',
      headings: (p.h2s || []).slice(0, 6),
      wordCount: p.wordCount || 0,
      lastModified: p.modifiedAt || 'unknown',
    }));

    let responses;
    try {
      responses = await callBatch(payload);
    } catch (err) {
      console.error('[content-architect] content-relevance batch failed, keeping mechanical fallback for this batch:', err.message);
      continue;
    }

    for (const entry of responses) {
      if (!results.has(entry.id)) continue; // model invented an id — ignore
      if (!VALID_ACTIONS.has(entry.action)) continue; // keep mechanical fallback for this one
      const reason = typeof entry.reason === 'string' && entry.reason.trim() ? entry.reason.trim() : results.get(entry.id).reason;
      results.set(entry.id, { action: entry.action, reason, source: 'llm' });
    }
  }

  return results;
}

module.exports = { assessRelevance, selectCandidates, matchesStaleTopic };
