// ── Basic-auth credentials on monitored domains ─────────────────────────────
// A staging domain can carry an HTTP basic-auth username and password so the
// checker can reach it. Those credentials are for the checker only.
//
// They used to travel to the browser in full: GET /clients returned the stored
// record as-is, so anyone who opened the page could read every client's staging
// password, and the edit form pre-filled it. Responses now carry the username
// and a `hasPassword` flag, and a blank password on edit means "keep the saved
// one".
//
// The second rule is about where a saved password may be sent. Editing a
// domain's URL used to keep its auth, so pointing a domain at another host made
// the next scheduled check send that client's credentials there. A saved
// password now stays with its host: moving to a different host needs the
// password typed again, by someone who knows it.

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

function redactDomain(domain) {
  if (!domain || !domain.auth) return domain;
  return {
    ...domain,
    auth: { username: domain.auth.username || '', hasPassword: Boolean(domain.auth.password) },
  };
}

function redactClient(client) {
  if (!client) return client;
  return { ...client, domains: (client.domains || []).map(redactDomain) };
}

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch { return null; }
}

/**
 * The auth to store for a domain edit.
 *
 * @param {object} input
 * @param {object} input.existing  the stored domain, with its real password
 * @param {string} [input.url]     the new URL, when the edit changes it
 * @param {object|null|undefined} input.auth  what the request sent
 * @returns {object|null|undefined} the auth to write; undefined means leave it
 */
function resolveAuthUpdate({ existing, url, auth }) {
  const saved = existing?.auth || null;
  const hostChanged = url !== undefined && hostOf(url) !== hostOf(existing?.url);

  if (auth === null) return null;

  if (auth === undefined) {
    if (saved && hostChanged) {
      throw badRequest('Enter the basic-auth password again when moving a domain to a different host.');
    }
    return undefined;
  }

  const username = String(auth.username || '').trim();
  const password = auth.password ? String(auth.password) : '';
  if (!username) throw badRequest('auth.username must be non-empty');

  if (password) return { username, password };

  if (!saved || !saved.password) throw badRequest('auth.password must be non-empty');
  if (hostChanged) {
    throw badRequest('Enter the basic-auth password again when moving a domain to a different host.');
  }
  return { username, password: saved.password };
}

module.exports = { redactDomain, redactClient, resolveAuthUpdate };
