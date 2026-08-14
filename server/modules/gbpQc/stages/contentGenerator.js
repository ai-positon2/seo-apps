const axios = require('axios');
const cheerio = require('cheerio');

function slug(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

// Tries to fetch the brand's location page and extract useful copy. Returns
// a short context string (max ~400 chars scraped, truncated to 400 when
// injected into the prompt) or '' if unavailable — this is a nice-to-have
// enrichment, not a required input, so every failure mode is swallowed.
async function fetchLocationContext(location, guidelines) {
  const template = guidelines.location_page_url_template || '';
  if (!template) return '';

  try {
    let locPart = location;
    const brandFmt = guidelines.brand_name_with_location_format || '';
    if (brandFmt.includes('[Location]')) {
      const prefix = brandFmt.split('[Location]')[0].trim().toLowerCase();
      const locLower = location.toLowerCase();
      if (locLower.startsWith(prefix)) {
        locPart = location.slice(brandFmt.split('[Location]')[0].length).trim();
      }
    }

    const url = template.replace('{slug}', slug(locPart));

    const resp = await axios.get(url, {
      timeout: 6000,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      },
      validateStatus: () => true,
    });
    if (resp.status !== 200) return '';

    const $ = cheerio.load(resp.data);
    $('script, style, nav, footer, header, aside').remove();

    const main = $('main').first().length ? $('main').first() : $('article').first().length ? $('article').first() : $('body');
    let text = main.text().replace(/\s+/g, ' ').trim();
    return text.slice(0, 500);
  } catch {
    return '';
  }
}

// Formatted requirements block injected into the generation prompt — reads
// from location_rules map (new) or post_types data (fallback). Always
// injects applicable special_rules.
function buildLocationRequirements(location, postType, guidelines) {
  const lines = [];
  const locLower = location.toLowerCase();
  const ptLower = postType.toLowerCase();

  const mandatory = [];
  for (const rule of guidelines.special_rules || []) {
    const ruleId = rule.id || '';
    const ruleTxt = rule.rule || '';
    const chkTxt = rule.check || '';

    if (ruleId === 'dbt_spelling') {
      mandatory.push(`CRITICAL SPELLING: ${ruleTxt}\n   → ${chkTxt}`);
    } else {
      const keywords = ruleId.split(/[_\s]/).filter((w) => w.length > 3);
      if (keywords.some((kw) => locLower.includes(kw))) {
        mandatory.push(`Location Rule: ${ruleTxt}\n   → ${chkTxt}`);
      }
    }
  }

  if (mandatory.length) {
    lines.push('## Mandatory Rules for This Location & Content');
    for (const m of mandatory) lines.push(`- ${m}`);
    lines.push('');
  }

  const locationRules = guidelines.location_rules || {};
  if (locationRules[location]) {
    const locCfg = locationRules[location];
    const available = locCfg.services || [];
    const svcNotes = locCfg.service_notes || {};

    let matchedSvc = null;
    for (const svc of ['mental_health', 'addiction', 'teen']) {
      const svcSpaced = svc.replace('_', ' ');
      if (ptLower.includes(svcSpaced) || svcSpaced.includes(ptLower)) {
        matchedSvc = svc;
        break;
      }
    }
    if (!matchedSvc) {
      for (const svc of ['awareness', 'general', 'holiday']) {
        if (ptLower.includes(svc)) {
          matchedSvc = svc;
          break;
        }
      }
    }

    if (matchedSvc && !available.includes(matchedSvc) && svcNotes[matchedSvc]) {
      const note = svcNotes[matchedSvc];
      lines.push('## Service Availability Note — REQUIRED');
      lines.push(`This location does NOT offer ${matchedSvc.replace('_', ' ')} services.`);
      lines.push('Append this EXACT note at the very end of the post body (and full_post):');
      lines.push(`"${note}"`);
      lines.push('');
    } else if (matchedSvc && available.includes(matchedSvc)) {
      lines.push('## Service Availability');
      lines.push(`This location DOES offer ${matchedSvc.replace('_', ' ')} — no service note needed.`);
      lines.push('');
    }
  }

  return lines.join('\n');
}

function buildPrompt(baseContent, location, postType, locationContext = '', guidelines = {}) {
  const baseChars = baseContent.length;

  const banned = (guidelines.clinical_language_rules || {}).banned_phrases || [
    'guaranteed results',
    'the best',
    'number one',
    'perfect results guaranteed',
  ];
  const bannedStr = banned.map((p) => `"${p}"`).join(', ');

  let contextSection = '';
  if (locationContext) {
    contextSection = `
## Location Page Context (scraped from the brand's website for this location)
Use the following snippet to inform subtle, natural phrasing tweaks — e.g. referencing a specific service,
a local detail, or a phrase that matches this location's page tone. Do NOT quote it verbatim; weave it in naturally.
---
${locationContext.slice(0, 400)}
---
`;
  }

  const locationRequirements = buildLocationRequirements(location, postType, guidelines);
  const requirementsSection = locationRequirements ? `\n${locationRequirements}\n` : '';

  return `Generate a complete, ready-to-post location-specific GBP post for the location below.

${requirementsSection}## PRIMARY RULE — Base Content is the Hard Template
The approved base content below is the exact structural template you must follow.
- Mirror its sections, order, and length exactly — do NOT add sections that are not present in the base content.
- Do NOT add a "Why Choose" section (or any other section) if it does not appear in the base content.
- Do NOT remove sections that are present in the base content.
- If the base content has 4 sections, the output has 4 sections. If it has 6, the output has 6.
- The user has intentionally written the base content this way — treat it as a hard rule, not a suggestion.
${contextSection}
## Your Only Job
Swap in the correct location name throughout, and make subtle natural rephrasing so each location's
post feels individually written rather than copy-pasted:
- Vary sentence structure in the intro (reorder clauses, vary sentence length)
- Vary word choice in 1–2 sentences (synonyms, different openers — same meaning)
- Vary the phrasing of 1–2 bullet points if bullet points are present (same facts, different wording)
- Vary the CTA sentence slightly (same call to action, slightly different phrasing)

Do NOT invent new facts, services, claims, or sections not present in the base content.

## Location
${location}

## Post Type / Theme
${postType}

## Approved Base Content — FOLLOW THIS STRUCTURE EXACTLY
---
${baseContent}
---
Base content length: ${baseChars} characters

## Style Rules (apply only within the structure above)

### Brand Name
- Use the exact brand name format from the guidelines (e.g. "Gentle Dental in [Location]")
- Substitute the correct location name everywhere the placeholder appears
- Do not shorten or alter the brand name

### Title
- Keep the same title structure as the base content
- Substitute the correct location name — never start the title with the brand name

### CTA
- Keep whatever CTA style is in the base content
- Substitute the correct location name
- Do not add a phone number

### Tone
- Warm, helpful, patient-first, simple, reassuring
- Do not use: ${bannedStr}

### Character Count
- Stay within 1500 characters total
- Aim to match the base content length closely: ${baseChars} characters

## Output Format
Return ONLY a valid JSON object — no markdown fences, no extra text:
{
  "title": "<the complete post title>",
  "body": "<the post body — everything after the title, ready to paste>",
  "full_post": "<title + two newlines + body, exactly as it should appear when posted>",
  "character_count": <integer: total character count of full_post>,
  "within_limit": <true if character_count <= 1500>,
  "sections_included": ["<list only the sections actually present in the output>"],
  "customization_notes": ["<brief note on what was rephrased or tweaked specifically for this location>"]
}`;
}

module.exports = { buildPrompt, fetchLocationContext };
