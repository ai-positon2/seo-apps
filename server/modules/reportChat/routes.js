// ── /api/report-chat ────────────────────────────────────────────────────────
//
//   GET  /:projectId/thread     the caller's active conversation on this project
//   POST /:projectId/thread     start a new one (the old one is archived, not deleted)
//   POST /:projectId/messages   ask a question; the answer streams back as SSE
//
// Every route answers only to someone who can VIEW the project, through
// projectAccess — a project in another workspace is a 404, as everywhere else.
// The assistant reads the same data the dashboard shows and can change nothing.
//
// The answer stream sends three events:
//   start  { userMessage }          the saved question
//   delta  { text }                 the next piece of the answer
//   done   { message }              the saved answer
//   error  { error }                the answer failed; the question stays saved
// Refusals that happen before any answer starts (bad input, no access, daily
// cap) are ordinary JSON errors, so the client can show them without a stream.
//
// Not wrapped in track(): every question and answer is already its own row in
// report_chat_messages, with the tokens it used.

const express = require('express');
const projectAccess = require('../../services/projectAccess');
const { isDatabaseConfigured } = require('../../services/db');
const { createLlmClient } = require('../../services/llmProviders');
const defaultStore = require('./store');
const { buildChatContext } = require('./context');
const { buildMessages } = require('./prompt');
const { isScreen } = require('./screens');
const { CALCULATOR_TOOL, runCalculator } = require('./calculator');
const { WEB_SEARCH_TOOL, runWebSearch, cleanSources } = require('./webSearch');
const { EXPERT_MARKER } = require('./prompt');

const MAX_QUESTION_CHARS = 2000;
// Earlier turns sent with each question. Enough for "and what about that one?"
// to resolve; the report data is re-read fresh every time, so old answers do
// not need to carry it.
const HISTORY_MESSAGES = 10;
const THREAD_MESSAGES = 50;
const MAX_OUTPUT_TOKENS = 4000;
const LLM_TIMEOUT_MS = 90_000;

// gpt-5.5 for answer quality (about 6–7× gpt-5.4-mini per question at the
// ~11k input tokens a question carries). REPORT_CHAT_MODEL overrides it.
const chatModel = () => process.env.REPORT_CHAT_MODEL || 'gpt-5.5';

function dailyLimit() {
  const n = Number.parseInt(process.env.REPORT_CHAT_DAILY_LIMIT, 10);
  return Number.isFinite(n) && n > 0 ? n : 200;
}

const messageView = (m) => ({
  id: m.id,
  role: m.role,
  content: m.content,
  screen: m.screen || null,
  createdAt: m.created_at,
  offerExpert: Boolean(m.offer_expert),
  sources: Array.isArray(m.sources) ? m.sources : [],
});

// ── The answer, with its tools ──────────────────────────────────────────────
//
// The model may call `calculate` (calculator.js) and `web_search`
// (webSearch.js) before it answers, as many rounds as it needs up to
// MAX_TOOL_ROUNDS; the last round has tools off so it must answer. Text from a
// round that turns out to be a tool call is held back (it is a preamble like
// "let me work that out", not the answer), so only the answer itself streams.
// A round's text is held until it is clearly prose — HOLD_CHARS long with no
// tool call — and then streams live.
//
// An advice answer ends with EXPERT_MARKER (prompt.js). The reader never sees
// it: the stream keeps back a marker's length of text until it can tell, and
// the app shows its own "talk to a Position2 specialist" notice instead.
const MAX_TOOL_ROUNDS = 5;
const HOLD_CHARS = 80;
const MAX_SEARCHES = 2;
const ADVICE_SECTION = /\*\*In general:?\*\*/i;

/** Streams text through, removing EXPERT_MARKER even when it arrives in pieces. */
function markerFilter(onText) {
  let tail = '';
  let found = false;
  const keep = EXPERT_MARKER.length - 1;
  return {
    push(piece) {
      tail += piece;
      if (tail.includes(EXPERT_MARKER)) { found = true; tail = tail.split(EXPERT_MARKER).join(''); }
      if (tail.length > keep) {
        onText(tail.slice(0, tail.length - keep));
        tail = tail.slice(tail.length - keep);
      }
    },
    flush() {
      if (tail.includes(EXPERT_MARKER)) { found = true; tail = tail.split(EXPERT_MARKER).join(''); }
      const rest = tail.replace(/\s+$/, '');
      if (rest) onText(rest);
      tail = '';
      return found;
    },
  };
}

