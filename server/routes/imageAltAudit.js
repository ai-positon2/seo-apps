const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const axios = require('axios');
const cheerio = require('cheerio');
// SSRF guard, shared with contentArchitect rather than reimplemented (see call site).
const { assertPublicHost } = require('../modules/contentArchitect/urlSafety');
const ExcelJS = require('exceljs');
const OpenAI = require('openai');

// ── In-memory stores ─────────────────────────────────────────────────────────
const sessions = new Map();   // token → { urls, config }
const downloads = new Map();  // token → { buffer, filename }

function generateToken() {
  return crypto.randomBytes(16).toString('hex');
}

// ── Defaults ─────────────────────────────────────────────────────────────────
// All client-specific values are blank by default so the tool is site-agnostic.
// concurrency stays at a sensible universal default.
const DEFAULT_CONFIG = {
  brandName: '',
  locationSuffix: '',
  sitewidePrefix: '',
  locationPrefix: '',
  plansFilenames: [],
  concurrency: 5,
};

// ── DOM / URL helpers ─────────────────────────────────────────────────────────

function getFilename(src) {
  try { return new URL(src).pathname.split('/').pop() || ''; }
  catch { return src.split('/').pop() || ''; }
}

function getCdnFolderId(src) {
  try {
    const parts = new URL(src).pathname.split('/').filter(Boolean);
    // Webflow CDN path: /{24-char-folder-id}/{asset-hash}_{filename}
    if (parts.length >= 1 && /^[a-f0-9]{24}$/i.test(parts[0])) return parts[0];
    return '';
  } catch { return ''; }
}

function getSectionText(imgEl, $) {
  // Walk up ancestors; at each level also scan preceding siblings for headings.
  // This covers Webflow's pattern where section headings are siblings, not parents.
  let node = $(imgEl);
  for (let i = 0; i < 15; i++) {
    node = node.parent();
    if (!node.length) break;

    const tag = (node.prop('tagName') || '').toUpperCase();
    if (tag === 'H2' || tag === 'H3') return node.text().trim();

    // Direct child headings
    const childH2 = node.children('h2').first().text().trim();
    if (childH2) return childH2;
    const childH3 = node.children('h3').first().text().trim();
    if (childH3) return childH3;

    // Preceding siblings (heading that labels this section)
    let prev = node.prev();
    while (prev.length) {
      const prevTag = (prev.prop('tagName') || '').toUpperCase();
      if (prevTag === 'H2' || prevTag === 'H3') return prev.text().trim();
      const prevHeading = prev.find('h2, h3').last().text().trim();
      if (prevHeading) return prevHeading;
      prev = prev.prev();
    }
  }
  return '';
}

// Generic call-to-action link text that is never a meaningful image subject.
// Without this filter, a "View All" CTA becomes the alt/service name
// (e.g. "View All at Jamaica Plain") for before/after and article thumbnails.
const GENERIC_ANCHOR_RE = /^(view|see|read|learn|find out|show)\s+(all|more|details)$|^(book( now| online| an appointment)?|schedule( now)?|call( now)?|contact( us)?|get started|explore|details|more|next|previous|view all|read more|learn more)$/i;

function isUsefulAnchor(t) {
  return t.length > 2 && !GENERIC_ANCHOR_RE.test(t);
}

function getAnchorText(imgEl, $) {
  let node = $(imgEl);
  for (let i = 0; i < 10; i++) {
    node = node.parent();
    if (!node.length) break;
    const tag = (node.prop('tagName') || '').toUpperCase();
    if (tag === 'A') {
      const t = node.text().trim();
      if (isUsefulAnchor(t)) return t;
    }
    // Prefer service links first
    const serviceLink = node.find('a[href*="/dental-services/"]').first();
    if (serviceLink.length) {
      const t = serviceLink.text().trim();
      if (isUsefulAnchor(t)) return t;
    }
    const a = node.find('a').first();
    if (a.length) {
      const t = a.text().trim();
      if (isUsefulAnchor(t)) return t;
    }
  }
  return '';
}

function getDoctorInfo(imgEl, $) {
  let node = $(imgEl).parent();
  for (let i = 0; i < 8; i++) {
    if (!node.length) break;

    const texts = [];
    node.find('h3, h4, p, .name, .doctor-name, [class*="doctor"], [class*="team"]').each((_, el) => {
      const t = $(el).text().trim();
      if (t && t.length < 200) texts.push(t);
    });

    if (texts.length > 0) {
      const nameEntry = texts.find(t =>
        /\b(dds|dmd|md|do)\b/i.test(t) || /^dr\.?\s+/i.test(t)
      );
      if (nameEntry) {
        const credMatch = nameEntry.match(/,?\s*(dds|dmd|md|do)\b/i);
        const credential = credMatch ? credMatch[1].toUpperCase() : 'DDS';
        const name = nameEntry
          .replace(/^dr\.?\s+/i, '')
          .replace(/,?\s*(dds|dmd|md|do)\b.*/i, '')
          .trim();

        const specialty = texts.find(t =>
          t !== nameEntry &&
          /dentist|specialist|orthodont|periodon|endodon|oral|pediatric|sedation|general|restorat|cosmetic|implant/i.test(t)
        ) || '';

        if (name) return { name, credential, specialty };
      }
    }
    node = node.parent();
  }
  return null;
}

