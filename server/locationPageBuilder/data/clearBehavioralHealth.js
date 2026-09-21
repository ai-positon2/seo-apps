// ── Clear Behavioral Health — reference data (L1/L2) ─────────────────────────
// The client's own service taxonomy and location list, as data. Everything the
// template calls a "page input variable" (§1) either lives here or is entered
// by the SEO team on the location record afterwards.
//
// NOTHING IN THIS FILE MAY BE GUESSED. The template's §6 Missing Data Rule and
// §13.17-§13.22 forbid inventing an address, a phone number, a serving area,
// an age range, an insurance acceptance or a service availability — and a
// plausible-looking placeholder in a seed file is exactly how an invented fact
// reaches a published page. So the service and location names below come from
// the client's own site structure, and every field they did not supply (street
// address, phone, hours, serving areas, ages served, the location's own page
// URL) is left EMPTY and flagged on the page via `nap_todo`.
//
// Re-running the seed is safe: services are replaced wholesale, and any
// location field entered by hand wins over this file's blank (see lsSeed).

const CLIENT_ID = 'client_clear_behavioral_health';
const BASE_URL = 'https://www.clearbehavioralhealth.com';

const CLIENT = {
  id: CLIENT_ID,
  name: 'Clear Behavioral Health',
  brand_static: {
    base_url: BASE_URL,
    org_schema: { '@type': 'Organization', name: 'Clear Behavioral Health', url: BASE_URL },
    // Left empty rather than guessed: a wrong logo or social profile in schema
    // is a factual error about the client.
    logo: '',
    sameAs: [],
    stats: {},
  },
  brand_rules: {
    // Behavioral health is YMYL: accuracy outranks persuasion everywhere the
    // two conflict, and the writer prompt says so (see lsWriter.systemPrompt).
    ymyl: true,
    // Phrases that must never appear, whatever the context. These are
    // PROHIBITIONS, not claims about the client.
    prohibited_claims: [
      'guaranteed cure', 'guaranteed results', 'cure depression', 'permanent cure',
      '100% effective', 'no side effects', 'miracle', 'instant results',
      'fully recovered', 'lifetime cure', 'guaranteed sobriety',
    ],
    licensing_language: 'All care is provided by licensed clinicians. Credentials are pulled from the provider record only.',
  },
  global_template_id: 'gt_clear_behavioral_location_service',
};

const GLOBAL_TEMPLATE = {
  id: 'gt_clear_behavioral_location_service',
  client_id: CLIENT_ID,
  page_type: 'ls_location_service',
  // The order the template's §15 brief presents, which is also the order the
  // page renders in.
  section_order: ['seo', 'hero', 'locationInfo', 'body', 'faq', 'schema'],
  section_layouts: {},
  seo_head_structure: {
    // §3 and §5 recommended structures. These are FALLBACKS, not patterns the
    // page is locked to: both must carry the primary keyword or a close
    // natural variant, which is a judgement the writer makes per page.
    meta_title_pattern: '[Service] in [Location] | [Brand]',
    h1_pattern: '[Service] in [Location]',
  },
  schema_skeletons: { business_type: 'MedicalBusiness' },
};

const STATE_NAMES = { CA: 'California' };

// ── Services ────────────────────────────────────────────────────────────────
// Three kinds of page live in this list, and they all run through the same
// generator, exactly as the template intends (§0: "the same framework must work
// across services, conditions, treatments, locations and brands"):
//   - PROGRAMS      a level of care ("Residential Mental Health Treatment")
//   - CONDITIONS    what the client says they treat ("Depression")
//   - THERAPIES     a modality offered alongside a programme ("Family Therapy")
//
// `category` picks the fallback section ladder (lsLadder.pickLadder), so it is
// not decoration: a programme gets "Who is it for / what happens / how long",
// a condition gets "Symptoms / causes / types / treatment options". Getting it
// wrong asks the wrong questions about the page.
//
// The slug is the URL segment (§2) AND the service id, so renaming one orphans
// any page already generated under the old slug.
//
// Format: [name, slug, category, [conditions treated]]

// Adult mental health — levels of care.
const RESIDENTIAL_MH = [
  ['Residential Mental Health Treatment', 'residential-mental-health-treatment', 'program'],
];
const OUTPATIENT_MH = [
  ['Partial Hospitalization Program (PHP)', 'partial-hospitalization-program', 'program'],
  ['Outpatient Mental Health Treatment (IOP)', 'outpatient-mental-health-treatment', 'program'],
  ['Legal Diversion Program', 'legal-diversion-program', 'program'],
  ['Labor Union Support', 'labor-union-support', 'program'],
];

