// ── Layer composition (Spec §2, §3.3) ───────────────────────────────────────
// PAGE = L1 (Global Template) + L2 (Location Data, pulled) + L3 (Service
// Content, generated). This module builds the L1/L2 scaffold by PULLING from
// the store — it never copies NAP/images/providers/reviews from scraped pages
// (Spec §15.4). The generator fills L3 into page_data; mergeL3 stitches it in.

const store = require('./store');
const categoryLogic = require('./categoryLogic');
const { pageUrl, canonicalUrl, breadcrumbLabel, dentalPageUrl, canonicalDentalUrl } = require('./urlBuilder');
const { baseCity } = require('./text');
const config = require('./config');

// Pull all L2 reference data for a (client, service, location) tuple.
async function loadLayers({ clientId, serviceId, locationId }) {
  const client = await store.get('clients', clientId);
  const service = await store.get('services', serviceId);
  const locationRow = await store.get('locations', locationId);
  if (!client || !service || !locationRow) {
    throw new Error('Client, service, or location not found.');
  }
  // Six Gentle Dental offices carry a sub-area label in `city` rather than a
  // city name ("Manchester Elm Street", "Boston - Newbury Street"). Keyword
  // matching already resolves those to the parent city; page CONTENT did not,
  // so those offices got an H1 and title of "Sealants in Manchester Elm
  // Street, NH", a schema addressLocality that is not a locality, and body
  // copy drilled to repeat the office label as if it were a city — which the
  // localization gates then PASSED, hiding it.
  //
  // `city` is the geographic claim (H1, title, schema, prompts, CTAs) and
  // `location_name` is the office's identity (officeInfo/NAP, internal-link
  // anchors); every consumer already reads whichever it means. So resolving
  // `city` once here fixes all of them at once and leaves the office label
  // intact. baseCity is a no-op for a normal city name, so nothing else moves.
  const location = { ...locationRow, city: baseCity(locationRow.city, locationRow.region) };
  const template = client.global_template_id
    ? await store.get('globalTemplates', client.global_template_id)
    : await store.findOne('globalTemplates', { client_id: clientId });

  const allProviders = await store.list('providers', { client_id: clientId });
  const providers = allProviders.filter(p =>
    (p.location_ids || []).includes(locationId) && (p.service_ids || []).includes(serviceId));

  const reviews = (await store.list('reviews', { client_id: clientId }))
    .filter(r => r.location_id === locationId && r.approved); // approved only (Spec §15.3)

  // Insurance: location-specific overrides brand-level.
  const insSets = await store.list('insuranceSets', { client_id: clientId });
  const insurance = insSets.find(i => i.location_id === locationId) || insSets.find(i => !i.location_id) || null;

  const tone = await store.findOne('toneProfiles', { client_id: clientId });

  const resources = (await store.list('resources', { client_id: clientId }))
    .filter(r => (r.related_service_ids || []).includes(serviceId));

  // Sibling services available at this location (for "services we offer").
  const allServices = await store.list('services', { client_id: clientId });
  const servicesAtLocation = allServices.filter(s => (location.services_available_ids || []).includes(s.id));

  return { client, service, location, template, providers, reviews, insurance, tone, resources, servicesAtLocation, allServices };
}