// ── Filename utilities ────────────────────────────────────────────────────────

// A base name is only "non-descriptive" when the WHOLE name is a generic token
// (optionally with a trailing number) — not merely because it starts with one.
// Previously `image-bluecross-blueshield-logo` matched and got truncated to `image`.
const NON_DESCRIPTIVE_RE = /^(?:untitled|img|dsc|image|photo)(?:[-_]?\d+)?$|^\d+$/i;

// Matches one trailing image extension. Applied repeatedly to peel Drupal image-style
// double extensions like `logo.png.webp` (which otherwise leave ".Png" in the alt text).
const IMAGE_EXT_RE = /\.(?:jpe?g|png|webp|gif|svg|avif|bmp|tiff?)$/i;

function slugify(text) {
  return (text || '')
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function cleanFilenameBase(filename) {
  let base = (filename || '').split('?')[0];         // drop any query string (e.g. ?itok=)
  base = base.replace(/^[a-f0-9]{6,}_/i, '');        // strip hash prefix (6+ hex, so words like "aetna_" survive)
  while (IMAGE_EXT_RE.test(base)) {                  // strip ALL trailing image extensions (.png.webp → )
    base = base.replace(IMAGE_EXT_RE, '');
  }
  base = base.replace(/-\d+x\d+/g, '');             // strip dimension suffix
  base = base.replace(/^[a-z]{2}\./i, '');           // strip locale prefix (e.g. nc.)
  base = base.replace(/_\d+$/, '');                  // strip Drupal dedup suffix (_0, _1) — keeps years like -2018
  return base;
}

function isNonDescriptive(filename) {
  return NON_DESCRIPTIVE_RE.test(cleanFilenameBase(filename));
}

function getLocationSlug(url) {
  try {
    const parts = new URL(url).pathname.split('/').filter(Boolean);
    return parts[parts.length - 1] || 'location';
  } catch { return 'location'; }
}

function suggestFilename(filename, type, locationSlug, doctorInfo, serviceName, planName) {
  const ext = (filename.split('.').pop() || 'jpg').toLowerCase();
  let descriptive = '';

  switch (type) {
    case 'DOCTOR':
      if (doctorInfo?.name) {
        const cred = (doctorInfo.credential || 'DDS').toLowerCase();
        descriptive = `dr-${slugify(doctorInfo.name)}-${cred}-dentist`;
      } else {
        descriptive = isNonDescriptive(filename) ? 'dentist' : slugify(cleanFilenameBase(filename));
      }
      break;

    case 'SERVICE':
      descriptive = serviceName
        ? slugify(serviceName)
        : isNonDescriptive(filename) ? 'dental-service' : slugify(cleanFilenameBase(filename));
      break;

    case 'DENTAL_PLAN':
      descriptive = planName === 'Adult' ? 'adult-dental-membership-plan' : 'child-dental-membership-plan';
      break;

    case 'HERO_BANNER': {
      const base = cleanFilenameBase(filename);
      descriptive = isNonDescriptive(filename) ? 'dental-office' : slugify(base);
      break;
    }

    default: {
      const base = cleanFilenameBase(filename);
      descriptive = isNonDescriptive(filename) ? 'image' : slugify(base);
    }
  }

  descriptive = descriptive.replace(/^-+|-+$/g, '') || 'image';
  return `${descriptive}-${locationSlug}.${ext}`;
}

// ── Classification ────────────────────────────────────────────────────────────

const DOCTOR_FILENAME_SIGNALS = ['-dds', '-dmd', '-md.', '-do.', 'dr-', '_dr-', '-dds.', '-dmd.'];
const SERVICE_FILENAME_SIGNALS = [
  'dental-seal', 'dental-x-ray', 'denture', 'implant', 'crown', 'root-canal',
  'cancer-screen', 'tmj', 'tmd', 'tooth-decay', 'whitening', 'orthodont',
  'emergency', 'extraction', 'veneer', 'bonding', 'filling', 'hygiene',
  'cleaning', 'invisible', 'braces', 'retainer', 'nightguard', 'mouthguard',
  'sedation', 'pediatric', 'invisalign', 'fluoride', 'perio', 'oral-surgery',
];

function classifyByFilename(filename) {
  const lf = filename.toLowerCase();
  if (DOCTOR_FILENAME_SIGNALS.some(s => lf.includes(s))) return 'DOCTOR';
  if (SERVICE_FILENAME_SIGNALS.some(s => lf.includes(s))) return 'SERVICE';
  return 'UNKNOWN';
}

function classifyImage(filename, cdnFolder, sectionText, anchorText, config) {
  const lf = filename.toLowerCase();
  const ls = (sectionText || '').toLowerCase();
  const la = (anchorText || '').toLowerCase();
  const sitewide = (config.sitewidePrefix || '').trim();
  const location = (config.locationPrefix || '').trim();
  const hasPrefix = !!(sitewide || location);

  // 1. Plan images (only when plan filename signals are configured)
  if (config.plansFilenames.length && config.plansFilenames.some(p => lf.includes(p.toLowerCase()))) return 'DENTAL_PLAN';

  // When no CDN prefix is configured, do NOT auto-classify decorative — there is
  // no reliable signal. Treat everything as content; classify by filename/section only.
  // (Guards against the empty-string match bug where cdnFolder '' === prefix '' .)
  if (!hasPrefix) {
    const byFilename = classifyByFilename(filename);
    if (byFilename !== 'UNKNOWN') return byFilename;
    if (/doctor|meet our|our team/i.test(ls)) return 'DOCTOR';
    if (/service|our services/i.test(ls) || la.includes('/dental-services/')) return 'SERVICE';
    return 'UNKNOWN';
  }

  // 2. Hero Banner
  if (sitewide && cdnFolder === sitewide && (lf.includes('banner') || lf.includes('location-map'))) return 'HERO_BANNER';

  // 3. Doctor (section signal)
  if (location && cdnFolder === location && /doctor|meet our|our team/i.test(ls)) return 'DOCTOR';

  // 4. Service (section signal or service link)
  if (location && cdnFolder === location && (/service|our services/i.test(ls) || la.includes('/dental-services/'))) return 'SERVICE';

  // 5. Filename-based fallback for location CDN images with no section context
  if (location && cdnFolder === location) {
    const byFilename = classifyByFilename(filename);
    if (byFilename !== 'UNKNOWN') return byFilename;
  }

  // 6. Sitewide Decorative
  if (sitewide && cdnFolder === sitewide) return 'SITEWIDE_DECORATIVE';

  // 7. Unknown
  return 'UNKNOWN';
}

// ── Alt tag generation ────────────────────────────────────────────────────────

function evaluateExistingAlt(alt) {
  if (!alt || !alt.trim()) return 'No';
  const lower = alt.toLowerCase().trim();
  const generic = ['image', 'photo', 'picture', 'img', 'untitled', 'placeholder', '.jpg', '.png', '.webp'];
  if (generic.some(g => lower === g) || /^(img|dsc|image|photo)\s*\d*$/i.test(lower)) return 'Yes (generic)';
  if (alt.trim().length < 20) return 'Yes (improve)';
  return 'Yes (good)';
}

function generateAltTag(type, config, locationName, doctorInfo, serviceName, planName, existingAlt) {
  const { brandName, locationSuffix } = config;
  const loc = locationName || 'Location';

  switch (type) {
    case 'DOCTOR':
      if (doctorInfo?.name) {
        const { name, credential, specialty } = doctorInfo;
        if (specialty) return `Dr. ${name}, ${credential} – ${specialty} at ${brandName} ${loc}${locationSuffix}`;
        return `Dr. ${name}, ${credential} – Dentist at ${brandName} ${loc}${locationSuffix}`;
      }
      return `Dentist at ${brandName} ${loc}${locationSuffix}`;

    case 'SERVICE':
      return `${serviceName || 'Dental service'} at ${brandName} ${loc}${locationSuffix}`;

    case 'DENTAL_PLAN': {
      const plan = planName === 'Adult' ? 'Adult dental membership plan' : 'Child dental membership plan';
      return `${plan} at ${brandName} – affordable dental care in ${loc}${locationSuffix}`;
    }

    case 'HERO_BANNER': {
      // Always build a fresh string — never concatenate onto existing alt verbatim.
      // Map images have location-specific existing alt that is wrong on other pages → force GPT.
      const existing = (existingAlt || '').trim().replace(/\.$/, '');
      const isMapImage = /map|location-map/i.test(existingAlt || '');
      if (!isMapImage && existing.length > 20) {
        return `${existing} at ${brandName} in ${loc}${locationSuffix}`;
      }
      return null; // → GPT fallback
    }

    case 'SITEWIDE_DECORATIVE':
      return '';

    default:
      return '';
  }
}

// Bug 3: best-effort fallback for images that remain UNKNOWN after all classifiers.
// Brand- and location-agnostic: only appends brand / location when they are provided.
function fallbackAltTag(filename, locationName, config, sectionText, existingAlt) {
  let base = cleanFilenameBase(filename)
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase())
    .trim();
  base = base.replace(/^Image\s+(?=\S)/, ''); // drop leading "Image" filename artifact (e.g. Drupal "image-bluecross-…")
  const subject = base || 'Image';
  const brand = (config.brandName || '').trim();
  const loc = `${(locationName || '').trim()}${config.locationSuffix || ''}`.trim();

  // Brand assets (logos, insurance/payment/award badges) are byte-identical across
  // every location page — appending " in {location}" is inaccurate and reads as spam.
  const isBrandAsset =
    /logo|badge|award|readers?-?choice|honorable|magazine|best-of/i.test(filename) ||
    /logo/i.test(existingAlt || '') ||
    /insurance|payment|we accept|accepted|award|recognition|membership/i.test(sectionText || '');

  const parts = [subject];
  if (brand) parts.push('at', brand);
  if (loc && !isBrandAsset) parts.push('in', loc);
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

async function generateHeroAltWithGPT(imageUrl, locationName, config, openai) {
  const brandLabel = (config.brandName || '').trim() || 'this website';
  const loc = (locationName || '').trim();
  const prompt = `You are an SEO specialist writing an image alt tag for ${brandLabel}.\n${loc ? `Page location: ${loc}\n` : ''}\nWrite a single, concise alt tag (under 125 characters) that:\n- Describes what is literally visible in the image\n- Naturally includes the brand name${loc ? ' and location' : ''} where appropriate\n- Does not assume any particular industry\n- Does not start with 'Image of' or 'Photo of'\n- Is written as a plain string with no quotes or punctuation at the end\n\nReturn only the alt tag text. Nothing else.`;

  const response = await openai.chat.completions.create({
    model: 'gpt-4o',
    max_tokens: 100,
    messages: [{
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: imageUrl } },
        { type: 'text', text: prompt }
      ]
    }]
  });

  return response.choices[0].message.content.trim();
}

