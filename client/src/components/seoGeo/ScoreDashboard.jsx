import { useState, useMemo } from 'react';
import {
  ScoreRing, ScoreBar, GEO_BADGE, EEAT_BADGE, scoreColor, resolveBreakdown,
  PipMeter, answerabilityVerdict, capIsHardBlock, asText,
} from './primitives';

const CAPTION = {
  fontSize: 11, fontWeight: 600, color: 'var(--text-3)',
  textTransform: 'uppercase', letterSpacing: '0.05em',
};
const CARD = {
  background: 'var(--card)', borderRadius: 'var(--r-lg)', border: '1px solid var(--border)',
  padding: 20, boxShadow: '0 1px 3px rgba(0,0,0,0.07)',
};

// ── Remediation content ──────────────────────────────────────────────────────
// The rule engine's check objects carry {id, category, name, status, severity, value,
// detail} and NO fix field — only the GPT output has remediation text. So every
// "how do I fix this" string below is authored deterministically here, keyed to the exact
// failing sub-condition, and the AI's issue text is layered on top when it resolved.
// That ordering matters: the panel must still be useful on a run where the AI call failed.

const BUCKET_INFO = {
  title_meta: {
    why: 'Grades the three places the page declares what it is — <title>, meta description and Open Graph — which produce the SERP snippet and give crawlers and AI engines their most heavily weighted statement of the page topic.',
    fix: 'Write one entity-first title under ~60 characters, a 120–155 character description that answers the query rather than describing the page, and mirror both into og:title/og:description with a valid og:image and og:url.',
  },
  content_structure: {
    why: 'The heaviest bucket. Grades heading hierarchy, content depth and answer-shape, and semantic landmarks — the structure search engines use to understand the page and AI engines use to isolate a single quotable passage.',
    fix: 'Give the page exactly one H1 plus a logical H2/H3 outline where each heading states a question or a claim, and open each section with a self-contained two-sentence answer inside <main>/<article>.',
  },
  indexability: {
    why: 'A gate, not a quality score: whether robots directives permit indexing, whether one unambiguous canonical is declared, and whether language variants are reciprocal. Fail any of it and no crawler ever considers the content.',
    fix: 'Serve index,follow with exactly one self-referencing absolute canonical, no meta refresh, and reciprocal hreflang only if genuine language or region variants exist.',
  },
  schema: {
    why: 'Grades the JSON-LD: that it exists, parses, matches what the page actually is, populates required properties, and links entities via @id/sameAs. It is the only machine-readable statement of the page facts an AI engine can cite without re-interpreting prose.',
    fix: 'Ship one valid JSON-LD graph containing the page’s primary @type with all required properties populated, plus @id and sameAs tying it to the site Organization.',
  },
  geo_signals: {
    why: 'Grades generative-engine retrievability specifically: server-rendered text ratio, Q&A structuring, the answerability roll-up, freshness, word-count band, sameAs linking, machine-readable NAP, hours, review markup and service area.',
    fix: 'Add a Q&A block whose answers stand alone without their heading, a dateModified, and state the page’s entity facts (3+ sameAs, NAP, hours, ratings, service area) in schema rather than only in prose.',
  },
  eeat: {
    why: 'Grades trust evidence — named author with linked bio and credentials, published/updated dates, licences, outbound regulatory links, About/Contact/policy links, named practitioners — what quality systems weigh before ranking or quoting, especially on YMYL topics.',
    fix: 'Attribute the page to a named, credentialed author linked to a real bio page, show both published and last-updated dates, and link About, Contact and an editorial or review policy from the page itself.',
  },
  technical: {
    why: 'Grades crawl-and-render mechanics: viewport and head plumbing, URL cleanliness and depth, render-blocking resources and document size, mixed content, and housekeeping — whether a crawler or AI fetcher can retrieve and render the page cheaply and safely at all.',
    fix: 'Clear the hard blockers first — mobile viewport, declared charset, HTTPS with zero mixed content — then remove render-blocking scripts and stylesheets from <head> and cut the HTML payload down.',
  },
  links_media: {
    why: 'Grades images and their alt text, dimensions and lazy-loading, internal link volume and anchor quality, outbound citations, and accessibility affordances — what makes the page navigable for crawlers and its media interpretable by screen readers and multimodal models.',
    fix: 'Give every meaningful image descriptive alt text plus explicit width and height, then add descriptive-anchor internal links to closely related pages and cite authoritative sources by link rather than by name.',
  },
  keyword: {
    why: 'Grades whether the supplied keywords actually appear where weight accrues — title, H1, meta description, first 100 words, URL slug, an H2, alt text, schema name and OG tags — at sane density and without over-repetition across headings.',
    fix: 'Place the exact primary keyword early in the title, in the H1 and in the first sentence of body copy, then cover natural variants across H2s and alt text instead of repeating the exact phrase.',
  },
};

