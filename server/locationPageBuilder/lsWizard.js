// ── Template-driven Location + Service wizard (docs/ybh-ls-pages.md) ────────
// Drives the five steps the SEO team works through:
//   1. pick location + service
//   2. keyword research           (keywordAdapter — SERP + SEMrush, billed)
//   3. finalize the keyword list  (keywordSelectionStore)
//   4. content BRIEF, editable    (lsBrief -> saveBrief -> approveBrief)
//   5. written COPY, editable     (lsWriter -> saveContent)
//
// Steps 4 and 5 are the reason this is not the Gentle Dental wizard: there,
// planning and writing are one call and the outline is never shown as an
// editable artefact. Here the brief is the template's §15 deliverable in its
// own right, the reviewer edits it, and the copy is written from the APPROVED
// brief — so approval is a real state transition, persisted on the page.
//
// Kept separate from pageService.js (the Neuro pipeline: multi-gate approval,
// versioning, SSE) for the same reason dentalWizard is: threading a third page
// shape through those functions would make all three harder to change.

const store = require('./store');
const config = require('./config');
const lsCompose = require('./lsCompose');
const lsProfiles = require('./lsProfiles');
const lsBrief = require('./lsBrief');
const lsWriter = require('./lsWriter');
const lsQa = require('./lsQa');
const schemaGenerator = require('./schemaGenerator');
const internalLinks = require('./internalLinks');
const keywordSelections = require('./keywordSelectionStore');
const { searchGoogle } = require('../services/googleSearch');
const { scrapeUrlsDetailed } = require('../services/scraper');

const COMPETITOR_URL_COUNT = 5;

// ── Competitor research (§7, §10) ──────────────────────────────────────────
// SERP the primary keyword, then scrape the top results that are not the
// client's own site for their H2/H3 headings and detected FAQ questions.
//
// Per-URL, not merged: §10's research output has to say WHICH competitor
// covers what, and the reviewer can drop a URL that is not a real competitor.
// (dentalWizard merges the sets, which is why it cannot answer either.)
//
// Fully fault-tolerant — a SERP or scrape failure returns what it has rather
// than failing the step; lsBrief already handles the no-competitor case by
// grading coverage "unavailable" and falling back to the ladder.
async function researchCompetitors({ primaryKeyword, profile, urls }) {
  // An explicit URL list (the reviewer's own edit) is never cached against the
  // keyword: it is not a function of the keyword, and caching it would leak
  // one reviewer's list onto the next page that shares the keyword.
  const explicit = (urls || []).filter(Boolean);
  const cacheK = store.cacheKey('ls-competitor-research', profile.clientId, primaryKeyword);
  if (!explicit.length) {
    const cached = await store.cacheGetSafe(cacheK, config.cache.serpTtlMs);
    if (cached) return cached;
  }

  let competitors = [];
  try {
    let targets = explicit;
    if (!targets.length) {
      const serp = await searchGoogle(lsProfiles.qualifySeed(primaryKeyword, profile));
      targets = (serp.results || [])
        .filter(r => r.url && (!profile.ownDomain || !r.url.includes(profile.ownDomain)))
        .slice(0, COMPETITOR_URL_COUNT)
        .map(r => r.url);
    }
    if (targets.length) {
      const scraped = await scrapeUrlsDetailed(targets);
      competitors = scraped
        .filter(s => s.success)
        .map(s => ({
          url: s.url,
          headings: [...new Set([...(s.h2s || []), ...(s.h3s || [])])].slice(0, 30),
          faqs: [...new Set(s.faqs || [])].slice(0, 12),
        }));
    }
  } catch {
    // SERP/scrape failure — fall back to ladder-only planning, don't fail the
    // step. The brief records that coverage was unavailable.
  }

  const result = { competitors };
  if (!explicit.length) await store.cacheSetSafe(cacheK, result, { kind: 'serp', ttlMs: config.cache.serpTtlMs });
  return result;
}

// ── Page rows ──────────────────────────────────────────────────────────────
// Only ONE page per (client, service, location) tuple is ever stored: every
// write path goes through this lookup + upsert-by-id, so a second
// generate/regenerate for the same tuple updates the existing row rather than
// creating a duplicate.
async function findExistingPage({ clientId, serviceId, locationId }) {
  const pages = await store.list('pages', { client_id: clientId });
  return pages.find(p => p.page_type === lsProfiles.LS_PAGE_TYPE
    && p.service_id === serviceId && p.location_id === locationId) || null;
}

async function getExistingPage(tuple) {
  return findExistingPage(tuple);
}

// The status a page row carries, derived from what it actually holds rather
// than set by hand at each call site — the two drift apart otherwise.
function statusOf(scaffold) {
  if ((scaffold.sections.body.blocks || []).length) return 'Content Generated';
  if (scaffold.brief?.approved) return 'Brief Approved';
  if (scaffold.brief) return 'Brief Drafted';
  return 'Draft';
}

