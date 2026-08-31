// ── googleExtract ─────────────────────────────────────────────────────────
//
// Fixtures from live recon: Google refused /search on the first request and
// udm=50 on the second, from a plain residential ISP address.
//
// Run: node modules/aiVisibility/__tests__/googleExtract.test.js

const assert = require('assert');
const g = require('../captureEngines/googleExtract');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (e) { failed += 1; console.error(`  ✗ ${name}\n    ${e.message}`); }
}
const section = (name) => console.log(`\n${name}`);

// Verbatim from the blocked recon run.
const BLOCKED = `About this page

Our systems have detected unusual traffic from your computer network. This page
checks to see if it's really you sending the requests, and not a robot.`;

const ANSWER = `Skip to main content
Accessibility help
AI Mode
All
Images
Videos
News
More
Sign in
Search Results
best dental implant providers in boston
When looking for top-tier dental implant providers in Boston, it's essential to
find a practice that combines multi-specialty expertise with modern technique.
People also ask`;

section('blockReason — a refusal must never read as an absent brand');

test('detects the interstitial text', () => {
  assert.strictEqual(g.blockReason({ mainText: BLOCKED }), 'google_captcha');
});

test('detects the /sorry redirect even before the body is read', () => {
  assert.strictEqual(
    g.blockReason({ url: 'https://www.google.com/sorry/index?continue=https://www.google.com/search' }),
    'google_captcha',
  );
});

test('a real answer page is not a block', () => {
  assert.strictEqual(g.blockReason({ mainText: ANSWER, url: 'https://www.google.com/search?q=x&udm=50' }), null);
});

section('unwrapGoogleUrl');

test('recovers the destination from Google\'s /url?q= wrapper', () => {
  assert.strictEqual(
    g.unwrapGoogleUrl('https://www.google.com/url?q=https://bostonimplantcenter.com/implants&sa=U'),
    'https://bostonimplantcenter.com/implants',
  );
});

test('leaves an already-direct link alone', () => {
  assert.strictEqual(g.unwrapGoogleUrl('https://ada.org/guidelines'), 'https://ada.org/guidelines');
});

test('malformed input never throws', () => {
  assert.strictEqual(g.unwrapGoogleUrl('not a url'), 'not a url');
});

section('citationsFromLinks — Google DOES expose full URLs, unlike ChatGPT');

test('keeps the full destination URL, which is what the URLs report needs', () => {
  const c = g.citationsFromLinks(['https://www.google.com/url?q=https://ada.org/guidelines/prophylaxis&sa=U']);
  assert.strictEqual(c.length, 1);
  assert.strictEqual(c[0].url, 'https://ada.org/guidelines/prophylaxis');
  assert.strictEqual(c[0].domain, 'ada.org');
});

test('Google\'s own properties are chrome, not sources', () => {
  const c = g.citationsFromLinks([
    'https://www.google.com/preferences',
    'https://policies.google.com/privacy',
    'https://www.youtube.com/watch?v=1',
    'https://gstatic.com/x.js',
  ]);
  assert.deepStrictEqual(c, []);
});

test('repeat citations of one host are counted, not duplicated', () => {
  const c = g.citationsFromLinks([
    'https://ada.org/a', 'https://ada.org/b', 'https://heart.org/c',
  ]);
  assert.strictEqual(c.length, 2);
  assert.strictEqual(c.find((x) => x.domain === 'ada.org').occurrences, 2);
});

test('host and registrable domain stay distinct', () => {
  const [c] = g.citationsFromLinks(['https://adanews.ada.org/story']);
  assert.strictEqual(c.host, 'adanews.ada.org');
  assert.strictEqual(c.domain, 'adanews.ada.org');
});

section('answerFromContainerText');

test('strips Google nav chrome from the answer', () => {
  const a = g.answerFromContainerText(ANSWER);
  assert.match(a, /top-tier dental implant providers/);
  assert.ok(!/Skip to main content/.test(a));
  assert.ok(!/People also ask/.test(a));
  assert.ok(!/Accessibility help/.test(a));
});

test('chrome-only content yields null, not a fake answer', () => {
  assert.strictEqual(g.answerFromContainerText('All\nImages\nVideos\nMore\nSign in'), null);
});

test('no AI block at all is null — a real and common outcome', () => {
  assert.strictEqual(g.answerFromContainerText(''), null);
  assert.strictEqual(g.answerFromContainerText(null), null);
});

section('aiOverviewFromBodyText — anchored on the heading, not a selector');

// Verbatim shape from a live captured AI Overview.
const AIO_BODY = `Skip to main content
Sign in
AI Mode
All
Images
Search Results
Boston, MA, USA
 ∙ Choose area
AI Overview
ಕನ್ನಡ
Top dental implant providers in Boston include multi-specialty centers and
experienced oral surgeons utilizing advanced 3D digital planning.
Boston Dental: Known for advanced 3D imaging.
People also ask
Tufts dental School implant cost`;

test('reads from the AI Overview heading to the next SERP section', () => {
  const a = g.aiOverviewFromBodyText(AIO_BODY);
  assert.match(a, /Top dental implant providers in Boston/);
  assert.match(a, /Boston Dental/);
});

test('stops at "People also ask" — SERP furniture is not the answer', () => {
  const a = g.aiOverviewFromBodyText(AIO_BODY);
  assert.ok(!/People also ask/.test(a));
  assert.ok(!/Tufts dental School implant cost/.test(a));
});

