// Auth had no tests at all, which is how both of its fail-open defects survived:
// an unconfigured sign-in allowlist admitted every Google account on the
// internet, and JWT_SECRET was accepted on truthiness alone. Both gates decide
// whether an anonymous caller becomes an authenticated one, so they are asserted
// here directly rather than through the router.
//
// auth.js validates its configuration at import time, so every case that needs
// different configuration re-imports the module with a cleared cache.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const AUTH_PATH = path.join(__dirname, '..', 'auth.js');
const STRONG_SECRET = 'a3f1c9e04b7d26185a0c4f93be27d5108e6b4a72f0d9c3516782be4f0ac91d3e';

// Runs `fn` with auth.js imported under a specific environment, and only then
// restores the previous env. The callback shape matters: isAllowedEmail and the
// dev-login bypass read process.env at CALL time (only isDevelopment and
// COOKIE_OPTIONS are captured at import), so tearing the environment down before
// the assertions run would silently test the ambient .env instead of the fixture.
function withAuth(env, fn) {
  const saved = { ...process.env };
  Object.assign(process.env, {
    JWT_SECRET: STRONG_SECRET,
    ALLOWED_GOOGLE_DOMAIN: 'example.com',
    ALLOWED_GOOGLE_EMAILS: '',
    NODE_ENV: 'test',
    ...env,
  });
  delete require.cache[require.resolve(AUTH_PATH)];
  try {
    return fn(require(AUTH_PATH));
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    delete require.cache[require.resolve(AUTH_PATH)];
  }
}

// For the cases that only assert on import-time behaviour (throw / don't throw).
function loadAuth(env = {}) {
  return withAuth(env, (m) => m);
}

// ── JWT_SECRET strength ──────────────────────────────────────────────────────

test('a generated 32-byte key is accepted', () => {
  const { __testables } = loadAuth();
  assert.doesNotThrow(() => __testables.assertUsableJwtSecret(STRONG_SECRET));
});

test('an absent secret is refused', () => {
  const { __testables } = loadAuth();
  assert.throws(() => __testables.assertUsableJwtSecret(''), /is not set/);
  assert.throws(() => __testables.assertUsableJwtSecret(undefined), /is not set/);
});

test('a secret shorter than 32 non-whitespace characters is refused', () => {
  const { __testables } = loadAuth();
  assert.throws(() => __testables.assertUsableJwtSecret('a1b2c3d4'), /at least 32/);
});

test('a word passphrase is refused however long it is', () => {
  const { __testables } = loadAuth();
  // The real value this repo shipped: 67 characters, so a length-only check
  // passed it, but 13 grammatical English words carry a few tens of bits at most.
  const passphrase = 'the quick brown fox jumps over the very lazy sleeping guard dog today';
  assert.ok(passphrase.replace(/\s+/g, '').length >= 32, 'fixture must clear the length bar');
  assert.throws(() => __testables.assertUsableJwtSecret(passphrase), /passphrase/);
});

test('a placeholder is refused', () => {
  const { __testables } = loadAuth();
  assert.throws(
    () => __testables.assertUsableJwtSecret('your-secret-here-your-secret-here-xx'),
    /placeholder/,
  );
});

test('a long but low-variety secret is refused', () => {
  const { __testables } = loadAuth();
  assert.throws(() => __testables.assertUsableJwtSecret('ab'.repeat(40)), /distinct characters/);
});

test('importing with a weak secret refuses to boot', () => {
  assert.throws(() => loadAuth({ JWT_SECRET: 'short' }), /JWT_SECRET/);
});

// ── Sign-in allowlist ────────────────────────────────────────────────────────

test('an unconfigured allowlist refuses to boot rather than admitting everyone', () => {
  assert.throws(
    () => loadAuth({ ALLOWED_GOOGLE_DOMAIN: '', ALLOWED_GOOGLE_EMAILS: '' }),
    /ALLOWED_GOOGLE_EMAILS|ALLOWED_GOOGLE_DOMAIN/,
  );
});

test('isAllowedEmail fails closed for an address outside the allowlist', () => {
  withAuth({ ALLOWED_GOOGLE_DOMAIN: 'example.com' }, ({ __testables }) => {
    assert.equal(__testables.isAllowedEmail('someone@example.com'), true);
    // The regression that mattered: any gmail.com account used to be admitted.
    assert.equal(__testables.isAllowedEmail('attacker@gmail.com'), false);
    assert.equal(__testables.isAllowedEmail(''), false);
    assert.equal(__testables.isAllowedEmail(undefined), false);
  });
});

