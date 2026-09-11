// ── Seeding template-driven clients ─────────────────────────────────────────
// Turns a client's reference-data file (see data/clearBehavioralHealth.js) into
// L1/L2 rows: the client, its global template, its services and its locations.
//
// Re-runnable, and that matters: the service taxonomy changes (a renamed or
// added service) far more often than the locations do, and re-seeding to pick
// up a service change must not cost the NAP work the SEO team has entered by
// hand. So services are replaced wholesale — they are pure reference data —
// while locations are MERGED, with every hand-populated field winning over the
// seed's blank. That merge is the one in seed.js (mergeLocation), reused
// rather than reimplemented: getting it wrong destroys data silently.

const store = require('./store');
const { slugify } = require('./urlBuilder');
const { mergeLocation, PRESERVED_LOCATION_FIELDS } = require('./seed');

// Location fields the client supplies and the SEO team maintains. A location
// whose entry leaves one blank carries it in `nap_todo`, which is what
// lsCompose turns into §6's "REQUIRED FROM CLIENT" flags on the page and in
// the export. An EMPTY nap_todo is meaningful (the team finished the data), so
// mergeLocation preserves it whenever the stored row has the field at all.
const NAP_FIELDS = ['street_address', 'phone_number', 'serving_areas', 'ages_served', 'directions_url'];

function hasValue(v) {
  if (v == null || v === '') return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v).length > 0;
  return true;
}

// `idPrefix` keeps one client's ids from colliding with another's when two
// brands happen to name a service the same thing ("Anxiety Treatment" is not
// unusual), since services and locations share one table across clients.
function buildServices({ clientId, idPrefix, serviceDefs }) {
  return serviceDefs.map(([name, slug, category, conditions]) => {
    const finalSlug = slug || slugify(name);
    return {
      id: `${idPrefix}svc_${finalSlug}`,
      client_id: clientId,
      name,
      slug: finalSlug,
      category: category || 'therapy',
      // The service's own hub page, which every location variant of it links
      // up to (see internalLinks.buildLsLinks).
      parent_service_url: `/services/${finalSlug}/`,
      conditions_treated: conditions || [],
      related_service_ids: [],
    };
  });
}

// Which services a location actually offers, resolved from the slugs the data
// file lists against it. This is a FACTUAL claim — §13.18 forbids inventing
// service availability, and `services_available_ids` is what decides which
// pages can be built and which siblings get linked — so an unknown slug is an
// error rather than a silently shorter list. A location that names no slugs at
// all offers everything, which is the right default for a single-site client.
function resolveServiceIds({ locationName, serviceSlugs, servicesBySlug, allServiceIds }) {
  if (!serviceSlugs) return allServiceIds;
  return serviceSlugs.map((slug) => {
    const id = servicesBySlug.get(slug);
    if (!id) throw new Error(`Location "${locationName}" lists service slug "${slug}", which no service defines.`);
    return id;
  });
}

function buildLocations({ clientId, idPrefix, locationDefs, serviceIds, stateNames, servicesBySlug = new Map() }) {
  return locationDefs.map(([locationName, city, stateAbbr, opts = {}]) => {
    // Slugged from the location NAME, not the city: a client can run several
    // facilities in one city ("Redondo Beach Outpatient" and "Redondo Beach
    // Residential" are different buildings with different addresses), and a
    // city-based slug would give them the same URL. For the usual case, where
    // the location is named after its city, the two are identical anyway.
    const locationSlug = opts.locationSlug || slugify(locationName || city);
    const row = {
      id: `${idPrefix}loc_${slugify(locationName || city)}`,
      client_id: clientId,
      location_name: locationName,
      city: city || locationName,
      region: opts.region || '',
      state: stateNames[stateAbbr] || opts.state || stateAbbr,
      state_abbreviation: stateAbbr,
      location_slug: locationSlug,
      // The location's own page on the client's site. Used for the breadcrumb
      // and the "this location" internal link, so it is left EMPTY rather than
      // guessed when the client has not given one — a breadcrumb pointing at a
      // URL that does not exist is worse than a shorter breadcrumb.
      location_page_url: opts.pagePath || '',
      street_address: opts.street || '',
      zip_code: opts.zip || '',
      phone_number: opts.phone || '',
      // §6 SERVING_AREAS and AGES_SERVED — client-verified facts.
      serving_areas: opts.servingAreas || [],
      ages_served: opts.agesServed || '',
      nearby_areas: opts.servingAreas || [],
      directions_url: opts.directionsUrl || '',
      appointment_url: opts.appointmentUrl || '',
      gbp_url: opts.gbpUrl || '',
      hours_by_day: opts.hoursByDay || {},
      latitude: opts.latitude || '',
      longitude: opts.longitude || '',
      hero_image_url: '', hero_image_alt: '',
      // Eligibility guardrail (a page is only built for a real location); the
      // NAP itself is still flagged field by field below.
      verified: true,
      services_available_ids: opts.serviceIds
        || resolveServiceIds({ locationName, serviceSlugs: opts.serviceSlugs, servicesBySlug, allServiceIds: serviceIds }),
    };
    row.nap_todo = NAP_FIELDS.filter(f => !hasValue(row[f]));
    return row;
  });
}

// The generic seeder. `data` is a reference-data module's exports.
async function seedLsClient(data, { idPrefix }) {
  const clientId = data.CLIENT_ID;
  await store.upsertBy('clients', 'id', data.CLIENT, 'client');
  await store.upsertBy('globalTemplates', 'id', data.GLOBAL_TEMPLATE, 'gt');

  const services = buildServices({ clientId, idPrefix, serviceDefs: data.SERVICE_DEFS || [] });
  const serviceIds = services.map(s => s.id);
  await store.replaceAllForClient('services', clientId, services);

  const seeded = buildLocations({
    clientId, idPrefix,
    locationDefs: data.LOCATION_DEFS || [],
    serviceIds,
    servicesBySlug: new Map(services.map(s => [s.slug, s.id])),
    stateNames: data.STATE_NAMES || {},
  });
  const stored = await store.list('locations', { client_id: clientId });
  const storedById = new Map(stored.map(l => [l.id, l]));
  const locations = seeded.map(l => mergeLocation(l, storedById.get(l.id)));
  await store.replaceAllForClient('locations', clientId, locations);

  const preserved = locations.filter(l => storedById.has(l.id)
    && PRESERVED_LOCATION_FIELDS.some(f => hasValue(l[f]) && hasValue(storedById.get(l.id)[f]))).length;

  return {
    client_id: clientId,
    services: services.length,
    locations: locations.length,
    locations_with_preserved_data: preserved,
    // Surfaced so the wizard can say "paste the client list into
    // data/clearBehavioralHealth.js" instead of showing empty dropdowns with
    // no explanation.
    reference_data_missing: !services.length || !locations.length,
  };
}

async function seedClearBehavioralHealth() {
  const data = require('./data/clearBehavioralHealth');
  return seedLsClient(data, { idPrefix: 'cbh_' });
}

module.exports = { seedLsClient, seedClearBehavioralHealth, buildServices, buildLocations, resolveServiceIds, NAP_FIELDS };
