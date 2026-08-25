const cheerio = require('cheerio');
const { collectData } = require('./dataCollector');
const { detectPageType, extractSchemas, getSchemaTypes } = require('./pageTypeDetector');
const { genId, saveAudit } = require('./store');

// ── Check result builders ─────────────────────────────────────────────────────

function chk(id, label, status, evidence, recommendation) {
  const r = { id, label, status, evidence };
  if (recommendation) r.recommendation = recommendation;
  return r;
}
const pass  = (id, l, e)    => chk(id, l, 'pass',    e);
const fail  = (id, l, e, r) => chk(id, l, 'fail',    e, r);
const warn  = (id, l, e, r) => chk(id, l, 'warning', e, r);
const manual= (id, l, e, r) => chk(id, l, 'manual',  e, r);
const na    = (id, l, e)    => chk(id, l, 'na',       e || 'Not applicable to this page type');

// ── Target keywords ─────────────────────────────────────────────────────────
// Keywords are per PAGE, not per site: the page about implants targets a
// different term from the page about pricing. A page with no keyword assigned is
// NOT failing the keyword checks — they do not apply to it, which is precisely
// what 'na' already means here.
//
// Deriving one instead (from the slug, the title, the H1) would make every
// keyword check score the page against a term nobody chose, and the findings
// would read as real. So the checks that need a keyword stand down, the rest of
// the audit runs, and the report says which is which.
const NO_KEYWORD = 'No target keyword is set for this page, so keyword placement was not checked.';
const naKeyword = (id, label) => chk(id, label, 'na', NO_KEYWORD);

// For remediation text that would otherwise quote the keyword back and print
// "undefined" when there isn't one.
const kwOr = (kws) => kws[0] || '[the page\'s target keyword]';

function sectionStatus(checks) {
  if (checks.some(c => c.status === 'fail'))    return 'fail';
  if (checks.some(c => c.status === 'warning')) return 'warning';
  if (checks.some(c => c.status === 'manual'))  return 'manual';
  if (checks.every(c => c.status === 'na'))     return 'na';
  return 'pass';
}

function sec(id, name, checks) {
  return { id, name, status: sectionStatus(checks), checks };
}

// ── Keyword helpers ───────────────────────────────────────────────────────────

function containsKeyword(text, keywords) {
  if (!text) return false;
  const lower = text.toLowerCase();
  return keywords.some(kw => lower.includes(kw.toLowerCase()));
}

function keywordCount(text, keywords) {
  if (!text) return 0;
  const lower = text.toLowerCase();
  return keywords.reduce((n, kw) => {
    let pos = 0, c = 0;
    const k = kw.toLowerCase();
    while ((pos = lower.indexOf(k, pos)) !== -1) { c++; pos += k.length; }
    return n + c;
  }, 0);
}

function keywordWordMatch(text, keywords) {
  if (!text) return false;
  const lower = text.toLowerCase();
  return keywords.some(kw =>
    kw.toLowerCase().split(/\s+/).filter(w => w.length > 2).some(w => lower.includes(w))
  );
}

// ── Body text extraction (strips nav / header / footer) ──────────────────────

function getBodyText(html) {
  if (!html) return '';
  const $ = cheerio.load(html);
  $('script, style, noscript, nav, header, footer, aside, [class*="cookie"], [class*="banner"], [class*="nav"], [class*="sidebar"]').remove();
  return $('body').text().replace(/\s+/g, ' ').trim();
}

function countWords(text) {
  return text.trim().split(/\s+/).filter(w => w.length > 0).length;
}

// ── CWV parsing ───────────────────────────────────────────────────────────────

function parseMetric(displayValue) {
  if (!displayValue) return null;
  const m = String(displayValue).match(/([0-9.]+)\s*(s|ms)?/i);
  if (!m) return null;
  const v = parseFloat(m[1]);
  return m[2]?.toLowerCase() === 'ms' ? v / 1000 : v;
}

function cwvStatus(metric, val) {
  if (val === null) return null;
  const t = { lcp: [2.5, 4.0], cls: [0.1, 0.25], inp: [0.2, 0.5], fcp: [1.8, 3.0], ttfb: [0.8, 1.8] }[metric];
  if (!t) return null;
  if (val <= t[0]) return 'good';
  if (val <= t[1]) return 'needs-improvement';
  return 'poor';
}

// ── Breadcrumb extraction ─────────────────────────────────────────────────────

function getBreadcrumb($, schemas) {
  // Try schema BreadcrumbList first
  const bc = schemas.find(s => {
    const t = [].concat(s['@type'] || []).map(x => x.toLowerCase());
    return t.includes('breadcrumblist');
  });
  if (bc?.itemListElement) {
    return bc.itemListElement.map(i => i.name || i.item?.name || '').filter(Boolean);
  }
  // Fall back to breadcrumb nav element
  const navBc = $('[aria-label*="breadcrumb" i], nav.breadcrumb, .breadcrumb, #breadcrumb').first();
  if (navBc.length) {
    return navBc.find('a, [itemprop="name"]').toArray().map(el => $(el).text().trim()).filter(Boolean);
  }
  return [];
}

// ── Section 1: URL Structure ──────────────────────────────────────────────────

function s1(data, kws) {
  const url = data.finalUrl || data.inputUrl;
  let urlObj;
  try { urlObj = new URL(url); } catch { return sec(1, 'URL Structure', [fail('1', 'URL is parseable', url, 'Fix the URL')]); }

  const slug = urlObj.pathname.split('/').filter(Boolean).pop() || '';
  const fullPath = urlObj.pathname;
  const urlLen = url.length;
  const checks = [];

  // 1: keyword in URL slug, length
  //
  // A compound check. Without a keyword the length half is still measurable, so
  // it is reported on its own with a label that says the other half was not
  // checked — rather than dropping a real check along with the keyword one.
  const kwInSlug = kws.length ? keywordWordMatch(fullPath, kws) : false;
  if (!kws.length) {
    checks.push(urlLen > 115
      ? warn('1', 'URL ≤ 115 chars (keyword placement not checked)', `"${slug}" — ${urlLen} chars (limit: 115). ${NO_KEYWORD}`, 'Shorten the URL path')
      : pass('1', 'URL ≤ 115 chars (keyword placement not checked)', `"${slug}" — ${urlLen} chars. ${NO_KEYWORD}`));
  } else if (!kwInSlug) {
    checks.push(fail('1', 'URL includes target keyword', `Slug: "${slug}" — no keyword word found`, `Rewrite the URL to include a keyword term. Suggested: /${kws[0].toLowerCase().replace(/\s+/g, '-')}/`));
  } else if (urlLen > 115) {
    checks.push(warn('1', 'URL includes target keyword and is ≤ 115 chars', `"${slug}" contains keyword but URL is ${urlLen} chars (limit: 115)`, 'Shorten the URL path while retaining the keyword'));
  } else {
    checks.push(pass('1', 'URL includes target keyword and is ≤ 115 chars', `"${slug}" — keyword present, ${urlLen} chars`));
  }

  // 1.1: hyphens
  if (slug.includes('_') || slug.includes('+') || slug.includes('%20')) {
    const sep = slug.includes('_') ? 'underscores' : slug.includes('+') ? 'plus signs' : 'encoded spaces';
    checks.push(fail('1.1', 'Hyphens used as word separators', `"${slug}" uses ${sep}`, `Replace ${sep} with hyphens and set up 301 redirects from old URLs`));
  } else {
    checks.push(pass('1.1', 'Hyphens used as word separators', `"${slug}" uses hyphens correctly`));
  }

  // 1.2: lowercase, no special chars
  const hasUpper = /[A-Z]/.test(urlObj.pathname);
  const hasParams = urlObj.search && urlObj.search.length > 1;
  if (hasUpper) {
    checks.push(fail('1.2', 'Fully lowercase URL', `URL contains uppercase: "${urlObj.pathname}"`, 'Convert URL to all-lowercase and 301 redirect the uppercase version'));
  } else if (hasParams) {
    checks.push(warn('1.2', 'No unnecessary URL parameters', `Query string: "${urlObj.search}" — may create duplicate content`, 'Remove non-functional query parameters and ensure canonical points to the clean URL'));
  } else {
    checks.push(pass('1.2', 'Fully lowercase, no unnecessary parameters', `"${urlObj.pathname}" — clean URL`));
  }

  // 1.3: URL hierarchy vs breadcrumb
  const $ = data.$;
  const schemas = extractSchemas($);
  const breadcrumb = getBreadcrumb($, schemas);
  if (breadcrumb.length > 0) {
    const pathSegs = fullPath.split('/').filter(Boolean);
    const bcSlugs = breadcrumb.map(b => b.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 6));
    const slugText = pathSegs.join(' ').toLowerCase().replace(/[^a-z0-9 ]/g, '');
    const match = bcSlugs.slice(0, -1).every(bc => bc.length < 3 || slugText.includes(bc));
    if (match) {
      checks.push(pass('1.3', 'URL hierarchy matches breadcrumb', `Breadcrumb: ${breadcrumb.join(' > ')}`));
    } else {
      checks.push(warn('1.3', 'URL hierarchy matches breadcrumb', `Breadcrumb: ${breadcrumb.join(' > ')} vs URL path: ${fullPath}`, 'Verify URL nesting matches breadcrumb navigation structure'));
    }
  } else {
    checks.push(manual('1.3', 'URL hierarchy matches breadcrumb', 'No breadcrumb detected on page', 'Add BreadcrumbList schema and verify URL nesting matches site navigation'));
  }

  return sec(1, 'URL Structure', checks);
}

// ── Section 2: Meta Title ─────────────────────────────────────────────────────

