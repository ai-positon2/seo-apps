// ── A JSON request that fails in plain words ────────────────────────────────
//
// `await res.json()` before checking res.ok turned a gateway's HTML error page
// (the host returns one during restarts) into "Unexpected token '<',
// "<!DOCTYPE "... is not valid JSON" — shown verbatim on the Team page, and an
// unhandled rejection that left first sign-in's profile form blank. The body is
// read as text first; a server's own { error } message is kept, anything else
// becomes one sentence a person can act on.

export const SERVER_DOWN_MESSAGE = "The server didn't respond properly. Try again in a minute.";

/**
 * Turns a status and raw body into { data } or { error }. Pure, for the tests.
 * @returns {{ ok: true, data: any } | { ok: false, message: string, status: number }}
 */
export function readJsonBody(status, text, okFlag = status >= 200 && status < 300) {
  let data = null;
  let parsed = false;
  if (text) {
    try { data = JSON.parse(text); parsed = true; } catch { parsed = false; }
  } else {
    parsed = true;
  }
  if (okFlag && parsed) return { ok: true, data };
  const own = parsed && data && typeof data.error === 'string' && data.error.trim() ? data.error : null;
  return { ok: false, status, message: own || SERVER_DOWN_MESSAGE };
}

/** fetch + readJsonBody. Throws an Error carrying .status on failure. */
export async function fetchJson(path, options = {}) {
  let res;
  try {
    res = await fetch(path, {
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      ...options,
    });
  } catch {
    throw Object.assign(new Error("Couldn't reach the server. Check your connection and try again."), { status: 0 });
  }
  let text = '';
  try { text = await res.text(); } catch { text = ''; }
  const out = readJsonBody(res.status, text, res.ok);
  if (out.ok) return out.data;
  throw Object.assign(new Error(out.message), { status: out.status });
}