test('drops the language switcher and location chip that flank the heading', () => {
  const a = g.aiOverviewFromBodyText(AIO_BODY);
  assert.ok(!/ಕನ್ನಡ/.test(a));
  assert.ok(!/Choose area/.test(a));
});

test('no AI Overview on the page yields null — a real, common outcome', () => {
  assert.strictEqual(g.aiOverviewFromBodyText('Search Results\nAll\nImages\njust organic results'), null);
});

section('aiModeFromBodyText — anchored on the echoed query');

const AIMODE_BODY = `Skip to main content
AI Mode
All
Images
Sign in
Search Results
best dental implant providers in boston
When looking for top-tier dental implant providers in Boston, it's essential to
find a practice that combines multi-specialty expertise.
People also ask`;

test('reads the answer following the echoed query', () => {
  const a = g.aiModeFromBodyText(AIMODE_BODY, 'best dental implant providers in boston');
  assert.match(a, /top-tier dental implant providers/);
});

test('does not anchor on the "AI Mode" nav tab, which is navigation not an answer', () => {
  const a = g.aiModeFromBodyText(AIMODE_BODY, 'best dental implant providers in boston');
  assert.ok(!/^All$/m.test(a));
  assert.ok(!/Skip to main content/.test(a));
});

test('a query that never appears yields null rather than the whole page', () => {
  assert.strictEqual(g.aiModeFromBodyText(AIMODE_BODY, 'something else entirely'), null);
});

section('citationsFromFavicons — the real carrier for Google AI sources');

// Verbatim srcs harvested from a live AI Mode page. Note the service and
// parameter differ from ChatGPT's: faviconV2?url= vs s2/favicons?domain=.
const AIM_FAVICONS = [
  'https://encrypted-tbn3.gstatic.com/faviconV2?url=https://jarvisanalytics.com&amp;client=AIM&amp;size=128',
  'https://encrypted-tbn2.gstatic.com/faviconV2?url=https://zocdoc.com&amp;client=AIM&amp;size=128',
  'https://encrypted-tbn1.gstatic.com/faviconV2?url=https://www.bostondental.com&amp;client=AIM&amp;size=128',
  'https://encrypted-tbn0.gstatic.com/faviconV2?url=http://www.dentalimplantsofboston.com&amp;client=AIM',
  'https://encrypted-tbn2.gstatic.com/faviconV2?url=https://zocdoc.com&amp;client=AIM&amp;size=128',
];

test('decodes Google\'s faviconV2 url= parameter', () => {
  const c = g.citationsFromFavicons(AIM_FAVICONS);
  const domains = c.map((x) => x.domain);
  assert.ok(domains.includes('zocdoc.com'));
  assert.ok(domains.includes('bostondental.com'));
  assert.ok(domains.includes('jarvisanalytics.com'));
});

test('also handles ChatGPT\'s s2/favicons domain= form, so one function serves both', () => {
  const c = g.citationsFromFavicons(['https://www.google.com/s2/favicons?domain=https%3A%2F%2Fwww.ada.org&sz=128']);
  assert.strictEqual(c[0].domain, 'ada.org');
});

test('http:// and www. are normalised to one host', () => {
  const c = g.citationsFromFavicons(AIM_FAVICONS);
  assert.ok(c.some((x) => x.domain === 'dentalimplantsofboston.com'));
});

test('repeat sources are counted, not duplicated', () => {
  const c = g.citationsFromFavicons(AIM_FAVICONS);
  assert.strictEqual(c.find((x) => x.domain === 'zocdoc.com').occurrences, 2);
});

test('Google\'s own chrome favicons are not sources', () => {
  const c = g.citationsFromFavicons([
    'https://encrypted-tbn0.gstatic.com/faviconV2?url=https://www.google.com&client=AIM',
    'https://encrypted-tbn0.gstatic.com/faviconV2?url=https://gstatic.com&client=AIM',
  ]);
  assert.deepStrictEqual(c, []);
});

section('mergeCitations — one domain, the richest row');

test('a link with a full URL beats a favicon chip for the same host', () => {
  const merged = g.mergeCitations(
    g.citationsFromLinks(['https://ada.org/guidelines/x']),
    g.citationsFromFavicons(['https://encrypted-tbn0.gstatic.com/faviconV2?url=https://ada.org&client=AIM']),
  );
  assert.strictEqual(merged.length, 1, 'the same host must not appear twice');
  assert.strictEqual(merged[0].url, 'https://ada.org/guidelines/x', 'the richer row wins');
});

test('occurrences accumulate across carriers, and index is re-sequenced', () => {
  const merged = g.mergeCitations(
    g.citationsFromLinks(['https://ada.org/a']),
    g.citationsFromFavicons(['https://encrypted-tbn0.gstatic.com/faviconV2?url=https://ada.org&client=AIM']),
  );
  assert.strictEqual(merged[0].occurrences, 2);
  assert.deepStrictEqual(merged.map((c) => c.index), [0]);
});

section('hasAiBlock — parsing failure must not masquerade as an absence');

test('detects a present AI block so an unreadable one can be failed, not scored', () => {
  assert.strictEqual(g.hasAiBlock(AIO_BODY), true);
  assert.strictEqual(g.hasAiBlock(AIMODE_BODY), true);
});

test('a plain SERP with no AI block is genuinely absent, not a failure', () => {
  assert.strictEqual(g.hasAiBlock('Search Results\nAll\nImages\norganic results only'), false);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