async function savePage({ clientId, serviceId, locationId, scaffold, existing }) {
  const record = {
    client_id: clientId, service_id: serviceId, location_id: locationId,
    page_type: lsProfiles.LS_PAGE_TYPE,
    status: statusOf(scaffold),
    page_object: scaffold,
  };
  return existing
    ? store.update('pages', existing.id, record)
    : store.insert('pages', record, 'lspg');
}

// The two things lsQa needs that are not on the page itself: the brand's
// prohibited-claims list and the words its pages carry implicitly. Both live
// on the client row, so they are resolved from the profile at every QC call
// rather than copied onto the page (where a brand-rules edit would never
// reach existing pages).
function qcExtras(profile) {
  return {
    budgets: profile.budgets,
    prohibitedClaims: profile.prohibitedClaims,
    verticalWords: profile.verticalWords,
  };
}

function runQc(scaffold, profile) {
  return lsQa.runLsQC(scaffold, qcExtras(profile));
}

// Schema + sibling links are DERIVED: recomputed on every write so they can
// never describe an older version of the page than the copy above them.
function refreshDerived({ scaffold, layers, profile, allLocations }) {
  const { client, location, service } = layers;
  scaffold.sections.internalLinks = internalLinks.buildLsLinks({
    allLocations, currentLocation: location, service, profile,
    // Passed in rather than imported inside internalLinks: the URL builder
    // needs the profile, and internalLinks is shared by all three page types.
    lsPageUrl: lsProfiles.lsPageUrl,
  });
  scaffold.schema = schemaGenerator.generateLsSchema({ scaffold, client, location, service, profile });
  scaffold.qc = runQc(scaffold, profile);
  return scaffold;
}

// ── Step 4: the brief ──────────────────────────────────────────────────────
// Plans (or re-plans) the brief and saves it against the tuple. Returns the
// whole page so the client can render step 4 from one response.
//
// `competitorUrls` is the reviewer's edited list; absent, the SERP decides.
async function generateBrief({ clientId, serviceId, locationId, primaryKeywords, secondaryKeywords, competitorUrls }) {
  const primaries = (primaryKeywords || []).filter(Boolean);
  if (!primaries.length) throw new Error('At least one primary keyword is required.');

  const { layers, profile } = await lsCompose.loadLsLayers({ clientId, serviceId, locationId });
  const { service, location } = layers;
  const existing = await findExistingPage({ clientId, serviceId, locationId });

  // Re-planning a brief must not discard the copy already written from the
  // previous one: the reviewer is told the copy is stale (QC's
  // copy_matches_brief gate), and they choose whether to regenerate it. So the
  // scaffold is rebuilt fresh only for a page that has none.
  const scaffold = existing?.page_object && lsCompose.isLsScaffold(existing.page_object)
    ? structuredClone(existing.page_object)
    : lsCompose.buildLsScaffold(layers, profile);

  scaffold.primaryKeyword = primaries[0];
  scaffold.primaryKeywords = primaries;
  // The second primary is folded into the secondary list for the writer — one
  // page realistically optimizes for one main term, and §4 says to use the
  // second only where it is genuinely different — but it stays in
  // primaryKeywords so the identity gates and the export still treat it as a
  // primary.
  scaffold.secondaryKeywords = [...primaries.slice(1), ...(secondaryKeywords || [])];

  const { competitors } = await researchCompetitors({
    primaryKeyword: primaries[0], profile, urls: competitorUrls,
  });

  const brief = await lsBrief.planBrief({
    service, location, profile,
    brandName: scaffold.meta.brandName,
    primaryKeyword: primaries[0],
    primaryKeywords: primaries,
    secondaryKeywords: scaffold.secondaryKeywords,
    competitors,
  });

  // A previously approved brief is REPLACED by a fresh plan, so the approval
  // does not silently carry over onto a section list nobody signed off.
  scaffold.brief = brief;
  scaffold.briefMeta = {
    competitorQuality: brief.competitorQuality,
    rationale: brief.rationale,
    plannedAt: store.nowIso(),
    competitorUrls: competitors.map(c => c.url),
  };

  const allLocations = await store.list('locations', { client_id: clientId });
  refreshDerived({ scaffold, layers, profile, allLocations });

  const saved = await savePage({ clientId, serviceId, locationId, scaffold, existing });
  return { pageId: saved.id, page: scaffold };
}

