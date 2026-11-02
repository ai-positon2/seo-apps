// ── Report assistant API client ─────────────────────────────────────────────
// Mirrors server/modules/reportChat/routes.js.
//
// The typed error shape is the same one aiVisibilityLiteApi.js uses: the panel
// branches on `error.code` (`daily_limit`), so a bare Error is not enough.

import { createSseParser } from '../components/chat/chatModel.js';

const BASE = '/api/report-chat';

async function toError(res) {
  let body = null;
  try { body = await res.json(); } catch { /* empty or non-JSON body */ }
  const error = new Error(body?.error || `Request failed (${res.status})`);
  error.status = res.status;
  error.code = body?.code;
  return error;
}

async function req(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    ...options,
  });
  if (!res.ok) throw await toError(res);
  return res.json();
}

export const reportChatApi = {
  thread: (projectId) => req(`${BASE}/${encodeURIComponent(projectId)}/thread`),
  newThread: (projectId) => req(`${BASE}/${encodeURIComponent(projectId)}/thread`, { method: 'POST' }),

  /**
   * Ask a question. Resolves when the answer stream ends; `onEvent(name, data)`
   * fires for start / delta / done / error as they arrive. A refusal before the
   * stream starts (no access, the daily cap) rejects with a typed error.
   */
  async ask(projectId, body, { onEvent, signal } = {}) {
    const res = await fetch(`${BASE}/${encodeURIComponent(projectId)}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) throw await toError(res);

    const feed = createSseParser(onEvent || (() => {}));
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      feed(decoder.decode(value, { stream: true }));
    }
    feed(decoder.decode());
  },
};