async function streamAnswer({ client, model, messages, signal, onText, search = runWebSearch }) {
  let msgs = messages;
  const usage = { prompt_tokens: 0, completion_tokens: 0 };
  let shown = '';
  const out = markerFilter((t) => { shown += t; onText(t); });
  let sources = [];
  let webSearches = 0;

  const runTool = async (c) => {
    if (c.name === 'calculate') return runCalculator(c.args);
    if (c.name === 'web_search') {
      if (webSearches >= MAX_SEARCHES) {
        return JSON.stringify({ error: `search limit reached (${MAX_SEARCHES} per answer); answer with what you have` });
      }
      webSearches += 1;
      let query = '';
      try { query = JSON.parse(c.args || '{}').query; } catch { /* reported below */ }
      const result = await search(query);
      sources = cleanSources([...sources, ...(result.sources || [])]);
      return JSON.stringify(result);
    }
    return JSON.stringify({ error: `unknown tool ${c.name}` });
  };
  // The model forgets the marker now and then; an answer with an "In general"
  // advice section is an advice answer either way.
  const finish = () => {
    const marked = out.flush();
    return { usage, offerExpert: marked || ADVICE_SECTION.test(shown), sources, webSearches };
  };

  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    const last = round === MAX_TOOL_ROUNDS - 1;
    const stream = await client.chat.completions.create({
      model,
      messages: msgs,
      stream: true,
      stream_options: { include_usage: true },
      max_completion_tokens: MAX_OUTPUT_TOKENS,
      tools: [CALCULATOR_TOOL, WEB_SEARCH_TOOL],
      tool_choice: last ? 'none' : 'auto',
    }, { signal, timeout: LLM_TIMEOUT_MS, maxRetries: 1 });

    const calls = [];
    let roundText = '';
    let held = '';
    let live = false;
    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta;
      for (const tc of delta?.tool_calls || []) {
        const slot = (calls[tc.index ?? 0] ||= { id: '', name: '', args: '' });
        if (tc.id) slot.id = tc.id;
        if (tc.function?.name) slot.name += tc.function.name;
        if (tc.function?.arguments) slot.args += tc.function.arguments;
      }
      const piece = delta?.content;
      if (piece) {
        roundText += piece;
        if (live) out.push(piece);
        else {
          held += piece;
          if (!calls.length && held.length >= HOLD_CHARS) { live = true; out.push(held); held = ''; }
        }
      }
      if (chunk.usage) {
        usage.prompt_tokens += chunk.usage.prompt_tokens || 0;
        usage.completion_tokens += chunk.usage.completion_tokens || 0;
      }
    }

    const toolCalls = calls.filter(Boolean);
    if (!toolCalls.length) {
      if (held) out.push(held);
      return finish();
    }
    if (live) {
      // Prose already shown, then a tool call. Rare; keep the prose and carry on.
      out.push('\n\n');
    }
    const results = await Promise.all(toolCalls.map(runTool));
    msgs = [
      ...msgs,
      {
        role: 'assistant',
        content: roundText || null,
        tool_calls: toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.args } })),
      },
      ...toolCalls.map((c, i) => ({ role: 'tool', tool_call_id: c.id, content: results[i] })),
    ];
  }
  return finish();
}

function handleError(res, e, where) {
  if (e && e.status) {
    return res.status(e.status).json({ error: e.message, code: e.code || undefined });
  }
  console.error(`[reportChat.${where}]`, e?.stack || e?.message || e);
  res.status(500).json({ error: 'Something went wrong with the report assistant.' });
}

/**
 * @param {object} [deps] swappable in tests
 */
