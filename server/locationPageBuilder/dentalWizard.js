// ── Gentle Dental wizard orchestrator — Build Brief §3 Step 3 ──────────────
// Kept separate from pageService.js (which drives the heavier Neuro
// pipeline: SERP/SEMrush keyword mining, competitor scraping, multi-gate
// approval, versioning). The dental wizard is deliberately lighter — one
// structured LLM call, no approval workflow — so it gets its own thin
// orchestrator rather than threading page_type conditionals through
// pageService's Neuro-specific functions.

const store = require('./store');
const config = require('./config');
const compose = require('./compose');
const contentGenerator = require('./contentGenerator');
const dentalOutline = require('./dentalOutline');
const schemaGenerator = require('./schemaGenerator');
const qaEngine = require('./qaEngine');
const internalLinks = require('./internalLinks');
const { disambiguate } = require('./keywordAdapter');
const { searchGoogle } = require('../services/googleSearch');
const { scrapeUrlsDetailed } = require('../services/scraper');

const COMPETITOR_URL_COUNT = 5;
const OWN_DOMAIN = 'gentledental.com';

// Real-competitor research for the primary keyword: SERP it, scrape the top
// (non-Gentle-Dental) results for their H2/H3 headings and any detected FAQ
// questions, so educationalBody + faqs can be modeled on actual coverage
// rather than the LLM's unaided guess. Cached (scraping is the expensive
// part) and fully fault-tolerant — a SERP or scrape failure falls back to
// empty arrays rather than failing the whole generation (contentGenerator
// already handles the no-competitor-data case).
async function researchCompetitors(primaryKeyword) {
  const cacheK = store.cacheKey('dental-competitor-research', primaryKeyword);
  const cached = await store.cacheGet(cacheK, config.cache.serpTtlMs);
  if (cached) return cached;

  let result = { headings: [], faqs: [] };
  try {
    const serp = await searchGoogle(disambiguate(primaryKeyword));
    const urls = (serp.results || [])
      .filter(r => r.url && !r.url.includes(OWN_DOMAIN))
      .slice(0, COMPETITOR_URL_COUNT)
      .map(r => r.url);

    if (urls.length) {
      const scraped = await scrapeUrlsDetailed(urls);
      const successes = scraped.filter(s => s.success);
      const headings = new Set();
      const faqs = new Set();
      successes.forEach(s => {
        [...(s.h2s || []), ...(s.h3s || [])].forEach(h => headings.add(h));
        (s.faqs || []).forEach(f => faqs.add(f));
      });
      result = { headings: [...headings].slice(0, 25), faqs: [...faqs].slice(0, 15) };
    }
  } catch {
    // SERP/scrape failure — fall back to LLM-only generation, don't fail the wizard.
  }

  await store.cacheSet(cacheK, result, { kind: 'serp', ttlMs: config.cache.serpTtlMs });
  return result;
}

// What the wizard's review screen shows about the outline decision: the grade
// the planner gave the scraped headings, why, and where each H2 came from.
// Persisted on the page object so a reviewer opening a saved page still sees
// it without re-running the planner.
//
// Built from the blocks that actually landed on the page, NOT from the plan:
// the wizard labels each heading by list position, so if the writer returned a
// different number of blocks than were planned, provenance read off the plan
// would label the wrong headings. Any block with no counterpart in the plan
// gets a null source, which the UI renders as no tag rather than a guess.
function outlineMetaOf(outline, scaffold) {
  const planned = outline.blocks || [];
  const blocks = scaffold?.sections?.educationalBody?.blocks || planned;
  return {
    competitorQuality: outline.competitorQuality,
    rationale: outline.rationale,
    sources: blocks.map((b, i) => ({ h2: b.h2, source: planned[i]?.source || null })),
  };
}

// Only one page per (client, service, location) tuple is ever allowed — every
// write path in this file goes through this lookup + upsert-by-id so a
// second generate/regenerate for the same tuple always updates the existing
// row instead of creating a duplicate.
async function findExistingPage({ clientId, serviceId, locationId }) {
  const pages = await store.list('pages', { client_id: clientId });
  return pages.find(p => p.service_id === serviceId && p.location_id === locationId) || null;
}

async function getExistingPage({ clientId, serviceId, locationId }) {
  return findExistingPage({ clientId, serviceId, locationId });
}

async function savePage({ clientId, serviceId, locationId, scaffold, existing }) {
  const record = {
    client_id: clientId, service_id: serviceId, location_id: locationId,
    page_type: 'dental_location_service',
    status: 'Content Generated',
    page_object: scaffold,
  };
  const saved = existing
    ? await store.update('pages', existing.id, record)
    : await store.insert('pages', record, 'dpg');
  return saved;
}

// ── Approved keyword selections ─────────────────────────────────────────────
// Keyed by the same (client, service, location) tuple as the page row. The
// implementation moved to keywordSelectionStore.js when the template-driven
// engine needed the identical records — nothing about it was dental-specific,
// and its deterministic-id upsert is too subtle to keep two copies of. They
// are re-exported below so this module's API is unchanged.
const { tupleKey, saveSelection, getSelection, recordApproval } = require('./keywordSelectionStore');

