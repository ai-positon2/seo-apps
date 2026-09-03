// ── Seed data: Neuro Wellness Spa (Spec — first client / worked example) ─────
// Replaces the L1 + L2 catalog wholesale so the dropdowns are exactly the
// seeded set (every service available at every location). Pages are preserved.

const store = require('./store');
const { slugify } = require('./urlBuilder');
const config = require('./config');

const CLIENT_ID = 'client_neuro_wellness_spa';
const BASE_URL = 'https://neurowellnessspa.com';

const CLIENT = {
  id: CLIENT_ID,
  name: 'Neuro Wellness Spa',
  brand_static: {
    logo: `${BASE_URL}/logo.png`,
    org_schema: { '@type': 'Organization', name: 'Neuro Wellness Spa', url: BASE_URL },
    sameAs: ['https://www.facebook.com/neurowellnessspa', 'https://www.instagram.com/neurowellnessspa'],
    base_url: BASE_URL,
    stats: { years_in_business: 10, patients_treated: '5,000+', locations: 13, expert_providers: 20 },
  },
  brand_rules: {
    ymyl: true,
    prohibited_claims: [
      'guaranteed cure', 'guaranteed results', 'cure depression', 'permanent cure',
      '100% effective', 'no side effects', 'miracle', 'instant results',
    ],
    licensing_language: 'All care is provided by licensed clinicians. Credentials are pulled from the provider record only.',
  },
  global_template_id: 'gt_neuro_location_service',
};

const GLOBAL_TEMPLATE = {
  id: 'gt_neuro_location_service',
  client_id: CLIENT_ID,
  page_type: 'location_service',
  // Section order matches the requested deliverable structure (feedback §5).
  section_order: ['seo', 'hero', 'approach', 'competitor_section', 'faqs', 'schema'],
  section_layouts: {},
  seo_head_structure: {
    meta_title_pattern: '[Service] in [Location] | [Brand]',
    h1_pattern: '[Adjective] [Service] in [Location]',
  },
  schema_skeletons: { business_type: 'MedicalBusiness' },
};

// name → category (Spec §3.4). Duplicates from the brief are de-duplicated.
const SERVICE_DEFS = [
  ['Depression treatment', 'condition', ['Depression', 'Major depressive disorder', 'Seasonal depression']],
  ['Anxiety treatment', 'condition', ['Anxiety', 'Generalized anxiety disorder', 'Panic disorder']],
  ['Addiction treatment', 'condition', ['Substance use disorder', 'Alcohol dependence', 'Behavioral addiction']],
  ['Grief and loss therapy', 'therapy', ['Grief', 'Bereavement', 'Complicated grief']],
  ['Stress and anxiety therapy', 'therapy', ['Stress', 'Anxiety', 'Burnout']],
  ['Grief counseling', 'therapy', ['Grief', 'Loss', 'Life transitions']],
  ['ADHD therapy', 'therapy', ['ADHD', 'Inattention', 'Executive dysfunction']],
  ['PTSD treatment', 'condition', ['PTSD', 'Trauma', 'Acute stress']],
  ['ADHD counseling', 'therapy', ['ADHD', 'Focus difficulties', 'Organization challenges']],
  ['Medication management', 'medication', ['Depression', 'Anxiety', 'ADHD', 'Bipolar disorder', 'OCD', 'PTSD']],
  ['Psychotherapy', 'therapy', ['Anxiety', 'Depression', 'Relationship concerns', 'Stress']],
  ['Depression treatment teens', 'condition', ['Teen depression', 'Adolescent mood disorders']],
  ['OCD treatment', 'condition', ['OCD', 'Intrusive thoughts', 'Compulsions']],
  ['PTSD therapy', 'therapy', ['PTSD', 'Trauma', 'Hypervigilance']],
  ['Stress counseling', 'therapy', ['Stress', 'Work stress', 'Burnout']],
];

const SERVICES = SERVICE_DEFS.map(([name, category, conditions]) => ({
  id: `svc_${slugify(name)}`,
  client_id: CLIENT_ID,
  name,
  slug: slugify(name),
  category,
  parent_service_url: `/services/${slugify(name)}/`,
  related_service_ids: [],
  conditions_treated: conditions,
  symptoms_addressed: conditions.slice(0, 3),
  treatment_process: ['Initial assessment', 'Personalized plan', 'Ongoing care', 'Progress review'],
  available_in_person: true,
  available_virtual: category !== 'procedure',
  teen_available: /teen/i.test(name) || category === 'medication' || category === 'therapy',
  service_disclaimers: '',
  semantic_variants: [name.toLowerCase().replace(/treatment|therapy|counseling/i, '').trim()].filter(Boolean),
}));

