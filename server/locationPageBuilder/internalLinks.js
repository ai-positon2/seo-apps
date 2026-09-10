// ── Internal link builder (Spec §7.2 step 5, §16 caps, §18) ─────────────────
// Pulls link targets from the Service / Resource / Location stores — never
// invents URLs. Caps sibling-location links to avoid manipulative patterns.

const config = require('./config');

function build({ layers }) {
  const { service, location, servicesAtLocation, resources, allServices } = layers;
  const links = [];
  const seen = new Set();
  const add = (anchor_text, url, link_type, placement) => {
    if (!url || seen.has(url) || links.length >= config.internalLinks.maxTotal) return;
    seen.add(url);
    links.push({ anchor_text, url, link_type, placement });
  };

  // Parent service hub
  if (service.parent_service_url) add(`${service.name} services`, service.parent_service_url, 'service', 'definition');

  // Related services at this location (current excluded)
  servicesAtLocation
    .filter(s => s.id !== service.id)
    .slice(0, 4)
    .forEach(s => add(`${s.name} in ${location.location_name}`, `/locations/${location.location_slug}/${s.slug}/`, 'service', 'services_we_offer'));

  // Appointment / CTA page
  if (location.appointment_url) add('Schedule a consultation', location.appointment_url, 'cta', 'final_cta');

  // Location hub
  if (location.location_page_url) add(`${location.location_name} location`, location.location_page_url, 'location', 'hero');

  // Relevant resources (capped)
  (resources || []).slice(0, 3).forEach(r => add(r.title, r.url, 'resource', 'latest_resources'));

  // Sibling-location pages for the same service (capped — §16)
  // (we link to the same service at OTHER verified locations, bounded)
  return links;
}

// ── Dental (Gentle Dental) sibling-location links — Build Brief Appendix C ───
// Combo pages currently only link out to global service pages; this closes
// the gap by linking the SAME service at a few OTHER offices (preferring the
// same region), building a location-level topical cluster. Deterministic —
// pulls URLs from the locations store, never invents them.
function buildDentalSiblings({ allLocations, currentLocation, service }) {
  const cap = config.internalLinks.maxSiblingLocations;
  const others = allLocations.filter(l => l.id !== currentLocation.id);
  const sameRegion = others.filter(l => l.region === currentLocation.region);
  const rest = others.filter(l => l.region !== currentLocation.region);
  const picked = [...sameRegion, ...rest].slice(0, cap);

  return picked.map(l => ({
    anchor_text: `${service.name} in ${l.city}`,
    url: `${l.location_page_url}/${service.slug}`,
    link_type: 'sibling_location',
    placement: 'services_in_city',
  }));
}

// ── Template-driven pages — internal links ──────────────────────────────────
// buildDentalSiblings cannot be reused here: it builds a sibling URL as
// `{location_page_url}/{service_slug}`, which is the Gentle Dental site's
// shape. A template-driven page's URL comes from its profile's own pattern
// (template §2), so the links are built through the same function that built
// this page's URL — otherwise every sibling link 404s on a client whose site
// nests pages differently.
//
// Deterministic: every URL is derived from a location row or a service row,
// never invented. Sibling locations are capped by config.internalLinks (§16)
// to avoid a manipulative cross-location pattern.
function buildLsLinks({ allLocations, currentLocation, service, profile, lsPageUrl }) {
  const links = [];
  const seen = new Set();
  const add = (anchor_text, url, link_type, placement) => {
    if (!url || seen.has(url) || links.length >= config.internalLinks.maxTotal) return;
    seen.add(url);
    links.push({ anchor_text, url, link_type, placement });
  };

  // The service's own hub page — the parent of every location variant of it.
  if (service.parent_service_url) add(`${service.name}`, service.parent_service_url, 'service', 'body');
  // This location's own page.
  if (currentLocation.location_page_url) {
    add(`${currentLocation.location_name || currentLocation.city} location`, currentLocation.location_page_url, 'location', 'location_info');
  }

  // The same service at other locations, same region first so the cluster is
  // geographically coherent rather than arbitrary.
  const others = (allLocations || []).filter(l => l.id !== currentLocation.id
    && (l.services_available_ids || []).includes(service.id));
  const sameRegion = others.filter(l => l.region && l.region === currentLocation.region);
  const rest = others.filter(l => !l.region || l.region !== currentLocation.region);
  [...sameRegion, ...rest]
    .slice(0, config.internalLinks.maxSiblingLocations)
    .forEach(l => add(
      `${service.name} in ${l.city || l.location_name}`,
      lsPageUrl(profile, l, service),
      'sibling_location',
      'related_locations',
    ));

  return links;
}

module.exports = { build, buildDentalSiblings, buildLsLinks };