function s2(data, kws) {
  const $ = data.$;
  const raw = $('title').text().trim();
  const checks = [];

  // 2.1: exists, not a CMS default
  const defaults = ['home', 'page', 'sample page', 'untitled', 'wordpress', 'drupal', 'just another'];
  if (!raw) {
    checks.push(fail('2.1', 'Title tag present and not a CMS default', 'No <title> tag found', `Add a <title> tag with the primary keyword. Suggested: "${kwOr(kws)} | [Brand Name]"`));
    checks.push(fail('2', 'Title concise and keyword-rich (≤ 60 chars)', 'No <title> tag — cannot evaluate', 'Add a title tag'));
    checks.push(fail('2.2', 'Brand name included', 'No <title> tag', 'Add title tag with brand'));
    // Keyword placement in a title that does not exist is still a keyword check:
    // with no keyword set there is nothing to place, and the missing title is
    // already reported by 2.1 and 2.
    checks.push(kws.length
      ? fail('2.3', 'Primary keyword in title', 'No <title> tag', 'Add title tag with keyword')
      : naKeyword('2.3', 'Primary keyword in title'));
    return sec(2, 'Meta Title', checks);
  }
  if (defaults.some(d => raw.toLowerCase().startsWith(d) || raw.toLowerCase() === d)) {
    checks.push(fail('2.1', 'Title tag present and not a CMS default', `"${raw}" — appears to be a CMS default`, `Replace with a keyword-optimized title. Suggested: "${kwOr(kws)} | [Brand Name]"`));
  } else {
    checks.push(pass('2.1', 'Title tag present and not a CMS default', `"${raw}"`));
  }

  // 2: length and keyword
  const brandSep = raw.indexOf(' | ') !== -1 ? ' | ' : raw.indexOf(' - ') !== -1 ? ' - ' : null;
  const withoutBrand = brandSep ? raw.substring(0, raw.lastIndexOf(brandSep)).trim() : raw;
  const fullLen = raw.length;
  const nobrLen = withoutBrand.length;

  // Length is checked either way; the "keyword-rich" half only when there is a
  // keyword to look for, and the label says so when there isn't.
  const hasKw = kws.length ? containsKeyword(raw, kws) : false;
  const titleLabel = kws.length
    ? 'Title ≤ 60 chars, keyword-rich'
    : 'Title ≤ 60 chars (keyword placement not checked)';
  if (fullLen > 70) {
    checks.push(fail('2', titleLabel, `"${raw}" — ${fullLen} chars (excluding brand: ${nobrLen} chars)`, `Shorten to under 60 characters. Currently ${fullLen} chars. Rewrite as: "${kwOr(kws)} | [Brand]"`));
  } else if (fullLen > 60) {
    checks.push(warn('2', titleLabel, `"${raw}" — ${fullLen} chars (${nobrLen} without brand) — may truncate in SERPs`, `Aim for ≤ 60 chars to prevent truncation. Current: ${fullLen} chars`));
  } else if (kws.length && !hasKw) {
    checks.push(warn('2', titleLabel, `"${raw}" — ${fullLen} chars, but no primary keyword found`, `Add "${kws[0]}" to the title`));
  } else {
    checks.push(pass('2', 'Title ≤ 60 chars, keyword-rich', `"${raw}" — ${fullLen} chars${nobrLen < fullLen ? ` (${nobrLen} excl. brand)` : ''}`));
  }

  // 2.2: brand name at end
  if (brandSep) {
    const brandAtEnd = raw.lastIndexOf(brandSep) > raw.length / 2;
    if (brandAtEnd) {
      checks.push(pass('2.2', 'Brand name at end', `Brand separator "${brandSep}" found at end`));
    } else {
      checks.push(warn('2.2', 'Brand name at end', `Brand appears at start of title: "${raw}"`, 'Move brand name to the end of the title, separated by " | "'));
    }
  } else {
    checks.push(warn('2.2', 'Brand name included', `No brand separator found in "${raw}"`, 'Append " | [Brand Name]" to the title'));
  }

  // 2.3: keyword in title
  if (!kws.length) {
    checks.push(naKeyword('2.3', 'Primary keyword in title'));
  } else if (containsKeyword(raw, kws)) {
    checks.push(pass('2.3', 'Primary keyword in title', `"${kws[0]}" found in title`));
  } else if (keywordWordMatch(raw, kws)) {
    checks.push(warn('2.3', 'Primary keyword in title', `Only partial keyword match found in "${raw}"`, `Include the full keyword "${kws[0]}" in the title`));
  } else {
    checks.push(fail('2.3', 'Primary keyword in title', `"${kws[0]}" not found in title "${raw}"`, `Add "${kws[0]}" to the title tag`));
  }

  return sec(2, 'Meta Title', checks);
}

// ── Section 3: Meta Description ───────────────────────────────────────────────

function s3(data, kws) {
  const $ = data.$;
  const desc = $('meta[name="description"]').attr('content') || '';
  const checks = [];
  const ctaWords = ['schedule', 'call', 'contact', 'book', 'get', 'request', 'sign up', 'learn more', 'find', 'discover', 'explore', 'start', 'try', 'see'];

  if (!desc) {
    checks.push(fail('3', 'Meta description present (≤ 160 chars, CTA, keyword)', 'Meta description tag not found', `Add a meta description containing "${kwOr(kws)}", a CTA, and under 160 characters`));
    checks.push(na('3.1', 'Not auto-generated'));
    checks.push(kws.length
      ? na('3.2', 'Keyword in description')
      : naKeyword('3.2', 'Keyword in description'));
    return sec(3, 'Meta Description', checks);
  }

  const len = desc.length;
  const hasCTA = ctaWords.some(w => desc.toLowerCase().includes(w));
  const hasKw = kws.length ? containsKeyword(desc, kws) : false;

  if (len > 175) {
    checks.push(fail('3', 'Meta description ≤ 160 chars with CTA and keyword', `"${desc.slice(0, 80)}…" — ${len} chars (exceeds 160)`, `Shorten to under 160 characters. Currently ${len} chars.`));
  } else if (len > 155) {
    checks.push(warn('3', 'Meta description ≤ 160 chars with CTA and keyword', `"${desc.slice(0, 80)}…" — ${len} chars (risk of truncation)`, `Aim for under 155 characters to prevent truncation. Currently ${len} chars.`));
  } else if (!hasCTA) {
    checks.push(warn('3', 'Meta description ≤ 160 chars with CTA and keyword', `"${desc.slice(0, 80)}" — ${len} chars, no CTA detected`, `Add a CTA phrase (e.g., "Schedule a consultation today" or "Call us now")`));
  } else {
    checks.push(pass('3', 'Meta description ≤ 160 chars with CTA and keyword', `"${desc.slice(0, 80)}…" — ${len} chars`));
  }

  // 3.1: not auto-generated
  const looksAutoGen = desc.endsWith('...') || desc.endsWith('…') || (desc.length < 80 && !hasCTA);
  if (looksAutoGen) {
    checks.push(warn('3.1', 'Description is intentionally written', `Description appears truncated or auto-generated: "${desc.slice(0, 60)}…"`, 'Rewrite as a hand-crafted 150–155 character summary with a CTA'));
  } else {
    checks.push(pass('3.1', 'Description is intentionally written', 'Description appears custom-written'));
  }

  // 3.2: keyword in description
  if (!kws.length) {
    checks.push(naKeyword('3.2', 'Primary keyword in description'));
  } else if (containsKeyword(desc, kws)) {
    checks.push(pass('3.2', 'Primary keyword in description', `"${kws[0]}" found in description`));
  } else if (keywordWordMatch(desc, kws)) {
    checks.push(warn('3.2', 'Primary keyword in description', `Only partial match for "${kws[0]}" in description`, `Include the full keyword phrase in the description`));
  } else {
    checks.push(fail('3.2', 'Primary keyword in description', `"${kws[0]}" not found in description`, `Add "${kws[0]}" naturally within the first 100 characters of the description`));
  }

  return sec(3, 'Meta Description', checks);
}

// ── Section 4: Heading Tags ───────────────────────────────────────────────────

function s4(data, kws) {
  const $ = data.$;
  const checks = [];

  const allH = [];
  $('h1,h2,h3,h4,h5,h6').each((_, el) => {
    allH.push({ level: parseInt(el.tagName[1]), text: $(el).text().trim() });
  });

  const h1s = allH.filter(h => h.level === 1);
  const h1 = h1s[0]?.text || '';

  // 4.1: single H1
  if (h1s.length === 0) {
    checks.push(fail('4', 'H1 present and addresses main topic', 'No <h1> tag found on the page', `Add a single H1 tag containing "${kwOr(kws)}"`));
    checks.push(fail('4.1', 'Single H1 per page', '0 H1 tags found', 'Add exactly one H1 tag'));
  } else if (h1s.length > 1) {
    checks.push(warn('4', 'H1 present and addresses main topic', `${h1s.length} H1 tags found: ${h1s.map(h => `"${h.text}"`).join(', ')}`, 'Remove duplicate H1 tags — keep only one'));
    checks.push(fail('4.1', 'Single H1 per page', `${h1s.length} H1 tags found`, `Remove ${h1s.length - 1} H1 tag(s) to leave exactly one`));
  } else {
    const vague = ['welcome', 'home', 'services', 'about us', 'contact', 'our services', 'overview'].some(v => h1.toLowerCase() === v);
    if (vague) {
      checks.push(warn('4', 'H1 present and addresses main topic', `H1: "${h1}" — appears vague or generic`, `Rewrite H1 to specifically describe the page topic, incorporating "${kwOr(kws)}"`));
    } else {
      checks.push(pass('4', 'H1 present and addresses main topic', `H1: "${h1}"`));
    }
    checks.push(pass('4.1', 'Single H1 per page', 'Exactly 1 H1 found'));
  }

  // 4.2: keyword in H1
  if (!kws.length) {
    checks.push(naKeyword('4.2', 'Primary keyword in H1'));
  } else if (!h1) {
    checks.push(fail('4.2', 'Primary keyword in H1', 'No H1 present', `Add H1 containing "${kws[0]}"`));
  } else if (containsKeyword(h1, kws)) {
    checks.push(pass('4.2', 'Primary keyword in H1', `"${kws[0]}" found in H1: "${h1}"`));
  } else if (keywordWordMatch(h1, kws)) {
    checks.push(warn('4.2', 'Primary keyword in H1', `Partial keyword match in H1: "${h1}"`, `Include the full keyword phrase "${kws[0]}" in the H1`));
  } else {
    checks.push(fail('4.2', 'Primary keyword in H1', `"${kws[0]}" not found in H1: "${h1}"`, `Rewrite H1 to include "${kws[0]}"`));
  }

  // 4.3: hierarchy — no skipped levels
  let prevLevel = 1;
  let skipFound = false;
  for (const h of allH) {
    if (h.level > prevLevel + 1) { skipFound = true; break; }
    prevLevel = h.level;
  }
  if (skipFound) {
    checks.push(warn('4.3', 'H2–H6 hierarchy is logical', `Level skip detected in heading structure: ${allH.slice(0, 8).map(h => `H${h.level}`).join(' → ')}`, 'Fix heading hierarchy — do not skip levels (e.g., H2 → H4 without H3)'));
  } else if (allH.length === 0) {
    checks.push(warn('4.3', 'H2–H6 hierarchy is logical', 'No headings found on page', 'Add structured headings (H1, H2, H3) to organize content'));
  } else {
    checks.push(pass('4.3', 'H2–H6 hierarchy is logical', `Heading structure: ${allH.slice(0, 6).map(h => `H${h.level}`).join(' → ')}`));
  }

  // 4.4: keyword in H2
  const h2s = allH.filter(h => h.level === 2);
  if (!kws.length) {
    checks.push(naKeyword('4.4', 'Primary keyword in at least one H2'));
  } else if (h2s.length === 0) {
    checks.push(warn('4.4', 'Primary keyword in at least one H2', 'No H2 tags found on page', 'Add H2 subheadings that include the primary keyword'));
  } else if (h2s.some(h => containsKeyword(h.text, kws))) {
    checks.push(pass('4.4', 'Primary keyword in at least one H2', `Keyword found in H2: "${h2s.find(h => containsKeyword(h.text, kws))?.text}"`));
  } else if (h2s.some(h => keywordWordMatch(h.text, kws))) {
    checks.push(warn('4.4', 'Primary keyword in at least one H2', `Partial keyword match in H2s: ${h2s.slice(0, 3).map(h => `"${h.text}"`).join(', ')}`, `Add the full keyword "${kws[0]}" to at least one H2`));
  } else {
    checks.push(fail('4.4', 'Primary keyword in at least one H2', `None of ${h2s.length} H2 tags contain "${kws[0]}"`, `Update one H2 to include "${kws[0]}" naturally`));
  }

  return sec(4, 'Heading Tags', checks);
}

// ── Section 5: Content Quality ────────────────────────────────────────────────

