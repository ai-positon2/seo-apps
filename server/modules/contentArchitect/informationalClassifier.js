// ── The model half of informational page selection ──────────────────────────
//
// informationalSelection.js groups a crawl's URLs into templates and decides,
// per template, whether its pages are informational. This file is the only part
// that talks to a model, so the selection itself stays pure and testable with a
// stub in place of this.
//
// Judged from URLs ONLY — the template's pattern and example URLs, or a single
// URL. No titles, no word counts, no content. That was a deliberate product
// decision: the URL is what a person reviewing the site's structure looks at,
// and it keeps the verdict about the page's role rather than its topic.
//
// Two rules carried over from patternClassifier.refineWithAI, for the same
// reasons given there:
//   • the model is never shown a rule-based guess to anchor on;
//   • once a batch returns a well-formed reply, that reply is authoritative — an
//     item the model left out or gave an unknown category becomes "unknown"
//     rather than quietly keeping some other verdict.
// A batch that FAILS (network, timeout, unparseable reply) is asked once more,
// then reported back as failed, so the caller can fall back to a cached verdict
// or the URL rules and say so.

const { createLlmClient, structuredTaskParams, assertNotTruncated } = require('../../services/llmProviders');
const {
  SELECTION_TEMPLATE_BATCH_SIZE, SELECTION_URL_BATCH_SIZE, SELECTION_AI_CONCURRENCY,
  SELECTION_AI_TIMEOUT_MS, SELECTION_AI_MAX_RETRIES, SELECTION_AI_BATCH_ATTEMPTS,
} = require('./config');

// Claude Sonnet through the shared factory, like llmNaming.js and
// contentRelevance.js: the factory handles the JSON-only reinforcement and fence
// stripping that Anthropic's compatible endpoint needs.
const MODEL = 'claude-sonnet-5';

const URL_CATEGORIES = ['informational', 'news', 'service', 'location', 'people', 'listing', 'media', 'other', 'unknown'];
const TEMPLATE_CATEGORIES = [...URL_CATEGORIES.slice(0, -1), 'mixed', 'unknown'];

const CATEGORY_DEFINITIONS = `- informational: content that teaches a subject or answers a question people search for — blog posts,
  articles, guides, how-tos, explainers, glossary or "what is" entries, FAQs, help or knowledge-base articles
  (including help with using the organisation's product or service).
- news: press releases, news posts, events, webinars, and the organisation's own news — awards, rankings,
  hires, verdicts or settlements won, lawsuits filed, investigations announced, event recaps, media mentions.
- service: a service, treatment, procedure, product, solution, plan or pricing page.
- location: a specific office, clinic, branch, store or city page — including a service offered in a named
  city ("/emergency-dentist-austin").
- people: staff, doctor, provider, author or team bios, and directories of them.
- listing: a page that lists other pages — a section index, tag/category/author archive, pagination, search
  results, an HTML sitemap.
- media: podcast episodes and video pages.
- other: about, contact, careers, legal/privacy, booking or appointments, thank-you, case studies, testimonials
  or reviews, galleries, downloadable or gated collateral — white papers, e-books, datasheets, solution briefs,
  analyst reports — and pages about the organisation's own logistics and policies: billing and payment,
  insurance or plans accepted, visiting information, amenities, records requests, customer or patient rights.`;

const JUDGING_RULES = `Judge the page's ROLE, not the topic words in the URL: "/locations/teeth-whitening-raleigh" is a
location page even though it names a treatment, and "/services/dental-implants" is a service page even though
people read it to learn. A blog with only the occasional news post is informational; one where company news,
awards or case announcements are a regular part of the examples is mixed.`;

const HINTS_RULE = `When the request includes "menuSections", those are links from the site's own header and footer
menus whose label names an informational section ("Blog", "Resources", "Learn"). Pages under those paths are
likely informational — but still judge each by its role; a menu can also link a pricing or product page.`;

