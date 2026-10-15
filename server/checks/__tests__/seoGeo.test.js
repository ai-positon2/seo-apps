'use strict';

// Zero-dependency test runner. No test framework is configured in this app (server/package.json has
// only nodemon in devDependencies), so this follows the same hand-rolled pattern as
// server/locationPageBuilder/__tests__/run.js.
//
// Run: node checks/__tests__/seoGeo.test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const KWM = require('../keywordMatch');
const cheerio = require('cheerio');
const { runAllChecks, calculateScores, withAxisScores, resolvePageIntent, computeAnswerability,
  summarizeLocalBusiness, toSameAsArray, validateOpeningHours, extractSchemaBlocks,
  countStatistics, contentOnlyText, detectPageType } = require('../seoGeoChecks');

let passed = 0, failed = 0;
const groups = [];
function group(name) { groups.push(name); console.log(`\n${name}`); }
function test(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); passed++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); failed++; }
}

const FIXTURE = path.join(__dirname, 'fixtures', 'arlington-live.html');
const ARLINGTON_URL = 'https://www.gentledental.com/dental-offices/ma/arlington';
const html = fs.readFileSync(FIXTURE, 'utf8');
const META = { gap: 3, metadata: true };

// Real strings from the fixture — the page the reported audit was run against.
const TITLE = 'Arlington Dentist, MA | Gentle Dental of New England';
const H1 = 'Your Experienced Arlington, MA Dentist for Family Dental Care';
const METADESC = 'Our Arlington dentists provide high-quality dental care for all ages. Flexible scheduling, most insurance accepted, and personalized treatments. Visit today!';
const OGTITLE = 'Gentle Dental of Arlington – Comprehensive Family Dentistry';

const tierOf = (kw, hay, opts = META) => KWM.matchKeyword(kw, hay, opts).tier;

// ─────────────────────────────────────────────────────────────────────────────
group('keywordMatch — the reported false negatives');

// These two were the ONLY hard errors in the reported audit, and both were wrong: the page targets
// the keyword, it just uses reversed word order.
test('reversed word order in the real title is a proximity match, not absent', () => {
  const m = KWM.matchKeyword('dentist in arlington', TITLE, META);
  assert.strictEqual(m.tier, 'unordered_proximity');
  assert.ok(m.gaps <= 1, `gaps should be <=1, got ${m.gaps}`);
  assert.ok(m.minLevel >= 2, `minLevel should be >=2, got ${m.minLevel}`);
  assert.strictEqual(m.evidence, 'Arlington Dentist');
});

test('reversed order with an injected state in the real H1 is a proximity match', () => {
  const m = KWM.matchKeyword('dentist in arlington', H1, META);
  assert.strictEqual(m.tier, 'unordered_proximity');
  assert.ok(m.gaps <= 1, `gaps should be <=1, got ${m.gaps}`);
  assert.strictEqual(m.evidence, 'Arlington, MA Dentist');
});

test('plural + reversed in the real meta description matches', () => {
  assert.strictEqual(tierOf('dentist in arlington', METADESC), 'unordered_proximity');
});

test('og:title uses a derivational sibling, so it is family tier only', () => {
  assert.strictEqual(tierOf('dentist in arlington', OGTITLE), 'family_proximity');
});

test('stopwords between terms are free — "Dentist Near You in Arlington" is an exact phrase', () => {
  assert.strictEqual(tierOf('dentist in arlington', 'Dentist Near You in Arlington, MA'), 'exact_phrase');
});

group('keywordMatch — variation classes');