const ALL_SERVICE_IDS = SERVICES.map(s => s.id);

// city, street, zip, nearby areas. Every location offers every service.
const LOCATION_DEFS = [
  ['Westlake Village', '2625 Townsgate Rd, Suite 330', '91361', ['Thousand Oaks', 'Agoura Hills', 'Calabasas']],
  ['Fresno', '7081 N Marks Ave, Suite 104', '93711', ['Clovis', 'Madera', 'Sanger']],
  ['Beverly Hills', '436 N Bedford Dr, Suite 308', '90210', ['West Hollywood', 'Century City', 'Westwood']],
  ['Santa Monica', '2825 Santa Monica Blvd, Suite 210', '90404', ['Venice', 'Brentwood', 'Marina del Rey']],
  ['Sacramento', '1234 H St, Suite 200', '95814', ['Davis', 'Elk Grove', 'Roseville']],
  ['Manhattan Beach', '1230 Rosecrans Ave, Suite 300', '90266', ['Hermosa Beach', 'El Segundo', 'Redondo Beach']],
  ['Torrance', '21250 Hawthorne Blvd, Suite 500', '90503', ['Carson', 'Lomita', 'Gardena']],
  ['Marina del Rey', '4640 Admiralty Way, Suite 500', '90292', ['Venice', 'Playa Vista', 'Culver City']],
  ['Long Beach', '111 W Ocean Blvd, Suite 400', '90802', ['Lakewood', 'Signal Hill', 'Seal Beach']],
  ['Encino', '16133 Ventura Blvd, Suite 700', '91436', ['Tarzana', 'Sherman Oaks', 'Studio City']],
  ['Pasadena', '65 N Madison Ave, Suite 404', '91101', ['Altadena', 'South Pasadena', 'Arcadia']],
  ['Brea', '475 S State College Blvd', '92821', ['Fullerton', 'Placentia', 'Yorba Linda']],
  ['Lake Forest', '23151 Moulton Pkwy, Suite 105', '92630', ['Mission Viejo', 'Irvine', 'Laguna Hills']],
];

const LOCATIONS = LOCATION_DEFS.map(([city, street, zip, nearby]) => {
  const citySlug = slugify(city);
  return {
    id: `loc_${citySlug}`,
    client_id: CLIENT_ID,
    location_name: city, city, state: 'California', state_abbreviation: 'CA',
    street_address: street, zip_code: zip, phone_number: '(877) 847-3984',
    latitude: '', longitude: '',
    location_slug: `psychiatrist-${citySlug}`,
    location_page_url: `/locations/psychiatrist-${citySlug}/`,
    appointment_url: `${BASE_URL}/contact/`, gbp_url: `https://g.page/neuro-${citySlug}`,
    hero_image_url: `${BASE_URL}/images/${citySlug}-office.jpg`,
    hero_image_alt: `Neuro Wellness Spa office in ${city}, CA`,
    parking_info: `Free on-site parking available at the ${city} office.`,
    nearby_areas: nearby,
    verified: true,
    services_available_ids: ALL_SERVICE_IDS, // every service available at every location
  };
});

const ALL_LOCATION_IDS = LOCATIONS.map(l => l.id);

