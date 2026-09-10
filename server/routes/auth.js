const express = require('express');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { OAuth2Client } = require('google-auth-library');
const { isDatabaseConfigured } = require('../services/db');
const identityStore = require('../services/identityStore');
const platformAdmin = require('../services/platformAdmin');
const { peekWorkspaceId } = require('../services/workspaceContext');
const router = express.Router();

const COOKIE_NAME = 'seo_session';

// The synthetic identity the removed shared-token logins used to mint. Kept as a
// constant only so already-issued cookies can be recognised and refused.
const LEGACY_EMBED_USER = 'platform_embed';
// Which workspace the user is currently working in. Only ever read through
// workspaceContext, which membership-checks it before anything is written
// against it — a cookie is caller-supplied and never trusted as-is.
const WORKSPACE_COOKIE = 'workspace_id';
// No fallback. A default here would be a secret published in the source: any
// deployment that forgot the variable would accept sessions forged by anyone who
// can read this repo. Refusing to boot is the safe failure.
const JWT_SECRET = process.env.JWT_SECRET;
// Presence was never the real bar. A session is HS256 over this value and
// jwt.verify() is the only thing between an anonymous request and full access,
// so a guessable secret is equivalent to no authentication at all: one captured
// cookie is enough to recover a low-entropy key offline and then mint tokens for
// any email, including a platform administrator. Strength is therefore asserted
// at boot, where the failure is loud and immediate, rather than trusted.
function assertUsableJwtSecret(secret) {
  if (!secret) {
    throw new Error(
      'JWT_SECRET is not set. Sessions are signed with it, so the server will not start '
      + 'without one. Generate one with `openssl rand -hex 32` and put it in .env as JWT_SECRET.'
    );
  }
  const compact = secret.replace(/\s+/g, '');
  const problems = [];
  if (compact.length < 32) {
    problems.push(`it is only ${compact.length} non-whitespace characters (need at least 32)`);
  }
  if (/placeholder|change.?me|your.?secret|example|secret.?here|todo|xxx/i.test(secret)) {
    problems.push('it looks like a placeholder rather than a generated value');
  }
  if (new Set(compact).size < 16) {
    problems.push(`it draws on only ${new Set(compact).size} distinct characters (need at least 16)`);
  }
  // A run of space-separated dictionary words is a passphrase, not a key. Chosen
  // by a human it carries far less entropy than its length suggests: a dozen
  // English words in grammatical order is worth a few tens of bits, which is
  // brute-forceable offline from a single captured cookie.
  const words = secret.trim().split(/\s+/).filter(Boolean);
  if (words.length >= 4 && !/[0-9]/.test(secret)) {
    problems.push(
      `it reads as a ${words.length}-word passphrase with no digits, which carries far less `
      + 'entropy than its length suggests'
    );
  }
  if (problems.length) {
    throw new Error(
      'JWT_SECRET is not strong enough to sign sessions with: ' + problems.join('; ') + '.\n'
      + 'Generate a real key with `openssl rand -hex 32` and set it in .env and in the '
      + 'platform environment.\n'
      + 'Rotating it invalidates every existing session cookie, which is intended.'
    );
  }
}
assertUsableJwtSecret(JWT_SECRET);

function normalizeSameSite(value) {
  const normalized = String(value || '').toLowerCase();
  return ['strict', 'lax', 'none'].includes(normalized) ? normalized : 'lax';
}

const sameSite = normalizeSameSite(process.env.COOKIE_SAME_SITE || process.env.COOKIE_SAMESITE);
// COOKIE_SECURE=false is a localhost affordance, so it is only honoured in
// development. Left overridable everywhere it silently downgraded deployed
// sessions: this repo's own .env carries NODE_ENV=production together with
// COOKIE_SECURE=false, which issued the 7-day session cookie without Secure and
// let any plaintext request to the host put it on the wire.
const isDevelopment = process.env.NODE_ENV === 'development';
const secureCookie = isDevelopment ? process.env.COOKIE_SECURE === 'true' : true;

const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: sameSite === 'none' ? true : secureCookie,
  sameSite,
  ...(process.env.COOKIE_DOMAIN ? { domain: process.env.COOKIE_DOMAIN } : {}),
};

const oauth2Client = new OAuth2Client(
  process.env.GOOGLE_OAUTH_CLIENT_ID,
  process.env.GOOGLE_OAUTH_CLIENT_SECRET,
  process.env.GOOGLE_OAUTH_REDIRECT_URI
);

