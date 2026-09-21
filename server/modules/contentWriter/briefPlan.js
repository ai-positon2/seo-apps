// One planning pass over a generated outline, run on Claude Sonnet 5.
//
// It decides two things the brief generator cannot: where CSQAF elements
// genuinely belong across the whole article, and which of the writer's own
// secondary keywords fit which section. Both are judgement calls about the
// article as a composition, which is why they are one call and not two.
//
// This module is the only Anthropic caller in Content Writer; everything else
// in the module runs on OpenAI. Keep them in separate files.

const Anthropic = require('@anthropic-ai/sdk');
const { z } = require('zod');
const { isFaq } = require('./document');

const MODEL = 'claude-sonnet-5';
const MAX_TOKENS = 16000;
const TIMEOUT_MS = 120000; // The Node SDK takes milliseconds.
// Whole-article budgets. CSQAF is a composition, not a checklist to repeat
// under every heading, so most sections are expected to receive nothing.
const MAX_CITATIONS = 8, MAX_STATISTICS = 4, MAX_TABLES = 2;

const slotSchema = { type: 'object', additionalProperties: false,
  properties: { sectionId: { type: 'string' }, what: { type: 'string' } }, required: ['sectionId', 'what'] };
const OUTPUT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['citations', 'statistics', 'quotations', 'tables', 'keywords'],
  properties: {
    citations: { type: 'array', items: slotSchema },
    statistics: { type: 'array', items: slotSchema },
    // An array of at most one, rather than a nullable object: simpler to validate.
    quotations: { type: 'array', items: slotSchema },
    tables: { type: 'array', items: { type: 'object', additionalProperties: false,
      properties: { sectionId: { type: 'string' }, what: { type: 'string' },
        columns: { type: 'array', items: { type: 'string' } } },
      required: ['sectionId', 'what', 'columns'] } },
    keywords: { type: 'array', items: { type: 'object', additionalProperties: false,
      properties: { sectionId: { type: 'string' }, keyword: { type: 'string' } },
      required: ['sectionId', 'keyword'] } },
  },
};
const slot = z.object({ sectionId: z.string().max(100), what: z.string().max(600) });
const planSchema = z.object({
  citations: z.array(slot).max(MAX_CITATIONS).default([]),
  statistics: z.array(slot).max(MAX_STATISTICS).default([]),
  quotations: z.array(slot).max(1).default([]),
  tables: z.array(slot.extend({ columns: z.array(z.string().max(120)).max(8).default([]) })).max(MAX_TABLES).default([]),
  keywords: z.array(z.object({ sectionId: z.string().max(100), keyword: z.string().max(200) })).max(40).default([]),
});

const INSTRUCTIONS = `You are an expert SEO content strategist planning one article from its outline.

CSQAF placement. CSQAF is Citations, Statistics, Quotations, Authoritativeness and Fluency. Decide where each element genuinely earns its place across the whole article. Do not spread them evenly and do not assign something to every section: most sections should receive nothing at all.
Budgets for the entire article, not per section: at most ${MAX_CITATIONS} citations, 2 to ${MAX_STATISTICS} statistics, at most one quotation, at most ${MAX_TABLES} tables. Use fewer when fewer are warranted.
Place a citation where the section makes a claim a reader would reasonably question. Place a statistic where a dated figure changes the reader's decision, not as decoration. Place the single quotation where an expert voice adds the most authority. Place a table only where the content is genuinely comparative or multi-dimensional, and say which columns it needs. Never target the Frequently Asked Questions section with a table or the quotation.
Describe what is needed. Never invent the figure, source, speaker or data itself.

Keyword assignment. You are given the writer's own secondary keywords. Assign a keyword to a section only where it is genuinely what that section is about and would appear naturally in that prose.
Do not force fit. Leaving a keyword unassigned is the correct answer whenever no section is a natural home for it, and it is better to return few assignments than to stretch a section around a keyword. Never assign a keyword to a section merely to use it up, and never assign the same keyword twice. A section may take more than one keyword only when each is genuinely on topic for it.

Use only the sectionId values supplied to you, and only the keywords supplied to you.`;

function hasKey() {
  const key = process.env.ANTHROPIC_API_KEY;
  return Boolean(key) && key !== 'your_anthropic_api_key_here';
}