const TEMPLATE_SYSTEM_PROMPT = `You are an SEO information architect. You are given URL path templates from ONE website.
Each template groups URLs that share a path structure ({slug}, {n} and {date} mark the parts that vary) and comes
with real example URLs spread across it. No page titles or content are available — judge only from the URL
structure and wording: the folder names and the slugs of the examples.

Decide what kind of page each template's URLs are. Categories:
${CATEGORY_DEFINITIONS}
- mixed: the examples are clearly different kinds of pages (say, legal pages next to service pages next to blog
  posts), or a noticeable share of them — roughly one in four or more — is a different kind from the rest
  (a blog whose examples include company news or announcements alongside how-to posts). Use this rather than
  forcing one category onto a template that mixes kinds; its pages are then judged one by one.
- unknown: nothing above fits, or you genuinely cannot tell.

${JUDGING_RULES}

${HINTS_RULE}

Return valid JSON only: {"templates":[{"i": <same i>, "category": "<one category>"}]}. Include every template you
were given.`;

const URL_SYSTEM_PROMPT = `You are an SEO information architect. You are given individual page URLs from ONE website.
No page titles or content are available — judge only from each URL's structure and wording: its folders and its
final slug.

Decide what kind of page each URL is. Categories:
${CATEGORY_DEFINITIONS}
- unknown: nothing above fits, or you genuinely cannot tell.

${JUDGING_RULES}

${HINTS_RULE}

Return valid JSON only: {"urls":[{"i": <same i>, "category": "<one category>"}]}. Include every URL you were
given.`;

// Named for what it gates, as in patternClassifier.hasClassifyKey: without a key
// there is no model half at all and the selection runs on its URL rules.
function hasSelectionKey() {
  const k = process.env.ANTHROPIC_API_KEY;
  return !!k && k !== 'your_anthropic_api_key_here';
}

// Runs `fn` over `items` with at most `limit` in flight, preserving nothing but
// completion — callers key results by the item, never by position.
async function mapWithConcurrency(items, limit, fn) {
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const item = items[next];
      next += 1;
      // eslint-disable-next-line no-await-in-loop
      await fn(item);
    }
  });
  await Promise.all(workers);
}

function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// The model sometimes says "article"; it means what this module calls
// "informational", and refusing it would throw away a correct answer.
function normalizeCategory(value, allowed) {
  const c = String(value || '').trim().toLowerCase();
  if (c === 'article' || c === 'articles') return 'informational';
  return allowed.includes(c) ? c : null;
}

// The JSON object in a reply. Seen live: "Looking at these URLs… {…}" — the
// model narrated before answering, and a strict parse threw the whole batch
// away twice. The outermost {…} is taken when the reply is not pure JSON; a
// reply with no parseable object still throws, so the batch is retried.
function parseJsonReply(raw) {
  const text = String(raw || '').trim();
  try {
    return JSON.parse(text);
  } catch (first) {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end <= start) throw first;
    return JSON.parse(text.slice(start, end + 1));
  }
}

// The category from one reply item. Normally `category`; when the model puts
// it under another key (it has echoed the input's "url" or "pattern" field
// name), the one string value that IS a category is taken. A value that is not
// a known category is never guessed at.
function categoryOf(entry, allowed) {
  if (!entry || typeof entry !== 'object') return null;
  const direct = normalizeCategory(entry.category, allowed);
  if (direct) return direct;
  const candidates = Object.entries(entry)
    .filter(([key, value]) => key !== 'i' && key !== 'category' && typeof value === 'string')
    .map(([, value]) => normalizeCategory(value, allowed))
    .filter(Boolean);
  return candidates.length === 1 ? candidates[0] : null;
}

/**
 * @param {object} [opts]
 * @param {object} [opts.client]  an object shaped like createLlmClient()'s return
 *                                value — injected by tests; built lazily otherwise
 * @returns {object|null} null when there is no API key and no injected client
 */
