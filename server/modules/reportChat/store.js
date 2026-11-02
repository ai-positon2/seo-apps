// ── Report chat storage (migration 0044) ────────────────────────────────────
//
// Every read is scoped by (project, user) as well as by id, so a thread id from
// one person's conversation can never return another person's messages even if
// a route forgot to check. Project access itself is decided by the route,
// through projectAccess, before anything here runs.

const db = require('../../services/db');

/** The caller's active thread on this project, or null. */
async function activeThread(projectId, userId) {
  return db.maybeOne(
    `select * from report_chat_threads
      where project_id = $1 and user_id = $2 and archived_at is null`,
    [projectId, userId],
  );
}

/**
 * The active thread, created if there is none. The partial unique index makes
 * two racing first messages converge on one thread instead of making two.
 */
async function ensureThread(projectId, userId) {
  await db.query(
    `insert into report_chat_threads (project_id, user_id) values ($1, $2)
       on conflict (project_id, user_id) where archived_at is null do nothing`,
    [projectId, userId],
  );
  return activeThread(projectId, userId);
}

/** "New conversation": the old thread is kept, just no longer active. */
async function archiveActive(projectId, userId) {
  await db.query(
    `update report_chat_threads set archived_at = now(), updated_at = now()
      where project_id = $1 and user_id = $2 and archived_at is null`,
    [projectId, userId],
  );
}

// ── Before migration 0045 ───────────────────────────────────────────────────
// offer_expert, sources and web_searches arrived in 0045. A server deployed
// before that migration is applied must still save and read conversations, so
// the first "undefined column" error switches this process to the 0044 columns.
let hasExpertColumns = true;
const UNDEFINED_COLUMN = '42703';

async function withExpertColumns(full, base) {
  if (hasExpertColumns) {
    try { return await full(); } catch (e) {
      if (e?.code !== UNDEFINED_COLUMN) throw e;
      hasExpertColumns = false;
      console.warn('[reportChat] migration 0045 not applied yet; saving without expert/sources columns');
    }
  }
  return base();
}

/** The newest `limit` messages of a thread, oldest first. */
async function listMessages(threadId, userId, limit = 50) {
  const sql = (cols) => `select ${cols} from report_chat_messages
      where thread_id = $1 and user_id = $2
      order by created_at desc, id desc
      limit $3`;
  const params = [threadId, userId, limit];
  const list = await withExpertColumns(
    () => db.rows(sql('id, role, content, screen, created_at, offer_expert, sources'), params),
    () => db.rows(sql('id, role, content, screen, created_at'), params),
  );
  return list.reverse();
}

async function addMessage({
  threadId, userId, role, content, screen = null, model = null, inputTokens = null, outputTokens = null,
  offerExpert = false, sources = null, webSearches = 0,
}) {
  const base = [threadId, userId, role, content, screen, model, inputTokens, outputTokens];
  const row = await withExpertColumns(
    () => db.one(
      `insert into report_chat_messages
         (thread_id, user_id, role, content, screen, model, input_tokens, output_tokens, offer_expert, sources, web_searches)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       returning id, role, content, screen, created_at, offer_expert, sources`,
      [...base, Boolean(offerExpert), sources && sources.length ? JSON.stringify(sources) : null, webSearches || 0],
    ),
    () => db.one(
      `insert into report_chat_messages
         (thread_id, user_id, role, content, screen, model, input_tokens, output_tokens)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       returning id, role, content, screen, created_at`,
      base,
    ),
  );
  await db.query(`update report_chat_threads set updated_at = now() where id = $1`, [threadId]);
  return row;
}

/** Questions this person has asked in the last 24 hours, across every project. */
async function countRecentQuestions(userId) {
  return db.count(
    `select count(*) from report_chat_messages
      where user_id = $1 and role = 'user' and created_at > now() - interval '24 hours'`,
    [userId],
  );
}

module.exports = { activeThread, ensureThread, archiveActive, listMessages, addMessage, countRecentQuestions };