// Addiction — levels of care, split by where they are actually delivered.
const RESIDENTIAL_ADDICTION = [
  ['Inpatient Alcohol and Drug Detox Program', 'inpatient-alcohol-and-drug-detox', 'program'],
  ['Inpatient Addiction Treatment', 'inpatient-addiction-treatment', 'program'],
];
const OUTPATIENT_ADDICTION = [
  ['Outpatient Addiction Treatment (IOP & PHP)', 'outpatient-addiction-treatment', 'program'],
];
// Offered at both addiction levels of care, so it belongs to neither group.
const DUAL_DIAGNOSIS = [
  ['Dual Diagnosis Addiction Treatment', 'dual-diagnosis-addiction-treatment', 'program'],
];

const TELEHEALTH = [
  ['Virtual Intensive Outpatient Program (IOP)', 'virtual-intensive-outpatient-program', 'program'],
  ['Evening Online Mental Health Treatment', 'evening-online-mental-health-treatment', 'program'],
];

const TEEN_PROGRAMS = [
  ['Teen IOP Treatment', 'teen-iop-treatment', 'program'],
  ['Parent Support Groups', 'parent-support-groups', 'therapy'],
  ['Family Therapy', 'family-therapy', 'therapy'],
];

// Adult mental health conditions. The name IS the condition, so the ladder's
// {{CONDITION}} rungs resolve to it directly ("Symptoms of Depression").
const MH_CONDITIONS = [
  ['Depression', 'depression', 'condition', ['Depression']],
  ['Anxiety', 'anxiety', 'condition', ['Anxiety']],
  ['Stress', 'stress', 'condition', ['Stress']],
  ['ADHD', 'adhd', 'condition', ['ADHD']],
  ['Anger Management', 'anger-management', 'condition', ['Anger']],
  ['Burnout', 'burnout', 'condition', ['Burnout']],
  ['Bipolar I & II', 'bipolar-i-and-ii', 'condition', ['Bipolar Disorder']],
  ['Grief Disorder', 'grief-disorder', 'condition', ['Grief']],
  ['Obsessive Compulsive Disorder (OCD)', 'obsessive-compulsive-disorder', 'condition', ['OCD']],
  ['Personality Disorder', 'personality-disorder', 'condition', ['Personality Disorder']],
  ['Post-Traumatic Stress Disorder (PTSD)', 'post-traumatic-stress-disorder', 'condition', ['PTSD']],
  ['Psychosis', 'psychosis', 'condition', ['Psychosis']],
];

// Adult addictions.
const ADDICTION_CONDITIONS = [
  ['Alcohol Addiction', 'alcohol-addiction', 'condition', ['Alcohol Addiction']],
  ['Marijuana Addiction', 'marijuana-addiction', 'condition', ['Marijuana Addiction']],
  ['Prescription Drug Addiction', 'prescription-drug-addiction', 'condition', ['Prescription Drug Addiction']],
  ['Suboxone Addiction', 'suboxone-addiction', 'condition', ['Suboxone Addiction']],
  ['Opioid Addiction', 'opioid-addiction', 'condition', ['Opioid Addiction']],
  ['Stimulant Addiction', 'stimulant-addiction', 'condition', ['Stimulant Addiction']],
  ['Benzodiazepine Addiction', 'benzodiazepine-addiction', 'condition', ['Benzodiazepine Addiction']],
];

// Teen conditions are their own pages, not the adult ones with a filter: a
// teen depression page answers different questions (school, parents, what
// treatment looks like around a school day) and targets different searches.
// Named "Teen X" so the H1, title and every ladder rung read correctly.
const TEEN_CONDITIONS = [
  ['Teen Depression', 'teen-depression', 'condition', ['Teen Depression']],
  ['Teen Anxiety', 'teen-anxiety', 'condition', ['Teen Anxiety']],
  ['Teen ADHD', 'teen-adhd', 'condition', ['Teen ADHD']],
  ['Teen Burnout', 'teen-burnout', 'condition', ['Teen Burnout']],
  ['Teen Stress', 'teen-stress', 'condition', ['Teen Stress']],
  ['Teen Bipolar Disorder', 'teen-bipolar-disorder', 'condition', ['Teen Bipolar Disorder']],
  ['Teen PTSD', 'teen-ptsd', 'condition', ['Teen PTSD']],
  ['Teen School Issues', 'teen-school-issues', 'condition', ['School Refusal', 'School Avoidance']],
  ['Teen Failure to Launch', 'teen-failure-to-launch', 'condition', ['Failure to Launch']],
  ['Teen OCD', 'teen-ocd', 'condition', ['Teen OCD']],
  ['Teen Anger Management', 'teen-anger-management', 'condition', ['Teen Anger']],
  ['Teen Autism', 'teen-autism', 'condition', ['Autism']],
];

