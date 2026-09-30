// ── A seed keyword from an article topic ─────────────────────────────────────
//
// Content Architect hands Keyword Research a TOPIC — an AI-suggested article
// title such as "How to Choose a Managed IT Provider: A Complete Guide" — not a
// keyword. Used as the seed verbatim, that title drives every later stage: the
// query variants are expansions of it, the URL rubric matches its words against
// SERP titles, and the shortlist prompt judges candidates against it. A title
// that long matches no real query, so the seed is turned into the 2–5 word head
// keyword a searcher would type before the pipeline starts.

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'of', 'for', 'to', 'in', 'on', 'with', 'your',
  'you', 'our', 'is', 'are', 'what', 'why', 'how', 'when', 'which', 'who',
  'complete', 'ultimate', 'guide', 'definitive', 'essential', 'everything',
  'need', 'know', 'about', 'best', 'top', 'tips', 'ways', 'explained',
]);

/**
 * The no-model fallback: the title before any ":" or " – " subtitle, stop
 * words and numbers removed, at most five words. Never returns an empty string
 * for a non-empty title — if every word was a stop word, the head is kept.
 */
function seedFromTopicFallback(topic) {
  const raw = String(topic || '').trim();
  if (!raw) return '';
  const head = raw.split(/\s*[:|–—]\s*|\s+-\s+/)[0] || raw;
  const words = head.toLowerCase().replace(/[^a-z0-9\s'-]/g, ' ').split(/\s+/).filter(Boolean);
  const kept = words.filter((w) => !STOP_WORDS.has(w) && !/^\d+$/.test(w));
  return (kept.length ? kept : words).slice(0, 5).join(' ');
}

/** Accept a model answer only if it is a plausible search query. */
function cleanSeed(value) {
  if (typeof value !== 'string') return '';
  const s = value.trim().toLowerCase().replace(/^["']|["']$/g, '').replace(/\s+/g, ' ');
  const count = s ? s.split(' ').length : 0;
  return count >= 1 && count <= 6 && s.length <= 80 ? s : '';
}

/**
 * The head keyword for `topic`, from one gpt-4o-mini call; the fallback when
 * the call fails or returns something unusable.
 *
 * @returns {Promise<{ keyword: string, source: 'model' | 'fallback' }>}
 */
async function seedFromTopic(openai, topic, intent) {
  try {
    const res = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: 'You are an SEO keyword assistant. Always respond with valid JSON only.' },
        {
          role: 'user',
          content: `Article topic: "${topic}"
Page intent: ${intent}

Return the single head keyword (2-5 words, lowercase) a searcher would type into Google to find this article. Keep every core noun and qualifier of the topic (industry, audience, use case); drop title words such as "guide", "complete", "how to", "tips", years and numbers.
Return JSON: { "keyword": "..." }`,
        },
      ],
    });
    const keyword = cleanSeed(JSON.parse(res.choices[0].message.content).keyword);
    if (keyword) return { keyword, source: 'model' };
  } catch (err) {
    console.error('[keyword-research] seed-from-topic failed:', err.message);
  }
  return { keyword: seedFromTopicFallback(topic), source: 'fallback' };
}

module.exports = { seedFromTopic, seedFromTopicFallback, cleanSeed };
