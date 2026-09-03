const express = require('express');
const jwt = require('jsonwebtoken');
const { OAuth2Client } = require('google-auth-library');
const { isSupabaseConfigured } = require('../services/supabase');
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
if (!JWT_SECRET) {
  throw new Error(
    'JWT_SECRET is not set. Sessions are signed with it, so the server will not start ' +
    'without one. Generate a long random value (e.g. `openssl rand -hex 32`) and put it ' +
    'in .env as JWT_SECRET.'
  );
}

function normalizeSameSite(value) {
  const normalized = String(value || '').toLowerCase();
  return ['strict', 'lax', 'none'].includes(normalized) ? normalized : 'lax';
}

const sameSite = normalizeSameSite(process.env.COOKIE_SAME_SITE || process.env.COOKIE_SAMESITE);
const secureCookie = process.env.COOKIE_SECURE
  ? process.env.COOKIE_SECURE === 'true'
  : process.env.NODE_ENV !== 'development';

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

  return !allowedEmails.length && !allowedDomain;
}

router.post('/logout', (req, res) => {
  res.clearCookie(COOKIE_NAME, COOKIE_OPTIONS);
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
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.username === LEGACY_EMBED_USER) return res.json({ valid: false });
    let hasProfile = true; // a session with no userId skips the profile step
    if (payload.userId && isSupabaseConfigured()) {
      hasProfile = Boolean(await identityStore.getProfile(payload.userId));
    }
    // Sent so the client can render the admin nav. It is a hint, never an
    // authorization decision: every /api/admin route re-checks the persisted
    // grant server-side, so a browser that flips this flag gains nothing
    // (PRD §7.2 last paragraph, AC-002).
    const isPlatformAdmin = await platformAdmin.isPlatformAdmin({
      email: payload.username,
      userId: payload.userId,
    });
    res.json({
      valid: true,
      role: payload.role,
      email: payload.username,
      userId: payload.userId,
      hasProfile,
      isPlatformAdmin,
    });
  } catch (e) {
    res.json({ valid: false });
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
router.get('/google', (req, res) => {
  const url = oauth2Client.generateAuthUrl({
    scope: ['openid', 'email', 'profile'],
    prompt: 'select_account',
  });
  res.redirect(url);
});

// GET /api/auth/google/callback
// Exchanges the auth code for tokens, verifies the ID token, checks the
// caller's email against the allowlist/domain, then issues our own session cookie.
router.get('/google/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error || !code) return res.redirect(`${POST_LOGIN_ORIGIN}/login?error=access_denied`);

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
    if (isSupabaseConfigured()) {
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
    console.error('[Auth] Google callback failed:', e.message);
    res.redirect(`${POST_LOGIN_ORIGIN}/login?error=login_failed`);
  }
});

module.exports = { router, requireAuth, requireSeo, COOKIE_OPTIONS, WORKSPACE_COOKIE };
