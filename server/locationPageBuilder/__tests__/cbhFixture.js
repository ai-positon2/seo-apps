// A CBH page written to the client's guidelines, used as the baseline for the
// QC tests. Its job is to prove the gates are SATISFIABLE -- a contract whose
// own limits cannot all be met at once is the failure mode the dental config
// warns about, and the only way to catch it is a hand-written page that obeys
// every rule and is then run through every gate.
//
// Tests mutate a clone of this to prove each gate bites.

const contract = require('../cbhContract');

// The DISPLAY PHRASE, as cbhCompose builds it: lower case apart from
// acronyms, because it goes straight into prose headings ("Our approach to
// anxiety treatment"). Title-casing it here made the fixture disagree with
// every page the pipeline actually produces.
const SERVICE = 'anxiety treatment';
const CITY = 'Anaheim Hills';
// The RAW service name, as the service record holds it. SERVICE above is the
// display phrase built from it.
const CONDITION = 'Anxiety';
const PRIMARY = 'anxiety treatment in anaheim hills';

function passingL3() {
  return {
    metaTitle: 'Anxiety Treatment in Anaheim Hills for Lasting Relief',
    metaDescription: 'Find evidence-based anxiety treatment in Anaheim Hills with licensed '
      + 'clinicians who tailor care to your needs and pace. Schedule a consultation today.',
    hero: {
      h1: 'Compassionate Anxiety Treatment in Anaheim Hills',
      description: 'Work with licensed clinicians on anxiety treatment in Anaheim Hills that builds '
        + 'practical coping skills and steady progress. Get support today.',
    },
    approach: {
      paragraphs: ['We start by understanding what anxiety looks like in your daily life, then match '
        + 'you to the level of care that fits rather than the one that is simply available.'],
      philosophy: ['Care here is paced to you. Sessions are collaborative, judgement-free, and built '
        + 'around goals you set with your clinician.'],
      // Medication is Neuro Wellness Spa's, never CBH's: the client's feedback
      // rule no-cbh-medication fails a page that implies otherwise.
      therapies: ['Our clinicians draw on CBT, DBT skills work and exposure-based approaches. Medication '
        + 'management is available through our partner provider, Neuro Wellness Spa.'],
    },
    insurance: 'Clear Behavioral Health accepts most major insurance providers, making anxiety '
      + 'treatment accessible for clients across Anaheim Hills.',
    educational: {
      paragraphs: ['Anxiety treatment is structured clinical care for persistent worry, panic and '
        + 'avoidance that interferes with daily life. It combines talk therapy, skills practice and '
        + 'steady support between sessions.'],
      // Paragraphs AND bullets, because the guidelines want both and a section
      // of one-sentence entries is what the client rejected. A fixture written
      // the way the page must not be written cannot prove the gates work.
      h3s: [
        { heading: 'Signs you may need support', lines: [
          'Anxiety becomes a clinical concern when worry stops responding to reassurance and starts '
            + 'shaping what you will and will not do. It usually shows up first in sleep, in '
            + 'concentration, and in the plans you quietly stop making.',
          '- Worry that is hard to control most days',
          '- Avoiding work, school or social plans',
          '- Sleep, appetite or concentration changes'] },
        { heading: 'Treatment options available', lines: [
          'Care is matched to how much support you need rather than to one preferred method. Most '
            + 'plans pair talk therapy with skills practice, and add group work where it helps '
            + 'most.',
          '- Individual therapy using CBT and DBT skills',
          '- Group sessions for shared skills practice'] },
        { heading: 'What to expect at your first visit', lines: [
          'The first session is an assessment rather than treatment. A clinician asks about symptoms, '
            + 'history and what you want to change, and you leave with a plan agreed with you rather '
            + 'than handed to you.'] },
        { heading: 'How to get started', lines: [
          'Call the Anaheim Hills office or request an appointment online. Benefits are verified '
            + 'before your first session, so what you will pay is clear in advance.'] },
      ],
    },
    uvp: 'Choosing Clear Behavioral Health for anxiety treatment in Anaheim Hills means licensed '
      + 'clinicians, care paced to you, and practical skills you can use between sessions.',
    service: 'Anxiety treatment in Anaheim Hills, delivered in person and online by licensed clinicians.',
    treatment: {
      heading: 'Our anxiety treatment experts in Anaheim Hills',
      paragraph: 'Our clinicians are experienced and compassionate, and they treat anxiety with the care '
        + 'and patience it asks for. You are met where you are, and the work moves at a pace you set.',
    },
    faqs: [
      { q: 'How soon can I be seen in Anaheim Hills?', type: 'location',
        a: 'Most new clients are offered an initial appointment within a week. Call and we will tell '
          + 'you the next opening at the Anaheim Hills office.' },
      { q: 'Does Clear Behavioral Health take my insurance?', type: 'brand',
        a: 'We accept most major insurance providers and verify your benefits before your first '
          + 'session so there are no surprises.' },
      { q: 'How long does anxiety treatment take?', type: 'intent',
        a: 'It depends on your goals and the level of care. Many people notice change within a few '
          + 'months of consistent work.' },
      { q: 'Is treatment available outside work hours?', type: 'location',
        a: 'Evening appointments are offered at this location, subject to clinician availability.' },
      { q: 'What happens if I need more support?', type: 'intent',
        a: 'Your clinician can step you up to a more intensive outpatient program without starting '
          + 'over with a new team.' },
    ],
  };
}

// The provenance the pipeline would have stamped: three sections modelled on
// competitor coverage, one filled from an authoritative source.
function passingProvenance() {
  return [
    { source: contract.PROVENANCE.COMPETITOR },
    { source: contract.PROVENANCE.COMPETITOR },
    { source: contract.PROVENANCE.FALLBACK, sourceUrl: 'https://www.nimh.nih.gov/health/topics/anxiety-disorders' },
    { source: contract.PROVENANCE.COMPETITOR },
  ];
}

// A bare scaffold with the fixed headings filled, without touching the store.
function scaffold() {
  return {
    meta: {
      client_id: 'client_clear_behavioral_health', urlPath: '/locations/anaheim-hills/anxiety',
      brandName: contract.BRAND, title: '', fullTitle: '', metaDescription: '',
    },
    serviceName: SERVICE,
    conditionName: CONDITION,
    locationName: CITY,
    primaryKeyword: PRIMARY,
    primaryKeywords: [PRIMARY],
    secondaryKeywords: [],
    sections: {
      hero: { h1: '', description: '', ctaLabel: 'Schedule a consultation', ctaUrl: '' },
      approach: {
        heading: contract.approachHeading('anxiety treatment'),
        paragraphs: [],
        philosophy: { heading: contract.FIXED_HEADINGS.approachPhilosophy, paragraphs: [] },
        therapies: { heading: contract.FIXED_HEADINGS.approachTherapies, paragraphs: [] },
      },
      insurance: { heading: contract.FIXED_HEADINGS.insurance, paragraph: '' },
      educational: {
        heading: contract.educationalHeading(CONDITION),
        paragraphs: [], source: null, sourceUrl: '', h3s: [],
      },
      uvp: { heading: contract.FIXED_HEADINGS.uvp, paragraph: '' },
      service: { heading: contract.serviceHeading(SERVICE, CITY), paragraph: '' },
      // Blank heading: this is the one H2 the writer composes.
      treatment: { heading: '', paragraph: '' },
      faq: { heading: 'Frequently Asked Questions', items: [] },
    },
    schema: {}, qc: null,
  };
}

module.exports = { passingL3, passingProvenance, scaffold, SERVICE, CONDITION, CITY, PRIMARY };