const SERVICE_DEFS = [
  ...RESIDENTIAL_MH, ...OUTPATIENT_MH,
  ...RESIDENTIAL_ADDICTION, ...OUTPATIENT_ADDICTION, ...DUAL_DIAGNOSIS,
  ...TELEHEALTH,
  ...TEEN_PROGRAMS,
  ...MH_CONDITIONS, ...ADDICTION_CONDITIONS, ...TEEN_CONDITIONS,
];

// ── Locations ───────────────────────────────────────────────────────────────
// ONE ROW PER CITY. The client's navigation lists a city once per programme it
// runs there — Redondo Beach appears under outpatient addiction, residential
// addiction, outpatient mental health and teen — but those are four listings of
// one city, not four locations. A page's subject is "{service} in {city}", so a
// row per city is what keeps one page per service per city and one address to
// maintain. "Los Angeles - Mid Wilshire" is the Los Angeles outpatient site and
// merges into Los Angeles for the same reason.
//
// `region` is geography, and it earns its place twice: the wizard groups the
// location picker by it, and internal links prefer siblings in the same region
// so a page's cluster is geographically coherent rather than arbitrary
// (internalLinks.buildLsLinks). It is also exempt from the rival-city keyword
// filter, so a page may legitimately reach for "South Bay" terms.
//
// Every location offers the full catalogue: the client confirmed that services
// and conditions are not location-scoped. `serviceSlugs` is therefore omitted,
// which lsSeed reads as "all of them". (The mechanism stays for clients whose
// availability IS scoped -- see lsSeed.resolveServiceIds.)
//
// Format:
//   [locationName, city, stateAbbr, { region, ...optional NAP }]
//
// NAP is deliberately absent: the client's site structure gives the locations,
// not their addresses, phone numbers, hours, serving areas or ages served.
// Every one of those is flagged on the page until the SEO team enters it.
const LOCATION_DEFS = [
  // Telehealth. Not a building, so there is no address to chase -- but it is a
  // real "location" for these pages, because a virtual IOP page is genuinely
  // about the whole state rather than about a city.
  ['Virtual California Statewide', 'California', 'CA', { region: 'Telehealth' }],

  // South Bay. "South Bay" is listed by the client as a location in its own
  // right as well as being the region these cities sit in; both are kept,
  // because dropping the client's own listing would lose a page they expect.
  ['South Bay', 'South Bay', 'CA', { region: 'South Bay' }],
  ['Redondo Beach', 'Redondo Beach', 'CA', { region: 'South Bay' }],
  ['Gardena', 'Gardena', 'CA', { region: 'South Bay' }],
  ['Torrance', 'Torrance', 'CA', { region: 'South Bay' }],
  ['Manhattan Beach', 'Manhattan Beach', 'CA', { region: 'South Bay' }],
  ['El Segundo', 'El Segundo', 'CA', { region: 'South Bay' }],

  // Los Angeles. The client's residential site is listed as "Los Angeles" and
  // its outpatient site as "Los Angeles - Mid Wilshire"; Mid Wilshire is a
  // neighbourhood of the same city, so they are one row.
  ['Los Angeles', 'Los Angeles', 'CA', { region: 'Los Angeles' }],

  // San Gabriel Valley.
  ['Pasadena', 'Pasadena', 'CA', { region: 'San Gabriel Valley' }],
  ['El Monte', 'El Monte', 'CA', { region: 'San Gabriel Valley' }],

  // San Fernando Valley and the Santa Clarita Valley.
  ['Van Nuys', 'Van Nuys', 'CA', { region: 'San Fernando Valley' }],
  ['Santa Clarita', 'Santa Clarita', 'CA', { region: 'Santa Clarita Valley' }],

  // Orange County.
  ['Anaheim Hills', 'Anaheim Hills', 'CA', { region: 'Orange County' }],
];

module.exports = {
  CLIENT_ID, BASE_URL, CLIENT, GLOBAL_TEMPLATE, STATE_NAMES,
  SERVICE_DEFS, LOCATION_DEFS,
  // The grouped service lists, exported so a future change of mind about
  // location-scoped availability has the groups already drawn.
  RESIDENTIAL_MH, OUTPATIENT_MH, RESIDENTIAL_ADDICTION, OUTPATIENT_ADDICTION,
  DUAL_DIAGNOSIS, TELEHEALTH, TEEN_PROGRAMS,
  MH_CONDITIONS, ADDICTION_CONDITIONS, TEEN_CONDITIONS,
};