// Keyed [rubric letter][state]. State is derived from the real geo.* facts (see
// rubricState) rather than parsed out of the finding sentence.
const RUBRIC_FIX = {
  N: {
    ids: 'T11',
    full:      { issue: '', why: 'Answer engines resolve a business to a place from marked-up NAP, not from prose.', fix: 'Keep the schema address and telephone in sync with the page and with your Google Business Profile.' },
    partial:   { issue: 'The business node has an address but a required subfield or the telephone is missing.', why: 'A partial PostalAddress cannot be matched confidently against a place, so the entity stays ambiguous.', fix: 'Complete the PostalAddress — streetAddress, addressLocality, addressRegion, postalCode, addressCountry — and add telephone in the same format shown on the page.' },
    text_only: { issue: 'The address and phone are printed in the page text but no PostalAddress or telephone property exists in schema.', why: 'Text-only NAP is parsed unreliably, so a visibly correct page still reads as location-less to an answer engine.', fix: 'Add a LocalBusiness node (or the correct subtype) with a nested address of @type PostalAddress carrying streetAddress, addressLocality, addressRegion, postalCode and addressCountry, plus telephone — copying the values already on the page. Markup only, no content change.' },
    absent:    { issue: 'No machine-readable address or telephone in schema, and none detectable in the page text either.', why: 'Without an address or phone the page cannot be resolved to a physical entity, which disqualifies it from local and near-me answers.', fix: 'Publish the full postal address and phone in the page body, then mark them up with LocalBusiness → address (PostalAddress) and telephone.' },
  },
  A: {
    ids: 'T12',
    full:      { issue: '', why: 'Structured day/time values are what let an engine answer "are they open now".', fix: 'Keep openingHoursSpecification in step with the displayed hours, including holiday exceptions.' },
    no_geo:    { issue: 'Opening hours are valid but the node carries no geo coordinates.', why: 'Coordinates let an engine place the business precisely for distance-ranked and map-based answers.', fix: 'Add geo with @type GeoCoordinates carrying latitude and longitude for the premises.' },
    invalid:   { issue: 'openingHoursSpecification is present but invalid or empty, so it carries no readable hours.', why: 'An invalid hours block is worse than none — it asserts availability data an engine then discards.', fix: 'Give each entry dayOfWeek as a full http://schema.org/<Day> URI plus opens and closes in 24-hour HH:MM. Plain "Monday" and the property "canceldayOfWeek" are both invalid.' },
    text_only: { issue: 'Opening hours appear in the page text but there is no openingHoursSpecification in schema.', why: 'Hours rendered as a text table or image cannot be compared against the time of a query.', fix: 'Transcribe the displayed hours into an openingHoursSpecification array — one entry per distinct pattern with dayOfWeek, opens and closes in 24-hour HH:MM. Content stays as-is; this is markup only.' },
    absent:    { issue: 'No openingHoursSpecification in schema and no hours visible in the page text.', why: 'Missing hours is a hard blocker for open-now and availability answers.', fix: 'Publish the weekly hours in the body, then add openingHoursSpecification with dayOfWeek, opens and closes for every day, marking closed days explicitly rather than omitting them.' },
  },
  P: {
    ids: 'T13',
    full:      { issue: '', why: 'Marked-up ratings are the proof signal engines weigh when recommending between competitors.', fix: 'Keep ratingValue and reviewCount accurate and sourced from reviews actually displayed on the page.' },
    partial:   { issue: 'Review markup is present but incomplete — aggregateRating is missing ratingValue or reviewCount.', why: 'An aggregateRating without both values cannot be rendered as a rich result or quoted as proof.', fix: 'Populate aggregateRating with ratingValue, reviewCount and bestRating on the business node.' },
    text_only: { issue: 'Reviews or star ratings are visible on the page but there is no AggregateRating or Review markup.', why: 'Unmarked testimonials are read as ordinary body text, so existing social proof contributes nothing to ranking or citation.', fix: 'Add aggregateRating (ratingValue, reviewCount, bestRating) to the business node and, where individual testimonials show, Review nodes with author, reviewRating and datePublished. The reviews are already on the page — only the encoding is missing.' },
    absent:    { issue: 'No review or rating content on the page and no AggregateRating or Review markup.', why: 'With no proof signal the page gives an engine nothing to weigh against competitors that publish ratings.', fix: 'Surface real customer reviews or an aggregate score on the page, then mark them up with aggregateRating and per-testimonial Review nodes. Do not mark up ratings collected elsewhere unless they are also displayed here.' },
  },
  E: {
    ids: 'T10, J9',
    full:      { issue: '', why: 'sameAs plus a stable @id is what ties this page to a knowledge-graph entity rather than a name string.', fix: 'Keep the @id stable across the site and add new authoritative profiles to sameAs as they appear.' },
    needs_id:  { issue: 'sameAs linking is adequate but the node lacks a stable @id, a specific subtype, or both.', why: 'Without @id other pages cannot reference the same entity, and a bare LocalBusiness subtype forfeits category-specific understanding.', fix: 'Give the business node a stable absolute @id (e.g. https://site.com/#organization) and change @type from LocalBusiness to the precise subtype (Dentist, Attorney, MedicalClinic).' },
    needs_sameas: { issue: 'The node has an @id and a specific subtype but fewer than three sameAs profile URLs.', why: 'Under three references leave the entity ambiguous against similarly named organisations, so authority can be misattributed.', fix: 'Extend sameAs to at least three authoritative profiles — prioritise Wikidata and Wikipedia if they exist, then LinkedIn, Crunchbase, and the primary registry for your sector.' },
    absent:    { issue: 'No sameAs profiles and no stable @id or specific subtype on the business node.', why: 'The page asserts an entity with no external corroboration, so the brand is treated as an unverified string.', fix: 'Add a sameAs array of at least three canonical profile URLs, a stable absolute @id, and the precise LocalBusiness subtype on the node.' },
  },
  F: {
    ids: 'T2, F6, F21',
    full:      { issue: '', why: 'A direct opening answer plus Q&A structure is the cleanest retrievable unit for passage-level extraction.', fix: 'Keep the opening paragraph answer-first and extend the Q&A block as new real questions appear.' },
    promo:     { issue: 'Unsubstantiated promotional superlatives were found in the body copy.', why: 'An engine cannot substantiate "best" or "world-class" the way it can substantiate a figure, which lowers the page’s value as a citable source.', fix: 'Replace each flagged term with a verifiable specific — "industry-leading" becomes the ranking and its source — and confine promotional phrasing to headings and CTAs rather than the body copy engines extract.' },
    structure: { issue: 'The page lacks a direct-answer opening, a question-form Q&A structure, or both.', why: 'Engines extract the opening passage first; an intro that warms up instead of answering forfeits the position most likely to be quoted.', fix: 'Rewrite the first paragraph so its opening sentence answers the page’s primary question directly, and add question-phrased H2/H3 headings each answered in the sentence immediately beneath.' },
    absent:    { issue: 'Promotional language is present and the page has neither a direct-answer opening nor Q&A structure.', why: 'Nothing on the page is shaped for extraction, so even a well-ranked page will not be quoted.', fix: 'Lead with a self-contained answer naming the entity, city and primary service, add a question-phrased FAQ block, and strip unverifiable superlatives from the body copy.' },
  },
  C: {
    ids: 'F16, F17',
    full:      { issue: '', why: 'Sourced figures are the passages an engine can quote and attribute.', fix: 'Keep each figure attributed inline to a named source and year.' },
    partial:   { issue: 'Statistics are present but not attributed to named sources.', why: 'An unattributed number cannot be corroborated, so it is discounted against a competitor that cites its source.', fix: 'Attribute each figure inline to a named source and publication year, and link to the primary document.' },
    absent:    { issue: 'No sourced statistics were detected.', why: 'With nothing extractable and checkable the page is treated as an unverified secondary source.', fix: 'Add concrete figures with units to the sections answering the page’s core question, each attributed inline to a named primary source and year.' },
  },
  S: {
    ids: 'F15',
    full:      { issue: '', why: 'Quantified claims are what retrieval-based engines prefer to quote.', fix: 'Keep figures current and spread across the sections that answer the page question.' },
    partial:   { issue: 'Fewer than four quantified statistics were found in the body copy.', why: 'Sparse hard numbers lose citation share to competitors whose passages each carry a quotable figure.', fix: 'Raise the count to at least four concrete figures with units, placed in the sections that answer the core question rather than clustered in the intro.' },
    absent:    { issue: 'No quantified statistics were detected anywhere in the body copy.', why: 'This is the main reason informational pages fail to be cited despite ranking well.', fix: 'Add at least four specific figures with units, preferring primary data (government, standards body, original study) over secondary aggregators.' },
  },
  Q: {
    ids: 'F14, R1',
    full:      { issue: '', why: 'First-hand expert testimony is weighted heavily for experience and expertise.', fix: 'Keep quotations attributed to a named practitioner with a visible credential.' },
    absent:    { issue: 'No attributed expert quotation was found — no blockquote or q element carrying a named speaker.', why: 'Generic editorial prose supplies no experience or expertise signal.', fix: 'Add at least one verbatim quotation from a named practitioner inside <blockquote>, with the person’s name and credential adjacent or in a <cite>, and mirror them as a Person node (name, jobTitle, sameAs) in the page schema.' },
  },
  // 'A' is reused by the CSQAF rubric for Authoritativeness. Resolved by rubric, not letter.
  A_CSQAF: {
    ids: 'F8, F9, R1',
    full:      { issue: '', why: 'An attributable author is the accountability signal quality systems look for.', fix: 'Keep the byline linked to a bio page listing current credentials.' },
    absent:    { issue: 'No named author byline was detected — the byline is absent or generic ("Admin", "Team", the brand name).', why: 'Without an attributable author the page carries no expertise signal, which is disqualifying for YMYL topics.', fix: 'Add a visible byline naming a real person near the top, link it to an author bio page listing credentials, and set author on the Article node to a Person with name, url, jobTitle and sameAs.' },
  },
};