// Persists the reviewer's edits to the brief. Editing is the point of step 4,
// so this accepts a whole brief object — but it re-normalizes it through
// lsBrief so an edited brief still satisfies every constraint the writer
// prompt and the QC gates assume (section band, paragraph clamp, one localized
// section, FAQ band, char limits). Without that pass, a reviewer deleting
// sections down to two would produce a page that cannot pass its own gates.
async function saveBrief({ clientId, serviceId, locationId, brief, approve }) {
  const existing = await findExistingPage({ clientId, serviceId, locationId });
  if (!existing?.page_object) throw new Error('Generate the brief before saving edits to it.');
  const { layers, profile } = await lsCompose.loadLsLayers({ clientId, serviceId, locationId });
  const scaffold = structuredClone(existing.page_object);

  const dedupe = list => [...new Map((list || []).filter(Boolean).map(k => [String(k).toLowerCase(), String(k)])).values()];
  const primaryPhrases = dedupe([scaffold.primaryKeyword, ...(scaffold.primaryKeywords || [])]);
  const secondaryPhrases = dedupe(scaffold.secondaryKeywords);

  const normalized = lsBrief.normalizeBrief(
    {
      competitorQuality: brief?.competitorQuality || scaffold.brief?.competitorQuality,
      rationale: brief?.rationale || scaffold.brief?.rationale,
      sections: brief?.sections || [],
      faqs: (brief?.faqs || []).map(f => ({ question: f.question || f.q, intent: f.intent, localize: f.localize })),
      commonTopics: brief?.research?.commonTopics,
      uniqueTopics: brief?.research?.uniqueTopics,
      faqTopics: brief?.research?.faqTopics,
      contentGaps: brief?.research?.contentGaps,
    },
    {
      service: layers.service, location: layers.location, budgets: profile.budgets,
      primaryPhrases, secondaryPhrases,
      keywordPhrases: dedupe([...primaryPhrases, ...secondaryPhrases]),
      brandName: scaffold.meta.brandName,
    },
  );

  // The competitor record is a fact from the scrape, so an edit cannot rewrite
  // it — §10's research output must keep saying what was actually found.
  normalized.research.competitors = scaffold.brief?.research?.competitors || [];
  normalized.approved = !!approve;
  normalized.approvedAt = approve
    ? (scaffold.brief?.approvedAt || store.nowIso())
    : null;
  scaffold.brief = normalized;

  const allLocations = await store.list('locations', { client_id: clientId });
  refreshDerived({ scaffold, layers, profile, allLocations });

  const saved = await savePage({ clientId, serviceId, locationId, scaffold, existing });
  return { pageId: saved.id, page: scaffold };
}

// ── Step 5: the copy ───────────────────────────────────────────────────────
// Writes the page from the APPROVED brief. Refusing to write from an
// unapproved one is deliberate: the whole point of step 4 is that a human
// decides what the page covers before the expensive call runs.
async function generateCopy({ clientId, serviceId, locationId }) {
  const existing = await findExistingPage({ clientId, serviceId, locationId });
  if (!existing?.page_object?.brief) throw new Error('Generate a content brief before writing the copy.');
  if (!existing.page_object.brief.approved) throw new Error('Approve the content brief before writing the copy.');

  const { layers, profile } = await lsCompose.loadLsLayers({ clientId, serviceId, locationId });
  const scaffold = structuredClone(existing.page_object);
  const brief = scaffold.brief;

  const l3 = await lsWriter.generateLsCopy({
    service: layers.service,
    location: layers.location,
    locationInfo: scaffold.sections.locationInfo,
    brandName: scaffold.meta.brandName,
    profile,
    brief,
    primaryKeyword: scaffold.primaryKeyword,
    secondaryKeywords: scaffold.secondaryKeywords,
  });
  lsCompose.mergeLsL3(scaffold, l3, brief, profile.budgets);

  const allLocations = await store.list('locations', { client_id: clientId });
  refreshDerived({ scaffold, layers, profile, allLocations });

  const saved = await savePage({ clientId, serviceId, locationId, scaffold, existing });

  // Record the keyword approval too, so a page generated without going through
  // the explicit approve step still leaves a durable keyword record behind.
  // Non-fatal: never lose generated copy over a bookkeeping write.
  try {
    await keywordSelections.recordApproval({
      clientId, serviceId, locationId,
      primary: scaffold.primaryKeywords, secondary: scaffold.secondaryKeywords,
    });
  } catch (e) {
    console.error('[lsWizard] Failed to record keyword selection:', e.message);
  }

  return { pageId: saved.id, page: scaffold };
}