// ── AI-inferred image categories (Change 5, Option A) ──────────────────────────
// One lightweight text call per page categorizes every content image by its role,
// using site-agnostic labels inferred from filename, existing alt, and section.
// Returns { [index]: label } or null on failure (caller falls back to heuristic type).
async function inferImageCategories(images, pageContext, openai) {
  if (!images.length) return null;
  const list = images.map((img, i) =>
    `${i}. filename="${img.filename}" alt="${(img.existingAlt || '').slice(0, 80)}" section="${(img.section || '').slice(0, 60)}"`
  ).join('\n');

  const prompt = `You are categorizing images on a single web page so they can be grouped in an SEO report.
Page context: ${pageContext}

For each image, assign a SHORT category label (1–3 words) describing its ROLE on the page, inferred from its filename, existing alt text, and section heading. Use site-agnostic labels that fit ANY industry (law firm, SaaS, retail, healthcare, etc.). Pick the best fit or invent a better short label. Example roles: "Team / Person", "Service", "Product", "Hero / Banner", "Logo / Brand", "Pricing / Plan", "Map / Location", "Gallery / Photo", "Icon / Decorative", "Other".

Images:
${list}

Return ONLY JSON in the form {"categories":[{"i":0,"label":"..."}]} with exactly one entry per image index.`;

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 700,
      response_format: { type: 'json_object' },
      messages: [{ role: 'user', content: prompt }],
    });
    const parsed = JSON.parse(response.choices[0].message.content || '{}');
    const map = {};
    for (const c of (parsed.categories || [])) {
      if (typeof c.i === 'number' && c.label) map[c.i] = String(c.label).trim();
    }
    return map;
  } catch (err) {
    console.warn(`[image-alt-audit] category inference failed: ${err.message}`);
    return null;
  }
}