// Per-tile remediation for the coverage grid. `family` also drives the state LABEL, because
// "In schema" is wrong for the eight tiles that have no schema component at all, and the
// 'page' state means two different things depending on the tile (see STATE_LABEL).
const TILE_FIX = {
  'Address & phone': { family: 'schema', ids: 'T11, J22, J23',
    page: { issue: 'Address and phone are printed in the page text but no PostalAddress or telephone property exists in schema.', why: 'Answer engines extract NAP from markup; text-only NAP is parsed unreliably and will not be quoted with confidence.', fix: 'Add a LocalBusiness node with a nested address of @type PostalAddress (streetAddress, addressLocality, addressRegion, postalCode, addressCountry) plus telephone, copying the values already shown. Markup only.' },
    no:   { issue: 'No machine-readable address or telephone in schema and none detectable in the page text.', why: 'Without an address or phone the page cannot be resolved to a physical entity, which disqualifies it from local answers.', fix: 'Publish the full postal address and phone in the body, then mark up LocalBusiness → address (PostalAddress) and telephone. If this page is deliberately not location-specific, link to the location page that carries them.' } },
  'Opening hours': { family: 'schema', ids: 'T12, J22',
    page: { issue: 'Opening hours appear in the page text but there is no openingHoursSpecification in schema.', why: 'An engine answering "are they open now" needs structured day and time values; a text table is not machine-comparable.', fix: 'Add an openingHoursSpecification array, one entry per distinct pattern, with dayOfWeek plus opens and closes in 24-hour HH:MM, transcribed from the hours already displayed.' },
    no:   { issue: 'No openingHoursSpecification in schema and no hours visible in the page text.', why: 'Missing hours is a hard blocker for open-now and availability answers.', fix: 'Publish the weekly hours in the body, then add openingHoursSpecification for every day, marking closed days explicitly rather than omitting them.' } },
  'Reviews & rating': { family: 'schema', ids: 'T13',
    page: { issue: 'Reviews or star ratings are visible on the page but there is no AggregateRating or Review markup.', why: 'Unmarked testimonials are read as ordinary body text, so existing social proof contributes nothing to ranking or citation.', fix: 'Add aggregateRating (ratingValue, reviewCount, bestRating) to the business node and Review nodes (author, reviewRating, datePublished) where testimonials show. Only the encoding is missing.' },
    no:   { issue: 'No review or rating content on the page and no AggregateRating or Review markup.', why: 'With no proof signal the page gives an engine nothing to weigh against competitors that publish ratings.', fix: 'Surface real customer reviews or an aggregate score on the page, then mark them up. Do not mark up ratings collected elsewhere unless they are also displayed here.' } },
  'sameAs profiles': { family: 'count', ids: 'T10, J9',
    partial: { issue: 'The sameAs array lists only one or two profiles, below the three-URL threshold entity resolution needs.', why: 'One or two references leave the entity ambiguous against similarly named organisations, so authority can be misattributed.', fix: 'Extend sameAs to at least three authoritative profile URLs — Wikidata and Wikipedia first if they exist, then LinkedIn, Crunchbase, and your sector’s primary registry.' },
    no:      { issue: 'The business node carries no sameAs array, so the page asserts an entity with no external corroboration.', why: 'Without sameAs an engine cannot connect this page to a knowledge-graph entity and treats the brand as an unverified string.', fix: 'Add a sameAs array of at least three canonical profile URLs, paired with a stable @id so other pages can reference the same entity.' } },
  'Service area': { family: 'schema', ids: 'T14',
    no: { issue: 'The schema declares no areaServed, hasOfferCatalog or makesOffer, so coverage area and service list are unstated in markup.', why: 'An engine filtering candidates by location or service cannot confirm this business qualifies, so the page drops out of geographically scoped answers.', fix: 'Add areaServed using Place/City/AdministrativeArea nodes (or a GeoCircle with geoMidpoint and geoRadius), add hasOfferCatalog or makesOffer listing each service by name, and state the coverage area in the body copy too.' } },
  Statistics: { family: 'content', ids: 'F15, F16',
    partial: { issue: 'Fewer than four quantified statistics were found in the body copy.', why: 'Sparse hard numbers lose citation share to competitors whose passages each carry a quotable figure.', fix: 'Raise the count to at least four concrete figures with units, each attributed inline to a named source and year, placed in the sections that answer the core question.' },
    no:      { issue: 'No quantified statistics were detected anywhere in the body copy.', why: 'With no numbers the page offers nothing extractable and checkable — the main reason informational pages fail to be cited despite ranking.', fix: 'Add at least four specific figures with units to the sections answering the primary question, attributing each inline, preferring primary data over aggregators.' } },
  'Expert quotes': { family: 'content', ids: 'F14, R1',
    no: { issue: 'No attributed expert quotation was found — no blockquote or q carrying a named speaker.', why: 'Answer engines weight first-hand expert testimony heavily for experience and expertise.', fix: 'Add at least one verbatim quotation from a named practitioner in <blockquote>, with name and credential adjacent or in <cite>, and mirror the person as a Person node in the page schema.' } },
  'Named author': { family: 'content', ids: 'F8, F9, R1',
    no: { issue: 'No named author byline was detected — absent or generic ("Admin", "Team", the brand name).', why: 'Without an attributable author the page carries no expertise or accountability signal, which is disqualifying for YMYL.', fix: 'Add a visible byline naming a real person near the top, link it to a bio page listing credentials, and set author on the Article node to a Person with name, url, jobTitle and sameAs.' } },
  'Primary sources': { family: 'content', ids: 'F17, F27',
    no: { issue: 'The page contains no outbound links to authoritative primary-source domains.', why: 'Uncited claims cannot be corroborated, so the page is treated as an unverified secondary source.', fix: 'Link each substantive claim to its primary source (peer-reviewed study, standards body, government dataset) with descriptive anchor text, and add a citation property on the Article node.' } },
  'Data tables': { family: 'content', ids: 'F18',
    no: { issue: 'No data table with header cells was found, so any comparison or specification content exists only as prose.', why: 'Comparison data in paragraphs is expensive to parse and rarely extracted, while a marked-up table can be quoted row by row.', fix: 'Convert at least one comparison, pricing or specification set into a <table> with a <caption> and <th scope> header cells, one row per option and one column per attribute.' } },
  'FAQ section': { family: 'content', ids: 'T2, F19, J18',
    no: { issue: 'No FAQ section was detected — no question-phrased headings and no FAQ container.', why: 'Q&A structure is the highest-leverage answerability gap, because engines retrieve at passage level and a question heading with a direct answer beneath is the cleanest retrievable unit.', fix: 'Add at least three question-phrased H2/H3 headings, each answered in the first sentence beneath it, then mark the block up as FAQPage → mainEntity → Question → acceptedAnswer → Answer.' } },
  'Direct answer opening': { family: 'content', ids: 'F6',
    no: { issue: 'The first paragraph is below the BLUF threshold (40 words informational, 25 commercial) or does not end in a complete sentence.', why: 'Engines extract the opening passage first; an intro that warms up instead of answering forfeits the position most likely to be quoted.', fix: 'Rewrite the opening so its first sentence answers the page’s primary question directly — 40+ words informational, 25+ commercial — and move brand framing below it.' } },
  'Promotional wording': { family: 'inverse', ids: 'F21',
    no: { issue: 'Promotional superlatives were detected in the body copy.', why: 'Unverifiable marketing language lowers the page’s usefulness as a citable source, since an engine cannot substantiate "best" or "world-class".', fix: 'Replace each flagged term with a verifiable specific — "industry-leading" becomes the ranking and its source — and confine promotional phrasing to headings and CTAs rather than the body copy engines extract.' } },
};

// 'page' means "in the page text but not in markup" ONLY for the schema family. For a count
// tile it means "below threshold" (1-2 sameAs URLs ARE in schema), and the content family has
// no schema dimension at all — labelling either "On page only" would be factually wrong.
const STATE_LABEL = {
  schema:  { yes: 'In schema',  page: 'On page only',    partial: 'Incomplete',       no: 'Missing' },
  count:   { yes: 'In schema',  partial: 'Below target', no: 'Missing' },
  content: { yes: 'Present',    partial: 'Below target', no: 'Absent' },
  inverse: { yes: 'Clean',      no: 'Found' },
};
const STATE_COLOR = {
  yes: 'var(--success)', page: 'var(--warning)', partial: 'var(--warning)', no: 'var(--danger)',
};

const UNSCORED = new Set(['skipped', 'na', 'informational']);