function s5(data, kws, pageType, isYMYL) {
  const bodyText = getBodyText(data.html);
  const wordCount = countWords(bodyText);
  const kwMentions = kws.length ? keywordCount(bodyText, kws) : 0;
  const $ = data.$;
  const checks = [];

  // 5: keyword mentions
  if (!kws.length) {
    checks.push(naKeyword('5', 'Keywords appear ≥ 5 times in body content'));
  } else if (kwMentions >= 5) {
    checks.push(pass('5', 'Keywords appear ≥ 5 times in body content', `${kwMentions} mentions of "${kws[0]}" found in body`));
  } else if (kwMentions >= 3) {
    checks.push(warn('5', 'Keywords appear ≥ 5 times in body content', `Only ${kwMentions} mentions found (target: 5+)`, `Increase natural usage of "${kws[0]}" — aim for 5–8 occurrences across the body content`));
  } else {
    checks.push(fail('5', 'Keywords appear ≥ 5 times in body content', `Only ${kwMentions} mentions found (target: 5+)`, `Significantly increase usage of "${kws[0]}" throughout body content. Currently ${kwMentions} occurrences.`));
  }

  // 5.1: word count
  const minWords = { blog: 800, location: 600, service: 600, homepage: 400, general: 500 };
  const target = minWords[pageType] || 500;
  if (wordCount >= target) {
    checks.push(pass('5.1', `Word count appropriate for ${pageType} page (min ${target})`, `${wordCount} words`));
  } else if (wordCount >= target * 0.75) {
    checks.push(warn('5.1', `Word count appropriate for ${pageType} page (min ${target})`, `${wordCount} words — below ${target}-word target for ${pageType} pages`, `Expand content to at least ${target} words. Add supporting sections, FAQ, or detail on related topics.`));
  } else {
    checks.push(fail('5.1', `Word count appropriate for ${pageType} page (min ${target})`, `${wordCount} words — significantly below ${target}-word minimum`, `Expand content to at least ${target} words. The page needs substantively more content.`));
  }

  // 5.2: search intent alignment (heuristic)
  //
  // Intent is intent FOR a keyword. With none set there is no SERP to compare
  // the page against, so this stands down rather than asking a reviewer to
  // check the page against nothing.
  checks.push(kws.length
    ? manual('5.2', 'Content matches search intent for primary keyword', `Page type detected: ${pageType}. Primary keyword: "${kws[0]}"`, `Verify that the page type and content match the dominant SERP intent for "${kws[0]}". Check: does Google primarily show informational pages, service pages, or location pages for this keyword?`)
    : naKeyword('5.2', 'Content matches search intent for primary keyword'));

  // 5.3: readability
  const paragraphs = $('p').toArray().map(el => $(el).text().trim()).filter(p => p.length > 50);
  const longParas = paragraphs.filter(p => p.split(/[.!?]/).filter(s => s.trim().length > 10).length > 6);
  const hasLists = $('ul li, ol li').length >= 3;
  if (longParas.length > 3) {
    checks.push(warn('5.3', 'Readability appropriate for audience', `${longParas.length} paragraphs have 6+ sentences. ${hasLists ? 'Lists present.' : 'No lists found.'}`, 'Break long paragraphs into shorter ones (max 4 sentences). Add bullet or numbered lists where appropriate.'));
  } else {
    checks.push(pass('5.3', 'Readability appropriate for audience', `${paragraphs.length} paragraphs, avg length acceptable. Lists: ${hasLists ? 'yes' : 'no'}`));
  }

  // 5.4: E-E-A-T (YMYL only)
  if (!isYMYL) {
    checks.push(na('5.4', 'E-E-A-T author attribution'));
  } else {
    const bodyHtml = $('body').html() || '';
    const hasCredentials = /\b(MD|DDS|DMD|DO|RN|PhD|LCSW|LMFT|Esq|CPA|CFP|Dr\.|Doctor|Dentist)\b/.test(bodyHtml);
    const hasAuthor = /\b(written by|author|reviewed by|medically reviewed|by Dr)\b/i.test(bodyHtml);
    if (hasCredentials && hasAuthor) {
      checks.push(pass('5.4', 'E-E-A-T author attribution (YMYL)', 'Author name and credentials detected in page content'));
    } else if (hasAuthor) {
      checks.push(warn('5.4', 'E-E-A-T author attribution (YMYL)', 'Author attribution found but no credentials/title detected', 'Add professional credentials (e.g., "Dr. Jane Smith, DDS") alongside author name'));
    } else {
      checks.push(fail('5.4', 'E-E-A-T author attribution (YMYL)', 'No author attribution found on YMYL page', 'Add a visible author or provider name with professional credentials. For dental/medical content: "Written by Dr. [Name], [Credentials]"'));
    }
  }

  // 5.5: medical claims sourced (YMYL only)
  if (!isYMYL) {
    checks.push(na('5.5', 'Medical/clinical claims supported by sources'));
  } else {
    checks.push(manual('5.5', 'Medical/clinical claims supported by sources', 'YMYL page — verify accuracy of clinical claims', 'Review all clinical/medical claims. Each factual claim should link to CDC, NIH, ADA, peer-reviewed journals, or recognized clinical guidelines.'));
  }

  // 5.6: last reviewed date (YMYL only)
  if (!isYMYL) {
    checks.push(na('5.6', 'Last reviewed / updated date visible'));
  } else {
    const hasDate = /last (reviewed|updated|modified|revised)|medically reviewed/i.test($('body').text());
    if (hasDate) {
      checks.push(pass('5.6', 'Last reviewed / updated date visible', 'Review or update date found in page content'));
    } else {
      checks.push(fail('5.6', 'Last reviewed / updated date visible', 'No review or update date found on YMYL page', 'Add a visible "Last Medically Reviewed: [Month Year]" date near the top of the page'));
    }
  }

  // 5.7: CTA present (service / location pages)
  if (pageType === 'service' || pageType === 'location' || pageType === 'homepage') {
    const ctaPatterns = ['schedule', 'appointment', 'call us', 'call now', 'contact us', 'get started', 'book', 'request', 'free consultation', 'get a quote'];
    const btns = $('a, button').toArray().map(el => $(el).text().toLowerCase());
    const hasCTA = ctaPatterns.some(p => btns.some(b => b.includes(p)));
    if (hasCTA) {
      checks.push(pass('5.7', 'CTA present and accessible', `CTA found: "${btns.find(b => ctaPatterns.some(p => b.includes(p)))?.slice(0, 40)}"`));
    } else {
      checks.push(fail('5.7', 'CTA present and accessible', 'No clear CTA button or link detected in page content', 'Add a prominent CTA (e.g., "Schedule an Appointment" or "Call Us Today") visible above the fold'));
    }
  } else {
    checks.push(na('5.7', 'CTA present'));
  }

  return sec(5, 'Content Quality', checks);
}

// ── Section 6: Internal Links — Outbound ──────────────────────────────────────

function s6(data, pageType) {
  const $ = data.$;
  const finalUrl = data.finalUrl || data.inputUrl;
  let host;
  try { host = new URL(finalUrl).hostname; } catch { host = ''; }

  // Strip nav/header/footer and find contextual body links
  const $b = cheerio.load(data.html || '');
  $b('nav, header, footer, aside, [class*="nav"], [class*="sidebar"]').remove();
  const bodyLinks = [];
  $b('a[href]').each((_, el) => {
    const href = $b(el).attr('href');
    const text = $b(el).text().trim();
    if (!href || !text || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:')) return;
    try {
      const u = new URL(href, finalUrl);
      if (u.hostname === host && u.pathname !== new URL(finalUrl).pathname) {
        bodyLinks.push({ url: u.href, anchor: text });
      }
    } catch { /* skip */ }
  });

  const minLinks = { blog: 3, service: 2, location: 2, homepage: 4, general: 2 };
  const min = minLinks[pageType] || 2;
  const checks = [];

  const linkList = bodyLinks.slice(0, 10).map(l => `"${l.anchor}" → ${l.url}`).join('\n');

  if (bodyLinks.length >= min) {
    checks.push(pass('6', `Contextual internal links in body (min ${min})`, `${bodyLinks.length} contextual internal links found:\n${linkList}`));
  } else if (bodyLinks.length > 0) {
    checks.push(warn('6', `Contextual internal links in body (min ${min})`, `Only ${bodyLinks.length} contextual internal links found (min: ${min}):\n${linkList}`, `Add ${min - bodyLinks.length} more contextual internal links to relevant pages`));
  } else {
    checks.push(fail('6', `Contextual internal links in body (min ${min})`, 'No contextual internal links found in body content', `Add at least ${min} contextual internal links to topically related pages`));
  }

  return sec(6, 'Internal Links — Outbound', checks);
}

// ── Section 7: Internal Links — Inbound ──────────────────────────────────────

function s7() {
  return sec(7, 'Internal Links — Inbound', [
    manual('7', 'Page is linked from relevant internal pages', 'Cannot verify inbound links from a single-page HTML fetch', 'Run Screaming Frog or Ahrefs site crawl. Check: does this URL appear in any inbound links from hub pages, service menus, or navigational elements?'),
    manual('7.1', 'Inbound internal links use keyword-rich anchor text', 'Cannot verify anchor text of inbound links from HTML', 'In Screaming Frog, filter inbound links to this URL. Check anchor text column for generic terms ("click here", "read more") — these should be replaced with descriptive keyword phrases.'),
  ]);
}

// ── Section 8: External Links ─────────────────────────────────────────────────

function s8(data, pageType, isYMYL) {
  const $ = data.$;
  const finalUrl = data.finalUrl || data.inputUrl;
  let host;
  try { host = new URL(finalUrl).hostname; } catch { host = ''; }

  const authoritative = ['nih.gov', 'cdc.gov', 'ada.org', 'who.int', 'mayoclinic.org', 'webmd.com', 'pubmed.ncbi.nlm.nih.gov', 'aapd.org', 'samhsa.gov', 'cms.gov', '.gov', '.edu'];
  const extLinks = [];
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    const text = $(el).text().trim();
    const rel = $(el).attr('rel') || '';
    if (!href || href.startsWith('#') || href.startsWith('/') || href.startsWith('tel:') || href.startsWith('mailto:')) return;
    try {
      const u = new URL(href, finalUrl);
      if (u.hostname !== host) {
        const isAuth = authoritative.some(a => u.hostname.includes(a) || u.hostname.endsWith(a));
        extLinks.push({ url: u.href, anchor: text, domain: u.hostname, rel, isAuthoritative: isAuth });
      }
    } catch { /* skip */ }
  });

  const checks = [];

  if (pageType === 'homepage') {
    checks.push(na('8', 'Authoritative external links (N/A for homepage)'));
    return sec(8, 'External Links', checks);
  }

  const authLinks = extLinks.filter(l => l.isAuthoritative);
  const linkSummary = extLinks.slice(0, 8).map(l => `"${l.anchor || '—'}" → ${l.domain} [rel="${l.rel || 'none'}"]`).join('\n');

  if (isYMYL && authLinks.length === 0) {
    if (extLinks.length === 0) {
      checks.push(fail('8', 'Authoritative external links on YMYL page', 'No external links found on YMYL page with clinical content', 'Add at least 2–3 links to authoritative sources (NIH, CDC, ADA, or peer-reviewed journals) to support clinical claims'));
    } else {
      checks.push(warn('8', 'Authoritative external links on YMYL page', `${extLinks.length} external links found but none to authoritative sources:\n${linkSummary}`, 'Replace or supplement with links to NIH, CDC, ADA, or peer-reviewed sources'));
    }
  } else if (extLinks.length === 0 && (pageType === 'blog' || pageType === 'service')) {
    checks.push(warn('8', 'External links to authoritative sources', 'No external links found', 'Add 1–2 links to authoritative external sources relevant to the topic'));
  } else if (extLinks.length > 0) {
    // Check rel attributes
    const missingRel = extLinks.filter(l => !l.rel.includes('noopener'));
    if (missingRel.length > 0) {
      checks.push(warn('8', 'Authoritative external links with correct rel attributes', `${extLinks.length} external links found; ${missingRel.length} missing rel="noopener noreferrer":\n${linkSummary}`, `Add rel="noopener noreferrer" to all external links: ${missingRel.slice(0, 3).map(l => l.url).join(', ')}`));
    } else {
      checks.push(pass('8', 'Authoritative external links with correct rel attributes', `${extLinks.length} external links found (${authLinks.length} authoritative):\n${linkSummary}`));
    }
  } else {
    checks.push(pass('8', 'External links', 'No external links expected for this page type'));
  }

  return sec(8, 'External Links', checks);
}