function getRenamePriority(filename, type) {
  if (isNonDescriptive(filename)) return 'Critical';
  if (type === 'UNKNOWN') return 'High';
  // If after stripping the hash prefix the base name is still mostly a hash/id
  const base = cleanFilenameBase(filename);
  if (/^[a-f0-9]{10,}$/i.test(base)) return 'High';
  return 'OK';
}

// ── URL processor ─────────────────────────────────────────────────────────────

async function processUrl(pageUrl, config, openai) {
  const startTime = Date.now();
  const logEntry = {
    url: pageUrl, status: 'Success', httpStatus: null, error: null,
    timestamp: new Date().toISOString(), duration: 0,
  };

  try {
    const response = await axios.get(pageUrl, {
      timeout: 15000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AltTagAudit/1.0; +https://arena.position2.com)', Accept: 'text/html' },
      maxRedirects: 5,
    });
    logEntry.httpStatus = response.status;

    const $ = cheerio.load(response.data);

    // Bug 1 fix: always derive location name from URL slug, never from H1.
    // H1 on these pages is a full SEO title like "Trusted Dentists in Concord, NC…"
    // which cascades into broken alt tags and impossibly long filenames.
    const urlSlug = getLocationSlug(pageUrl);  // e.g. "high-point"
    const locationName = urlSlug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()); // "High Point"

    // Bug 5 fix: locationSlug for filenames includes the state code (e.g. "high-point-nc")
    // when a location suffix is provided; otherwise just the URL slug (site-agnostic).
    const stateCode = (config.locationSuffix || '').replace(/[^a-z]/gi, '').toLowerCase();
    const locationSlug = stateCode ? `${urlSlug}-${stateCode}` : urlSlug;

    const contentImages = [];
    const decorativeImages = [];

    for (const imgEl of $('img').toArray()) {
      const rawSrc = $(imgEl).attr('src') || $(imgEl).attr('data-src') || '';
      if (!rawSrc || rawSrc.startsWith('data:')) continue;

      let src;
      try { src = new URL(rawSrc, pageUrl).href; } catch { continue; }

      const filename = getFilename(src);
      if (!filename) continue;

      // Skip Webflow placeholder
      if (src.includes('plugins/Basic/assets/placeholder')) continue;

      // Skip SVGs unless logo
      const lf = filename.toLowerCase();
      if (lf.endsWith('.svg') && !lf.includes('logo')) continue;

      // Skip icon/UI patterns
      if (/\b(icon|check|shield|quotes|alarm|search)\b/i.test(filename)) continue;

      const alt = $(imgEl).attr('alt') || '';
      const cdnFolder = getCdnFolderId(src);
      const sectionText = getSectionText(imgEl, $);
      const anchorText = getAnchorText(imgEl, $);
      const type = classifyImage(filename, cdnFolder, sectionText, anchorText, config);

      // Decorative → Sheet 2
      if (type === 'SITEWIDE_DECORATIVE') {
        const isLogo = lf.includes('logo');
        decorativeImages.push({
          pageUrl, locationName,
          section: sectionText, src, filename,
          purpose: isLogo ? 'Brand logo' : 'UI decorative element / sitewide icon',
          treatment: isLogo ? `alt="${config.brandName} logo"` : 'alt="" aria-hidden="true"',
        });
        continue;
      }

      // Type-specific context
      let doctorInfo = null, serviceName = '', planName = '', notes = '';

      if (type === 'DOCTOR') {
        doctorInfo = getDoctorInfo(imgEl, $);
        if (!doctorInfo) notes = 'Doctor name not found in DOM';
      } else if (type === 'SERVICE') {
        serviceName = anchorText;
        if (!serviceName) {
          const base = cleanFilenameBase(filename);
          serviceName = base.replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).trim();
          notes = 'Service name derived from filename';
        }
      } else if (type === 'DENTAL_PLAN') {
        planName = lf.includes('pricing-1') ? 'Adult' : 'Child';
      }

      // Generate alt tag
      let suggestedAlt = generateAltTag(type, config, locationName, doctorInfo, serviceName, planName, alt);

      if (suggestedAlt === null && type === 'HERO_BANNER') {
        try {
          suggestedAlt = await generateHeroAltWithGPT(src, locationName, config, openai);
          notes = (notes ? notes + ' | ' : '') + 'GPT-4o vision used';
        } catch (err) {
          suggestedAlt = '';
          notes = (notes ? notes + ' | ' : '') + `GPT error: ${err.message.substring(0, 80)}`;
          console.warn(`[image-alt-audit] GPT error for ${src}: ${err.message}`);
        }
      }

      // Bug 3: generate a best-effort fallback alt for anything still UNKNOWN
      if (type === 'UNKNOWN' && !suggestedAlt) {
        suggestedAlt = fallbackAltTag(filename, locationName, config, sectionText, alt);
        notes = (notes ? notes + ' | ' : '') + 'Fallback alt – classification failed, review manually';
      }

      // Normalize whitespace so an empty brand/location never leaves a double space
      // (e.g. "Veneers at  Jamaica Plain") or a dangling connective.
      suggestedAlt = (suggestedAlt || '').replace(/\s+/g, ' ').replace(/\s+(at|in)\s*$/i, '').trim();

      const renamePriority = getRenamePriority(filename, type);
      if (renamePriority === 'Critical') {
        notes = (notes ? notes + ' | ' : '') + 'RENAME_CRITICAL';
      }

      const typeLabel = type === 'DENTAL_PLAN' ? 'Dental Plan'
        : type === 'HERO_BANNER' ? 'Hero Banner'
        : type === 'UNKNOWN' ? 'Unknown'
        : type.charAt(0) + type.slice(1).toLowerCase();

      contentImages.push({
        pageUrl, locationName,
        type: typeLabel,
        rawType: type,
        section: sectionText,
        existingAlt: alt,
        src, filename,
        suggestedFilename: suggestFilename(filename, type, locationSlug, doctorInfo, serviceName, planName),
        suggestedAlt: suggestedAlt || '',
        hasAlt: evaluateExistingAlt(alt),
        renamePriority,
        notes,
      });
    }

    // Change 5 (Option A): AI-infer a site-agnostic category for each content image.
    // Best-effort — falls back to the heuristic type label if the call fails.
    if (contentImages.length) {
      let pageContext = locationName || '';
      try { pageContext = `${pageContext} (${new URL(pageUrl).hostname})`.trim(); } catch { /* keep */ }
      const catMap = await inferImageCategories(contentImages, pageContext, openai);
      contentImages.forEach((img, i) => {
        img.category = (catMap && catMap[i]) || img.type;
      });
    }

    logEntry.duration = Date.now() - startTime;
    return { success: true, pageUrl, locationName, contentImages, decorativeImages, logEntry };

  } catch (err) {
    logEntry.status = 'Failed';
    logEntry.httpStatus = err.response?.status || null;
    logEntry.error = err.message;
    logEntry.duration = Date.now() - startTime;
    return { success: false, pageUrl, locationName: '', contentImages: [], decorativeImages: [], logEntry };
  }
}