test('plural/singular inflection', () => {
  assert.strictEqual(tierOf('dentist in arlington', 'Meet Our Trusted Dentists in Arlington, MA'), 'exact_phrase_inflected');
});
test('irregular plural teeth/tooth unifies', () => {
  assert.strictEqual(tierOf('teeth whitening', 'tooth whitening treatment'), 'exact_phrase_inflected');
});
test('hyphenation is transparent', () => {
  assert.strictEqual(tierOf('teeth whitening', 'Teeth-Whitening Special'), 'exact_phrase');
});
test('nbsp entities are transparent', () => {
  assert.strictEqual(tierOf('dentist in arlington', 'Dentist&nbsp;in&nbsp;Arlington,&nbsp;MA'), 'exact_phrase');
});
test('double space does not defeat the match (the old substring engine failed this)', () => {
  assert.strictEqual(tierOf('dentist in arlington', 'Dentist in  Arlington'), 'exact_phrase');
});
test('casing is transparent', () => {
  assert.strictEqual(tierOf('dentist in arlington', 'ARLINGTON DENTIST'), 'unordered_proximity');
});
test('diacritics fold', () => {
  assert.strictEqual(tierOf('montreal dentist', 'Montréal Dentist'), 'exact_phrase');
});
test('possessive collapses to the owner', () => {
  assert.strictEqual(tierOf('dentist in arlington', "Arlington's dentist of choice"), 'unordered_proximity');
});
test('state code expands to the full name', () => {
  assert.strictEqual(tierOf('dentist in arlington', 'Dentist in Arlington, Massachusetts'), 'exact_phrase');
});
test('intervening content tokens are an ordered gap, not a failure', () => {
  assert.strictEqual(tierOf('dentist in arlington', 'Emergency Dentist Serving Arlington and Belmont'), 'ordered_with_gaps');
});
test('derivational family is its own, lower tier', () => {
  assert.strictEqual(tierOf('dentist in arlington', 'Dentistry in Arlington'), 'family_proximity');
  assert.strictEqual(tierOf('orthodontist arlington', 'Arlington Orthodontics'), 'family_proximity');
});

group('keywordMatch — false-positive traps that must NOT match');

test('no substring matching across word boundaries (dental vs inCIDENTAL)', () => {
  // The old engine returned TRUE here via "in·cidental care".
  const t = tierOf('dental care', 'purely incidental care is not covered');
  assert.ok(TIER_RANK_LT(t, 'family_proximity'), `expected below family tier, got ${t}`);
});
test('root collision is braked by the length+vowel guard (car vs care)', () => {
  const t = tierOf('car repair', 'we care about repair quality');
  assert.ok(TIER_RANK_LT(t, 'family_proximity'), `expected below family tier, got ${t}`);
});
test('a sentence barrier prevents a cross-sentence match', () => {
  const t = tierOf('dentist in arlington',
    'We serve Arlington, Belmont, and Somerville. Our staff includes a dentist, a hygienist and two assistants.',
    { gap: 6 });
  assert.ok(TIER_RANK_LT(t, 'unordered_proximity'), `expected below proximity tier, got ${t}`);
});
test('a pipe in a metadata field is a barrier', () => {
  const t = tierOf('dentist arlington', 'Dental Insurance | Arlington Heights Office');
  assert.ok(TIER_RANK_LT(t, 'family_proximity'), `expected below family tier, got ${t}`);
});
test('completely unrelated text is absent', () => {
  assert.strictEqual(tierOf('dentist in arlington', 'Read our privacy policy'), 'absent');
});
test('a searcher-side modifier cannot yield a top-tier match', () => {
  const m = KWM.matchKeyword('dentist near me', 'Our dentist is here for you', META);
  assert.ok(KWM.TIER_RANK[m.tier] <= KWM.TIER_RANK.ordered_with_gaps,
    `"near me" must not reach exact_phrase; got ${m.tier}`);
});

function TIER_RANK_LT(tier, floor) { return KWM.TIER_RANK[tier] < KWM.TIER_RANK[floor]; }

group('keywordMatch — occurrence counting');

test('overlapping variant forms are not double-counted', () => {
  // The old code summed per-variant regex counts over the same text: 1 + 0 + 2 = 3 for 2 real hits.
  const { count } = KWM.countOccurrences('dental implants',
    'We place dental implants daily. Our dental implant is affordable.',
    { gap: 3, minTier: 'ordered_with_gaps' });
  assert.strictEqual(count, 2);
});

test('stem() is idempotent and unifies singular/plural', () => {
  for (const w of ['ring','sing','training','whitening','flower','lawyer','business','address','bus','service']) {
    assert.strictEqual(KWM.stem(w), KWM.stem(KWM.stem(w)), `stem not idempotent for "${w}"`);
  }
  assert.strictEqual(KWM.stem('services'), KWM.stem('service'));
  assert.strictEqual(KWM.stem('dentists'), KWM.stem('dentist'));
  assert.notStrictEqual(KWM.stem('business'), 'busines');
});

// ─────────────────────────────────────────────────────────────────────────────
group('helpers — the crash and validation fixes');

