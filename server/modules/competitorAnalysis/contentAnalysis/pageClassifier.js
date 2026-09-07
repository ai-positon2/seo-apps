// ── Page classification: Claude Sonnet 5, then the rules ────────────────────
//
// The model decides; pageRules.js constrains. Claude Sonnet 5 reads each URL
// with its title and returns a subtype, a confidence, and a runner-up; the pure
// rule layer then applies the spec's precedence — utility overrides, entity
// intersections, the landing-page guard, the confidence floor — and derives the
// facets. Neither half is trusted alone: the model brings judgement the URL
// cannot carry, the rules bring the parts that are not a judgement call.
//
// Bounded by construction: at most 25 top pages per domain over at most 5
// domains, so 125 URLs is the ceiling for a whole run, and the token budget is
// set against that rather than against however large a site happens to be. The
// classifier this replaced sized its output cap against a site's folder-pattern
// count, and a 581-pattern site silently overran it and typed every page
// "other".
const Anthropic = require('@anthropic-ai/sdk');
const {
  SUBTYPES, SUBTYPE_HINTS, FAMILIES, TAXONOMY_VERSION,
} = require('./pageTaxonomy');
const { classifyPage } = require('./pageRules');

const MODEL = 'claude-sonnet-5';

// Bumped when the PROMPT or the request shape changes, independently of
// TAXONOMY_VERSION — so a stored crawl can be diffed after a taxonomy change and
// after a classifier change, and the two are told apart.
const CLASSIFIER_VERSION = '2.0.0';

const MAX_PAGES_PER_CALL = 125;
const MAX_TOKENS = 16000;

// Grouped by family, because that is how the taxonomy is meant to be read: pick
// the family, then the leaf inside it.
const TAXONOMY_BLOCK = Object.entries(FAMILIES)
  .map(([family, subs]) => `${family.toUpperCase()}\n`
    + subs.map((s) => `  ${s} — ${SUBTYPE_HINTS[s]}`).join('\n'))
  .join('\n\n');

const SCHEMA = {
  type: 'object',
  properties: {
    pages: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          i: { type: 'integer', description: 'the page number given in the list' },
          subtype: { type: 'string', enum: SUBTYPES },
          confidence: { type: 'number', description: '0 to 1' },
          secondary: { type: 'string', enum: SUBTYPES, description: 'the runner-up, when there is a real one' },
          secondary_confidence: { type: 'number' },
          reason: { type: 'string', description: 'why this was hard, when confidence is below 0.5' },
        },
        required: ['i', 'subtype', 'confidence'],
        additionalProperties: false,
      },
    },
  },
  required: ['pages'],
  additionalProperties: false,
};

const SYSTEM = 'You are a web information architect. You are given real page URLs, each with its '
  + '<title> where one could be read. Classify each page into exactly ONE subtype from the '
  + 'taxonomy below.\n\n'
  + TAXONOMY_BLOCK
  + '\n\nHow to judge:\n'
  + '- Read the URL path and the title together. A path token is stronger evidence than a title '
  + 'phrase, but a title often settles what a slug leaves ambiguous.\n'
  + '- Prefer the MOST SPECIFIC subtype that fits. "a service in a named city" is location_service, '
  + 'not service. An individual job description is job_posting, not careers_hub.\n'
  + '- Distinguish one entity from a list of them: blog_post vs blog_index, case_study vs '
  + 'case_study_index, location vs location_directory.\n'
  + '- Do NOT assign "landing" just because a page is persuasive or converts well. It means '
  + 'campaign-scoped: stripped navigation, paid entry, or excluded from the sitemap.\n'
  + '- Use "unclassified" only when nothing fits, and give a reason when you do.\n'
  + '- confidence is your own: 0.9+ when the URL and title agree and the subtype is unambiguous, '
  + '0.4-0.6 when you are choosing between two plausible subtypes, below 0.4 when you are guessing. '
  + 'Give `secondary` whenever a second subtype was genuinely close.';