test('the domain rule matches only the domain part, not any occurrence of it', () => {
  withAuth({ ALLOWED_GOOGLE_DOMAIN: 'example.com' }, ({ __testables }) => {
    assert.equal(__testables.isAllowedEmail('someone@example.com.evil.net'), false);
    assert.equal(__testables.isAllowedEmail('example.com@evil.net'), false);
  });
});

test('an individual address is allowed without a domain rule, case-insensitively', () => {
  withAuth({
    ALLOWED_GOOGLE_DOMAIN: '',
    ALLOWED_GOOGLE_EMAILS: 'One@Example.com, two@other.org',
  }, ({ __testables }) => {
    assert.equal(__testables.isAllowedEmail('one@example.com'), true);
    assert.equal(__testables.isAllowedEmail('ONE@EXAMPLE.COM'), true);
    assert.equal(__testables.isAllowedEmail('two@other.org'), true);
    assert.equal(__testables.isAllowedEmail('three@other.org'), false);
  });
});

// ── Session re-checking ──────────────────────────────────────────────────────

test('a session for a de-allowlisted account stops being accepted immediately', () => {
  withAuth({ ALLOWED_GOOGLE_DOMAIN: 'example.com' }, ({ __testables }) => {
    assert.equal(__testables.isSessionIdentityStillAllowed('staff@example.com'), true);
    // Same signed cookie, account no longer allowed: must not wait for the 7-day expiry.
    assert.equal(__testables.isSessionIdentityStillAllowed('leaver@other.org'), false);
  });
});

test('the dev-login identity is only honoured in development without a Google client', () => {
  const devEnv = { NODE_ENV: 'development', ALLOWED_GOOGLE_DOMAIN: 'example.com' };

  withAuth({ ...devEnv, GOOGLE_OAUTH_CLIENT_ID: '' }, ({ __testables }) => {
    assert.equal(__testables.isSessionIdentityStillAllowed('dev-local@localhost'), true);
  });

  // Real OAuth credentials present: the bypass identity must stop working, since
  // /dev-login itself self-disables under exactly this condition.
  withAuth({
    ...devEnv,
    GOOGLE_OAUTH_CLIENT_ID: 'real-client-id.apps.googleusercontent.com',
  }, ({ __testables }) => {
    assert.equal(__testables.isSessionIdentityStillAllowed('dev-local@localhost'), false);
  });

  // And it must never be accepted outside development.
  withAuth({
    NODE_ENV: 'production',
    ALLOWED_GOOGLE_DOMAIN: 'example.com',
    GOOGLE_OAUTH_CLIENT_ID: '',
  }, ({ __testables }) => {
    assert.equal(__testables.isSessionIdentityStillAllowed('dev-local@localhost'), false);
  });
});

// ── Cookie flags ─────────────────────────────────────────────────────────────

test('Secure cannot be switched off outside development', () => {
  // The exact combination this repo's .env carried.
  const { COOKIE_OPTIONS } = loadAuth({ NODE_ENV: 'production', COOKIE_SECURE: 'false' });
  assert.equal(COOKIE_OPTIONS.secure, true, 'COOKIE_SECURE=false must not downgrade production');
  assert.equal(COOKIE_OPTIONS.httpOnly, true);
});

test('Secure is still opt-in-able for localhost development', () => {
  let opts = loadAuth({ NODE_ENV: 'development', COOKIE_SECURE: 'false' }).COOKIE_OPTIONS;
  assert.equal(opts.secure, false);
  opts = loadAuth({ NODE_ENV: 'development', COOKIE_SECURE: 'true' }).COOKIE_OPTIONS;
  assert.equal(opts.secure, true);
});

test('SameSite=None always forces Secure, since browsers reject it otherwise', () => {
  const { COOKIE_OPTIONS } = loadAuth({ NODE_ENV: 'development', COOKIE_SAME_SITE: 'none' });
  assert.equal(COOKIE_OPTIONS.sameSite, 'none');
  assert.equal(COOKIE_OPTIONS.secure, true);
});

// ── OAuth state comparison ───────────────────────────────────────────────────

test('the state comparison is exact and length-safe', () => {
  const { __testables } = loadAuth();
  const eq = __testables.timingSafeEqualStr;
  assert.equal(eq('abc123', 'abc123'), true);
  assert.equal(eq('abc123', 'abc124'), false);
  // Different lengths must return false rather than throwing, which is what
  // crypto.timingSafeEqual does on unequal buffers.
  assert.equal(eq('abc', 'abcdef'), false);
  assert.equal(eq('', ''), true);
});
