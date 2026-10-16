// ── Clear Behavioral Health page scaffold ───────────────────────────────────
// Builds the L1+L2 skeleton for the CBH contract (cbhContract.js) with every
// FIXED heading already filled in and every generated field left empty for the
// writer.
//
// Separate from compose.buildDentalScaffold because the two contracts share no
// section. The dental body is a flat list of H2 blocks whose bodies are HTML
// with headings forbidden inside; this one has ten named sections, one of
// which nests 4-5 H3s under a single H2 and budgets each of them in LINES.
//
// The fixed headings are never sent to the writer to produce. The guidelines
// say "use this H2 exactly as written", and the surest way to honour that is
// for the model to have no opportunity to reword it.

const contract = require('./cbhContract');
const { cbhPageUrl, canonicalCbhUrl, slugify } = require('./urlBuilder');

const { FIXED_HEADINGS } = contract;

// The service name as it reads inside a heading. Service records are titled
// for a menu ("Anxiety", "ADHD"), and the guidelines' headings read as prose --
// "Our approach to anxiety treatment", not "Our approach to Anxiety".
//
// Casing is the client's, not ours. Deriving display text from the KEYWORD
// phrase (which is lowercase by design) and title-casing it back produced
// "Adhd Treatment" for ADHD and "Bipolar i And ii" for Bipolar I & II.
function headingService(service, servicePhraseFn) {
  const phrase = servicePhraseFn ? servicePhraseFn(service?.name) : '';
  return (phrase || service?.name || '').trim();
}

// The program a page belongs to: the service's program groups that this
// location actually runs. "Anxiety" is both a residential and an outpatient
// condition, and at an outpatient office it is the outpatient one. A location
// seeded before program_groups existed has none, so the page gets none rather
// than a guess.
function programGroupsFor(service, location) {
  const runs = Array.isArray(location?.program_groups) ? location.program_groups : [];
  return (service?.groups || []).filter(g => runs.includes(g));
}

// The doorway-page guardrail for the CBH routes. The wizard's picker already
// hides a service a location does not offer, but the API took any pair, so a
// stale tab or a direct call could still build a Psychosis page for an
// outpatient office.
function assertCbhEligible(service, location) {
  const offered = (location?.services_available_ids || []).includes(service?.id);
  if (!offered) {
    throw new Error(`${service?.name || 'This service'} is not offered at ${location?.location_name || location?.city || 'this location'}, `
      + 'so a page for it there would advertise care that location does not provide. Choose a location that runs it.');
  }
}

function buildCbhScaffold(layers, { servicePhrase } = {}) {
  const { client, service, location } = layers;
  const baseUrl = client.brand_static?.base_url || '';
  // The service slug is SEEDED from the service record and then belongs to the
  // page: the client edits it per page, and the same service can be slugged
  // differently on another location without one page's edit moving the other.
  const serviceSlug = slugify(service.slug || service.name);

  const svcPhrase = headingService(service, servicePhrase);
  const cityName = location.city;

  const scaffold = {
    meta: {
      page_id: '', client_id: client.id, service_id: service.id, location_id: location.id,
      status: 'draft',
      // Derived from serviceSlug, never stored independently of it -- see
      // applyCbhUrls, which is the single place these two are computed.
      urlPath: '',
      canonical: '',
      serviceSlug,
      brandName: contract.BRAND,
      // Which program this page is for (see programGroupsFor). The writer is
      // told, and client feedback rules can be scoped by it.
      programGroups: programGroupsFor(service, location),
      // Marks a page whose treatment (CMS "experts") H2 is built by code. Set
      // only here, so every page generated from now on carries it and a page
      // that predates it keeps the heading its writer composed. Server-owned:
      // saveContent restores it from the stored page.
      fixedExpertsHeading: true,
      // `title` is the part the 50-60 window applies to; `fullTitle` is what
      // ships. Both are stored so nothing downstream has to re-derive which is
      // which, and QC can gate them separately.
      title: '',
      fullTitle: '',
      metaDescription: '',
    },

    // Denormalised onto the page because QC, the exporter and the wizard all
    // need them and none of them load the service/location rows.
    serviceName: svcPhrase,
    // The raw service name, which is the CONDITION: "Depression", not
    // "Depression treatment". Only the educational H2 and the schema's
    // MedicalCondition want it; everything else wants the phrase above.
    conditionName: String(service?.name || '').trim(),
    locationName: cityName,
    primaryKeyword: '',
    primaryKeywords: [],
    secondaryKeywords: [],

    sections: {
      hero: {
        h1: '',
        description: '',
        ctaLabel: 'Schedule a consultation',
        ctaUrl: location.appointment_url || location.location_page_url || '',
      },

      approach: {
        heading: contract.approachHeading(svcPhrase),
        paragraphs: [],
        philosophy: { heading: FIXED_HEADINGS.approachPhilosophy, paragraphs: [] },
        therapies: { heading: FIXED_HEADINGS.approachTherapies, paragraphs: [] },
      },

      insurance: {
        heading: FIXED_HEADINGS.insurance,
        paragraph: '',
      },

      educational: {
        heading: contract.educationalHeading(service?.name || svcPhrase),
        paragraphs: [],
        // Provenance for the intro itself; the H3s carry their own.
        source: null,
        sourceUrl: '',
        // Each: { heading, lines: [], source, sourceUrl }. `lines` rather than
        // a blob because the guidelines budget this content in lines, and a
        // bullet counts as one -- keeping them separate is what lets QC count
        // the way the guidelines count.
        h3s: [],
      },

      uvp: {
        heading: FIXED_HEADINGS.uvp,
        paragraph: '',
      },

      service: {
        heading: contract.serviceHeading(svcPhrase, cityName),
        paragraph: '',
      },

      // Sits between Service and the FAQs: the clinicians section. Its H2 used
      // to be the writer's; it is now built from the service, brand and city.
      treatment: {
        heading: contract.expertsHeading(svcPhrase, cityName),
        paragraph: '',
      },

      faq: {
        heading: 'Frequently Asked Questions',
        // Each: { q, a, type } where type is location | brand | intent.
        items: [],
      },
    },

    schema: {},
    qc: null,
  };

  return refreshCbhDerived(scaffold, { client, location, service });
}

