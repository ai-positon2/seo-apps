// ── Canonical URL normalization ──────────────────────────────────────────────
// Applied consistently to every URL from Stage 1 onward, so the same page
// reached two different ways (mixed case host, trailing slash, tracking
// params) is always treated as one URL. Trailing-slash policy: strip it
// everywhere except the bare root path.
function normalizeUrl(rawUrl, base) {
  let u;
  try {
    u = new URL(rawUrl, base);
  } catch {
    return null;
  }
  u.hostname = u.hostname.toLowerCase();
  u.search = '';
  u.hash = '';
  if (u.pathname.length > 1 && u.pathname.endsWith('/')) {
    u.pathname = u.pathname.replace(/\/+$/, '');
  }
  return u.href;
}

function dedupeUrls(urls) {
  return [...new Set(urls)];
}

module.exports = { normalizeUrl, dedupeUrls };