// The AI's issue ids are model-generated free text — nothing server-side validates them
// against the real check list. So findings.checks is the authoritative side and the AI is an
// overlay that gets dropped whenever it does not resolve: a hallucinated id must never reach
// the UI. Also never attach AI text to a pass/na/informational row — only fail|warning|notice
// checks are ever sent to the model, so anything else claiming a fix is fabricated.
function buildAiIndex(findings, ai) {
  const byId = new Map((findings?.checks || []).map(c => [c.id, c]));
  const aiById = new Map();
  for (const s of ai?.sections || []) {
    for (const i of s.issues || []) {
      const id = String(i.id ?? '').trim().toUpperCase()
        .replace(/^CHECK\s*/, '').replace(/\s+/g, '').replace(/[.,;:]+$/, '');
      const c = byId.get(id);
      if (!c || UNSCORED.has(c.status)) continue;
      const prev = aiById.get(id);
      if (!prev || (i.priority ?? 99) < (prev.priority ?? 99)) aiById.set(id, { ...i, id });
    }
  }
  return { byId, aiById };
}

const SEV_RANK = (c) => c.status === 'fail'
  ? (c.severity === 'error' ? 0 : 1)
  : c.status === 'warning' ? 2 : c.status === 'notice' ? 3 : 4;

// asText lives in primitives.jsx — the same coercion is needed by the schema panels on the
// audit page, which crashed on exactly this (see its comment there).

// ── Shared detail renderers ──────────────────────────────────────────────────

const PANEL = {
  background: 'var(--surface)', borderRadius: 8, padding: 14, marginTop: 10,
  border: '1px solid var(--border)',
};
const H = { fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-3)', marginBottom: 4 };
const BODY = { fontSize: 12, color: 'var(--text-2)', lineHeight: 1.6 };

function FixBlock({ content, relatedIds, checks, aiById, aiMissing }) {
  if (!content) return null;
  const related = (relatedIds || '').split(',').map(s => s.trim()).filter(Boolean)
    .map(id => checks.get(id)).filter(Boolean);
  return (
    <div>
      {content.issue ? (
        <div style={{ marginBottom: 10 }}>
          <p style={H}>Issue</p>
          <p style={{ ...BODY, color: 'var(--text)' }}>{content.issue}</p>
        </div>
      ) : null}
      {content.why && (
        <div style={{ marginBottom: 10 }}>
          <p style={H}>Why it matters</p>
          <p style={BODY}>{content.why}</p>
        </div>
      )}
      {content.fix && (
        <div>
          <p style={H}>How to fix</p>
          <p style={BODY}>{content.fix}</p>
        </div>
      )}
      {related.length > 0 && (
        <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
          <p style={H}>Related checks</p>
          {related.map(c => <CheckRow key={c.id} check={c} aiIssue={aiById.get(c.id)} />)}
          {aiMissing && <p style={{ fontSize: 10, color: 'var(--text-3)', marginTop: 6 }}>AI remediation unavailable for this run — showing rule-engine findings only.</p>}
        </div>
      )}
    </div>
  );
}

const STATUS_CHIP = {
  pass: ['var(--success)', 'PASS'], fail: ['var(--danger)', 'FAIL'],
  warning: ['var(--warning)', 'WARN'], notice: ['var(--info)', 'NOTICE'],
  na: ['var(--text-3)', 'N/A'], informational: ['var(--text-3)', 'MEASURED'],
  skipped: ['var(--text-3)', 'SKIPPED'],
};

function CheckRow({ check, aiIssue }) {
  const [color, chip] = STATUS_CHIP[check.status] || STATUS_CHIP.skipped;
  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
        <span style={{ fontSize: 9, fontWeight: 700, color, fontFamily: 'var(--font-mono)', flexShrink: 0, minWidth: 52 }}>{chip}</span>
        <span style={{ fontSize: 11, color: 'var(--text-3)', fontFamily: 'var(--font-mono)', flexShrink: 0 }}>{check.id}</span>
        <span style={{ fontSize: 12, color: 'var(--text)' }}>{check.name}</span>
      </div>
      {check.detail && <p style={{ fontSize: 11, color: 'var(--text-2)', lineHeight: 1.5, marginLeft: 60, marginTop: 2 }}>{check.detail}</p>}
      {aiIssue && (() => {
        const impact = asText(aiIssue.impact);
        const fix = asText(aiIssue.fix) || asText(aiIssue.issue);
        const code = asText(aiIssue.code_example);
        const effort = asText(aiIssue.effort);
        if (!impact && !fix && !code) return null;
        return (
          <div style={{ marginLeft: 60, marginTop: 4, paddingLeft: 8, borderLeft: '2px solid var(--primary)' }}>
            {impact && <p style={{ fontSize: 11, color: 'var(--text-2)', lineHeight: 1.5 }}><strong style={{ color: 'var(--text-3)' }}>Impact — </strong>{impact}</p>}
            {fix && <p style={{ fontSize: 11, color: 'var(--text)', lineHeight: 1.5, marginTop: 2 }}><strong style={{ color: 'var(--text-3)' }}>AI fix — </strong>{fix}</p>}
            {code && (
              <pre style={{ fontSize: 10, background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 4, padding: 8, marginTop: 4, overflowX: 'auto', fontFamily: 'var(--font-mono)', color: 'var(--text-2)', whiteSpace: 'pre-wrap' }}>{code}</pre>
            )}
            {effort && <span style={{ fontSize: 9, color: 'var(--text-3)', fontFamily: 'var(--font-mono)' }}>EFFORT: {effort.toUpperCase()}</span>}
          </div>
        );
      })()}
    </div>
  );
}

// The cap is never silent: without this row a noindex page shows an Indexability
// bar of 89 next to a headline of 25 and recreates the bug the cap exists to fix.
function CapBanner({ cap, composite }) {
  if (!cap?.applied) return null;
  const groups = (cap.groups || []).map(g => {
    const ids = (g.check_ids || []).join(', ');
    return ids ? `${g.reason} (${ids})` : g.reason;
  }).join(' · ');
  return (
    <div style={{
      background: 'var(--danger-soft)', border: '1px solid var(--danger)',
      borderRadius: 8, padding: '8px 12px', marginBottom: 16,
    }}>
      <p style={{ fontSize: 12, fontWeight: 600, color: 'var(--danger)' }}>
        Capped at {cap.value} — {groups}
        {Number.isFinite(composite) ? ` Uncapped composite: ${composite}.` : ''}
      </p>
    </div>
  );
}

function BandLine({ band, score }) {
  if (!band?.label) return null;
  return (
    <p style={{ fontSize: 12, color: 'var(--text-2)', marginBottom: 16, lineHeight: 1.5 }}>
      <span style={{ fontWeight: 700, color: scoreColor(score) }}>{band.label}</span>
      {band.blurb ? ` — ${band.blurb}` : ''}
    </p>
  );
}

// points_lost sums to (100 − composite), so the headline is explainable on screen.
function PointsLostWaterfall({ breakdown, composite, formula }) {
  const rows = breakdown.filter(b => Number.isFinite(b.points_lost) && b.points_lost > 0);
  if (rows.length === 0) return null;
  const total = Math.round(rows.reduce((s, b) => s + b.points_lost, 0) * 10) / 10;
  const worst = Math.max(...rows.map(b => b.points_lost));
  return (
    <div title={formula || undefined} style={{ marginTop: 16, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <p style={CAPTION}>Points Lost</p>
        <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-2)', fontFamily: 'var(--font-mono)' }}>−{total}</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {rows.map(b => (
          <div key={b.key} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11 }}>
            <span style={{ color: 'var(--text-2)', width: 118, flexShrink: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{b.label}</span>
            <div style={{ flex: 1, height: 4, background: 'var(--surface)', borderRadius: 999, overflow: 'hidden' }}>
              <div style={{ height: '100%', borderRadius: 999, width: `${worst > 0 ? (b.points_lost / worst) * 100 : 0}%`, backgroundColor: 'var(--danger)' }} />
            </div>
            <span style={{ width: 36, textAlign: 'right', color: 'var(--danger)', fontFamily: 'var(--font-mono)' }}>−{b.points_lost}</span>
          </div>
        ))}
      </div>
      {Number.isFinite(composite) && (
        <p style={{ fontSize: 10, color: 'var(--text-3)', marginTop: 6, fontFamily: 'var(--font-mono)' }}>
          100 − {total} = {composite}
        </p>
      )}
    </div>
  );
}