// Regenerate ONE field of an already-written page, in place. `field` is one of
// lsWriter.REGEN_FIELDS; `index` addresses a section or an FAQ answer.
async function regenerateField({ clientId, serviceId, locationId, field, index }) {
  const existing = await findExistingPage({ clientId, serviceId, locationId });
  if (!existing?.page_object) throw new Error('Generate the page before regenerating part of it.');
  const scaffold = structuredClone(existing.page_object);
  if (!scaffold.brief) throw new Error('This page has no brief to regenerate against.');

  const { layers, profile } = await lsCompose.loadLsLayers({ clientId, serviceId, locationId });

  const current = field === 'section' ? scaffold.sections.body.blocks?.[index]?.html
    : field === 'faqItem' ? scaffold.sections.faq.items?.[index]?.a
      : field === 'seoTitle' ? scaffold.meta.title
        : field === 'metaDescription' ? scaffold.meta.metaDescription
          : field === 'h1' ? scaffold.sections.hero.h1
            : field === 'heroOneLiner' ? scaffold.sections.hero.oneLiner
              : field === 'faqIntro' ? scaffold.sections.faq.intro
                : '';

  const value = await lsWriter.regenerateLsField({
    service: layers.service,
    location: layers.location,
    locationInfo: scaffold.sections.locationInfo,
    brandName: scaffold.meta.brandName,
    profile,
    brief: scaffold.brief,
    primaryKeyword: scaffold.primaryKeyword,
    secondaryKeywords: scaffold.secondaryKeywords,
    field, index, current,
  });

  if (field === 'section') {
    if (!scaffold.sections.body.blocks?.[index]) throw new Error('index must reference an existing section.');
    scaffold.sections.body.blocks[index].html = value;
  } else if (field === 'faqItem') {
    if (!scaffold.sections.faq.items?.[index]) throw new Error('index must reference an existing FAQ.');
    scaffold.sections.faq.items[index].a = value;
  } else if (field === 'seoTitle') {
    scaffold.meta.title = value;
  } else if (field === 'metaDescription') {
    scaffold.meta.metaDescription = value;
  } else if (field === 'h1') {
    scaffold.sections.hero.h1 = value;
  } else if (field === 'heroOneLiner') {
    scaffold.sections.hero.oneLiner = value;
  } else if (field === 'faqIntro') {
    scaffold.sections.faq.intro = value;
  } else {
    throw new Error(`Unknown field: ${field}`);
  }

  const allLocations = await store.list('locations', { client_id: clientId });
  refreshDerived({ scaffold, layers, profile, allLocations });
  const saved = await savePage({ clientId, serviceId, locationId, scaffold, existing });
  return { pageId: saved.id, page: scaffold, value };
}

// ── Manual edits (steps 4 and 5) ───────────────────────────────────────────
// Held in React state until saved, so this is the write path for them. Refuses
// anything that is not recognisably an LS page: page_object is read unguarded
// by the dashboard and the exporters, and storing a payload that breaks those
// later is worse than rejecting it now.
async function saveContent({ pageId, page }) {
  const existing = await store.get('pages', pageId);
  if (!existing || existing.page_type !== lsProfiles.LS_PAGE_TYPE) throw new Error('Page not found.');
  if (!lsCompose.isLsScaffold(page)) throw new Error('A valid page object (meta + sections) is required.');

  const { layers, profile } = await lsCompose.loadLsLayers({
    clientId: existing.client_id, serviceId: existing.service_id, locationId: existing.location_id,
  });
  const scaffold = structuredClone(page);
  // Re-derive schema and re-run QC over what is ACTUALLY being stored. Without
  // this an edit would leave the previous verdict (and the previous FAQPage
  // block) on the record, so the dashboard could show PASS for content that no
  // longer passes.
  const allLocations = await store.list('locations', { client_id: existing.client_id });
  refreshDerived({ scaffold, layers, profile, allLocations });

  return store.update('pages', pageId, { status: statusOf(scaffold), page_object: scaffold });
}

// Persist a QC verdict onto a saved page (the QC route is otherwise pure).
async function saveQc({ pageId, qc }) {
  const existing = await store.get('pages', pageId);
  if (!existing || existing.page_type !== lsProfiles.LS_PAGE_TYPE) return null;
  return store.update('pages', pageId, { page_object: { ...existing.page_object, qc } });
}

// Re-run QC (or one check) against a possibly-edited page, without needing the
// caller to know how to resolve the brand's rules.
async function qcFor({ clientId, page, id, checks }) {
  const client = await store.get('clients', clientId || page?.meta?.client_id);
  const profile = lsProfiles.resolveProfile(client || {});
  return id
    ? lsQa.recheckLs(page, id, checks, qcExtras(profile))
    : lsQa.runLsQC(page, qcExtras(profile));
}

module.exports = {
  generateBrief, saveBrief, generateCopy, regenerateField,
  getExistingPage, saveContent, saveQc, qcFor, researchCompetitors,
  statusOf, findExistingPage,
  // Keyword selections are the shared tuple-keyed store; re-exported so the
  // route layer has one module to talk to per engine.
  saveSelection: keywordSelections.saveSelection,
  getSelection: keywordSelections.getSelection,
  tupleKey: keywordSelections.tupleKey,
};