function createInformationalClassifier({ client: injected = null } = {}) {
  if (!injected && !hasSelectionKey()) return null;

  let llm = injected;
  const getClient = () => {
    if (!llm) llm = createLlmClient(MODEL);
    return llm;
  };

  // One batch → Map(key → category). Throws on anything that is not a
  // well-formed reply, so the caller records the batch as failed.
  async function callBatch({ batch, system, listKey, allowed, maxTokens, toPayload, hints }) {
    const client = getClient();
    const payload = batch.map((item, i) => ({ i, ...toPayload(item) }));
    const completion = await client.chat.completions.create({
      model: client.model || MODEL,
      temperature: 0,
      max_tokens: maxTokens,
      ...structuredTaskParams(client),
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: JSON.stringify({ [listKey]: payload, ...(hints?.length ? { menuSections: hints } : {}) }) },
      ],
    }, { timeout: SELECTION_AI_TIMEOUT_MS, maxRetries: SELECTION_AI_MAX_RETRIES });

    assertNotTruncated(completion);
    const raw = completion?.choices?.[0]?.message?.content || '{}';
    const parsed = parseJsonReply(raw);
    if (!Array.isArray(parsed[listKey])) throw new Error(`response missing "${listKey}" array`);

    const answered = new Map();
    for (const entry of parsed[listKey]) {
      const index = Number(entry?.i);
      if (!Number.isInteger(index) || !batch[index]) continue; // an invented index — ignored
      const category = categoryOf(entry, allowed);
      if (category) answered.set(batch[index].key, category);
    }
    // A reply in which not one item carries a usable category is not an
    // answer — seen live: a whole 100-URL batch came back as
    // {"i":0,"url":"other"}, the category written under the input's field
    // name. Treated as a failed call, so it is asked again rather than every
    // item quietly becoming "unknown".
    if (batch.length && !answered.size) throw new Error('the reply carried no usable categories');
    // A real reply is authoritative: anything it left out is "unknown", not a
    // silent keep of some other verdict.
    for (const item of batch) if (!answered.has(item.key)) answered.set(item.key, 'unknown');
    return answered;
  }

  async function run(items, { batchSize, system, listKey, allowed, maxTokens, toPayload, deadline, hints }) {
    const verdicts = new Map();
    const failedKeys = new Set();
    const skippedKeys = new Set();
    let batches = 0;
    let error = null;

    await mapWithConcurrency(chunk(items, batchSize), SELECTION_AI_CONCURRENCY, async (batch) => {
      // Checked when a batch STARTS: one already in flight finishes, but nothing
      // new begins past the budget.
      if (deadline && Date.now() > deadline) {
        for (const item of batch) skippedKeys.add(item.key);
        return;
      }
      batches += 1;
      let lastError = null;
      for (let attempt = 0; attempt < SELECTION_AI_BATCH_ATTEMPTS; attempt += 1) {
        // A retry is a new call, so it respects the budget like a new batch.
        if (attempt > 0 && deadline && Date.now() > deadline) break;
        try {
          // eslint-disable-next-line no-await-in-loop
          const answered = await callBatch({ batch, system, listKey, allowed, maxTokens, toPayload, hints });
          for (const [key, category] of answered) verdicts.set(key, category);
          lastError = null;
          break;
        } catch (e) {
          lastError = e;
        }
      }
      if (lastError) {
        if (!error) error = lastError.message;
        console.error('[content-architect] informational selection batch failed:', lastError.message);
        for (const item of batch) failedKeys.add(item.key);
      }
    });

    return { verdicts, failedKeys, skippedKeys, batches, error };
  }

  return {
    model: MODEL,

    /**
     * @param {Array<{key: string, pattern: string, examples: string[]}>} items
     * @param {{deadline?: number}} [opts]  epoch ms after which no batch starts
     */
    classifyTemplates(items, { deadline, hints } = {}) {
      return run(items, {
        hints,
        batchSize: SELECTION_TEMPLATE_BATCH_SIZE,
        system: TEMPLATE_SYSTEM_PROMPT,
        listKey: 'templates',
        allowed: TEMPLATE_CATEGORIES,
        maxTokens: 4096,
        toPayload: (item) => ({ pattern: item.pattern, examples: item.examples }),
        deadline,
      });
    },

    /**
     * @param {Array<{key: string, url: string}>} items
     * @param {{deadline?: number}} [opts]
     */
    classifyUrls(items, { deadline, hints } = {}) {
      return run(items, {
        hints,
        batchSize: SELECTION_URL_BATCH_SIZE,
        system: URL_SYSTEM_PROMPT,
        listKey: 'urls',
        allowed: URL_CATEGORIES,
        maxTokens: 8192,
        toPayload: (item) => ({ url: item.url }),
        deadline,
      });
    },
  };
}

module.exports = {
  createInformationalClassifier,
  hasSelectionKey,
  normalizeCategory,
  parseJsonReply,
  mapWithConcurrency,
  MODEL,
  URL_CATEGORIES,
  TEMPLATE_CATEGORIES,
  TEMPLATE_SYSTEM_PROMPT,
  URL_SYSTEM_PROMPT,
};