const PROVIDERS = [
  {
    id: 'prov_chen', client_id: CLIENT_ID, name: 'Dr. Emily Chen', credentials: 'MD',
    title: 'Board-Certified Psychiatrist', specialty: 'Adult & adolescent psychiatry',
    bio: 'Dr. Chen specializes in mood and anxiety disorders with a focus on integrative, evidence-based care.',
    image_url: `${BASE_URL}/images/dr-chen.jpg`, linkedin_url: 'https://linkedin.com/in/dr-emily-chen',
    location_ids: ALL_LOCATION_IDS, service_ids: ALL_SERVICE_IDS,
  },
  {
    id: 'prov_patel', client_id: CLIENT_ID, name: 'Dr. Anil Patel', credentials: 'MD',
    title: 'Psychiatrist & Medical Director', specialty: 'Treatment-resistant depression & medication management',
    bio: 'Dr. Patel leads clinical care and has treated thousands of patients across mood and anxiety conditions.',
    image_url: `${BASE_URL}/images/dr-patel.jpg`, linkedin_url: 'https://linkedin.com/in/dr-anil-patel',
    location_ids: ALL_LOCATION_IDS, service_ids: ALL_SERVICE_IDS,
  },
  {
    id: 'prov_rivera', client_id: CLIENT_ID, name: 'Sofia Rivera', credentials: 'LMFT',
    title: 'Licensed Marriage & Family Therapist', specialty: 'Talk therapy, grief & relationship counseling',
    bio: 'Sofia provides compassionate therapy for individuals, couples, and teens.',
    image_url: `${BASE_URL}/images/sofia-rivera.jpg`, linkedin_url: 'https://linkedin.com/in/sofia-rivera-lmft',
    location_ids: ALL_LOCATION_IDS, service_ids: ALL_SERVICE_IDS,
  },
];

// A couple of approved reviews per a few locations (real-reviews-only guardrail).
const REVIEWS = [];
['loc_brea', 'loc_beverly-hills', 'loc_santa-monica', 'loc_pasadena', 'loc_long-beach'].forEach((locId, i) => {
  REVIEWS.push(
    { id: `rev_${locId}_1`, client_id: CLIENT_ID, location_id: locId, reviewer_name: ['Jessica M.', 'Karen T.', 'David R.', 'Priya S.', 'Marcus L.'][i], rating: 5, text: 'Compassionate, professional care that genuinely helped. Highly recommend this office.', date: '2026-03-12', source: 'Google', approved: true },
    { id: `rev_${locId}_2`, client_id: CLIENT_ID, location_id: locId, reviewer_name: 'Anon', rating: 5, text: 'Easy to schedule and welcoming providers.', date: '2026-02-02', source: 'Google', approved: true },
  );
});

const INSURANCE_SETS = [
  {
    id: 'ins_brand', client_id: CLIENT_ID, location_id: null,
    providers: [
      { name: 'Aetna', logo_url: `${BASE_URL}/images/aetna.png`, alt_text: 'Aetna logo' },
      { name: 'Cigna', logo_url: `${BASE_URL}/images/cigna.png`, alt_text: 'Cigna logo' },
      { name: 'Anthem Blue Cross', logo_url: `${BASE_URL}/images/anthem.png`, alt_text: 'Anthem Blue Cross logo' },
      { name: 'UnitedHealthcare', logo_url: `${BASE_URL}/images/uhc.png`, alt_text: 'UnitedHealthcare logo' },
    ],
    copy: 'We accept most major insurance plans and offer flexible self-pay options.',
    disclaimer: 'Coverage varies by plan. Please contact us to verify your specific benefits.',
  },
];

const RESOURCES = [
  { id: 'res_1', client_id: CLIENT_ID, title: 'Understanding Therapy: What to Expect', url: '/blog/understanding-therapy/', image_url: '', related_service_ids: ['svc_psychotherapy', 'svc_anxiety-treatment'], related_condition_tags: ['anxiety', 'depression'], published_date: '2026-01-10' },
  { id: 'res_2', client_id: CLIENT_ID, title: 'A Guide to Psychiatric Medication Management', url: '/blog/medication-management-guide/', image_url: '', related_service_ids: ['svc_medication-management'], related_condition_tags: ['adhd', 'anxiety'], published_date: '2026-03-01' },
  { id: 'res_3', client_id: CLIENT_ID, title: 'Coping with Grief and Loss', url: '/blog/coping-with-grief/', image_url: '', related_service_ids: ['svc_grief-counseling', 'svc_grief-and-loss-therapy'], related_condition_tags: ['grief'], published_date: '2026-02-15' },
];

const TONE_PROFILE = {
  id: 'tone_neuro', client_id: CLIENT_ID,
  voice: 'Warm, compassionate, professional, and reassuring. Patient-centered and hopeful without overpromising.',
  reading_level: 'Grade 8-9', avg_sentence_length: 18,
  vocabulary_notes: 'Plain-language mental-health terms; avoids clinical jargon; uses "care", "support", "healing".',
  cta_phrasing: ['Schedule a consultation', 'Take the first step', "Let's talk"],
  formatting_habits: 'Short paragraphs, descriptive H2/H3s, scannable bullet lists, FAQ accordions.',
  structural_signals: { hero_cta: true, care_pillars: 2 },
  sample_urls: [`${BASE_URL}/locations/psychiatrist-brea/psychotherapy/`],
  confirmed: true,
};

