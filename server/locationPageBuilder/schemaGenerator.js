// ── Schema generation, JSON-LD (Spec §8) ───────────────────────────────────
// Skeletons live in L1; values pulled from L2/L3. aggregateRating/review ONLY
// from approved real reviews (Spec §8, §15.3). FAQPage MUST mirror visible FAQs.

function generateSchema(pageObject) {
  const pd = pageObject.page_data;
  const ld = pageObject.location_data;
  const sd = pageObject.service_data;
  const gt = pageObject.global_template;
  const client = pageObject._client || {};
  const brand = pageObject.global_template.brand_name;
  const url = pd.canonical_url || pd.page_url;
  const businessType = gt.business_type || 'LocalBusiness';

  // BreadcrumbList: Home → Location → Service
  const breadcrumb = {
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: (client.brand_static?.base_url || '') + '/' },
      { '@type': 'ListItem', position: 2, name: ld.location_name, item: (client.brand_static?.base_url || '') + ld.location_page_url },
      { '@type': 'ListItem', position: 3, name: pd.breadcrumb_label, item: url },
    ],
  };

  // LocalBusiness / MedicalBusiness
  const approvedReviews = (ld.reviews || []).filter(r => r.text && r.rating);
  const localBusiness = {
    '@type': businessType,
    name: `${brand} — ${ld.location_name}`,
    description: pd.meta_description || `${sd.service_name} in ${ld.location_name}, ${ld.state}.`,
    url,
    telephone: ld.phone_number,
    image: ld.hero_image_url || undefined,
    logo: client.brand_static?.logo || undefined,
    address: {
      '@type': 'PostalAddress',
      streetAddress: ld.street_address,
      addressLocality: ld.city,
      addressRegion: ld.state_abbreviation,
      postalCode: ld.zip_code,
      addressCountry: 'US',
    },
    ...(ld.latitude && ld.longitude ? { geo: { '@type': 'GeoCoordinates', latitude: ld.latitude, longitude: ld.longitude } } : {}),
    sameAs: [ld.gbp_url, ...(client.brand_static?.sameAs || [])].filter(Boolean),
    hasOfferCatalog: {
      '@type': 'OfferCatalog',
      name: `Services at ${ld.location_name}`,
      itemListElement: (pd.services_for_schema || []).map(s => ({
        '@type': 'Offer', itemOffered: { '@type': 'Service', name: s.name },
      })),
    },
  };
  // Reviews/aggregateRating ONLY if approved real reviews exist (Spec §15.3)
  if (approvedReviews.length) {
    const avg = approvedReviews.reduce((s, r) => s + Number(r.rating || 0), 0) / approvedReviews.length;
    localBusiness.aggregateRating = { '@type': 'AggregateRating', ratingValue: avg.toFixed(1), reviewCount: approvedReviews.length };
    localBusiness.review = approvedReviews.map(r => ({
      '@type': 'Review', author: { '@type': 'Person', name: r.reviewer_name },
      reviewRating: { '@type': 'Rating', ratingValue: r.rating }, reviewBody: r.text, datePublished: r.date,
    }));
  }

  // Service schema
  const serviceSchema = {
    '@type': 'Service',
    name: `${sd.service_name} in ${ld.location_name}`,
    description: pd.meta_description || pd.approach?.intro || '',
    provider: { '@type': businessType, name: `${brand} — ${ld.location_name}` },
    areaServed: [ld.city, ...(ld.nearby_areas || [])],
  };

  // FAQPage — mirrors visible FAQs exactly (QA-checked)
  const faqPage = {
    '@type': 'FAQPage',
    mainEntity: (pd.faqs || []).map(f => ({
      '@type': 'Question', name: f.question,
      acceptedAnswer: { '@type': 'Answer', text: f.answer },
    })),
  };

  // Yoast-style graph
  const yoastGraph = {
    '@context': 'https://schema.org',
    '@graph': [
      { '@type': 'WebPage', '@id': `${url}#webpage`, url, name: pd.meta_title, description: pd.meta_description, primaryImageOfPage: ld.hero_image_url ? { '@id': `${url}#primaryimage` } : undefined },
      ...(ld.hero_image_url ? [{ '@type': 'ImageObject', '@id': `${url}#primaryimage`, url: ld.hero_image_url, caption: ld.hero_image_alt }] : []),
      { ...breadcrumb, '@id': `${url}#breadcrumb` },
      { '@type': 'WebSite', '@id': `${client.brand_static?.base_url || ''}#website`, url: client.brand_static?.base_url || '', name: brand },
      { '@type': 'Organization', '@id': `${client.brand_static?.base_url || ''}#organization`, name: brand, logo: client.brand_static?.logo, sameAs: client.brand_static?.sameAs || [] },
    ].filter(Boolean),
  };

  const schema = {
    yoast_graph: yoastGraph,
    local_business: localBusiness,
    service: serviceSchema,
    faq_page: faqPage,
    breadcrumb_list: breadcrumb,
    offer_catalog: localBusiness.hasOfferCatalog,
  };

  // MedicalCondition for condition/procedure categories (Spec §8)
  if (['condition', 'procedure'].includes(sd.service_category)) {
    schema.medical_condition = (sd.conditions_treated || []).slice(0, 5).map(c => ({ '@type': 'MedicalCondition', name: c }));
  }

  return schema;
}