let cachedClient = null;
function client() {
  if (!cachedClient) {
    // The constructor has moved between the default and named export across
    // versions; the aiVisibilityLite surfaces resolve it the same way.
    const Ctor = Anthropic.default || Anthropic;
    cachedClient = new Ctor({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: TIMEOUT_MS, maxRetries: 1 });
  }
  return cachedClient;
}

function parseSecondary(value) {
  return [...new Set(String(value || '').split(/[,\n]/).map(k => k.trim()).filter(Boolean))];
}

function applyPlan(brief, plan) {
  const lines = new Map();
  const add = (sectionId, line, allowFaq = true) => {
    const section = brief.sections.find(s => s.id === sectionId);
    if (!section || (!allowFaq && isFaq(section.heading))) return false;
    lines.set(sectionId, [...(lines.get(sectionId) || []), line]);
    return true;
  };
  const assigned = new Set();
  for (const k of plan.keywords) {
    // One home per keyword, whatever the model returned.
    if (assigned.has(k.keyword.toLowerCase())) continue;
    if (add(k.sectionId, `- Keyword: ${k.keyword}`)) assigned.add(k.keyword.toLowerCase());
  }
  for (const c of plan.citations) add(c.sectionId, `- Citation: ${c.what}`);
  for (const s of plan.statistics) add(s.sectionId, `- Statistic: ${s.what}`);
  for (const q of plan.quotations) add(q.sectionId, `- Quotation: ${q.what}`, false);
  for (const t of plan.tables) {
    add(t.sectionId, `- Table: ${t.what}${t.columns.length ? ` (columns: ${t.columns.join(', ')})` : ''}`, false);
  }
  return {
    brief: {
      ...brief,
      sections: brief.sections.map(s => (lines.has(s.id)
        ? { ...s, guidance: `${s.guidance}\n\nCSQAF:\n${lines.get(s.id).join('\n')}`.trim() }
        : s)),
    },
    assigned,
  };
}

async function planBrief(brief, { keyword, targetWords, secondaryKeywords }, emit = () => {}, deps = {}) {
  if (!deps.llm && !hasKey()) {
    throw Object.assign(new Error(
      'Brief planning needs ANTHROPIC_API_KEY, which is not configured. '
      + 'Set it on the server and rebuild the brief.'), { status: 503, code: 'anthropic_not_configured' });
  }
  const llm = deps.llm || client();
  const secondary = parseSecondary(secondaryKeywords);
  emit('step', { id: 'plan', status: 'active',
    message: 'Planning citations, statistics, a quotation, tables and keyword placement with Claude Sonnet 5…' });
  const response = await llm.messages.create({
    model: MODEL, max_tokens: MAX_TOKENS,
    thinking: { type: 'adaptive' },
    output_config: { format: { type: 'json_schema', schema: OUTPUT_SCHEMA } },
    system: INSTRUCTIONS,
    messages: [{ role: 'user', content: JSON.stringify({
      keyword, targetWords: targetWords || null, secondaryKeywords: secondary,
      sections: brief.sections.map(s => ({ sectionId: s.id, level: s.level, heading: s.heading,
        guidance: s.guidance.slice(0, 800) })),
    }) }],
  });
  // A refusal or a truncated answer is a failed plan, not an empty one.
  if (response.stop_reason === 'refusal') {
    throw new Error(`Brief planning was declined (${response.stop_details?.category || 'unspecified'}).`);
  }
  if (response.stop_reason === 'max_tokens') throw new Error('The brief plan response was incomplete.');
  const text = (response.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
  const plan = planSchema.parse(JSON.parse(text));
  const { brief: planned, assigned } = applyPlan(brief, plan);
  const unused = secondary.filter(k => !assigned.has(k.toLowerCase()));
  if (unused.length) {
    emit('warning', { message: `${unused.length} secondary keyword${unused.length === 1 ? '' : 's'} had no natural home in this outline and ${unused.length === 1 ? 'was' : 'were'} left unassigned: ${unused.join(', ')}. Add a section for them if they matter.` });
  }
  emit('step', { id: 'plan', status: 'done',
    message: `Planned ${plan.citations.length} citations, ${plan.statistics.length} statistics, ${plan.quotations.length} quotation, ${plan.tables.length} tables, ${assigned.size}/${secondary.length} keywords placed` });
  return { brief: planned, plan: { ...plan, unusedKeywords: unused } };
}

module.exports = { planBrief, applyPlan, parseSecondary, hasKey, planSchema, MODEL };
