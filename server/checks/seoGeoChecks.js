'use strict';

const cheerio = require('cheerio');
const axios = require('axios');

// ── helpers ──────────────────────────────────────────────────────────────────

function stemWord(w) {
  return w.toLowerCase().replace(/(?:ing|ed|er|s|es|ly)$/, '');
}

function visibleText($) {
  $('script, style, noscript, [style*="display:none"], [style*="display: none"], [style*="visibility:hidden"]').remove();
  return $.text().replace(/\s+/g, ' ').trim();
}

function wordCount(text) {
  return text.split(/\s+/).filter(Boolean).length;
}

function makeResult(id, category, name, requiresHttp = false) {
  return { id, category, name, status: 'pass', severity: 'info', value: null, detail: '', requires_http: requiresHttp };
}

function pass(r, value, detail) { r.status = 'pass'; r.value = value; r.detail = detail; return r; }
function fail(r, severity, value, detail) { r.status = 'fail'; r.severity = severity; r.value = value; r.detail = detail; return r; }
function warn(r, value, detail) { r.status = 'warning'; r.severity = 'warning'; r.value = value; r.detail = detail; return r; }
function notice(r, value, detail) { r.status = 'notice'; r.severity = 'notice'; r.value = value; r.detail = detail; return r; }
// `info` records a MEASUREMENT, not a verdict. It used to set status:'pass', which handed a free 100
// to ~30 checks that can never fail (e.g. "0 outbound links to authoritative domains." rendered as a
// green pass). Its own status keeps those rows visible while excluding them from every score.
function info(r, value, detail) { r.status = 'informational'; r.severity = 'info'; r.value = value; r.detail = detail; return r; }
function skipped(r, reason) { r.status = 'skipped'; r.severity = 'info'; r.detail = `Skipped — ${reason}`; return r; }
// `na` marks a check that does not apply to this page's intent/type. Distinct from `skipped` (which
// means "could not evaluate") so the report can say WHY it was excluded. Both are unscored.
function na(r, reason) { r.status = 'na'; r.severity = 'info'; r.detail = `Not applicable — ${reason}`; return r; }

// Statuses excluded from every numerator AND denominator in calculateScores().
const UNSCORED_STATUSES = new Set(['skipped', 'na', 'informational']);
function isScored(c) { return !UNSCORED_STATUSES.has(c.status); }

// `@type` is legitimately either a string or an array. Every `s['@type'] === 'X'` comparison in this
// file was silently false for array-valued types (the Arlington Dentist node is
// ["Dentist","MedicalBusiness","LocalBusiness"]), which produced a run of false negatives.
function typesOf(s) { return [].concat((s && s['@type']) || []).filter(Boolean); }
function hasType(s, t) { return typesOf(s).includes(t); }

