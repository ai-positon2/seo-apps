// ── One prompt per page, written from the page itself ───────────────────────
//
// This is the ONLY way questions are generated.
//
// It reads the page: fetches the URL, pulls the content a reader would
// actually see, and asks a model what a buyer would type to find it. One page,
// one call, one question — so a question can always be traced back to the page
// it is meant to win, and a bad one implicates exactly one page.
//
// The slot generator that used to sit beside this wrote from a TOPIC — a label
// and a few terms — which is why it produced "best find a dentist" from a page
// whose title happened to be "Find A Dentist". A label is not a page. It has
// been removed, along with its topic×intent matrix and its paid demand seeding.
//
// One call per page is slower and costs more calls than batching, and it is
// also the only shape where "this question is wrong for this page" is a
// statement anyone can check.

const { createLlmClient } = require('../../services/llmProviders');
const { chatParams } = require('../../locationPageBuilder/llmParams');
const promptValidator = require('./promptValidator');

// Named explicitly rather than taken from the app's default. This is a small,
// cheap, high-volume job — one call per page — and the choice of a mini model
// is the point, not an incidental default that might drift later.
const MODEL = process.env.AIV_PROMPT_MODEL || 'gpt-4o-mini';

// A hard ceiling on pages per request. Each page is a fetch plus a model call,
// so this bounds both the time and the spend of one click.
const MAX_PAGES = 20;

// How much of the page the model sees. Enough to know what the page is for;
// far short of a whole document, because a 200KB page of markup would cost more
// than the answer is worth and adds nothing after the first few paragraphs.
const MAX_CONTENT_CHARS = 4_000;

const FETCH_TIMEOUT_MS = 12_000;

// A real browser UA. A page served a bot-shaped response is a page we would be
// writing prompts about without having seen it.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

const SYSTEM_PROMPT = `You write the single search question a real person would type into ChatGPT or Gemini when they are trying to find a business like the one whose page you are shown.

You are given one page from a company's website. Write ONE question that this page deserves to be the answer to.

Rules that matter:
- Write what a CUSTOMER types, not what the page calls itself. A page titled "What Is a Root Canal? Causes, Symptoms and Treatment" earns "how much does a root canal cost" or "does a root canal hurt" — not "what is a root canal causes symptoms and treatment".
- NEVER name the company, its brand, or any of its own wording that only an insider would use. The question must be one a person asks before they have heard of this company.
- Lowercase, no punctuation at the end, no quotation marks. Real people do not capitalise or punctuate search questions.
- 3 to 12 words.
- If the page is about a place, include the place.
- If the page is a team bio, a press release, or a policy page, a customer would not search for it: return null instead of inventing a question.

Reply with JSON only.`;

const RESPONSE_FORMAT = 'Respond with exactly: '
  + '{"prompt": "<the question, or null>", "intent": "commercial|informational|comparison|navigational", '
  + '"why": "<a short clause saying who asks this and why this page answers it>"}';

let _client = null;
function client() {
  if (!_client) _client = createLlmClient(MODEL);
  return _client;
}

function hasKey() {
  const k = process.env.OPENAI_API_KEY;
  return Boolean(k) && !/your_.*_here/i.test(k);
}

/**
 * The readable content of a page.
 *
 * Strips script, style, nav, header and footer before taking text: those are
 * the same on every page of a site, and a model shown them writes the same
 * prompt for every page — which is exactly the failure this file exists to fix.
 */
function readableFromHtml(html) {
  const pick = (re) => {
    const m = re.exec(html);
    return m ? m[1].replace(/\s+/g, ' ').trim() : null;
  };

  const title = pick(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const description = pick(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i)
    || pick(/<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["']/i);

  const headings = [];
  const hRe = /<h([12])[^>]*>([\s\S]*?)<\/h\1>/gi;
  let m = hRe.exec(html);
  while (m && headings.length < 12) {
    const text = m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (text) headings.push(text);
    m = hRe.exec(html);
  }

  const body = html
    .replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(nav|header|footer|form)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();

  return {
    title,
    description,
    headings,
    body: body.slice(0, MAX_CONTENT_CHARS),
  };
}

/**
 * Fetch one page.
 *
 * Returns `{ok:false, reason}` rather than throwing. A page we could not read
 * must produce NO prompt — writing one from its URL alone would be guessing,
 * and a guessed prompt is measured exactly as confidently as a real one.
 */
async function fetchPage(url, { timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' },
    });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };

    const type = res.headers.get('content-type') || '';
    if (!/text\/html|application\/xhtml/i.test(type)) {
      return { ok: false, reason: `not HTML (${type.split(';')[0] || 'unknown'})` };
    }

    const html = await res.text();
    const content = readableFromHtml(html);
    if (!content.title && !content.headings.length && content.body.length < 120) {
      return { ok: false, reason: 'page had no readable content' };
    }
    return { ok: true, content, bytes: html.length };
  } catch (e) {
    return { ok: false, reason: e.name === 'AbortError' ? 'timed out' : e.message };
  } finally {
    clearTimeout(timer);
  }
}