async function seedNeuroWellness() {
  await store.upsertBy('clients', 'id', CLIENT, 'client');
  await store.upsertBy('globalTemplates', 'id', GLOBAL_TEMPLATE, 'gt');
  // Scoped to this client_id — does NOT touch other clients' rows in the
  // same shared table (see store.replaceAllForClient).
  await store.replaceAllForClient('services', CLIENT_ID, SERVICES);
  await store.replaceAllForClient('locations', CLIENT_ID, LOCATIONS);
  await store.replaceAllForClient('providers', CLIENT_ID, PROVIDERS);
  await store.replaceAllForClient('reviews', CLIENT_ID, REVIEWS);
  await store.replaceAllForClient('insuranceSets', CLIENT_ID, INSURANCE_SETS);
  await store.replaceAllForClient('resources', CLIENT_ID, RESOURCES);
  await store.upsertBy('toneProfiles', 'id', TONE_PROFILE, 'tone');
  return { client_id: CLIENT_ID, services: SERVICES.length, locations: LOCATIONS.length, providers: PROVIDERS.length };
}

// ── Seed data: Gentle Dental of New England (dental location+service wizard) ─
// NAP (address/phone/hours/directions/map) is intentionally left EMPTY — it
// is populated manually from GBP/Birdeye later, not by this seeder or the
// generator (never fabricated). Every office offers every service.

const GD_CLIENT_ID = 'client_gentle_dental';
const GD_BASE_URL = 'https://gentledental.com';

const GD_CLIENT = {
  id: GD_CLIENT_ID,
  name: 'Gentle Dental of New England',
  brand_static: {
    logo: '',
    org_schema: { '@type': 'Organization', name: 'Gentle Dental of New England', url: GD_BASE_URL },
    sameAs: [],
    base_url: GD_BASE_URL,
  },
  brand_rules: {
    ymyl: true,
    prohibited_claims: [
      'guaranteed results', 'guarantee', 'pain-free guarantee', 'cure',
      'permanent results', '100% effective', 'no risk', 'miracle', 'instant results',
    ],
  },
  global_template_id: 'gt_gentle_dental_location_service',
};

const GD_GLOBAL_TEMPLATE = {
  id: 'gt_gentle_dental_location_service',
  client_id: GD_CLIENT_ID,
  page_type: 'dental_location_service',
  // Section order matches the Build Brief §2.2 GeneratedPage contract.
  section_order: ['seo', 'hero', 'breadcrumb', 'officeInfo', 'servicesInCity', 'educationalBody', 'faq', 'schema'],
  section_layouts: {},
  seo_head_structure: {
    // [Brand] is the per-office practice name (config.dental.brand), not the
    // group name — a few offices trade under their own brand.
    meta_title_pattern: '[Service] in [City], [STATE] | [Brand]',
    h1_pattern: '[Service] in [City], [STATE]',
  },
  schema_skeletons: { business_type: 'Dentist' },
};

