// ── DataForSEO transport ─────────────────────────────────────────────────────
//
// Shared plumbing for the surfaces in ./surfaces. DataForSEO spans three
// products on one set of credentials, and which one you call decides what you
// actually measure:
//
//   SERP endpoints              Google AI Mode, Google AI Overview
//   AI Optimization "LLM Scraper"   drives the real chatgpt.com / gemini UI
//   AI Optimization "LLM Responses" calls the model's own API
//
// The LLM Scraper is the one that matters for this module. It reads back what a
// consumer actually sees, which is the thing a client is asking about when they
// ask whether they show up in ChatGPT — the model API's answer is a different
// question with a different retrieval stack behind it.
//
// Derived from Elmo (MIT) — see ./LICENSE-elmo.md. Ported to plain REST rather
// than their TypeScript SDK: this codebase is CommonJS and already calls Serper
// the same way (services/googleSearch.js), so a TS-oriented dependency would be
// the odd one out.

const BASE_URL = 'https://api.dataforseo.com';

// DataForSEO documents `keyword` up to 2000 characters for the ChatGPT scraper,
// but the SERP surfaces are tighter and a prompt set has to be usable across all
// of them. 500 is Elmo's cap and it is the safe common denominator; a prompt
// long enough to hit it is a badly-shaped prompt anyway.
const MAX_PROMPT_CHARS = 500;

// US English. Deliberately not exposed as a per-project setting yet: DataForSEO's
// localization support differs by surface and by underlying model, so offering
// one control that silently means different things on different surfaces would
// be worse than not offering it. See PRD §30 — name the gap rather than fake it.
const LOCATION_CODE = 2840;
const LANGUAGE_CODE = 'en';

// The scraper drives a real browser session on their side and the docs allow up
// to 120 seconds. Our own ceiling sits above that so a slow-but-working call is
// not killed by us and recorded as a failure.
const REQUEST_TIMEOUT_MS = 150_000;

/** Credentials are read per call, not at require time, so a key added to .env
 *  after boot works without a restart. */
function credentials() {
  return {
    login: process.env.DATAFORSEO_LOGIN || null,
    password: process.env.DATAFORSEO_PASSWORD || null,
  };
}

function isConfigured() {
  const { login, password } = credentials();
  return Boolean(login && password);
}

/**
 * A prompt too long for the API.
 *
 * Thrown before the request rather than after, so it costs nothing and the
 * failure names the prompt rather than surfacing as an opaque 400.
 */
function assertPromptLength(prompt) {
  const length = Array.from(String(prompt || '')).length;
  if (!length) throw new Error('An empty prompt cannot be measured.');
  if (length > MAX_PROMPT_CHARS) {
    throw new Error(
      `Prompt is ${length} characters; DataForSEO surfaces take at most ${MAX_PROMPT_CHARS}.`,
    );
  }
}

/**
 * POST one task to DataForSEO and return `tasks[0].result[0]` plus the raw body.
 *
 * Two failure layers, and conflating them is the classic mistake with this API:
 * HTTP 200 does NOT mean the task succeeded. Every task carries its own
 * `status_code`, and 20000 is the only success value. A task can fail —
 * out of credit, bad location, their own internal error — inside a 200.
 *
 * @param {string} path    e.g. '/v3/ai_optimization/chat_gpt/llm_scraper/live/advanced'
 * @param {object} body    the single task object (wrapped in an array here)
 * @returns {Promise<{result: object, raw: object, taskCost: number|null}>}
 */
async function postTask(path, body) {
  const { login, password } = credentials();
  if (!login || !password) {
    throw new Error(
      'DataForSEO needs DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD. '
      + 'Nothing was requested, so nothing was charged.',
    );
  }

  const token = Buffer.from(`${login}:${password}`).toString('base64');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(`${BASE_URL}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify([body]),
      signal: controller.signal,
    });
  } catch (e) {
    if (e.name === 'AbortError') {
      throw new Error(`DataForSEO did not respond within ${REQUEST_TIMEOUT_MS / 1000}s.`);
    }
    throw new Error(`DataForSEO request failed: ${e.message}`);
  } finally {
    clearTimeout(timer);
  }

  // Read the body before judging the status. DataForSEO puts the ACTIONABLE
  // message in a top-level `status_message` and is inconsistent about the HTTP
  // code it pairs with it — the same account-verification refusal arrives as a
  // 403 sometimes and a 200 with no tasks other times.
  //
  // Discarding that message is how "Please verify your account before using the
  // API" became "DataForSEO returned no task.", which sends whoever reads it
  // hunting for a bug in our request shape instead of clicking one link.
  const raw = await response.json().catch(() => null);

  // 20000 is the only success value at the top level too, not just per task.
  if (raw && typeof raw.status_code === 'number' && raw.status_code !== 20000) {
    throw new Error(`DataForSEO ${raw.status_code}: ${raw.status_message || 'request refused'}`);
  }
  if (!response.ok) {
    throw new Error(`DataForSEO HTTP ${response.status} ${response.statusText}`);
  }
  if (!raw) throw new Error('DataForSEO returned an unreadable body.');

  const task = raw.tasks?.[0];
  if (!task) {
    throw new Error(
      `DataForSEO returned no task (${raw.tasks_error ?? 0} task error(s))`
      + `${raw.status_message && raw.status_message !== 'Ok.' ? `: ${raw.status_message}` : ''}`,
    );
  }

  // 20000 is success. Anything else is a real failure even though the HTTP call
  // was fine, and the message is worth keeping — it is what tells an operator
  // whether they are out of credit or sent a bad request.
  if (task.status_code !== 20000) {
    throw new Error(`DataForSEO task ${task.status_code}: ${task.status_message || 'unknown error'}`);
  }
  const result = task.result?.[0];
  if (!result) throw new Error('DataForSEO task succeeded but returned no result.');

  return {
    result,
    raw,
    // Per-task cost, so a run can report what it actually spent rather than an
    // estimate. Null when absent rather than 0 — an unknown cost is not a free
    // one (§16.11).
    taskCost: typeof task.cost === 'number' ? task.cost : null,
  };
}

/**
 * Retry a task that DataForSEO fails on its own side.
 *
 * Only for the transient, task-level "Internal SE Server Error" the async AI
 * Overview path is known to throw; a couple of attempts clear it. Deliberately
 * NOT a general retry: re-sending a request that failed because it was malformed
 * or because the account is out of credit just spends the same money twice.
 */
async function postTaskWithRetry(path, body, { attempts = 3, backoffMs = 1500 } = {}) {
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await postTask(path, body);
    } catch (e) {
      lastError = e;
      const transient = /internal se server error|did not respond|HTTP 5\d\d/i.test(e.message);
      if (!transient || attempt === attempts - 1) throw e;
      await new Promise((resolve) => setTimeout(resolve, backoffMs * (attempt + 1)));
    }
  }
  throw lastError;
}

module.exports = {
  BASE_URL,
  MAX_PROMPT_CHARS,
  LOCATION_CODE,
  LANGUAGE_CODE,
  REQUEST_TIMEOUT_MS,
  credentials,
  isConfigured,
  assertPromptLength,
  postTask,
  postTaskWithRetry,
};