test('toSameAsArray handles a comma-joined string (reading .length gave a char count; .some() threw)', () => {
  const s = 'https://www.youtube.com/user/GentleDental1, https://twitter.com/gentledentalne, https://www.facebook.com/GentleDental';
  const out = toSameAsArray(s);
  assert.strictEqual(out.length, 3);
  assert.ok(out.every(u => u.startsWith('http')));
  assert.deepStrictEqual(toSameAsArray(['https://a.com']), ['https://a.com']);
  assert.deepStrictEqual(toSameAsArray(null), []);
});

test('an empty OpeningHoursSpecification is an error, not a pass', () => {
  const errs = validateOpeningHours({ '@type': 'OpeningHoursSpecification' });
  assert.ok(errs.length >= 1, 'empty spec must produce an error');
  assert.ok(errs.some(e => e.severity === 'error'));
});
test('a plain-string dayOfWeek is flagged', () => {
  const errs = validateOpeningHours({ '@type':'OpeningHoursSpecification', dayOfWeek:'Monday', opens:'08:30', closes:'17:00' });
  assert.ok(errs.some(e => /schema\.org URI/.test(e.error)));
});
test('a valid spec produces no errors', () => {
  const errs = validateOpeningHours({ '@type':'OpeningHoursSpecification', dayOfWeek:'http://schema.org/Monday', opens:'08:30', closes:'17:00' });
  assert.deepStrictEqual(errs, []);
});
test('a non-string dayOfWeek does not throw', () => {
  assert.doesNotThrow(() => validateOpeningHours({ dayOfWeek: [123], opens:'1', closes:'2' }));
});

test('extractSchemaBlocks recurses into nested entities', () => {
  const blocks = extractSchemaBlocks(require('cheerio').load(html));
  const types = new Set(blocks.flatMap(b => [].concat(b['@type'] || [])));
  // These live under Dentist.employee and WebPage.breadcrumb — invisible to the old flat collector,
  // which is why the audit claimed there was no Person schema on a page listing six named dentists.
  assert.ok(types.has('Person'), 'nested Person nodes must be collected');
  assert.ok(types.has('BreadcrumbList'), 'nested BreadcrumbList must be collected');
  assert.ok(types.has('Organization'), 'Organization must be collected');
});

group('page-type URL detection — plural section names');

// Reproduces a real bug found by running the audit against a random live page:
// brushandfloss.com/locations/apex — an unambiguous location page ("Family Dentist in Apex, NC") —
// was detected as page_type 'other' (0.5 confidence, defaulting to informational intent) because the
// URL pattern for 'location' only matched the literal singular segment "location", not "locations".
// The DOM-signal fallback couldn't rescue it either, because that site's LocalBusiness/Dentist schema
// is injected by client-side JS and so is invisible to a static fetch — exactly the scenario a plural
// URL segment is most likely to appear in.
const $minimal = cheerio.load('<html><body><h1>Family Dentist</h1></body></html>');

test('a pluralized /locations/ URL is detected as a location page even with no LocalBusiness schema', () => {
  const ctx = detectPageType($minimal, 'https://www.brushandfloss.com/locations/apex', []);
  assert.strictEqual(ctx.pageType, 'location');
  assert.ok(ctx.pageTypeConfidence >= 0.7);
});
test('other pluralized section names resolve too (services, resources)', () => {
  assert.strictEqual(detectPageType($minimal, 'https://example.com/services/whitening', []).pageType, 'service');
  assert.strictEqual(detectPageType($minimal, 'https://example.com/resources/articles/x', []).pageType, 'article',
    'the more specific article pattern should still win over the generic resource one');
  assert.strictEqual(detectPageType($minimal, 'https://example.com/resources/guide', []).pageType, 'resource');
});
test('the singular forms still work (no regression)', () => {
  assert.strictEqual(detectPageType($minimal, 'https://example.com/location/apex', []).pageType, 'location');
  assert.strictEqual(detectPageType($minimal, 'https://example.com/service/whitening', []).pageType, 'service');
});

group('page intent');

test('user-supplied intent always wins', () => {
  assert.deepStrictEqual(resolvePageIntent('commercial', { pageType: 'article' }), { intent: 'commercial', source: 'user' });
  assert.deepStrictEqual(resolvePageIntent('informational', { pageType: 'location' }), { intent: 'informational', source: 'user' });
});
test('auto infers commercial for a location page and informational for an article', () => {
  assert.strictEqual(resolvePageIntent('auto', { pageType: 'location' }).intent, 'commercial');
  assert.strictEqual(resolvePageIntent('auto', { pageType: 'article' }).intent, 'informational');
  assert.strictEqual(resolvePageIntent('auto', { pageType: 'location' }).source, 'detected');
});
test('an unknown page type falls back to informational (preserves prior behaviour)', () => {
  assert.strictEqual(resolvePageIntent('auto', { pageType: 'other' }).intent, 'informational');
  assert.strictEqual(resolvePageIntent(undefined, {}).intent, 'informational');
});

