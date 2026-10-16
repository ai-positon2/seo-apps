// ── Generate a Clear Behavioral Health page from its approved brief ─────────
// The CBH counterpart to briefWizard.generateFromBrief. It does NOT research
// or plan: it reads what a human approved and hands that to the writer. If it
// re-planned here, the brief step would be decorative -- the reviewer would
// edit an outline the generator then discarded.

const store = require('./store');
const compose = require('./compose');
const contract = require('./cbhContract');
const cbhCompose = require('./cbhCompose');
const cbhQc = require('./cbhQc');
const cbhWriter = require('./cbhWriter');
const cbhFeedback = require('./cbhFeedback');
const cbhFeedbackReview = require('./cbhFeedbackReview');
const { getCbhBrief, normalizeCbhBrief, caseContext } = require('./cbhBrief');
const { servicePhraseDisplay } = require('./keywordRelevance');

const PAGE_TYPE = 'cbh_location_service';


async function findExistingPage({ clientId, serviceId, locationId }) {
  const pages = await store.list('pages', { client_id: clientId });
  return pages.find(p => p.service_id === serviceId && p.location_id === locationId) || null;
}

async function generateFromBrief({ clientId, serviceId, locationId, brief: briefInput }) {
  // Prefer the SAVED brief: what ships must be what was approved. An inline
  // brief is accepted because the wizard generates straight after saving, and
  // making that a second round trip would only add a race.
  const stored = await getCbhBrief({ clientId, serviceId, locationId });
  const brief = briefInput
    ? normalizeCbhBrief(briefInput, await caseContext({ clientId, serviceId, locationId }))
    : stored?.brief;
  if (!brief) throw new Error('No brief found for this location + service. Build and save a brief first.');
  if (!brief.primaryKeyword) throw new Error('The brief has no primary keyword.');

  const h3s = brief.educational?.h3s || [];
  const { min, max } = contract.LIMITS.educational.h3Count;
  if (h3s.length < min || h3s.length > max) {
    throw new Error(`The brief needs ${min}-${max} educational H3s; it has ${h3s.length}.`);
  }

  const layers = await compose.loadLayers({ clientId, serviceId, locationId });
  // `service` is needed for refreshCbhDerived below, which takes the raw
  // condition name from it for the educational H2.
  const { client, location, service } = layers;
  // Before the writer is paid for: a pair the location does not offer gets no page.
  cbhCompose.assertCbhEligible(service, location);
  const feedbackRules = await cbhFeedback.loadActiveRules(clientId);

  let scaffold = cbhCompose.buildCbhScaffold(layers, { servicePhrase: servicePhraseDisplay });
  scaffold.primaryKeyword = brief.primaryKeyword;
  scaffold.primaryKeywords = brief.primaryKeywords;
  scaffold.secondaryKeywords = brief.secondaryKeywords;

  const { l3, feedbackReview } = await cbhWriter.generateCbhL3({
    scaffold,
    primaryKeyword: brief.primaryKeyword,
    secondaryKeywords: brief.secondaryKeywords,
    h3Plan: h3s,
    faqPlan: brief.faqs || [],
    feedbackRules,
  });

  scaffold = cbhCompose.mergeCbhL3(scaffold, l3, location);

  // The reviewer's meta wins over the writer's. It was approved; the writer's
  // is only a draft of something nobody had opinions about yet.
  if (brief.meta?.title) {
    scaffold.meta.title = brief.meta.title;
    scaffold.meta.fullTitle = contract.fullTitle(brief.meta.title);
  }
  if (brief.meta?.description) scaffold.meta.metaDescription = brief.meta.description;

  // Provenance comes from the BRIEF, not the model: the writer does not get to
  // declare its own output competitor-backed.
  scaffold = cbhCompose.applyProvenance(scaffold, h3s);

  // URLs and schema together, so the JSON-LD can never quote a URL the page
  // does not have.
  cbhCompose.refreshCbhDerived(scaffold, { client, location, service });

  // The marker that puts this page under the client's feedback rules. Every page
  // generated from here on carries it; a page without it predates the rules and
  // QC, save and regen leave it exactly as it was.
  stampFeedback(scaffold, feedbackRules);
  if (feedbackReview) {
    // The writer reviewed the winning draft before it was cased, given its
    // provenance and stripped of the brief's meta, none of which changes what
    // the review judged. Re-stamped so the page does not open "out of date".
    scaffold.feedbackReview = { ...feedbackReview, contentHash: cbhFeedback.reviewContentHash(scaffold) };
  }
  scaffold.qc = cbhQc.runCbhQc(scaffold, { feedbackRules });

  const existing = await findExistingPage({ clientId, serviceId, locationId });
  const record = {
    client_id: clientId, service_id: serviceId, location_id: locationId,
    page_type: PAGE_TYPE,
    status: 'Content Generated',
    page_object: scaffold,
  };
  const saved = existing
    ? await store.update('pages', existing.id, record)
    : await store.insert('pages', record, 'cbh');

  return { pageId: saved.id, page: scaffold };
}