// ── Editing an already-generated page ───────────────────────────────────────
// Manual edits in step 4 were previously held in React state only and lost on
// navigate-away; this is the write path for them.
async function saveContent({ pageId, page }) {
  const existing = await store.get('pages', pageId);
  if (!existing || existing.page_type !== 'dental_location_service') {
    throw new Error('Page not found.');
  }
  // Shape guard: page_object is read unguarded by the dashboard and the
  // exporters, so refuse anything that isn't recognisably a GeneratedPage
  // rather than storing a payload that breaks those later. Shares the QC
  // engine's predicate so the two can't drift apart.
  if (!qaEngine.isDentalScaffold(page)) {
    throw new Error('A valid page object (meta + sections) is required.');
  }
  // Re-run QC over what is actually being stored. runDentalQC is pure and
  // synchronous (no LLM, no network), and without this an edit would leave the
  // PREVIOUS verdict on the record -- so the pages dashboard could show PASS
  // for content that no longer passes.
  const scaffold = { ...page, qc: qaEngine.runDentalQC(page) };
  return store.update('pages', pageId, { page_object: scaffold });
}

// Persist a QC verdict onto the saved page (POST /wizard/qc is otherwise pure).
async function saveQc({ pageId, qc }) {
  const existing = await store.get('pages', pageId);
  if (!existing || existing.page_type !== 'dental_location_service') return null;
  const page_object = { ...existing.page_object, qc };
  return store.update('pages', pageId, { page_object });
}

// Generates (or regenerates) the full GeneratedPage for one (service, location)
// tuple and persists it to the shared `pages` collection — ALWAYS saved,
// ALWAYS keyed by the tuple (see findExistingPage/savePage above), so
// re-running the wizard for the same page updates it in place instead of
// creating a duplicate row.
//
// primaryKeywords: up to 2 (matching the keyword-research module's model).
// The FIRST drives every QC gate (H1/title/meta, H2, 5x frequency — a single
// page realistically optimizes for one main term). The SECOND, if present,
// is folded into secondaryKeywords — woven in naturally without being held
// to the same strict structural checks.
async function generatePage({ clientId, serviceId, locationId, primaryKeywords, secondaryKeywords }) {
  const primaries = (primaryKeywords || []).filter(Boolean);
  if (!primaries.length) throw new Error('At least one primary keyword is required.');
  const primaryKeyword = primaries[0];
  const mergedSecondary = [...primaries.slice(1), ...(secondaryKeywords || [])];

  const layers = await compose.loadLayers({ clientId, serviceId, locationId });
  const { client, service, location } = layers;

  const scaffold = compose.buildDentalScaffold(layers);
  scaffold.primaryKeyword = primaryKeyword;
  scaffold.primaryKeywords = primaries;
  scaffold.secondaryKeywords = mergedSecondary;

  const { headings: competitorHeadings, faqs: competitorFaqs } = await researchCompetitors(primaryKeyword);

  // Decide the H2 stack BEFORE writing: Sonnet grades the scraped headings and
  // either leans on them, blends them with the curated fallback ladder, or
  // discards them entirely (see dentalOutline.js). The writer then fills this
  // outline in rather than choosing its own sections.
  const outline = await dentalOutline.planDentalOutline({
    service, location, primaryKeyword, secondaryKeywords: mergedSecondary,
    competitorHeadings, competitorFaqs,
  });
  // The practice name for this page: most offices are Gentle Dental, some
  // carry their own local brand. compose already resolved it onto the
  // scaffold; pass the same value to the writer so the copy matches the title.
  const brandName = scaffold.meta.brandName;

  const l3 = await contentGenerator.generateDentalL3({
    service, location, primaryKeyword, secondaryKeywords: mergedSecondary,
    outline, competitorFaqs, brandName,
  });
  compose.mergeDentalL3(scaffold, l3);
  scaffold.outlineMeta = outlineMetaOf(outline, scaffold);

  const allLocations = await store.list('locations', { client_id: clientId });
  scaffold.sections.servicesInCity.internalLinks = internalLinks.buildDentalSiblings({
    allLocations, currentLocation: location, service,
  });

  scaffold.schema = schemaGenerator.generateDentalSchema({ scaffold, client, location, service });
  scaffold.qc = qaEngine.runDentalQC(scaffold);

  const existing = await findExistingPage({ clientId, serviceId, locationId });
  const saved = await savePage({ clientId, serviceId, locationId, scaffold, existing });

  // Record the approval too, so a page generated without going through the
  // explicit approve step still leaves a durable keyword record behind.
  // Non-fatal: never lose a generated page over a bookkeeping write.
  try {
    // Only keyword STRINGS reach this function; recordApproval re-uses the
    // rich candidate objects (volume/difficulty/intent/source) already stored
    // for the same keywords, so generating cannot flatten a just-approved
    // selection back to bare keywords.
    await recordApproval({
      clientId, serviceId, locationId,
      primary: primaries, secondary: mergedSecondary,
    });
  } catch (e) {
    console.error('[dentalWizard] Failed to record keyword selection:', e.message);
  }

  return { pageId: saved.id, page: scaffold };
}