group('answerability — commercial pages are not scored on citations/statistics/quotes');

const COMMERCIAL_SIGNALS = {
  sourcedStats: 0, statCount: 0, expertQuoteCount: 0, hasAuthor: false, promoCount: 0,
  blufOk: true, qaOk: true,
  lbFacts: { hasLocalSignals: true, hasTelephone: true, addrComplete: true, hasAddress: true,
    ohsValid: true, ohsPresent: true, hasGeoCoords: true, aggregateRating: { ratingValue: 4.8, reviewCount: 120 },
    reviewNodes: [], sameAsUrls: ['a','b','c'], hasSchemaId: true, hasSpecificSubtype: true, lbType: 'Dentist' },
};

test('a complete commercial page scores 10/10 on NAPEF with zero citations, stats or quotes', () => {
  const a = computeAnswerability('commercial', COMMERCIAL_SIGNALS);
  assert.strictEqual(a.rubric, 'NAPEF');
  assert.strictEqual(a.score, 10);
  assert.deepStrictEqual(a.breakdown.map(b => b.key), ['N','A','P','E','F']);
});

test('the same page scores near zero on CSQAF — proving the rubric switch is what matters', () => {
  const a = computeAnswerability('informational', COMMERCIAL_SIGNALS);
  assert.strictEqual(a.rubric, 'CSQAF');
  assert.ok(a.score <= 2, `expected <=2, got ${a.score}`);
});

test('C, S and Q are never rendered for a commercial page', () => {
  const keys = computeAnswerability('commercial', COMMERCIAL_SIGNALS).breakdown.map(b => b.key);
  assert.ok(!keys.includes('C'), 'Citations must not appear');
  assert.ok(!keys.includes('S'), 'Statistics must not appear');
  assert.ok(!keys.includes('Q'), 'Quotations must not appear');
});

test('a commercial page with no local signals drops N and A instead of scoring them zero', () => {
  const a = computeAnswerability('commercial', {
    ...COMMERCIAL_SIGNALS,
    lbFacts: { ...COMMERCIAL_SIGNALS.lbFacts, hasLocalSignals: false },
  });
  assert.strictEqual(a.max, 6, 'max should renormalise to 6 when N and A do not apply');
  assert.deepStrictEqual(a.breakdown.map(b => b.key), ['P','E','F']);
  assert.strictEqual(a.score, 10);
});

group('statistics counting — nav/CTA pollution must not swallow real content');

test('a nav block with no sentence punctuation does not fuse onto the next real sentence and get excluded by an unrelated $ price', () => {
  // Reproduces a real bug: a 50-city nav menu (no periods anywhere) plus a "$79" price banner glued
  // directly onto the article's opening statistic with no punctuation between them. Sentence-splitting
  // on [.!?]+ merged them into one blob, and the $-price exclusion (meant to filter phone numbers/
  // prices, not statistics) discarded the whole blob — reporting 0 statistics on a page that opens
  // with "Nearly 73% of adults... according to a 2025 JADA study."
  const navDump = 'Locations Boston Cambridge New Patient Offer$79A $400+ Value Book Now';
  const realSentence = 'Nearly 73% of adults report some level of dental fear, according to a 2025 study.';
  const polluted = navDump + realSentence; // no punctuation between them, exactly as scraped
  assert.strictEqual(countStatistics(polluted), 0,
    'sanity check: confirms the fusion bug still exists at the raw-text level');
  assert.strictEqual(countStatistics(realSentence), 1,
    'the real sentence alone is correctly counted once isolated from the nav');
});

test('contentOnlyText strips nav/header/footer/form so the fusion cannot happen', () => {
  const html = `<html><body>
    <nav><a href="/a">Locations</a><a href="/b">Boston</a><div>New Patient Offer$79A $400+ Value</div></nav>
    <main><p>Nearly 73% of adults report some level of dental fear, according to a 2025 study.</p></main>
  </body></html>`;
  const text = contentOnlyText(html);
  assert.ok(!text.includes('$79'), 'nav content must be stripped');
  assert.strictEqual(countStatistics(text), 1);
});