function stampFeedback(page, feedbackRules) {
  const applicable = cbhFeedback.rulesFor(feedbackRules, cbhFeedback.pageContext(page));
  page.feedback = {
    rulesVersion: cbhFeedback.rulesVersion(applicable),
    ruleKeys: applicable.map(r => r.key),
    appliedAt: new Date().toISOString(),
  };
  return page;
}

// The feedback fields are the SERVER's: the marker says which rules a page was
// built under, and the review is what the reviewer actually returned. Both are
// taken from the stored page, never from what the browser sent back, and a page
// that never had them does not get them.
function carryFeedbackFields(next, stored) {
  ['feedback', 'feedbackReview'].forEach((k) => {
    if (stored && stored[k] !== undefined) next[k] = structuredClone(stored[k]);
    else delete next[k];
  });
  if (stored?.meta?.programGroups) next.meta.programGroups = structuredClone(stored.meta.programGroups);
  // Whether code owns the experts H2 is decided at generation, never by what
  // the browser sends back.
  if (stored?.meta?.fixedExpertsHeading) next.meta.fixedExpertsHeading = true;
  else delete next.meta.fixedExpertsHeading;
  return next;
}

// Re-run QC over an edited page and persist it. Mirrors dentalWizard.saveContent.
async function saveContent({ pageId, page }) {
  const existing = await store.get('pages', pageId);
  if (!existing || existing.page_type !== PAGE_TYPE) throw new Error('Page not found.');
  if (!cbhQc.isCbhPage(page)) throw new Error('A valid CBH page object (meta + sections) is required.');
  // Re-derive the shipped title so an edited title cannot lose its suffix.
  const next = carryFeedbackFields(structuredClone(page), existing.page_object);
  next.meta.title = contract.titleWithoutSuffix(next.meta.title || '');
  next.meta.fullTitle = contract.fullTitle(next.meta.title);
  // The reviewer edits the SLUG; urlPath and canonical are derived from it here
  // rather than trusted from the client, so a hand-edited URL cannot disagree
  // with the slug it is supposed to come from.
  const [client, location, service] = await Promise.all([
    store.get('clients', existing.client_id),
    store.get('locations', existing.location_id),
    store.get('services', existing.service_id),
  ]);
  // Also restate the fixed headings. saveContent did not, so a page that
  // reached save without passing the read route kept a stale one and failed a
  // Critical gate on a heading nobody had touched. Idempotent.
  cbhCompose.ensureCbhSections(next);
  // Rebuilds the URLs AND the JSON-LD. The schema quotes the canonical, the
  // meta and the FAQ pairs, so an edit to any of them has to reach it.
  cbhCompose.refreshCbhDerived(next, { client, location, service });
  next.qc = cbhQc.runCbhQc(next, next.feedback
    ? { feedbackRules: await cbhFeedback.loadActiveRules(existing.client_id) } : {});
  const saved = await store.update('pages', pageId, { page_object: next });
  return { saved: true, updatedAt: saved.updated_at, qc: next.qc, page: next };
}

// BILLED: one review call. Re-runs the AI review of the STORED page against
// the rules in force now, re-stamps the marker with them, and re-runs QC. The
// wizard saves first, so what is reviewed is what is on screen.
async function recheckFeedback({ pageId }) {
  const existing = await store.get('pages', pageId);
  if (!existing || existing.page_type !== PAGE_TYPE) throw new Error('Page not found.');
  const page = structuredClone(existing.page_object);
  if (!page?.feedback) {
    throw new Error('This page was generated before the client feedback rules existed, so it is not checked against them. '
      + 'Regenerate it to bring it under the rules.');
  }
  const feedbackRules = await cbhFeedback.loadActiveRules(existing.client_id);
  stampFeedback(page, feedbackRules);
  // Unlike generation, a failure here is reported: the reviewer asked for it.
  page.feedbackReview = await cbhFeedbackReview.reviewPage(page, feedbackRules);
  page.qc = cbhQc.runCbhQc(page, { feedbackRules });
  const saved = await store.update('pages', pageId, { page_object: page });
  return { saved: true, updatedAt: saved.updated_at, qc: page.qc, page };
}

// buildCbhSchema is re-exported from its new home in cbhCompose so existing
// callers keep working.
module.exports = {
  generateFromBrief, saveContent, recheckFeedback, buildCbhSchema: cbhCompose.buildCbhSchema, PAGE_TYPE,
};