function createRouter(deps = {}) {
  const store = deps.store || defaultStore;
  const requireProject = deps.requireProject || projectAccess.requireProject;
  const buildContext = deps.buildChatContext || buildChatContext;
  const llmClient = deps.createLlmClient || createLlmClient;
  const configured = deps.isDatabaseConfigured || isDatabaseConfigured;

  const router = express.Router();

  router.use((req, res, next) => {
    if (configured()) return next();
    res.status(503).json({ error: 'The report assistant needs the database configured.', code: 'not_configured' });
  });

  router.get('/:projectId/thread', async (req, res) => {
    try {
      const access = await requireProject(req, req.params.projectId, 'view');
      const userId = req.user.userId;
      const thread = await store.activeThread(access.project.id, userId);
      const messages = thread ? await store.listMessages(thread.id, userId, THREAD_MESSAGES) : [];
      res.json({
        thread: thread ? { id: thread.id, createdAt: thread.created_at } : null,
        messages: messages.map(messageView),
        dailyLimit: dailyLimit(),
      });
    } catch (e) { handleError(res, e, 'thread'); }
  });

  router.post('/:projectId/thread', async (req, res) => {
    try {
      const access = await requireProject(req, req.params.projectId, 'view');
      await store.archiveActive(access.project.id, req.user.userId);
      res.json({ thread: null, messages: [] });
    } catch (e) { handleError(res, e, 'newThread'); }
  });

  router.post('/:projectId/messages', async (req, res) => {
    const question = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
    if (!question) return res.status(400).json({ error: 'Type a question first.', code: 'empty_question' });
    if (question.length > MAX_QUESTION_CHARS) {
      return res.status(400).json({
        error: `Questions can be up to ${MAX_QUESTION_CHARS} characters.`,
        code: 'question_too_long',
      });
    }
    const screen = isScreen(req.body?.screen) ? req.body.screen : null;

    let access, thread, history, userMessage;
    try {
      access = await requireProject(req, req.params.projectId, 'view');
      const userId = req.user.userId;
      const limit = dailyLimit();
      if (await store.countRecentQuestions(userId) >= limit) {
        return res.status(429).json({
          error: `You have reached today's limit of ${limit} questions. It resets over the next 24 hours.`,
          code: 'daily_limit',
        });
      }
      thread = await store.ensureThread(access.project.id, userId);
      history = await store.listMessages(thread.id, userId, HISTORY_MESSAGES);
      userMessage = await store.addMessage({ threadId: thread.id, userId, role: 'user', content: question, screen });
    } catch (e) { return handleError(res, e, 'messages'); }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    let finished = false;
    const controller = new AbortController();
    res.on('close', () => { if (!finished) controller.abort(); });
    const emit = (event, data) => {
      if (res.writableEnded) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    emit('start', { userMessage: messageView(userMessage) });

    let text = '';
    let usage = null;
    let model = chatModel();
    try {
      const context = await buildContext({ access, screen, screenCopy: req.body?.screenCopy });
      const client = llmClient(model);
      model = client.model || model;
      const result = await streamAnswer({
        client,
        model,
        messages: buildMessages(context, history, question),
        signal: controller.signal,
        onText: (piece) => {
          text += piece;
          emit('delta', { text: piece });
        },
        ...(deps.webSearch ? { search: deps.webSearch } : {}),
      });
      usage = result.usage;
      if (!text.trim()) throw new Error('the model returned an empty answer');

      const saved = await store.addMessage({
        threadId: thread.id,
        userId: req.user.userId,
        role: 'assistant',
        content: text,
        screen,
        model,
        inputTokens: usage?.prompt_tokens ?? null,
        outputTokens: usage?.completion_tokens ?? null,
        offerExpert: result.offerExpert,
        sources: result.sources,
        webSearches: result.webSearches,
      });
      // The stored row is the source of truth, but a store that predates
      // migration 0045 hands back no expert/sources columns — so the live
      // answer carries them from the stream either way.
      emit('done', {
        message: { ...messageView(saved), offerExpert: result.offerExpert, sources: result.sources },
      });
    } catch (e) {
      if (controller.signal.aborted) {
        // The reader closed the panel mid-answer. Keep what had arrived so the
        // conversation still reads sensibly when they come back.
        if (text.trim()) {
          await store.addMessage({
            threadId: thread.id, userId: req.user.userId, role: 'assistant',
            content: `${text}\n\n(answer stopped)`, screen, model,
          }).catch(() => {});
        }
      } else {
        console.error('[reportChat.answer]', e?.message || e);
        emit('error', { error: 'The assistant could not answer just now. Please try again in a moment.' });
      }
    } finally {
      finished = true;
      if (!res.writableEnded) res.end();
    }
  });

  return router;
}

module.exports = createRouter();
module.exports.createRouter = createRouter;
module.exports.dailyLimit = dailyLimit;
module.exports.streamAnswer = streamAnswer;