test('ratio statistics with a bare "in" (not just "in every") are counted', () => {
  assert.strictEqual(countStatistics('1 in 5 adults avoid the dentist due to anxiety.'), 1);
  assert.strictEqual(countStatistics('9 in 10 dentists recommend this.'), 1);
  assert.strictEqual(countStatistics('I saw him again in 5 minutes.'), 0,
    'a bare "in" between two numbers only — must not fire without a second number nearby');
});

group('scoring model — coherence with the displayed bars');

function synth(n, status, category, severity) {
  return Array.from({ length: n }, (_, i) => ({
    id: `${category.replace(/\W/g,'')}${i}`, category, status, severity: severity || 'info',
  }));
}

test('an all-passing page scores 100', () => {
  const s = calculateScores([...synth(5,'pass','Title Tag'), ...synth(5,'pass','Schema')]);
  assert.strictEqual(s.overall, 100);
  assert.strictEqual(s.band.label, 'Excellent');
});

test('the headline equals the weighted mean of the bars (it used to use a different formula entirely)', () => {
  const s = calculateScores([
    ...synth(4,'pass','Title Tag'), ...synth(4,'warning','Content Quality'),
    ...synth(4,'notice','Schema'), ...synth(4,'pass','Technical'),
  ]);
  const wsum = s.breakdown.reduce((a,b) => a + b.weight * b.score, 0);
  const wtot = s.breakdown.reduce((a,b) => a + b.weight, 0);
  assert.strictEqual(s.composite, Math.round(wsum / wtot),
    'composite must be reproducible from the displayed bar values');
});

test('points_lost sums to 100 - composite, so the headline is explainable line by line', () => {
  const s = calculateScores([
    ...synth(3,'pass','Title Tag'), ...synth(3,'warning','Content Quality'),
    ...synth(3,'notice','Images'), ...synth(3,'pass','Meta Robots'),
  ]);
  const lost = s.breakdown.reduce((a,b) => a + b.points_lost, 0);
  assert.ok(Math.abs(lost - (100 - s.composite)) <= 1.0,
    `points_lost ${lost.toFixed(1)} should sum to 100-composite ${100 - s.composite}`);
});

test('every category maps into exactly one bar — no check is invisible to the breakdown', () => {
  const ALL_CATEGORIES = ['Title Tag','Meta Description','Meta Robots','Canonical','Headings',
    'Content Quality','Images','Internal Links','External Links','Schema','Open Graph','Hreflang',
    'Technical','URL Signals','Page Speed','Semantic HTML','Accessibility','E-E-A-T','Security',
    'GEO Signals','Miscellaneous','Keyword Analysis'];
  const checks = ALL_CATEGORIES.flatMap(c => synth(2, 'pass', c));
  const warnings = [];
  const orig = console.warn;
  console.warn = (...a) => warnings.push(a.join(' '));
  try { calculateScores(checks); } finally { console.warn = orig; }
  assert.deepStrictEqual(warnings, [], `unmapped categories: ${warnings.join('; ')}`);
});

test('errors are no longer double-counted as warnings', () => {
  const s = calculateScores([
    { id:'X1', category:'Schema', status:'fail', severity:'error' },
    { id:'X2', category:'Schema', status:'warning', severity:'warning' },
  ]);
  assert.strictEqual(s.counts.errors, 1);
  assert.strictEqual(s.counts.warnings, 1, 'a fail/error must not also count as a warning');
  assert.strictEqual(s.counts.errors + s.counts.warnings + s.counts.notices + s.counts.passed,
    s.counts.evaluated, 'the four chips must sum to the number evaluated');
});

test("'na' and 'informational' are excluded from scoring entirely", () => {
  const base = synth(4, 'pass', 'Schema');
  const withNa = [...base, ...synth(4, 'na', 'Schema'), ...synth(4, 'informational', 'Schema')];
  assert.strictEqual(calculateScores(base).schema, calculateScores(withNa).schema,
    'unscored statuses must not move a bar');
});

test('an empty bucket is dropped, never awarded a free 100', () => {
  const s = calculateScores(synth(3, 'pass', 'Schema'));
  assert.strictEqual(s.geo_signals, null, 'a bucket with no checks must be null, not 100');
  assert.ok(!s.breakdown.some(b => b.key === 'geo_signals'));
});