// The page's JSON-LD. Moved here from cbhWizard so that ONE function can own
// everything derived from the page -- see refreshCbhDerived. It reads the
// canonical, the meta and the FAQs, all of which an editor can change.
function buildCbhSchema({ scaffold, client, location }) {
  const m = scaffold.meta;
  const org = {
    '@context': 'https://schema.org',
    '@type': 'MedicalBusiness',
    name: contract.BRAND,
    url: m.canonical,
    address: {
      '@type': 'PostalAddress',
      addressLocality: location.city,
      addressRegion: location.state_abbreviation,
      addressCountry: 'US',
    },
    ...(client.brand_static?.sameAs?.length ? { sameAs: client.brand_static.sameAs } : {}),
    areaServed: [location.city, ...(location.nearby_areas || [])].filter(Boolean),
  };

  const webPage = {
    '@context': 'https://schema.org',
    '@type': 'MedicalWebPage',
    url: m.canonical,
    name: m.fullTitle || m.title,
    description: m.metaDescription,
    about: { '@type': 'MedicalCondition', name: scaffold.conditionName || scaffold.serviceName },
  };

  const items = scaffold.sections.faq.items || [];
  const faqPage = items.length ? {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: items.map(f => ({
      '@type': 'Question',
      name: f.q,
      acceptedAnswer: { '@type': 'Answer', text: f.a },
    })),
  } : null;

  // Stored as strings, matching how the dental pages store theirs, so the
  // exporters and the wizard render both without branching.
  return {
    medicalBusiness: JSON.stringify(org, null, 2),
    medicalWebPage: JSON.stringify(webPage, null, 2),
    faqPage: faqPage ? JSON.stringify(faqPage, null, 2) : '',
  };
}

// The ONE place everything DERIVED from a page is computed: its URLs, and the
// JSON-LD that quotes them. Called when the page is built, and again whenever
// it is read or saved.
//
// The schema belongs here and not at generation time only. It embeds the
// canonical, the meta title and description, and the FAQ pairs -- every one of
// which a reviewer can edit afterwards. Built once, it went stale the moment
// anyone touched them, and shipped a URL the page no longer had.
// Re-cases every heading already on a page. Generation now cases them as it
// merges, but pages written before that still hold what the model produced, and
// regenerating one costs several minutes of billed calls. Idempotent, so a page
// already correct is untouched.
function caseCbhHeadings(page, location) {
  const s = page?.sections;
  if (!s) return page;
  const keep = contract.protectedTerms({
    serviceName: page.serviceName, locationName: page.locationName, location,
  });
  const cs = v => contract.sentenceCase(v, keep);
  // Three headings are built by CODE from the service and the city, so they are
  // REBUILT rather than re-cased: a page written before the wording changed --
  // "Anxiety treatment in X" before it became "Anxiety treatment program in X"
  // -- then opens with the current heading instead of needing regeneration.
  // None of the three is editable in the wizard, so nothing hand-typed is lost.
  const svc = page.serviceName;
  const city = page.locationName;
  if (s.hero) s.hero.h1 = cs(s.hero.h1);
  if (s.approach && svc) s.approach.heading = contract.approachHeading(svc);
  if (s.educational) {
    // The condition where we have it; the display phrase is the fallback for a
    // page whose service record has since been renamed or removed.
    if (page.conditionName || svc) s.educational.heading = contract.educationalHeading(page.conditionName || svc);
    (s.educational.h3s || []).forEach((h) => { h.heading = cs(h.heading); });
  }
  if (s.service && svc && city) s.service.heading = contract.serviceHeading(svc, city);
  if (s.treatment) {
    // Rebuilt only on a page generated under the code-built heading. An older
    // page keeps what its writer composed, just re-cased.
    s.treatment.heading = (page.meta?.fixedExpertsHeading && svc && city)
      ? contract.expertsHeading(svc, city)
      : cs(s.treatment.heading);
  }
  (s.faq?.items || []).forEach((f) => { f.q = cs(f.q); });
  // meta.title is NOT touched: it is the <title> tag, read in a SERP rather
  // than on the page, and it ships as the SEO team wrote it.
  return page;
}

