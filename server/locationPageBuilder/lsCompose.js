// ── Template-driven Location + Service page scaffold (docs/ybh-ls-pages.md) ──
// PAGE = L1 (brand/template) + L2 (location data, PULLED) + L3 (generated).
// This module builds the L1/L2 half and stitches L3 in; it never invents a
// location fact. compose.loadLayers does the actual store reads, so the three
// page shapes in this module (Neuro, Gentle Dental, template-driven) share one
// loader and differ only in what they assemble from it.
//
// The shape assembled here is the template's §12 "internal page data
// structure" plus the two things §12 leaves out but §15 requires: the editable
// BRIEF (which sections exist, what each one must cover, its keywords and its
// character budget) and the QC verdict. Copy is written from the approved
// brief, so both have to live on the same record.

const compose = require('./compose');
const lsProfiles = require('./lsProfiles');
const lsLadder = require('./lsLadder');
const text = require('./text');

// Template §6 "Missing Data Rule": if a location fact is unavailable, DO NOT
// invent it — flag it. The flag strings are the template's own wording, so the
// exported brief says exactly what the SEO team has to go and ask the client
// for. Keyed by the scaffold field so the wizard can mark the right row.
const LOCATION_DATA_REQUIREMENTS = [
  ['address', 'LOCATION ADDRESS REQUIRED FROM CLIENT'],
  ['phone', 'PHONE NUMBER REQUIRED FROM CLIENT'],
  ['servingAreas', 'SERVING AREAS REQUIRED FROM CLIENT'],
  ['agesServed', 'AGES SERVED REQUIRED FROM CLIENT'],
  ['mapUrl', 'MAP / DIRECTIONS REQUIRED FROM CLIENT'],
];

function hasValue(v) {
  if (v == null || v === '') return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v).length > 0;
  return true;
}

// The practice name for ONE page. Almost every brand trades under one name, so
// this is normally just the client name — but a location row may carry its own
// `brand_name` (a co-branded or acquired site), and calling that location by
// the group name is wrong in the one detail a local searcher checks first.
// Same resolution order as compose.dentalBrandName, minus the config override
// map: this engine has no per-URL exceptions, only data.
function lsBrandName(location = {}, profile = {}) {
  return String(location.brand_name || '').trim() || profile.brandName || '';
}

// Location facts, PULLED. Anything the store does not hold is left empty and
// named in `dataRequired` — never filled with a plausible-looking value.
function buildLocationInfo(location = {}) {
  const info = {
    name: location.location_name || location.city || '',
    city: location.city || '',
    state: location.state || '',
    stateAbbreviation: location.state_abbreviation || '',
    // Composed ONLY when there is a street address. Joining whatever is
    // present would produce "Torrance, CA" for a location with no address at
    // all — a non-empty string, so §6's LOCATION ADDRESS flag would never
    // fire, and the page would print a city as though it were an address.
    address: location.street_address
      ? [location.street_address, location.city, location.state_abbreviation, location.zip_code]
        .filter(Boolean).join(', ')
      : '',
    phone: location.phone_number || '',
    // Template §6 asks for "Directions / Map". A directions URL is the useful
    // artefact; the GBP listing is the fallback, since that is what a map
    // embed on the live page is built from.
    mapUrl: location.directions_url || location.map_image_url || location.gbp_url || '',
    // §6 SERVING_AREAS. `nearby_areas` is the existing field for the same
    // idea, so a location row populated for the other two page types already
    // satisfies this instead of needing the data entered twice.
    servingAreas: location.serving_areas || location.nearby_areas || [],
    // §6 AGES_SERVED. Behavioral health pages live or die on this (a teen
    // programme and an adult programme are different pages), and it is a
    // client-verified fact, so it is pulled or flagged — never inferred.
    agesServed: location.ages_served || '',
    hoursByDay: location.hours_by_day || {},
    moreInfo: location.location_page_url || '',
    parkingInfo: location.parking_info || '',
  };
  info.dataRequired = LOCATION_DATA_REQUIREMENTS
    .filter(([field]) => !hasValue(info[field]))
    .map(([, flag]) => flag);
  return info;
}

// Home > Locations > {Location} > {Service}. Built from the location's own
// page URL, so it mirrors the site's real hierarchy rather than asserting one.
function buildBreadcrumb({ profile, location, service, urlPath }) {
  const base = profile.baseUrl || '';
  const items = [{ label: 'Home', url: `${base}/` }];
  if (location.location_page_url) {
    items.push({ label: location.location_name || location.city, url: `${base}${location.location_page_url}` });
  }
  items.push({ label: `${service.name} in ${location.location_name || location.city}`, url: `${base}${urlPath}` });
  return { items };
}

