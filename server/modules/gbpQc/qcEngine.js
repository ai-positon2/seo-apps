// GBP post quality-check engine — one system prompt per client (their full
// brand guidelines embedded verbatim) + a stage-specific user prompt, run
// through OpenAI JSON mode. Ported from the standalone gbp-qc-agent tool;
// the scoring rubric and "only flag genuine violations" rules below are
// tuned prompt text, not to be paraphrased.
const OpenAI = require('openai');
const baseCheck = require('./stages/baseCheck');
const expandedCheck = require('./stages/expandedCheck');
const contentGenerator = require('./stages/contentGenerator');

const MODEL = 'gpt-4o-mini';
const GENERATE_MODEL = 'gpt-4o-mini';

function hasOpenAiKey() {
  const k = process.env.OPENAI_API_KEY;
  return !!k && k !== 'your_openai_api_key_here';
}

let _client = null;
function client() {
  if (!_client) _client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _client;
}

function buildSystemPrompt(guidelines) {
  const guidelinesJson = JSON.stringify(guidelines, null, 2);
  return `You are a precise GBP (Google Business Profile) Quality Check Agent for ${guidelines.client_name}.

Your task is to review GBP post content against the brand guidelines below and return a structured JSON result.

## Client Brand Guidelines
\`\`\`json
${guidelinesJson}
\`\`\`

## Scoring
- 90-100 -> Overall Status: "Pass"
- 70-89  -> Overall Status: "Needs Minor Edits"
- 0-69   -> Overall Status: "Needs Major Edits"

## Critical Rules for Flagging Issues
- ONLY flag genuine, clear violations of explicit rules stated in the guidelines.
- Examples in the guidelines (cta_examples, approved_safe_phrases, etc.) are illustrations of acceptable style — they are NOT exact required phrases. Never flag content simply because it uses different wording than an example.
- CTA check: A CTA PASSES if it is (1) present at the end of the post, (2) clear and action-oriented, and (3) uses the correct brand name where the guidelines require it. Synonyms like "book an appointment", "schedule a visit", "make an appointment", "call us today" are all equally valid CTAs.
- Do NOT flag phrasing preferences or stylistic differences. Only flag actual rule violations.
- For every issue you flag, you MUST cite the specific rule or guideline being violated in the "reason" field.
- If you are uncertain whether something is a genuine violation, do NOT flag it.
- A post with a clear CTA, correct brand name, correct character count, and no banned phrases should score very high even if phrasing differs from the examples.

## Response Format
Respond ONLY with a valid JSON object — no markdown fences, no extra text:
{
  "overall_status": "Pass" | "Needs Minor Edits" | "Needs Major Edits",
  "qc_score": <integer 0-100>,
  "passed_checks": ["<specific check that passed>"],
  "issues_found": [
    {
      "severity": "major" | "minor",
      "check": "<check category>",
      "issue": "<specific description of the violation>",
      "reason": "<the exact rule or guideline being violated — quote it directly>"
    }
  ],
  "recommended_fixes": ["<specific actionable fix>"],
  "suggested_edited_version": "<complete corrected post if fixes are needed, otherwise empty string>",
  "final_approval_recommendation": "<one clear paragraph stating whether to approve, reject, or revise>"
}`;
}

async function call(model, temperature, systemPrompt, userPrompt) {
  const response = await client().chat.completions.create({
    model,
    max_tokens: 2048,
    temperature,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    response_format: { type: 'json_object' },
  });

  const raw = (response.choices[0].message.content || '').trim();
  try {
    return JSON.parse(raw);
  } catch (e) {
    return {
      overall_status: 'Error',
      qc_score: 0,
      passed_checks: [],
      issues_found: [
        { severity: 'major', check: 'System Error', issue: `Failed to parse QC result: ${e.message}` },
      ],
      recommended_fixes: ['Please try again. If the problem persists, check your API key.'],
      suggested_edited_version: '',
      final_approval_recommendation: `QC check failed due to a parsing error. Raw response snippet: ${raw.slice(0, 300)}`,
    };
  }
}

async function checkBaseContent(guidelines, { topic, content, postType, location = '' }) {
  const systemPrompt = buildSystemPrompt(guidelines);
  const userPrompt = baseCheck.buildPrompt(topic, content, postType, location);
  return call(MODEL, 0, systemPrompt, userPrompt);
}

async function checkExpandedContent(guidelines, { baseContent, expandedContent, postType, location }) {
  const systemPrompt = buildSystemPrompt(guidelines);
  const userPrompt = expandedCheck.buildPrompt(baseContent, expandedContent, postType, location);
  return call(MODEL, 0, systemPrompt, userPrompt);
}

async function generateLocationContent(guidelines, { baseContent, location, postType }) {
  const locationContext = await contentGenerator.fetchLocationContext(location, guidelines);
  const systemPrompt = buildSystemPrompt(guidelines);
  const userPrompt = contentGenerator.buildPrompt(baseContent, location, postType, locationContext, guidelines);
  const result = await call(GENERATE_MODEL, 0.35, systemPrompt, userPrompt);

  // Overwrite the model's self-reported count with our own — the source of truth.
  const fullPost = result.full_post || '';
  result.character_count = fullPost.length;
  result.within_limit = fullPost.length <= 1500;
  return result;
}

module.exports = { hasOpenAiKey, checkBaseContent, checkExpandedContent, generateLocationContent };