test('a noindex page is capped and the cap is reported, not applied silently', () => {
  const s = calculateScores([
    ...synth(20, 'pass', 'Title Tag'), ...synth(20, 'pass', 'Schema'),
    { id:'C1', category:'Meta Robots', status:'fail', severity:'error' },
  ]);
  assert.ok(s.cap, 'cap must be present');
  assert.strictEqual(s.cap.applied, true);
  assert.strictEqual(s.overall, 25);
  assert.ok(s.composite > s.overall, 'the uncapped composite must still be reported');
  assert.ok(/noindex/i.test(s.cap.groups[0].reason));
});

test('a near-empty page cannot score well', () => {
  const s = calculateScores([
    { id:'F2', category:'Content Quality', status:'fail', severity:'error' },
    { id:'A1', category:'Title Tag', status:'fail', severity:'error' },
    ...synth(6, 'pass', 'Technical'),
  ]);
  assert.ok(s.overall <= 55, `expected a low score, got ${s.overall}`);
});

// ─────────────────────────────────────────────────────────────────────────────
group('integration — the real Arlington page (the page in the reported audit)');

(async () => {
  // sameAs on this page is a comma-joined string; once @graph flattening was fixed, reading it
  // without toSameAsArray threw a TypeError that would have 500'd the whole route.
  const commercial = await runAllChecks(html, ARLINGTON_URL, {}, [], { pageIntent: 'auto' });
  const informational = await runAllChecks(html, ARLINGTON_URL, {}, [], { pageIntent: 'informational' });
  const withKeywords = await runAllChecks(html, ARLINGTON_URL, {}, ['dentist in arlington','arlington dentist'], { pageIntent: 'auto' });

  test('a dental location page auto-detects as commercial', () => {
    assert.strictEqual(commercial.pageIntent, 'commercial');
    assert.strictEqual(commercial.pageIntentSource, 'detected');
  });

  test('KW1/KW2 no longer report a false error on the reversed-order title and H1', () => {
    const kw1 = withKeywords.kwChecks.find(c => c.id === 'KW1');
    const kw2 = withKeywords.kwChecks.find(c => c.id === 'KW2');
    assert.strictEqual(kw1.status, 'pass', `KW1 was ${kw1.status}: ${kw1.detail}`);
    assert.strictEqual(kw2.status, 'pass', `KW2 was ${kw2.status}: ${kw2.detail}`);
    assert.ok((kw1.flags || []).includes('word_order_reversed'),
      'the reversed order should still be reported as a flag');
  });

  test('the headline is coherent with the bars', () => {
    const bars = withKeywords.scores.breakdown.map(b => b.score);
    const lo = Math.min(...bars), hi = Math.max(...bars);
    assert.ok(withKeywords.scores.overall >= lo - 1 && withKeywords.scores.overall <= hi + 1,
      `overall ${withKeywords.scores.overall} must sit within the bar range ${lo}-${hi}`);
  });

  test('the named-doctor quick win was false — six practitioners are published in schema', () => {
    assert.strictEqual(commercial.pageContext.namedPractitioners.length, 6);
    const r12 = commercial.checks.find(c => c.id === 'R12');
    assert.strictEqual(r12.status, 'pass');
  });

  test('the city is parsed from schema, not from the state segment of the URL', () => {
    assert.strictEqual(commercial.pageContext.primaryCity, 'Arlington');
    assert.strictEqual(commercial.pageContext.primaryRegion, 'MA');
  });

  test('the fabricated expert quote is gone', () => {
    // Was 1: a span between two HTML attribute delimiters that matched a bare "Director".
    assert.strictEqual(commercial.geo.expert_quotes, 0);
  });

  test('bracket literals are no longer counted as sourced statistics', () => {
    // Was 4-9: ["Dentist","MedicalBusiness"], ["Tuesday","Thursday"] and two [data-src] selectors.
    const csqaf = informational.geo.answerability_breakdown.find(b => b.key === 'C');
    assert.ok(csqaf.points <= 1, `Citations should not score 2 on a page with zero citations; got ${csqaf.points}`);
  });

  test('a cited award is not counted as promotional puffery', () => {
    const hits = commercial.geo.promotional_language_hits.map(h => h.word);
    assert.ok(!hits.includes('#1'), '"#1 ranking in 2017" from a named award is a citation, not puffery');
    assert.ok(commercial.geo.promotional_language_count < 7,
      `promo count should drop below the reported 7; got ${commercial.geo.promotional_language_count}`);
  });

  test('the @graph fixes turn a run of false negatives into passes', () => {
    for (const id of ['J4','J7','J9','J12','J20','J25','T10']) {
      const c = commercial.checks.find(x => x.id === id);
      assert.strictEqual(c.status, 'pass', `${id} should pass: ${c.detail}`);
    }
  });

  test('the real schema defect IS now reported as an error', () => {
    // The plain-string dayOfWeek the prompt is written to fix. The original report never showed it,
    // because the GPT payload filter was a no-op and slice(0,120) dropped J22 by array order.
    const j22 = commercial.checks.find(c => c.id === 'J22');
    assert.strictEqual(j22.status, 'fail');
    assert.strictEqual(j22.severity, 'error');
    assert.ok(/schema\.org URI/.test(j22.detail));
  });

  test('citations, statistics and quotations carry no weight under commercial intent', () => {
    for (const id of ['F14','F15','F16','F17','F27','I5','R7']) {
      const c = commercial.checks.find(x => x.id === id);
      assert.strictEqual(c.status, 'na', `${id} should be na under commercial intent, was ${c.status}`);
    }
    // ...and they DO carry weight when the user says informational.
    const f15 = informational.checks.find(c => c.id === 'F15');
    assert.notStrictEqual(f15.status, 'na', 'F15 must be scored for an informational page');
  });

  test('the rubric switches with intent', () => {
    assert.strictEqual(commercial.geo.answerability_rubric, 'NAPEF');
    assert.strictEqual(informational.geo.answerability_rubric, 'CSQAF');
    assert.strictEqual(commercial.geo.csqaf_score, commercial.geo.answerability_score,
      'csqaf_score must alias the answerability score for older persisted runs');
  });

  test('the commercial GEO checks evaluate real facts on this page', () => {
    const byId = id => commercial.checks.find(c => c.id === id);
    assert.strictEqual(byId('T11').status, 'pass', 'NAP is complete on this page');
    assert.strictEqual(byId('T12').status, 'fail', 'the hours block is invalid');
    assert.strictEqual(byId('T14').status, 'pass');
    for (const id of ['T11','T12','T13','T14']) {
      assert.strictEqual(informational.checks.find(c => c.id === id).status, 'na',
        `${id} must be na for an informational page`);
    }
  });

  group('SEO / GEO split');
  const mk = (id, category, status, value) => ({ id, category, status, severity: status === 'fail' ? 'error' : status, value });
  const clean = [mk('A3', 'Title Tag', 'pass'), mk('E2', 'Headings', 'pass'), mk('J1', 'Schema', 'pass'),
    mk('G1', 'GEO Signals', 'pass'), mk('H1', 'E-E-A-T', 'pass')];
  const withAns = (n) => calculateScores([...clean,
    mk('T3', 'GEO Signals', n >= 7 ? 'pass' : n < 4 ? 'warning' : 'notice', `${n}/10`)]);

  test('a page AI engines cannot answer from is never a "Good" GEO score', () => {
    assert.strictEqual(withAns(8).geo.cap, null, 'answerability 7+ is GEO ready: no cap');
    assert.strictEqual(withAns(5).geo.score, 74, 'answerability 4-6 caps GEO at the top of "Needs work"');
    assert.strictEqual(withAns(3).geo.score, 55, 'answerability below 4 caps GEO at "Poor"');
    assert.ok(withAns(5).geo.composite > 74, 'the cap is what lowers it, not the bars');
  });

  test('the answerability gate is GEO-only and leaves the headline alone', () => {
    const s = withAns(2);
    assert.strictEqual(s.seo.cap, null, 'SEO is not capped by answerability');
    assert.strictEqual(s.overall, s.composite, 'the headline has no answerability cap');
  });

  test('a saved report without the split is gated the same way as a fresh one', () => {
    const fresh = withAns(5);
    const saved = { ...fresh, seo: undefined, geo: undefined };
    const checks = [...clean, mk('T3', 'GEO Signals', 'notice', '5/10')];
    const derived = withAxisScores({ findings: { scores: saved, checks } }).findings.scores;
    assert.strictEqual(derived.geo.score, fresh.geo.score);
    assert.strictEqual(derived.seo.score, fresh.seo.score);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