// ── The scaffold ───────────────────────────────────────────────────────────
// Every generated string starts empty, with ONE exception: meta.title and
// hero.h1 carry the template's §3/§5 recommended patterns as a fallback.
// They are not deterministic here the way they are on a dental page — §3 and
// §5 both require the primary keyword (or a close natural variant) to drive
// them, which is a judgement the writer makes — but a page whose generation
// failed halfway is more useful with a correct-shaped title than with none.
function buildLsScaffold(layers, profileArg) {
  const { client, service, location, template, allServices } = layers;
  const profile = profileArg || lsProfiles.resolveProfile(client);
  const brandName = lsBrandName(location, profile);
  const urlPath = lsProfiles.lsPageUrl(profile, location, service);
  const canonical = lsProfiles.lsCanonicalUrl(profile, location, service);
  const locationLabel = location.location_name || location.city;

  return {
    meta: {
      page_id: '', client_id: client.id, service_id: service.id, location_id: location.id,
      status: 'draft',
      pageType: profile.pageType,
      urlPath,
      canonical,
      // §3 recommended structure: "{Service} in {Location} | {Brand}".
      title: `${service.name} in ${locationLabel} | ${brandName}`,
      metaDescription: '',
      brandName,
      businessType: template?.schema_skeletons?.business_type || profile.businessType,
    },
    primaryKeyword: '',
    primaryKeywords: [],
    secondaryKeywords: [],
    // Set by lsWizard once lsBrief has planned it, edited by the reviewer, and
    // frozen on approval. lsWriter reads THIS, not the planner's output, so an
    // edited brief is what the copy is written from (§15's brief is the
    // deliverable that governs the page).
    brief: null,
    sections: {
      hero: {
        // §5: H1 must carry the primary keyword or a close natural variant.
        // This is the fallback shape until the writer replaces it.
        h1: `${service.name} in ${locationLabel}`,
        oneLiner: '',
        ctaLabel: 'Request a Consultation',
        ctaUrl: location.appointment_url || location.location_page_url || '',
      },
      breadcrumb: buildBreadcrumb({ profile, location, service, urlPath }),
      // §6 — PULLED, never generated. Empty fields are flagged, not filled.
      locationInfo: buildLocationInfo(location),
      // §7/§8 — the competitor-modelled body. One entry per approved brief
      // section, carrying the brief's own instructions and budget so the
      // reviewer can see what the copy was asked for beside what it says.
      body: { blocks: [] },
      // §9 — intro plus 5-7 Q&As.
      faq: { heading: 'Frequently Asked Questions', intro: '', items: [] },
      internalLinks: [],
      // Sibling services at this location, for OfferCatalog schema only — not
      // part of the visible body order.
      servicesForSchema: (allServices || [])
        .filter(s => (location.services_available_ids || []).includes(s.id))
        .map(s => ({ name: s.name, url: s.parent_service_url || '', is_current: s.id === service.id })),
    },
    schema: { breadcrumbList: '', business: '', medicalWebPage: '', service: '', faqPage: '' },
    // §10's research output, kept for the review screen: which competitors
    // were read, what they cover, and why the planner leaned on them or not.
    // Lives beside the brief rather than inside it so editing the brief cannot
    // rewrite the record of what was actually found.
    briefMeta: null,
    qc: null,
  };
}

// ── L3 merge ───────────────────────────────────────────────────────────────
// Clips every generated string as a safety net after generation, the same way
// compose.mergeL3 does. The clips are ceilings the QC gates already enforce,
// so a model that overshoots produces a flagged page rather than a page that
// breaks the export.
function mergeLsL3(scaffold, l3, brief, budgets) {
  const b = budgets;
  const clip = (s, n) => {
    const v = String(s || '').trim().replace(/\s+/g, ' ');
    return v.length > n ? v.slice(0, n) : v;
  };

  if (l3.seoTitle) scaffold.meta.title = clip(l3.seoTitle, b.seoTitle.max + 20);
  if (l3.metaDescription) scaffold.meta.metaDescription = clip(l3.metaDescription, b.metaDescription.max + 20);
  if (l3.h1) scaffold.sections.hero.h1 = clip(l3.h1, 120);
  if (l3.heroOneLiner) scaffold.sections.hero.oneLiner = clip(l3.heroOneLiner, 400);

  // Body blocks are matched to the BRIEF by position: the writer is told the
  // section list is fixed, and a heading it reworded anyway would otherwise
  // detach the copy from the instructions it was written to. Where the counts
  // disagree the writer's own headings are kept (there is no sound mapping),
  // and QC flags the count — same posture as contentGenerator.alignToOutline.
  const planned = brief?.sections || [];
  if (Array.isArray(l3.sections)) {
    const aligned = planned.length && l3.sections.length === planned.length;
    scaffold.sections.body.blocks = l3.sections.map((s, i) => ({
      h2: aligned ? planned[i].h2 : (s.h2 || ''),
      html: text.normalizeBlockHtml(s.html || ''),
      // Carried from the brief so the review screen can show each block's
      // instructions, keywords and character budget next to its copy.
      instructions: planned[i]?.instructions || '',
      keywords: planned[i]?.keywords || [],
      charLimit: planned[i]?.charLimit || { min: b.sectionChars.min, max: b.sectionChars.max },
      source: planned[i]?.source || null,
    }));
  }

  if (l3.faqIntro) scaffold.sections.faq.intro = clip(l3.faqIntro, b.faqIntro.maxChars + 60);
  if (Array.isArray(l3.faqs)) {
    scaffold.sections.faq.items = l3.faqs
      .map(f => ({ q: clip(f.q || f.question, 200), a: clip(f.a || f.answer, 1200) }))
      .filter(f => f.q && f.a);
  }
  return scaffold;
}

// The shape this engine can read. Callers hand us a client-supplied page, and
// a QC verdict computed from a payload that is not an LS page would be
// meaningless — worse, it can be persisted. Checked on every write path.
function isLsScaffold(page) {
  return !!page && typeof page === 'object' && !!page.meta && !!page.sections
    && !!page.sections.body && !!page.sections.hero;
}

// Loads the layers AND resolves the profile in one call, since every caller
// needs both and resolving it twice from the same client row is how the two
// drift apart.
async function loadLsLayers({ clientId, serviceId, locationId }) {
  const layers = await compose.loadLayers({ clientId, serviceId, locationId });
  const profile = lsProfiles.resolveProfile(layers.client);
  return { layers, profile };
}

module.exports = {
  buildLsScaffold, mergeLsL3, isLsScaffold, loadLsLayers,
  buildLocationInfo, lsBrandName, LOCATION_DATA_REQUIREMENTS,
  // Re-exported so the brief planner and the writer resolve the condition name
  // the same way the ladders do.
  conditionNameOf: lsLadder.conditionNameOf,
};
