// ── Who each answer recommends ──────────────────────────────────────────────
//
// Gap analysis used to see only the competitors configured on the project. A
// project whose configured competitors never appear in the answers — US
// retailers on an India-facing project, or none at all — read "no gaps" while
// every answer was recommending somebody else. This reads, per answer, the
// businesses it actually puts forward as options, so a gap is "an answer that
// recommends others and not you", whoever the others are.
//
// Every name must appear in the answer it is claimed for (the same verbatim
// guard describe.js applies to quotes), so a name the model invents never
// reaches a report.

const { createLlmClient } = require('../../services/llmProviders');
const { chatParams } = require('../../locationPageBuilder/llmParams');
const { namesBrand } = require('../aiVisibility/capture');
const { flatten, parseReply } = require('./describe');

const MODEL = process.env.AIVL_BRANDS_MODEL || 'gpt-4o-mini';
const BATCH = 8;
const PARALLEL = 3;
const MAX_CHARS = 3_000;
const MAX_NAMES = 15;

// Stamped on every stored result; older ones are re-read (routes.js backfill).
//   2  only businesses competing for the buyer's choice, not tools/channels
const BRANDS_VERSION = 2;

const SYSTEM = `You are reading answers that AI assistants gave to buyers. Each comes with the
buyer's question. For EACH answer, list the businesses the answer puts forward as options for
what the buyer asked — the companies, brands, stores, agencies, practices or products it
recommends or names as choices.

Include a business whether it is praised, simply listed, or compared.

Only businesses that compete to be CHOSEN for what the buyer asked: if they asked for an
agency, the agencies; for a store, the stores and brands on offer; for a dentist, the
practices.

Do NOT include:
- the business named in "exclude", or any of its branches
- platforms, tools, ad channels or software the answer mentions in passing ("Google
  Ads", "GA4", "LinkedIn", "HubSpot") — unless the buyer asked for that kind of product
- publications, review sites or directories cited as sources ("according to Clutch")
- generic categories ("digital agencies", "online marketplaces")
- people

Copy each name exactly as the answer writes it. An empty list is correct when the answer
names no business.

Return ONLY raw JSON: {"answers": [{"i": the answer's index, "names": ["..."]}]}`;

/**
 * One batch's reply, kept only where each name really is in its answer and is
 * not the client.
 */
function interpretBrands(parsed, texts, clientNames = []) {
  const haystack = texts.map(flatten);
  const out = new Map();
  for (const item of parsed?.answers || []) {
    const i = Number(item?.i);
    if (!Number.isInteger(i) || i < 0 || i >= texts.length || out.has(i)) continue;
    const seen = new Set();
    const names = [];
    for (const raw of item?.names || []) {
      const name = String(raw || '').replace(/\s+/g, ' ').trim();
      const key = name.toLowerCase();
      if (name.length < 2 || name.length > 60 || seen.has(key)) continue;
      if (!haystack[i].includes(flatten(name))) continue;
      if (clientNames.length && namesBrand(name, clientNames)) continue;
      seen.add(key);
      names.push(name);
      if (names.length >= MAX_NAMES) break;
    }
    out.set(i, names);
  }
  return out;
}

/**
 * The businesses each captured answer recommends.
 *
 * @returns {Promise<Array<{runId, promptId, engine, names: string[], v}>>}
 *   one entry per answer read, including those naming nobody (names: []) so
 *   they are not re-read; a failed batch costs only its own answers.
 */
async function extractAnswerBrands({ rows, brand }) {
  const answers = (rows || []).filter((r) => r.status === 'captured' && r.answerText);
  if (!answers.length) return [];
  const clientNames = [brand?.name, ...(brand?.aliases || [])].filter(Boolean);

  const client = createLlmClient(MODEL);
  const batches = [];
  for (let i = 0; i < answers.length; i += BATCH) batches.push(answers.slice(i, i + BATCH));

  const readBatch = async (batch) => {
    const texts = batch.map((r) => String(r.answerText).slice(0, MAX_CHARS));
    try {
      const res = await client.chat.completions.create({
        model: client.model,
        response_format: { type: 'json_object' },
        ...chatParams(client.model, { maxTokens: 1500, temperature: 0 }),
        messages: [
          { role: 'system', content: SYSTEM },
          {
            role: 'user',
            // The buyer's question travels with each answer: what counts as
            // "a business competing to be chosen" depends on what was asked.
            content: JSON.stringify({
              exclude: brand?.name,
              answers: texts.map((text, i) => ({ i, question: batch[i].prompt || null, text })),
            }),
          },
        ],
      });
      const found = interpretBrands(parseReply(res.choices?.[0]?.message?.content), texts, clientNames);
      return [...found.entries()].map(([i, names]) => ({
        runId: batch[i].runId || null,
        promptId: batch[i].promptId || null,
        engine: batch[i].engine || null,
        names,
        v: BRANDS_VERSION,
      }));
    } catch (e) {
      console.warn(`[aiVisibilityLite] brand batch skipped (${e.message})`);
      return [];
    }
  };

  const results = [];
  for (let i = 0; i < batches.length; i += PARALLEL) {
    // eslint-disable-next-line no-await-in-loop
    const done = await Promise.all(batches.slice(i, i + PARALLEL).map(readBatch));
    done.forEach((d) => results.push(...d));
  }
  return results;
}

module.exports = {
  BRANDS_VERSION, extractAnswerBrands, interpretBrands,
};