// ── Readiness hero ───────────────────────────────────────────────────────────
// The dashboard used to print scores.overall (a /100 weighted mean of ~250 build
// checks) and geo_readiness (a verdict on a 10-point extractability rubric) side by
// side with nothing saying they measure different things — so a page could show a
// green 86 next to a red "Not Ready" and read as if the tool were contradicting
// itself. This hero states the two questions explicitly, gives each track its own
// visual form (ring vs pip meter, never two rings — see PipMeter), and names the one
// place the two actually touch.

const SEARCH_CLAUSE = {
  strong:   'Strong for classic search',
  ok:       'Reasonably solid for classic search',
  weak:     'Weak for classic search',
  critical: 'Failing for classic search',
  blocked:  'Blocked from ranking',
};
const AI_CLAUSE = {
  ready:      'and ready for AI answer engines',
  needs_work: 'but only partly readable by AI answer engines',
  not_ready:  'but not yet readable by AI answer engines',
};

function searchState(overall, cap) {
  if (capIsHardBlock(cap)) return 'blocked';
  if (!Number.isFinite(overall)) return 'weak';
  return overall >= 75 ? 'strong' : overall >= 60 ? 'ok' : overall >= 40 ? 'weak' : 'critical';
}

function ReadinessHero({ findings, breakdown }) {
  const scores = findings.scores;
  const geo = findings.geo;
  const overall = Number.isFinite(scores.overall) ? scores.overall : 0;
  const cap = scores.cap;
  const sState = searchState(scores.overall, cap);
  const aState = answerabilityVerdict(geo);

  const ansScore = geo?.answerability_score ?? geo?.csqaf_score;
  const ansMax = geo?.answerability_max ?? 10;
  const rubric = geo?.answerability_rubric ?? 'CSQAF';
  const parts = Array.isArray(geo?.answerability_breakdown) ? geo.answerability_breakdown : [];

  // Built mechanically from the two states so the sentence can never drift from the
  // numbers printed beneath it.
  const verdict = `${SEARCH_CLAUSE[sState]}${aState ? ` — ${AI_CLAUSE[aState]}` : ''}.`;

  // The genuine, auditable point of contact: the GEO-signals bucket is one of the nine
  // weighted buckets inside scores.overall, so the search score has ALREADY been docked
  // for GEO defects by exactly this much. Everything else in the rubric sits outside it.
  const geoLost = breakdown.find(b => b.key === 'geo_signals')?.points_lost;
  const checksRun = findings.meta?.total_checks_run;

  return (
    <div style={CARD}>
      <p style={CAPTION}>Readiness</p>
      <p style={{ fontSize: 20, fontWeight: 700, color: 'var(--text)', lineHeight: 1.3, marginTop: 6, marginBottom: 16 }}>
        {verdict}
      </p>

      <div style={{
        background: 'var(--surface)', borderRadius: 8, padding: 16,
        display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 0,
      }}>
        {/* Track A — classic SEO, /100, drawn as a ring */}
        <div style={{ paddingRight: 16 }}>
          <p style={CAPTION}>Search Readiness</p>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 10 }}>
            <ScoreRing score={overall} size={64} />
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: scoreColor(overall) }}>
                {scores.band?.label || `${overall}/100`}
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-3)', lineHeight: 1.4, marginTop: 2 }}>
                Classic SEO{Number.isFinite(checksRun) ? ` · ${checksRun} checks` : ''}
              </div>
              {cap?.applied && (
                <div style={{ fontSize: 11, color: 'var(--danger)', marginTop: 2 }}>
                  {capIsHardBlock(cap) ? 'Blocked' : 'Capped'} at {cap.value}
                  {Number.isFinite(scores.composite) ? ` (from ${scores.composite})` : ''}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Track B — extractability rubric, small-integer, drawn as pips (never a ring) */}
        <div style={{ paddingLeft: 16, borderLeft: '1px solid var(--border)' }}>
          <p style={CAPTION}>AI Answer Readiness</p>
          {Number.isFinite(ansScore) ? (
            <>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginTop: 10, marginBottom: 8 }}>
                <span style={{ fontSize: 26, fontWeight: 700, color: 'var(--text)', fontFamily: 'var(--font-mono)' }}>
                  {ansScore}<span style={{ fontSize: 13, color: 'var(--text-3)' }}>/{ansMax}</span>
                </span>
                {aState && (
                  <span style={{
                    fontSize: 11, fontWeight: 600, padding: '3px 8px', borderRadius: 999,
                    background: GEO_BADGE[aState].bg, color: GEO_BADGE[aState].text,
                  }}>
                    {GEO_BADGE[aState].label}
                  </span>
                )}
              </div>
              <PipMeter parts={parts} />
              <div style={{ fontSize: 11, color: 'var(--text-3)', lineHeight: 1.4, marginTop: 8 }}>
                {rubric} rubric · structured data only
              </div>
            </>
          ) : (
            <p style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 10 }}>Not measured for this page.</p>
          )}
        </div>
      </div>

      <p style={{ fontSize: 12, color: 'var(--text-2)', lineHeight: 1.6, marginTop: 12 }}>
        These answer two different questions, so a page can score well on one and badly on
        the other. Search Readiness is a weighted average of every build check on the page
        {Number.isFinite(geoLost) && geoLost > 0
          ? ` — it has already docked ${geoLost} points for GEO defects`
          : ''}. AI Answer Readiness is a separate {ansMax}-point test of whether a machine
        can extract this page&apos;s facts from its structured data.
      </p>
    </div>
  );
}

// Rule-based answerability (F28), not the model's re-derivation — so the card
// survives an AI failure. C/S/Q are never rendered for a commercial page.
function AnswerabilityCard({ findings, aiIndex, aiMissing }) {
  const geo = findings.geo;
  const [open, setOpen] = useState(null);
  if (!geo) return null;
  const ans = geo.answerability_breakdown;
  const rubric = geo.answerability_rubric ?? 'CSQAF';
  const score = geo.answerability_score ?? geo.csqaf_score ?? 0;
  const maxPts = geo.answerability_max ?? 10;
  const earned = geo.answerability_earned;
  const intent = findings.meta?.page_intent ?? 'informational';
  const cols = Array.isArray(ans) && ans.length > 0 ? Math.min(ans.length, 5) : 5;
  const openPart = Array.isArray(ans) ? ans.find(c => c.key === open) : null;
  const openFix = openPart ? rubricFix(openPart, geo, rubric) : null;
  return (
    <div style={CARD}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 12 }}>
        <div>
          <p style={CAPTION}>GEO Answerability — {rubric}</p>
          {intent === 'commercial' && (
            <p style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 4 }}>
              Commercial-intent rubric · citations, statistics and quotations are not scored on this page.
            </p>
          )}
        </div>
        <div style={{ textAlign: 'right', flexShrink: 0 }}>
          <span style={{ fontSize: 24, fontWeight: 700, color: 'var(--text)', fontFamily: 'var(--font-mono)' }}>{score}/10</span>
          {maxPts !== 10 && Number.isFinite(earned) && (
            <span style={{ display: 'block', fontSize: 11, color: 'var(--text-3)' }}>({earned} of {maxPts} pts)</span>
          )}
        </div>
      </div>
      {Array.isArray(ans) && ans.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: `repeat(${cols}, 1fr)`, gap: 8 }}>
          {ans.map(c => {
            const active = open === c.key;
            return (
              <div key={c.key}
                onClick={() => setOpen(active ? null : c.key)}
                role="button" tabIndex={0}
                onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(active ? null : c.key); } }}
                style={{
                  background: 'var(--surface)', borderRadius: 8, padding: 10, textAlign: 'center',
                  cursor: 'pointer', border: `1px solid ${active ? 'var(--primary)' : 'transparent'}`,
                }}>
                <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--text)', fontFamily: 'var(--font-mono)' }}>{c.key}</div>
                <div style={{ fontSize: 12, color: 'var(--text-2)' }}>{c.label}</div>
                <div style={{ fontSize: 12, fontWeight: 600, color: c.points >= c.max ? 'var(--success)' : c.points > 0 ? 'var(--warning)' : 'var(--danger)', marginTop: 4, fontFamily: 'var(--font-mono)' }}>
                  {c.points}/{c.max}
                </div>
                {c.finding && (
                  <div style={{ fontSize: 10, color: 'var(--text-3)', marginTop: 4, lineHeight: 1.4 }}>{c.finding}</div>
                )}
                <div style={{ fontSize: 10, color: active ? 'var(--primary)' : 'var(--text-3)', marginTop: 6 }}>
                  {active ? '▾ close' : '▸ how to fix'}
                </div>
              </div>
            );
          })}
        </div>
      )}
      {openPart && (
        <div style={PANEL}>
          <p style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)', marginBottom: 8 }}>
            {openPart.key} — {openPart.label} · {openPart.points}/{openPart.max}
          </p>
          {openFix ? (
            <FixBlock content={openFix.content} relatedIds={openFix.ids}
              checks={aiIndex.byId} aiById={aiIndex.aiById} aiMissing={aiMissing} />
          ) : (
            <p style={BODY}>{openPart.finding}</p>
          )}
        </div>
      )}
    </div>
  );
}