// Appendix A — 26 services (category | name | slug).
const GD_SERVICE_DEFS = [
  // The client's own service taxonomy. Three kinds of page live here, and they
  // all run through the same generator:
  //   - single procedures ("Dental Crowns", "Root Canals")
  //   - category hubs ("Cosmetic Dentistry", "Oral Surgery")
  //   - practitioner pages ("Orthodontist", "Periodontist")
  //
  // Deliberate near-pairs are NOT accidental duplicates: "Teeth Extractions"
  // and "Tooth Extraction", "TMD/TMJ Treatment" and "TMJ Treatment" target
  // different searches and get their own pages.
  //
  // The slug is the page URL and the service id, so renaming a service here
  // changes both. Anything already generated under the old slug is orphaned
  // (compose.loadLayers can no longer resolve it) and has to be regenerated.
  // Every slug added here also needs an entry in keywordUniverseMap, or its
  // live keyword pool loses its topical filter.
  ['Cosmetic', 'Cosmetic Dentistry', 'cosmetic-dentistry'],
  ['Cosmetic', 'Smile Makeover', 'smile-makeover'],
  ['Cosmetic', 'Teeth Whitening', 'teeth-whitening'],
  ['Cosmetic', 'Veneers', 'veneers'],
  ['Cosmetic', 'Invisalign® Treatment', 'invisalign-treatment'],

  ['Restorative', 'Restorative Dentistry', 'restorative-dentistry'],
  ['Restorative', 'Crowns and Bridges', 'crowns-and-bridges'],
  ['Restorative', 'Dental Crowns', 'dental-crowns'],
  ['Restorative', 'Dental Bridges', 'dental-bridges'],
  ['Restorative', 'Dental Fillings', 'dental-fillings'],
  ['Restorative', 'Root Canals', 'root-canals'],
  ['Restorative', 'Dental Implants', 'dental-implants'],
  ['Restorative', 'Dentures', 'dentures'],
  ['Restorative', 'Gum Treatments', 'gum-treatments'],
  ['Restorative', 'Gum Disease Treatment', 'gum-disease-treatment'],

  ['Oral Surgery', 'Oral Surgery', 'oral-surgery'],
  ['Oral Surgery', 'Teeth Extractions', 'teeth-extractions'],
  ['Oral Surgery', 'Tooth Extraction', 'tooth-extraction'],
  ['Oral Surgery', 'Wisdom Teeth Extractions', 'wisdom-teeth-extractions'],

  ['Orthodontics', 'Orthodontics', 'orthodontics'],
  ['Orthodontics', 'Orthodontist', 'orthodontist'],
  ['Orthodontics', 'Braces', 'braces'],

  ['Preventive', 'Preventive Dentistry', 'preventive-dentistry'],
  ['Preventive', 'Dental Exam', 'dental-exam'],
  ['Preventive', 'Dental Cleaning', 'dental-cleaning'],
  ['Preventive', 'Digital X-Rays', 'digital-x-rays'],
  ['Preventive', 'Fluoride Treatment', 'fluoride-treatment'],
  ['Preventive', 'Dental Sealants', 'dental-sealants'],
  ['Preventive', 'Oral Cancer Screening', 'oral-cancer-screening'],
  ['Preventive', 'Curodont™', 'curodont'],
  ['Preventive', 'Diabetes And Oral Health', 'diabetes-and-oral-health'],

  ['Specialty', 'Emergency Dentist', 'emergency-dentist'],
  ['Specialty', 'Pediatric Dentistry', 'pediatric-dentistry'],
  ['Specialty', 'Periodontist', 'periodontist'],
  ['Specialty', 'Sedation Dentistry', 'sedation-dentistry'],
  ['Specialty', 'Sleep Apnea Treatment', 'sleep-apnea-treatment'],
  ['Specialty', 'TMD/TMJ Treatment', 'tmd-tmj-treatment'],
  ['Specialty', 'TMJ Treatment', 'tmj-treatment'],
];


const GD_SERVICES = GD_SERVICE_DEFS.map(([category, name, slug]) => ({
  id: `dsvc_${slug}`,
  client_id: GD_CLIENT_ID,
  name,
  slug,
  category,
}));

const GD_ALL_SERVICE_IDS = GD_SERVICES.map(s => s.id);