// Build the canonical Page Object scaffold (L1 + L2 + empty L3 with headings).
function buildScaffold(layers) {
  const { client, service, location, template, providers, reviews, insurance, servicesAtLocation } = layers;
  const baseUrl = client.brand_static?.base_url || '';

  const url = pageUrl(location.location_slug, service.slug);

  return {
    meta: {
      page_id: '', client_id: client.id, service_id: service.id, location_id: location.id,
      status: 'draft', version_no: 1,
      eligibility: { eligible: true, gbp_backed: !!location.verified, reason: '' },
    },
    global_template: {
      page_type: template?.page_type || 'location_service',
      brand_name: client.name,
      business_type: template?.schema_skeletons?.business_type || 'LocalBusiness',
      section_order: template?.section_order || [],
    },
    location_data: {
      location_name: location.location_name, city: location.city, state: location.state,
      state_abbreviation: location.state_abbreviation, street_address: location.street_address,
      zip_code: location.zip_code, phone_number: location.phone_number,
      latitude: location.latitude, longitude: location.longitude,
      location_slug: location.location_slug, location_page_url: location.location_page_url,
      appointment_url: location.appointment_url, gbp_url: location.gbp_url,
      hero_image_url: location.hero_image_url, hero_image_alt: location.hero_image_alt,
      parking_info: location.parking_info, nearby_areas: location.nearby_areas || [],
      insurance: insurance ? { providers: insurance.providers || [], copy: insurance.copy || '', disclaimer: insurance.disclaimer || '' } : { providers: [], copy: '', disclaimer: '' },
      providers: providers.map(p => ({ name: p.name, credentials: p.credentials, title: p.title, specialty: p.specialty, bio: p.bio, image_url: p.image_url, linkedin_url: p.linkedin_url })),
      reviews: reviews.map(r => ({ reviewer_name: r.reviewer_name, rating: r.rating, text: r.text, date: r.date, source: r.source })),
    },
    service_data: {
      service_name: service.name, service_slug: service.slug, service_category: service.category,
      parent_service_url: service.parent_service_url, related_services: service.related_service_ids || [],
      conditions_treated: service.conditions_treated || [], symptoms_addressed: service.symptoms_addressed || [],
      treatment_process: service.treatment_process || [],
      available_in_person: !!service.available_in_person, available_virtual: !!service.available_virtual,
      teen_available: !!service.teen_available,
    },
    keywords: { primary: [], secondary: [], local_modifier: [], semantic: [], faq: [], internal_linking: [], informational_low: [], excluded: [] },
    page_data: {
      page_url: url,
      canonical_url: canonicalUrl(baseUrl, location.location_slug, service.slug),
      meta_title: `${service.name} in ${location.location_name} | ${client.name}`,
      meta_description: '',
      og_title: '', og_description: '', og_url: canonicalUrl(baseUrl, location.location_slug, service.slug), og_image: location.hero_image_url || '',
      breadcrumb_label: breadcrumbLabel(service.name, location.location_name),
      h1: '',
      hero_intro: '',
      // Our approach to <Service> — always carries the two required H3s (feedback §4/§5).
      approach: { heading: `Our approach to ${service.name}`, intro: '', care_pillars: categoryLogic.APPROACH_PILLARS.map(h => ({ heading: h, copy: '' })) },
      // Competitor-modelled body: ≥1 H2 + 3 H3s; recommended 2 H2 + 5 H3s (feedback §5).
      competitor_section: { blocks: [] },
      faqs: [], // 7-11 Q&A (feedback §5)
      internal_links: [],
      // L2-derived list kept for OfferCatalog schema only (not part of visible body order).
      services_for_schema: servicesAtLocation.map(s => ({ name: s.name, url: s.parent_service_url, is_current: s.id === service.id })),
      schema: {},
    },
    competitor_analysis: [],
    qa_result: {},
    approval_status: { seo: 'pending', clinical: client.brand_rules?.ymyl ? 'pending' : 'n/a', content: 'pending', client: 'pending' },
  };
}

// Merge generated L3 fields into the scaffold's page_data (new structure).
function mergeL3(pageObject, l3) {
  const pd = pageObject.page_data;
  if (l3.meta_title) pd.meta_title = l3.meta_title;
  if (l3.meta_description) pd.meta_description = l3.meta_description;
  if (l3.og_title) pd.og_title = l3.og_title;
  if (l3.og_description) pd.og_description = l3.og_description;
  if (l3.h1) pd.h1 = l3.h1.slice(0, 55);
  if (l3.hero_intro) pd.hero_intro = l3.hero_intro.slice(0, 160);
  if (l3.approach_intro) pd.approach.intro = l3.approach_intro.slice(0, 1110);
  // competitor_section: blocks of { h2, description, h3s: [{heading, copy}] }
  // Enforce char limits as a safety net after generation.
  const LIMITS = { description: 450, h3Copy: 1500, faqAnswer: 300 };
  const clip = (s, n) => (typeof s === 'string' && s.length > n ? s.slice(0, n) : s);
  if (Array.isArray(l3.competitor_section)) {
    pd.competitor_section.blocks = l3.competitor_section.map(b => ({
      h2: b.h2 || '',
      description: clip(b.description || '', LIMITS.description),
      h3s: (b.h3s || []).map(h => ({ heading: h.heading || '', copy: clip(h.copy || '', LIMITS.h3Copy) })),
    }));
  } else if (l3.competitor_section && Array.isArray(l3.competitor_section.blocks)) {
    pd.competitor_section.blocks = l3.competitor_section.blocks.map(b => ({
      h2: b.h2 || '',
      description: clip(b.description || '', LIMITS.description),
      h3s: (b.h3s || []).map(h => ({ heading: h.heading || '', copy: clip(h.copy || '', LIMITS.h3Copy) })),
    }));
  }
  if (Array.isArray(l3.faqs)) pd.faqs = l3.faqs.map(f => ({ ...f, answer: clip(f.answer || '', LIMITS.faqAnswer) }));
  return pageObject;
}

// ── Dental (Gentle Dental) scaffold — Build Brief §2.2 GeneratedPage contract ─
// Reviews are OUT OF SCOPE (added manually later) — no `reviews` section.
// NAP (officeInfo) is PULLED from the location record, never generated; it may
// be empty in v1 (NAP populated manually from GBP/Birdeye — see location.nap_todo).