// Which remediation entry applies is decided from the real geo.* facts, not by parsing the
// finding sentence. 'A' is ambiguous across rubrics — Availability in NAPEF, Authoritativeness
// in CSQAF — so the rubric name has to disambiguate before the letter is used as a key.
function rubricFix(part, geo, rubric) {
  const { key, points, max } = part;
  const full = points >= max;
  const entryKey = (key === 'A' && rubric === 'CSQAF') ? 'A_CSQAF' : key;
  const table = RUBRIC_FIX[entryKey];
  if (!table) return null;
  let state;
  if (full) state = 'full';
  else if (entryKey === 'N') state = points === 1 ? 'partial' : (geo.nap_on_page ? 'text_only' : 'absent');
  else if (entryKey === 'A') state = geo.hours_valid ? 'no_geo'
    : geo.hours_on_page ? 'text_only'
    : points === 1 ? 'invalid' : 'absent';
  else if (entryKey === 'P') state = points === 1 ? 'partial' : (geo.reviews_on_page ? 'text_only' : 'absent');
  else if (entryKey === 'E') state = points === 1
    ? ((geo.sameas_count ?? 0) >= 3 ? 'needs_id' : 'needs_sameas')
    : 'absent';
  else if (entryKey === 'F') state = points === 1
    ? ((geo.promotional_language_count ?? 0) === 0 ? 'structure' : 'promo')
    : 'absent';
  else state = points === 0 ? 'absent' : 'partial';
  const content = table[state] || table.absent || null;
  return content ? { content, ids: table.ids } : null;
}

// Renamed from "GEO Signals" — that label already belongs to one of the nine weighted
// scoring buckets in the bar stack, and using it for this raw-presence grid too meant the
// same words named two different measurements on one screen.
//
// Three states, not two. A bare red "No" could not distinguish "this page has no address
// anywhere" from "the address is right there in the page text, it just isn't marked up" —
// which is the single thing that made the audit look wrong on a page plainly showing its
// address. Amber now means "you have the fact, encode it"; red means genuinely absent.
// Grey is deliberately avoided: it already means na/skipped in the keyword grid, so using
// it for a scored, docked failure would soften a real defect into a shrug.
function GeoSignalsCard({ findings, aiIndex, aiMissing }) {
  const geo = findings.geo;
  const [open, setOpen] = useState(null);
  if (!geo) return null;
  const intent = findings.meta?.page_intent ?? 'informational';

  // 'page' is reserved for "the fact is in the page text but not in markup" and is only
  // valid for the three tiles that have a *_on_page counterpart. A below-threshold count is
  // 'partial', NOT 'page' — 1-2 sameAs URLs are in schema, and statistics never are, so
  // labelling either "On page only" would state something untrue.
  const tri = (inSchema, onPage) => (inSchema ? 'yes' : onPage ? 'page' : 'no');
  const band = (n, target) => (n >= target ? 'yes' : n > 0 ? 'partial' : 'no');

  const head = intent === 'commercial'
    ? [
        ['Address & phone',  tri(geo.nap_complete, geo.nap_on_page)],
        ['Opening hours',    tri(geo.hours_valid, geo.hours_on_page)],
        ['Reviews & rating', tri(geo.review_markup, geo.reviews_on_page)],
        ['sameAs profiles',  band(geo.sameas_count ?? 0, 3), `${geo.sameas_count ?? 0} linked`],
        ['Service area',     geo.service_area_clear ? 'yes' : 'no'],
      ]
    : [
        ['Statistics',      band(geo.statistics_count ?? 0, 4), `${geo.statistics_count ?? 0} found`],
        ['Expert quotes',   geo.expert_quotes > 0 ? 'yes' : 'no', `${geo.expert_quotes ?? 0} found`],
        ['Named author',    geo.named_author ? 'yes' : 'no'],
        ['Primary sources', geo.primary_source_citations > 0 ? 'yes' : 'no', `${geo.primary_source_citations ?? 0} cited`],
        ['Data tables',     geo.html_tables > 0 ? 'yes' : 'no', `${geo.html_tables ?? 0} found`],
      ];

  // The rubric composite tile that used to sit here is gone — it now headlines the hero,
  // and printing it twice on one screen was part of why the two axes read as one.
  const tiles = [
    ...head,
    ['FAQ section',           geo.faq_section ? 'yes' : 'no'],
    ['Direct answer opening', geo.direct_answer_opening ? 'yes' : 'no'],
    // Inverted tile: zero promotional terms is the GOOD state. It used to render "Missing"
    // when promo language was *present*, which read as the exact opposite of the finding.
    ['Promotional wording',   (geo.promotional_language_count ?? 0) === 0 ? 'yes' : 'no',
      `${geo.promotional_language_count ?? 0} term(s)`],
  ];

  const anyOnPage = tiles.some(([, state]) => state === 'page');
  const openTile = tiles.find(([label]) => label === open);
  const openMeta = openTile ? TILE_FIX[openTile[0]] : null;
  const openContent = openMeta ? openMeta[openTile[1]] : null;

  return (
    <div style={CARD}>
      <p style={CAPTION}>{intent === 'commercial' ? 'Structured Data Coverage' : 'Content Signals'}</p>
      <p style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 4, marginBottom: 12, lineHeight: 1.5 }}>
        What a machine can extract from this page. &ldquo;On page only&rdquo; means the fact is
        there in the text but not encoded as markup — a markup task, not missing content.
        Click any tile for the fix.
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
        {tiles.map(([label, state, sub]) => {
          const family = TILE_FIX[label]?.family || 'schema';
          const text = (STATE_LABEL[family] && STATE_LABEL[family][state]) || STATE_LABEL.schema[state] || state;
          const active = open === label;
          const hasFix = !!(TILE_FIX[label] && TILE_FIX[label][state]);
          return (
            <div key={label}
              onClick={() => setOpen(active ? null : label)}
              role="button" tabIndex={0}
              onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(active ? null : label); } }}
              style={{
                background: 'var(--surface)', borderRadius: 8, padding: 10, textAlign: 'center',
                cursor: 'pointer', border: `1px solid ${active ? 'var(--primary)' : 'transparent'}`,
              }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: STATE_COLOR[state] || 'var(--text-3)' }}>{text}</div>
              <div style={{ fontSize: 12, color: 'var(--text-2)', marginTop: 3, lineHeight: 1.3 }}>{label}</div>
              {sub && <div style={{ fontSize: 10, color: 'var(--text-3)', marginTop: 2, fontFamily: 'var(--font-mono)' }}>{sub}</div>}
              <div style={{ fontSize: 10, color: active ? 'var(--primary)' : 'var(--text-3)', marginTop: 5 }}>
                {active ? '▾ close' : hasFix ? '▸ how to fix' : '▸ details'}
              </div>
            </div>
          );
        })}
      </div>
      {openTile && (
        <div style={PANEL}>
          <p style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)', marginBottom: 8 }}>{openTile[0]}</p>
          {openContent
            ? <FixBlock content={openContent} relatedIds={openMeta.ids}
                checks={aiIndex.byId} aiById={aiIndex.aiById} aiMissing={aiMissing} />
            : <p style={BODY}>This signal is in place — nothing to fix. Keep it in step with the page content as it changes.</p>}
        </div>
      )}
      {anyOnPage && (
        <p style={{ fontSize: 11, color: 'var(--warning)', marginTop: 10 }}>
          Amber items are the fastest wins — the content already exists, it just needs marking up.
        </p>
      )}
    </div>
  );
}