// Keys whose values are never prose. A URL or a slug cannot legitimately carry
// an em dash, and rewriting a character inside one would corrupt the value
// rather than clean it, so they are skipped rather than trusted.
const NON_PROSE_KEYS = new Set([
  'urlPath', 'canonical', 'ctaUrl', 'sourceUrl', 'serviceSlug',
  'page_id', 'client_id', 'service_id', 'location_id', 'status', 'source', 'type',
]);

// Two subtrees are skipped whole. `schema` is rebuilt from the cleaned page a
// few lines below, so cleaning its JSON strings first is wasted work at best;
// `qc` is a result set written by cbhQc, not page content, and rewriting the
// wording of a gate's own explanation would be a lie about what it said.
const SKIP_SUBTREES = new Set(['schema', 'qc']);

// Strips em dashes from every piece of prose on a page, in place.
//
// mergeCbhL3 already covers anything this pipeline generates. This exists for
// the two cases it cannot reach: a page SAVED before this rule existed, and a
// reviewer who types an em dash into the editor. Running it on every read and
// every save means an old page opens clean and saves clean without costing a
// regeneration -- the same approach caseCbhHeadings takes to stale headings.
//
// Deliberately a generic walk rather than a list of the fields that exist
// today: a field added to the contract later is covered without a second edit
// here, which is precisely the kind of edit that gets forgotten.
function stripCbhEmDashes(page) {
  if (!page || typeof page !== 'object') return page;
  const clean = (value, key) => {
    if (typeof value === 'string') {
      return NON_PROSE_KEYS.has(key) ? value : contract.removeEmDashes(value);
    }
    if (Array.isArray(value)) return value.map(v => clean(v, key));
    if (value && typeof value === 'object') {
      for (const k of Object.keys(value)) {
        if (!SKIP_SUBTREES.has(k)) value[k] = clean(value[k], k);
      }
    }
    return value;
  };
  clean(page, null);
  return page;
}

function refreshCbhDerived(page, { client, location, service } = {}) {
  if (!page || !page.meta) return page;
  // Before the headings are cased and before the schema is built, so neither
  // can carry through an em dash the page arrived with.
  stripCbhEmDashes(page);
  // A page written before the educational H2 named the condition has no raw
  // name stored. Backfilling from the service record here is what lets it open
  // as "What is depression?" instead of silently keeping the old heading --
  // the same trick the read route uses for meta.serviceSlug.
  if (!page.conditionName && service?.name) page.conditionName = String(service.name).trim();
  caseCbhHeadings(page, location);
  const slug = slugify(page.meta.serviceSlug || '');
  page.meta.serviceSlug = slug;
  // The SERVICE picks the location page where an office has two (see
  // contract.cbhLocationSlug).
  const locationPageUrl = contract.cbhLocationPageUrl(location, service);
  page.meta.urlPath = cbhPageUrl(locationPageUrl, slug);
  page.meta.canonical = canonicalCbhUrl(
    client?.brand_static?.base_url || '', locationPageUrl, slug);
  page.schema = buildCbhSchema({ scaffold: page, client: client || {}, location: location || {} });
  return page;
}

