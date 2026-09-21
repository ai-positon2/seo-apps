const cheerio = require('cheerio');
const { cleanHtml, foldText } = require('./document');

const HEADINGS = 'h1,h2,h3,h4,h5,h6';
const BLOCKS = `${HEADINGS},p,li,blockquote,td,th`;
const isHeading = el => /^h[1-6]$/.test(el?.name || '');

// Only a claim credited to a named source is policed. Ordinary wording that
// merely contains a number -- "every 6 months", "$150", "two visits" -- is not a
// sourced claim and must survive verification failures untouched.
const ATTRIBUTION_PHRASE = new RegExp([
  String.raw`\b(?:according to|reported by|cited by|reviewed by|per the|published (?:in|by))\b`,
  // "a 2024 study found", "the survey suggests that"
  String.raw`\b(?:stud(?:y|ies)|survey|trial|poll|research(?:ers)?|analysis)\b[^.!?]{0,40}\b(?:found|shows?|showed|suggests?|suggested|reports?|reported|concludes?|concluded|estimates?|estimated|reveals?|revealed|indicates?|indicated)\b`,
].join('|'), 'i');
// Case-sensitive on purpose. A reporting verb alone is not attribution -- "this
// section explains the topic" credits nobody -- so a named subject is required
// before it, and "the American Dental Association" is a source while "college
// students" is not.
const SPEAKS = String.raw`(?:says|said|notes|noted|writes|wrote|explains|explained|warns|warned|argues|argued|recommends|recommended|advises|advised)`;
const ATTRIBUTION_NAME = new RegExp([
  String.raw`\bDr\.?\s|\bProf(?:\.|essor)\b`,
  String.raw`\b[A-Z][\w.&'-]+(?:\s+[A-Z][\w.&'-]+)*\s+` + SPEAKS + String.raw`\b`,
  String.raw`\b(?:Association|Institute|University|Foundation|Academy|Society|Council|Agency|Administration|Ministry)\b`,
  String.raw`\b(?:CDC|WHO|ADA|NIH|FDA|NHS|OECD|EPA|AMA|NICE)\b`,
].join('|'));
const isAttributed = sentence => ATTRIBUTION_PHRASE.test(sentence) || ATTRIBUTION_NAME.test(sentence);
const normalize = value => String(value || '').replace(/\s+/g, ' ').trim();

function reviewBlocks(html) {
  const $ = cheerio.load(cleanHtml(html), null, false);
  const blocks = $(BLOCKS).toArray().filter(el => !$(el).find(BLOCKS).length);
  return { $, blocks, passages: blocks.map((el, index) => ({ id: `B${index + 1}`, text: normalize($(el).text()), html: $.html(el) })) };
}

// Cutting an arbitrary span leaves fragments like "but the rest of the claim."
// Removals are widened to the sentences they touch so the remaining text reads.
function sentenceSpan(text, start, end) {
  const before = text.slice(0, start);
  const opening = before.search(/[^.!?]*$/);
  let closing = end;
  while (closing < text.length && !/[.!?]/.test(text[closing])) closing++;
  while (closing < text.length && /[.!?\s]/.test(text[closing])) closing++;
  return [opening < 0 ? start : opening, closing];
}

// Remove text across nested marks/links without replacing the surrounding HTML.
function removeExcerpt(el, excerpt) {
  const nodes = [];
  function collect(node) {
    if (node.type === 'text') nodes.push(node);
    else for (const child of node.children || []) collect(child);
  }
  collect(el);
  const raw = nodes.map(n => n.data).join('');
  const offsets = []; let normalized = '';
  for (let i = 0; i < raw.length; i++) {
    if (/\s/.test(raw[i])) {
      if (!normalized.endsWith(' ')) { normalized += ' '; offsets.push(i); }
    } else { normalized += raw[i]; offsets.push(i); }
  }
  // foldText is one character to one character, so folded indices still address
  // the offsets table built above.
  const needle = foldText(normalize(excerpt));
  const at = needle ? foldText(normalized).indexOf(needle) : -1;
  if (at < 0) return false;
  const [from, to] = sentenceSpan(normalized, at, at + needle.length);
  const start = offsets[from], end = offsets[to] ?? raw.length;
  let offset = 0;
  for (const node of nodes) {
    const length = node.data.length;
    const from = Math.max(0, start - offset), to = Math.min(length, end - offset);
    if (from < to) node.data = node.data.slice(0, from) + node.data.slice(to);
    offset += length;
  }
  return true;
}

