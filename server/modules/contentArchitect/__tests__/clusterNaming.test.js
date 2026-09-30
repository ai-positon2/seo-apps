// ── What a cluster is called, and which page may be its hub ─────────────────
//
// Regressions from the 10-site hub and spoke review (2026-09-29): brand words in
// names, word stems shown as names, the location penalty on ordinary words, and
// glossary entries reported as clusters missing a hub. No model is called: the
// key is blanked before anything loads, so naming and relevance fall back to
// their deterministic paths.
//
// Run: node --test modules/contentArchitect/__tests__/clusterNaming.test.js

process.env.ANTHROPIC_API_KEY = '';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const termProfile = require('../termProfile');
const { withoutBrand } = require('../llmNaming');
const { mechanicalName } = require('../clusterEngine');
const { computeIdf } = require('../similarity');
const { hasLocationTerm } = require('../hubSelection');
const { analyzeCrawledPages, referenceFolderOf, withReferenceHub } = require('../fullAnalysis');

test("the brand is the registrable domain's label, not the first label of the host", () => {
  assert.equal(termProfile.brandLabel('https://my.clevelandclinic.org'), 'clevelandclinic');
  assert.equal(termProfile.brandLabel('https://blog.hubspot.com'), 'hubspot');
  assert.equal(termProfile.brandLabel('https://www.example.co.uk'), 'example');
  assert.equal(termProfile.brandLabel('zapier.com'), 'zapier');
});

test("a multi-word brand is read from the site's title suffix", () => {
  const pages = ['Gum disease', 'Flossing tips', 'Tartar'].map((t) => ({ title: `${t} | Aspen Dental` }));
  const brand = termProfile.deriveBrand('https://www.aspendental.com', pages);
  assert.ok(brand.words.includes('aspen dental'));
  assert.deepEqual(brand.phrases, ['aspen dental']);
  // A suffix that is not the brand is left alone.
  const other = termProfile.deriveBrand('https://www.aspendental.com', pages.map((p) => ({ title: p.title.replace('Aspen Dental', 'Dental Tips') })));
  assert.deepEqual(other.phrases, []);
  // "Position²" is the brand "position2".
  assert.ok(termProfile.deriveBrand('https://www.position2.com', [{ title: 'A | Position²' }, { title: 'B | Position²' }]).words.includes('position2'));
});

test('a model name that uses the brand keeps its topic, without the brand', () => {
  const zapier = termProfile.deriveBrand('https://zapier.com', []);
  assert.equal(withoutBrand('Zapier AI Tools and Features', zapier), 'AI Tools and Features');
  assert.equal(withoutBrand("Zapier's Native AI Features", zapier), 'Native AI Features');
  assert.equal(withoutBrand('AI Tools by Zapier', zapier), 'AI Tools');
  assert.equal(withoutBrand('Zapier Tables', zapier), null, 'one word left is not a name');
  assert.equal(withoutBrand('Customer Stories', zapier), 'Customer Stories');
  const aspen = termProfile.deriveBrand('https://www.aspendental.com', [{ title: 'a | Aspen Dental' }, { title: 'b | Aspen Dental' }]);
  assert.equal(withoutBrand('Aspen Dental Insurance Guides', aspen), 'Insurance Guides');
});

test('mechanical names are words, never stems, and never carry the brand', () => {
  // Seen live: "Canva & Zapier Tabl", "Daili Seo & Seo Fix", "Help Hub & Hub Moz".
  const pages = [
    { url: 'https://zapier.com/blog/tables-guide', title: 'Zapier Tables: daily automation' },
    { url: 'https://zapier.com/blog/tables-tips', title: 'Zapier Tables tips for daily work' },
    { url: 'https://zapier.com/blog/other', title: 'Something else entirely' },
  ];
  const profiles = termProfile.buildCorpusTermProfiles(pages, { domain: 'https://zapier.com' });
  for (const p of profiles) for (const term of p.keys()) assert.ok(!term.split(' ').includes('zapier'), term);
  const name = mechanicalName([0, 1], profiles, computeIdf(profiles));
  assert.doesNotMatch(name, /Zapier/, name);
  // Every word of the name is a word the pages actually use.
  const text = pages.map((p) => `${p.title} ${p.url}`).join(' ').toLowerCase();
  for (const word of name.toLowerCase().split(/[\s&]+/).filter(Boolean)) {
    assert.ok(new RegExp(`\\b${word}\\b`).test(text), `"${word}" in "${name}" is not a word from the pages`);
  }
  assert.equal(termProfile.surfaceTerm('tabl daili', profiles.surface), 'tables daily');
});