// ── Section 9: Schema Markup ──────────────────────────────────────────────────

function s9(data, pageType) {
  const $ = data.$;
  const schemas = extractSchemas($);
  const types = getSchemaTypes(schemas);
  const checks = [];

  if (schemas.length === 0) {
    checks.push(fail('9', 'Schema markup is implemented', 'No JSON-LD schema blocks found on the page', 'Implement JSON-LD schema markup. See check 9.1 for required types for this page type.'));
    checks.push(fail('9.1', 'All applicable schema types implemented', `Page type: ${pageType} — all required schema types missing`, getSchemaRecommendation(pageType)));
    return sec(9, 'Schema Markup', checks);
  }

  const microdata = $('[itemtype]').length > 0 && schemas.length === 0;
  if (microdata) {
    checks.push(warn('9', 'Schema markup is implemented (JSON-LD preferred)', 'Microdata found but no JSON-LD — Google prefers JSON-LD', 'Migrate schema from Microdata to JSON-LD format'));
  } else {
    checks.push(pass('9', 'Schema markup is implemented', `${schemas.length} JSON-LD block(s) found. Types: ${types.join(', ') || 'unknown'}`));
  }

  // 9.1: check required/recommended types for page type
  const { required, recommended } = getExpectedSchema(pageType);
  const missingRequired = required.filter(t => !types.some(ft => ft.includes(t.toLowerCase())));
  const missingRecommended = recommended.filter(t => !types.some(ft => ft.includes(t.toLowerCase())));

  if (missingRequired.length > 0) {
    checks.push(fail('9.1', 'All required schema types present', `Missing required types for ${pageType} page: ${missingRequired.join(', ')}\nPresent: ${types.join(', ')}`, `Add the following required schema: ${missingRequired.join(', ')}. ${getSchemaRecommendation(pageType)}`));
  } else if (missingRecommended.length > 0) {
    checks.push(warn('9.1', 'All required and recommended schema types present', `Required types present. Missing recommended: ${missingRecommended.join(', ')}`, `Add recommended schema: ${missingRecommended.join(', ')} to improve rich result eligibility`));
  } else {
    checks.push(pass('9.1', 'All applicable schema types present', `Types found: ${types.join(', ')}`));
  }

  return sec(9, 'Schema Markup', checks);
}

function getExpectedSchema(pageType) {
  const map = {
    location: { required: ['LocalBusiness'], recommended: ['BreadcrumbList', 'FAQPage', 'AggregateRating'] },
    service:  { required: ['Service'],       recommended: ['BreadcrumbList', 'FAQPage'] },
    blog:     { required: ['Article'],       recommended: ['BreadcrumbList', 'FAQPage'] },
    homepage: { required: ['Organization'],  recommended: ['WebSite', 'BreadcrumbList'] },
    general:  { required: [],               recommended: ['BreadcrumbList'] },
  };
  return map[pageType] || { required: [], recommended: [] };
}

function getSchemaRecommendation(pageType) {
  const r = {
    location: 'Add LocalBusiness (or Dentist/MedicalClinic subtype) with: name, address (PostalAddress), telephone, url, openingHoursSpecification',
    service:  'Add Service schema with: name, description, provider, areaServed',
    blog:     'Add Article or BlogPosting schema with: headline, author, datePublished, dateModified, publisher',
    homepage: 'Add Organization schema with: name, url, logo, sameAs (social profiles)',
    general:  'Add WebPage or appropriate schema type for this content',
  };
  return r[pageType] || r.general;
}

// ── Section 10: Alt Tags ──────────────────────────────────────────────────────

function s10(data, kws) {
  const $ = data.$;
  const imgs = $('img').toArray().map(el => {
    const src = $(el).attr('src') || '';
    const alt = $(el).attr('alt');
    const filename = src.split('/').pop().split('?')[0];
    return { src: filename, alt, hasAlt: alt !== undefined, altEmpty: alt === '' };
  });

  const checks = [];
  const meaningful = imgs.filter(i => !i.altEmpty && i.src && !/spacer|blank|transparent|pixel|1x1/i.test(i.src));
  const missing = meaningful.filter(i => !i.hasAlt);
  const emptyAlt = meaningful.filter(i => i.hasAlt && i.altEmpty);
  const generic = meaningful.filter(i => i.hasAlt && !i.altEmpty && /^(image|img|photo|picture|graphic|icon|logo)$/i.test(i.alt));

  if (missing.length > 0) {
    checks.push(fail('10', 'All meaningful images have descriptive alt text', `${missing.length} image(s) missing alt attribute:\n${missing.slice(0, 5).map(i => i.src).join('\n')}`, `Add descriptive alt text to all meaningful images. Include "${kwOr(kws)}" in alt text where contextually appropriate.`));
  } else if (generic.length > 0) {
    checks.push(warn('10', 'All meaningful images have descriptive alt text', `${generic.length} image(s) have generic alt text: ${generic.slice(0, 3).map(i => `"${i.alt}"`).join(', ')}`, 'Replace generic alt text with specific descriptions (2–10 words)'));
  } else if (imgs.length === 0) {
    checks.push(pass('10', 'All meaningful images have descriptive alt text', 'No images found on page'));
  } else {
    const kwInAlt = kws.length && meaningful.some(i => i.alt && containsKeyword(i.alt, kws));
    checks.push(pass('10', 'All meaningful images have descriptive alt text', `${meaningful.length} meaningful images — all have alt text.${kws.length ? ` Keyword in alt: ${kwInAlt ? 'yes' : 'no'}` : ''}`));
  }

  // 10.1: decorative images use alt=""
  const decorative = imgs.filter(i => i.altEmpty && i.src);
  if (decorative.length > 0) {
    checks.push(pass('10.1', 'Decorative images use alt=""', `${decorative.length} decorative image(s) correctly use alt=""`));
  } else {
    checks.push(pass('10.1', 'Decorative images use alt=""', 'No explicitly decorative images detected'));
  }

  // 10.2: descriptive file names
  const genericNames = imgs.filter(i => /^(img|image|photo|dsc|pic|p\d+|screen[-_]?shot|screenshot|\d+)\.[a-z]+$/i.test(i.src));
  if (genericNames.length > 0) {
    checks.push(warn('10.2', 'Image file names are descriptive', `${genericNames.length} image(s) have generic file names:\n${genericNames.slice(0, 5).map(i => i.src).join('\n')}`, `Rename these images with descriptive, hyphenated names (e.g., "dental-implants-procedure.jpg")`));
  } else if (imgs.length > 0) {
    checks.push(pass('10.2', 'Image file names are descriptive', `${imgs.length} image(s) — file names appear descriptive`));
  } else {
    checks.push(na('10.2', 'Image file names are descriptive'));
  }

  return sec(10, 'Alt Tags', checks);
}

// ── Section 11: Image Optimization ───────────────────────────────────────────

function s11(data) {
  const $ = data.$;
  const psiM = data.psi.mobile;
  const psiD = data.psi.desktop;
  const checks = [];

  // 11: compressed
  const optimized = psiM?.audits?.optimizedImages ?? psiD?.audits?.optimizedImages;
  if (optimized === null || optimized === undefined) {
    checks.push(manual('11', 'Images compressed for fast loading', 'PSI data unavailable', 'Run PageSpeed Insights and check the "Efficiently encode images" audit'));
  } else if (optimized < 0.9) {
    checks.push(fail('11', 'Images compressed for fast loading', `PSI "uses-optimized-images" score: ${Math.round(optimized * 100)}%`, 'Compress all images. Use tools like Squoosh, ImageOptim, or serve via a CDN with auto-optimization.'));
  } else {
    checks.push(pass('11', 'Images compressed for fast loading', `PSI image optimization score: ${Math.round(optimized * 100)}%`));
  }

  // 11.1: WebP
  const webp = psiM?.audits?.webpImages ?? psiD?.audits?.webpImages;
  const imgSrcs = $('img').toArray().map(el => $(el).attr('src') || $(el).attr('data-src') || '');
  const hasWebP = imgSrcs.some(s => /\.(webp|avif)/i.test(s));
  if (webp === null || webp === undefined) {
    if (hasWebP) {
      checks.push(pass('11.1', 'WebP or next-gen image format used', 'WebP/AVIF images detected in img src attributes'));
    } else {
      checks.push(manual('11.1', 'WebP or next-gen image format used', 'PSI unavailable and no WebP detected in src attributes', 'Check if your server is serving WebP via content negotiation. Consider converting all JPG/PNG images to WebP.'));
    }
  } else if (webp < 0.9) {
    checks.push(fail('11.1', 'WebP or next-gen image format used', `PSI "uses-webp-images" score: ${Math.round(webp * 100)}%`, 'Convert all JPEG/PNG images to WebP format. Configure server to serve WebP with JPEG fallback.'));
  } else {
    checks.push(pass('11.1', 'WebP or next-gen image format used', `PSI WebP score: ${Math.round(webp * 100)}%`));
  }

  // 11.2: lazy loading
  const imgs = $('img').toArray();
  const lazyCount = imgs.filter(el => $(el).attr('loading') === 'lazy').length;
  const hasJsLazy = (data.html || '').includes('IntersectionObserver') || (data.html || '').includes('lazyload');
  if (imgs.length === 0) {
    checks.push(na('11.2', 'Lazy loading implemented'));
  } else if (lazyCount >= imgs.length * 0.8 || hasJsLazy) {
    checks.push(pass('11.2', 'Lazy loading implemented for below-fold images', `${lazyCount}/${imgs.length} images use loading="lazy"${hasJsLazy ? ' + JS lazy-load detected' : ''}`));
  } else if (lazyCount > 0) {
    checks.push(warn('11.2', 'Lazy loading implemented for below-fold images', `Only ${lazyCount}/${imgs.length} images use loading="lazy"`, `Add loading="lazy" to all below-fold images`));
  } else {
    checks.push(fail('11.2', 'Lazy loading implemented for below-fold images', `0/${imgs.length} images use loading="lazy"`, `Add loading="lazy" attribute to all non-above-fold images`));
  }

  // 11.3: responsive images
  const respImages = psiM?.audits?.responsiveImages ?? psiD?.audits?.responsiveImages;
  if (respImages === null || respImages === undefined) {
    const hasWidthHeight = imgs.filter(el => $(el).attr('width') && $(el).attr('height')).length;
    checks.push(manual('11.3', 'Images rendered at display dimensions', `${hasWidthHeight}/${imgs.length} images have explicit width/height. PSI data unavailable for full assessment`, 'Run PageSpeed Insights and check the "Properly size images" audit'));
  } else if (respImages < 0.9) {
    checks.push(fail('11.3', 'Images rendered at display dimensions', `PSI "uses-responsive-images" score: ${Math.round(respImages * 100)}%`, 'Serve images sized to their display dimensions. Add width/height attributes to all img tags to prevent layout shift.'));
  } else {
    checks.push(pass('11.3', 'Images rendered at display dimensions', `PSI responsive images score: ${Math.round(respImages * 100)}%`));
  }

  return sec(11, 'Image Optimization', checks);
}

// ── Section 12: Page Speed ────────────────────────────────────────────────────