// The practice name for ONE page. Most offices trade as Gentle Dental; a few
// carry their own local brand (the Newbury Street office is Newbury Dental
// Associates) and calling those "Gentle Dental" is simply wrong — it is the
// name in the title tag, the body copy, the schema and the exported document.
//
// Resolution order: the location row's own brand_name, then the config
// override keyed by page URL, then the brand default.
function dentalBrandName(location = {}, client = {}) {
  const own = String(location.brand_name || '').trim();
  if (own) return own;
  const override = config.dental.brand.byLocationPageUrl[location.location_page_url];
  if (override) return override;
  return config.dental.brand.default || client.name || '';
}

function dentalBreadcrumb({ client, service, location }) {
  const baseUrl = (client.brand_static?.base_url || '').replace(/\/+$/, '');
  const stateSlugMatch = /^\/dental-offices\/([^/]+)/.exec(location.location_page_url || '');
  const stateSlug = stateSlugMatch ? stateSlugMatch[1] : (location.state_abbreviation || '').toLowerCase();
  return {
    items: [
      { label: 'Home', url: `${baseUrl}/` },
      { label: location.state_abbreviation, url: `${baseUrl}/dental-offices/${stateSlug}` },
      { label: location.city, url: `${baseUrl}${location.location_page_url}` },
      { label: service.name, url: `${baseUrl}${dentalPageUrl(location.location_page_url, service.slug)}` },
    ],
  };
}

function dentalServicesMenu({ allServices, location, currentServiceSlug }) {
  const available = allServices.filter(s => (location.services_available_ids || []).includes(s.id));
  const byCategory = new Map();
  for (const s of available) {
    if (!byCategory.has(s.category)) byCategory.set(s.category, []);
    byCategory.get(s.category).push({
      label: s.name,
      url: dentalPageUrl(location.location_page_url, s.slug),
      is_current: s.slug === currentServiceSlug,
    });
  }
  return [...byCategory.entries()].map(([name, items]) => ({ name, items }));
}

function buildDentalScaffold(layers) {
  const { client, service, location, allServices } = layers;
  const baseUrl = client.brand_static?.base_url || '';
  const urlPath = dentalPageUrl(location.location_page_url, service.slug);
  const canonical = canonicalDentalUrl(baseUrl, location.location_page_url, service.slug);
  const brandName = dentalBrandName(location, client);
  const title = `${service.name} in ${location.city}, ${location.state_abbreviation} | ${brandName}`;

  return {
    meta: {
      page_id: '', client_id: client.id, service_id: service.id, location_id: location.id,
      status: 'draft',
      urlPath, title,
      // Read by schemaGenerator, the exporter and the wizard, so every surface
      // names the practice the same way without re-resolving it.
      brandName,
      metaDescription: '',
      canonical,
    },
    primaryKeyword: '',
    secondaryKeywords: [],
    sections: {
      hero: {
        h1: `${service.name} in ${location.city}, ${location.state_abbreviation}`,
        intro: '',
        ctaLabel: 'Book an Appointment',
        ctaUrl: location.location_page_url,
      },
      breadcrumb: dentalBreadcrumb({ client, service, location }),
      officeInfo: {
        name: location.location_name,
        address: location.street_address || '',
        phone: location.phone_number || '',
        directionsUrl: location.directions_url || '',
        hoursByDay: location.hours_by_day || {},
        moreInfo: location.location_page_url,
        nap_todo: location.nap_todo || [],
      },
      servicesInCity: {
        intro: '',
        ctaLabel: 'View All Services',
        ctaUrl: location.location_page_url,
        categories: dentalServicesMenu({ allServices, location, currentServiceSlug: service.slug }),
        internalLinks: [],
      },
      educationalBody: { blocks: [] },
      faq: { heading: 'Frequently Asked Questions', items: [] },
    },
    schema: { breadcrumbList: '', dentist: '', medicalWebPage: '', medicalProcedure: '', faqPage: '' },
    // Set by dentalWizard once dentalOutline has graded the scraped competitor
    // headings: { competitorQuality, rationale, sources } for the review screen.
    outlineMeta: null,
    qc: null,
  };
}

// Merge the LLM-generated subset (hero.intro, meta.metaDescription,
// educationalBody.blocks, faq.items) into the scaffold. servicesInCity.intro
// is NOT generated — it stays whatever manual value the wizard user typed
// (default ''). No OG tags at all — dropped from the contract.
function mergeDentalL3(scaffold, l3) {
  const m = scaffold.meta, s = scaffold.sections;
  if (l3.heroIntro) s.hero.intro = l3.heroIntro;
  if (l3.metaDescription) m.metaDescription = l3.metaDescription;
  if (Array.isArray(l3.educationalBody)) {
    s.educationalBody.blocks = l3.educationalBody.map(b => ({ h2: b.h2 || '', html: b.html || '' }));
  }
  if (Array.isArray(l3.faqs)) {
    s.faq.items = l3.faqs.map(f => ({ q: f.q || f.question || '', a: f.a || f.answer || '' }));
  }
  return scaffold;
}

module.exports = { loadLayers, buildScaffold, mergeL3, buildDentalScaffold, mergeDentalL3, dentalBrandName };