// ── Concurrency runner ────────────────────────────────────────────────────────

async function runWithConcurrency(items, concurrency, fn) {
  const results = new Array(items.length);
  let index = 0;
  async function worker() {
    while (index < items.length) {
      const i = index++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

// ── Excel builder ─────────────────────────────────────────────────────────────

// Palette for dynamic, AI-inferred categories (assigned on first appearance).
const CATEGORY_PALETTE = [
  'FFE8F0FE', 'FFE6F4EA', 'FFFFF8E1', 'FFFCE4EC', 'FFFFE0B2',
  'FFE0F2F1', 'FFF3E5F5', 'FFEDE7F6', 'FFFFF3E0', 'FFE1F5FE',
];

function applyHeaderStyle(row) {
  row.height = 22;
  row.eachCell(cell => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A5F' } };
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
    cell.alignment = { vertical: 'middle', horizontal: 'left', wrapText: false };
  });
}

function applyDataStyle(row, argbColor) {
  row.height = 17;
  row.eachCell(cell => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: argbColor } };
    cell.font = { size: 10 };
    cell.alignment = { vertical: 'middle', wrapText: false };
  });
}

async function buildExcel(results, config, brandSlug) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'SEO Automation · Arena';
  wb.created = new Date();

  // Assign a stable palette color to each distinct AI-inferred category.
  const categoryColors = {};
  let paletteIdx = 0;
  const colorForCategory = (cat) => {
    const key = ((cat || 'Other').trim()) || 'Other';
    if (!categoryColors[key]) {
      categoryColors[key] = CATEGORY_PALETTE[paletteIdx % CATEGORY_PALETTE.length];
      paletteIdx++;
    }
    return categoryColors[key];
  };

  // ── Sheet 1: Content Images ────────────────────────────────────────────────
  const s1 = wb.addWorksheet('Content Images');
  s1.columns = [
    { key: 'a', width: 40 }, { key: 'b', width: 22 }, { key: 'c', width: 14 },
    { key: 'd', width: 26 }, { key: 'e', width: 52 }, { key: 'f', width: 38 },
    { key: 'g', width: 42 }, { key: 'h', width: 55 }, { key: 'i', width: 14 },
    { key: 'j', width: 15 }, { key: 'k', width: 38 },
  ];
  const h1Row = s1.addRow(['Page URL', 'Location Name', 'Image Type', 'Section', 'Current Full URL', 'Current Filename', 'Suggested Filename', 'Suggested Alt Tag', 'Has Alt Tag?', 'Rename Priority', 'Notes']);
  applyHeaderStyle(h1Row);

  for (const r of results) {
    for (const img of r.contentImages) {
      const category = img.category || img.type;
      const row = s1.addRow([
        img.pageUrl, img.locationName, category, img.section,
        img.src, img.filename, img.suggestedFilename, img.suggestedAlt,
        img.hasAlt, img.renamePriority, img.notes,
      ]);
      applyDataStyle(row, colorForCategory(category));
    }
  }

  // ── Sheet 2: Decorative Images ─────────────────────────────────────────────
  const s2 = wb.addWorksheet('Decorative Images');
  s2.columns = [
    { key: 'a', width: 40 }, { key: 'b', width: 22 }, { key: 'c', width: 26 },
    { key: 'd', width: 52 }, { key: 'e', width: 38 }, { key: 'f', width: 30 },
    { key: 'g', width: 38 },
  ];
  const h2Row = s2.addRow(['Page URL', 'Location Name', 'Section', 'Current Full URL', 'Current Filename', 'Purpose', 'Recommended Treatment']);
  applyHeaderStyle(h2Row);

  for (const r of results) {
    for (const img of r.decorativeImages) {
      const row = s2.addRow([img.pageUrl, img.locationName, img.section, img.src, img.filename, img.purpose, img.treatment]);
      applyDataStyle(row, 'FFF9FAFB');
    }
  }

  // ── Sheet 3: Summary by Page ───────────────────────────────────────────────
  const s3 = wb.addWorksheet('Summary by Page');
  s3.columns = [
    { key: 'a', width: 40 }, { key: 'b', width: 22 }, { key: 'c', width: 14 },
    { key: 'd', width: 15 }, { key: 'e', width: 18 }, { key: 'f', width: 16 },
    { key: 'g', width: 16 }, { key: 'h', width: 16 }, { key: 'i', width: 14 },
    { key: 'j', width: 12 },
  ];
  const h3Row = s3.addRow(['Page URL', 'Location Name', 'Total Images', 'Content Images', 'Decorative Images', 'Missing Alt Tags', 'Generic Alt Tags', 'Critical Renames', 'Unknown Images', 'Status']);
  applyHeaderStyle(h3Row);

  for (const r of results) {
    const ci = r.contentImages;
    const row = s3.addRow([
      r.pageUrl,
      r.locationName || '',
      ci.length + r.decorativeImages.length,
      ci.length,
      r.decorativeImages.length,
      ci.filter(i => i.hasAlt === 'No').length,
      ci.filter(i => i.hasAlt === 'Yes (generic)').length,
      ci.filter(i => i.renamePriority === 'Critical').length,
      ci.filter(i => i.rawType === 'UNKNOWN').length,
      r.success ? 'Complete' : 'Failed',
    ]);
    applyDataStyle(row, r.success ? 'FFF9FAFB' : 'FFFEF2F2');
  }

  // ── Sheet 4: Run Log ───────────────────────────────────────────────────────
  const s4 = wb.addWorksheet('Run Log');
  s4.columns = [
    { key: 'a', width: 45 }, { key: 'b', width: 10 }, { key: 'c', width: 12 },
    { key: 'd', width: 45 }, { key: 'e', width: 22 }, { key: 'f', width: 14 },
  ];
  const h4Row = s4.addRow(['URL', 'Status', 'HTTP Status', 'Error Message', 'Timestamp', 'Duration (ms)']);
  applyHeaderStyle(h4Row);

  for (const r of results) {
    const l = r.logEntry;
    const row = s4.addRow([l.url, l.status, l.httpStatus || '', l.error || '', l.timestamp, l.duration]);
    applyDataStyle(row, l.status === 'Success' ? 'FFF0FAF7' : 'FFFEF2F2');
  }

  const buffer = await wb.xlsx.writeBuffer();
  const today = new Date().toISOString().split('T')[0];
  // Derive filename from the brand name when provided; otherwise a generic slug.
  const filename = `${brandSlug ? `${brandSlug}_` : ''}image_alt_audit_${today}.xlsx`;
  return { buffer, filename };
}