// Appendix B — 50 offices (state_abbreviation | region | city/officeName | pagePath).
const GD_LOCATION_DEFS = [
  ['MA', 'Boston', 'Boston', '/dental-offices/ma/boston'],
  ['MA', 'Boston', 'Boston - Newbury Street', '/dental-offices/ma/boston/newbury-st'],
  ['MA', 'Boston', 'Brighton', '/dental-offices/ma/boston/brighton'],
  ['MA', 'Boston', 'Brookline', '/dental-offices/ma/brookline'],
  ['MA', 'Boston', 'Jamaica Plain', '/dental-offices/ma/boston/jamaica-plain'],
  ['MA', 'Boston', 'South Boston', '/dental-offices/ma/boston/south-boston'],
  ['MA', 'Boston', 'West Roxbury', '/dental-offices/ma/boston/west-roxbury'],
  ['MA', 'Greater Boston', 'Arlington', '/dental-offices/ma/arlington'],
  ['MA', 'Greater Boston', 'Belmont', '/dental-offices/ma/belmont'],
  ['MA', 'Greater Boston', 'Brockton', '/dental-offices/ma/brockton'],
  ['MA', 'Greater Boston', 'Burlington', '/dental-offices/ma/burlington'],
  ['MA', 'Greater Boston', 'Cambridge', '/dental-offices/ma/cambridge'],
  ['MA', 'Greater Boston', 'Malden', '/dental-offices/ma/malden'],
  ['MA', 'Greater Boston', 'Medford', '/dental-offices/ma/medford'],
  ['MA', 'Greater Boston', 'Norwood', '/dental-offices/ma/norwood'],
  ['MA', 'Greater Boston', 'Somerville', '/dental-offices/ma/somerville'],
  ['MA', 'Greater Boston', 'Stoughton', '/dental-offices/ma/stoughton'],
  ['MA', 'Greater Boston', 'Waltham', '/dental-offices/ma/waltham'],
  ['MA', 'Metrowest', 'Franklin', '/dental-offices/ma/franklin'],
  ['MA', 'Metrowest', 'Hudson', '/dental-offices/ma/hudson'],
  ['MA', 'Metrowest', 'Milford', '/dental-offices/ma/milford'],
  ['MA', 'Metrowest', 'Natick', '/dental-offices/ma/natick'],
  ['MA', 'Merrimack Valley', 'Chelmsford', '/dental-offices/ma/chelmsford'],
  ['MA', 'Merrimack Valley', 'Methuen', '/dental-offices/ma/methuen'],
  ['MA', 'Merrimack Valley', 'North Andover', '/dental-offices/ma/north-andover'],
  ['MA', 'North Shore', 'Beverly', '/dental-offices/ma/beverly'],
  ['MA', 'North Shore', 'Peabody', '/dental-offices/ma/peabody'],
  ['MA', 'North Shore', 'Saugus', '/dental-offices/ma/saugus'],
  ['MA', 'North Shore', 'Wakefield', '/dental-offices/ma/wakefield'],
  ['MA', 'South Coast', 'Attleboro', '/dental-offices/ma/attleboro'],
  ['MA', 'South Coast', 'New Bedford', '/dental-offices/ma/new-bedford'],
  ['MA', 'South Coast', 'Seekonk', '/dental-offices/ma/seekonk'],
  ['MA', 'South Shore', 'Braintree', '/dental-offices/ma/braintree'],
  ['MA', 'South Shore', 'Hanover', '/dental-offices/ma/hanover'],
  ['MA', 'South Shore', 'Quincy', '/dental-offices/ma/quincy'],
  ['MA', 'Worcester', 'Worcester', '/dental-offices/ma/worcester'],
  ['MA', 'Worcester', 'Worcester at The Trolley Yard', '/dental-offices/ma/worcester/worcester-at-the-trolley-yard'],
  ['MA', 'Worcester', 'Worcester - Shrewsbury Street', '/dental-offices/ma/worcester/worcester-shrewsbury-st'],
  ['NH', 'Manchester', 'Manchester', '/dental-offices/nh/manchester'],
  ['NH', 'Manchester', 'Manchester Elm Street', '/dental-offices/nh/manchester/elm-st'],
  ['NH', 'Manchester', 'Manchester South Willow', '/dental-offices/nh/manchester/south-willow'],
  ['NH', 'Nashua', 'Nashua', '/dental-offices/nh/nashua'],
  ['NH', 'Nashua', 'Nashua - Main Street', '/dental-offices/nh/nashua/main-st'],
  ['NH', 'Nashua', 'South Nashua', '/dental-offices/nh/nashua/south-nashua'],
  ['NH', 'All New Hampshire', 'Concord', '/dental-offices/nh/concord/concord-south-main-st'],
  ['NH', 'All New Hampshire', 'Derry', '/dental-offices/nh/derry'],
  ['NH', 'All New Hampshire', 'Dover', '/dental-offices/nh/dover'],
  ['NH', 'All New Hampshire', 'Exeter', '/dental-offices/nh/exeter'],
  ['NH', 'All New Hampshire', 'Keene', '/dental-offices/nh/keene'],
  ['NH', 'All New Hampshire', 'Rochester', '/dental-offices/nh/rochester'],
];

const GD_STATE_NAMES = { MA: 'Massachusetts', NH: 'New Hampshire' };

