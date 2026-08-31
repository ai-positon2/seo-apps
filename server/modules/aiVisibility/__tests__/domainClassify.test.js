// ── domainClassify ────────────────────────────────────────────────────────
//
// Run: node modules/aiVisibility/__tests__/domainClassify.test.js

const assert = require('assert');
const d = require('../captureEngines/domainClassify');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (e) { failed += 1; console.error(`  ✗ ${name}\n    ${e.message}`); }
}
const section = (name) => console.log(`\n${name}`);

const SETS = { clientDomains: ['gentledental.com'], competitorDomains: ['aspendental.com'] };

section('registrableDomain — host and domain must stay distinguishable');

test('a subdomain rolls up to its registrable domain', () => {
  assert.strictEqual(d.registrableDomain('adanews.ada.org'), 'ada.org');
});

test('multi-part suffixes are not truncated to the suffix', () => {
  assert.strictEqual(d.registrableDomain('www.bbc.co.uk'), 'bbc.co.uk');
  assert.strictEqual(d.registrableDomain('news.nhs.uk'), 'nhs.uk');
});

test('a bare host (all ChatGPT gives us) works, not just a URL', () => {
  assert.strictEqual(d.registrableDomain('foreondental.com'), 'foreondental.com');
});

section('normaliseUrl — §5.1');

test('drops tracking params that identify a visit, not a page', () => {
  assert.strictEqual(
    d.normaliseUrl('https://www.ADA.org/Guidelines?utm_source=chatgpt.com&ct-referrer=perplexity&id=7#top'),
    'https://ada.org/Guidelines?id=7',
  );
});

test('keeps path case but lowercases the host', () => {
  assert.strictEqual(d.normaliseUrl('https://ADA.org/Some/Path'), 'https://ada.org/Some/Path');
});

test('strips one trailing slash and collapses duplicates', () => {
  assert.strictEqual(d.normaliseUrl('https://ada.org//a//b/'), 'https://ada.org/a/b');
});

test('two URLs differing only by tracking collapse to one', () => {
  const a = d.normaliseUrl('https://ada.org/x?utm_source=a');
  const b = d.normaliseUrl('https://ada.org/x?gclid=b');
  assert.strictEqual(a, b, 'otherwise one source splits across rows');
});

test('non-http schemes are rejected rather than stored', () => {
  assert.strictEqual(d.normaliseUrl('javascript:alert(1)'), null);
  assert.strictEqual(d.normaliseUrl('not a url'), null);
});

section('classifyDomain — the measured set always wins');

test('the client\'s own domain is `you`, whatever else it looks like', () => {
  assert.strictEqual(d.classifyDomain('https://gentledental.com/implants', SETS), 'you');
});

test('a configured competitor is `competitor`, not `corporate`', () => {
  assert.strictEqual(d.classifyDomain('aspendental.com', SETS), 'competitor');
});

test('a subdomain of the client still resolves to `you`', () => {
  assert.strictEqual(d.classifyDomain('blog.gentledental.com', SETS), 'you');
});

test('classification order: institutional before anything pattern-based', () => {
  assert.strictEqual(d.classifyDomain('ada.org', SETS), 'institutional');
  assert.strictEqual(d.classifyDomain('bu.edu', SETS), 'institutional');
  assert.strictEqual(d.classifyDomain('cdc.gov', SETS), 'institutional');
});

test('directories are `reference` — the type you can actually get listed in', () => {
  assert.strictEqual(d.classifyDomain('zocdoc.com', SETS), 'reference');
  assert.strictEqual(d.classifyDomain('healthgrades.com', SETS), 'reference');
});

test('forums and review sites are `ugc`', () => {
  assert.strictEqual(d.classifyDomain('reddit.com', SETS), 'ugc');
  assert.strictEqual(d.classifyDomain('www.yelp.com', SETS), 'ugc');
});

test('publishers are `editorial`', () => {
  assert.strictEqual(d.classifyDomain('healthline.com', SETS), 'editorial');
});

test('an ordinary commercial site falls through to `corporate`', () => {
  assert.strictEqual(d.classifyDomain('somedentist.com', SETS), 'corporate');
});

section('typeWeight — §6');

test('a directory outweighs a competitor\'s own site for gap scoring', () => {
  assert.strictEqual(d.typeWeight('reference'), 1.0);
  assert.strictEqual(d.typeWeight('corporate'), 0.6);
});

test('your own site is never a gap', () => {
  assert.strictEqual(d.typeWeight('you'), 0);
});

section('classifyUrl — §5.4');

test('root path is a homepage', () => {
  assert.strictEqual(d.classifyUrl('https://gentledental.com/'), 'homepage');
});

test('a leaf practice page is a profile, its section index is a category', () => {
  assert.strictEqual(d.classifyUrl('https://x.com/dental-offices/ma/boston/newbury-st'), 'profile');
  assert.strictEqual(d.classifyUrl('https://x.com/dentists'), 'category');
});

test('a listicle is decided by its title, not its path', () => {
  assert.strictEqual(d.classifyUrl('https://x.com/blog/dentists', { title: '20 Best Dentists in Boston' }), 'listicle');
});

test('forums are discussions', () => {
  assert.strictEqual(d.classifyUrl('https://x.com/forum/thread/123'), 'discussion');
});

section('classifyCitation — one call per row');

test('a full URL yields both a domain type and a URL type', () => {
  const c = d.classifyCitation({ url: 'https://ada.org/resources/guidelines?utm_source=chatgpt.com' }, SETS);
  assert.strictEqual(c.domain, 'ada.org');
  assert.strictEqual(c.domainType, 'institutional');
  assert.strictEqual(c.urlType, 'article');
  assert.strictEqual(c.url, 'https://ada.org/resources/guidelines', 'tracking stripped');
  assert.strictEqual(c.rulesetVersion, d.RULESET_VERSION);
});

test('a domain-only citation (ChatGPT) leaves urlType null rather than guessing', () => {
  const c = d.classifyCitation({ host: 'foreondental.com' }, SETS);
  assert.strictEqual(c.domain, 'foreondental.com');
  assert.strictEqual(c.domainType, 'corporate');
  assert.strictEqual(c.urlType, null, 'no path means the URLs report must say it does not know');
  assert.strictEqual(c.url, null);
});

test('the original URL is preserved alongside the normalised one', () => {
  const c = d.classifyCitation({ url: 'https://ada.org/x?ct-referrer=perplexity' }, SETS);
  assert.match(c.originalUrl, /ct-referrer/, '§5.1: that provenance is worth showing');
  assert.ok(!/ct-referrer/.test(c.url));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