// ── Routes ────────────────────────────────────────────────────────────────────

// POST /init — validate + store session, return token
// async because the SSRF guard below resolves each host before accepting it.
router.post('/init', async (req, res) => {
  const { urls, config } = req.body;
  if (!Array.isArray(urls) || urls.length === 0) {
    return res.status(400).json({ error: 'urls array is required' });
  }

  const validUrls = urls.map(u => u.trim()).filter(u => {
    try { new URL(u); return true; } catch { return false; }
  });
  if (validUrls.length === 0) {
    return res.status(400).json({ error: 'No valid URLs provided' });
  }

  // SSRF guard — `new URL(u)` above proves the string parses, not that the host
  // is one this server should be made to fetch. Every one of these is fetched
  // server-side, so without this a signed-in caller could enumerate internal
  // hosts, or read http://169.254.169.254/ (cloud instance metadata), through a
  // tool whose whole job is to report what it found on a page.
  // Rejects the whole batch rather than silently dropping entries: a partial
  // audit that does not say what it skipped is the failure mode this repo's
  // own findings-are-partial marking exists to avoid.
  // The outer try/catch is not redundant with the inner one: the inner catch
  // turns a rejected host into an entry in `unsafe`, but a DNS layer failure
  // outside that call would otherwise reject Promise.all and — Express 4 not
  // forwarding handler rejections — hang this request instead of answering it.
  // That is the defect class this repo spent Round 1 removing; adding a guard
  // must not reintroduce it.
  const unsafe = [];
  try {
    await Promise.all(validUrls.map(async (u) => {
      try { await assertPublicHost(new URL(u).hostname); }
      catch (e) { unsafe.push(`${u} — ${e.message}`); }
    }));
  } catch (e) {
    console.error('[imageAltAudit] host validation failed:', e.message);
    return res.status(500).json({ error: 'Could not validate the supplied URLs.' });
  }
  if (unsafe.length) {
    return res.status(400).json({ error: `Refusing to fetch ${unsafe.length} URL(s): ${unsafe.join('; ')}` });
  }

  const mergedConfig = { ...DEFAULT_CONFIG, ...(config || {}) };
  if (typeof mergedConfig.plansFilenames === 'string') {
    mergedConfig.plansFilenames = mergedConfig.plansFilenames.split(',').map(s => s.trim()).filter(Boolean);
  }
  mergedConfig.concurrency = Math.min(Math.max(parseInt(mergedConfig.concurrency) || 5, 1), 10);

  const token = generateToken();
  sessions.set(token, { urls: validUrls, config: mergedConfig });
  setTimeout(() => sessions.delete(token), 600000); // 10-min TTL

  res.json({ token, urlCount: validUrls.length });
});