function s12(data) {
  const m = data.psi.mobile;
  const d = data.psi.desktop;
  const checks = [];

  if (!m && !d) {
    return sec(12, 'Page Speed', [manual('12', 'Page speed data', 'PageSpeed Insights data unavailable', 'Run PageSpeed Insights manually: https://pagespeed.web.dev/')]);
  }

  // 12: scores
  const mScore = m?.score ?? null;
  const dScore = d?.score ?? null;

  if (mScore !== null) {
    if (mScore < 50) checks.push(fail('12', 'Performance score meets minimum thresholds', `Mobile: ${mScore}/100, Desktop: ${dScore ?? 'n/a'}/100`, `Mobile score ${mScore} is in the "Poor" range (<50). Fix: ${(m?.opportunities || []).slice(0, 2).map(o => o.title).join('; ')}`));
    else if (mScore < 70) checks.push(warn('12', 'Performance score meets minimum thresholds', `Mobile: ${mScore}/100 (target: ≥70), Desktop: ${dScore ?? 'n/a'}/100`, `Improve mobile score from ${mScore} to ≥70. Top opportunities: ${(m?.opportunities || []).slice(0, 2).map(o => o.title).join('; ')}`));
    else if (dScore !== null && dScore < 60) checks.push(warn('12', 'Performance score meets minimum thresholds', `Mobile: ${mScore}/100 ✓, Desktop: ${dScore}/100 (target: ≥80)`, `Improve desktop score from ${dScore} to ≥80`));
    else checks.push(pass('12', 'Performance score meets minimum thresholds', `Mobile: ${mScore}/100, Desktop: ${dScore ?? 'n/a'}/100`));
  }

  // 12.1: mobile CWV
  if (m) {
    const lcpVal = parseMetric(m.lcp); const clsVal = parseMetric(m.cls); const inpVal = parseMetric(m.inp);
    const lcpS = cwvStatus('lcp', lcpVal); const clsS = cwvStatus('cls', clsVal); const inpS = cwvStatus('inp', inpVal);

    const mobileCwvSummary = `LCP: ${m.lcp || 'n/a'} (${lcpS || '?'}), CLS: ${m.cls || 'n/a'} (${clsS || '?'}), INP: ${m.inp || 'n/a'} (${inpS || '?'}), FCP: ${m.fcp || 'n/a'}, TTFB: ${m.ttfb || 'n/a'}`;

    if ([lcpS, clsS, inpS].includes('poor')) {
      const failing = [lcpS === 'poor' ? `LCP ${m.lcp}` : null, clsS === 'poor' ? `CLS ${m.cls}` : null, inpS === 'poor' ? `INP ${m.inp}` : null].filter(Boolean);
      checks.push(fail('12.1', 'Core Web Vitals — Mobile', mobileCwvSummary, `Fix "Poor" CWV: ${failing.join(', ')}`));
    } else if ([lcpS, clsS, inpS].includes('needs-improvement')) {
      checks.push(warn('12.1', 'Core Web Vitals — Mobile', mobileCwvSummary, 'Improve mobile CWV from "Needs Improvement" to "Good" range'));
    } else {
      checks.push(pass('12.1', 'Core Web Vitals — Mobile', mobileCwvSummary));
    }
  } else {
    checks.push(manual('12.1', 'Core Web Vitals — Mobile', 'Mobile PSI data unavailable', 'Run PageSpeed Insights on mobile'));
  }

  // 12.2: desktop CWV
  if (d) {
    const lcpVal = parseMetric(d.lcp); const clsVal = parseMetric(d.cls); const inpVal = parseMetric(d.inp);
    const lcpS = cwvStatus('lcp', lcpVal); const clsS = cwvStatus('cls', clsVal); const inpS = cwvStatus('inp', inpVal);
    const desktopCwvSummary = `LCP: ${d.lcp || 'n/a'} (${lcpS || '?'}), CLS: ${d.cls || 'n/a'} (${clsS || '?'}), INP: ${d.inp || 'n/a'} (${inpS || '?'}), FCP: ${d.fcp || 'n/a'}, TTFB: ${d.ttfb || 'n/a'}`;

    if ([lcpS, clsS, inpS].includes('poor')) {
      checks.push(fail('12.2', 'Core Web Vitals — Desktop', desktopCwvSummary, `Fix "Poor" CWV on desktop`));
    } else if ([lcpS, clsS, inpS].includes('needs-improvement')) {
      checks.push(warn('12.2', 'Core Web Vitals — Desktop', desktopCwvSummary, 'Improve desktop CWV from "Needs Improvement" to "Good" range'));
    } else {
      checks.push(pass('12.2', 'Core Web Vitals — Desktop', desktopCwvSummary));
    }
  } else {
    checks.push(manual('12.2', 'Core Web Vitals — Desktop', 'Desktop PSI data unavailable', 'Run PageSpeed Insights on desktop'));
  }

  // Top PSI opportunities
  const opps = [...(m?.opportunities || []), ...(d?.opportunities || [])];
  const uniqueOpps = [...new Map(opps.map(o => [o.id, o])).values()].slice(0, 3);
  if (uniqueOpps.length > 0) {
    checks.push({ id: '12.ops', label: 'Top PageSpeed Opportunities', status: 'manual', evidence: uniqueOpps.map(o => `• ${o.title}`).join('\n'), recommendation: uniqueOpps.map(o => `${o.title}: ${o.description || ''}`).join('\n') });
  }

  return sec(12, 'Page Speed', checks);
}

// ── Section 13: Canonical Tags ────────────────────────────────────────────────

function s13(data) {
  const $ = data.$;
  const finalUrl = (data.finalUrl || data.inputUrl).replace(/\/$/, '');
  const canonical = $('link[rel="canonical"]').attr('href') || '';
  const httpCanonical = data.responseHeaders['link'] || '';
  const checks = [];

  if (!canonical) {
    checks.push(fail('13', 'Self-referencing canonical tag present', 'No <link rel="canonical"> found in <head>', `Add <link rel="canonical" href="${finalUrl}"> to the <head>`));
  } else {
    const normCanon = canonical.replace(/\/$/, '');
    if (normCanon === finalUrl || normCanon === finalUrl.replace(/^https:\/\/www\./, 'https://')) {
      checks.push(pass('13', 'Self-referencing canonical tag present', `canonical: "${canonical}"`));
    } else if (normCanon.startsWith('http')) {
      checks.push(warn('13', 'Self-referencing canonical tag present', `Canonical points to a different URL: "${canonical}" (final URL: "${finalUrl}")`, 'If this is an intentional canonical consolidation, verify it is correct. If not, update to self-referencing canonical.'));
    } else {
      checks.push(warn('13', 'Self-referencing canonical tag present', `Canonical value: "${canonical}" — appears relative`, 'Use an absolute URL in the canonical tag'));
    }
  }

  // 13.1: no conflicting signals
  const headerHasCanonical = httpCanonical.includes('rel="canonical"');
  if (headerHasCanonical && canonical) {
    const headerCanon = (httpCanonical.match(/<([^>]+)>;\s*rel="canonical"/) || [])[1] || '';
    if (headerCanon && headerCanon.replace(/\/$/, '') !== canonical.replace(/\/$/, '')) {
      checks.push(fail('13.1', 'No conflicting canonical signals', `Conflicting canonicals: <head>: "${canonical}" vs HTTP header: "${headerCanon}"`, 'Remove one canonical declaration — keep only the <link> in <head>'));
    } else {
      checks.push(warn('13.1', 'No conflicting canonical signals', 'Canonical declared in both <head> and HTTP header (redundant)', 'Remove the HTTP Link header canonical — <head> canonical is sufficient'));
    }
  } else {
    checks.push(pass('13.1', 'No conflicting canonical signals', 'Single canonical declaration only'));
  }

  return sec(13, 'Canonical Tags', checks);
}

// ── Section 14: Open Graph Tags ───────────────────────────────────────────────

function s14(data) {
  const $ = data.$;
  const og = {};
  $('meta[property^="og:"]').each((_, el) => {
    og[$(el).attr('property')] = $(el).attr('content') || '';
  });
  const checks = [];
  const core = ['og:title', 'og:description', 'og:url', 'og:image', 'og:type'];
  const missing = core.filter(p => !og[p]);

  if (missing.length >= 2) {
    checks.push(fail('14', 'Core OG tags present', `Missing: ${missing.join(', ')}\nPresent: ${Object.keys(og).join(', ') || 'none'}`, `Add the following OG tags: ${missing.map(p => `<meta property="${p}" content="...">`).join(' ')}`));
  } else if (missing.length === 1) {
    checks.push(warn('14', 'Core OG tags present', `Missing: ${missing[0]}\nPresent: ${Object.keys(og).join(', ')}`, `Add missing OG tag: <meta property="${missing[0]}" content="...">`));
  } else {
    checks.push(pass('14', 'Core OG tags present', `All core OG tags present: ${Object.entries(og).map(([k, v]) => `${k}="${v.slice(0, 40)}"`).join(', ')}`));
  }

  // 14.1: OG image
  if (!og['og:image']) {
    checks.push(fail('14.1', 'OG image is correct size (1200×630px)', 'og:image not set', 'Add og:image with a 1200×630px image'));
  } else {
    checks.push(manual('14.1', 'OG image is correct size (1200×630px)', `og:image: "${og['og:image']}"`, 'Verify the OG image dimensions are 1200×630px using a social debugger (https://developers.facebook.com/tools/debug/)'));
  }

  return sec(14, 'Open Graph Tags', checks);
}

// ── Section 15: Twitter Card Tags ─────────────────────────────────────────────

function s15(data) {
  const $ = data.$;
  const tw = {};
  $('meta[name^="twitter:"]').each((_, el) => {
    tw[$(el).attr('name')] = $(el).attr('content') || '';
  });
  const checks = [];

  if (!tw['twitter:card']) {
    checks.push(fail('15', 'Twitter Card defined with correct type', 'No twitter:card meta tag found', 'Add <meta name="twitter:card" content="summary_large_image"> and twitter:title, twitter:description'));
  } else if (tw['twitter:card'] === 'summary_large_image' || tw['twitter:card'] === 'summary') {
    const hasTitleDesc = tw['twitter:title'] && tw['twitter:description'];
    if (hasTitleDesc) {
      checks.push(pass('15', 'Twitter Card defined with correct type', `twitter:card="${tw['twitter:card']}", title: "${tw['twitter:title']?.slice(0, 50)}"`));
    } else {
      checks.push(warn('15', 'Twitter Card defined with correct type', `twitter:card="${tw['twitter:card']}" but missing ${!tw['twitter:title'] ? 'twitter:title' : ''} ${!tw['twitter:description'] ? 'twitter:description' : ''}`.trim(), 'Add twitter:title and twitter:description tags'));
    }
  } else {
    checks.push(warn('15', 'Twitter Card defined with correct type', `twitter:card="${tw['twitter:card']}" — should be "summary_large_image" for content pages`, 'Change twitter:card to "summary_large_image" for best social preview'));
  }

  return sec(15, 'Twitter Card Tags', checks);
}

// ── Section 16: Crawlability & Indexation ─────────────────────────────────────