// `sameAs` is specified as an array but publishers frequently emit one comma-joined string. Reading
// `.length` on that yields the character count (117 on Arlington → "117 profiles") and `.some()`
// throws, which would 500 the whole audit.
function toSameAsArray(v) {
  if (!v) return [];
  const arr = Array.isArray(v) ? v : String(v).split(/[,\s]+/);
  return arr.map(s => String(s).trim()).filter(s => /^https?:\/\//i.test(s));
}

// Deduped: 'unbeatable' appeared twice, double-counting every page that used it.
const PROMO_WORDS = [...new Set(['world-class','leading','#1','top-rated','award-winning','innovative',
  'revolutionary','state-of-the-art','cutting-edge','industry-leading','unmatched','unbeatable',
  'game-changing','disruptive','amazing','incredible'])];

// A promotional word inside a substantiated claim (a named award with a year, a third-party ranking)
// is a citation, not puffery. Arlington's "#1 ranking in 2017" from the Wicked Local Readers' Choice
// Awards was being counted against the page.
const SUBSTANTIATED_CLAIM = /\b(19|20)\d{2}\b|readers.?\s*choice|voted by|ranked by|accredited by/i;

// Post-nominals that actually signal expertise. Bare Director/Founder/CEO were removed: they match
// ordinary business copy ("Dental Director") and were the sole reason Arlington's credential check
// passed while having zero real credentials.
const CREDENTIAL_PATTERN = /\b(MD|DO|DDS|DMD|DVM|PhD|RN|NP|PA-C|RDH|CPA|JD|MBA|Esq|LCSW|DPT)\b/;

const AUTHORITATIVE_DOMAINS = ['.gov','.edu','pubmed','ncbi','arxiv','springer','nature.com',
  'sciencedirect','who.int','cdc.gov','nih.gov','bmj.com','thelancet.com','jamanetwork.com'];

const NON_DESCRIPTIVE_ANCHORS = new Set(['click here','here','read more','learn more','more',
  'this','link','page','this page','continue','view more']);

// ── §1.3: Statistics counter constants ───────────────────────────────────────

const STATISTIC_PATTERNS = [
  /\d+\.?\d*\s*%\s*(of\s+\w+|reduction|increase|improvement|patients|cases|adults|children|people)/i,
  // "in every"/"out of"/"per" was too narrow — the far more common ratio phrasing "1 in 5 adults" /
  // "9 in 10 dentists" has a bare "in", not "in every". Requiring digits on both sides keeps this
  // from false-firing on unrelated "in" usage ("3 in the morning" has no second number to match).
  /\d+\s+(out\s+of|in\s+every|in|per)\s+\d+/i,
  /\d+\s+(million|billion|thousand)\s+(people|patients|adults|Americans|cases|dentists)/i,
  /according\s+to\s+[A-Z][^,]+,\s*\d/i,
  /\d+[^.]*\(\s*(CDC|ADA|WHO|NIH|NIDCR|study|research|survey|report)/i,
  /(studies?|research|data|survey|report)\s+(show|found|indicate|suggest|reveal)[^.]*\d/i,
];
const STATISTIC_EXCLUSIONS = [
  /\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}/,
  /\d{5}(-\d{4})?/,
  /\$[\d,]+(\.\d{2})?/,
  /\d{1,2}:\d{2}\s*(AM|PM|am|pm)/,
  /\d+\s*(st|nd|rd|th)\s+(floor|suite|ste)/i,
  /copyright\s+©?\s*\d{4}/i,
  /©\s*\d{4}/,
  /established\s+in\s+\d{4}/i,
  /since\s+\d{4}/i,
  /\(\s*\d{4}\s*\)/,
];

// ── §1.4: Outdated year exclusion contexts ────────────────────────────────────

const YEAR_EXCLUSION_CONTEXTS = [
  /copyright/i, /©/, /all\s+rights\s+reserved/i, /since\s+\d{4}/i,
  /established/i, /founded/i, /\d{4}\s*[-–—]\s*\d{4}/, /privacy\s+policy/i,
  /terms\s+of\s+(service|use)/i,
];

function countStatistics(textContent) {
  let count = 0;
  const sentences = textContent.split(/[.!?]+/);
  for (const sentence of sentences) {
    if (STATISTIC_EXCLUSIONS.some(p => p.test(sentence))) continue;
    if (STATISTIC_PATTERNS.some(p => p.test(sentence))) count++;
  }
  return count;
}

// ── §1.7: LocalBusiness subtype registry ─────────────────────────────────────

const LOCAL_BUSINESS_SUBTYPES = new Set([
  'LocalBusiness',
  'Dentist','MedicalOrganization','Hospital','Physician','MedicalClinic','Pharmacy','Optician','Veterinary',
  'Restaurant','Bakery','BarOrPub','CafeOrCoffeeShop','FastFoodRestaurant','Hotel','LodgingBusiness','BedAndBreakfast',
  'Store','AutoDealer','AutoRepair','BeautySalon','HairSalon','HealthClub','SportsClub','GymOrHealthClub',
  'LegalService','Attorney','AccountingService','FinancialService','InsuranceAgency','RealEstateAgent',
  'HomeAndConstructionBusiness','Plumber','Electrician','Locksmith','HVACBusiness','MovingCompany',
  'CleaningService','LandscapingBusiness',
  'School','Library','Museum','PerformingArtsTheater','PlaceOfWorship','GovernmentOffice','FireStation','PoliceStation',
  'TravelAgency','TaxiService','Florist','PetStore',
]);

const VALID_DAY_OF_WEEK_URIS = new Set([
  'http://schema.org/Monday','https://schema.org/Monday',
  'http://schema.org/Tuesday','https://schema.org/Tuesday',
  'http://schema.org/Wednesday','https://schema.org/Wednesday',
  'http://schema.org/Thursday','https://schema.org/Thursday',
  'http://schema.org/Friday','https://schema.org/Friday',
  'http://schema.org/Saturday','https://schema.org/Saturday',
  'http://schema.org/Sunday','https://schema.org/Sunday',
  'http://schema.org/PublicHolidays','https://schema.org/PublicHolidays',
]);
const PLAIN_DAY_STRINGS = new Set(['monday','tuesday','wednesday','thursday','friday','saturday','sunday','publicholidays']);

function validateOpeningHours(spec) {
  const errors = [];
  if (!spec || typeof spec !== 'object') return errors;
  if (spec.canceldayOfWeek) {
    errors.push({ field: 'canceldayOfWeek', error: 'Invalid property name — should be "dayOfWeek" not "canceldayOfWeek".', severity: 'error' });
  }

  // An OpeningHoursSpecification carrying no day and no times is machine-readable noise. The old
  // version only inspected dayOfWeek when present, so `{"@type":"OpeningHoursSpecification"}` — the
  // exact shape on the Arlington page — returned zero errors and the check reported a pass.
  const hasDay = !!(spec.dayOfWeek || spec.canceldayOfWeek);
  const hasTimes = !!(spec.opens && spec.closes);
  if (!hasDay && !hasTimes) {
    errors.push({
      field: 'openingHoursSpecification', severity: 'error',
      error: 'OpeningHoursSpecification is empty — no dayOfWeek, opens, or closes. The object carries no machine-readable hours.',
    });
  } else if (!hasTimes && hasDay) {
    errors.push({ field: 'opens/closes', severity: 'error', error: 'OpeningHoursSpecification is missing opens and/or closes.' });
  }

  const days = spec.dayOfWeek || spec.canceldayOfWeek;
  if (days) {
    const dayArray = Array.isArray(days) ? days : [days];
    for (const rawDay of dayArray) {
      const day = String(rawDay); // a non-string day used to throw on .toLowerCase()
      if (PLAIN_DAY_STRINGS.has(day.toLowerCase())) {
        errors.push({ field: 'dayOfWeek', error: `"${day}" must be a schema.org URI — use "http://schema.org/${day}" instead of plain string.`, severity: 'error' });
      } else if (!VALID_DAY_OF_WEEK_URIS.has(day)) {
        errors.push({ field: 'dayOfWeek', error: `"${day}" is not a valid schema.org dayOfWeek URI.`, severity: 'error' });
      }
    }
  }
  return errors;
}

// ── HTTP check queue ──────────────────────────────────────────────────────────

async function headRequest(url, timeout = 5000) {
  try {
    const r = await axios.head(url, { timeout, maxRedirects: 1, validateStatus: () => true });
    return { status: r.status, final: r.request?.res?.responseUrl || url };
  } catch {
    try {
      const r = await axios.get(url, { timeout, maxRedirects: 1, validateStatus: () => true });
      return { status: r.status, final: r.request?.res?.responseUrl || url };
    } catch {
      return { status: 'timeout', final: url };
    }
  }
}

async function batchHttpChecks(tasks, concurrency = 10) {
  const results = {};
  const queue = [...tasks];
  async function worker() {
    while (queue.length) {
      const { key, url } = queue.shift();
      results[key] = await headRequest(url);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
  return results;
}

// ── A. Title Tag ──────────────────────────────────────────────────────────────

function checksA($) {
  const titles = $('title');
  const titleText = titles.first().text().trim();
  const len = titleText.length;

  const A1 = makeResult('A1','Title Tag','Title tag present');
  const A2 = makeResult('A2','Title Tag','Title tag not empty');
  const A3 = makeResult('A3','Title Tag','Title length: not too short');
  const A4 = makeResult('A4','Title Tag','Title length: not too long');
  const A5 = makeResult('A5','Title Tag','Title does not exactly match H1');
  const A6 = makeResult('A6','Title Tag','Brand name detected in title');
  const A7 = makeResult('A7','Title Tag','No keyword stuffing in title');
  const A8 = makeResult('A8','Title Tag','No special/disruptive characters');
  const A9 = makeResult('A9','Title Tag','Only one title tag present');

  if (titles.length === 0) {
    fail(A1,'error',null,'No <title> element found.');
    fail(A2,'error',null,'No title tag to evaluate.');
    fail(A3,'warning',null,'No title tag present.');
    fail(A4,'warning',null,'No title tag present.');
    pass(A5,null,'No title tag to compare.');
    pass(A6,null,'No title tag present.');
    pass(A7,null,'No title tag present.');
    pass(A8,null,'No title tag present.');
    pass(A9,null,'Only 0 title tags — none found.');
  } else {
    pass(A1, titleText, 'Title tag present.');
    titleText.length > 0 ? pass(A2, titleText, 'Title tag has content.') : fail(A2,'error','','Title tag is empty.');
    len >= 30 ? pass(A3, `${len} chars`, `Title is ${len} characters.`) : warn(A3, `${len} chars`, `Title is only ${len} characters (min 30).`);
    len <= 60 ? pass(A4, `${len} chars`, `Title is ${len} characters.`) : warn(A4, `${len} chars`, `Title is ${len} characters (max 60).`);

    const h1Text = $('h1').first().text().trim().toLowerCase();
    titleText.toLowerCase() === h1Text && h1Text.length > 0
      ? warn(A5, titleText, 'Title exactly matches H1 — differentiate them.')
      : pass(A5, titleText, 'Title differs from H1.');

    const segments = titleText.split(/[|\-–—]/);
    const brand = segments.length > 1 ? segments[segments.length - 1].trim() : null;
    brand ? info(A6, brand, `Brand segment detected: "${brand}".`) : notice(A6, null, 'No brand separator detected in title.');

    const roots = titleText.toLowerCase().split(/\s+/).map(stemWord);
    const freq = {};
    roots.forEach(w => { if (w.length > 3) freq[w] = (freq[w] || 0) + 1; });
    const stuffed = Object.entries(freq).filter(([,c]) => c >= 3);
    stuffed.length ? warn(A7, stuffed.map(([w,c]) => `"${w}"×${c}`).join(', '), 'Same root word appears 3+ times.') : pass(A7, null, 'No keyword stuffing detected.');

    // CHANGE 1 — §1.1: A8 title special characters
    const TITLE_SEPARATOR_WHITELIST = ['|', '-', '–', '—', '·', '•'];
    const stripped = titleText.replace(/\s*[|–—·•\-]\s*/g, ' ');
    const disruptive = stripped.match(/[#$%^*~`@{}\[\]<>\\]/g);
    disruptive ? notice(A8, disruptive.join(''), `Disruptive characters found: ${disruptive.join('')}`) : pass(A8, null, 'No disruptive characters.');

    titles.length === 1 ? pass(A9, '1', 'Exactly one title tag.') : fail(A9,'error', `${titles.length}`, `${titles.length} title tags found — only one allowed.`);
  }

  return [A1,A2,A3,A4,A5,A6,A7,A8,A9];
}

// ── B. Meta Description ───────────────────────────────────────────────────────

function checksB($) {
  const metas = $('meta[name="description"], meta[name="Description"]');
  const content = metas.first().attr('content') || '';
  const len = content.trim().length;

  const B1 = makeResult('B1','Meta Description','Meta description present');
  const B2 = makeResult('B2','Meta Description','Meta description not empty');
  const B3 = makeResult('B3','Meta Description','Length: not too short');
  const B4 = makeResult('B4','Meta Description','Length: not too long');
  const B5 = makeResult('B5','Meta Description','No promotional tone detected');
  const B6 = makeResult('B6','Meta Description','Only one meta description tag');

  metas.length > 0 ? pass(B1, content.substring(0,80), 'Meta description present.') : warn(B1,null,'Meta description missing.');
  len > 0 ? pass(B2, `${len} chars`, 'Meta description has content.') : warn(B2,'','Meta description is empty.');
  len >= 120 ? pass(B3, `${len} chars`, `Length is ${len} characters.`) : notice(B3, `${len} chars`, `Length is ${len} characters (min 120 recommended).`);
  len <= 160 ? pass(B4, `${len} chars`, `Length is ${len} characters.`) : warn(B4, `${len} chars`, `Length is ${len} characters (max 160).`);

  const promoFound = PROMO_WORDS.filter(w => content.toLowerCase().includes(w));
  promoFound.length ? notice(B5, promoFound.join(', '), `Promotional words detected: ${promoFound.join(', ')}.`) : pass(B5, null, 'No promotional tone detected.');

  metas.length === 1 ? pass(B6, '1', 'Exactly one meta description.') : warn(B6, `${metas.length}`, `${metas.length} meta description tags found.`);

  return [B1,B2,B3,B4,B5,B6];
}

// ── C. Meta Robots & Indexability ─────────────────────────────────────────────

function checksC($, httpHeaders) {
  const robotsMeta = $('meta[name="robots"], meta[name="Robots"]').attr('content') || '';
  const rc = robotsMeta.toLowerCase();

  const checks = ['C1','C2','C3','C4','C5','C6','C7','C8','C9','C10','C11'].map((id, i) =>
    makeResult(id, 'Meta Robots', ['Page is not noindex','Page is not nofollow','Not both noindex+nofollow',
      'No noarchive directive','No nosnippet directive','No noimageindex directive',
      'max-snippet value recorded','max-image-preview value recorded','No meta refresh redirect',
      'Meta refresh delay ≠ 0','X-Robots-Tag header recorded'][i], id === 'C11'));

  const [C1,C2,C3,C4,C5,C6,C7,C8,C9,C10,C11] = checks;

  rc.includes('noindex') ? fail(C1,'error',robotsMeta,'Page has noindex directive — will not be indexed.') : pass(C1, robotsMeta||'(not set)', 'No noindex directive.');
  rc.includes('nofollow') ? warn(C2, robotsMeta, 'Page has nofollow directive.') : pass(C2, robotsMeta||'(not set)', 'No nofollow directive.');
  rc.includes('noindex') && rc.includes('nofollow') ? fail(C3,'error',robotsMeta,'Both noindex and nofollow present.') : pass(C3, null, 'Not both noindex+nofollow.');
  rc.includes('noarchive') ? notice(C4, robotsMeta, 'noarchive directive present.') : pass(C4, null, 'No noarchive directive.');
  rc.includes('nosnippet') ? notice(C5, robotsMeta, 'nosnippet directive present.') : pass(C5, null, 'No nosnippet directive.');
  rc.includes('noimageindex') ? notice(C6, robotsMeta, 'noimageindex directive present.') : pass(C6, null, 'No noimageindex directive.');

  const maxSnippet = robotsMeta.match(/max-snippet:\s*(-?\d+)/i);
  maxSnippet ? info(C7, maxSnippet[1], `max-snippet:${maxSnippet[1]}`) : info(C7, null, 'max-snippet not set.');

  const maxImg = robotsMeta.match(/max-image-preview:\s*(\w+)/i);
  maxImg ? info(C8, maxImg[1], `max-image-preview:${maxImg[1]}`) : info(C8, null, 'max-image-preview not set.');

  const refresh = $('meta[http-equiv="refresh"], meta[http-equiv="Refresh"]');
  if (refresh.length) {
    warn(C9, refresh.attr('content'), 'Meta refresh redirect detected.');
    const delay = parseInt((refresh.attr('content') || '').split(';')[0]) || 0;
    delay === 0 ? fail(C10,'error','delay=0','Meta refresh with delay=0 is a hard redirect.') : pass(C10, `delay=${delay}`, `Refresh delay is ${delay}s.`);
  } else {
    pass(C9, null, 'No meta refresh redirect.');
    pass(C10, null, 'No meta refresh present.');
  }

  const xRobots = httpHeaders?.['x-robots-tag'] || null;
  xRobots ? info(C11, xRobots, `X-Robots-Tag: ${xRobots}`) : info(C11, null, 'X-Robots-Tag header not present (or URL not provided).');

  return checks;
}

// ── D. Canonical Tags ─────────────────────────────────────────────────────────

function checksD($, pageUrl, httpHeaders) {
  const canonicals = $('head link[rel="canonical"]');
  const canonHref = canonicals.first().attr('href') || '';

  const D1 = makeResult('D1','Canonical','Canonical tag present');
  const D2 = makeResult('D2','Canonical','Only one canonical tag');
  const D3 = makeResult('D3','Canonical','Canonical href is not empty');
  const D4 = makeResult('D4','Canonical','Canonical is self-referencing');
  const D5 = makeResult('D5','Canonical','Canonical points to different URL');
  const D6 = makeResult('D6','Canonical','Canonical URL uses HTTPS');
  const D7 = makeResult('D7','Canonical','Canonical has consistent trailing slash');
  const D8 = makeResult('D8','Canonical','Canonical target is live',true);
  const D9 = makeResult('D9','Canonical','Canonical target is not noindex',true);

  canonicals.length > 0 ? pass(D1, canonHref, 'Canonical tag present.') : warn(D1,null,'No canonical tag found.');
  canonicals.length <= 1 ? pass(D2, `${canonicals.length}`, 'Only one canonical tag.') : fail(D2,'error',`${canonicals.length}`,`${canonicals.length} canonical tags found.`);
  canonHref.length > 0 ? pass(D3, canonHref, 'Canonical href has a value.') : fail(D3,'error','','Canonical href is empty.');

  if (pageUrl && canonHref) {
    canonHref === pageUrl ? info(D4, canonHref, 'Canonical is self-referencing.') : pass(D4, canonHref, 'Canonical does not self-reference.');
    canonHref !== pageUrl ? notice(D5, canonHref, `Canonical points to: ${canonHref}`) : pass(D5, null, 'Canonical matches page URL.');
    canonHref.startsWith('http://') ? warn(D6,canonHref,'Canonical uses HTTP on an HTTPS page.') : pass(D6, canonHref, 'Canonical uses HTTPS.');
    const pageTrail = pageUrl.endsWith('/');
    const canonTrail = canonHref.endsWith('/');
    pageTrail !== canonTrail ? notice(D7, null, `Trailing slash mismatch: page="${pageUrl}", canonical="${canonHref}".`) : pass(D7, null, 'Trailing slash consistent.');
  } else {
    skipped(D4,'URL not provided'); skipped(D5,'URL not provided');
    skipped(D6,'URL not provided'); skipped(D7,'URL not provided');
  }

  skipped(D8, 'Run HTTP checks separately');
  skipped(D9, 'Run HTTP checks separately');

  return [D1,D2,D3,D4,D5,D6,D7,D8,D9];
}

// ── E. Heading Structure ──────────────────────────────────────────────────────

function checksE($) {
  const h1s = $('h1'); const h2s = $('h2'); const h3s = $('h3');
  const h4s = $('h4'); const h5s = $('h5'); const h6s = $('h6');
  const h1Text = h1s.first().text().trim();

  const E1=makeResult('E1','Headings','H1 tag present');
  const E2=makeResult('E2','Headings','Exactly one H1 tag');
  const E3=makeResult('E3','Headings','H1 is not empty');
  const E4=makeResult('E4','Headings','H1 does not exactly match title');
  const E5=makeResult('E5','Headings','H1 length: not too short');
  const E6=makeResult('E6','Headings','H1 length: not too long');
  const E7=makeResult('E7','Headings','H2 tags present');
  const E8=makeResult('E8','Headings','Heading hierarchy not skipped');
  const E9=makeResult('E9','Headings','No empty headings');
  const E10=makeResult('E10','Headings','Heading counts per level');
  const E11=makeResult('E11','Headings','H2/H3 written as questions');
  const E12=makeResult('E12','Headings','Sub-query coverage signal');
  const E13=makeResult('E13','Headings','No keyword stuffing in headings');

  h1s.length > 0 ? pass(E1, h1Text.substring(0,60), 'H1 present.') : fail(E1,'error',null,'No H1 found.');
  h1s.length === 1 ? pass(E2,'1','Exactly one H1.') : warn(E2,`${h1s.length}`,`${h1s.length} H1 tags found.`);
  h1Text.length > 0 ? pass(E3, h1Text, 'H1 has content.') : fail(E3,'error','','H1 is empty.');

  const titleText = $('title').first().text().trim().toLowerCase();
  h1Text.toLowerCase() === titleText && h1Text.length > 0
    ? warn(E4, h1Text, 'H1 exactly matches title tag.') : pass(E4, h1Text, 'H1 differs from title.');

  h1Text.length >= 20 ? pass(E5,`${h1Text.length} chars`,`H1 is ${h1Text.length} chars.`) : notice(E5,`${h1Text.length} chars`,`H1 is short (${h1Text.length} chars, min 20).`);
  h1Text.length <= 70 ? pass(E6,`${h1Text.length} chars`,`H1 is ${h1Text.length} chars.`) : notice(E6,`${h1Text.length} chars`,`H1 is ${h1Text.length} chars (max 70).`);
  h2s.length > 0 ? pass(E7,`${h2s.length}`,'H2 tags present.') : notice(E7,'0','No H2 tags found.');

  // Hierarchy check
  let hierarchyOk = true;
  let seenH2 = false, seenH3 = false, seenH4 = false, seenH5 = false;
  $('h1,h2,h3,h4,h5,h6').each((_, el) => {
    const tag = el.tagName.toLowerCase();
    if (tag === 'h2') seenH2 = true;
    if (tag === 'h3' && !seenH2) hierarchyOk = false;
    if (tag === 'h3') seenH3 = true;
    if (tag === 'h4' && !seenH3) hierarchyOk = false;
    if (tag === 'h4') seenH4 = true;
    if (tag === 'h5' && !seenH4) hierarchyOk = false;
    if (tag === 'h5') seenH5 = true;
    if (tag === 'h6' && !seenH5) hierarchyOk = false;
  });
  hierarchyOk ? pass(E8, null, 'Heading hierarchy is valid.') : warn(E8, null, 'Heading levels are skipped (e.g. H3 without H2).');

  const emptyHeadings = [];
  $('h1,h2,h3,h4,h5,h6').each((_, el) => { if (!$(el).text().trim()) emptyHeadings.push(el.tagName); });
  emptyHeadings.length ? warn(E9, emptyHeadings.join(', '), `Empty headings found: ${emptyHeadings.join(', ')}.`) : pass(E9, null, 'No empty headings.');

  const counts = { H1: h1s.length, H2: h2s.length, H3: h3s.length, H4: h4s.length, H5: h5s.length, H6: h6s.length };
  info(E10, JSON.stringify(counts), `Heading counts: ${Object.entries(counts).map(([k,v])=>`${k}:${v}`).join(', ')}.`);

  const qHeadings = $('h2,h3').filter((_, el) => $(el).text().trim().endsWith('?')).length;
  info(E11, `${qHeadings}`, `${qHeadings} H2/H3 headings written as questions.`);
  info(E12, `${h2s.length + h3s.length}`, `${h2s.length + h3s.length} H2+H3 sections total.`);

  // CHANGE 12 — §1.13: E13 stemmer normalisation
  const allHeadingText = $('h1,h2,h3,h4,h5,h6').map((_, el) => $(el).text()).get().join(' ');
  const hRoots = allHeadingText.toLowerCase().split(/\s+/).map(w => stemWord(w.replace(/[^a-zA-Z]/g, '')));
  const hFreq = {};
  hRoots.forEach(w => { if (w.length > 3) hFreq[w] = (hFreq[w]||0)+1; });
  const hStuffed = Object.entries(hFreq).filter(([,c])=>c>=3);
  hStuffed.length ? warn(E13, hStuffed.map(([w,c])=>`"${w}"×${c}`).join(', '), 'Keyword stuffing in headings.') : pass(E13, null, 'No heading keyword stuffing.');

  return [E1,E2,E3,E4,E5,E6,E7,E8,E9,E10,E11,E12,E13];
}

// ── §1.2: F6 first paragraph helper ──────────────────────────────────────────

function findFirstContentParagraph($) {
  const excludeSelectors = [
    '[class*="banner"]', '[class*="promo"]', '[class*="cta"]',
    '[class*="alert"]', '[class*="offer"]', '[class*="notice"]',
    '[class*="badge"]', '[class*="tag"]', '[class*="pill"]',
    'header', 'nav', 'aside', 'footer'
  ].join(', ');
  const containers = ['main', 'article', '[class*="content"]', '[class*="body"]', 'body']
    .map(sel => $(sel).first())
    .filter(el => el.length);
  for (const container of containers) {
    const paragraphs = container.find('p').toArray();
    for (const p of paragraphs) {
      const el = $(p);
      if (el.closest(excludeSelectors).length > 0) continue;
      const words = el.text().trim().split(/\s+/).filter(Boolean);
      if (words.length >= 20) return el.text().trim();
    }
  }
  return $('p').first().text().trim();
}

// ── F. Content Quality & Structure ────────────────────────────────────────────

function checksF($, rawHtml, intent = 'informational', pageContext = {}, lbFacts = {}) {
  const $clone = cheerio.load(rawHtml);
  $clone('script,style,noscript').remove();
  const bodyText = $clone('body').text().replace(/\s+/g,' ').trim();
  const wc = wordCount(bodyText);
  const htmlLen = rawHtml.length;
  const textRatio = htmlLen > 0 ? ((bodyText.length / htmlLen) * 100) : 0;

  const isCommercial = intent === 'commercial';
  const isYMYL = !!pageContext.isYMYL;
  const pageType = pageContext.pageType || 'page';
  // A concise, well-structured commercial opener is a direct answer; the 40-word bar was written for
  // editorial ledes and fails legitimate location-page openings.
  const blufMin = isCommercial ? 25 : 40;
  // Word-count bands: a location or contact page has no business being 800+ words.
  const thinFloor = isCommercial ? 150 : 300;
  const thinCeil = isCommercial ? 350 : 600;
  const sweetLo = isCommercial ? 350 : 800;
  const sweetHi = isCommercial ? 1200 : 1500;

  const F = (id, name) => makeResult(id, 'Content Quality', name);

  const F1=F('F1','Word count recorded');
  const F2=F('F2','Word count: not critically thin');
  const F3=F('F3','Word count: not thin');
  const F4=F('F4','Word count in GEO sweet spot');
  const F5=F('F5','Text-to-HTML ratio');
  const F6=F('F6','Direct answer in first paragraph (BLUF)');
  const F7=F('F7','Answer within first 30% of content');
  const F8=F('F8','Named author byline present');
  const F9=F('F9','Author is named (not generic)');
  const F10=F('F10','Author links to bio page');
  const F11=F('F11','Publication date visible');
  const F12=F('F12','Last updated date visible');
  const F13=F('F13','"Last Reviewed by Expert" present');
  const F14=F('F14','Expert quotes present');
  const F15=F('F15','Statistics count: target met');
  const F16=F('F16','Statistics include source attribution');
  const F17=F('F17','Outbound citations to primary sources');
  const F18=F('F18','HTML comparison tables present');
  const F19=F('F19','FAQ section present');
  const F20=F('F20','Brand name in opening paragraph');
  const F21=F('F21','Promotional language detected');
  const F22=F('F22','Keyword stuffing: body text');
  const F23=F('F23','Content length: no long-form without structure');
  const F24=F('F24','Content length: grounding budget signal');
  const F25=F('F25','No hidden text blocks');
  const F26=F('F26','Outdated statistics year check');
  const F27=F('F27','Source citation count recorded');
  const F28=F('F28','CSQAF score (composite)');

  info(F1, `${wc}`, `Word count: ${wc}.`);
  wc < thinFloor ? fail(F2,'error',`${wc}`,`Critically thin content — under ${thinFloor} words.`) : pass(F2,`${wc}`,`Word count above ${thinFloor}.`);
  wc >= thinFloor && wc < thinCeil
    ? (isCommercial ? notice(F3,`${wc}`,`${wc} words — light for a ${pageType} page but not critical.`) : warn(F3,`${wc}`,'Thin content — 300–599 words.'))
    : pass(F3,`${wc}`,'Word count not thin.');

  if (wc >= sweetLo && wc <= sweetHi) pass(F4,`${wc}`,`Word count is in the GEO sweet spot for a ${intent} page (${sweetLo}–${sweetHi}).`);
  else if (wc > 3000) notice(F4,`${wc}`,`Word count is ${wc} — over 3,000 is a GEO grounding risk.`);
  else info(F4,`${wc}`,`Word count: ${wc} (${intent} sweet spot is ${sweetLo}–${sweetHi}).`);

  if (textRatio < 5) fail(F5,'error',`${textRatio.toFixed(1)}%`,`Text-to-HTML ratio is ${textRatio.toFixed(1)}% (critical — under 5%).`);
  else if (textRatio < 10) warn(F5,`${textRatio.toFixed(1)}%`,`Text-to-HTML ratio is ${textRatio.toFixed(1)}% (under 10%).`);
  else pass(F5,`${textRatio.toFixed(1)}%`,`Text-to-HTML ratio: ${textRatio.toFixed(1)}%.`);

  // CHANGE 2 — §1.2: F6 first paragraph detection (BLUF)
  const firstP = findFirstContentParagraph($);
  const firstPWords = wordCount(firstP);
  firstPWords >= blufMin && /[.!?]$/.test(firstP.trim())
    ? pass(F6,firstP.substring(0,100),`First paragraph has a direct answer (BLUF, ${firstPWords} words, ${intent} threshold ${blufMin}).`)
    : warn(F6,firstP.substring(0,100),`First paragraph is short (${firstPWords} words, need ${blufMin}) or lacks a complete sentence.`);

  const h1Kw = $('h1').first().text().trim().toLowerCase().split(/\s+/)[0] || '';
  const first30 = bodyText.split(/\s+/).slice(0, Math.floor(wc * 0.3)).join(' ').toLowerCase();
  h1Kw && first30.includes(h1Kw)
    ? pass(F7, h1Kw, 'Primary keyword appears in first 30% of content.')
    : notice(F7, h1Kw || '(no H1)', 'Primary keyword not found in first 30% of body text.');

  // CHANGE 8 — §1.9: F8/F9 author detection context validation
  const AUTHOR_CONTEXTS = '[rel="author"], [class*="author"], [class*="byline"], [itemprop="author"]';
  const structuralAuthor = $(AUTHOR_CONTEXTS).first();
  const genericAuthorNames = new Set(['team','staff','admin','editor','webmaster','support','marketing']);
  let hasAuthor = false;
  let authorValue = null;
  if (structuralAuthor.length) {
    const authorText = structuralAuthor.text().trim();
    if (authorText && !genericAuthorNames.has(authorText.toLowerCase())) {
      hasAuthor = true; authorValue = authorText;
    }
  }
  if (!hasAuthor) {
    const contentArea = $('main, article, [class*="content"], [class*="post-body"]').first();
    if (contentArea.length) {
      const bylineMatch = contentArea.text().match(/\b(by|written by|author:)\s+([A-Z][a-z]+ [A-Z][a-z]+)/i);
      if (bylineMatch) {
        const matchText = bylineMatch[0];
        const notInTeam = !contentArea.find('[class*="team"], [class*="staff"], [class*="doctor"], [class*="provider"]').text().includes(bylineMatch[2]);
        if (notInTeam) { hasAuthor = true; authorValue = bylineMatch[2]; }
      }
    }
  }
  hasAuthor ? pass(F8, authorValue || '(found)', 'Named author byline detected.') : warn(F8, null, 'No author byline found (E-E-A-T/GEO signal missing).');

  if (!hasAuthor) {
    warn(F9, null, 'No author to evaluate.');
  } else {
    const authorText = (authorValue || '').toLowerCase();
    genericAuthorNames.has(authorText)
      ? warn(F9, authorValue, `Author name is generic ("${authorValue}").`)
      : pass(F9, authorValue || '(found)', 'Author appears to be a named individual.');
  }

  const authorLink = $('[rel="author"] a, [class*="author"] a').first().attr('href') || '';
  authorLink && (authorLink.includes('/author/') || authorLink.includes('/about/'))
    ? pass(F10, authorLink, 'Author links to bio page.')
    : notice(F10, authorLink||null, 'Author does not link to /author/ or /about/ bio page.');

  const timeEl = $('time[datetime], time').first().attr('datetime') || $('time').first().text();
  const datePattern = /\b(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4}|\w+ \d{1,2},? \d{4}|\d{4}-\d{2}-\d{2})\b/;
  const hasDate = timeEl || datePattern.test(rawHtml) || rawHtml.toLowerCase().includes('datepublished');
  hasDate ? pass(F11, String(timeEl||'').substring(0,30), 'Publication date found.') : notice(F11,null,'No publication date detected.');

  const updatedPattern = /last\s+updated|updated\s+on|last\s+modified|reviewed\s+on/i;
  updatedPattern.test(rawHtml) ? pass(F12,null,'Last updated date signal found.') : notice(F12,null,'No "last updated" date signal found.');

  const reviewedPattern = /reviewed\s+by|medically\s+reviewed|fact.?checked\s+by|legally\s+reviewed/i;
  reviewedPattern.test(rawHtml) ? pass(F13,null,'"Reviewed by expert" signal found.') : notice(F13,null,'No expert review attribution found.');

  // Count quotes from the DOM only. Regexing rawHtml for /"[^"]{50,}"/ matched the span between two
  // HTML *attribute* delimiters — on Arlington the single "quote" ran from the closing quote of one
  // attribute to the opening quote of `class="`, and survived only because "Dental Director" matched
  // the old pattern's bare `Director`. That fabricated a GEO signal worth 2 CSQAF points.
  const quoteEls = $('blockquote, q, cite, [class*="quote"], [class*="testimonial"]').toArray();
  const expertQuoteCount = quoteEls.filter(el => {
    const t = $(el).text().trim();
    return t.length >= 60 && CREDENTIAL_PATTERN.test(`${t} ${$(el).next().text()}`);
  }).length;
  expertQuoteCount > 0 ? pass(F14,`${expertQuoteCount}`,`${expertQuoteCount} expert quote(s) found.`) : warn(F14,'0','No expert quotes detected (GEO +40.3% signal missing).');

  // CHANGE 3 — §1.3: Statistics counter fix
  // countStatistics splits on sentence-ending punctuation, but nav menus and CTA buttons have none —
  // so a 50-city location menu with no periods fuses onto the very next real sentence into one giant
  // "sentence". If that fused blob also contains a dollar amount from an unrelated price banner (e.g.
  // "New Patient Offer $79"), the $-exclusion pattern (meant to filter prices, not statistics) throws
  // out the whole blob — discarding a genuine, well-sourced statistic sitting right after it. Verified
  // on a real article: "Nearly 73% of adults... according to a 2025 JADA study" was reported as 0
  // statistics for exactly this reason. Scope to content-only text so nav/header/footer/form can never
  // fuse onto real content and take it down with them.
  const statCount = countStatistics(contentOnlyText(rawHtml));
  statCount >= 4 ? pass(F15,`${statCount}`,`${statCount} statistics found (target: 5–7).`) : warn(F15,`${statCount}`,`Only ${statCount} statistics found (target: ≥4).`);

  // Run against bodyText (script/style already stripped) and require a citation-SHAPED bracket. The
  // old `\[[^\]]{3,50}\]` over rawHtml matched JSON-LD and CSS literals — Arlington's four "sourced
  // statistics" were ["Dentist","MedicalBusiness","LocalBusiness"], ["Tuesday","Thursday"] and two
  // [data-src] selectors, worth another 2 bogus CSQAF points.
  const sourcePattern = /\((?:source|per|via)[,:\s][^)]{1,60}\)|\[\s*\d{1,3}\s*\]|\baccording\s+to\s+[A-Z]/gi;
  const sourcedStats = (bodyText.match(sourcePattern) || []).length;
  sourcedStats > 0 ? pass(F16,`${sourcedStats}`,`${sourcedStats} sourced statistic(s) found.`) : warn(F16,'0','No source attribution found near statistics.');

  const externalLinks = $('a[href]').filter((_, el) => {
    const href = $(el).attr('href') || '';
    return href.startsWith('http') && !href.includes(($('meta[property="og:url"]').attr('content')||'').split('/')[2]||'__none__');
  });
  const primarySources = externalLinks.filter((_, el) => AUTHORITATIVE_DOMAINS.some(d => ($(el).attr('href')||'').includes(d)));
  primarySources.length > 0 ? pass(F17,`${primarySources.length}`,`${primarySources.length} outbound link(s) to primary sources.`) : warn(F17,'0','No outbound citations to .gov/.edu/research domains (GEO +41.5% signal missing).');

  const dataTables = $('table').filter((_, el) => $(el).find('th').length > 0).length;
  dataTables > 0 ? pass(F18,`${dataTables}`,`${dataTables} HTML table(s) with headers found.`) : notice(F18,'0','No comparison tables found.');

  const hasFaq = $('[class*="faq"],[id*="faq"]').length > 0 ||
    $('h2,h3').filter((_, el) => /frequently asked|faq/i.test($(el).text())).length > 0;
  hasFaq ? pass(F19,null,'FAQ section detected.') : notice(F19,null,'No FAQ section detected.');

  // Sourced from the shared, @graph-flattened summary. The old inline re-parse used strict
  // `s['@type'] === 'Organization'` against un-flattened blocks, so the brand name was often missed.
  const orgName = lbFacts.orgName || '';
  const firstPLower = firstP.toLowerCase();
  orgName && firstPLower.includes(orgName)
    ? pass(F20,orgName,'Brand name in opening paragraph (Gemini GEO signal).')
    : notice(F20,orgName||null,'Brand name not found in opening paragraph.');

  // Word-boundary matching, and suppress hits inside a substantiated claim. `split()` had no
  // boundaries (so "leading" matched inside "misleading") and no context, so Arlington's "#1 ranking
  // in 2017" from a named third-party award — a citation — counted as puffery.
  const promoHits = [];
  const promoSentences = bodyText.split(/(?<=[.!?])\s+/);
  for (const sentence of promoSentences) {
    if (SUBSTANTIATED_CLAIM.test(sentence)) continue;
    for (const w of PROMO_WORDS) {
      const re = new RegExp(`(^|[^\\w-])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`, 'gi');
      const found = sentence.match(re);
      if (found) promoHits.push(...found.map(m => ({ word: w, context: sentence.trim().slice(0, 90) })));
    }
  }
  const promoCount = promoHits.length;
  const promoSummary = [...new Set(promoHits.map(h => h.word))].join(', ');
  promoCount > 0
    ? warn(F21, `${promoCount}: ${promoSummary}`, `${promoCount} unsubstantiated promotional term(s) detected (GEO penalty): ${promoSummary}. Claims backed by a named award or year are not counted.`)
    : pass(F21, '0', 'No unsubstantiated promotional language detected.');

  // CHANGE 12 — §1.13: F22 normalise before stemming
  const words = bodyText.toLowerCase().split(/\s+/).filter(w => w.length > 4);
  const stopWords = new Set(['about','above','after','again','against','there','their','these','those','which','would','could','should']);
  const wordFreq = {};
  words.forEach(w => { if (!stopWords.has(w)) wordFreq[stemWord(w.replace(/[^a-zA-Z]/g,''))] = (wordFreq[stemWord(w.replace(/[^a-zA-Z]/g,''))]||0)+1; });
  const topWord = Object.entries(wordFreq).sort(([,a],[,b])=>b-a)[0];
  const density = topWord && wc > 0 ? (topWord[1]/wc*100) : 0;
  density > 4 ? warn(F22,`"${topWord[0]}" at ${density.toFixed(1)}%`,`Keyword density too high: "${topWord[0]}" at ${density.toFixed(1)}%.`) : pass(F22, topWord?`"${topWord[0]}" at ${density.toFixed(1)}%`:null,'No excessive keyword density detected.');

  wc > 5000 && h2s_count($) < 5
    ? warn(F23,`${wc} words`,`Over 5,000 words with fewer than 5 H2 sections.`)
    : pass(F23,`${wc} words`,'Content length vs structure ratio is acceptable.');

  wc > 3000 ? notice(F24,`${wc} words`,`${wc} words — over 3,000 is a GEO grounding budget risk.`) : pass(F24,`${wc} words`,'Word count within GEO grounding range.');

  const hiddenTexts = [];
  $('[style]').each((_, el) => {
    const style = ($(el).attr('style')||'').replace(/\s/g,'').toLowerCase();
    if ((style.includes('display:none') || style.includes('visibility:hidden')) && wordCount($(el).text()) > 20)
      hiddenTexts.push($(el).text().substring(0,40));
  });
  hiddenTexts.length ? fail(F25,'error',`${hiddenTexts.length} block(s)`,`Hidden text blocks with >20 words detected.`) : pass(F25,null,'No hidden text blocks detected.');

  // CHANGE 4 — §1.4: F26 outdated year detection
  const currentYear = new Date().getFullYear();
  const oldStatYears = [];
  const sentences = bodyText.split(/[.!?]+/);
  for (const sentence of sentences) {
    if (YEAR_EXCLUSION_CONTEXTS.some(p => p.test(sentence))) continue;
    if (!STATISTIC_PATTERNS.some(p => p.test(sentence))) continue;
    const years = sentence.match(/\b(20\d{2})\b/g) || [];
    years.forEach(y => { if (parseInt(y) <= currentYear - 3) oldStatYears.push(y); });
  }
  const uniqueOldStat = [...new Set(oldStatYears)];
  uniqueOldStat.length > 0
    ? warn(F26, uniqueOldStat.join(', '), `Statistics cite outdated year(s): ${uniqueOldStat.join(', ')} (≥3 years old).`)
    : pass(F26, null, 'No outdated year references in statistics.');

  info(F27,`${primarySources.length}`,`${primarySources.length} outbound links to authoritative domains.`);

  // ── Intent gating ──────────────────────────────────────────────────────────
  // On a commercial page, citations / statistics / expert quotations and the editorial byline axis
  // are not ranking or citation signals. Mark them 'na' rather than passing them: a silent pass would
  // add a free 100 to the score AND make the report assert things like "expert quote(s) found".
  if (isCommercial) {
    na(F14, 'commercial intent: expert quotations are not a citation signal for a transactional page.');
    na(F15, 'commercial intent: statistics are not a ranking or citation signal for this page type.');
    na(F16, 'commercial intent: statistic source attribution does not apply.');
    na(F17, 'commercial intent: outbound research citations are not expected on a transactional page.');
    na(F26, 'commercial intent: no statistics are being judged, so their vintage is moot.');
    na(F27, 'commercial intent: citation counting does not apply.');
    na(F8,  `commercial intent: an author byline is not the E-E-A-T signal for a ${pageType} page.`);
    na(F9,  'commercial intent: dependent on the author byline check.');
    na(F10, 'commercial intent: dependent on the author byline check.');
    na(F11, 'commercial intent: publication date is an editorial-freshness signal.');
    if (!isYMYL) na(F13, 'commercial intent, non-YMYL: expert review attribution does not apply.');
  }

  const answerability = computeAnswerability(intent, {
    sourcedStats, statCount, expertQuoteCount, hasAuthor, promoCount,
    lbFacts,
    blufOk: firstPWords >= blufMin && /[.!?]$/.test(firstP.trim()),
    qaOk: lbFacts.questionHeadingCount >= 3 || lbFacts.faqSchemaValid,
  });
  info(F28, `${answerability.score}/10`,
    `${answerability.rubric} answerability score: ${answerability.score}/10 (${answerability.earned} of ${answerability.max} pts).`);

  return {
    checks: [F1,F2,F3,F4,F5,F6,F7,F8,F9,F10,F11,F12,F13,F14,F15,F16,F17,F18,F19,F20,F21,F22,F23,F24,F25,F26,F27,F28],
    geo: {
      // csqaf_score is retained as an alias of the answerability score: T3 and previously-persisted
      // client runs both read it.
      csqaf_score: answerability.score,
      answerability_score: answerability.score,
      answerability_rubric: answerability.rubric,
      answerability_earned: answerability.earned,
      answerability_max: answerability.max,
      answerability_breakdown: answerability.breakdown,
      statistics_count: statCount,
      expert_quotes: expertQuoteCount,
      named_author: hasAuthor,
      primary_source_citations: primarySources.length,
      html_tables: dataTables,
      faq_section: hasFaq,
      direct_answer_opening: firstPWords >= blufMin,
      promotional_language_count: promoCount,
      promotional_language_hits: promoHits.slice(0, 12),
      // Commercial-intent tiles
      nap_complete: !!(lbFacts.hasTelephone && lbFacts.addrComplete),
      hours_valid: !!lbFacts.ohsValid,
      review_markup: !!(lbFacts.aggregateRating || (lbFacts.reviewNodes || []).length),
      sameas_count: (lbFacts.sameAsUrls || []).length,
      service_area_clear: !!lbFacts.hasAreaServed,
      // Visible-on-page counterparts of the three tiles above. These let the UI separate
      // "the fact is absent entirely" from "the fact is on the page but not encoded in
      // schema" — the second is a markup task, not missing content, and showing both as a
      // bare "No" is what made a page with a plainly visible address look mis-audited.
      nap_on_page: !!lbFacts.visibleAddressOnPage,
      hours_on_page: !!lbFacts.visibleHoursOnPage,
      reviews_on_page: !!lbFacts.visibleReviewsOnPage,
      named_practitioners: (pageContext.namedPractitioners || []).length,
    }
  };
}

function h2s_count($) { return $('h2').length; }

// ── G. Images ─────────────────────────────────────────────────────────────────

function checksG($) {
  const imgs = $('img');
  const total = imgs.length;

  const G = (id,name,req=false) => makeResult(id,'Images',name,req);
  const G1=G('G1','All non-decorative images have alt text');
  const G2=G('G2','No empty alt on non-decorative images');
  const G3=G('G3','Alt text length: not too long');
  const G4=G('G4','No keyword stuffing in alt text');
  const G5=G('G5','Decorative images have empty alt');
  const G6=G('G6','Image dimensions specified');
  const G7=G('G7','Lazy loading implemented');
  const G8=G('G8','Modern image formats used');
  const G9=G('G9','No empty src attributes');
  const G10=G('G10','No large inline base64 images');
  const G11=G('G11','figure + figcaption used for content images');
  const G12=G('G12','No hotlinked external images');
  const G13=G('G13','Broken images check',true);

  const missingAlt = [], emptyAltNonDec = [], longAlt = [], stuffedAlt = [];
  const noDims = [], noLazy = [], oldFormat = [], emptySrc = [], bigBase64 = [];
  let lazyCount = 0;

  imgs.each((_, el) => {
    const src = $(el).attr('src') || '';
    const alt = $(el).attr('alt');
    const isDecor = $(el).attr('role') === 'presentation' || $(el).closest('[role="presentation"]').length > 0;
    const isIcon = /icon|logo|spacer|pixel/i.test(src);

    // CHANGE 5 — §1.5: G1/G2 decorative image detection
    const isDecorativeByAttr = $(el).attr('aria-hidden') === 'true'
      || $(el).attr('role') === 'presentation' || $(el).attr('role') === 'none'
      || $(el).closest('[role="presentation"]').length > 0
      || /\b(icon|spacer|pixel|separator|decoration|divider|bg)\b/i.test($(el).attr('class') || '')
      || /spacer|pixel|dot\.gif|blank/i.test(src)
      || (parseInt($(el).attr('width')) <= 4 && parseInt($(el).attr('width')) > 0)
      || (parseInt($(el).attr('height')) <= 4 && parseInt($(el).attr('height')) > 0);
    const isDecorFull = isDecor || isIcon || isDecorativeByAttr;

    // G1: missing alt (undefined) on non-decorative
    if (!isDecorFull && alt === undefined) missingAlt.push(src.substring(0,40));
    // G2: empty alt="" on non-decorative (empty alt is correct only on decorative)
    if (!isDecorFull && alt !== undefined && alt.trim() === '') emptyAltNonDec.push(src.substring(0,40));

    if (alt && alt.length > 125) longAlt.push(alt.substring(0,40));
    if (alt) {
      const altRoots = alt.toLowerCase().split(/\s+/).map(stemWord);
      const af = {};
      altRoots.forEach(w => { if (w.length > 3) af[w]=(af[w]||0)+1; });
      if (Object.values(af).some(c=>c>=3)) stuffedAlt.push(alt.substring(0,40));
    }
    if (!$(el).attr('width') && !$(el).attr('height')) noDims.push(src.substring(0,40));
    if ($(el).attr('loading') === 'lazy') lazyCount++;
    if (/\.(jpg|jpeg|png)$/i.test(src)) oldFormat.push(src.substring(0,40));
    if (!src || src.trim() === '') emptySrc.push('(empty src)');
    if (src.startsWith('data:image') && src.length > 50000) bigBase64.push('(base64 image)');
  });

  // CHANGE 5 — updated G1/G2 pass/fail
  missingAlt.length || emptyAltNonDec.length
    ? fail(G1,'error',`${missingAlt.length + emptyAltNonDec.length} imgs`,`${missingAlt.length} non-decorative image(s) missing alt text, ${emptyAltNonDec.length} have empty alt="".`)
    : pass(G1,`${total} imgs`,'All non-decorative images have non-empty alt text.');
  emptyAltNonDec.length
    ? warn(G2,`${emptyAltNonDec.length}`,`${emptyAltNonDec.length} non-decorative image(s) have empty alt="".`)
    : pass(G2,null,'No problematic empty alt attributes.');

  longAlt.length ? notice(G3,`${longAlt.length} imgs`,`${longAlt.length} alt attribute(s) over 125 characters.`) : pass(G3,null,'All alt texts are reasonable length.');
  stuffedAlt.length ? warn(G4,`${stuffedAlt.length} imgs`,`${stuffedAlt.length} alt attribute(s) with keyword stuffing.`) : pass(G4,null,'No alt text keyword stuffing.');
  info(G5,null,'Decorative image check recorded.');
  noDims.length ? warn(G6,`${noDims.length}`,`${noDims.length} image(s) missing width/height attributes.`) : pass(G6,null,'All images specify dimensions.');

  // CHANGE 11 — §1.12: G7 lazy loading threshold
  const nonHeroImgs = Math.max(0, total - 1); // skip first image (LCP)
  const pct = nonHeroImgs > 0 ? (lazyCount / nonHeroImgs) : 1;
  if (nonHeroImgs === 0 || pct >= 0.8) pass(G7, `${lazyCount}/${total}`, `${lazyCount} of ${total} images use lazy loading.`);
  else if (pct >= 0.5) notice(G7, `${lazyCount}/${nonHeroImgs}`, `${lazyCount}/${nonHeroImgs} non-hero images have lazy loading. Target: ≥80%.`);
  else warn(G7, `${lazyCount}/${nonHeroImgs}`, `Only ${lazyCount}/${nonHeroImgs} non-hero images have loading="lazy" (${Math.round(pct*100)}%). Missing lazy loading forces all images to load at page open.`);

  oldFormat.length ? notice(G8,`${oldFormat.length}`,`${oldFormat.length} image(s) use JPEG/PNG — consider WebP/AVIF.`) : pass(G8,null,'Modern image formats in use.');
  emptySrc.length ? fail(G9,'error',`${emptySrc.length}`,`${emptySrc.length} image(s) with empty src.`) : pass(G9,null,'No empty image src attributes.');
  bigBase64.length ? warn(G10,`${bigBase64.length}`,`${bigBase64.length} large inline base64 image(s) detected.`) : pass(G10,null,'No large inline base64 images.');
  const figcaptions = $('figure figcaption').length;
  info(G11,`${figcaptions}`,`${figcaptions} figure/figcaption pairs found.`);
  const hotlinked = imgs.filter((_, el) => {
    const src = $(el).attr('src')||'';
    return src.startsWith('http') && !/cdn\.|cloudfront\.|amazonaws\.|imgix\.|cloudinary\./.test(src);
  }).length;
  hotlinked > 0 ? notice(G12,`${hotlinked}`,`${hotlinked} potentially hotlinked external image(s).`) : pass(G12,null,'No hotlinked external images detected.');
  skipped(G13, 'HTTP checks run separately');

  return [G1,G2,G3,G4,G5,G6,G7,G8,G9,G10,G11,G12,G13];
}

// ── H. Internal Links ─────────────────────────────────────────────────────────

function checksH($, pageUrl) {
  const domain = pageUrl ? (new URL(pageUrl).hostname) : '';
  const allLinks = $('a[href]');
  const internal = allLinks.filter((_, el) => {
    const href = $(el).attr('href')||'';
    return href.startsWith('/') || (domain && href.includes(domain));
  });

  const H = (id,name,req=false) => makeResult(id,'Internal Links',name,req);
  const H1=H('H1','Total internal link count');
  const H2=H('H2','No nofollow on internal links');
  const H3=H('H3','No mixed nofollow/dofollow');
  const H4=H('H4','No internal links to noindex pages',true);
  const H5=H('H5','No empty anchor text on internal links');
  const H6=H('H6','No non-descriptive anchor text');
  const H7=H('H7','No JavaScript-only internal links');
  const H8=H('H8','No hash-only fragment links as primary nav');
  const H9=H('H9','Internal links to redirected pages',true);
  const H10=H('H10','Internal links to 4xx pages',true);
  const H11=H('H11','Link distribution by DOM area');

  info(H1,`${internal.length}`,`${internal.length} internal links found.`);

  const nofollowInternal = internal.filter((_, el) => ($(el).attr('rel')||'').includes('nofollow'));
  nofollowInternal.length ? warn(H2,`${nofollowInternal.length}`,`${nofollowInternal.length} internal link(s) with nofollow.`) : pass(H2,null,'No nofollow on internal links.');

  pass(H3, null, 'Mixed nofollow check — review manually if needed.');

  skipped(H4, 'HTTP checks run separately');

  const emptyAnchors = internal.filter((_, el) => {
    const text = $(el).text().trim();
    const hasImg = $(el).find('img[alt]').length > 0;
    return !text && !hasImg;
  });
  emptyAnchors.length ? warn(H5,`${emptyAnchors.length}`,`${emptyAnchors.length} internal link(s) with empty anchor text.`) : pass(H5,null,'No empty anchor text on internal links.');

  const nonDescriptive = internal.filter((_, el) => NON_DESCRIPTIVE_ANCHORS.has($(el).text().trim().toLowerCase())).length;
  nonDescriptive ? warn(H6,`${nonDescriptive}`,`${nonDescriptive} non-descriptive anchor text link(s) found.`) : pass(H6,null,'No non-descriptive anchor text.');

  const jsLinks = internal.filter((_, el) => {
    const href = $(el).attr('href')||'';
    return (href === '#' || href.startsWith('javascript:')) && $(el).attr('onclick');
  });
  jsLinks.length ? warn(H7,`${jsLinks.length}`,`${jsLinks.length} JavaScript-only link(s) detected.`) : pass(H7,null,'No JS-only links.');

  const hashLinks = $('a[href^="#"]').length;
  hashLinks > 5 ? notice(H8,`${hashLinks}`,`${hashLinks} hash-only fragment links.`) : pass(H8,`${hashLinks}`,`${hashLinks} fragment links.`);

  skipped(H9,'HTTP checks run separately');
  skipped(H10,'HTTP checks run separately');

  const navLinks = $('nav a').length;
  const mainLinks = $('main a, article a').length;
  const footerLinks = $('footer a').length;
  info(H11,`nav:${navLinks} main:${mainLinks} footer:${footerLinks}`,`Link distribution — nav:${navLinks}, main:${mainLinks}, footer:${footerLinks}.`);

  return [H1,H2,H3,H4,H5,H6,H7,H8,H9,H10,H11];
}

// ── I. External Links ─────────────────────────────────────────────────────────

function checksI($, pageUrl, intent = 'informational') {
  const isCommercial = intent === 'commercial';
  let domain = '';
  try { domain = pageUrl ? new URL(pageUrl).hostname : ''; } catch { domain = ''; }
  const allLinks = $('a[href]');
  const external = allLinks.filter((_, el) => {
    const href = $(el).attr('href')||'';
    return href.startsWith('http') && (!domain || !href.includes(domain));
  });
  const total = allLinks.length;

  const I = (id,name,req=false) => makeResult(id,'External Links',name,req);
  const I1=I('I1','Total external link count');
  const I2=I('I2','Total link count: not excessive');
  const I3=I('I3','No external links to HTTP');
  const I4=I('I4','rel=noopener noreferrer on target=_blank');
  const I5=I('I5','Outbound citations to primary sources');
  const I6=I('I6','Broken external links',true);
  const I7=I('I7','External links to redirect pages',true);

  info(I1,`${external.length}`,`${external.length} external links found.`);
  total > 100 ? warn(I2,`${total}`,`${total} total links — over 100 can dilute link equity.`) : pass(I2,`${total}`,`${total} total links.`);

  const httpExt = external.filter((_, el) => ($(el).attr('href')||'').startsWith('http://'));
  httpExt.length ? warn(I3,`${httpExt.length}`,`${httpExt.length} external link(s) use HTTP.`) : pass(I3,null,'All external links use HTTPS.');

  const blankNoOpener = $('a[target="_blank"]').filter((_, el) => !($(el).attr('rel')||'').includes('noopener'));
  blankNoOpener.length ? warn(I4,`${blankNoOpener.length}`,`${blankNoOpener.length} target="_blank" link(s) missing rel="noopener noreferrer".`) : pass(I4,null,'All target="_blank" links have noopener.');

  // CHANGE 6 — §1.6: I5 zero citations shows as pass
  const primaryCount = external.filter((_, el) => AUTHORITATIVE_DOMAINS.some(d => ($(el).attr('href')||'').includes(d))).length;
  if (isCommercial) {
    // Same citations axis as F17/R7 under a different category name — zeroing those and leaving this
    // one deducting would not honour "no weightage to citations".
    na(I5, 'commercial intent: outbound research citations are not a ranking signal for a transactional page.');
  } else if (primaryCount >= 3) pass(I5,`${primaryCount}`,`${primaryCount} outbound links to primary sources.`);
  else if (primaryCount >= 1) notice(I5,`${primaryCount}`,`${primaryCount} outbound link(s) to primary sources — target ≥3.`);
  else notice(I5,'0','No outbound citations to .gov/.edu/research domains. Adding ≥2 citations is a validated GEO signal (+41.5% visibility).');

  skipped(I6,'HTTP checks run separately');
  skipped(I7,'HTTP checks run separately');

  return [I1,I2,I3,I4,I5,I6,I7];
}

// ── J. Structured Data / Schema ───────────────────────────────────────────────

// `parsedSchemas` is now supplied by the caller (already @graph-flattened and recursed into nested
// entities). checksJ used to re-parse the JSON-LD itself and NOT flatten @graph, which is why it
// reported "No Organization schema found" and skipped J5-J13 on a page whose Dentist node was right
// there inside an @graph — and why it disagreed with detectPageType() about the very same document.
function checksJ($, parsedSchemas = [], intent = 'informational', lbFacts = {}) {
  const isCommercial = intent === 'commercial';
  const J = (id,name) => makeResult(id,'Schema','Schema: '+name);
  const results = [];
  const add = r => { results.push(r); return r; };

  const J1=add(J('J1','Schema markup present'));
  const J2=add(J('J2','Schema type(s) detected'));
  const J3=add(J('J3','JSON-LD is valid JSON'));

  const blocks = $('script[type="application/ld+json"]');
  const parseErrors = parsedSchemas.filter(s => s && s._parseError).length;

  blocks.length > 0 ? pass(J1,`${blocks.length} block(s)`,`${blocks.length} JSON-LD block(s) found.`) : warn(J1,'0','No schema markup found.');
  const types = [...new Set(parsedSchemas.flatMap(s => typesOf(s)))];
  types.length ? info(J2, types.join(', '), `Schema types: ${types.join(', ')}.`) : info(J2, null, 'No schema types detected.');
  parseErrors === 0 ? pass(J3, null, 'All JSON-LD blocks are valid JSON.') : fail(J3,'error',`${parseErrors} error(s)`,`${parseErrors} JSON-LD block(s) failed JSON parsing.`);

  // CHANGE 7 — §1.8: J4 updated to use subtype registry
  const J4=add(J('J4','Organization schema present'));
  // Prefer a real Organization node for brand-level fields. `find()` on the combined predicate used to
  // return the first LocalBusiness subtype instead, so J5-J13 evaluated the Dentist node and reported
  // a missing logo / missing YouTube profile while a proper Organization node carried both.
  const orgSchema = lbFacts.orgOrLb
    || parsedSchemas.find(s => hasType(s, 'Organization'))
    || parsedSchemas.find(s => typesOf(s).some(t => LOCAL_BUSINESS_SUBTYPES.has(t)));
  orgSchema ? pass(J4, typesOf(orgSchema)[0], 'Organization/LocalBusiness schema found.') : warn(J4,null,'No Organization schema found.');

  const articleSchema = parsedSchemas.find(s => ['Article','BlogPosting','NewsArticle'].some(t => hasType(s, t)));
  const faqSchema = parsedSchemas.find(s => hasType(s, 'FAQPage'));
  const personSchema = parsedSchemas.find(s => hasType(s, 'Person'));
  const productSchema = parsedSchemas.find(s => hasType(s, 'Product'));
  const breadcrumbSchema = parsedSchemas.find(s => hasType(s, 'BreadcrumbList'));
  const videoSchema = parsedSchemas.find(s => hasType(s, 'VideoObject'));

  const J5=add(J('J5','Organization: name field'));
  const J6=add(J('J6','Organization: url field'));
  const J7=add(J('J7','Organization: logo field'));
  const J8=add(J('J8','Organization: description field'));
  const J9=add(J('J9','Organization: sameAs array'));
  const J10=add(J('J10','sameAs links to LinkedIn'));
  const J11=add(J('J11','sameAs links to Wikidata'));
  const J12=add(J('J12','sameAs links to YouTube'));
  const J13=add(J('J13','@id used in schema'));

  if (orgSchema) {
    orgSchema.name ? pass(J5,orgSchema.name,'Organization name present.') : fail(J5,'error',null,'Organization schema missing name field.');
    orgSchema.url ? pass(J6,orgSchema.url,'Organization url present.') : warn(J6,null,'Organization schema missing url field.');
    orgSchema.logo ? pass(J7,typeof orgSchema.logo==='object'?orgSchema.logo.url:orgSchema.logo,'Organization logo present.') : warn(J7,null,'Organization schema missing logo field.');
    orgSchema.description ? pass(J8,orgSchema.description.substring(0,60),'Organization description present.') : warn(J8,null,'Organization schema missing description field.');
    // Union across all org-like blocks, and normalised: publishers legitimately split entity
    // properties across nodes, and `sameAs` is frequently a comma-joined STRING. Reading `.length` on
    // that string reported "117 profiles" and `.some()` threw a TypeError that 500'd the audit.
    const sameAs = (lbFacts.sameAsUrls && lbFacts.sameAsUrls.length) ? lbFacts.sameAsUrls : toSameAsArray(orgSchema.sameAs);
    sameAs.length >= 1 ? pass(J9,`${sameAs.length} profiles`,`sameAs has ${sameAs.length} profile(s).`) : warn(J9,'0','Organization schema missing sameAs (GEO entity signal).');
    sameAs.some(u=>u.includes('linkedin.com')) ? pass(J10,null,'sameAs includes LinkedIn.') : notice(J10,null,'sameAs missing LinkedIn.');
    sameAs.some(u=>u.includes('wikidata.org')) ? pass(J11,null,'sameAs includes Wikidata.') : notice(J11,null,'sameAs missing Wikidata.');
    sameAs.some(u=>u.includes('youtube.com')) ? pass(J12,null,'sameAs includes YouTube.') : notice(J12,null,'sameAs missing YouTube.');
    const anyId = orgSchema['@id'] || (parsedSchemas.find(s => s['@id']) || {})['@id'];
    anyId ? pass(J13,anyId,'@id present in schema.') : warn(J13,null,'@id missing from Organization schema.');
  } else {
    [J5,J6,J7,J8,J9,J10,J11,J12,J13].forEach(r => skipped(r,'No Organization schema'));
  }

  const J14=add(J('J14','Article schema on editorial pages'));
  const J15=add(J('J15','Article: author field'));
  const J16=add(J('J16','Article: datePublished'));
  const J17=add(J('J17','Article: dateModified'));

  if (articleSchema) {
    pass(J14,typesOf(articleSchema)[0],'Article schema present.');
    articleSchema.author ? pass(J15,typeof articleSchema.author==='object'?articleSchema.author.name:articleSchema.author,'Article author present.') : fail(J15,'error',null,'Article schema missing author.');
    articleSchema.datePublished ? pass(J16,articleSchema.datePublished,'datePublished present.') : warn(J16,null,'Article schema missing datePublished.');
    articleSchema.dateModified ? pass(J17,articleSchema.dateModified,'dateModified present (GEO freshness signal).') : warn(J17,null,'Article schema missing dateModified.');
  } else if (isCommercial) {
    // Correctly NOT having Article schema on a transactional page was scoring 75% credit. The prompt
    // already forbids recommending Article schema here; now the score agrees.
    na(J14,'commercial intent: Article/BlogPosting schema does not belong on a transactional page.');
    [J15,J16,J17].forEach(r => na(r,'commercial intent: no Article schema expected.'));
  } else {
    notice(J14,null,'No Article/BlogPosting schema — consider adding if this is editorial content.');
    [J15,J16,J17].forEach(r => skipped(r,'No Article schema'));
  }

  const J18=add(J('J18','FAQPage schema present'));
  const J19=add(J('J19','FAQPage Q&A format correct'));
  if (faqSchema) {
    pass(J18,null,'FAQPage schema found.');
    const items = [].concat(faqSchema.mainEntity || []);
    const valid = items.every(i => i['@type']==='Question' && i.acceptedAnswer && i.acceptedAnswer['@type']==='Answer');
    valid ? pass(J19,`${items.length} Q&A pairs`,'FAQPage structure is correct.') : fail(J19,'error',null,'FAQPage items have incorrect structure.');
  } else {
    notice(J18,null,'No FAQPage schema.'); skipped(J19,'No FAQPage schema');
  }

  const J20=add(J('J20','Person schema on bio pages'));
  const J21=add(J('J21','Person: name, jobTitle, affiliation, sameAs'));
  if (personSchema) {
    const personCount = parsedSchemas.filter(s => hasType(s, 'Person')).length;
    pass(J20,`${personCount} Person node(s)`,`${personCount} Person schema node(s) found.`);
    const hasAll = personSchema.name && personSchema.jobTitle && personSchema.affiliation && personSchema.sameAs;
    hasAll ? pass(J21,null,'Person schema has all required fields.') : warn(J21,personSchema.name || null,'Person schema missing one or more of: name, jobTitle, affiliation, sameAs.');
  } else {
    // Was info() → rendered as a green pass reading "No Person schema detected."
    notice(J20,null,'No Person schema detected. Publish practitioners/authors as Person nodes.');
    skipped(J21,'No Person schema');
  }

  // CHANGE 7 — §1.8: J22/J23 LocalBusiness subtype registry + validation
  const J22=add(J('J22','LocalBusiness / subtype schema'));
  const J23=add(J('J23','LocalBusiness: address, telephone, geo, openingHours'));

  const lbSchema = lbFacts.lbSchema || parsedSchemas.find(s => typesOf(s).some(t => LOCAL_BUSINESS_SUBTYPES.has(t)));

  if (lbSchema) {
    const lbType = lbFacts.lbType || typesOf(lbSchema).find(t => LOCAL_BUSINESS_SUBTYPES.has(t));
    const ohsErrors = (lbFacts.ohsErrors && lbFacts.ohsErrors.length)
      ? lbFacts.ohsErrors
      : [].concat(lbSchema.openingHoursSpecification || []).flatMap(ohs => validateOpeningHours(ohs));

    // A plain-string dayOfWeek (or an empty spec) makes the hours block invalid for rich results —
    // that is an error-class defect, not a warning.
    if (ohsErrors.length > 0) {
      const anyError = ohsErrors.some(e => e.severity === 'error');
      const msg = `${lbType} schema has ${ohsErrors.length} openingHours validation error(s): ${ohsErrors.slice(0, 5).map(e=>e.error).join('; ')}`;
      anyError ? fail(J22, 'error', lbType, msg) : warn(J22, lbType, msg);
    } else {
      pass(J22, lbType, `${lbType} schema found (LocalBusiness subtype).`);
    }

    const missingFields = [];
    if (!lbSchema.address) missingFields.push('address');
    if (!lbSchema.telephone) missingFields.push('telephone');
    if (!lbSchema.geo) missingFields.push('geo');
    if (!lbFacts.ohsPresent) missingFields.push('openingHoursSpecification');
    if (!(lbFacts.sameAsUrls || []).length) missingFields.push('sameAs');

    // On a commercial page a business node without NAP is error-class; a missing geo/hours/sameAs is
    // a warning.
    const napMissing = missingFields.includes('address') || missingFields.includes('telephone');
    if (missingFields.length === 0) {
      pass(J23, null, 'LocalBusiness schema has all key fields.');
    } else if (isCommercial && napMissing) {
      fail(J23, 'error', missingFields.join(', '), `LocalBusiness is missing NAP field(s): ${missingFields.join(', ')}.`);
    } else {
      warn(J23, missingFields.join(', '), `LocalBusiness missing field(s): ${missingFields.join(', ')}.`);
    }
  } else if (isCommercial) {
    warn(J22, null, 'No LocalBusiness/subtype schema on a commercial page — add the appropriate subtype.');
    skipped(J23, 'No LocalBusiness schema');
  } else {
    na(J22, 'no LocalBusiness schema, and this is not a commercial page.');
    skipped(J23, 'No LocalBusiness schema');
  }

  const J24=add(J('J24','Product + Offer schema'));
  productSchema ? pass(J24,null,'Product schema found.') : info(J24,null,'No Product schema.');

  const J25=add(J('J25','BreadcrumbList schema'));
  breadcrumbSchema ? pass(J25,null,'BreadcrumbList schema found.') : notice(J25,null,'No BreadcrumbList schema.');

  const J26=add(J('J26','VideoObject schema'));
  const hasVideo = $('iframe[src*="youtube.com"], iframe[src*="vimeo.com"]').length > 0;
  if (hasVideo && !videoSchema) warn(J26,null,'Video embed detected but no VideoObject schema.'); else if (videoSchema) pass(J26,null,'VideoObject schema found.'); else na(J26,'no video content on this page.');

  const J27=add(J('J27','HowTo schema'));
  info(J27, null, parsedSchemas.find(s => hasType(s, 'HowTo')) ? 'HowTo schema present.' : 'No HowTo schema.');

  const J28=add(J('J28','Schema format is JSON-LD'));
  const hasMicrodata = $('[itemscope]').length > 0;
  hasMicrodata ? warn(J28,null,'Microdata attributes detected — JSON-LD is preferred.') : pass(J28,null,'No Microdata detected.');

  const J29=add(J('J29','No conflicting schema types'));
  const hasConflict = types.includes('Article') && types.includes('Product');
  hasConflict ? warn(J29,types.join(', '),'Conflicting schema types detected (Article + Product).') : pass(J29,null,'No conflicting schema types.');

  const J30=add(J('J30','YMYL: MedicalOrganization schema'));
  const J31=add(J('J31','YMYL: Attorney/FinancialService schema'));
  info(J30,null,'YMYL medical schema check — review if applicable.');
  info(J31,null,'YMYL legal/financial schema check — review if applicable.');

  return results;
}

// ── K. Open Graph & Social Meta ───────────────────────────────────────────────

function checksK($, pageUrl) {
  const og = prop => $(`meta[property="${prop}"]`).attr('content') || null;
  const tw = name => $(`meta[name="${name}"]`).attr('content') || null;

  const K = (id,name,req=false) => makeResult(id,'Open Graph','OG: '+name,req);
  const K1=K('K1','og:title');  const K2=K('K2','og:description'); const K3=K('K3','og:image');
  const K4=K('K4','og:image URL accessible',true); const K5=K('K5','og:url');
  const K6=K('K6','og:url matches canonical'); const K7=K('K7','og:type'); const K8=K('K8','og:site_name');
  const K9=K('K9','twitter:card'); const K10=K('K10','twitter:title');
  const K11=K('K11','twitter:description'); const K12=K('K12','twitter:image');

  const ogTitle = og('og:title');
  ogTitle ? pass(K1,ogTitle.substring(0,60),'og:title present.') : warn(K1,null,'og:title missing.');
  const ogDesc = og('og:description');
  ogDesc ? pass(K2,ogDesc.substring(0,60),'og:description present.') : warn(K2,null,'og:description missing.');
  const ogImg = og('og:image');
  ogImg ? pass(K3,ogImg,'og:image present.') : warn(K3,null,'og:image missing.');
  skipped(K4,'HTTP checks run separately');
  const ogUrl = og('og:url');
  ogUrl ? pass(K5,ogUrl,'og:url present.') : warn(K5,null,'og:url missing.');

  const canonHref = $('link[rel="canonical"]').attr('href') || '';
  if (ogUrl && canonHref) {
    ogUrl === canonHref ? pass(K6,null,'og:url matches canonical.') : warn(K6,`og:${ogUrl} vs canon:${canonHref}`,'og:url does not match canonical URL.');
  } else { skipped(K6,'og:url or canonical missing'); }

  og('og:type') ? pass(K7,og('og:type'),'og:type present.') : notice(K7,null,'og:type missing.');
  og('og:site_name') ? pass(K8,og('og:site_name'),'og:site_name present.') : notice(K8,null,'og:site_name missing.');
  tw('twitter:card') ? pass(K9,tw('twitter:card'),'twitter:card present.') : notice(K9,null,'twitter:card missing.');
  tw('twitter:title') ? pass(K10,tw('twitter:title').substring(0,40),'twitter:title present.') : notice(K10,null,'twitter:title missing.');
  tw('twitter:description') ? pass(K11,tw('twitter:description').substring(0,40),'twitter:description present.') : notice(K11,null,'twitter:description missing.');
  tw('twitter:image') ? pass(K12,tw('twitter:image'),'twitter:image present.') : notice(K12,null,'twitter:image missing.');

  return [K1,K2,K3,K4,K5,K6,K7,K8,K9,K10,K11,K12];
}

// ── L. Hreflang ───────────────────────────────────────────────────────────────

function checksL($) {
  const hreflangs = $('link[rel="alternate"][hreflang]');
  const L = (id,name) => makeResult(id,'Hreflang',name);
  const L1=L('L1','Hreflang tags detected'); const L2=L('L2','Language codes valid');
  const L3=L('L3','x-default tag present'); const L4=L('L4','Self-referencing hreflang');
  const L5=L('L5','Hreflang conflicts with canonical');

  if (hreflangs.length === 0) {
    info(L1,null,'No hreflang tags detected.'); [L2,L3,L4,L5].forEach(r=>skipped(r,'No hreflang tags'));
    return [L1,L2,L3,L4,L5];
  }

  info(L1,`${hreflangs.length} tags`,`${hreflangs.length} hreflang tag(s) found.`);
  const langPattern = /^[a-z]{2}(-[A-Z]{2})?$|^x-default$/;
  const invalid = [];
  hreflangs.each((_, el) => { if (!langPattern.test($(el).attr('hreflang')||'')) invalid.push($(el).attr('hreflang')); });
  invalid.length ? notice(L2,invalid.join(', '),`Invalid hreflang codes: ${invalid.join(', ')}.`) : pass(L2,null,'All hreflang codes are valid.');

  const hasXDefault = hreflangs.filter((_, el) => $(el).attr('hreflang') === 'x-default').length > 0;
  hasXDefault ? pass(L3,null,'x-default hreflang present.') : notice(L3,null,'No x-default hreflang tag.');
  info(L4,null,'Self-referencing hreflang — review manually.');
  const canonHref = $('link[rel="canonical"]').attr('href') || '';
  const conflict = canonHref && hreflangs.filter((_, el) => $(el).attr('href') !== canonHref && $(el).attr('hreflang') !== 'x-default').length > 0;
  conflict ? warn(L5,canonHref,'Hreflang URL may conflict with canonical.') : pass(L5,null,'No hreflang/canonical conflict detected.');

  return [L1,L2,L3,L4,L5];
}

// ── M. Technical HTML Foundation ──────────────────────────────────────────────

function checksM($, rawHtml, httpHeaders) {
  const M = (id,name) => makeResult(id,'Technical','Tech: '+name);
  const M1=M('M1','DOCTYPE declared'); const M2=M('M2','Character encoding declared');
  const M3=M('M3','HTML lang attribute present'); const M4=M('M4','HTML lang attribute is valid');
  const M5=M('M5','Viewport meta present'); const M6=M('M6','Viewport: width=device-width');
  const M7=M('M7','Viewport: initial-scale=1'); const M8=M('M8','Viewport: user-scalable not disabled');
  const M9=M('M9','No frames or iframes (non-content)'); const M10=M('M10','No incompatible plugins');
  const M11=M('M11','HTML file size acceptable'); const M12=M('M12','DOM element count acceptable');
  const M13=M('M13','No CSS in body'); const M14=M('M14','Inline CSS not excessive');
  const M15=M('M15','Inline JS not excessive'); const M16=M('M16','No render-blocking JS in head');
  const M17=M('M17','External CSS file count'); const M18=M('M18','External JS file count');
  const M19=M('M19','Render-blocking resource count'); const M20=M('M20','Resource hints present');
  const M21=M('M21','No mixed content'); const M22=M('M22','No meta refresh redirect');

  rawHtml.trimStart().toLowerCase().startsWith('<!doctype') ? pass(M1,null,'DOCTYPE declared.') : warn(M1,null,'DOCTYPE missing or not first line.');
  $('meta[charset]').length ? pass(M2,$('meta[charset]').attr('charset'),'Charset declared.') : warn(M2,null,'No charset meta tag found.');

  const htmlLang = $('html').attr('lang') || '';
  htmlLang ? pass(M3,htmlLang,'HTML lang attribute present.') : warn(M3,null,'HTML lang attribute missing.');
  const validLang = /^[a-z]{2}(-[A-Z]{2})?$/.test(htmlLang);
  validLang ? pass(M4,htmlLang,'HTML lang is valid BCP 47.') : warn(M4,htmlLang,`HTML lang "${htmlLang}" may not be valid BCP 47.`);

  const vp = $('meta[name="viewport"]');
  const vpContent = vp.attr('content') || '';
  vp.length ? pass(M5,vpContent,'Viewport meta present.') : fail(M5,'error',null,'Viewport meta tag missing.');
  vpContent.includes('width=device-width') ? pass(M6,vpContent,'width=device-width present.') : fail(M6,'error',vpContent,'Viewport missing width=device-width.');
  vpContent.includes('initial-scale=1') ? pass(M7,vpContent,'initial-scale=1 present.') : warn(M7,vpContent,'Viewport missing initial-scale=1.');
  vpContent.includes('user-scalable=no') ? warn(M8,vpContent,'user-scalable=no disables zoom (accessibility issue).') : pass(M8,null,'user-scalable not disabled.');

  const frames = $('frame, frameset').length;
  const nonContentIframes = $('iframe').filter((_, el) => !/youtube\.com|vimeo\.com|maps\.google|google\.com\/maps/i.test($(el).attr('src')||'')).length;
  frames + nonContentIframes > 0 ? warn(M9,`${frames} frames, ${nonContentIframes} iframes`,`${frames} frame(s) and ${nonContentIframes} non-content iframe(s) found.`) : pass(M9,null,'No frames or non-content iframes.');

  const oldPlugins = rawHtml.match(/\.swf|flash|silverlight|java applet/gi) || [];
  oldPlugins.length ? fail(M10,'error',oldPlugins[0],'Incompatible plugin references detected.') : pass(M10,null,'No incompatible plugins.');

  const sizeKB = Math.round(rawHtml.length / 1024);
  sizeKB > 100 ? warn(M11,`${sizeKB}KB`,`HTML is ${sizeKB}KB — over 100KB.`) : pass(M11,`${sizeKB}KB`,`HTML size: ${sizeKB}KB.`);

  const domCount = $('*').length;
  domCount > 1500 ? warn(M12,`${domCount}`,`DOM has ${domCount} elements — over 1,500.`) : pass(M12,`${domCount}`,`DOM element count: ${domCount}.`);

  $('body style').length ? notice(M13,null,'<style> tag found outside <head>.') : pass(M13,null,'No CSS in body.');
  const inlineCssLen = $('style').map((_, el) => $(el).html()?.length||0).get().reduce((a,b)=>a+b,0);
  inlineCssLen > 5000 ? notice(M14,`${inlineCssLen} chars`,`Inline CSS is ${inlineCssLen} characters.`) : pass(M14,`${inlineCssLen} chars`,`Inline CSS: ${inlineCssLen} chars.`);

  const inlineJsLen = $('script:not([src]):not([type="application/ld+json"])').map((_, el) => $(el).html()?.length||0).get().reduce((a,b)=>a+b,0);
  inlineJsLen > 10000 ? notice(M15,`${inlineJsLen} chars`,`Inline JS is ${inlineJsLen} characters.`) : pass(M15,`${inlineJsLen} chars`,`Inline JS: ${inlineJsLen} chars.`);

  const blockingJS = $('head script[src]').filter((_, el) => !$(el).attr('async') && !$(el).attr('defer')).length;
  blockingJS ? warn(M16,`${blockingJS}`,`${blockingJS} render-blocking <script> tag(s) in <head>.`) : pass(M16,null,'No render-blocking JS in head.');

  const cssList = $('link[rel="stylesheet"]').length;
  cssList > 6 ? notice(M17,`${cssList}`,`${cssList} external CSS files — consider consolidating.`) : pass(M17,`${cssList}`,`${cssList} external CSS files.`);

  const jsList = $('script[src]').length;
  jsList > 10 ? notice(M18,`${jsList}`,`${jsList} external JS files.`) : pass(M18,`${jsList}`,`${jsList} external JS files.`);

  const blockingCSS = $('head link[rel="stylesheet"]:not([media])').length;
  const totalBlocking = blockingJS + blockingCSS;
  totalBlocking > 0 ? warn(M19,`${totalBlocking}`,`${totalBlocking} render-blocking resource(s).`) : pass(M19,'0','No render-blocking resources.');

  const hints = $('link[rel="preconnect"], link[rel="preload"], link[rel="prefetch"], link[rel="dns-prefetch"]').length;
  hints > 0 ? pass(M20,`${hints}`,`${hints} resource hint(s) found.`) : notice(M20,'0','No resource hints (preconnect/preload/prefetch).');

  const mixedContent = $('img[src^="http://"], script[src^="http://"], link[href^="http://"]').length;
  mixedContent ? fail(M21,'error',`${mixedContent}`,`${mixedContent} mixed content reference(s) found.`) : pass(M21,null,'No mixed content detected.');

  $('meta[http-equiv="refresh"]').length ? warn(M22,null,'Meta refresh redirect present.') : pass(M22,null,'No meta refresh redirect.');

  return [M1,M2,M3,M4,M5,M6,M7,M8,M9,M10,M11,M12,M13,M14,M15,M16,M17,M18,M19,M20,M21,M22];
}

// ── N. URL Signals ────────────────────────────────────────────────────────────

function checksN(pageUrl) {
  const N = (id,name) => makeResult(id,'URL Signals',name);
  const checks = [N('N1','URL length'), N('N2','No underscores in slug'), N('N3','URL param count'),
    N('N4','No year string in URL'), N('N5','URL directory depth'), N('N6','No keyword stuffing in slug'),
    N('N7','URL slug is descriptive')];
  const [N1,N2,N3,N4,N5,N6,N7] = checks;

  if (!pageUrl) { checks.forEach(r => skipped(r,'URL not provided')); return checks; }

  let parsed;
  try { parsed = new URL(pageUrl); } catch { checks.forEach(r => skipped(r,'Invalid URL')); return checks; }

  const fullLen = pageUrl.length;
  fullLen > 115 ? warn(N1,`${fullLen} chars`,`URL is ${fullLen} characters (max 115).`) : pass(N1,`${fullLen} chars`,`URL length: ${fullLen} chars.`);

  const slug = parsed.pathname;
  slug.includes('_') ? notice(N2,slug,'URL slug contains underscores — use hyphens.') : pass(N2,slug,'No underscores in URL.');

  const paramCount = [...parsed.searchParams].length;
  paramCount > 2 ? warn(N3,`${paramCount}`,`${paramCount} URL parameters.`) : pass(N3,`${paramCount}`,`${paramCount} URL parameter(s).`);

  /\/20\d{2}[\/\-]/.test(slug) ? notice(N4,slug,'URL contains year pattern — can cause freshness issues.') : pass(N4,slug,'No year in URL slug.');

  const depth = slug.split('/').filter(Boolean).length;
  depth > 3 ? warn(N5,`${depth} levels`,`URL is ${depth} levels deep (max 3).`) : pass(N5,`${depth} levels`,`URL depth: ${depth}.`);

  const slugParts = slug.toLowerCase().split(/[\/-]/).filter(Boolean);
  const slugFreq = {};
  slugParts.map(stemWord).forEach(w => { slugFreq[w]=(slugFreq[w]||0)+1; });
  const stuffed = Object.entries(slugFreq).filter(([,c])=>c>=3);
  stuffed.length ? warn(N6,slug,'Keyword stuffing in URL slug.') : pass(N6,slug,'No URL slug stuffing.');

  /^\d+$/.test(slugParts[slugParts.length-1]||'') ? notice(N7,slug,'URL slug appears purely numeric.') : pass(N7,slug,'URL slug is descriptive.');

  return checks;
}

// ── O. Page Speed Signals ─────────────────────────────────────────────────────

function checksO($, rawHtml) {
  const O = (id,name) => makeResult(id,'Page Speed',name);
  const O1=O('O1','No render-blocking JS in head'); const O2=O('O2','No render-blocking CSS');
  const O3=O('O3','Image lazy loading'); const O4=O('O4','Image dimensions specified');
  const O5=O('O5','No large inline base64 images'); const O6=O('O6','Preconnect for third-party domains');
  const O7=O('O7','Preload for critical resources'); const O8=O('O8','HTML document size acceptable');

  const blockingJS = $('head script[src]').filter((_, el) => !$(el).attr('async') && !$(el).attr('defer')).length;
  blockingJS ? warn(O1,`${blockingJS}`,`${blockingJS} render-blocking script(s) in <head>.`) : pass(O1,null,'No render-blocking JS in head.');

  const blockingCSS = $('head link[rel="stylesheet"]:not([media])').length;
  blockingCSS ? warn(O2,`${blockingCSS}`,`${blockingCSS} potentially render-blocking CSS file(s).`) : pass(O2,null,'No render-blocking CSS.');

  const imgCount = $('img').length;
  const lazyCount = $('img[loading="lazy"]').length;
  imgCount > 3 && lazyCount === 0 ? warn(O3,'0 lazy',`${imgCount} images, none with loading="lazy".`) : pass(O3,`${lazyCount}/${imgCount}`,`${lazyCount}/${imgCount} images use lazy loading.`);

  const noDims = $('img').filter((_, el) => !$(el).attr('width') && !$(el).attr('height')).length;
  noDims ? warn(O4,`${noDims}`,`${noDims} image(s) missing dimensions.`) : pass(O4,null,'All images have dimensions.');

  const base64Imgs = $('img[src^="data:image"]').filter((_, el) => ($(el).attr('src')||'').length > 50000).length;
  base64Imgs ? warn(O5,`${base64Imgs}`,`${base64Imgs} large base64 image(s).`) : pass(O5,null,'No large base64 images.');

  const thirdPartyDomains = new Set();
  $('[src^="http"], [href^="http"]').each((_, el) => {
    const url = $(el).attr('src') || $(el).attr('href') || '';
    try { thirdPartyDomains.add(new URL(url).hostname); } catch {}
  });
  const preconnects = new Set();
  $('link[rel="preconnect"]').each((_, el) => {
    try { preconnects.add(new URL($(el).attr('href')||'').hostname); } catch {}
  });
  const missing = [...thirdPartyDomains].filter(d => !preconnects.has(d)).length;
  missing > 0 ? notice(O6,`${missing} domain(s)`,`${missing} third-party domain(s) without preconnect hint.`) : pass(O6,null,'Third-party domains have preconnect hints.');

  const firstMainImg = $('main img, article img').first().attr('src') || '';
  const hasPreload = $('link[rel="preload"][as="image"]').length > 0;
  firstMainImg && !hasPreload ? notice(O7,firstMainImg,'LCP candidate image lacks <link rel="preload">.') : pass(O7,null,'Preload hint for critical image found or not applicable.');

  const sizeKB = Math.round(rawHtml.length / 1024);
  sizeKB > 100 ? warn(O8,`${sizeKB}KB`,`HTML is ${sizeKB}KB — over 100KB.`) : pass(O8,`${sizeKB}KB`,`HTML size: ${sizeKB}KB.`);

  return [O1,O2,O3,O4,O5,O6,O7,O8];
}

// ── P. Semantic HTML ──────────────────────────────────────────────────────────

function checksP($) {
  const P = (id,name) => makeResult(id,'Semantic HTML',name);
  const P1=P('P1','<main> element present'); const P2=P('P2','<nav> element present');
  const P3=P('P3','<header> element present'); const P4=P('P4','<footer> element present');
  const P5=P('P5','<article> wraps editorial content'); const P6=P('P6','<section> used');
  const P7=P('P7','Semantic HTML ratio'); const P8=P('P8','Data tables use proper structure');
  const P9=P('P9','No layout tables'); const P10=P('P10','Lists use ul/ol properly');
  const P11=P('P11','<figure> + <figcaption> used');

  $('main').length ? pass(P1,null,'<main> element present.') : warn(P1,null,'No <main> element — important for accessibility and SEO.');
  $('nav').length ? pass(P2,null,'<nav> element present.') : notice(P2,null,'No <nav> element found.');
  $('header').length ? pass(P3,null,'<header> element present.') : notice(P3,null,'No <header> element found.');
  $('footer').length ? pass(P4,null,'<footer> element present.') : notice(P4,null,'No <footer> element found.');
  $('article').length ? pass(P5,null,'<article> element present.') : notice(P5,null,'No <article> element — consider wrapping editorial content.');
  $('section').length ? info(P6,`${$('section').length}`,`${$('section').length} <section> element(s).`) : info(P6,'0','No <section> elements.');

  const semanticCount = $('main, nav, header, footer, article, section, aside, figure').length;
  const divSpanCount = $('div, span').length;
  const ratio = divSpanCount > 0 ? semanticCount / divSpanCount : 1;
  ratio < 0.1 ? warn(P7,ratio.toFixed(3),`Semantic ratio is ${ratio.toFixed(3)} — heavy use of div/span.`) : pass(P7,ratio.toFixed(3),`Semantic HTML ratio: ${ratio.toFixed(3)}.`);

  const badTables = $('table').filter((_, el) => $(el).find('th').length === 0).length;
  badTables ? warn(P8,`${badTables}`,`${badTables} table(s) without <th> headers.`) : pass(P8,null,'All tables use <th> headers.');

  $('table').filter((_, el) => $(el).find('th').length === 0 && $(el).find('td').length > 2).length
    ? warn(P9,null,'Possible layout table(s) detected.')
    : pass(P9,null,'No layout tables detected.');

  info(P10,null,'Faux list check — review manually if needed.');
  const figcaptions = $('figure figcaption').length;
  info(P11,`${figcaptions}`,`${figcaptions} figure/figcaption pairs.`);

  return [P1,P2,P3,P4,P5,P6,P7,P8,P9,P10,P11];
}

// ── Q. Accessibility ──────────────────────────────────────────────────────────

function checksQ($) {
  const Q = (id,name) => makeResult(id,'Accessibility',name);
  const Q1=Q('Q1','All images have alt text'); const Q2=Q('Q2','Form inputs have labels');
  const Q3=Q('Q3','Buttons have accessible text'); const Q4=Q('Q4','Anchor tags not empty');
  const Q5=Q('Q5','iframes have title attribute'); const Q6=Q('Q6','Videos have captions');
  const Q7=Q('Q7','ARIA roles usage'); const Q8=Q('Q8','Skip navigation link');
  const Q9=Q('Q9','Language attribute set');

  const missingAlt = $('img').filter((_, el) => $(el).attr('alt') === undefined).length;
  missingAlt ? fail(Q1,'error',`${missingAlt}`,`${missingAlt} image(s) missing alt text.`) : pass(Q1,null,'All images have alt text.');

  const unlabelledInputs = $('input:not([type="hidden"]):not([type="submit"]):not([type="button"])').filter((_, el) => {
    const id = $(el).attr('id');
    return !$(el).attr('aria-label') && (!id || $(`label[for="${id}"]`).length === 0);
  }).length;
  unlabelledInputs ? warn(Q2,`${unlabelledInputs}`,`${unlabelledInputs} input(s) without labels.`) : pass(Q2,null,'All form inputs have labels.');

  const emptyButtons = $('button').filter((_, el) => !$(el).text().trim() && !$(el).attr('aria-label') && !$(el).find('img[alt]').length).length;
  emptyButtons ? warn(Q3,`${emptyButtons}`,`${emptyButtons} button(s) without accessible text.`) : pass(Q3,null,'All buttons have accessible text.');

  const emptyAnchors = $('a[href]').filter((_, el) => !$(el).text().trim() && !$(el).find('img[alt]').length).length;
  emptyAnchors ? warn(Q4,`${emptyAnchors}`,`${emptyAnchors} anchor tag(s) without text.`) : pass(Q4,null,'No empty anchors.');

  const iframesNoTitle = $('iframe').filter((_, el) => !$(el).attr('title')).length;
  iframesNoTitle ? warn(Q5,`${iframesNoTitle}`,`${iframesNoTitle} iframe(s) without title attribute.`) : pass(Q5,null,'All iframes have title attributes.');

  const videosNoCaptions = $('video').filter((_, el) => $(el).find('track[kind="captions"]').length === 0).length;
  videosNoCaptions ? warn(Q6,`${videosNoCaptions}`,`${videosNoCaptions} video(s) without captions track.`) : pass(Q6,null,'All videos have captions.');

  const ariaCount = $('[aria-role], [aria-label], [aria-describedby], [role]').length;
  info(Q7,`${ariaCount}`,`${ariaCount} ARIA attribute(s) found.`);

  $('a[href="#main"], a[href="#content"], a[href="#maincontent"]').first().length
    ? pass(Q8,null,'Skip navigation link found.')
    : notice(Q8,null,'No skip navigation link found.');

  const htmlLang = $('html').attr('lang') || '';
  htmlLang ? pass(Q9,htmlLang,'HTML lang attribute set.') : fail(Q9,'error',null,'HTML lang attribute missing.');

  return [Q1,Q2,Q3,Q4,Q5,Q6,Q7,Q8,Q9];
}

// ── R. E-E-A-T Signals ────────────────────────────────────────────────────────

function checksR($, rawHtml, intent = 'informational', pageContext = {}) {
  const isCommercial = intent === 'commercial';
  const isYMYL = !!pageContext.isYMYL;
  const pageType = pageContext.pageType || 'page';
  const practitioners = pageContext.namedPractitioners || [];

  const R = (id,name) => makeResult(id,'E-E-A-T',name);
  const R1=R('R1','Named author byline'); const R2=R('R2','Author bio page linked');
  const R3=R('R3','Author credentials visible'); const R4=R('R4','Publication date visible');
  const R5=R('R5','Last updated date visible'); const R6=R('R6','Professional license mentioned');
  const R7=R('R7','External links to regulatory sources'); const R8=R('R8','About page linked');
  const R9=R('R9','Contact information present'); const R10=R('R10','Privacy policy linked');
  const R11=R('R11','Editorial or review policy linked');
  const R12=R('R12','Named practitioners present');

  // The byline axis. On a location/product/pricing page there is no article to attribute, and the
  // real E-E-A-T signal is the named-practitioner roster (R12).
  if (isCommercial) {
    na(R1, `an author byline is not the E-E-A-T signal for a ${pageType} page; a named practitioner roster is (see R12).`);
    na(R2, `author bio pages do not apply to a ${pageType} page.`);
    na(R4, 'publication date is an editorial-freshness signal; commercial freshness is covered by T4.');
    na(R7, 'commercial intent: outbound regulatory citations are not a ranking signal for this page type.');
    na(R11, 'a transactional page has no editorial or review policy.');
  } else {
    const hasAuthor = /rel=["']author["']|class=["'][^"']*author[^"']*["']|written\s+by|by\s+[A-Z][a-z]+\s+[A-Z][a-z]+/i.test(rawHtml);
    hasAuthor ? pass(R1,null,'Author byline detected.') : warn(R1,null,'No author byline (E-E-A-T signal missing).');

    const authorLink = $('[rel="author"] a, [class*="author"] a').first().attr('href') || '';
    authorLink && (authorLink.includes('/author/') || authorLink.includes('/about/'))
      ? pass(R2,authorLink,'Author links to bio page.') : warn(R2,null,'Author does not link to bio page.');

    /\b(20\d{2})\b/.test(rawHtml) ? pass(R4,null,'Date found on page.') : notice(R4,null,'No publication date detected.');

    const regLinks = $('a[href]').filter((_, el) => AUTHORITATIVE_DOMAINS.some(d => ($(el).attr('href')||'').includes(d))).length;
    regLinks > 0 ? pass(R7,`${regLinks}`,`${regLinks} regulatory/authoritative outbound link(s).`) : notice(R7,'0','No links to regulatory or authoritative sources.');

    /editorial policy|review policy|fact.?check/i.test(rawHtml)
      ? pass(R11,null,'Editorial/review policy found.') : notice(R11,null,'No editorial or review policy link.');
  }

  // Credentials remain a real signal on a YMYL commercial page — a named DDS on a dental location page
  // is exactly the trust signal that matters. Post-nominals only; bare "Director" used to pass this.
  if (isCommercial && !isYMYL) {
    na(R3, 'non-YMYL commercial page: professional credentials are not an expected signal.');
  } else {
    CREDENTIAL_PATTERN.test(rawHtml)
      ? pass(R3,null,'Professional credentials (post-nominals) detected.')
      : notice(R3,null,'No post-nominal credentials (DDS, DMD, MD, PhD…) found. Degrees stated in prose are not machine-readable.');
  }

  // Positive evidence, so the report cannot claim named experts are absent on a page that lists them.
  if (practitioners.length) {
    pass(R12, practitioners.slice(0, 4).map(p => `${p.name}${p.jobTitle ? ` (${p.jobTitle})` : ''}`).join('; '),
      `${practitioners.length} named practitioner(s) published in Person schema.`);
  } else if (isCommercial && isYMYL) {
    warn(R12, '0', 'No named practitioners in Person schema. For a YMYL commercial page, name the treating practitioner(s) with credentials.');
  } else {
    na(R12, 'named practitioners are not an expected signal for this page.');
  }

  // R5/R6 stay intent-neutral: "hours updated Jan 2026" and a license reference are both meaningful
  // on a location page, and R6 is directly YMYL-relevant.
  /last\s+updated|updated\s+on|last\s+modified/i.test(rawHtml)
    ? pass(R5,null,'"Last updated" signal found.') : notice(R5,null,'No "last updated" date found.');
  /license\s+#|license\s+number|board\s+certified/i.test(rawHtml)
    ? pass(R6,null,'Professional license mentioned.') : notice(R6,null,'No professional license reference found (relevant for YMYL).');

  $('a[href*="/about"]').length ? pass(R8,null,'About page linked.') : notice(R8,null,'No About page link found.');

  const hasPhone = /\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/.test(rawHtml);
  const hasEmail = $('a[href^="mailto:"]').length > 0 || $('a[href^="tel:"]').length > 0;
  hasPhone || hasEmail ? pass(R9,null,'Contact information found.') : warn(R9,null,'No contact information detected.');

  $('a[href*="privacy"]').length || /privacy policy/i.test(rawHtml)
    ? pass(R10,null,'Privacy policy linked.') : notice(R10,null,'No privacy policy link found.');

  return [R1,R2,R3,R4,R5,R6,R7,R8,R9,R10,R11,R12];
}

// ── S. Security Signals ───────────────────────────────────────────────────────

function checksS($, rawHtml) {
  const S = (id,name) => makeResult(id,'Security',name);
  const S1=S('S1','No mixed content'); const S2=S('S2','No frames loading external HTTP');
  const S3=S('S3','No unrecognized third-party scripts'); const S4=S('S4','No hidden content blocks');
  const S5=S('S5','No obfuscated links'); const S6=S('S6','HTML comments: no sensitive data');

  const mixedContent = $('img[src^="http://"], script[src^="http://"], link[href^="http://"]').length;
  mixedContent ? fail(S1,'error',`${mixedContent}`,`${mixedContent} mixed content reference(s).`) : pass(S1,null,'No mixed content.');

  const httpIframes = $('iframe[src^="http://"]').length;
  httpIframes ? warn(S2,`${httpIframes}`,`${httpIframes} iframe(s) loading external HTTP content.`) : pass(S2,null,'No external HTTP iframes.');

  const knownCDNs = /googletagmanager|google-analytics|googlefonts|googleapis|jquery|cloudflare|jsdelivr|unpkg|bootstrapcdn|cdnjs|fontawesome/i;
  const unknownScripts = $('script[src]').filter((_, el) => {
    const src = $(el).attr('src')||'';
    return src.startsWith('http') && !knownCDNs.test(src);
  }).length;
  unknownScripts > 0 ? notice(S3,`${unknownScripts}`,`${unknownScripts} unrecognized third-party script(s).`) : pass(S3,null,'All scripts from known CDNs/sources.');

  const hiddenBlocks = $('[style]').filter((_, el) => {
    const s = ($(el).attr('style')||'').replace(/\s/g,'').toLowerCase();
    return (s.includes('display:none') || s.includes('visibility:hidden')) && wordCount($(el).text()) > 20;
  }).length;
  hiddenBlocks ? fail(S4,'error',`${hiddenBlocks}`,`${hiddenBlocks} hidden text block(s) with >20 words.`) : pass(S4,null,'No hidden text blocks.');

  const obfLinks = $('a[href]').filter((_, el) => {
    const href = $(el).attr('href')||'';
    return /[?&](ref|aff|affiliate|redirect)=|\/go\/|\/out\//i.test(href) || /^data:/i.test(href);
  }).length;
  obfLinks ? warn(S5,`${obfLinks}`,`${obfLinks} potentially obfuscated/affiliate link(s).`) : pass(S5,null,'No obfuscated links detected.');

  const comments = [];
  const commentRegex = /<!--([\s\S]*?)-->/g;
  let m;
  const sensitivePatterns = /api[_-]?key|password|secret|token|admin|todo|internal|email.*@/i;
  while ((m = commentRegex.exec(rawHtml)) !== null) {
    if (sensitivePatterns.test(m[1])) comments.push(m[1].substring(0,40));
  }
  comments.length ? notice(S6,`${comments.length} comment(s)`,`${comments.length} HTML comment(s) may contain sensitive data.`) : pass(S6,null,'No sensitive data in HTML comments.');

  return [S1,S2,S3,S4,S5,S6];
}

// ── T. GEO-Specific Signals ───────────────────────────────────────────────────

function checksT($, rawHtml, geoData, intent = 'informational', parsedSchemas = [], lbFacts = {}, detectedElements = {}) {
  const isCommercial = intent === 'commercial';
  const T = (id,name) => makeResult(id,'GEO Signals',name);
  const T1=T('T1','JavaScript-content ratio'); const T2=T('T2','Content is Q&A structured');
  const T3=T('T3','GEO answerability score'); const T4=T('T4','Freshness signal (dateModified)');
  const T5=T('T5','VideoObject schema on video page'); const T6=T('T6','Video transcript on page');
  const T7=T('T7','llms.txt referenced'); const T8=T('T8','Content word count in GEO sweet spot');
  const T9=T('T9','Page targets single focused topic'); const T10=T('T10','sameAs entity linking ≥3');
  // Commercial-intent GEO checks. These are the signals an answer engine actually extracts from a
  // transactional page, and they replace the citation/statistics axis that does not apply here.
  const T11=T('T11','NAP machine-readable in schema'); const T12=T('T12','Opening hours complete & valid');
  const T13=T('T13','Review / AggregateRating markup'); const T14=T('T14','Service area / offer clarity');

  const visText = visibleText(cheerio.load(rawHtml));
  const jsRatio = rawHtml.length > 0 ? (visText.length / rawHtml.length * 100) : 0;
  jsRatio < 15 ? warn(T1,`${jsRatio.toFixed(1)}%`,`Visible text is ${jsRatio.toFixed(1)}% of HTML — page may be JS-rendered (GEO crawl risk).`) : pass(T1,`${jsRatio.toFixed(1)}%`,`Text-to-HTML ratio: ${jsRatio.toFixed(1)}%.`);

  const qCount = $('h2,h3').filter((_, el) => $(el).text().trim().endsWith('?')).length;
  const faqEl = $('[class*="faq"],[id*="faq"]').length;
  const t2Score = qCount + faqEl;
  // Local/commercial queries are question-shaped ("is X open Saturday", "does X take Medicare"), so
  // an absent Q&A structure is a real defect there, not a nice-to-have.
  t2Score > 0
    ? pass(T2,`${t2Score} signals`,`${qCount} question headings + ${faqEl} FAQ blocks.`)
    : (isCommercial ? warn(T2,'0','No Q&A structure — the highest-leverage GEO gap for a commercial page.')
                    : notice(T2,'0','No Q&A structure detected.'));

  const ansScore = (geoData && (geoData.answerability_score ?? geoData.csqaf_score)) || 0;
  const rubric = (geoData && geoData.answerability_rubric) || 'CSQAF';
  ansScore < 4 ? warn(T3,`${ansScore}/10`,`${rubric} answerability ${ansScore}/10 — below threshold (GEO not ready).`) :
  ansScore >= 7 ? pass(T3,`${ansScore}/10`,`${rubric} answerability ${ansScore}/10 — GEO ready.`) :
  notice(T3,`${ansScore}/10`,`${rubric} answerability ${ansScore}/10 — GEO needs work.`);

  // Freshness: look beyond Article schema. The old check only inspected Article/BlogPosting/NewsArticle
  // `@type`, so EVERY non-article page took a hard warning at 15% of the GEO weight for the crime of
  // not being an article.
  const articleSchema = parsedSchemas.find(s => ['Article','BlogPosting','NewsArticle'].some(t => hasType(s, t)));
  const anyDateModified = (articleSchema && articleSchema.dateModified)
    || (parsedSchemas.find(s => s.dateModified) || {}).dateModified
    || $('meta[property="article:modified_time"]').attr('content')
    || $('time[datetime]').first().attr('datetime')
    || null;
  if (anyDateModified) {
    const daysOld = (Date.now() - new Date(anyDateModified).getTime()) / 86400000;
    Number.isFinite(daysOld) && daysOld < 365
      ? pass(T4, anyDateModified, `Freshness signal is ${Math.round(daysOld)} days old.`)
      : warn(T4, anyDateModified, `Freshness signal is ${Math.round(daysOld)} days old — over 365 days.`);
  } else if (isCommercial) {
    notice(T4, null, 'No dateModified/modified_time found. Weak but real for a commercial page (hours and insurance change) — add dateModified to the business schema.');
  } else {
    warn(T4, null, 'No dateModified in schema (GEO freshness signal missing).');
  }

  const hasVideoEmbed = $('iframe[src*="youtube.com"], iframe[src*="vimeo.com"]').length > 0;
  const hasVideoSchema = parsedSchemas.some(s => hasType(s, 'VideoObject'));
  if (hasVideoEmbed && !hasVideoSchema) warn(T5,null,'Video embed found without VideoObject schema.');
  else if (hasVideoSchema) pass(T5,null,'VideoObject schema present.');
  else na(T5,'no video content on this page.');

  if (!hasVideoEmbed) {
    na(T6, 'no video embed on this page, so there is nothing to transcribe.');
  } else {
    const videoText = $('div,section').filter((_, el) => {
      const text = $(el).text().trim();
      return text.length > 500 && $(el).prev('iframe').length > 0;
    }).length;
    videoText ? pass(T6,null,'Video transcript text block detected.') : notice(T6,null,'No video transcript detected near video embed.');
  }

  // CHANGE 9 — §1.10: T7 llms.txt absence is notice not pass
  const hasLlms = $('a[href*="llms.txt"]').length > 0 || /llms\.txt/i.test(rawHtml);
  hasLlms
    ? pass(T7, null, 'llms.txt referenced in page HTML.')
    : notice(T7, null, 'llms.txt not referenced. Adding /llms.txt is a low-effort GEO signal for AI engine prioritization.');

  // Intent-specific band. 350-1200 is healthy for a location/service page; the 800-1500 editorial band
  // told concise commercial pages they were under-length. Notice threshold stays at 3000 so this and
  // F24 can never disagree.
  const wc = wordCount(visText);
  const tLo = isCommercial ? 350 : 800;
  const tHi = isCommercial ? 1200 : 1500;
  const tFloor = isCommercial ? 150 : 300;
  wc >= tLo && wc <= tHi ? pass(T8,`${wc}`,`Word count ${wc} is in the ${intent} GEO sweet spot (${tLo}–${tHi}).`) :
  wc < tFloor ? fail(T8,'error',`${wc}`,`Under ${tFloor} words — too thin for GEO.`) :
  wc > 3000 ? notice(T8,`${wc}`,`${wc} words — over 3,000 is a GEO grounding budget risk.`) :
  info(T8,`${wc}`,`Word count: ${wc} (${intent} sweet spot ${tLo}–${tHi}).`);

  // Not a check — a manual-review placeholder. It used to be an unconditional pass worth 10% of the
  // GEO score.
  info(T9,null,'Topic focus — review H1/H2 alignment manually. Not scored.');

  const sameAsCount = (lbFacts.sameAsUrls || []).length;
  sameAsCount >= 3 ? pass(T10,`${sameAsCount}`,`sameAs has ${sameAsCount} profiles (≥3 required).`) : warn(T10,`${sameAsCount}`,`sameAs has only ${sameAsCount} profile(s) — add ≥3 authoritative profiles.`);

  // ── T11-T14: commercial-intent GEO signals ────────────────────────────────
  if (!isCommercial) {
    na(T11, 'commercial-intent check.'); na(T12, 'commercial-intent check.');
    na(T13, 'commercial-intent check.'); na(T14, 'commercial-intent check.');
  } else if (!lbFacts.hasLocalSignals) {
    // A SaaS landing page or pricing page has no reason to publish local facts.
    const why = 'this commercial page publishes no local-business signals (no address, phone, hours or LocalBusiness schema).';
    na(T11, why); na(T12, why); na(T14, why);
    lbFacts.aggregateRating || (lbFacts.reviewNodes || []).length
      ? pass(T13, 'markup present', 'Review or AggregateRating markup present.')
      : notice(T13, null, 'No review markup. Add AggregateRating/Review for any review content on the page.');
  } else {
    if (lbFacts.hasTelephone && lbFacts.addrComplete) {
      pass(T11, `${lbFacts.lbType}`, `NAP is machine-readable: telephone plus a complete address on the ${lbFacts.lbType} node.`);
    } else if (lbFacts.hasAddress) {
      warn(T11, `${lbFacts.lbType || 'LocalBusiness'}`, `Partial NAP: ${lbFacts.hasTelephone ? '' : 'telephone missing; '}${lbFacts.addrComplete ? '' : 'address is incomplete (needs streetAddress, addressLocality, addressRegion, postalCode)'}.`);
    } else {
      fail(T11, 'error', lbFacts.lbType || null, 'No machine-readable address. Address and phone are the facts an AI answer engine extracts first from a location page.');
    }

    if (lbFacts.ohsValid) {
      pass(T12, 'valid', 'openingHoursSpecification is present and valid.');
    } else if (lbFacts.ohsPresent) {
      fail(T12, 'error', `${lbFacts.ohsErrors.length} error(s)`, `openingHoursSpecification is present but invalid: ${lbFacts.ohsErrors.slice(0, 3).map(e => e.error).join(' ')}`);
    } else {
      warn(T12, null, 'No openingHoursSpecification. Hours are among the most-requested facts for a local business.');
    }

    const ar = lbFacts.aggregateRating || {};
    if (ar.ratingValue && ar.reviewCount) {
      pass(T13, `${ar.ratingValue} (${ar.reviewCount})`, 'AggregateRating carries both ratingValue and reviewCount.');
    } else if (lbFacts.aggregateRating || (lbFacts.reviewNodes || []).length) {
      notice(T13, `${(lbFacts.reviewNodes || []).length} Review node(s)`, 'Partial review markup — add AggregateRating with ratingValue and reviewCount.');
    } else if (detectedElements.hasReviewText || detectedElements.hasStarRating) {
      warn(T13, 'visible reviews, no markup', 'The page shows review/rating content but publishes no AggregateRating or Review markup — the rating is invisible to search and AI engines.');
    } else {
      notice(T13, null, 'No review content or markup found.');
    }

    lbFacts.hasAreaServed
      ? pass(T14, 'declared', 'Service area / offer catalogue is declared in schema.')
      : notice(T14, null, 'No areaServed or offer catalogue in schema — state the service area explicitly.');
  }

  return [T1,T2,T3,T4,T5,T6,T7,T8,T9,T10,T11,T12,T13,T14];
}

// ── U. Miscellaneous ──────────────────────────────────────────────────────────

function checksU($, rawHtml) {
  const U = (id,name) => makeResult(id,'Miscellaneous',name);
  const U1=U('U1','Favicon declared'); const U2=U('U2','RSS/Atom feed linked');
  const U3=U('U3','Breadcrumb visible in HTML'); const U4=U('U4','HTML comments: sensitive data');
  const U5=U('U5','Excessive affiliate links'); const U6=U('U6','Total link count');
  const U7=U('U7','Encoding declared'); const U8=U('U8','llms.txt referenced');

  $('link[rel="icon"], link[rel="shortcut icon"]').length ? pass(U1,null,'Favicon declared.') : notice(U1,null,'No favicon link found in <head>.');
  $('link[rel="alternate"][type="application/rss+xml"]').length ? info(U2,null,'RSS/Atom feed linked.') : info(U2,null,'No RSS/Atom feed linked.');
  $('[class*="breadcrumb"], nav[aria-label*="breadcrumb"], [id*="breadcrumb"]').length ? pass(U3,null,'Breadcrumb element detected.') : notice(U3,null,'No breadcrumb detected.');

  const sensitiveComments = [];
  const cr = /<!--([\s\S]*?)-->/g; let cm;
  while ((cm = cr.exec(rawHtml)) !== null) {
    if (/api[_-]?key|password|secret|token|admin|todo|email.*@/i.test(cm[1])) sensitiveComments.push(cm[1].substring(0,30));
  }
  sensitiveComments.length ? notice(U4,`${sensitiveComments.length}`,`${sensitiveComments.length} HTML comment(s) may contain sensitive data.`) : pass(U4,null,'No sensitive HTML comments.');

  const affiliateLinks = $('a[href]').filter((_, el) => /[?&](ref|aff|affiliate)=|shareasale|clickbank|cj\.com/i.test($(el).attr('href')||'')).length;
  affiliateLinks > 10 ? warn(U5,`${affiliateLinks}`,`${affiliateLinks} affiliate link(s) — over 10 may look spammy.`) : info(U5,`${affiliateLinks}`,`${affiliateLinks} affiliate link(s).`);

  const totalLinks = $('a[href]').length;
  totalLinks > 100 ? warn(U6,`${totalLinks}`,`${totalLinks} total links — over 100.`) : info(U6,`${totalLinks}`,`${totalLinks} total links.`);

  $('meta[charset]').length ? pass(U7,$('meta[charset]').attr('charset'),'Encoding declared.') : warn(U7,null,'No charset declaration.');

  // CHANGE 9 — §1.10: U8 llms.txt absence is notice not pass
  /llms\.txt/i.test(rawHtml)
    ? pass(U8, null, 'llms.txt referenced.')
    : notice(U8, null, 'llms.txt not referenced on page.');

  return [U1,U2,U3,U4,U5,U6,U7,U8];
}

// ── Scoring model ─────────────────────────────────────────────────────────────
// The headline `overall` is a weighted mean of the bar values the user is shown, and nothing else.
// It replaces a formula that divided a POINTS total by a CHECK COUNT and multiplied by 100 —
// mathematically incoherent, and computed over a different check population than the bars, which is
// why a page could show 47 overall beside bars of 78-100. If you change a weight or a tier here, the
// bars and the headline move together. Do not add a second formula.

// Importance tier: how much a check matters. Orthogonal to status, which says how bad the finding is.
const TIER_3_CHECKS = new Set([ // failure de-indexes, breaks rendering, or removes a primary surface
  'A1','A2','A9','C1','C3','C10','D2','D3','E1','E3','F2','F5','F25','G9','J3','J5','J15','J19',
  'M5','M6','M10','M21','Q9','S1','S4','T1','T3','T8','KW1','KW2',
]);
const TIER_1_CHECKS = new Set([ // advisory / nice-to-have
  'A6','A8','B5','C4','C5','C6','D5','D7','F4','F18','F20','F24','G3','G8','G12','H8','J14','J25',
  'J26','K7','K8','K9','K10','K11','K12','L2','L3','L5','M13','M14','M17','M18','M20','N2','N4',
  'N7','O6','O7','R6','R11','S3','S6','T5','T6','T7','T14','U1','U4','U5','KW7','KW9','KW12',
  'KW2_1','KW2_2',
]);
// Intent shifts emphasis rather than introducing a second weighting scheme.
const TIER_OVERRIDES = {
  commercial:    { T2: 3, T4: 1, T10: 3, T11: 3, T12: 3, T13: 2, R12: 3, J23: 3 },
  informational: { T4: 3, T2: 2 },
};
function checkTier(id, intent) {
  const o = TIER_OVERRIDES[intent] && TIER_OVERRIDES[intent][id];
  if (o) return o;
  return TIER_3_CHECKS.has(id) ? 3 : TIER_1_CHECKS.has(id) ? 1 : 2;
}

// status (+ severity) -> points. `notice` scoring above `warning` is deliberate and matches how the
// helpers are used in this file: notice() marks an absent nice-to-have, warn() marks a real defect —
// the syslog/W3C convention where NOTICE is milder than WARNING.
function checkPoints(c) {
  if (UNSCORED_STATUSES.has(c.status)) return null;
  if (c.status === 'pass') return 100;
  if (c.status === 'notice') return 85;
  if (c.status === 'warning') return 50;
  // A warning-severity fail is usually a cascade dependent of one real defect (no <title> fails A1+A2
  // at error AND A3+A4 at warning). Charging all four as maximal zeros quadruple-counts one problem.
  if (c.status === 'fail') return c.severity === 'error' ? 0 : 25;
  return null;
}

// Every scoring category lands in exactly one bar. Previously 11 of 22 categories — 41% of all
// checks, including every keyword check — fed the headline while appearing in no bar at all.
const SCORE_BUCKETS = [
  { key:'title_meta',        label:'Title & Meta',            weight:0.14, categories:['Title Tag','Meta Description','Open Graph'] },
  { key:'content_structure', label:'Content & Structure',     weight:0.20, categories:['Headings','Content Quality','Semantic HTML'] },
  { key:'indexability',      label:'Indexability',            weight:0.14, categories:['Meta Robots','Canonical','Hreflang'] },
  { key:'schema',            label:'Schema',                  weight:0.13, categories:['Schema'] },
  { key:'geo_signals',       label:'GEO Signals',             weight:0.13, categories:['GEO Signals'] },
  { key:'eeat',              label:'E-E-A-T',                 weight:0.10, categories:['E-E-A-T'] },
  { key:'technical',         label:'Technical & Performance', weight:0.09, categories:['Technical','URL Signals','Page Speed','Security','Miscellaneous'] },
  { key:'links_media',       label:'Links & Media',           weight:0.07, categories:['Images','Internal Links','External Links','Accessibility'] },
  { key:'keyword',           label:'Keyword Targeting',       weight:0.12, categories:['Keyword Analysis'] },
];
const CATEGORY_TO_BUCKET = SCORE_BUCKETS.reduce((m, b) => { for (const c of b.categories) m[c] = b.key; return m; }, {});

// A weighted mean over a defect detector cannot go low on its own: a noindex page still averages ~85.
// Grouped so one defect firing several checks caps once.
const BLOCKER_GROUPS = [
  { id:'noindex',            cap:25, ids:['C1','C3'], reason:'Page carries a noindex directive — it cannot rank or be cited.' },
  { id:'meta_refresh',       cap:40, ids:['C10'],     reason:'Meta refresh with delay=0 acts as a hard redirect.' },
  { id:'thin_content',       cap:50, ids:['F2'],      reason:'Content is critically thin — too little to rank or to ground an AI answer.' },
  { id:'no_title',           cap:60, ids:['A1','A2'], reason:'No usable title element — the primary ranking and snippet surface is absent.' },
  { id:'no_h1',              cap:65, ids:['E1','E3'], reason:'No usable H1.' },
  { id:'no_viewport',        cap:65, ids:['M5','M6'], reason:'No mobile viewport — fails mobile-first indexing.' },
  { id:'canonical_conflict', cap:70, ids:['D2'],      reason:'Multiple canonical tags — Google will ignore all of them.' },
  { id:'invalid_jsonld',     cap:75, ids:['J3'],      reason:'JSON-LD fails to parse — no structured data reaches Google or LLMs.' },
];

const SCORE_BANDS = [
  { min:90, label:'Excellent',  blurb:'No blocking issues. What remains is refinement.' },
  { min:75, label:'Good',       blurb:'Technically sound, with a few real gaps worth fixing.' },
  { min:60, label:'Needs work', blurb:'Several real defects are limiting search and AI visibility.' },
  { min:40, label:'Poor',       blurb:'Significant defects across multiple areas.' },
  { min:0,  label:'Critical',   blurb:'Blocking problems — fix these before anything else.' },
];

function calculateScores(checks, intent = 'informational') {
  const all = Array.isArray(checks) ? checks : [];
  const evaluated = all.filter(isScored);

  // Disjoint counts. `warnings` used to include every `fail`, so an error was charged twice and the
  // four meta-bar chips summed to more than the number of checks actually evaluated.
  const isError = c => c.status === 'fail' && c.severity === 'error';
  const isWarning = c => c.status === 'warning' || (c.status === 'fail' && c.severity !== 'error');
  const counts = {
    errors: evaluated.filter(isError).length,
    warnings: evaluated.filter(isWarning).length,
    notices: evaluated.filter(c => c.status === 'notice').length,
    passed: evaluated.filter(c => c.status === 'pass').length,
    failed: evaluated.filter(c => c.status === 'fail').length,
    evaluated: evaluated.length,
    informational: all.filter(c => c.status === 'informational').length,
    na: all.filter(c => c.status === 'na').length,
    skipped: all.filter(c => c.status === 'skipped').length,
    total: all.length,
  };
  counts.issues = counts.errors + counts.warnings;
  counts.scored = counts.evaluated;

  const breakdown = [];
  const flat = {};
  for (const b of SCORE_BUCKETS) {
    const relevant = all.filter(c => b.categories.includes(c.category) && checkPoints(c) !== null);
    if (relevant.length === 0) { flat[b.key] = null; continue; } // dropped entirely, never a free 100
    let num = 0, den = 0;
    const st = { pass:0, notice:0, warning:0, failed:0, errors:0 };
    for (const c of relevant) {
      const t = checkTier(c.id, intent);
      num += t * checkPoints(c);
      den += t * 100;
      if (c.status === 'pass') st.pass++;
      else if (c.status === 'notice') st.notice++;
      else if (c.status === 'warning') st.warning++;
      else { st.failed++; if (c.severity === 'error') st.errors++; }
    }
    const score = Math.max(0, Math.min(100, Math.round((num / den) * 100)));
    flat[b.key] = score;
    // `categories` ships so the client can resolve a bar back to the exact checks that
    // scored it (for the click-through detail panel) without duplicating SCORE_BUCKETS
    // client-side, which would silently drift the moment a category is added here.
    breakdown.push({ key:b.key, label:b.label, score, weight:b.weight, categories:[...b.categories], checks_scored:relevant.length, statuses:st });
  }
  for (const b of SCORE_BUCKETS) if (!(b.key in flat)) flat[b.key] = null;

  // A category with no bucket would silently vanish from the headline — warn loudly instead.
  const unmapped = [...new Set(evaluated.filter(c => !CATEGORY_TO_BUCKET[c.category]).map(c => c.category))];
  if (unmapped.length) console.warn('[seoGeoChecks] categories missing from SCORE_BUCKETS:', unmapped.join(', '));

  // Composite over the buckets that actually have checks, using the ROUNDED bar values so a user can
  // reproduce the headline with a calculator.
  const weightTotal = breakdown.reduce((s, b) => s + b.weight, 0);
  const weightedSum = breakdown.reduce((s, b) => s + b.weight * b.score, 0);
  const composite = weightTotal > 0 ? Math.round(weightedSum / weightTotal) : null;

  for (const b of breakdown) {
    b.effective_weight = weightTotal > 0 ? Math.round((b.weight / weightTotal) * 1000) / 1000 : 0;
    b.points_lost = Math.round(b.effective_weight * (100 - b.score) * 10) / 10; // sums to 100 - composite
  }
  breakdown.sort((a, b) => b.points_lost - a.points_lost);

  const failedIds = new Set(all.filter(c => c.status === 'fail').map(c => c.id));
  const triggered = BLOCKER_GROUPS.filter(g => g.ids.some(id => failedIds.has(id)));
  const cap = triggered.length
    ? Math.max(10, Math.min(...triggered.map(g => g.cap)) - 5 * (triggered.length - 1))
    : null;
  const overall = composite === null ? null : (cap === null ? composite : Math.min(composite, cap));
  const band = SCORE_BANDS.find(b => (overall ?? 0) >= b.min) || SCORE_BANDS[SCORE_BANDS.length - 1];

  return {
    overall,
    composite,
    // Legacy flat keys retained so existing consumers keep working.
    title_meta: flat.title_meta,
    content_structure: flat.content_structure,
    indexability: flat.indexability,
    schema: flat.schema,
    geo_signals: flat.geo_signals,
    eeat: flat.eeat,
    technical: flat.technical,
    links_media: flat.links_media,
    keyword: flat.keyword,
    breakdown,
    cap: triggered.length
      ? { applied: overall < composite, value: cap,
          groups: triggered.map(g => ({ id:g.id, cap:g.cap, reason:g.reason, check_ids:g.ids.filter(id => failedIds.has(id)) })) }
      : null,
    band: { label: band.label, blurb: band.blurb },
    formula: breakdown.map(b => `${b.weight}x${b.score}`).join(' + ')
      + ` = ${weightedSum.toFixed(2)}`
      + (Math.abs(weightTotal - 1) > 1e-9 ? ` / ${weightTotal.toFixed(2)}` : '')
      + ` = ${composite}`,
    counts,
  };
}

// ── §2: Page type detection (rule-based) ─────────────────────────────────────

// Found by running the audit against real, randomly-selected pages: a page titled "Family Dentist in
// Apex, NC" at /locations/apex — an unambiguous location page — was detected as page_type 'other' at
// the 0.5 default confidence (and so defaulted to informational intent) because 'location' had no
// plural form and this site's Dentist/LocalBusiness schema is injected by client-side JS (invisible to
// a static fetch, so the DOM-signal fallback in detectPageType() below can't rescue it either). Nearly
// every alternative here was singular-only while real sites overwhelmingly pluralize section URLs
// ("/locations/", "/services/", "/resources/"). Added `s?` to every single-word alternative; left
// multi-word phrases ("who-we-are", "get-in-touch", "case-study") alone since they don't pluralize.
const URL_PAGE_TYPE_PATTERNS = [
  { type: 'homepage',  pattern: /^https?:\/\/[^\/]+\/?$/ },
  { type: 'article',   pattern: /\/(blog|news|article|post|editorial|insight|story|press)s?\// },
  { type: 'article',   pattern: /\/(blog|news|article|post)s?\/[^\/]+\/?$/ },
  { type: 'location',  pattern: /\/(location|office|branch|store|clinic|venue|outlet|practice|dental-office)s?\// },
  { type: 'location',  pattern: /\/[a-z]{2}\/[a-z-]+\/?$/ },
  { type: 'service',   pattern: /\/(service|treatment|procedure|offering|solution|therapy)s?\// },
  { type: 'product',   pattern: /\/(product|item|shop|buy|purchase|catalog)s?\// },
  { type: 'category',  pattern: /\/(category|cat|collection|department)s?\// },
  { type: 'about',     pattern: /\/(about|about-us|our-story|company|who-we-are)\/?$/ },
  { type: 'contact',   pattern: /\/(contact|contact-us|get-in-touch|reach-us)\/?$/ },
  { type: 'faq',       pattern: /\/(faq|faqs|frequently-asked|help|support)\// },
  { type: 'resource',  pattern: /\/(resource|guide|whitepaper|ebook|case-study|report|template|checklist)s?\// },
  { type: 'team',      pattern: /\/(team|staff|people|doctors|physicians|attorneys|our-team)s?\// },
  { type: 'pricing',   pattern: /\/(pricing|plans|packages|rates|fees)\/?$/ },
  { type: 'landing',   pattern: /\/(lp|landing|campaign)s?\// },
];

// Visible-content address/hours detection. Found on a real audit (gentledental.com root-canal page):
// the address "320 Washington St., Brighton, MA 02135" sits in a plain <div class="title-wrap"> with
// no itemprop/address class at all, so the old class-only selector missed it — which meant the
// schema-recommendation engine never suggested adding PostalAddress/OpeningHoursSpecification schema
// for a page that plainly has this content, just not marked up. Falls back to text-shaped patterns,
// mirroring how hasPhone already works via a plain regex rather than a class selector.
const STREET_ADDRESS_RE = /\b\d{1,6}\s+[A-Za-z0-9.'-]+(?:\s+[A-Za-z0-9.'-]+){0,4}\s+(?:St(?:reet)?|Ave(?:nue)?|Rd|Road|Blvd|Boulevard|Dr(?:ive)?|Ln|Lane|Way|Ct|Court|Pl(?:ace)?|Pkwy|Parkway|Cir(?:cle)?|Ter(?:race)?|Hwy|Highway|Sq(?:uare)?)\.?\b/i;
const STATE_ZIP_RE = /\b[A-Z]{2}\s+\d{5}(-\d{4})?\b/;
const OPENING_HOURS_TEXT_RE = /opening hours|hours of operation|office hours|business hours|store hours|mon(?:day)?\s*[-–—]\s*fri(?:day)?|\b(?:mon|tue|wed|thu|fri|sat|sun)\w*\b[^.]{0,25}\d{1,2}:\d{2}\s*(?:am|pm)/i;

function detectAddressSignal($) {
  if ($('[class*="address"], [itemprop="address"]').length > 0) return true;
  const bodyText = $('body').text();
  return STREET_ADDRESS_RE.test(bodyText) || STATE_ZIP_RE.test(bodyText);
}

function detectOpeningHoursSignal($) {
  if ($('[class*="hours"], [class*="timings"]').length > 0) return true;
  return OPENING_HOURS_TEXT_RE.test($('body').text());
}

function detectPageType($, pageUrl, parsedSchemas) {
  let pageType = 'other';
  let confidence = 0.5;

  // Stage 1a: URL patterns
  if (pageUrl) {
    for (const { type, pattern } of URL_PAGE_TYPE_PATTERNS) {
      if (pattern.test(pageUrl)) { pageType = type; confidence = 0.7; break; }
    }
  }

  // Stage 1b: DOM signals override/confirm
  const schemaTypes = new Set(parsedSchemas.flatMap(s => [].concat(s['@type'] || [])));
  const hasLocalBusiness = [...schemaTypes].some(t => LOCAL_BUSINESS_SUBTYPES.has(t));
  const hasArticle = schemaTypes.has('Article') || schemaTypes.has('BlogPosting') || schemaTypes.has('NewsArticle');
  const hasProduct = schemaTypes.has('Product');

  const hasMap = $('iframe[src*="google.com/maps"], iframe[src*="maps.google"]').length > 0;
  const hasOpeningHours = detectOpeningHoursSignal($);
  const hasAddress = detectAddressSignal($) || /PostalAddress/i.test(JSON.stringify(parsedSchemas));
  const hasArticleEl = $('article').length > 0;
  const hasAuthorByline = $('[rel="author"], [class*="byline"], [class*="author"]').length > 0;
  const hasTimeEl = $('time[datetime]').length > 0;

  if (hasLocalBusiness && (hasMap || hasAddress || hasOpeningHours)) { pageType = 'location'; confidence = 0.9; }
  else if (hasArticle || (hasArticleEl && hasAuthorByline && hasTimeEl)) { pageType = 'article'; confidence = 0.85; }
  else if (hasProduct) { pageType = 'product'; confidence = 0.85; }

  // Extract context
  const allSchemaJson = JSON.stringify(parsedSchemas).toLowerCase();
  const hasMedicalContent = [...schemaTypes].some(t => ['Dentist','Physician','MedicalOrganization','Hospital','MedicalClinic','Pharmacy'].includes(t))
    || /medical|dental|dentist|physician|clinic|healthcare|patient/i.test($('body').text().substring(0, 2000));
  const hasLegalContent = [...schemaTypes].some(t => ['Attorney','LegalService'].includes(t));
  const hasFinancialContent = [...schemaTypes].some(t => ['FinancialService','AccountingService','InsuranceAgency'].includes(t));

  const brandName = parsedSchemas.find(s => hasType(s, 'Organization') || typesOf(s).some(t => LOCAL_BUSINESS_SUBTYPES.has(t)))?.name
    || $('meta[property="og:site_name"]').attr('content')
    || (() => { const t = $('title').first().text(); const segs = t.split(/[|\-–]/); return segs.length > 1 ? segs[segs.length-1].trim() : ''; })()
    || '';

  const h1Text = $('h1').first().text().trim();
  // Prefer the authoritative addressLocality from schema. The URL regex alone captured the STATE
  // segment of paths like /dental-offices/ma/arlington, so this page reported primaryCity 'ma'.
  const schemaLocality = parsedSchemas
    .map(s => s.address && s.address.addressLocality)
    .find(v => typeof v === 'string' && v.trim());
  const urlCityMatch = pageUrl?.match(/\/([a-z][a-z-]{2,})\/?$/); // last path segment, not the state
  const h1CityMatch = h1Text.match(/\bin\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/);
  const primaryCity = (schemaLocality && schemaLocality.trim())
    || (h1CityMatch && h1CityMatch[1])
    || (urlCityMatch && urlCityMatch[1].replace(/-/g, ' '))
    || '';
  const schemaRegion = parsedSchemas
    .map(s => s.address && s.address.addressRegion)
    .find(v => typeof v === 'string' && v.trim()) || '';

  // The named-practitioner roster. Surfaced explicitly so the AI cannot claim named experts are
  // absent on a page that lists them — a Person node with a jobTitle is a practitioner, whereas a
  // Person reached via a Review is its author.
  const namedPractitioners = parsedSchemas
    .filter(s => hasType(s, 'Person') && s.name && s.jobTitle)
    .map(s => ({ name: String(s.name).slice(0, 80), jobTitle: String(s.jobTitle).slice(0, 60), url: s.url || '' }));

  return {
    pageType,
    pageTypeConfidence: confidence,
    brandName: brandName.substring(0, 60),
    primaryCity,
    primaryRegion: schemaRegion,
    primaryService: h1Text.split(/\s+/).slice(0, 4).join(' '),
    hasEcommerce: hasProduct,
    hasMedicalContent,
    hasLegalContent,
    hasFinancialContent,
    isYMYL: hasMedicalContent || hasLegalContent || hasFinancialContent,
    detectedVertical: hasMedicalContent ? 'healthcare' : hasLegalContent ? 'legal' : hasFinancialContent ? 'finance' : hasProduct ? 'ecommerce' : 'other',
    namedPractitioners,
    keywords: [], // filled in by caller
  };
}

// ── Page intent (commercial vs informational) ────────────────────────────────
// Commercial pages are transactional/entity pages: their job is to convert and to expose machine-
// readable facts (NAP, hours, offers). Informational pages answer a question, so citations,
// statistics and expert quotations are first-class signals there and meaningless here.
const PAGE_TYPE_INTENT = {
  location: 'commercial', service: 'commercial', product: 'commercial', category: 'commercial',
  pricing: 'commercial', contact: 'commercial', landing: 'commercial', homepage: 'commercial',
  team: 'commercial', about: 'commercial',
  article: 'informational', blog: 'informational', resource: 'informational',
  guide: 'informational', faq: 'informational',
};

// A user-supplied intent always wins. Unknown/'other' page types fall back to informational so an
// unclassifiable page never silently loses its citation/statistics scoring.
function resolvePageIntent(userIntent, pageContext) {
  if (userIntent === 'commercial' || userIntent === 'informational') {
    return { intent: userIntent, source: 'user' };
  }
  return { intent: PAGE_TYPE_INTENT[pageContext && pageContext.pageType] || 'informational', source: 'detected' };
}

// Resolve every LocalBusiness-shaped fact ONCE. checksF/checksJ/checksT each used to re-parse the
// JSON-LD independently and none of them flattened @graph, so they disagreed with detectPageType()
// and with each other (T10 read 3 sameAs profiles while J9 read 1 on the same page).
function summarizeLocalBusiness(parsedSchemas, detectedElements, $) {
  const lbSchema = parsedSchemas.find(s => typesOf(s).some(t => LOCAL_BUSINESS_SUBTYPES.has(t)));
  // Prefer a real Organization node for brand-level fields; fall back to the LocalBusiness subtype.
  const orgOrLb = parsedSchemas.find(s => hasType(s, 'Organization'))
    || parsedSchemas.find(s => typesOf(s).some(t => LOCAL_BUSINESS_SUBTYPES.has(t)));
  const lbType = lbSchema ? typesOf(lbSchema).find(t => LOCAL_BUSINESS_SUBTYPES.has(t)) : null;
  const addr = (lbSchema && lbSchema.address) || null;
  const ADDR_SUB = ['streetAddress', 'addressLocality', 'addressRegion', 'postalCode'];
  const ohsArray = [].concat((lbSchema && lbSchema.openingHoursSpecification) || []);
  const ohsErrors = ohsArray.flatMap(o => validateOpeningHours(o));
  const reviewNodes = parsedSchemas.filter(s => hasType(s, 'Review'));
  const aggregateRating = (lbSchema && lbSchema.aggregateRating)
    || (parsedSchemas.find(s => s.aggregateRating) || {}).aggregateRating || null;

  // sameAs may be split across org-like blocks; take the union.
  const sameAsUrls = [...new Set(parsedSchemas
    .filter(s => hasType(s, 'Organization') || hasType(s, 'WebSite') || typesOf(s).some(t => LOCAL_BUSINESS_SUBTYPES.has(t)))
    .flatMap(s => toSameAsArray(s.sameAs)))];

  const faqNode = parsedSchemas.find(s => hasType(s, 'FAQPage'));
  const faqItems = [].concat((faqNode && faqNode.mainEntity) || []);

  return {
    lbSchema, lbType, orgOrLb,
    orgName: String((orgOrLb && orgOrLb.name) || '').toLowerCase(),
    hasAddress: !!addr,
    addrComplete: !!addr && ADDR_SUB.every(f => !!addr[f]),
    hasTelephone: !!(lbSchema && lbSchema.telephone),
    ohsPresent: ohsArray.length > 0,
    ohsValid: ohsArray.length > 0 && ohsErrors.length === 0,
    ohsErrors,
    hasGeoCoords: !!(lbSchema && lbSchema.geo && lbSchema.geo.latitude && lbSchema.geo.longitude),
    aggregateRating,
    reviewNodes,
    sameAsUrls,
    hasSchemaId: !!(orgOrLb && orgOrLb['@id']),
    // 'LocalBusiness' is itself in LOCAL_BUSINESS_SUBTYPES, so exclude it when asking "is the subtype
    // specific?" — Dentist is specific, bare LocalBusiness is not.
    hasSpecificSubtype: !!lbType && lbType !== 'LocalBusiness',
    hasAreaServed: !!(lbSchema && (lbSchema.areaServed || lbSchema.hasOfferCatalog || lbSchema.makesOffer)),
    personNodes: parsedSchemas.filter(s => hasType(s, 'Person')),
    questionHeadingCount: $ ? $('h2,h3').filter((_, el) => $(el).text().trim().endsWith('?')).length : 0,
    faqSchemaValid: !!faqNode && faqItems.length > 0
      && faqItems.every(i => hasType(i, 'Question') && i.acceptedAnswer),
    // Distinct from hasAddress/ohsValid/aggregateRating above, which are schema-only: these three flag
    // when the fact is visible in the page's plain text/DOM even though no schema encodes it, so the
    // answerability findings below can say "visible but not machine-readable" instead of implying the
    // content itself is absent.
    visibleAddressOnPage: !!(detectedElements && detectedElements.hasAddress),
    visibleHoursOnPage: !!(detectedElements && detectedElements.hasOpeningHours),
    visibleReviewsOnPage: !!(detectedElements && (detectedElements.hasReviewText || detectedElements.hasStarRating)),
    // Gate for "does this page have any reason to publish local facts at all?" — a SaaS pricing page
    // must not be marked down for having no address. detectedElements.hasAddress is a class-name
    // heuristic and is false on Arlington, so schema presence has to be part of the test.
    hasLocalSignals: !!lbSchema || !!(detectedElements && (detectedElements.hasPhone
      || detectedElements.hasAddress || detectedElements.hasOpeningHours)),
  };
}

// ── GEO answerability score (0-10) ───────────────────────────────────────────
// Two rubrics behind one 0-10 scale so the T3 thresholds and the UI stay comparable.
//   CSQAF (informational): Citations, Statistics, Quotations, Authoritativeness, Fluency
//   NAPEF (commercial):    NAP, Availability, Proof, Entity linking, Fluency
// On a commercial page citations/statistics/quotations carry ZERO weight; their 6 points are
// redistributed onto signals an answer engine actually extracts from a transactional page.
function computeAnswerability(intent, s) {
  const parts = [];
  if (intent === 'commercial') {
    const f = s.lbFacts;
    const local = f.hasLocalSignals;

    if (local) {
      const napPts = (f.hasTelephone && f.addrComplete) ? 2 : (f.hasAddress ? 1 : 0);
      const napMissingNote = f.visibleAddressOnPage
        ? ' A plain-text address is visible on the page — it just isn\'t encoded in schema markup, so AI engines and rich results can\'t reliably extract it.'
        : '';
      parts.push({ key: 'N', label: 'NAP completeness', points: napPts, max: 2, finding:
        napPts === 2 ? 'Telephone and a complete postal address are present in the business schema.'
        : napPts === 1 ? 'An address is present but a subfield or the telephone is missing.'
        : `No machine-readable address in schema markup.${napMissingNote}` });

      const availPts = (f.ohsValid ? 1 : 0) + (f.hasGeoCoords ? 1 : 0);
      const hoursMissingNote = (!f.ohsPresent && f.visibleHoursOnPage)
        ? ' Hours are shown as plain text on the page — add an openingHoursSpecification block to make them machine-readable.'
        : '';
      parts.push({ key: 'A', label: 'Availability (hours + geo)', points: availPts, max: 2, finding:
        `Opening hours ${f.ohsValid ? 'are valid' : f.ohsPresent ? 'are present but invalid or empty' : 'are absent from schema'}; geo coordinates ${f.hasGeoCoords ? 'present' : 'absent'}.${hoursMissingNote}` });
    }

    const ar = f.aggregateRating || {};
    const proofPts = (ar.ratingValue && ar.reviewCount) ? 2 : ((f.aggregateRating || f.reviewNodes.length) ? 1 : 0);
    const proofMissingNote = (proofPts === 0 && f.visibleReviewsOnPage)
      ? ' Reviews are visible on the page but not marked up — add AggregateRating/Review schema so they count as GEO proof.'
      : '';
    parts.push({ key: 'P', label: 'Proof / review markup', points: proofPts, max: 2, finding:
      proofPts === 2 ? 'AggregateRating carries both ratingValue and reviewCount.'
      : proofPts === 1 ? `Partial review markup (${f.reviewNodes.length} Review node(s), aggregateRating ${f.aggregateRating ? 'present' : 'absent'}).`
      : `No AggregateRating and no Review markup.${proofMissingNote}` });

    const entityPts = (f.sameAsUrls.length >= 3 ? 1 : 0) + ((f.hasSchemaId && f.hasSpecificSubtype) ? 1 : 0);
    parts.push({ key: 'E', label: 'Entity linking', points: entityPts, max: 2, finding:
      `${f.sameAsUrls.length} sameAs profile(s); @id ${f.hasSchemaId ? 'present' : 'absent'}; subtype ${f.hasSpecificSubtype ? `specific (${f.lbType})` : 'generic or absent'}.` });

    const fluencyPts = (s.promoCount === 0 ? 1 : 0) + ((s.blufOk && s.qaOk) ? 1 : 0);
    parts.push({ key: 'F', label: 'Fluency & extractability', points: fluencyPts, max: 2, finding:
      `${s.promoCount} unsubstantiated promotional term(s); direct-answer opening ${s.blufOk ? 'yes' : 'no'}; Q&A structure ${s.qaOk ? 'yes' : 'no'}.` });
  } else {
    parts.push({ key: 'C', label: 'Citations', points: s.sourcedStats > 0 ? 2 : (s.statCount > 0 ? 1 : 0), max: 2,
      finding: `${s.sourcedStats} sourced statistic(s).` });
    parts.push({ key: 'S', label: 'Statistics', points: s.statCount >= 4 ? 2 : (s.statCount >= 2 ? 1 : 0), max: 2,
      finding: `${s.statCount} statistic(s) detected.` });
    parts.push({ key: 'Q', label: 'Quotations', points: s.expertQuoteCount > 0 ? 2 : 0, max: 2,
      finding: `${s.expertQuoteCount} attributed expert quote(s).` });
    parts.push({ key: 'A', label: 'Authoritativeness', points: s.hasAuthor ? 2 : 0, max: 2,
      finding: s.hasAuthor ? 'A named author is present.' : 'No named author.' });
    parts.push({ key: 'F', label: 'Fluency', points: s.promoCount === 0 ? 2 : (s.promoCount < 3 ? 1 : 0), max: 2,
      finding: `${s.promoCount} unsubstantiated promotional term(s).` });
  }

  const earned = parts.reduce((a, p) => a + p.points, 0);
  const max = parts.reduce((a, p) => a + p.max, 0);
  // Renormalise rather than zero, so a commercial page with no reason to publish local facts is not
  // charged for their absence.
  const score = max > 0 ? Math.max(0, Math.min(10, Math.round((earned / max) * 10))) : 0;
  return { rubric: intent === 'commercial' ? 'NAPEF' : 'CSQAF', score, earned, max, breakdown: parts };
}

// ── §5: Schema detection + recommendation engine ──────────────────────────────

// Entity-valued properties worth registering as first-class schema blocks. Without this the collector
// saw only `@graph` and top-level arrays, so the six `Person` objects nested under `Dentist.employee`
// on the Arlington page were invisible — which is why the audit reported "no Person schema" and the AI
// produced the quick win "Add named doctor and medical credentials" for a page listing six named
// dentists. `WebPage.breadcrumb` was lost the same way, producing a false "no BreadcrumbList".
const NESTED_ENTITY_KEYS = ['employee','member','founder','author','provider','physician','department',
  'breadcrumb','itemReviewed','subOrganization','parentOrganization','review','makesOffer','hasOfferCatalog'];

function collectSchemaNodes(node, out, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 5) return;
  if (Array.isArray(node)) { for (const n of node) collectSchemaNodes(n, out, depth); return; }
  if (node['@graph']) collectSchemaNodes(node['@graph'], out, depth);
  if (node['@type']) out.push(node);
  for (const k of NESTED_ENTITY_KEYS) {
    if (node[k]) collectSchemaNodes(node[k], out, depth + 1);
  }
}

function extractSchemaBlocks($) {
  const blocks = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      collectSchemaNodes(JSON.parse($(el).html() || ''), blocks);
    } catch { blocks.push({ _parseError: true }); }
  });
  return blocks;
}

function getSchemaRecommendations(pageType, pageContext, detectedElements, detectedTypes) {
  const detected = new Set(detectedTypes);
  const recs = [];
  const add = (type, source, priority) => { if (!detected.has(type)) recs.push({ type, source, priority }); };

  const pageTypeSchemas = {
    homepage:  [['Organization','required'],['WebSite','required']],
    location:  [[pageContext.hasMedicalContent ? 'Dentist' : 'LocalBusiness','required'],['GeoCoordinates','recommended']],
    service:   [['Service','recommended']],
    article:   [['Article','required'],['Person','recommended'],['BreadcrumbList','recommended']],
    blog:      [['BlogPosting','required'],['Person','recommended'],['BreadcrumbList','recommended']],
    product:   [['Product','required'],['Offer','required'],['AggregateRating','recommended']],
    about:     [['Organization','required'],['AboutPage','recommended'],['Person','recommended']],
    contact:   [['ContactPage','recommended'],['PostalAddress','recommended']],
    faq:       [['FAQPage','required']],
    resource:  [['Article','recommended'],['HowTo','optional'],['BreadcrumbList','recommended']],
    guide:     [['HowTo','recommended'],['BreadcrumbList','recommended']],
    team:      [['Person','recommended']],
    pricing:   [['Offer','recommended']],
  };
  for (const [type, priority] of (pageTypeSchemas[pageType] || [])) add(type, 'page_type', priority);

  if (detectedElements.hasPhone || detectedElements.hasAddress) add('ContactPoint','element','recommended');
  if (detectedElements.hasOpeningHours) add('OpeningHoursSpecification','element','recommended');
  if (detectedElements.hasFAQSection) add('FAQPage','element','recommended');
  if (detectedElements.hasVideoEmbed) add('VideoObject','element','recommended');
  if (detectedElements.hasReviewText) add('AggregateRating','element','recommended');
  if (detectedElements.hasBreadcrumb) add('BreadcrumbList','element','recommended');
  if (detectedElements.hasAuthorByline) add('Person','element','recommended');
  if (detectedElements.hasSocialLinks) add('sameAs (within Organization)','element','recommended');
  if (detectedElements.hasMapEmbed) add('GeoCoordinates','element','recommended');
  if (detectedElements.hasNumberedSteps) add('HowTo','element','optional');
  if (pageContext.hasMedicalContent) { add('MedicalOrganization','ymyl','recommended'); }
  if (pageContext.hasLegalContent) add('LegalService','ymyl','required');
  if (pageContext.hasFinancialContent) add('FinancialService','ymyl','required');

  const seen = new Set();
  return recs.filter(r => { if (seen.has(r.type)) return false; seen.add(r.type); return true; });
}

function detectPageElements($, rawHtml) {
  return {
    hasPhone: /\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/.test(rawHtml),
    hasAddress: detectAddressSignal($),
    hasOpeningHours: detectOpeningHoursSignal($),
    hasFAQSection: $('[class*="faq"],[id*="faq"]').length > 0 || $('h2,h3').filter((_, el) => /faq|frequently asked/i.test($(el).text())).length > 0,
    hasVideoEmbed: $('iframe[src*="youtube.com"], iframe[src*="vimeo.com"]').length > 0,
    hasImages: $('img').length > 0,
    imageCount: $('img').length,
    hasReviewText: $('[class*="review"], [class*="rating"], [itemprop="review"]').length > 0 || $('[class*="star"]').length > 0,
    hasStarRating: $('[class*="star"],[data-rating]').length > 0,
    hasBreadcrumb: $('[class*="breadcrumb"],[aria-label*="breadcrumb"]').length > 0,
    hasAuthorByline: $('[rel="author"],[class*="author"],[class*="byline"]').length > 0,
    hasStaffSection: $('[class*="team"],[class*="staff"],[class*="doctor"],[class*="provider"]').length > 0,
    hasSocialLinks: $('a[href*="facebook.com"], a[href*="twitter.com"], a[href*="linkedin.com"], a[href*="instagram.com"]').length > 0,
    hasMapEmbed: $('iframe[src*="maps.google"], iframe[src*="google.com/maps"]').length > 0,
    hasGeoCoords: /latitude|longitude|GeoCoordinates/i.test(rawHtml),
    hasInsuranceText: /insurance|insured|accepts.*insurance/i.test(rawHtml),
    hasNumberedSteps: $('ol li').length >= 3 || /step\s+\d/i.test($('h2,h3').text()),
    hasPriceRange: /\$\d|\bprice range\b/i.test(rawHtml),
    hasEventText: /event|appointment|schedule|webinar/i.test(rawHtml),
  };
}

// ── §3: Keyword check suite ───────────────────────────────────────────────────
// Backed by keywordMatch.js, which returns a GRADED tier rather than a boolean. The old engine
// generated a handful of naive variants (stopword strip + trailing-s toggle) and did a raw substring
// `includes()`, so it had no notion of word order, word boundaries or proximity. On a page titled
// "Arlington Dentist, MA" the keyword "dentist in arlington" was reported ABSENT from both the title
// and the H1 — the only two hard errors in the whole audit — purely because the terms were reversed.
//
// A boolean cannot fix that without breaking something else: making it order-insensitive and
// stem-aware enough to match "Gentle Dental Arlington" would simultaneously make the density and
// heading-repetition checks fire on the brand name. The graded tier lets placement checks (KW1/KW2)
// accept a low bar and report the shortfall, while density/repetition checks demand a high one.

// Required lazily: the keyword suite only runs when the user supplies keywords, so a missing engine
// must not take down an audit that never needed it.
let _kwm = null;
function KWMod() {
  if (!_kwm) _kwm = require('./keywordMatch');
  return _kwm;
}

// Field-level gap budget: metadata and headings are terse, prose is not.
const G_META = 3;
const G_BODY = 6;

function contentOnlyText(rawHtml) {
  // Strip chrome before measuring density or the "first 100 words". Arlington's first 100 words are
  // its 50-city office nav, so no matcher could have produced a meaningful verdict from full <body>.
  const $c = cheerio.load(rawHtml);
  $c('script,style,noscript,header,footer,nav,form').remove();
  const scope = $c('main').length ? $c('main') : ($c('[role=main]').length ? $c('[role=main]') : $c('body'));
  return scope.text().replace(/\s+/g, ' ').trim();
}

function checksKW($, rawHtml, keywords, pageUrl = null, pageContext = {}) {
  const KWM = KWMod();
  const T = KWM.TIER_RANK;
  const results = [];
  const terms = (keywords || []).filter(Boolean);
  const kw = terms[0];
  const kw2 = terms[1] || null;
  if (!kw) return results;

  const brandName = pageContext.brandName || '';
  const KW = (id, name) => makeResult(id, 'Keyword Analysis', name);

  // Attach the graded match evidence to the check so the UI and the AI can see WHY it scored.
  const record = (r, m, extraFlags) => {
    r.tier = m.tier;
    r.matchScore = m.score;
    if (m.evidence) r.evidence = m.evidence;
    const flags = [...(m.flags || []), ...(extraFlags || [])];
    if (flags.length) r.flags = [...new Set(flags)];
    return r;
  };

  const titleText = $('title').first().text().trim();
  const h1Text = $('h1').first().text().trim();
  const metaDesc = $('meta[name="description"]').attr('content') || '';
  const ogTitle = $('meta[property="og:title"]').attr('content') || '';
  const ogDesc = $('meta[property="og:description"]').attr('content') || '';
  const contentText = contentOnlyText(rawHtml);
  const contentWords = wordCount(contentText);
  const first100 = contentText.split(/\s+/).slice(0, 100).join(' ');
  const h2List = $('h2').map((_, el) => $(el).text()).get();
  const allHeadings = $('h1,h2,h3,h4,h5,h6').map((_, el) => $(el).text()).get();
  const altList = $('img[alt]').map((_, el) => $(el).attr('alt')).get().filter(Boolean);

  const meta = { gap: G_META, metadata: true };
  const body = { gap: G_BODY };

  // Best match across a list of independent strings — never join them, or a match can straddle two
  // unrelated headings (the old code did `$('h2').map(...).join(' ')`).
  const bestOf = (list, keyword, opts) => list.reduce((best, s) => {
    const m = KWM.matchKeyword(keyword, s, opts);
    return (!best || m.rank > best.rank) ? m : best;
  }, null) || KWM.matchKeyword(keyword, '', opts);

  // ── KW1 / KW2: primary keyword in the title and H1 ──────────────────────────
  // These accept `unordered_proximity` with at most one intervening content token. Google treats
  // "Arlington Dentist" and "dentist in Arlington" as the same intent, so flagging the former is
  // simply wrong; the reversed order is reported as a flag, not a failure.
  const placementStatus = (r, m, label) => {
    const reversedButTight = m.tier === 'unordered_proximity' && m.gaps <= 1 && m.minLevel >= 2;
    if (m.rank >= T.ordered_with_gaps || reversedButTight) {
      const note = reversedButTight
        ? ` ${label} uses reversed word order ("${m.evidence}") — this satisfies the query, though the canonical order reads better in a SERP snippet.`
        : '';
      pass(r, m.evidence || null, `Keyword found in ${label} (${m.tier}).${note}`);
      return record(r, m, reversedButTight ? ['word_order_reversed'] : []);
    }
    if (m.rank >= T.family_proximity) {
      notice(r, m.evidence || null, `${label} uses a related form ("${m.evidence}") rather than the keyword itself (${m.tier}).`);
      return record(r, m);
    }
    if (m.rank === T.absent) {
      fail(r, 'error', null, `Keyword "${kw}" not found in ${label}.`);
      return record(r, m);
    }
    warn(r, m.evidence || null, `Keyword "${kw}" only partially present in ${label} (${m.tier}).`);
    return record(r, m);
  };

  const KW1 = KW('KW1', 'Primary keyword in title tag');
  const m1 = KWM.matchKeyword(kw, titleText, meta);
  placementStatus(KW1, m1, 'title');

  const KW2 = KW('KW2', 'Primary keyword in H1');
  placementStatus(KW2, KWM.matchKeyword(kw, h1Text, meta), 'H1');

  // ── KW3 / KW4 ───────────────────────────────────────────────────────────────
  const KW3 = KW('KW3', 'Primary keyword in meta description');
  const m3 = KWM.matchKeyword(kw, metaDesc, meta);
  m3.rank >= T.unordered_proximity ? pass(KW3, m3.evidence, `Keyword found in meta description (${m3.tier}).`)
    : m3.rank >= T.family_proximity ? notice(KW3, m3.evidence, `Meta description uses a related form (${m3.tier}).`)
    : warn(KW3, metaDesc.substring(0, 80), `Keyword "${kw}" not found in meta description.`);
  record(KW3, m3);

  const KW4 = KW('KW4', 'Keyword in first 100 words of main content');
  const m4 = KWM.matchKeyword(kw, first100, body);
  m4.rank >= T.unordered_proximity ? pass(KW4, m4.evidence, `Keyword appears in the first 100 words (${m4.tier}).`)
    : m4.rank >= T.scattered_terms ? notice(KW4, first100.substring(0, 80), `Keyword terms appear early but not as a phrase (${m4.tier}).`)
    : warn(KW4, first100.substring(0, 80), `Keyword "${kw}" not in the first 100 words of main content.`);
  record(KW4, m4);

  // ── KW5: URL slug ───────────────────────────────────────────────────────────
  // Uses the real page URL. This check used to regex the first http:// string out of the raw HTML,
  // which on Arlington was a purl.org RSS namespace from an <html prefix> attribute — so it graded
  // the slug "/rss/1.0/modules/content/" and never looked at the page's own path.
  const KW5 = KW('KW5', 'Keyword in URL slug');
  let urlPath = null;
  try { urlPath = pageUrl ? new URL(pageUrl).pathname : null; } catch { urlPath = null; }
  if (urlPath === null) {
    skipped(KW5, 'no URL available (pasted HTML)');
  } else {
    const m5 = KWM.matchKeyword(kw, urlPath.replace(/[-_/]+/g, ' '), meta);
    m5.rank >= T.unordered_proximity ? pass(KW5, urlPath, `Keyword in URL slug (${m5.tier}).`)
      : m5.rank >= T.partial_terms ? notice(KW5, urlPath, `URL slug carries only part of the keyword (${m5.tier}).`)
      : warn(KW5, urlPath, 'Primary keyword not found in the URL slug.');
    record(KW5, m5);
  }

  // ── KW6 / KW7: coverage checks — either supplied keyword satisfies these ─────
  const coverageTerms = kw2 ? [kw, kw2] : [kw];
  const KW6 = KW('KW6', 'Keyword in at least one H2');
  const m6 = coverageTerms.map(t => ({ t, m: bestOf(h2List, t, meta) })).sort((a, b) => b.m.rank - a.m.rank)[0];
  m6.m.rank >= T.unordered_proximity ? pass(KW6, m6.m.evidence, `Keyword found in an H2 (${m6.m.tier}${m6.t !== kw ? `, matched secondary "${m6.t}"` : ''}).`)
    : m6.m.rank >= T.family_proximity ? notice(KW6, m6.m.evidence, `An H2 uses a related form (${m6.m.tier}).`)
    : warn(KW6, null, `Keyword "${kw}" not found in any H2.`);
  record(KW6, m6.m);

  const KW7 = KW('KW7', 'Keyword in image alt text');
  const m7 = coverageTerms.map(t => bestOf(altList, t, meta)).sort((a, b) => b.rank - a.rank)[0];
  m7.rank >= T.family_proximity ? pass(KW7, m7.evidence, `Keyword or a related form appears in alt text (${m7.tier}).`)
    : m7.rank >= T.partial_terms ? notice(KW7, m7.evidence, `Alt text carries only part of the keyword (${m7.tier}).`)
    : notice(KW7, null, `Keyword "${kw}" not found in any image alt text.`);
  record(KW7, m7);

  // ── KW8: density ────────────────────────────────────────────────────────────
  // Non-overlapping occurrence counting at a strict tier. The old code summed independent regex
  // counts across every generated variant over the same text, so one real occurrence was counted once
  // per variant that fit inside it.
  const KW8 = KW('KW8', 'Keyword density in body text');
  const strict = KWM.countOccurrences(kw, contentText, { gap: G_META, minTier: 'ordered_with_gaps' });
  const family = KWM.countOccurrences(kw, contentText, { gap: G_META, minTier: 'family_proximity' });
  const brandHits = brandName
    ? KWM.countOccurrences(brandName, contentText, { gap: G_META, minTier: 'exact_phrase_inflected' }).count
    : 0;
  const density = contentWords > 0 ? (strict.count / contentWords * 100) : 0;
  const densityDetail = `${strict.count} phrase occurrence(s) in ${contentWords} content words (${density.toFixed(2)}%). `
    + `${family.count} looser topical/family mention(s)`
    + (brandHits ? `, of which ~${brandHits} are the brand name "${brandName}"` : '') + '.';
  if (density >= 0.5 && density <= 3.0) pass(KW8, `${density.toFixed(2)}%`, `Density is within the 0.5–3.0% target. ${densityDetail}`);
  else if (density < 0.5) notice(KW8, `${density.toFixed(2)}%`, `Density is below 0.5% — page may be under-optimised. ${densityDetail}`);
  else warn(KW8, `${density.toFixed(2)}%`, `Density is above 3.0% — over-optimisation risk. ${densityDetail}`);
  KW8.matchScore = Math.round(density * 100) / 100;

  // ── KW9: schema name fields ─────────────────────────────────────────────────
  // Scoped to the primary entity's own naming fields. Testing the whole raw JSON-LD blob meant an FAQ
  // question or a review body could satisfy "keyword in schema name field".
  const KW9 = KW('KW9', 'Keyword in schema name field');
  const schemaNames = (pageContext.schemaNameText || '');
  const m9 = KWM.matchKeyword(kw, schemaNames, { gap: G_META, metadata: true });
  m9.rank >= T.unordered_proximity ? pass(KW9, m9.evidence, `Keyword in a schema naming field (${m9.tier}).`)
    : m9.rank >= T.family_proximity ? notice(KW9, m9.evidence, `Schema naming fields use a related form (${m9.tier}).`)
    : notice(KW9, null, `Keyword "${kw}" not found in the primary entity's schema name/description fields.`);
  record(KW9, m9);

  // ── KW10 / KW11 ─────────────────────────────────────────────────────────────
  const KW10 = KW('KW10', 'Keyword in OG title');
  const m10 = KWM.matchKeyword(kw, ogTitle, meta);
  m10.rank >= T.unordered_proximity ? pass(KW10, m10.evidence, `Keyword in og:title (${m10.tier}).`)
    : m10.rank >= T.family_proximity ? notice(KW10, m10.evidence, `og:title uses a related form (${m10.tier}).`)
    : notice(KW10, ogTitle.substring(0, 80), `Keyword "${kw}" not found in og:title.`);
  record(KW10, m10);

  const KW11 = KW('KW11', 'Keyword in OG description');
  const m11 = KWM.matchKeyword(kw, ogDesc, meta);
  m11.rank >= T.unordered_proximity ? pass(KW11, m11.evidence, `Keyword in og:description (${m11.tier}).`)
    : m11.rank >= T.family_proximity ? notice(KW11, m11.evidence, `og:description uses a related form (${m11.tier}).`)
    : notice(KW11, ogDesc.substring(0, 80), `Keyword "${kw}" not found in og:description.`);
  record(KW11, m11);

  // ── KW12: distinct surface forms ────────────────────────────────────────────
  const KW12 = KW('KW12', 'Keyword variant coverage');
  const forms = [...new Set(family.hits.map(h => (h.evidence || '').toLowerCase().trim()).filter(Boolean))];
  forms.length >= 3 ? pass(KW12, forms.slice(0, 4).join(' | '), `${forms.length} distinct surface forms of the keyword in the content.`)
    : forms.length === 2 ? notice(KW12, forms.join(' | '), 'Only 2 distinct forms — add more natural variations.')
    : notice(KW12, forms.join(' | ') || null, `Only ${forms.length} distinct form(s) — add natural variations (plural, reordered, with a preposition).`);

  // ── KW13: over-repetition in headings ───────────────────────────────────────
  // Counts at the strict tier and excludes brand-name incidentals: "Gentle Dental Arlington" appears
  // in most headings on this page for reasons unrelated to keyword targeting, and counting those would
  // manufacture a stuffing warning.
  const KW13 = KW('KW13', 'Keyword not over-repeated in headings');
  const brandLower = brandName.toLowerCase();
  const hitHeadings = allHeadings.filter(h => {
    const m = KWM.matchKeyword(kw, h, meta);
    if (m.rank < T.unordered_proximity) return false;
    if (brandLower && h.toLowerCase().includes(brandLower)) return false; // brand incidental
    return true;
  }).length;
  const pct = allHeadings.length ? hitHeadings / allHeadings.length : 0;
  pct <= 0.4 ? pass(KW13, `${hitHeadings}/${allHeadings.length} headings`, 'Keyword is not over-repeated in headings (brand-name mentions excluded).')
    : pct <= 0.6 ? notice(KW13, `${hitHeadings}/${allHeadings.length} (${Math.round(pct*100)}%)`, `Keyword appears in ${Math.round(pct*100)}% of headings — target ≤40%.`)
    : warn(KW13, `${hitHeadings}/${allHeadings.length} (${Math.round(pct*100)}%)`, `Keyword appears in ${Math.round(pct*100)}% of headings — over-optimisation risk.`);

  // ── KW14: position in title ─────────────────────────────────────────────────
  // Uses the match's character offset. `titleText.indexOf(kw)` returns -1 for any title that does not
  // contain the keyword as a literal substring, which is exactly the case this whole rewrite is about.
  const KW14 = KW('KW14', 'Keyword position in title');
  if (m1.rank < T.family_proximity || m1.srcStart == null) {
    notice(KW14, titleText.substring(0, 60), 'Keyword not located in the title.');
  } else if (m1.srcStart <= 40) {
    pass(KW14, `Position ${m1.srcStart}`, `Keyword appears early in the title (character ${m1.srcStart}).`);
  } else {
    notice(KW14, `Position ${m1.srcStart}`, `Keyword appears late in the title (character ${m1.srcStart} — target ≤40).`);
  }

  results.push(KW1,KW2,KW3,KW4,KW5,KW6,KW7,KW8,KW9,KW10,KW11,KW12,KW13,KW14);

  // ── Secondary keyword: same ladder, one severity milder ─────────────────────
  if (kw2) {
    const KW2_1 = KW('KW2_1', 'Secondary keyword in title');
    const s1 = KWM.matchKeyword(kw2, titleText, meta);
    s1.rank >= T.unordered_proximity ? pass(KW2_1, s1.evidence, `Secondary keyword in title (${s1.tier}).`)
      : notice(KW2_1, titleText.substring(0, 80), `Secondary keyword "${kw2}" not in title (${s1.tier}).`);
    record(KW2_1, s1);

    const KW2_2 = KW('KW2_2', 'Secondary keyword in H1');
    const s2 = KWM.matchKeyword(kw2, h1Text, meta);
    s2.rank >= T.unordered_proximity ? pass(KW2_2, s2.evidence, `Secondary keyword in H1 (${s2.tier}).`)
      : notice(KW2_2, h1Text.substring(0, 80), `Secondary keyword "${kw2}" not in H1 (${s2.tier}).`);
    record(KW2_2, s2);

    const KW2_3 = KW('KW2_3', 'Secondary keyword in body');
    const s3 = KWM.matchKeyword(kw2, contentText, body);
    s3.rank >= T.unordered_proximity ? pass(KW2_3, s3.evidence, `Secondary keyword found in body (${s3.tier}).`)
      : s3.rank >= T.family_proximity ? notice(KW2_3, s3.evidence, `Body uses a related form of the secondary keyword (${s3.tier}).`)
      : warn(KW2_3, null, `Secondary keyword "${kw2}" not found in body text.`);
    record(KW2_3, s3);

    results.push(KW2_1, KW2_2, KW2_3);
  }

  return results;
}

// ── Main export ───────────────────────────────────────────────────────────────

// CHANGE 15 — Updated runAllChecks signature and return value
// `options.pageIntent` is 'auto' | 'commercial' | 'informational'. Using an options object rather than
// a fifth positional keeps future flags from churning the signature again.
async function runAllChecks(rawHtml, pageUrl, httpHeaders, keywords = [], options = {}) {
  const $ = cheerio.load(rawHtml, { decodeEntities: false });

  // Extract schema blocks first (needed for page type detection)
  const parsedSchemas = extractSchemaBlocks($);
  const schemaTypes = parsedSchemas.flatMap(s => typesOf(s));

  // Page type detection
  const pageContext = detectPageType($, pageUrl, parsedSchemas);
  pageContext.keywords = keywords || [];

  // Detected elements
  const detectedElements = detectPageElements($, rawHtml);

  // Resolve intent BEFORE any check runs, so every check can see it. (The route's AI page-type
  // classifier runs after this and therefore cannot influence scoring — by design.)
  const { intent, source: pageIntentSource } = resolvePageIntent(options.pageIntent, pageContext);
  pageContext.pageIntent = intent;
  pageContext.pageIntentSource = pageIntentSource;

  // Resolve the LocalBusiness/entity facts once and share them, so checksF/J/T cannot disagree.
  const lbFacts = summarizeLocalBusiness(parsedSchemas, detectedElements, $);

  // Naming fields of the PAGE'S OWN entities, for KW9. Deliberately excludes FAQ questions, review
  // bodies and breadcrumb items — testing the whole raw JSON-LD blob meant an FAQ question containing
  // the keyword satisfied "keyword in schema name field".
  const KW9_ENTITY_TYPES = new Set(['Dentist','LocalBusiness','MedicalBusiness','MedicalClinic',
    'Organization','WebPage','WebSite','Product','Service','DentalService']);
  pageContext.schemaNameText = parsedSchemas
    .filter(s => typesOf(s).some(t => KW9_ENTITY_TYPES.has(t)))
    .flatMap(s => [s.name, s.alternateName, s.legalName, s.description, s.headline])
    .filter(v => typeof v === 'string' && v.trim())
    .join(' . ');

  // Schema recommendations
  const schemaRecommendations = getSchemaRecommendations(
    pageContext.pageType, pageContext, detectedElements, schemaTypes
  );

  const a = checksA($);
  const b = checksB($);
  const c = checksC($, httpHeaders);
  const d = checksD($, pageUrl, httpHeaders);
  const e = checksE($);
  const fResult = checksF($, rawHtml, intent, pageContext, lbFacts);
  const f = fResult.checks;
  const geoData = fResult.geo;
  const g = checksG($);
  const h = checksH($, pageUrl);
  const i = checksI($, pageUrl, intent);
  const j = checksJ($, parsedSchemas, intent, lbFacts);
  const k = checksK($, pageUrl);
  const l = checksL($);
  const m = checksM($, rawHtml, httpHeaders);
  const n = checksN(pageUrl);
  const o = checksO($, rawHtml);
  const p = checksP($);
  const q = checksQ($);
  const r = checksR($, rawHtml, intent, pageContext);
  const s = checksS($, rawHtml);
  const t = checksT($, rawHtml, geoData, intent, parsedSchemas, lbFacts, detectedElements);
  const u = checksU($, rawHtml);

  // Keyword checks (only when keywords provided). pageUrl and pageContext are passed so the URL-slug
  // check can look at the ACTUAL page URL instead of scraping the first http:// string out of the HTML.
  let kwChecks = [];
  if (keywords && keywords.length > 0) {
    kwChecks = checksKW($, rawHtml, keywords, pageUrl, pageContext);
  }

  const allChecks = [...a,...b,...c,...d,...e,...f,...g,...h,...i,...j,...k,...l,...m,...n,...o,...p,...q,...r,...s,...t,...u,...kwChecks];
  const scores = calculateScores(allChecks, intent);

  return {
    checks: allChecks,
    scores,
    geo: geoData,
    pageContext,
    pageIntent: intent,
    pageIntentSource,
    detectedElements,
    detectedSchemas: parsedSchemas,
    schemaRecommendations,
    kwChecks,
  };
}

module.exports = {
  runAllChecks, batchHttpChecks, headRequest,
  // exported for the zero-dependency test runner
  calculateScores, resolvePageIntent, computeAnswerability, summarizeLocalBusiness,
  toSameAsArray, validateOpeningHours, extractSchemaBlocks, SCORE_BUCKETS,
  countStatistics, contentOnlyText, detectPageType,
};