const GD_LOCATIONS = GD_LOCATION_DEFS.map(([stateAbbr, region, city, pagePath]) => {
  const idSlug = pagePath.replace(/^\/dental-offices\//, '').replace(/\//g, '-');
  return {
    id: `dloc_${idSlug}`,
    client_id: GD_CLIENT_ID,
    location_name: city, // NAP: TODO — confirm exact GBP business name
    city,
    region,
    state: GD_STATE_NAMES[stateAbbr] || stateAbbr,
    state_abbreviation: stateAbbr,
    location_page_url: pagePath,
    // Practice name for this office. Almost all trade as Gentle Dental; the
    // exceptions live in config.dental.brand so compose can apply them to rows
    // that predate this field (re-seeding locations would wipe the NAP data
    // the SEO team enters by hand). Kept here too so a fresh seed carries it.
    brand_name: config.dental.brand.byLocationPageUrl[pagePath] || null,
    // NAP — left EMPTY on purpose (populated manually from GBP/Birdeye later).
    street_address: '',
    zip_code: '',
    phone_number: '',
    hours_by_day: {},
    directions_url: '',
    map_image_url: '',
    hero_image_url: '',
    hero_image_alt: '',
    latitude: '', longitude: '',
    nearby_areas: [],
    verified: true, // eligibility guardrail passes; NAP itself still flagged below
    services_available_ids: GD_ALL_SERVICE_IDS,
    nap_todo: ['street_address', 'phone_number', 'hours_by_day', 'directions_url', 'map_image_url'],
  };
});

// Location fields the SEO team fills in by hand. The seed deliberately ships
// them EMPTY (see nap_todo above), so a blind replaceAll silently destroyed
// that work — which made re-seeding to pick up a service change cost the
// entire NAP effort, and is why this used to be a one-shot bootstrap rather
// than something safe to re-run.
const PRESERVED_LOCATION_FIELDS = [
  'street_address', 'zip_code', 'phone_number', 'hours_by_day', 'directions_url',
  'map_image_url', 'hero_image_url', 'hero_image_alt', 'latitude', 'longitude',
  'nearby_areas', 'gbp_url', 'brand_name',
];

// nap_todo is the opposite case: an EMPTY list is meaningful (it means the
// team finished the NAP), so "preserve only when non-empty" would reset a
// completed checklist back to the full set of TODOs. Preserve it whenever the
// stored row carries the field at all.
const PRESERVED_IF_PRESENT = ['nap_todo'];

function hasValue(v) {
  if (v == null || v === '') return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v).length > 0;
  return true;
}

// Seeded values win for identity and geography (that is the point of
// re-seeding); anything a human populated wins over the seed's blank.
function mergeLocation(seeded, stored) {
  if (!stored) return seeded;
  const merged = { ...seeded };
  for (const field of PRESERVED_LOCATION_FIELDS) {
    if (hasValue(stored[field])) merged[field] = stored[field];
  }
  for (const field of PRESERVED_IF_PRESENT) {
    if (Object.prototype.hasOwnProperty.call(stored, field)) merged[field] = stored[field];
  }
  return merged;
}

// Re-runnable. Services are pure reference data and are replaced outright, so
// a renamed service loses its old row (and any page generated under the old
// slug is orphaned — that is inherent to a rename, not to the seed).
async function seedGentleDental() {
  await store.upsertBy('clients', 'id', GD_CLIENT, 'client');
  await store.upsertBy('globalTemplates', 'id', GD_GLOBAL_TEMPLATE, 'gt');
  await store.replaceAllForClient('services', GD_CLIENT_ID, GD_SERVICES);

  const stored = await store.list('locations', { client_id: GD_CLIENT_ID });
  const storedById = new Map(stored.map(l => [l.id, l]));
  const locations = GD_LOCATIONS.map(l => mergeLocation(l, storedById.get(l.id)));
  await store.replaceAllForClient('locations', GD_CLIENT_ID, locations);

  const napPreserved = locations.filter((l, i) => storedById.has(l.id)
    && PRESERVED_LOCATION_FIELDS.some(f => hasValue(l[f]) && hasValue(storedById.get(l.id)[f]))).length;

  return {
    client_id: GD_CLIENT_ID,
    services: GD_SERVICES.length,
    locations: locations.length,
    locations_with_preserved_data: napPreserved,
  };
}

module.exports = {
  seedNeuroWellness, CLIENT_ID, seedGentleDental, GD_CLIENT_ID,
  mergeLocation, PRESERVED_LOCATION_FIELDS, PRESERVED_IF_PRESENT,
};
