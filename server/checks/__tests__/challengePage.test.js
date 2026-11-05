// ── Bot walls are not the site's page ───────────────────────────────────────
//
// 8x8's whole SEO & GEO score (45) was a Vercel "Security Checkpoint" page, and
// a Cloudflare "Just a moment..." page scoring 15 pulled an Eventgroove site
// from 86 to 72.
//
// Run: node --test checks/__tests__/challengePage.test.js

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { challengeReason, pageFacts } = require('../challengePage');

test('known bot-protection titles are walls, whatever the status', () => {
  for (const title of ['Just a moment...', 'Vercel Security Checkpoint', 'Attention Required! | Cloudflare',
    'Verifying your connection...', 'Pardon Our Interruption']) {
    assert.ok(challengeReason({ title, wordCount: 400, status: 200 }), title);
  }
});

test('a refusal status with an almost empty page is a wall', () => {
  assert.ok(challengeReason({ title: 'Home', wordCount: 3, status: 429 }));
  assert.equal(challengeReason({ title: 'Home', wordCount: 900, status: 429 }), null);
});

test('real pages are never flagged', () => {
  assert.equal(challengeReason({ title: 'Teeth Whitening: What You Need to Know', wordCount: 4500, status: 200 }), null);
  assert.equal(challengeReason({ title: 'Just the facts about implants', wordCount: 20, status: 200 }), null);
});

test('a stored audit is read the same way (title A1, words F1)', () => {
  const stored = {
    meta: { http_status: 429 },
    checks: [{ id: 'A1', value: 'Just a moment...' }, { id: 'F1', value: '0' }],
  };
  assert.deepEqual(pageFacts(stored), { title: 'Just a moment...', wordCount: 0, status: 429 });
  assert.ok(challengeReason(pageFacts(stored)));
});

// Unanchored title patterns flagged real 200 pages as bot walls.
test('a real page whose title merely contains a challenge phrase is not a wall', () => {
  assert.equal(challengeReason({ title: 'Free Checking Your Way | Acme Bank', wordCount: 900, status: 200 }), null);
  assert.equal(challengeReason({ title: 'Security Checkpoint Software | Acme', wordCount: 900, status: 200 }), null);
  assert.equal(challengeReason({ title: 'Free Checking Your Way | Acme Bank', wordCount: 40, status: 200 }), null);
  assert.equal(challengeReason({ title: 'Captcha Solutions for Retail | Acme' }), null, 'title-only (sitemap crawler)');
});

test('a 200 page with a challenge title is a wall only when thin or carrying challenge markers', () => {
  assert.equal(challengeReason({ title: 'Just a moment...', wordCount: 1200, status: 200 }), null);
  assert.ok(challengeReason({ title: 'Just a moment...', wordCount: 1200, status: 200, html: '<script>window._cf_chl_opt={}</script>' }));
  assert.ok(challengeReason({ title: 'Security Checkpoint', wordCount: 1200, status: 200, headers: { 'x-vercel-mitigated': 'challenge' } }));
  assert.ok(challengeReason({ title: 'Just a moment…', wordCount: 30, status: 200 }));
  assert.ok(challengeReason({ title: 'Access to this page has been denied.', wordCount: 60, status: 200 }), 'PerimeterX');
  assert.ok(challengeReason({ title: 'Access Denied', wordCount: 20, status: 403 }), 'Akamai');
  assert.ok(challengeReason({ title: '', wordCount: 15, status: 200, html: '<iframe src="https://geo.captcha-delivery.com/captcha/"></iframe>' }), 'DataDome');
  assert.ok(challengeReason({ title: 'Just a moment...' }), 'title-only callers still recognise known walls');
});
