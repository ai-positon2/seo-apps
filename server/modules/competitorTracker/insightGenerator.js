const OpenAI = require('openai');

function getClient() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY not configured');
  return new OpenAI({ apiKey });
}

const SYSTEM_PROMPT = `You are a sharp SEO analyst writing a competitive analysis briefing for a client, in the same voice used in the agency's standard deliverable: short, direct, no filler.

Respond with ONLY a valid JSON object — no markdown, no explanation, no wrapper text. It must match this EXACT structure:

{
  "observation": ["short factual bullet about what's happening", "a second bullet if there's a distinct second fact worth noting"],
  "recommendation": ["short, concrete bullet on what to do about it"]
}

1-2 bullets per array, each one sentence. Observation states facts with numbers; Recommendation is actionable, not generic ("build more backlinks" is too vague — say what kind, from where, or on what topic, based on the data given).`;

/**
 * Generates one Observation/Recommendation pair for a module. Only called
 * when insightThresholds.js says the module has something notable — this
 * function itself does no gating, it just writes given the data it's handed.
 */
async function generateModuleInsight(moduleLabel, dataSummary) {
  const completion = await getClient().chat.completions.create({
    model: 'gpt-4o-mini',
    max_tokens: 400,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: `Module: ${moduleLabel}\n\nData:\n${dataSummary}` },
    ],
  });

  const responseText = completion.choices[0]?.message?.content || '';
  let insight;
  try {
    insight = JSON.parse(responseText);
  } catch {
    const objMatch = responseText.match(/\{[\s\S]*\}/);
    if (!objMatch) throw new Error('GPT returned an invalid JSON response');
    insight = JSON.parse(objMatch[0]);
  }
  if (!Array.isArray(insight.observation) || !Array.isArray(insight.recommendation)) {
    throw new Error('GPT response missing observation/recommendation arrays');
  }
  return insight;
}

const CATEGORY_SYSTEM_PROMPT = `You classify website domains into a short industry/topical category label (2-3 words, e.g. "Information Technology", "Mass Media", "Security Products & Services", "Education", "Computers & Electronics"). Respond with ONLY a valid JSON object mapping each input domain to a category string, no markdown, no explanation: {"example.com": "Information Technology", ...}`;

/**
 * Approximates SEMrush's UI-only "referring domain category" breakdown —
 * their public API doesn't export a category column, only an undocumented
 * filter. One cached, cheap call per client per refresh; clearly an
 * approximation, not SEMrush's native taxonomy.
 */
async function categorizeReferringDomains(domains) {
  if (!domains.length) return {};
  const list = domains.slice(0, 25).map(d => d.domain);

  const completion = await getClient().chat.completions.create({
    model: 'gpt-4o-mini',
    max_tokens: 500,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: CATEGORY_SYSTEM_PROMPT },
      { role: 'user', content: list.join('\n') },
    ],
  });

  try {
    return JSON.parse(completion.choices[0]?.message?.content || '{}');
  } catch {
    return {};
  }
}

module.exports = { generateModuleInsight, categorizeReferringDomains };
