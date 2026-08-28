// ── Deciding what to ask ─────────────────────────────────────────────────────
//
// A bad prompt set makes the whole report noise, and it is the part of this
// module a model cannot rescue: measuring the wrong questions precisely is
// still measuring the wrong questions.
//
// Four sources were asked for. Three are reachable from stored data:
//
//   category    generated from the primary domain and the competitor set.
//               Works on day one with no setup, which matters because the
//               alternative is a feature nobody can try.
//   cluster     Content Architect's topic clusters (hub_spoke payload
//               `clusters[].name`). This is the one that makes the cross-module
//               insight possible — an absence maps to a cluster, and a cluster
//               maps to a missing hub page.
//   manual      whatever a human typed. Overrides everything.
//
// The fourth, SEMrush keywords, is NOT built and is not silently dropped: the
// competitor module stores `clientKeywordBuckets` as COUNTS ({page1: 18,
// total: 100}), not keyword text. Getting the actual terms needs a fresh
// SEMrush call at ~1,955 units per domain, which is a spend decision rather
// than a wiring one. `unavailableSources()` names it so the UI can say why it
// is missing instead of leaving a checkbox that does nothing (PRD §30).

const { createLlmClient } = require('../../services/llmProviders');
const { chatParams } = require('../../locationPageBuilder/llmParams');

const MODEL = 'claude-sonnet-5';

// DataForSEO surfaces cap the keyword; anything longer is a badly-shaped prompt.
const MAX_PROMPT_CHARS = 500;

const SOURCES = { CATEGORY: 'competitor', CLUSTER: 'cluster', KEYWORD: 'keyword', MANUAL: 'manual' };
const INTENTS = ['commercial', 'informational', 'navigational', 'comparison'];