// Bucket click-through. Every number in the sentence is a real field: the tier-weighted
// mean is what calculateScores() actually computes, and effective_weight (not weight) is the
// share of the headline — the nine declared weights sum to 1.12, so raw weight would overstate
// every bucket. points_lost sums to 100 - composite, which is why a cap gets its own line.
function BucketDetail({ bucket, findings, aiIndex, aiMissing, cap }) {
  const info = BUCKET_INFO[bucket.key];
  const cats = Array.isArray(bucket.categories) ? bucket.categories : null;
  const inBucket = cats ? (findings.checks || []).filter(c => cats.includes(c.category)) : [];
  const scored = inBucket.filter(c => !UNSCORED.has(c.status));
  const naC = inBucket.filter(c => c.status === 'na');
  const infoC = inBucket.filter(c => c.status === 'informational');

  const issues = scored.filter(c => c.status === 'fail' || c.status === 'warning')
    .sort((a, b) => SEV_RANK(a) - SEV_RANK(b) || a.id.localeCompare(b.id));
  const opps = scored.filter(c => c.status === 'notice').sort((a, b) => a.id.localeCompare(b.id));
  const passing = scored.filter(c => c.status === 'pass');

  // A cap fired by a check inside THIS bucket is the most important thing in the panel.
  const capGroup = (cap?.groups || []).find(g => (g.check_ids || []).some(id => inBucket.some(c => c.id === id)));

  const excl = [
    naC.length && `${naC.length} not applicable`,
    infoC.length && `${infoC.length} measurement-only`,
  ].filter(Boolean).join(', ');

  return (
    <div style={PANEL}>
      {capGroup && (
        <p style={{ fontSize: 12, color: 'var(--danger)', fontWeight: 600, marginBottom: 8 }}>
          Blocking: {capGroup.reason}
        </p>
      )}
      {info && (
        <>
          <p style={H}>What this measures</p>
          <p style={{ ...BODY, marginBottom: 10 }}>{info.why}</p>
          <p style={H}>Highest-leverage fix</p>
          <p style={{ ...BODY, marginBottom: 10 }}>{info.fix}</p>
        </>
      )}

      {cats ? (
        <p style={{ fontSize: 11, color: 'var(--text-3)', lineHeight: 1.6, paddingTop: 8, borderTop: '1px solid var(--border)' }}>
          Scored {bucket.score}/100 from {bucket.checks_scored} scored check{bucket.checks_scored === 1 ? '' : 's'}
          {excl ? ` (${excl} — excluded from both sides of the average)` : ''}. Each scored check is
          worth 100 (pass), 85 (notice), 50 (warning), 25 (minor fail) or 0 (error), weighted by an
          importance tier of 1–3.
          {Number.isFinite(bucket.effective_weight) && Number.isFinite(bucket.points_lost)
            ? ` This bucket carries ${(bucket.effective_weight * 100).toFixed(1)}% of the overall score, so scoring ${bucket.score} instead of 100 cost the page ${bucket.points_lost} points.`
            : ''}
          {cap?.applied ? ` The headline is capped at ${cap.value} by a blocking defect, so it reads ${findings.scores.overall} rather than the ${findings.scores.composite} these bars produce.` : ''}
        </p>
      ) : (
        <p style={{ fontSize: 11, color: 'var(--text-3)', paddingTop: 8, borderTop: '1px solid var(--border)' }}>
          This run was saved before per-bucket check detail was recorded, so the individual findings
          are not available. Re-run the audit to see them.
        </p>
      )}

      {issues.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <p style={H}>Issues ({issues.length})</p>
          {issues.map(c => <CheckRow key={c.id} check={c} aiIssue={aiIndex.aiById.get(c.id)} />)}
        </div>
      )}
      {opps.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <p style={H}>Opportunities ({opps.length})</p>
          <p style={{ fontSize: 10, color: 'var(--text-3)', marginBottom: 2 }}>Scores 85/100 — a missing nice-to-have, not a defect.</p>
          {opps.map(c => <CheckRow key={c.id} check={c} aiIssue={aiIndex.aiById.get(c.id)} />)}
        </div>
      )}
      {naC.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <p style={H}>Not applicable to this page ({naC.length})</p>
          <p style={{ fontSize: 10, color: 'var(--text-3)', marginBottom: 2 }}>Excluded from the score entirely — neither numerator nor denominator.</p>
          {naC.map(c => <CheckRow key={c.id} check={c} />)}
        </div>
      )}
      {infoC.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <p style={H}>Measurements ({infoC.length})</p>
          {infoC.map(c => <CheckRow key={c.id} check={c} />)}
        </div>
      )}
      {issues.length === 0 && opps.length === 0 && passing.length > 0 && (
        <p style={{ ...BODY, marginTop: 12, color: 'var(--success)' }}>
          All {passing.length} scored checks in this bucket pass.
        </p>
      )}
      {aiMissing && issues.length > 0 && (
        <p style={{ fontSize: 10, color: 'var(--text-3)', marginTop: 8 }}>
          AI remediation unavailable for this run — showing rule-engine findings only.
        </p>
      )}
      {findings.meta?.checks_truncated > 0 && (
        <p style={{ fontSize: 10, color: 'var(--text-3)', marginTop: 6 }}>
          {findings.meta.checks_truncated} lower-priority checks were not sent to the AI, so some rows
          show rule-engine detail only.
        </p>
      )}
    </div>
  );
}