function removeUnsupported(html, { removals = [], sources = [], conservative = false } = {}) {
  const { $, blocks } = reviewBlocks(html);
  const omitted = [];
  function removeBlock(el, reason) {
    // Removing a cell alone can misalign a statistic with a different label.
    const row = $(el).closest('tr');
    const target = row.length ? row : $(el);
    omitted.push({ text: normalize(target.text()), reason }); target.remove();
  }
  let unresolved = false;
  for (const item of removals) {
    const index = Number(item.blockId?.replace(/^B/, '')) - 1;
    const el = blocks[index];
    if (!el) { unresolved = true; continue; }
    if ($(el).closest('tr').length || !removeExcerpt(el, item.excerpt)) removeBlock(el, item.reason);
    else omitted.push({ text: item.excerpt, reason: item.reason });
  }
  const allowed = new Set(sources.map(s => s.url));
  // An unverified citation is removed with its sentence, not merely unlinked.
  $('a').each((_, el) => {
    if (!conservative && !unresolved && allowed.has($(el).attr('href'))) return;
    const block = $(el).closest(BLOCKS).get(0);
    // A heading is structure rather than a claim, so drop the link and keep the wording.
    if (isHeading(block)) {
      omitted.push({ text: normalize($(el).text()), reason: 'Unverified link removed from a heading.' });
      $(el).replaceWith($(el).contents());
    } else if (block) removeBlock(block, 'Citation could not be validated.');
    else { omitted.push({ text: normalize($(el).text()), reason: 'Unverified link removed.' }); $(el).remove(); }
  });
  if (conservative || unresolved) {
    for (const el of blocks) {
      // A heading carries no claim of its own, and gutting it breaks the outline.
      if (!el.parent || isHeading(el)) continue;
      // When verification is unavailable, omit only what credits a source.
      const text = normalize($(el).text());
      const sentences = text.match(/[^.!?]+(?:[.!?]+|$)/g) || [];
      for (const sentence of sentences) {
        if (isAttributed(sentence)) {
          if (removeExcerpt(el, sentence)) omitted.push({ text: sentence.trim(), reason: 'Omitted because the source it credits could not be verified.' });
        }
      }
    }
    // Quotations nest, so a blockquote wrapping a paragraph is not a leaf block.
    $('blockquote').toArray().forEach(el => { if (el.parent && normalize($(el).text())) removeBlock(el, 'Unverified quotation removed.'); });
  }
  $(`p,li,blockquote,a,strong,em,u,s,td,th,${HEADINGS}`).toArray().reverse().forEach(el => { if (!normalize($(el).text())) $(el).remove(); });
  $('ul,ol,table,thead,tbody,tr').toArray().reverse().forEach(el => { if (!normalize($(el).text())) $(el).remove(); });
  // An FAQ question whose answer was just removed reads as a defect. Walk the
  // headings backwards so a heading exposed by the one below it also goes.
  $(HEADINGS).toArray().reverse().forEach(el => {
    const next = $(el).nextAll().get(0);
    if (next && !(/^h[1-6]$/.test(next.name) && Number(next.name[1]) <= Number(el.name[1]))) return;
    omitted.push({ text: normalize($(el).text()), reason: 'Heading removed because the content beneath it could not be verified.' });
    $(el).remove();
  });
  return { html: cleanHtml($.html()), omitted, unresolved };
}
module.exports = { reviewBlocks, removeUnsupported };