function isAnthropicConfigured() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

function buildClient() {
  const Ctor = Anthropic.default || Anthropic;
  return new Ctor({ apiKey: process.env.ANTHROPIC_API_KEY });
}

async function classifyBatch(client, batch) {
  const lines = batch
    .map((p, i) => `${i}. ${p.fullUrl}\n   title: ${p.title || '(unavailable)'}`)
    .join('\n');

  const response = await client.messages.parse({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    // Sonnet 5 takes adaptive thinking only; a token budget is rejected. Low
    // effort suits bulk classification against a supplied taxonomy.
    thinking: { type: 'adaptive' },
    output_config: {
      effort: 'low',
      format: { type: 'json_schema', schema: SCHEMA },
    },
    system: SYSTEM,
    messages: [{
      role: 'user',
      content: `${lines}\n\nClassify every page above. Return one entry per page, using the `
        + 'number shown for that page.',
    }],
  });

  // Read BEFORE the content. A refusal and a truncation both return HTTP 200
  // with usable-looking content, and going straight to the body is how the
  // previous classifier turned a half-written reply into a run of "other".
  if (response.stop_reason === 'refusal') {
    const detail = response.stop_details?.explanation || response.stop_details?.category || 'no reason given';
    throw new Error(`Claude declined to classify this batch (${detail}).`);
  }
  if (response.stop_reason === 'max_tokens') {
    throw new Error(
      `The classification reply hit the ${MAX_TOKENS}-token ceiling with ${batch.length} pages, `
      + 'so it is incomplete. Lower MAX_PAGES_PER_CALL.',
    );
  }

  const parsed = response.parsed_output
    ?? JSON.parse(response.content.find((b) => b.type === 'text')?.text || '{}');

  const verdicts = new Map();
  for (const item of parsed.pages || []) {
    const index = Number(item.i);
    if (!Number.isInteger(index) || !batch[index]) continue;
    verdicts.set(index, {
      subtype: item.subtype,
      confidence: Number(item.confidence),
      secondary: item.secondary || null,
      secondaryConfidence: Number.isFinite(item.secondary_confidence) ? item.secondary_confidence : null,
      reason: item.reason || null,
    });
  }
  return verdicts;
}

/**
 * Classifies the run's top pages and applies the precedence rules.
 *
 * A page the model did not return an entry for is still classified — as
 * `unclassified`, with a reason saying so. Leaving it absent would let a partial
 * reply look like a complete one, which is the failure this whole redesign is
 * about.
 *
 * @param {Array<{fullUrl: string, title: ?string}>} pages
 * @returns {Promise<Map<string, object>>} fullUrl → ClassificationResult
 */
async function classifyTopPages(pages) {
  const out = new Map();
  const list = (pages || []).filter((p) => p && p.fullUrl);
  if (!list.length) return out;
  if (!isAnthropicConfigured()) {
    throw new Error('ANTHROPIC_API_KEY is not configured, so top pages cannot be classified.');
  }

  const client = buildClient();
  const classifiedAt = new Date().toISOString();

  for (let start = 0; start < list.length; start += MAX_PAGES_PER_CALL) {
    const batch = list.slice(start, start + MAX_PAGES_PER_CALL);
    // eslint-disable-next-line no-await-in-loop
    const verdicts = await classifyBatch(client, batch);

    batch.forEach((page, i) => {
      const verdict = verdicts.get(i) || {
        subtype: 'unclassified',
        confidence: 0,
        reason: 'The classifier returned no entry for this page.',
      };
      out.set(page.fullUrl, {
        ...classifyPage(page, verdict),
        taxonomy_version: TAXONOMY_VERSION,
        classifier_version: CLASSIFIER_VERSION,
        classified_at: classifiedAt,
      });
    });
  }

  return out;
}

module.exports = {
  classifyTopPages,
  MODEL, CLASSIFIER_VERSION, MAX_PAGES_PER_CALL, isAnthropicConfigured,
};