export default function ScoreDashboard({ findings, ai }) {
  const scores = findings?.scores;
  const aiSummary = ai?.summary;
  const [openBucket, setOpenBucket] = useState(null);
  const aiIndex = useMemo(() => buildAiIndex(findings, ai), [findings, ai]);
  if (!scores) return null;

  const aiMissing = !ai;
  const breakdown = resolveBreakdown(scores);
  const overall = Number.isFinite(scores.overall) ? scores.overall : 0;

  return (
    // One column, not a three-column grid.
    //
    // The grid put the composition card (nine bucket bars, a points-lost
    // waterfall and an expandable detail panel per bar) into one third of the
    // width beside a stack of four cards in the other two thirds. The bars were
    // 180px wide with their labels ellipsed, and the reading order down the page
    // was: verdict, then the arithmetic, then — back at the top of the next
    // column — the rubric the verdict was half about.
    //
    // Stacked, each block gets the full measure and the order is the order of
    // the argument: what the two scores are, how the search score was built,
    // how the answerability score was built, what to do, and what a machine can
    // currently extract.
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

      <ReadinessHero findings={findings} breakdown={breakdown} />

      {/* How the Search Readiness score is built. The two verdict pills that used to sit
          beside this ring are gone: geo_readiness now lives in the hero next to the rubric
          it actually describes, and the E-E-A-T pill is below, attributed to the model —
          it was rendering a red "weak" directly beside an 84/100 E-E-A-T bucket bar. */}
      <div style={CARD}>
        <p style={{ ...CAPTION, marginBottom: 16 }}>Search Readiness — Composition</p>

        {scores.cap?.applied
          ? <CapBanner cap={scores.cap} composite={scores.composite} />
          : <BandLine band={scores.band} score={overall} />}

        {aiSummary?.priority_verdict && (
          <div style={{ background: 'var(--danger-soft)', border: '1px solid var(--danger)', borderRadius: 8, padding: 12, marginBottom: 16 }}>
            <p style={{ fontSize: 12, fontWeight: 600, color: 'var(--danger)', marginBottom: 4 }}>Priority Issue</p>
            <p style={{ fontSize: 14, color: 'var(--danger)' }}>{aiSummary.priority_verdict}</p>
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {breakdown.map(b => (
            <div key={b.key}>
              <ScoreBar
                label={b.label}
                score={b.score}
                checksScored={b.checks_scored}
                effectiveWeight={b.effective_weight}
                active={openBucket === b.key}
                onClick={() => setOpenBucket(openBucket === b.key ? null : b.key)}
              />
              {openBucket === b.key && (
                <BucketDetail bucket={b} findings={findings} aiIndex={aiIndex}
                  aiMissing={aiMissing} cap={scores.cap} />
              )}
            </div>
          ))}
        </div>

        <PointsLostWaterfall breakdown={breakdown} composite={scores.composite} formula={scores.formula} />

        {/* Explicitly attributed to the model, and explicitly a different thing from the
            E-E-A-T bar above it: the bar counts checks, this judges entity trust. Shown as
            a labelled line rather than a bare red pill so the two no longer look like the
            same measurement disagreeing with itself. */}
        {aiSummary?.eeat_strength && (
          <p style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 12, lineHeight: 1.5 }}>
            AI&apos;s qualitative read of E-E-A-T:{' '}
            <span style={{ fontWeight: 700, color: EEAT_BADGE[aiSummary.eeat_strength]?.text }}>
              {aiSummary.eeat_strength}
            </span>
            {' '}— a judgement on entity trust (credentials, NAP consistency, review markup),
            separate from the check-based E-E-A-T bar above.
          </p>
        )}
      </div>

      {/* How the answerability score was built, then what to do, then what a
          machine can extract today. The rubric card moved ABOVE quick wins: the
          design puts it directly under the composition it is the counterpart to,
          and half the verdict sentence at the top of the page is about it. */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

        <AnswerabilityCard findings={findings} aiIndex={aiIndex} aiMissing={aiMissing} />

        {aiSummary?.quick_wins?.length > 0 && (
          <div style={CARD}>
            <p style={{ ...CAPTION, marginBottom: 12 }}>Quick Wins</p>
            <ul style={{ display: 'flex', flexDirection: 'column', gap: 8, listStyle: 'none', padding: 0, margin: 0 }}>
              {aiSummary.quick_wins.map((w, i) => (
                <li key={i} style={{ display: 'flex', gap: 10, fontSize: 14 }}>
                  <span style={{ width: 20, height: 20, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 700, flexShrink: 0, color: '#fff', background: 'var(--primary)' }}>{i + 1}</span>
                  <span style={{ color: 'var(--text)' }}>{w}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <GeoSignalsCard findings={findings} aiIndex={aiIndex} aiMissing={aiMissing} />

        {/* Keyword Analysis.
            Not in the design, kept anyway: it is the only place in the report
            that says whether the page targets the keyword it was audited
            against, and nine of its checks have nowhere else to be read. It
            sits last because it answers a narrower question than everything
            above it. */}
        {findings.meta.keywords?.length > 0 && findings.kwChecks?.length > 0 && (
          <div style={CARD}>
            <p style={{ ...CAPTION, marginBottom: 12 }}>
              Keyword Analysis — "{findings.meta.keywords[0]}"
            </p>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 12 }}>
              {[
                ['Title', findings.kwChecks.find(c => c.id === 'KW1')],
                ['H1', findings.kwChecks.find(c => c.id === 'KW2')],
                ['Meta Desc', findings.kwChecks.find(c => c.id === 'KW3')],
                ['Density', findings.kwChecks.find(c => c.id === 'KW8')],
                ['URL', findings.kwChecks.find(c => c.id === 'KW5')],
                ['H2', findings.kwChecks.find(c => c.id === 'KW6')],
                ['Alt Text', findings.kwChecks.find(c => c.id === 'KW7')],
                ['Schema', findings.kwChecks.find(c => c.id === 'KW9')],
              ].map(([label, chk]) => {
                if (!chk) return null;
                const statusColor = {
                  pass: 'var(--success)', fail: 'var(--danger)',
                  warning: 'var(--warning)', notice: 'var(--info)', skipped: 'var(--text-3)',
                  na: 'var(--text-3)', informational: 'var(--text-3)',
                }[chk.status] || 'var(--text-3)';
                const statusIcon = chk.status === 'pass' ? '✓' : chk.status === 'fail' ? '✕'
                  : (chk.status === 'na' || chk.status === 'informational') ? '–' : '~';
                const detail = [chk.tier, Number.isFinite(chk.matchScore) ? `${chk.matchScore}%` : null]
                  .filter(Boolean).join(' · ');
                return (
                  <div key={label} title={chk.evidence || chk.detail || undefined} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, border: '1px solid var(--border)', borderRadius: 4, padding: 8 }}>
                    <span style={{ fontWeight: 700, color: statusColor }}>{statusIcon}</span>
                    <span style={{ color: 'var(--text-2)' }}>{label}</span>
                    {detail && <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--text-3)', fontFamily: 'var(--font-mono)' }}>{detail}</span>}
                  </div>
                );
              })}
            </div>
            {ai?.keyword_analysis && (
              <p style={{ fontSize: 12, color: 'var(--text)', fontStyle: 'italic' }}>{ai.keyword_analysis.summary}</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export function AuditMetaBar({ findings }) {
  if (!findings?.meta) return null;
  return (
    <div style={{
      background: 'var(--card)', borderRadius: 'var(--r-lg)', border: '1px solid var(--border)',
      padding: '12px 20px', marginBottom: 16,
      display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap',
      fontSize: 12, color: 'var(--text-2)', boxShadow: '0 1px 3px rgba(0,0,0,0.07)',
    }}>
      <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 320 }}>{findings.meta.url}</span>
      <span>HTTP {findings.meta.http_status || '—'}</span>
      <span>{Math.round(findings.meta.html_size_bytes / 1024)}KB</span>
      <span>{findings.meta.fetch_time_ms}ms</span>
      <span>{findings.meta.total_checks_run} checks</span>
      <span style={{ color: 'var(--danger)', fontWeight: 500 }}>{findings.meta.errors} errors</span>
      <span style={{ color: 'var(--warning)', fontWeight: 500 }}>{findings.meta.warnings} warnings</span>
      <span style={{ color: 'var(--info)' }}>{findings.meta.notices} notices</span>
      <span style={{ color: 'var(--success)' }}>{findings.meta.passed} passed</span>
      {findings.meta.page_type && findings.meta.page_type !== 'unknown' && (
        <span style={{ fontWeight: 500, textTransform: 'capitalize', color: 'var(--primary)' }}>
          {findings.meta.page_type.replace('_', ' ')} page
          {findings.meta.is_ymyl ? ' · YMYL' : ''}
        </span>
      )}
      {findings.meta.page_intent && (
        <span style={{ fontWeight: 500, textTransform: 'capitalize', color: 'var(--text-2)' }}>
          {findings.meta.page_intent} intent{findings.meta.page_intent_source === 'detected' ? ' (auto)' : ''}
        </span>
      )}
      {findings.meta.keywords?.length > 0 && (
        <span style={{ color: 'var(--primary)' }}>KW: {findings.meta.keywords.join(', ')}</span>
      )}
    </div>
  );
}