// GET /stream/:token — SSE stream, processes all URLs
router.get('/stream/:token', async (req, res) => {
  const session = sessions.get(req.params.token);
  if (!session) return res.status(404).json({ error: 'Session not found or expired' });
  sessions.delete(req.params.token);

  const { urls, config } = session;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  let isClosed = false;
  res.on('close', () => { isClosed = true; });

  // Keepalive comment every 25s to prevent proxy timeouts
  const keepAlive = setInterval(() => {
    if (isClosed) { clearInterval(keepAlive); return; }
    try { res.write(': ping\n\n'); } catch { isClosed = true; clearInterval(keepAlive); }
  }, 25000);

  const emit = (event, data) => {
    if (isClosed) return;
    try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }
    catch { isClosed = true; }
  };

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  try {
    emit('step', { id: 'scrape', status: 'active', message: `Processing 0 / ${urls.length} pages…` });

    const allResults = new Array(urls.length);
    let doneCount = 0;

    await runWithConcurrency(urls, config.concurrency, async (url, idx) => {
      if (isClosed) return;
      emit('url_start', { url, index: idx, total: urls.length });

      const result = await processUrl(url, config, openai);
      allResults[idx] = result;
      doneCount++;

      emit('url_done', {
        url, index: idx, total: urls.length,
        success: result.success,
        locationName: result.locationName,
        contentCount: result.contentImages.length,
        decorativeCount: result.decorativeImages.length,
        error: result.logEntry.error || null,
      });
      emit('step', { id: 'scrape', status: 'active', message: `Processing ${doneCount} / ${urls.length} pages…` });
    });

    if (isClosed) { clearInterval(keepAlive); return; }

    const successCount = allResults.filter(r => r.success).length;
    emit('step', { id: 'scrape', status: 'done', message: `Processed ${successCount} / ${urls.length} pages successfully` });
    emit('step', { id: 'export', status: 'active', message: 'Building Excel workbook…' });

    const brandSlug = slugify(config.brandName);
    const { buffer, filename } = await buildExcel(allResults, config, brandSlug);

    const dlToken = generateToken();
    downloads.set(dlToken, { buffer, filename });
    setTimeout(() => downloads.delete(dlToken), 1800000); // 30-min TTL

    emit('step', { id: 'export', status: 'done', message: 'Excel workbook ready' });
    emit('ready', { downloadToken: dlToken, filename });

  } catch (err) {
    console.error('[image-alt-audit] Fatal error:', err.message);
    emit('fail', { message: err.message });
  }

  clearInterval(keepAlive);
  emit('done', {});
  res.end();
});

// GET /download/:token — serve the Excel file
router.get('/download/:token', (req, res) => {
  const dl = downloads.get(req.params.token);
  if (!dl) return res.status(404).json({ error: 'Download not found or expired (30-min window)' });

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${dl.filename}"`);
  res.send(Buffer.from(dl.buffer));
});

module.exports = router;