function parseReply(raw) {
  const text = String(raw || '').trim().replace(/^```(?:json)?|```$/g, '').trim();
  const parsed = JSON.parse(text);
  return parsed;
}

/**
 * Ask the model for one prompt for one page.
 *
 * @returns {Promise<{prompt, intent, why}|null>} null when the page is
 *   not something a customer searches for — a team bio, a press release.
 */
async function promptForPage({ url, content, brand, competitors = [] }) {
  const payload = {
    page_url: url,
    title: content.title,
    meta_description: content.description,
    headings: content.headings,
    page_text: content.body,
    // Given so the model can AVOID them, never to include them.
    do_not_mention: [brand?.name, ...(competitors || []).map((c) => c.name || c)].filter(Boolean),
  };

  const llm = client();
  const completion = await llm.chat.completions.create({
    model: llm.model,
    ...chatParams(llm.model, { maxTokens: 300, temperature: 0.4 }),
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: `${RESPONSE_FORMAT}\n\n${JSON.stringify(payload)}` },
    ],
  });

  const parsed = parseReply(completion.choices?.[0]?.message?.content);
  const prompt = typeof parsed?.prompt === 'string' ? parsed.prompt.trim() : null;
  if (!prompt || prompt.toLowerCase() === 'null') return null;

  return {
    prompt,
    intent: parsed.intent || 'commercial',
    why: typeof parsed.why === 'string' ? parsed.why.slice(0, 240) : null,
  };
}

/**
 * One prompt per URL, for up to MAX_PAGES URLs.
 *
 * Never throws for one bad page. Every URL comes back in exactly one of
 * `prompts` or `skipped`, with a reason — a run that quietly returned 12
 * prompts for 20 URLs would leave eight pages unexplained.
 *
 * @param {object} input
 * @param {string[]} input.urls
 * @param {object} input.brand
 * @param {Array} [input.competitors]
 * @param {Array} [input.existing] prompt texts to avoid duplicating
 * @param {number} [input.concurrency]
 */
async function generateForUrls({
  urls = [], brand, competitors = [], existing = [], concurrency = 4,
}) {
  const capped = [...new Set(urls.filter(Boolean))].slice(0, MAX_PAGES);
  const result = {
    model: MODEL,
    requested: urls.length,
    considered: capped.length,
    truncated: urls.length > MAX_PAGES,
    prompts: [],
    skipped: [],
    calls: 0,
  };

  if (!capped.length) return result;
  if (!hasKey()) {
    result.skipped = capped.map((url) => ({ url, reason: 'no_openai_key' }));
    return result;
  }

  const index = promptValidator.makeIndex(existing);
  const guard = promptValidator.brandTokens(brand, competitors);

  // A small worker pool: 20 pages serially is 20 round trips of latency, and
  // all at once is impolite to a client's own site.
  const queue = [...capped];
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    for (;;) {
      const url = queue.shift();
      if (!url) return;

      const page = await fetchPage(url);
      if (!page.ok) { result.skipped.push({ url, reason: page.reason }); continue; }

      let written;
      try {
        result.calls += 1;
        written = await promptForPage({
          url, content: page.content, brand, competitors,
        });
      } catch (e) {
        result.skipped.push({ url, reason: `model call failed: ${e.message}` });
        continue;
      }

      if (!written) {
        result.skipped.push({ url, reason: 'not a page a customer searches for' });
        continue;
      }

      // The brand guard is enforced HERE, in code. The system prompt asks for
      // it too, but an instruction is not a constraint — a model that names the
      // brand produces a prompt that measures whether the engine can echo a
      // name it was given, which is not visibility.
      if (promptValidator.matchesBrand(written.prompt, guard)) {
        result.skipped.push({ url, reason: 'the model named the brand', text: written.prompt });
        continue;
      }
      // `.dup` — isNearDuplicate returns {dup, against, score, rule}, not a
      // boolean, and the object is always truthy. Treating it as a boolean
      // rejects every prompt while looking like a working duplicate check.
      const dupe = promptValidator.isNearDuplicate(written.prompt, index);
      if (dupe.dup) {
        result.skipped.push({
          url,
          reason: `too close to an existing prompt (${dupe.rule}): "${dupe.against}"`,
          text: written.prompt,
        });
        continue;
      }

      index.add?.(written.prompt);
      result.prompts.push({
        text: written.prompt,
        intent: written.intent,
        source: 'cluster',
        sourceRef: page.content.title || url,
        rationale: written.why,
        topicKind: 'page',
        topicLabel: page.content.title || url,
        targetUrl: url,
      });
    }
  });

  await Promise.all(workers);
  return result;
}

module.exports = {
  MODEL,
  MAX_PAGES,
  MAX_CONTENT_CHARS,
  hasKey,
  readableFromHtml,
  fetchPage,
  promptForPage,
  generateForUrls,
};