// Where to send the browser after the Google round-trip. The callback always
// lands on this server's own origin (it's whatever GOOGLE_OAUTH_REDIRECT_URI
// says, e.g. http://localhost:5001) because that's the URL registered with
// Google — never the Vite dev origin. In production that's fine, Express
// serves the built client from the same origin (relative redirect). In dev
// the client only exists on the Vite server, so a relative redirect here 404s
// against a client/dist that was never built. CLIENT_DEV_URL lets that be
// overridden; the Vite default port is the fallback.
const POST_LOGIN_ORIGIN = process.env.NODE_ENV === 'development'
  ? (process.env.CLIENT_DEV_URL || 'http://localhost:3000')
  : '';

function isAllowedEmail(email) {
  if (!email) return false;
  const allowedEmails = (process.env.ALLOWED_GOOGLE_EMAILS || '')
    .split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
  if (allowedEmails.includes(email.toLowerCase())) return true;

  const allowedDomain = (process.env.ALLOWED_GOOGLE_DOMAIN || '').trim().toLowerCase();
  if (allowedDomain && email.toLowerCase().endsWith('@' + allowedDomain)) return true;

  // Fails closed. This used to `return !allowedEmails.length && !allowedDomain`,
  // so a deployment that configured neither variable admitted every Google
  // account on the internet -- and every session is minted with role 'seo', which
  // is the only gate on all 30+ routers, the crawler's outbound fetches and all
  // third-party API spend. An unconfigured allowlist is now a boot failure
  // (assertSignInAllowlist) instead of an open door.
  return false;
}

// Refuse to boot with no allowlist at all, mirroring the JWT_SECRET assertion.
// Catching this at startup is the whole point: misconfigured this way the app
// looks healthy and serves traffic, and nothing surfaces the fact that anyone
// can sign in until someone does.
function assertSignInAllowlist() {
  const emails = (process.env.ALLOWED_GOOGLE_EMAILS || '').split(',').map(e => e.trim()).filter(Boolean);
  const domain = (process.env.ALLOWED_GOOGLE_DOMAIN || '').trim();
  if (!emails.length && !domain) {
    throw new Error(
      'Neither ALLOWED_GOOGLE_EMAILS nor ALLOWED_GOOGLE_DOMAIN is set, so no Google account '
      + 'could be authorised to sign in. Set ALLOWED_GOOGLE_DOMAIN to your organisation domain '
      + '(e.g. ALLOWED_GOOGLE_DOMAIN=example.com) and/or ALLOWED_GOOGLE_EMAILS to a comma-separated '
      + 'list of individual addresses, in .env and in the platform environment.'
    );
  }
}
assertSignInAllowlist();

// The identity minted by /dev-login, which is not a Google account and so can
// never satisfy the allowlist. It only exists when NODE_ENV=development and no
// GOOGLE_OAUTH_CLIENT_ID is configured (see /dev-login), and the re-check below
// honours exactly those same two conditions rather than trusting the name alone.
const DEV_LOCAL_USER = 'dev-local@localhost';

// Re-evaluated on every authenticated request, so removing someone from the
// allowlist takes effect at once instead of when their 7-day cookie expires.
// This is a cheap, in-process check (no query); it revokes access by *account
// standing*. It is deliberately not a full per-token revocation story -- a
// stolen cookie for a still-allowed account remains valid until it expires, and
// closing that needs a token id and a denylist (see notes in the audit).
function isSessionIdentityStillAllowed(username) {
  if (
    isDevelopment
    && !process.env.GOOGLE_OAUTH_CLIENT_ID
    && username === DEV_LOCAL_USER
  ) {
    return true;
  }
  return isAllowedEmail(username);
}