test('the location penalty needs a location word in a folder or short segment', () => {
  const at = (p) => hasLocationTerm(`https://x.test${p}`);
  for (const p of ['/locations/austin', '/our-offices/boston-office', '/austin-office', '/dentist-near-me-austin', '/boston', '/dealers/texas']) {
    assert.equal(at(p), true, p);
  }
  for (const p of [
    '/blog/chief-marketing-officers-you-own-organizational-growth',
    '/seo/glossary/link-velocity',
    '/seo/for/car-dealerships',
    '/blog/tips-and-design-principles-multi-location-websites',
    '/blog/multi-location-seo',
    '/dental-care-resources/emergency-room-vs-dental-office/',
  ]) assert.equal(at(p), false, p);
});

test('a cluster of glossary entries is not reported as missing a hub', async () => {
  assert.equal(referenceFolderOf('https://ahrefs.com/seo/glossary/anchor-text'), 'https://ahrefs.com/seo/glossary');
  assert.equal(referenceFolderOf('https://ahrefs.com/blog/anchor-text'), null);

  const entry = (slug, title) => ({
    url: `https://ahrefs.com/seo/glossary/${slug}`, finalUrl: null, title, h1: title,
    h2s: ['Why link attributes matter', 'Nofollow and sponsored link attributes'],
    metaDescription: `${title}: a link attribute that tells search engines about a link.`,
    firstParagraph: '', wordCount: 400, outboundLinks: [],
  });
  // Blog posts on another topic alongside, so the entries' shared words are
  // not on most pages (a term on more than 60% is dropped as generic).
  const post = (slug, title) => ({
    url: `https://ahrefs.com/blog/${slug}`, finalUrl: null, title, h1: title, h2s: [`${title} explained`],
    metaDescription: title, firstParagraph: '', wordCount: 1500, outboundLinks: [],
  });
  const pages = [
    entry('nofollow-link', 'What is a nofollow link attribute?'),
    entry('sponsored-link', 'What is a sponsored link attribute?'),
    entry('ugc-link', 'What is a UGC link attribute?'),
    entry('dofollow-link', 'What is a dofollow link attribute?'),
    post('keyword-research', 'Keyword research for beginners'),
    post('keyword-difficulty', 'How keyword difficulty is scored'),
    post('local-seo', 'Local SEO checklist for small shops'),
    post('site-speed', 'Why site speed affects rankings'),
    post('email-outreach', 'Email outreach templates that work'),
    post('content-audit', 'Running a content audit in a day'),
  ];
  const analysis = await analyzeCrawledPages(
    { pages, excluded: [], sampled: false, sampleSize: pages.length },
    { domain: 'https://ahrefs.com', vertical: null },
    { linkGraph: { graph: pages.map(() => new Set()), inboundCounts: pages.map(() => 1), depths: pages.map(() => 3) } },
  );
  // The rule itself: a glossary-only cluster that selectHub found no hub for.
  const gap = { isGap: true, hubPageIndex: null, gapSuggestion: { title: 'Security & UGC Attributes' }, scores: new Map() };
  const glossaryOnly = withReferenceHub(gap, { memberIndices: [0, 1, 2] }, pages);
  assert.equal(glossaryOnly.isGap, false);
  assert.equal(glossaryOnly.gapSuggestion, null);
  assert.equal(glossaryOnly.referenceIndexUrl, 'https://ahrefs.com/seo/glossary');
  assert.equal(withReferenceHub(gap, { memberIndices: [0, 4] }, pages), gap, 'a mixed cluster keeps its gap');

  const byId = new Map(analysis.pages.map((p) => [p.id, p]));
  const glossary = analysis.clusters.filter((c) => [c.hubPageId, ...c.spokeIds].filter(Boolean)
    .every((id) => byId.get(id).url.includes('/seo/glossary/')));
  assert.ok(glossary.length >= 1, 'the entries cluster together');
  for (const c of glossary) {
    assert.equal(c.isGap, false, `${c.name} is not a gap`);
    if (!c.hubPageId) assert.equal(c.referenceIndexUrl, 'https://ahrefs.com/seo/glossary');
  }
});