function s16(data) {
  const $ = data.$;
  const checks = [];

  // 16: HTTP status
  const status = data.statusCode;
  if (!status) {
    checks.push(fail('16', 'Page returns HTTP 200', 'Could not fetch the page — no HTTP status code', 'Verify the URL is accessible and returns a 200 response'));
  } else if (status === 200) {
    const hadRedirect = data.redirectChain.length > 1;
    if (hadRedirect) {
      const chain = data.redirectChain.map(r => `${r.url} (${r.status})`).join(' → ');
      const hasTemp = data.redirectChain.some(r => r.status === 302 || r.status === 307);
      if (hasTemp) {
        checks.push(warn('16', 'Page returns HTTP 200', `Final URL returns 200 but redirect chain contains a temporary redirect:\n${chain}`, 'Convert temporary redirects (302/307) to permanent redirects (301)'));
      } else {
        checks.push(pass('16', 'Page returns HTTP 200', `Returns 200. Redirect chain (${data.redirectChain.length - 1} hop): ${chain}`));
      }
    } else {
      checks.push(pass('16', 'Page returns HTTP 200', `HTTP 200 OK — direct response`));
    }
  } else if (status >= 400) {
    checks.push(fail('16', 'Page returns HTTP 200', `HTTP ${status} error`, `Fix the server error. HTTP ${status} pages cannot be indexed by Google.`));
  } else {
    checks.push(warn('16', 'Page returns HTTP 200', `Unexpected status: ${status}`, 'Verify the URL resolves to a 200 response'));
  }

  // 16.1: meta robots noindex
  const metaRobots = $('meta[name="robots"]').attr('content') || '';
  const metaGooglebot = $('meta[name="googlebot"]').attr('content') || '';
  if (metaRobots.includes('noindex') || metaGooglebot.includes('noindex')) {
    checks.push(fail('16.1', 'No noindex in meta robots', `<meta name="robots" content="${metaRobots || metaGooglebot}">`, 'Remove the noindex directive unless this page is intentionally excluded from indexing'));
  } else if (metaRobots) {
    checks.push(pass('16.1', 'No noindex in meta robots', `<meta name="robots" content="${metaRobots}">`));
  } else {
    checks.push(pass('16.1', 'No noindex in meta robots', 'No meta robots tag — page is indexable by default'));
  }

  // 16.2: X-Robots-Tag header
  const xRobots = (data.responseHeaders['x-robots-tag'] || '').toLowerCase();
  if (xRobots.includes('noindex') || xRobots === 'none') {
    checks.push(fail('16.2', 'No X-Robots-Tag: noindex in HTTP headers', `X-Robots-Tag: ${data.responseHeaders['x-robots-tag']}`, 'Remove the noindex directive from the X-Robots-Tag header'));
  } else if (xRobots) {
    checks.push(warn('16.2', 'No X-Robots-Tag: noindex in HTTP headers', `X-Robots-Tag: ${data.responseHeaders['x-robots-tag']}`, 'Review X-Robots-Tag header — verify it does not block any intended crawlers'));
  } else {
    checks.push(pass('16.2', 'No X-Robots-Tag: noindex in HTTP headers', 'X-Robots-Tag header absent'));
  }

  // 16.3: robots.txt
  if (data.errors.robots) {
    checks.push(manual('16.3', 'URL not blocked by robots.txt', `Could not fetch robots.txt: ${data.errors.robots}`, 'Verify robots.txt is accessible and check for any Disallow rules matching this URL'));
  } else if (data.robotsBlocked) {
    checks.push(fail('16.3', 'URL not blocked by robots.txt', 'URL is blocked by a Disallow rule in robots.txt', 'Remove the Disallow rule for this URL path in robots.txt'));
  } else {
    checks.push(pass('16.3', 'URL not blocked by robots.txt', 'No Disallow rule matches this URL'));
  }

  // 16.4: in sitemap
  if (data.inSitemap === null) {
    checks.push(manual('16.4', 'URL appears in XML sitemap', data.errors.sitemap ? `Sitemap error: ${data.errors.sitemap}` : 'Sitemap could not be checked', 'Manually verify the URL appears in your XML sitemap'));
  } else if (data.inSitemap === false) {
    checks.push(fail('16.4', 'URL appears in XML sitemap', 'URL not found in any accessible XML sitemap', `Add ${data.finalUrl || data.inputUrl} to your XML sitemap and resubmit to Google Search Console`));
  } else {
    checks.push(pass('16.4', 'URL appears in XML sitemap', 'URL found in XML sitemap'));
  }

  return sec(16, 'Crawlability & Indexation', checks);
}

// ── Section 17: Redirects & URL Hygiene ──────────────────────────────────────

function s17(data) {
  const $ = data.$;
  const checks = [];
  const inputUrl = data.inputUrl;
  const finalUrl = data.finalUrl || inputUrl;
  const canonical = ($('link[rel="canonical"]').attr('href') || '').replace(/\/$/, '');
  const normFinal = finalUrl.replace(/\/$/, '');

  // 17: final URL matches canonical
  if (!canonical) {
    checks.push(warn('17', 'Final resolved URL matches canonical', 'No canonical tag to compare against', 'Add a self-referencing canonical tag'));
  } else if (canonical === normFinal) {
    checks.push(pass('17', 'Final resolved URL matches canonical', `Both: "${normFinal}"`));
  } else {
    checks.push(fail('17', 'Final resolved URL matches canonical', `Final URL: "${normFinal}"\nCanonical: "${canonical}"`, 'Update canonical to exactly match the final resolved URL, or fix the redirect chain'));
  }

  // 17.1: redirect chain length
  const hops = data.redirectChain.length;
  if (hops <= 1) {
    checks.push(pass('17.1', 'No redirect chains — resolves in ≤ 1 hop', `${hops} hop(s)`));
  } else if (hops === 2) {
    checks.push(warn('17.1', 'No redirect chains — resolves in ≤ 1 hop', `${hops - 1} redirect hop: ${data.redirectChain.map(r => r.url).join(' → ')}`, 'Single redirect is acceptable but log for awareness'));
  } else {
    checks.push(fail('17.1', 'No redirect chains — resolves in ≤ 1 hop', `${hops - 1} redirect hops:\n${data.redirectChain.map(r => `${r.url} (${r.status})`).join('\n')}`, 'Collapse redirect chain to a single 301 redirect'));
  }

  // 17.2: trailing slash consistency
  const withSlash = finalUrl.endsWith('/');
  const canonWithSlash = canonical ? canonical.endsWith('/') : null;
  if (canonWithSlash !== null && withSlash !== canonWithSlash) {
    checks.push(warn('17.2', 'Trailing slash convention consistent', `Final URL ${withSlash ? 'has' : 'lacks'} trailing slash; canonical ${canonWithSlash ? 'has' : 'lacks'} trailing slash`, 'Ensure trailing slash convention is consistent between the URL and canonical'));
  } else {
    checks.push(pass('17.2', 'Trailing slash convention consistent', `Trailing slash: ${withSlash ? 'present' : 'absent'} — consistent with canonical`));
  }

  // 17.3: HTTP → HTTPS
  if (data.errors.httpRedirect) {
    checks.push(manual('17.3', 'HTTP redirects to HTTPS', `Could not check: ${data.errors.httpRedirect}`, 'Manually verify http:// version redirects to https:// with a 301'));
  } else if (!data.httpRedirect) {
    checks.push(manual('17.3', 'HTTP redirects to HTTPS', 'HTTP redirect check not performed', 'Verify http:// version 301-redirects to https://'));
  } else {
    const { status, location } = data.httpRedirect;
    if (status === 301 && location && (location.startsWith('https://') || location.startsWith('/'))) {
      checks.push(pass('17.3', 'HTTP redirects to HTTPS', `http:// returns 301 → ${location}`));
    } else if (status === 302 && location?.startsWith('https://')) {
      checks.push(warn('17.3', 'HTTP redirects to HTTPS', `http:// returns 302 (temporary) → ${location}`, 'Change HTTP→HTTPS redirect from 302 to 301'));
    } else if (status === 200) {
      checks.push(fail('17.3', 'HTTP redirects to HTTPS', `http:// returns 200 — no redirect to HTTPS`, 'Configure server to 301-redirect all HTTP traffic to HTTPS'));
    } else {
      checks.push(warn('17.3', 'HTTP redirects to HTTPS', `http:// returns ${status}${location ? ` → ${location}` : ''}`, 'Verify HTTP→HTTPS redirect is a 301'));
    }
  }

  return sec(17, 'Redirects & URL Hygiene', checks);
}

// ── Section 18: Mobile Optimization ──────────────────────────────────────────

function s18(data) {
  const $ = data.$;
  const psiM = data.psi.mobile;
  const checks = [];

  // 18: viewport + mobile score
  const viewport = $('meta[name="viewport"]').attr('content') || '';
  const mScore = psiM?.score ?? null;
  if (!viewport) {
    checks.push(fail('18', 'Page passes mobile-friendliness', 'No <meta name="viewport"> tag found', 'Add <meta name="viewport" content="width=device-width, initial-scale=1"> to the <head>'));
  } else if (mScore !== null && mScore < 50) {
    checks.push(fail('18', 'Page passes mobile-friendliness', `viewport present but mobile score: ${mScore}/100`, `Improve mobile performance score from ${mScore} to ≥70`));
  } else {
    checks.push(pass('18', 'Page passes mobile-friendliness', `viewport: "${viewport}"${mScore !== null ? `, mobile score: ${mScore}` : ''}`));
  }

  // 18.1: click-to-call
  const phoneRegex = /(\+?1?[-.\s]?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4})/g;
  const bodyHtml = $('body').html() || '';
  const plainPhones = [];
  const telLinks = $('a[href^="tel:"]').length;
  // Find phone numbers not inside anchor tags
  const textNodes = $('body').clone();
  textNodes.find('a[href^="tel:"]').remove();
  const plainText = textNodes.text();
  const matches = plainText.match(phoneRegex) || [];
  if (matches.length > 0) {
    checks.push(warn('18.1', 'All phone numbers are click-to-call', `${matches.length} plain-text phone number(s) found: ${matches.slice(0, 3).join(', ')}`, `Wrap each phone number in a tel: link: <a href="tel:+1XXXXXXXXXX">${matches[0]}</a>`));
  } else if (telLinks > 0) {
    checks.push(pass('18.1', 'All phone numbers are click-to-call', `${telLinks} tel: link(s) found`));
  } else {
    checks.push(pass('18.1', 'All phone numbers are click-to-call', 'No phone numbers found on page'));
  }

  // 18.2: tap targets
  const tapTargets = psiM?.audits?.tapTargets ?? null;
  if (tapTargets === null) {
    checks.push(manual('18.2', 'Tap targets appropriately sized', 'PSI tap-targets data unavailable', 'Run PageSpeed Insights mobile and check the "Tap targets" audit'));
  } else if (tapTargets < 0.9) {
    checks.push(fail('18.2', 'Tap targets appropriately sized', `PSI tap-targets score: ${Math.round(tapTargets * 100)}%`, 'Increase button/link sizes to at least 48×48px with adequate spacing between touch targets'));
  } else {
    checks.push(pass('18.2', 'Tap targets appropriately sized', `PSI tap-targets score: ${Math.round(tapTargets * 100)}%`));
  }

  // 18.3: no horizontal scroll
  const fixedWidths = (data.html || '').match(/width:\s*([\d]+)px/g) || [];
  const wide = fixedWidths.filter(m => parseInt(m.match(/\d+/)[0]) > 400);
  if (wide.length > 3) {
    checks.push(warn('18.3', 'No horizontal scroll on mobile', `${wide.length} fixed-width CSS values over 400px found in inline styles`, 'Replace fixed pixel widths with percentage-based or max-width responsive values'));
  } else {
    checks.push(pass('18.3', 'No horizontal scroll on mobile', 'No evidence of wide fixed-width elements in inline styles'));
  }

  // 18.4: font sizes
  const fontSize = psiM?.audits?.fontSize ?? null;
  if (fontSize === null) {
    checks.push(manual('18.4', 'Font sizes legible without zooming', 'PSI font-size data unavailable', 'Run PageSpeed Insights mobile and check the "Font sizes" audit'));
  } else if (fontSize < 0.9) {
    checks.push(fail('18.4', 'Font sizes legible without zooming', `PSI font-size score: ${Math.round(fontSize * 100)}%`, 'Ensure body text is at least 16px on mobile. Avoid font-size below 12px for any readable text.'));
  } else {
    checks.push(pass('18.4', 'Font sizes legible without zooming', `PSI font-size score: ${Math.round(fontSize * 100)}%`));
  }

  return sec(18, 'Mobile Optimization', checks);
}