// Merge the writer's output into the scaffold. Only the generated fields are
// touched: every fixed heading survives whatever the model returned, which is
// what makes "use this H2 exactly as written" a guarantee rather than a hope.
function mergeCbhL3(scaffold, l3 = {}, location = null) {
  const s = scaffold.sections;
  // Em dashes go here, at the seam, rather than being trusted to the prompt.
  // Every generated string on the page passes through `str` or `list`, so this
  // is the one edit that covers all of them -- including a section added later
  // that nobody remembers to sanitize. See cbhContract.removeEmDashes.
  const str = v => contract.removeEmDashes(String(v == null ? '' : v).replace(/\s+/g, ' ').trim());
  const list = v => (Array.isArray(v) ? v.map(str).filter(Boolean) : []);
  // Headings the MODEL writes are cased here rather than asked for in the
  // prompt. A prompt is a request; this is a guarantee, and it applies to
  // every page including ones regenerated from an older draft.
  const keep = contract.protectedTerms({
    serviceName: scaffold.serviceName, locationName: scaffold.locationName, location,
  });
  const heading = v => contract.sentenceCase(str(v), keep);

  if (l3.metaTitle) {
    scaffold.meta.title = contract.titleWithoutSuffix(str(l3.metaTitle));
    scaffold.meta.fullTitle = contract.fullTitle(scaffold.meta.title);
  }
  if (l3.metaDescription) scaffold.meta.metaDescription = str(l3.metaDescription);

  if (l3.hero) {
    s.hero.h1 = heading(l3.hero.h1) || s.hero.h1;
    s.hero.description = str(l3.hero.description) || s.hero.description;
  }

  if (l3.approach) {
    s.approach.paragraphs = list(l3.approach.paragraphs);
    s.approach.philosophy.paragraphs = list(l3.approach.philosophy);
    s.approach.therapies.paragraphs = list(l3.approach.therapies);
  }

  if (l3.insurance) s.insurance.paragraph = str(l3.insurance);
  if (l3.uvp) s.uvp.paragraph = str(l3.uvp);
  if (l3.service) s.service.paragraph = str(l3.service);

  // The paragraph is the model's. The heading is too only on a page without the
  // code-built one; otherwise whatever the model returned is ignored, like any
  // other fixed heading. The `||` keeps what was there when the model omits a
  // value -- a correction pass that returns only the paragraph must not blank
  // the heading.
  if (l3.treatment) {
    if (!scaffold.meta?.fixedExpertsHeading) {
      s.treatment.heading = heading(l3.treatment.heading) || s.treatment.heading;
    }
    s.treatment.paragraph = str(l3.treatment.paragraph) || s.treatment.paragraph;
  }

  if (l3.educational) {
    s.educational.paragraphs = list(l3.educational.paragraphs);
    s.educational.h3s = (l3.educational.h3s || []).map(h => ({
      heading: heading(h.heading),
      lines: list(h.lines),
      // Provenance is decided by the pipeline, not by the model: the writer
      // does not get to declare its own output competitor-backed.
      source: null,
      sourceUrl: '',
    })).filter(h => h.heading);
  }

  if (Array.isArray(l3.faqs)) {
    s.faq.items = l3.faqs
      .map(f => ({
        q: heading(f.q),
        a: str(f.a),
        type: ['location', 'brand', 'intent'].includes(f.type) ? f.type : null,
      }))
      .filter(f => f.q && f.a);
  }

  return scaffold;
}

// Stamps the provenance the pipeline determined onto the educational section.
// `plan` is the brief's H3 list, which knows which headings came from
// competitor research and which were filled from an authoritative source.
function applyProvenance(scaffold, plan = []) {
  const s = scaffold.sections.educational;
  s.h3s = s.h3s.map((h, i) => {
    const planned = plan[i] || {};
    return { ...h, source: planned.source || null, sourceUrl: planned.sourceUrl || '' };
  });
  // The intro is competitor-driven whenever any H3 is; it is written from the
  // same research pass.
  s.source = s.h3s.some(h => h.source === contract.PROVENANCE.COMPETITOR)
    ? contract.PROVENANCE.COMPETITOR
    : (s.h3s.length ? contract.PROVENANCE.FALLBACK : null);
  return scaffold;
}

// Fills in sections a page predates. Pages are stored as whole JSONB blobs,
// so one written before a section existed simply has no key for it -- and the
// wizard's editors assign straight into `p.sections.<key>`, which throws on
// undefined rather than degrading. Read paths run this so an old page opens
// and can be edited up to the current contract instead of crashing the editor.
//
// It adds structure, never content: an empty section still fails its own gates,
// which is the correct signal that the page needs regenerating.
function ensureCbhSections(page) {
  if (!page || !page.sections) return page;
  const s = page.sections;
  if (!s.treatment) s.treatment = { heading: '', paragraph: '' };
  // The FIXED headings are code's, not the page's: restating them here means a
  // page written before one of them was reworded opens with the current text
  // instead of failing the gate that checks it.
  if (s.approach?.philosophy) s.approach.philosophy.heading = FIXED_HEADINGS.approachPhilosophy;
  if (s.approach?.therapies) s.approach.therapies.heading = FIXED_HEADINGS.approachTherapies;
  if (s.insurance) s.insurance.heading = FIXED_HEADINGS.insurance;
  if (s.uvp) s.uvp.heading = FIXED_HEADINGS.uvp;
  return page;
}

module.exports = {
  programGroupsFor, assertCbhEligible,
  buildCbhScaffold, mergeCbhL3, applyProvenance, headingService, ensureCbhSections,
  refreshCbhDerived, buildCbhSchema, caseCbhHeadings, stripCbhEmDashes,
};
