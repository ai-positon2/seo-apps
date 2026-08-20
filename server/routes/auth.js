const express = require('express');
const jwt = require('jsonwebtoken');
const { OAuth2Client } = require('google-auth-library');
const { isSupabaseConfigured } = require('../services/supabase');
const identityStore = require('../services/identityStore');
const { peekWorkspaceId } = require('../services/workspaceContext');
const router = express.Router();

const COOKIE_NAME = 'seo_session';
// Which workspace the user is currently working in. Only ever read through
// workspaceContext, which membership-checks it before anything is written
// against it — a cookie is caller-supplied and never trusted as-is.
const WORKSPACE_COOKIE = 'workspace_id';
const JWT_SECRET = process.env.JWT_SECRET || 'seo-automation-fallback-secret';

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

router.get('/verify', async (req, res) => {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) return res.json({ valid: false });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    let hasProfile = true; // platform/embed sessions (no userId) skip the profile step
    if (payload.userId && isSupabaseConfigured()) {
      hasProfile = Boolean(await identityStore.getProfile(payload.userId));
    }
    res.json({ valid: true, role: payload.role, email: payload.username, userId: payload.userId, hasProfile });
  } catch (e) {
    res.json({ valid: false });
  }
});

function requireAuth(req, res, next) {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) return res.status(401).json({ error: 'Not authenticated.' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
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
  if (error || !code) return res.redirect('/login?error=access_denied');

  try {
    const { tokens } = await oauth2Client.getToken(code);
    const ticket = await oauth2Client.verifyIdToken({
      idToken: tokens.id_token,
      audience: process.env.GOOGLE_OAUTH_CLIENT_ID,
    });
    const payload = ticket.getPayload();

    if (!payload.email_verified || !isAllowedEmail(payload.email)) {
      return res.redirect('/login?error=unauthorized');
    }

    let userId;
    if (isSupabaseConfigured()) {
      const user = await identityStore.getOrCreateUser(payload.email);
      userId = user.id;
    }

    const sessionToken = jwt.sign(
      { username: payload.email, role: 'seo', userId },
      JWT_SECRET,
      { expiresIn: '7d' }
    );
    res.cookie(COOKIE_NAME, sessionToken, COOKIE_OPTIONS);
    res.redirect('/');
  } catch (e) {
    console.error('[Auth] Google callback failed:', e.message);
    res.redirect('/login?error=login_failed');
  }
});

// GET /api/auth/platform-login?token=xxx
// Silent auto-login for the Position2 Intelligence Platform iframe embed.
router.get('/platform-login', (req, res) => {
  const platformToken = process.env.PLATFORM_TOKEN;
  if (!platformToken || req.query.token !== platformToken) {
    return res.status(401).json({ error: 'Invalid platform token.' });
  }
  const role = process.env.PLATFORM_DEFAULT_ROLE || 'seo';
  const token = jwt.sign({ username: 'platform_embed', role }, JWT_SECRET, { expiresIn: '7d' });
  res.cookie(COOKIE_NAME, token, COOKIE_OPTIONS);
  res.json({ ok: true });
});

module.exports = { router, requireAuth, requireSeo, COOKIE_OPTIONS, WORKSPACE_COOKIE };