// Constant-time compare of two strings of possibly different length.
function timingSafeEqualStr(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

router.post('/logout', (req, res) => {
  res.clearCookie(COOKIE_NAME, COOKIE_OPTIONS);
  // The workspace selection outlived the session it was made in (30 days), so on
  // a shared browser the next person to sign in silently inherited the previous
  // user's workspace as their active one.
  res.clearCookie(WORKSPACE_COOKIE, COOKIE_OPTIONS);
  res.json({ ok: true });
});

// ── Dev-only bypass ───────────────────────────────────────────────────────
// Lets local development proceed before a Google OAuth client exists. Gated
// on two conditions, not one: NODE_ENV=development so it can never exist in a
// deployed environment, AND no GOOGLE_OAUTH_CLIENT_ID so it self-disables the
// moment real credentials are configured — a bypass that outlives the reason
// it was added is the actual risk here, more than the bypass itself.
router.post('/dev-login', (req, res) => {
  if (process.env.NODE_ENV !== 'development' || process.env.GOOGLE_OAUTH_CLIENT_ID) {
    return res.status(404).json({ error: 'Not found.' });
  }
  const sessionToken = jwt.sign(
    { username: 'dev-local@localhost', role: 'seo' },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
  res.cookie(COOKIE_NAME, sessionToken, COOKIE_OPTIONS);
  res.json({ ok: true });
});

router.get('/verify', async (req, res) => {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) return res.json({ valid: false });

  // "Is this session valid?" and "is the identity store reachable?" are separate
  // questions, and collapsing both into `valid: false` meant a database blip
  // logged out every signed-in user at once: App.jsx reads valid:false as "not
  // authenticated" and redirects to /login, which then hits the same dead
  // upstream. The token is therefore checked on its own here, and only the
  // database reads below are allowed to answer 503.
  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET);
  } catch (e) {
    return res.json({ valid: false });
  }
  if (payload.username === LEGACY_EMBED_USER) return res.json({ valid: false });
  // A session is only as good as its account's *current* standing. Without this
  // re-check a cookie stayed usable for its full 7 days after the person was
  // removed from the allowlist, so off-boarding someone had no effect for a week.
  if (!isSessionIdentityStillAllowed(payload.username)) {
    return res.json({ valid: false });
  }

  try {
    // Both reads at once. They are independent — one asks whether this user has
    // finished profile setup, the other whether they hold a platform-admin grant
    // — and they were awaited one after the other, so a verified session cost two
    // full round trips to a database ~250ms away.
    //
    // Nothing waits on this more than the app itself: App.jsx renders a blank
    // screen until /verify answers, so every millisecond here is a millisecond
    // before the first dashboard request is even sent. On this deployment that
    // was 506ms of dead time; in parallel it is 250ms.
    //
    // `hasProfile` defaults true: a session with no userId skips the profile step.
    const [profile, isPlatformAdmin] = await Promise.all([
      payload.userId && isDatabaseConfigured()
        ? identityStore.getProfile(payload.userId)
        : Promise.resolve(true),
      // Sent so the client can render the admin nav. It is a hint, never an
      // authorization decision: every /api/admin route re-checks the persisted
      // grant server-side, so a browser that flips this flag gains nothing
      // (PRD §7.2 last paragraph, AC-002).
      platformAdmin.isPlatformAdmin({
        email: payload.username,
        userId: payload.userId,
      }),
    ]);
    const hasProfile = Boolean(profile);
    res.json({
      valid: true,
      role: payload.role,
      email: payload.username,
      userId: payload.userId,
      hasProfile,
      isPlatformAdmin,
    });
  } catch (e) {
    // Reaching here means the session parsed but the identity store did not
    // answer, which is not the same as "your session is invalid" and must not be
    // reported as one. See the note above the token check.
    console.error('[Auth] /verify could not reach the identity store:', e.message);
    res.status(503).json({ error: 'Sign-in service is temporarily unavailable.' });
  }
});

function requireAuth(req, res, next) {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) return res.status(401).json({ error: 'Not authenticated.' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    // Sessions minted by the removed shared-token paths. They are still validly
    // signed for up to a week, so they are rejected by identity rather than left
    // to expire — otherwise "removed" would mean "removed for new visitors".
    if (req.user.username === LEGACY_EMBED_USER) {
      return res.status(401).json({ error: 'Please sign in with Google.' });
    }
    // Same reasoning as in /verify: a validly-signed cookie for an account that
    // is no longer allowed to sign in must stop working now, not in seven days.
    if (!isSessionIdentityStillAllowed(req.user.username)) {
      return res.status(401).json({ error: 'This account is no longer authorised. Please sign in again.' });
    }
    // peek, not resolve: the cached workspace is already membership-checked,
    // and the activity trail must never add a query to the request path.
    identityStore.recordActivity({
      userId: req.user.userId,
      workspaceId: peekWorkspaceId(req.user.userId),
      method: req.method,
      path: req.baseUrl || req.path,
    });
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Session expired. Please log in again.' });
  }
}

function requireSeo(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== 'seo') return res.status(403).json({ error: 'Forbidden.' });
    next();
  });
}