/** Same normalisation the unique index uses, so the two cannot disagree. */
function normalise(text) {
  return String(text || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Merge prompt sets, keeping the highest-trust version of any duplicate.
 *
 * A human-written prompt beats a generated one saying the same thing, so
 * `manual` wins ties. Order otherwise is first-seen, which keeps a reviewed
 * list stable between builds.
 */
function dedupe(prompts) {
  const rank = { [SOURCES.MANUAL]: 0, [SOURCES.CLUSTER]: 1, [SOURCES.KEYWORD]: 2, [SOURCES.CATEGORY]: 3 };
  const byKey = new Map();

  for (const prompt of prompts) {
    const text = String(prompt?.text || '').trim();
    if (!text || text.length > MAX_PROMPT_CHARS) continue;
    const key = normalise(text);
    if (!key) continue;

    const existing = byKey.get(key);
    if (!existing || (rank[prompt.source] ?? 9) < (rank[existing.source] ?? 9)) {
      byKey.set(key, {
        text,
        source: prompt.source || SOURCES.MANUAL,
        sourceRef: prompt.sourceRef || null,
        intent: INTENTS.includes(prompt.intent) ? prompt.intent : null,
      });
    }
  }
  return [...byKey.values()];
}

/**
 * Deterministic prompts, for when the model is unavailable.
 *
 * Crude on purpose — templated category questions and one per cluster. It
 * exists so the feature degrades to something usable rather than to nothing,
 * and so the result is reproducible in a test without an API key.
 */
function templatePrompts({ brandName, competitors = [], clusters = [], country }) {
  const where = country === 'US' ? '' : '';
  const out = [];

  if (brandName) {
    for (const competitor of competitors.slice(0, 3)) {
      out.push({
        text: `${brandName} vs ${competitor} which is better`,
        source: SOURCES.CATEGORY, sourceRef: competitor, intent: 'comparison',
      });
    }
  }

  for (const cluster of clusters.slice(0, 12)) {
    const name = String(cluster?.name || cluster || '').trim();
    if (!name) continue;
    out.push({
      text: `best ${name.toLowerCase()}${where}`,
      source: SOURCES.CLUSTER, sourceRef: name, intent: 'commercial',
    });
  }

  return out;
}

/**
 * Ask the model for buyer-phrased prompts.
 *
 * The job is phrasing, not invention: turn "Teeth Whitening Options" into what
 * somebody actually types into ChatGPT. Prompts naming the brand are excluded
 * except for explicit comparisons — a prompt containing the brand name proves
 * nothing about visibility, because the answer is about whatever was asked for.
 */
async function modelPrompts({ brandName, brandDomain, competitors, clusters, country, count }) {
  const system = 'You write the questions a real buyer types into ChatGPT when they are '
    + 'choosing a provider. Short, natural, lower-case, no punctuation flourishes. '
    + 'They must NOT contain the brand being measured, except where the question is '
    + 'explicitly a comparison between two named companies — a question containing the '
    + 'brand name proves nothing about whether the brand gets recommended. Reply JSON only.';

  const clusterList = clusters.slice(0, 20)
    .map((c) => `- ${c?.name || c}`).join('\n') || '(none)';

  const user = `Brand: ${brandName} (${brandDomain})\n`
    + `Market: ${country || 'US'}\n`
    + `Competitors: ${competitors.join(', ') || '(none known)'}\n`
    + `Topic clusters from their own site:\n${clusterList}\n\n`
    + `Write ${count} questions. Cover a mix: category questions with buying intent, `
    + `informational questions in these topics, and at most 2 head-to-head comparisons.\n\n`
    + 'Return JSON: {"prompts":[{"text":"...","source":"cluster|competitor",'
    + '"sourceRef":"the cluster name or competitor it came from","intent":'
    + '"commercial|informational|comparison"}]}';

  const llm = createLlmClient(MODEL);
  const completion = await llm.chat.completions.create({
    model: llm.model,
    ...chatParams(llm.model, { maxTokens: 2000 }),
    response_format: { type: 'json_object' },
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
  });

  const raw = JSON.parse(completion.choices?.[0]?.message?.content || '{}');
  const list = Array.isArray(raw.prompts) ? raw.prompts : [];

  return list
    .map((p) => ({
      text: String(p?.text || '').trim(),
      source: p?.source === SOURCES.CLUSTER ? SOURCES.CLUSTER : SOURCES.CATEGORY,
      sourceRef: p?.sourceRef ? String(p.sourceRef).slice(0, 120) : null,
      intent: INTENTS.includes(p?.intent) ? p.intent : null,
    }))
    .filter((p) => p.text);
}

/**
 * Build the prompt set for a project.
 *
 * Never throws: a model failure downgrades to templates rather than taking the
 * run with it. The result says which path it took so the UI can be honest about
 * how the questions were chosen.
 *
 * @returns {Promise<{prompts, method, model, error, unavailable}>}
 */
async function buildPrompts({
  brandName, brandDomain, competitors = [], clusters = [], country = 'US',
  manual = [], count = 20,
} = {}) {
  const manualPrompts = manual.map((text) => ({
    text, source: SOURCES.MANUAL, sourceRef: null, intent: null,
  }));

  let generated = [];
  let error = null;
  let usedModel = false;

  if (brandName) {
    try {
      generated = await modelPrompts({
        brandName, brandDomain, competitors, clusters, country,
        count: Math.max(1, count - manualPrompts.length),
      });
      usedModel = generated.length > 0;
    } catch (e) {
      error = e.message;
    }
  }

  if (!generated.length) {
    generated = templatePrompts({ brandName, competitors, clusters, country });
  }

  const prompts = dedupe([...manualPrompts, ...generated]).slice(0, count);

  return {
    prompts,
    method: usedModel ? 'model' : 'template',
    model: usedModel ? MODEL : null,
    error,
    unavailable: unavailableSources({ clusters }),
  };
}

/**
 * Sources that could have contributed and did not, with the reason.
 *
 * Named rather than hidden: a prompt set built without the client's clusters is
 * a weaker set, and the person reading the report should know that rather than
 * discovering it when the cross-module insight never fires.
 */
function unavailableSources({ clusters = [] } = {}) {
  const out = [];
  if (!clusters.length) {
    out.push({
      source: SOURCES.CLUSTER,
      reason: 'Content Architect has not produced clusters for this client, so no prompt '
        + 'is grounded in their own topics.',
    });
  }
  out.push({
    source: SOURCES.KEYWORD,
    reason: 'SEMrush keyword text is not stored — the competitor module keeps only bucket '
      + 'counts. Using real keywords needs a fresh SEMrush call (~1,955 units per domain).',
  });
  return out;
}

/** One line for the report, saying how the questions were chosen. */
function basis({ method, model, error, prompts }) {
  const n = prompts?.length ?? 0;
  if (method === 'model') return `${n} prompts written by ${model} from the client's topics and competitors`;
  return `${n} prompts from templates over the client's clusters and competitors`
    + (error ? ` — the model was unavailable (${error})` : '');
}

module.exports = {
  SOURCES,
  INTENTS,
  MAX_PROMPT_CHARS,
  normalise,
  dedupe,
  templatePrompts,
  modelPrompts,
  buildPrompts,
  unavailableSources,
  basis,
};
