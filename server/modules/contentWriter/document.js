const { z } = require('zod');
const sanitizeHtml = require('sanitize-html');
const crypto = require('crypto');

// H1 is the title, so an outline heading runs from H2 down to H6.
const LEVELS = ['H2', 'H3', 'H4', 'H5', 'H6'];
const FAQ_HEADING = 'Frequently Asked Questions';
const isFaq = heading => /frequently asked questions|^\s*faqs?\s*$/i.test(heading || '');

// Pages are typeset with curly quotes and long dashes; a model re-emitting that
// text through JSON straightens them, and the excerpt then fails to match its
// own source. Folding both sides fixes that without loosening verification.
// Every mapping is strictly one character to one character, because callers map
// folded offsets back onto raw text nodes — never add an expanding rule here.
const FOLD = {
  '‘': "'", '’': "'", '‚': "'", '‛': "'", '′': "'", '´': "'", '`': "'",
  '“': '"', '”': '"', '„': '"', '‟': '"', '″': '"', '«': '"', '»': '"',
  '‐': '-', '‑': '-', '‒': '-', '–': '-', '—': '-', '―': '-', '−': '-',
  ' ': ' ', ' ': ' ', ' ': ' ', ' ': ' ',
};
const foldText = value => String(value || '').replace(/[‘’‚‛′´`“”„‟″«»‐‑‒–—―−    ]/g,
  character => FOLD[character]).toLowerCase();

const optionsSchema = z.object({
  wordCount: z.union([z.literal(''), z.number().int().min(100).max(10000)]).default(''),
  audience: z.string().max(1000).default(''), tone: z.string().max(1000).default(''),
  language: z.string().max(100).default(''), secondaryKeywords: z.string().max(4000).default(''),
  instructions: z.string().max(10000).default(''), client: z.string().max(100).default(''),
  feedbackKbIds: z.array(z.string().max(200)).max(30).default([]),
});
const briefSchema = z.object({
  title: z.string().max(1000), intro: z.string().max(20000).default(''),
  sections: z.array(z.object({ id: z.string().max(100), level: z.enum(LEVELS),
    heading: z.string().max(1000), guidance: z.string().max(20000) })).max(100),
  references: z.string().max(20000).default(''),
});
const editableSchema = z.object({
  keyword: z.string().trim().min(1).max(500), options: optionsSchema.default({}),
  brief: briefSchema.nullable().default(null), draftHtml: z.string().max(500000).default(''),
});
// Exporting what is on screen only needs the content, so an empty keyword is
// not a reason to refuse the download.
const exportableSchema = editableSchema.extend({ keyword: z.string().trim().max(500).default('') });
function cleanHtml(html) {
  return sanitizeHtml(html, {
    allowedTags: ['h1','h2','h3','h4','h5','h6','p','br','strong','em','u','s','blockquote','ul','ol','li','a','table','thead','tbody','tr','th','td','hr'],
    allowedAttributes: { a: ['href'], td: ['colspan','rowspan'], th: ['colspan','rowspan'], ol: ['start'] },
    allowedSchemes: ['http','https'], allowProtocolRelative: false,
  });
}
function parseBrief(markdown) {
  const brief = { title: '', intro: '', sections: [], references: '' };
  let section = null, references = false;
  for (const line of markdown.split(/\r?\n/)) {
    if (/^\s*(?:\*\*)?Reference Blog URLs:/i.test(line)) { references = true; continue; }
    if (references) { brief.references += line + '\n'; continue; }
    const h = line.match(/^(#{1,6})\s+(?:H[1-6]:\s*)?(.*)$/i);
    if (h?.[1].length === 1) { brief.title = h[2].trim(); continue; }
    if (h) {
      section = { id: crypto.randomUUID(), level: LEVELS[Math.min(h[1].length, 6) - 2], heading: h[2].trim(), guidance: '' };
      brief.sections.push(section);
    } else if (section) section.guidance += line + '\n';
    else brief.intro += line + '\n';
  }
  brief.intro = brief.intro.trim(); brief.references = brief.references.trim();
  brief.sections.forEach(s => { s.guidance = s.guidance.replace(/\*\*/g, '').replace(/^\s*---+\s*$/gm, '').trim(); });
  if (!brief.title || !brief.sections.length) throw new Error('The generated brief was incomplete. Please generate it again.');
  return brief;
}
function briefMarkdown(brief) {
  return [`# H1: ${brief.title}`, brief.intro, ...brief.sections.map(s =>
    `${'#'.repeat(Number(s.level.slice(1)))} ${s.level}: ${s.heading}\n${s.guidance}`),
  '**Reference Blog URLs:**', brief.references].filter(Boolean).join('\n\n');
}
function briefHash(brief) { return crypto.createHash('sha256').update(JSON.stringify(brief)).digest('hex'); }
// Every article ships with an FAQ section. The writer may delete it afterwards;
// it is only guaranteed to be offered.
function ensureFaqSection(brief) {
  if (brief.sections.some(s => isFaq(s.heading))) return brief;
  return { ...brief, sections: [...brief.sections, { id: crypto.randomUUID(), level: 'H2', heading: FAQ_HEADING,
    guidance: ['Answer the questions readers actually ask about this topic.',
      '- Write 5-8 questions drawn from the themes covered above.',
      '- Give every question its own complete answer of roughly 40-80 words.',
      '- Answer directly in the first sentence, then add the detail that qualifies it.'].join('\n') }] };
}
module.exports = { editableSchema, exportableSchema, cleanHtml, parseBrief, briefMarkdown, briefHash, ensureFaqSection, isFaq, foldText, LEVELS, FAQ_HEADING };