// GET /api/auth/google
// Redirects to Google's consent screen to start "Sign in with Google".
// Ties the callback to the browser that began the flow. SameSite=Lax governs
// when a cookie is *sent*, not when it is *set*, so a cross-site GET reaching
// the callback still had its Set-Cookie honoured -- letting an attacker replay
// their own authorization code into a victim's browser and silently seat the
// victim in the attacker's account (login CSRF / session fixation, RFC 6749
// §10.12). The state cookie is short-lived and scoped to this exchange only.
const OAUTH_STATE_COOKIE = 'oauth_state';
const OAUTH_STATE_OPTIONS = { ...COOKIE_OPTIONS, maxAge: 10 * 60 * 1000 };

router.get('/google', (req, res) => {
  const state = crypto.randomBytes(32).toString('hex');
  res.cookie(OAUTH_STATE_COOKIE, state, OAUTH_STATE_OPTIONS);
  const url = oauth2Client.generateAuthUrl({
    scope: ['openid', 'email', 'profile'],
    prompt: 'select_account',
    state,
  });
  res.redirect(url);
});

// GET /api/auth/google/callback
// Exchanges the auth code for tokens, verifies the ID token, checks the
// caller's email against the allowlist/domain, then issues our own session cookie.
router.get('/google/callback', async (req, res) => {
  const { code, error, state } = req.query;
  if (error || !code) return res.redirect(`${POST_LOGIN_ORIGIN}/login?error=access_denied`);

  // Compared before the code is exchanged, so a forged callback costs nothing
  // and never reaches Google. The cookie is cleared either way: a state value is
  // single-use, and leaving it set would let one flow's state authorise a second.
  const expectedState = req.cookies?.[OAUTH_STATE_COOKIE];
  res.clearCookie(OAUTH_STATE_COOKIE, COOKIE_OPTIONS);
  if (!expectedState || !state || !timingSafeEqualStr(String(state), expectedState)) {
    console.error('[Auth] Google callback rejected: OAuth state missing or mismatched.');
    return res.redirect(`${POST_LOGIN_ORIGIN}/login?error=access_denied`);
  }

  try {
    const { tokens } = await oauth2Client.getToken(code);
    const ticket = await oauth2Client.verifyIdToken({
      idToken: tokens.id_token,
      audience: process.env.GOOGLE_OAUTH_CLIENT_ID,
    });
    const payload = ticket.getPayload();

    if (!payload.email_verified || !isAllowedEmail(payload.email)) {
      return res.redirect(`${POST_LOGIN_ORIGIN}/login?error=unauthorized`);
    }

    let userId;
    if (isDatabaseConfigured()) {
      const user = await identityStore.getOrCreateUser(payload.email);
      userId = user.id;
      // This is the one moment both the Google-verified email and the app_users
      // row are known, so it is where a pending platform-admin grant gets
      // linked to a user id (PRD §7.3, requirement 4: idempotent when the
      // account already exists). Never fails the login — a link failure means
      // the grant stays pending and is retried next sign-in.
      await platformAdmin.linkGrantForUser({ userId, email: payload.email });
    }

    const sessionToken = jwt.sign(
      { username: payload.email, role: 'seo', userId },
      JWT_SECRET,
      { expiresIn: '7d' }
    );
    res.cookie(COOKIE_NAME, sessionToken, COOKIE_OPTIONS);
    res.redirect(POST_LOGIN_ORIGIN || '/');
  } catch (e) {
    // "Try again" is only sound advice when trying again can work. A database
    // that is down produces the same exception shape as a genuine sign-in
    // problem, and telling the user to retry sends them round a loop that
    // cannot succeed — every attempt hits the same dead upstream.
    if (e?.upstreamUnavailable) {
      console.error('[Auth] Google callback blocked by an unavailable upstream:', e.message);
      return res.redirect(`${POST_LOGIN_ORIGIN}/login?error=service_unavailable`);
    }
    console.error('[Auth] Google callback failed:', e.message);
    res.redirect(`${POST_LOGIN_ORIGIN}/login?error=login_failed`);
  }
});

module.exports = {
  router,
  requireAuth,
  requireSeo,
  COOKIE_OPTIONS,
  WORKSPACE_COOKIE,
  // Exposed for the tests in ./__tests__/auth.test.js. These are the two gates
  // that decide whether an anonymous caller becomes an authenticated one, and
  // both previously failed open, so they are worth asserting on directly.
  __testables: {
    assertUsableJwtSecret,
    assertSignInAllowlist,
    isAllowedEmail,
    isSessionIdentityStillAllowed,
    timingSafeEqualStr,
  },
};