// ── Dental (Gentle Dental) schema — Build Brief §2.2/§7, Appendix C layering ──
// MedicalWebPage (page) > Dentist/LocalBusiness (office) > MedicalProcedure
// (service) > FAQPage (FAQ) > BreadcrumbList. Each returned as a MINIFIED JSON
// string (brief §5: "the single <script type=application/ld+json>...</script>
// block, minified and valid"), not an object. NAP fields are only included when
// present (they're pulled from the location record, which may be empty — never
// fabricated).
function stripHtml(html) {
  return String(html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function generateDentalSchema({ scaffold, client, location, service }) {
  const m = scaffold.meta;
  const sec = scaffold.sections;
  // The practice name for THIS page, resolved once in compose. Offices with
  // their own local brand must not be described as Gentle Dental in schema.
  const brand = m.brandName || client.name;
  const officeInfo = sec.officeInfo;

  const breadcrumbList = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: sec.breadcrumb.items.map((it, i) => ({
      '@type': 'ListItem', position: i + 1, name: it.label, item: it.url,
    })),
  };

  const address = {
    '@type': 'PostalAddress',
    ...(officeInfo.address ? { streetAddress: officeInfo.address } : {}),
    addressLocality: location.city,
    addressRegion: location.state_abbreviation,
    addressCountry: 'US',
  };
  const dentist = {
    '@context': 'https://schema.org',
    '@type': 'Dentist',
    name: `${brand} — ${officeInfo.name}`,
    url: m.canonical,
    ...(officeInfo.phone ? { telephone: officeInfo.phone } : {}),
    address,
    ...(location.latitude && location.longitude
      ? { geo: { '@type': 'GeoCoordinates', latitude: location.latitude, longitude: location.longitude } }
      : {}),
  };

  const medicalWebPage = {
    '@context': 'https://schema.org',
    '@type': 'MedicalWebPage',
    url: m.canonical,
    name: m.title,
    description: m.metaDescription || '',
    about: { '@type': 'MedicalProcedure', name: service.name },
  };

  const procedureDescription = stripHtml(
    (sec.educationalBody.blocks || []).map(b => b.html).join(' ')
  ).slice(0, 500) || m.metaDescription || sec.hero.intro || '';
  const medicalProcedure = {
    '@context': 'https://schema.org',
    '@type': 'MedicalProcedure',
    name: service.name,
    description: procedureDescription,
    provider: { '@type': 'Dentist', name: brand },
  };

  const faqPage = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: (sec.faq.items || []).map(f => ({
      '@type': 'Question', name: f.q,
      acceptedAnswer: { '@type': 'Answer', text: f.a },
    })),
  };

  return {
    breadcrumbList: JSON.stringify(breadcrumbList),
    dentist: JSON.stringify(dentist),
    medicalWebPage: JSON.stringify(medicalWebPage),
    medicalProcedure: JSON.stringify(medicalProcedure),
    faqPage: JSON.stringify(faqPage),
  };
}

module.exports = { generateSchema, generateDentalSchema };