// ── Section 19: HTTPS & Security ─────────────────────────────────────────────

function s19(data) {
  const finalUrl = data.finalUrl || data.inputUrl;
  const html = data.html || '';
  const checks = [];

  const isHttps = finalUrl.startsWith('https://');
  if (!isHttps) {
    checks.push(fail('19', 'Page loads over HTTPS with no mixed content', `Final URL uses HTTP: "${finalUrl}"`, 'Enable HTTPS and configure a 301 redirect from HTTP to HTTPS'));
    return sec(19, 'HTTPS & Security', checks);
  }

  // Check for mixed content
  const httpResources = [];
  const patterns = [/src=["']http:\/\/[^"']+["']/g, /href=["']http:\/\/[^"']+\.(css|js)["']/g, /@import\s+url\(['"]?http:\/\//g];
  for (const p of patterns) {
    const matches = html.match(p) || [];
    httpResources.push(...matches.slice(0, 3));
  }

  if (httpResources.length > 0) {
    checks.push(fail('19', 'Page loads over HTTPS with no mixed content', `HTTPS confirmed but mixed content found:\n${httpResources.slice(0, 5).join('\n')}`, 'Update all resource references to use HTTPS instead of HTTP'));
  } else {
    checks.push(pass('19', 'Page loads over HTTPS with no mixed content', `HTTPS confirmed, no mixed content detected`));
  }

  return sec(19, 'HTTPS & Security', checks);
}

// ── Section 20: Analytics & Tracking ─────────────────────────────────────────

function s20(data) {
  const html = data.html || '';
  const $ = data.$;
  const checks = [];
  const canonical = $('link[rel="canonical"]').attr('href') || '';

  // 20: GA4
  const hasGA4 = /G-[A-Z0-9]{8,}/.test(html);
  const hasGTM = /GTM-[A-Z0-9]+/.test(html);
  const hasGAnalytics = /analytics\.js|gtag\.js/.test(html);

  if (hasGA4) {
    const ga4Id = (html.match(/G-[A-Z0-9]{8,}/) || [])[0];
    checks.push(pass('20', 'GA4 pageview tracking confirmed', `GA4 ID found: ${ga4Id}`));
  } else if (hasGTM) {
    const gtmId = (html.match(/GTM-[A-Z0-9]+/) || [])[0];
    checks.push(manual('20', 'GA4 pageview tracking confirmed', `GTM container found (${gtmId}) but GA4 configuration cannot be confirmed from static HTML`, 'Verify GA4 is firing via Google Tag Assistant or GTM preview mode'));
  } else if (hasGAnalytics) {
    checks.push(warn('20', 'GA4 pageview tracking confirmed', 'analytics.js or gtag.js found but no GA4 measurement ID detected', 'Verify GA4 is implemented. Universal Analytics (UA) has been deprecated.'));
  } else {
    checks.push(fail('20', 'GA4 pageview tracking confirmed', 'No GA4 measurement ID or GTM container found in HTML source', 'Implement GA4 tracking or install Google Tag Manager'));
  }

  checks.push(manual('20.1', 'Conversion events firing correctly', 'Cannot verify event firing from static HTML', 'Use Google Tag Assistant or GA4 DebugView to verify form submission, click, and phone call events are firing correctly'));

  // 20.2: CallRail
  const hasCallRail = /callrail|calltrk\.net|jstag\.min\.js/i.test(html);
  if (hasCallRail) {
    checks.push(pass('20.2', 'Call tracking implemented', 'CallRail or equivalent script detected'));
  } else {
    checks.push(warn('20.2', 'Call tracking implemented', 'No CallRail or call tracking script found', 'Install CallRail (or equivalent) to track phone conversions from organic search'));
  }

  // 20.3: no UTM in canonical
  if (canonical && /[?&]utm_/.test(canonical)) {
    checks.push(fail('20.3', 'No UTM parameters in canonical URL', `Canonical contains UTM parameters: "${canonical}"`, 'Remove UTM parameters from the canonical href — it should always be the clean URL'));
  } else {
    checks.push(pass('20.3', 'No UTM parameters in canonical URL', `Canonical: "${canonical || 'not set'}"`));
  }

  return sec(20, 'Analytics & Tracking', checks);
}

// ── Section 21: E-E-A-T & Trust Signals ──────────────────────────────────────

function s21(data, isYMYL) {
  if (!isYMYL) {
    return sec(21, 'E-E-A-T & Trust Signals', [
      warn('21', 'Author/provider identified with credentials', 'Non-YMYL page — E-E-A-T signals recommended but not required', 'Consider adding author byline for improved trust'),
      na('21.1', 'Medical reviewer attribution'),
      na('21.2', 'Provider credentials or bio page linked'),
      warn('21.3', 'Trust signals visible', 'Non-YMYL page — trust signals recommended', 'Add relevant trust signals (awards, certifications, client logos)'),
    ]);
  }

  const $ = data.$;
  const bodyHtml = $('body').html() || '';
  const bodyText = $('body').text() || '';
  const checks = [];

  // 21: author with credentials
  const credPattern = /\b(MD|DDS|DMD|DO|RN|PhD|LCSW|LMFT|LCPC|Esq|CPA|CFP|Dr\.|Doctor|Dentist|Therapist|Counselor)\b/;
  const authorPattern = /\b(written by|author[:\s]|reviewed by|medically reviewed|by Dr|contributed by)\b/i;
  if (credPattern.test(bodyHtml) && authorPattern.test(bodyHtml)) {
    checks.push(pass('21', 'Author identified with credentials', 'Author attribution and credentials found in page content'));
  } else if (authorPattern.test(bodyHtml)) {
    checks.push(warn('21', 'Author identified with credentials', 'Author attribution found but no credentials/title detected', 'Add professional credentials next to author name (e.g., "Dr. Jane Smith, DDS")'));
  } else {
    checks.push(fail('21', 'Author identified with credentials', 'No author attribution found on YMYL page', 'Add a visible author name with credentials. For dental/medical content: "Dr. [Full Name], [Degree]"'));
  }

  // 21.1: medical reviewer
  const reviewerPattern = /medically reviewed|reviewed by|clinical review|fact-checked/i;
  if (reviewerPattern.test(bodyHtml)) {
    checks.push(pass('21.1', 'Medical reviewer attribution', 'Medical reviewer attribution found'));
  } else {
    checks.push(fail('21.1', 'Medical reviewer attribution for clinical content', 'No "Medically Reviewed by" attribution found', 'Add a "Medically Reviewed by [Name, Credentials]" attribution near the top of the page'));
  }

  // 21.2: bio page linked
  const bioLinks = $('a[href*="/team/"], a[href*="/about/"], a[href*="/bio/"], a[href*="/doctor/"], a[href*="/provider/"], a[href*="/staff/"]').length;
  if (bioLinks > 0) {
    checks.push(pass('21.2', 'Provider credentials or bio page linked', `${bioLinks} bio/team page link(s) found`));
  } else {
    checks.push(warn('21.2', 'Provider credentials or bio page linked', 'No links to bio or team profile pages detected', 'Link author names to their dedicated bio/team pages with credential detail'));
  }

  // 21.3: trust signals
  const trustSignals = [
    /ada\.org|american dental association/i.test(bodyHtml),
    /accredited|accreditation|jcaho|ncqa/i.test(bodyHtml),
    /insurance.*accepted|we accept.*insurance/i.test(bodyHtml),
    $('img[alt*="award"], img[alt*="certified"], img[alt*="accredited"], img[alt*="badge"]').length > 0,
    /\d{3,}[\s+]*(patients|reviews|years)/i.test(bodyText),
  ].filter(Boolean).length;

  if (trustSignals >= 2) {
    checks.push(pass('21.3', 'Trust signals visible (≥2)', `${trustSignals} trust signal(s) detected`));
  } else if (trustSignals === 1) {
    checks.push(warn('21.3', 'Trust signals visible (≥2)', 'Only 1 trust signal detected', 'Add more trust signals: accreditation logos, association memberships, patient counts, or insurance logos'));
  } else {
    checks.push(fail('21.3', 'Trust signals visible (≥2)', 'No trust signals detected on YMYL page', 'Add at least 2 trust signals: professional accreditation logos, association badges, insurance accepted, or patient review count'));
  }

  return sec(21, 'E-E-A-T & Trust Signals', checks);
}

// ── Section 22: Local SEO Signals ─────────────────────────────────────────────

function s22(data, pageType) {
  if (pageType !== 'location') {
    return sec(22, 'Local SEO Signals', [na('22', 'NAP present'), na('22.1', 'Google Maps embed'), na('22.2', 'Business hours displayed'), na('22.3', 'Service area stated'), na('22.4', 'Driving directions included')]);
  }

  const $ = data.$;
  const bodyText = $('body').text() || '';
  const bodyHtml = $('body').html() || '';
  const checks = [];

  // 22: NAP
  const hasPhone = /\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}/.test(bodyText);
  const hasAddress = /\d{3,5}\s+[a-zA-Z].*\b(st|ave|blvd|rd|dr|ln|way|ct|pl|suite)\b/i.test(bodyText);
  const hasName = $('h1, h2, [class*="office"], [class*="location"]').text().length > 5;
  if (hasPhone && hasAddress) {
    checks.push(pass('22', 'NAP (Name, Address, Phone) present', 'Phone number and street address detected in body content'));
  } else if (hasPhone || hasAddress) {
    const missing = !hasPhone ? 'phone number' : 'street address';
    checks.push(warn('22', 'NAP (Name, Address, Phone) present', `Partial NAP — missing ${missing}`, `Add ${missing} to the page content and ensure it matches your schema markup exactly`));
  } else {
    checks.push(fail('22', 'NAP (Name, Address, Phone) present', 'No phone number or street address detected in body content', 'Add full NAP (business name, complete street address, phone number) to the page content'));
  }

  // 22.1: Google Maps embed
  const hasMapsIframe = $('iframe[src*="google.com/maps"], iframe[src*="maps.google.com"]').length > 0;
  if (hasMapsIframe) {
    checks.push(pass('22.1', 'Google Maps embed present', 'Google Maps iframe detected'));
  } else {
    const hasMapsLink = $('a[href*="google.com/maps"], a[href*="maps.google.com"]').length > 0;
    if (hasMapsLink) {
      checks.push(warn('22.1', 'Google Maps embed present', 'Google Maps linked but not embedded as iframe', 'Replace the Maps link with an embedded iframe for better local SEO signals'));
    } else {
      checks.push(fail('22.1', 'Google Maps embed present', 'No Google Maps iframe or link found', 'Add a Google Maps iframe embed showing the business location'));
    }
  }

  // 22.2: business hours
  const hasHours = /\b(mon|tue|wed|thu|fri|sat|sun|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b.*\d{1,2}(:\d{2})?\s*(am|pm)/i.test(bodyText) || /hours.*(am|pm)/i.test(bodyText);
  if (hasHours) {
    checks.push(pass('22.2', 'Business hours displayed', 'Operating hours detected in body content'));
  } else {
    checks.push(fail('22.2', 'Business hours displayed', 'No business hours found in page content', 'Add business hours to the page and ensure they match openingHoursSpecification in schema'));
  }

  // 22.3: service area
  const hasServiceArea = /serving|service area|we serve|patients (from|in|near)|locations (near|around|in)/i.test(bodyText) || /[A-Z][a-z]+,\s*[A-Z]{2}/.test(bodyText);
  if (hasServiceArea) {
    checks.push(pass('22.3', 'Service area stated', 'Service area mention or city/state reference found in content'));
  } else {
    checks.push(fail('22.3', 'Service area stated', 'No geographic service area mentioned in page content', 'Add a sentence explicitly naming the city, region, or zip codes served (e.g., "Serving patients in [City] and surrounding areas")'));
  }

  // 22.4: driving directions
  const hasDirections = /direction|parking|located at|how to find|get here|exit|highway|interstate|take the|turn (left|right)|from [A-Z]/i.test(bodyText);
  if (hasDirections) {
    checks.push(pass('22.4', 'Driving directions or parking info included', 'Directional content detected'));
  } else {
    checks.push(warn('22.4', 'Driving directions or parking info included', 'No directional content found', 'Add a "Getting Here" section with directions, nearby landmarks, and parking information'));
  }

  return sec(22, 'Local SEO Signals', checks);
}

// ── Section 23: Accessibility ─────────────────────────────────────────────────

function s23(data) {
  const $ = data.$;
  const psiM = data.psi.mobile;
  const checks = [];

  // 23: color contrast (PSI proxy)
  const ccScore = psiM?.audits?.colorContrast ?? null;
  const a11yScore = psiM?.accessibilityScore ?? null;
  if (ccScore === null) {
    checks.push(manual('23', 'Color contrast meets WCAG 2.1 AA', `Accessibility score: ${a11yScore ?? 'unavailable'}`, 'Run PageSpeed Insights and review the "Color Contrast" audit, or use axe DevTools in Chrome'));
  } else if (ccScore < 0.9) {
    checks.push(fail('23', 'Color contrast meets WCAG 2.1 AA', `PSI color-contrast score: ${Math.round(ccScore * 100)}%`, 'Fix contrast issues flagged by PageSpeed Insights. Text must meet 4.5:1 contrast ratio (WCAG AA).'));
  } else {
    checks.push(pass('23', 'Color contrast meets WCAG 2.1 AA', `PSI color-contrast score: ${Math.round(ccScore * 100)}%${a11yScore ? `, accessibility score: ${a11yScore}` : ''}`));
  }

  // 23.1: ARIA labels on interactive elements
  const iconBtns = $('button, [role="button"]').toArray().filter(el => {
    const text = $(el).text().trim();
    const ariaLabel = $(el).attr('aria-label') || $(el).attr('aria-labelledby') || '';
    return !text && !ariaLabel;
  });
  if (iconBtns.length > 0) {
    checks.push(fail('23.1', 'Interactive elements have ARIA labels', `${iconBtns.length} button(s) have no visible text and no aria-label`, `Add aria-label to all icon-only buttons. Example: <button aria-label="Close menu">...</button>`));
  } else {
    checks.push(pass('23.1', 'Interactive elements have ARIA labels', 'All detectable interactive elements have accessible labels'));
  }

  // 23.2: form labels
  const inputs = $('input:not([type="hidden"]):not([type="submit"]):not([type="button"]), textarea, select').toArray();
  const unlabeled = inputs.filter(el => {
    const id = $(el).attr('id');
    const ariaLabel = $(el).attr('aria-label') || $(el).attr('aria-labelledby') || '';
    const hasLabel = id ? $(`label[for="${id}"]`).length > 0 : false;
    return !hasLabel && !ariaLabel;
  });
  if (unlabeled.length > 0) {
    checks.push(fail('23.2', 'All form fields have visible labels', `${unlabeled.length} form field(s) have no associated <label> or aria-label`, 'Add <label for="fieldId"> elements to all form fields. Do not rely on placeholder text alone.'));
  } else if (inputs.length === 0) {
    checks.push(na('23.2', 'All form fields have visible labels'));
  } else {
    checks.push(pass('23.2', 'All form fields have visible labels', `${inputs.length} form field(s) — all appear labeled`));
  }

  // 23.3: keyboard navigation (MANUAL + partial heuristic)
  const divOnclicks = $('div[onclick], span[onclick]').toArray().filter(el => !$(el).attr('role') && !$(el).attr('tabindex'));
  if (divOnclicks.length > 0) {
    checks.push(fail('23.3', 'Page is keyboard-navigable', `${divOnclicks.length} <div> or <span> with onclick handlers but no role or tabindex — keyboard users cannot access these`, 'Replace with <button> elements or add role="button" and tabindex="0" with keyboard event handlers'));
  } else {
    checks.push(manual('23.3', 'Page is keyboard-navigable', 'No obvious keyboard-inaccessible onclick handlers found. Full keyboard test requires manual verification.', 'Tab through the page to verify all interactive elements are reachable. Check: does focus order follow logical reading order?'));
  }

  return sec(23, 'Accessibility', checks);
}

// ── Priority action builder ───────────────────────────────────────────────────

const PRIORITY_SCORE = {
  '16.1': 100, '16.3': 98, '16': 95, '13': 88, '4': 85, '4.1': 84,
  '12.1': 82, '2.1': 80, '3': 78, '19': 75, '17.3': 72, '9': 68,
  '5.1': 65, '10': 62, '2': 60, '4.2': 58, '5.7': 55, '16.4': 52,
  '5.4': 50, '18': 48, '20': 45, '5.6': 42, '21': 40, '22': 38,
  '14': 35, '12.2': 33, '3.2': 30, '4.4': 28, '11.1': 25, '17.1': 22,
};

function buildPriorityActions(sections) {
  const failedChecks = [];
  for (const s of sections) {
    for (const c of s.checks) {
      if (c.status === 'fail') {
        failedChecks.push({ sectionName: s.name, check: c });
      }
    }
  }
  // Also include critical warnings
  for (const s of sections) {
    for (const c of s.checks) {
      if (c.status === 'warning' && (PRIORITY_SCORE[c.id] || 0) >= 70) {
        failedChecks.push({ sectionName: s.name, check: c });
      }
    }
  }

  return failedChecks
    .sort((a, b) => (PRIORITY_SCORE[b.check.id] || 0) - (PRIORITY_SCORE[a.check.id] || 0))
    .slice(0, 10)
    .map((item, i) => ({
      rank: i + 1,
      sectionName: item.sectionName,
      checkId: item.check.id,
      issue: item.check.label,
      status: item.check.status,
      why: getWhyItMatters(item.check.id),
      fix: item.check.recommendation || 'See check evidence for details',
    }));
}

function getWhyItMatters(checkId) {
  const map = {
    '16.1': 'noindex prevents Google from indexing the page — it will never rank',
    '16.3': 'robots.txt block prevents Googlebot from crawling the page',
    '16': 'Non-200 status codes cannot be indexed or ranked',
    '13': 'Missing canonical invites duplicate content issues and splits link equity',
    '4': 'Google uses H1 as a primary signal for page topic relevance',
    '4.1': 'Multiple H1 tags confuse crawlers about the primary topic',
    '12.1': 'Poor Core Web Vitals are a ranking signal and directly harm user experience',
    '2.1': 'Missing title tag is one of the most impactful technical SEO deficiencies',
    '3': 'Meta description controls SERP click-through rate',
    '19': 'Mixed content breaks HTTPS security and may trigger browser warnings',
    '17.3': 'HTTP pages without redirect are served unsecurely and lose PageRank',
    '9': 'Schema enables rich results which significantly increase SERP visibility',
    '5.1': 'Thin content is a primary reason pages fail to rank for competitive keywords',
    '10': 'Missing alt text loses keyword relevance signals and fails accessibility',
    '2': 'Titles over 60 characters are truncated in SERPs, reducing CTR',
    '4.2': 'Primary keyword in H1 is a direct on-page relevance signal',
    '5.7': 'No CTA means visitors cannot convert — organic traffic produces no ROI',
    '16.4': 'Pages absent from sitemap are discovered more slowly by Googlebot',
    '5.4': 'E-E-A-T is a critical ranking factor for YMYL content',
    '18': 'Mobile-first indexing means Google ranks based on mobile version',
    '20': 'Missing analytics means no conversion data, no ROI measurement',
  };
  return map[checkId] || 'Resolving this issue will improve search visibility and user experience';
}

function collectManualItems(sections) {
  const items = [];
  for (const s of sections) {
    for (const c of s.checks) {
      if (c.status === 'manual') {
        items.push({
          sectionId: s.id,
          sectionName: s.name,
          checkId: c.id,
          label: c.label,
          evidence: c.evidence,
          instructions: c.recommendation || 'Requires manual verification',
        });
      }
    }
  }
  return items;
}

// ── Main export ───────────────────────────────────────────────────────────────

async function runAudit(url, primaryKeywords, onProgress) {
  const id = genId();
  const kws = (Array.isArray(primaryKeywords) ? primaryKeywords : [primaryKeywords]).filter(Boolean);

  const audit = {
    id,
    url,
    primaryKeywords: kws,
    auditDate: new Date().toISOString(),
    status: 'running',
    progress: '',
    pageType: null,
    isYMYL: false,
    sections: [],
    priorityActions: [],
    manualItems: [],
    dataErrors: {},
  };

  // Phase 1: data collection
  const data = await collectData(url, (msg) => {
    audit.progress = msg;
    onProgress?.(msg);
  });
  audit.dataErrors = data.errors;

  if (!data.$ && !data.html) {
    audit.status = 'failed';
    audit.errorMessage = `Failed to fetch page: ${data.errors.html || 'unknown error'}`;
    await saveAudit(audit);
    return audit;
  }

  // Phase 2: page type detection
  onProgress?.('Detecting page type…');
  const { pageType, isYMYL } = detectPageType(data);
  audit.pageType = pageType;
  audit.isYMYL = isYMYL;

  // Phase 3: run all 23 sections
  onProgress?.('Running SEO audit checks…');
  audit.sections = [
    s1(data, kws),
    s2(data, kws),
    s3(data, kws),
    s4(data, kws),
    s5(data, kws, pageType, isYMYL),
    s6(data, pageType),
    s7(),
    s8(data, pageType, isYMYL),
    s9(data, pageType),
    s10(data, kws),
    s11(data),
    s12(data),
    s13(data),
    s14(data),
    s15(data),
    s16(data),
    s17(data),
    s18(data),
    s19(data),
    s20(data),
    s21(data, isYMYL),
    s22(data, pageType),
    s23(data),
  ];

  // Phase 4: priority actions + manual items
  onProgress?.('Generating priority action list…');
  audit.priorityActions = buildPriorityActions(audit.sections);
  audit.manualItems = collectManualItems(audit.sections);
  audit.status = 'complete';

  await saveAudit(audit);
  return audit;
}

/**
 * The pass rate this module has always shown on its own report.
 *
 * `manual` and `na` are excluded from the denominator, and that exclusion is the
 * substance of the methodology rather than a detail:
 *
 *   • `manual` is a check no automated audit can settle — "verify the accuracy of
 *     these clinical claims". Counting it as a failure would punish a page for a
 *     question nobody asked a human yet.
 *   • `na` is a check that does not apply, which now includes every keyword check
 *     on a page with no target keyword. Counting those would score a page down
 *     for a keyword its owner never set.
 *
 * So the number answers: of the checks that could be judged automatically, what
 * share passed. The report has displayed exactly this since before the project
 * layer existed; this is the same arithmetic, moved to where both the report and
 * the project run can read it, so the two can never disagree.
 *
 * @returns {{ score: number|null, counts: object, scored: number, total: number }}
 *   score is null when nothing could be judged — never 0, which would read as a
 *   page that failed everything rather than one nothing applied to.
 */
function passRate(audit) {
  const counts = { pass: 0, fail: 0, warning: 0, manual: 0, na: 0 };
  for (const section of (audit?.sections || [])) {
    for (const check of (section.checks || [])) {
      if (counts[check.status] === undefined) continue;
      counts[check.status] += 1;
    }
  }
  const scored = counts.pass + counts.fail + counts.warning;
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return {
    score: scored > 0 ? Math.round((counts.pass / scored) * 100) : null,
    counts,
    scored,
    total,
  };
}

module.exports = { runAudit, passRate };