// Regenerate ONE section of an already-generated page in place — "regenerate
// every section" without re-running (and re-billing) the whole pipeline.
// section: 'heroIntro' | 'metaDescription' | 'educationalBlock' (needs
// blockIndex) | 'educationalBody' (all blocks) | 'faqs'.
async function regenerateSection({ clientId, serviceId, locationId, section, blockIndex }) {
  const existing = await findExistingPage({ clientId, serviceId, locationId });
  if (!existing?.page_object) throw new Error('Generate the page before regenerating a section.');

  const layers = await compose.loadLayers({ clientId, serviceId, locationId });
  const { client, service, location } = layers;
  const scaffold = structuredClone(existing.page_object);
  const primaryKeyword = scaffold.primaryKeyword;
  const secondaryKeywords = scaffold.secondaryKeywords || [];

  const { headings: competitorHeadings, faqs: competitorFaqs } = await researchCompetitors(primaryKeyword);

  const context = {};
  if (section === 'educationalBlock') {
    const blocks = scaffold.sections.educationalBody.blocks || [];
    if (blockIndex == null || !blocks[blockIndex]) throw new Error('blockIndex is required and must reference an existing block.');
    context.currentH2 = blocks[blockIndex].h2;
    context.otherHeadings = blocks.filter((_, i) => i !== blockIndex).map(b => b.h2);
  } else if (section === 'faqItem') {
    const items = scaffold.sections.faq.items || [];
    if (blockIndex == null || !items[blockIndex]) throw new Error('blockIndex is required and must reference an existing FAQ item.');
    context.currentQ = items[blockIndex].q;
    context.otherQuestions = items.filter((_, i) => i !== blockIndex).map(f => f.q);
  }

  // A full-stack rewrite re-decides the outline (the SERP may have moved, and
  // the reviewer is explicitly asking for a different stack). Single-field and
  // single-block regens keep the headings they have.
  let outline = null;
  if (section === 'educationalBody') {
    outline = await dentalOutline.planDentalOutline({
      service, location, primaryKeyword, secondaryKeywords, competitorHeadings, competitorFaqs,
    });
  }

  const result = await contentGenerator.generateDentalRegen({
    service, location, primaryKeyword, secondaryKeywords, competitorHeadings, competitorFaqs, section, context, outline,
    brandName: scaffold.meta.brandName,
  });

  if (section === 'heroIntro') {
    scaffold.sections.hero.intro = result.heroIntro || scaffold.sections.hero.intro;
  } else if (section === 'metaDescription') {
    scaffold.meta.metaDescription = result.metaDescription || scaffold.meta.metaDescription;
  } else if (section === 'educationalBlock') {
    scaffold.sections.educationalBody.blocks[blockIndex] = { h2: result.h2 || '', html: result.html || '' };
    // This heading was written fresh, not chosen by the outline planner, so
    // its provenance tag would now be a lie. Keep the h2 in sync and drop the
    // source rather than attributing it to a competitor or the ladder.
    const sources = scaffold.outlineMeta?.sources;
    if (Array.isArray(sources) && sources[blockIndex]) {
      sources[blockIndex] = { h2: result.h2 || '', source: null };
    }
  } else if (section === 'educationalBody') {
    if (Array.isArray(result.educationalBody)) {
      scaffold.sections.educationalBody.blocks = result.educationalBody.map(b => ({ h2: b.h2 || '', html: b.html || '' }));
    }
    scaffold.outlineMeta = outlineMetaOf(outline, scaffold);
  } else if (section === 'faqs') {
    // Never let a rewrite leave the page with FEWER FAQs than it started with
    // when that would break the Critical faq_count_min_4 gate. The generator
    // already retries a short response; if even the retry comes back short,
    // keeping the existing block beats destroying a passing page. The reviewer
    // can simply click regenerate again.
    const next = Array.isArray(result.faqs)
      ? result.faqs.map(f => ({ q: f.q || f.question || '', a: f.a || f.answer || '' })).filter(f => f.q && f.a)
      : [];
    const current = scaffold.sections.faq.items || [];
    if (next.length >= config.dental.faqs.min || next.length >= current.length) {
      scaffold.sections.faq.items = next;
    }
  } else if (section === 'faqItem') {
    scaffold.sections.faq.items[blockIndex] = { q: result.q || '', a: result.a || '' };
  }

  scaffold.schema = schemaGenerator.generateDentalSchema({ scaffold, client, location, service });
  scaffold.qc = qaEngine.runDentalQC(scaffold);

  const saved = await savePage({ clientId, serviceId, locationId, scaffold, existing });
  return { pageId: saved.id, page: scaffold };
}

module.exports = {
  generatePage, regenerateSection, getExistingPage,
  saveSelection, getSelection, saveContent, saveQc, tupleKey,
};
