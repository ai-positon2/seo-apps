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
