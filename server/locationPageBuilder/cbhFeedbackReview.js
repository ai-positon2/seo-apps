// ── AI review of a page against the client feedback rules ──────────────────
// The regex checks in cbhFeedback catch wording. They cannot tell whether a
// stress page's "when it becomes a concern" section is really about anxiety,
// or whether a symptoms list reads like a medical emergency. Each rule that
// needs that judgement carries a `review` question, and this asks all of a
// page's questions in ONE call.
//
// The reviewer must quote the text it objects to. A quote that is not actually
// on the page is kept, but marked unverified, and QC reports it at Minor for a
// person to look at. A model that invents a problem should not be able to fail
// a page at Critical.

const config = require('./config');
const contract = require('./cbhContract');
const fb = require('./cbhFeedback');
const llmProviders = require('../services/llmProviders');
const { chatParams } = require('./llmParams');

// The writer and the reviewer share a provider, so the tests route the stub on
// this phrase. It is also the reviewer's opening line.
const REVIEWER_MARKER = 'You check a finished web page against a client\'s content rules';

function norm(s) {
  return String(s || '').toLowerCase()
    .replace(/\*\*/g, '')
    .replace(/[‘’]/g, '\'')
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function systemPrompt() {
  return `${REVIEWER_MARKER} for ${contract.BRAND}, a behavioral health provider.

You are given the page's text, labelled by section, and a numbered list of rules. Each rule has a
question; answer it for THIS page. Judge only what the rule asks. Do not raise style, SEO or
length issues, and do not invent rules of your own.

For a rule the page breaks, quote the exact words on the page that break it: copy them verbatim
from the page text, at most 200 characters, with nothing added. Then say in one sentence how to fix
it. If you cannot point to specific words, the page complies.

Return ONLY JSON:
{ "results": [{ "ruleKey": "string", "compliant": true, "section": "string", "evidence": "string", "fix": "string" }] }
One entry per rule, using the rule's key. "section" is the label of the section the quote is from.`;
}

function userPrompt(page, rules) {
  const ctx = fb.pageContext(page);
  const program = ctx.programGroups.map(g => fb.PROGRAM_LABELS[g] || g).join(', ');
  const list = rules.map((r, i) => {
    const q = r.checks.filter(c => c.type === 'review').map(c => fb.fill(c.question, ctx)).join(' ');
    return `${i + 1}. key: ${r.key}\n   Question: ${q}\n   The client's rule: ${fb.fill(r.instruction, ctx)}`;
  }).join('\n');
  const body = fb.pageDoc(page).pieces
    .filter(p => !String(p.section).startsWith('meta.'))
    .map(p => `[${p.section}] ${p.text}`)
    .join('\n');
  return `PAGE: ${ctx.service} in ${ctx.city}${program ? `\nPROGRAM: ${program}` : ''}

RULES
${list}

PAGE TEXT
${body}

Return JSON only.`;
}

// Throws on a provider error or two unusable responses; safeReviewPage below
// is what the pipeline calls.
async function reviewPage(page, rules) {
  const reviewRules = fb.reviewRulesFor(page, rules);
  if (!reviewRules.length) return null;

  const llm = llmProviders.createLlmClient(config.llm.cbhFeedbackReviewModel);
  const messages = [{ role: 'system', content: systemPrompt() }, { role: 'user', content: userPrompt(page, reviewRules) }];
  let raw = null;
  for (let attempt = 0; attempt < 2 && !raw; attempt++) {
    const completion = await llm.chat.completions.create({
      model: llm.model,
      // Reasoning headroom: the answer is short, the page is not.
      ...chatParams(llm.model, { maxTokens: 8000 }),
      response_format: { type: 'json_object' },
      messages,
    });
    try {
      const parsed = JSON.parse(completion.choices[0].message.content);
      if (parsed && Array.isArray(parsed.results)) raw = parsed;
    } catch { /* retry once */ }
  }
  if (!raw) throw new Error('The feedback reviewer returned no usable JSON.');

  const pageText = norm(fb.pageDoc(page).pieces.map(p => p.text).join('\n'));
  const keys = new Set(reviewRules.map(r => r.key));
  const seen = new Set();
  const results = raw.results
    .filter(x => x && keys.has(x.ruleKey) && !seen.has(x.ruleKey) && seen.add(x.ruleKey))
    .map((x) => {
      const compliant = x.compliant !== false;
      const evidence = String(x.evidence || '').trim().slice(0, 300);
      return {
        ruleKey: x.ruleKey,
        compliant,
        // Compliant needs no proof. A finding needs a quote that is really there.
        verified: compliant || (!!evidence && pageText.includes(norm(evidence))),
        section: String(x.section || '').trim(),
        evidence: compliant ? '' : contract.removeEmDashes(evidence),
        fix: compliant ? '' : contract.removeEmDashes(String(x.fix || '').trim()),
      };
    });

  return {
    rulesVersion: fb.rulesVersion(reviewRules),
    contentHash: fb.reviewContentHash(page),
    reviewedAt: new Date().toISOString(),
    model: llm.model,
    results,
  };
}

// A reviewer outage must not cost a whole page. The page ships without a
// review, and QC says so (fb_review_missing) until someone re-checks it.
async function safeReviewPage(page, rules) {
  try {
    return await reviewPage(page, rules);
  } catch (e) {
    console.error('[cbhFeedbackReview] review failed, page saved without one:', e.message);
    return null;
  }
}

module.exports = { reviewPage, safeReviewPage, systemPrompt, userPrompt, REVIEWER_MARKER };
