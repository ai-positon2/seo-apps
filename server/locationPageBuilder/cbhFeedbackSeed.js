// ── Clear Behavioral Health: the first two feedback batches, as rules ───────
// The client reviewed the first Anaheim Hills pages (Anxiety, ADHD, Depression,
// Burnout, Stress) and then sent a second note on program scope (Psychosis,
// Family Therapy, Parent Support Groups). Both are kept here VERBATIM as the
// record, with the rules written from them by hand.
//
// Data, not code, so the tests can prove every rule bites on a bad page and
// stays quiet on a good one. server/scripts/seedCbhFeedback.js upserts these
// into lpb_feedbackbatches / lpb_feedbackrules keyed by `key`, so re-running it
// is safe. Later batches arrive through the Feedback Rules screen instead.
//
// Two items in batch 2 are not rules at all and were done in code: Psychosis is
// now offered only at mental-health residential locations (seed.js), and the
// CBH routes refuse a service a location does not offer (cbhCompose.cbhEligibility).

const CBH_CLIENT_ID = 'client_clear_behavioral_health';

const BATCHES = [
  {
    key: 'cbh-2026-10-page-review',
    client_id: CBH_CLIENT_ID,
    title: 'Page review: Anxiety, ADHD, Depression, Burnout, Stress',
    received_at: '2026-10-09',
    raw_text: `Anxiety Treatment Pages
In the "What is Anxiety?" section, review the reference to the cited study and determine whether it should be explicitly called out or revised.
ADHD Treatment Page
The FAQ references medication management in a way that implies CBH provides the service. Please revise to accurately reflect services provided, including references to Neuro Wellness Spa (which provided medication) where appropriate.
In the FAQ, "Southern California location" does not appear to be the most accurate phrasing and should be updated.
Depression Treatment Page
The Clinical Therapies section references TMS and ketamine treatment. TMS is a Neuro Wellness Spa service and not provided in CBH, and neither CBH nor NWS currently provides ketamine treatment. Please revise accordingly.
In the FAQ, the response that states clients can seamlessly transition between in-person and telehealth services is not accurate and should be removed. Let’s not ask this question.

Burnout Treatment Page
In the "Common Causes of Burnout" section, the sentence beginning with "In Anaheim Hills, burnout..." reads awkwardly and should be avoided.
In the insurance FAQ, rather than instructing prospective clients to verify benefits with their insurer, please indicate that our team can assist with benefit verification.
Stress Relief Programs Page
In the "Our Philosophy of Compassionate Care" section, revise the opening language. Suggested wording:
"We treat stress as a signal, not a flaw. It's the body and mind telling you something needs attention."
Remove references to biofeedback-informed relaxation training, as this is not a service we offer.
In the "Signs and Symptoms of Stress" section, much of the content appears focused on symptoms requiring immediate medical attention rather than indicators for seeking mental health treatment. Please revise accordingly.
The sections "When Stress Becomes a Concern" and "Common Causes and Triggers of Stress" appear to focus more on anxiety than stress and should be updated for better alignment.

All Pages:
The FAQ references medication management in a way that implies CBH provides the service. Please revise to accurately reflect services provided, including references to Neuro Wellness Spa (which provided medication) where appropriate.
In the FAQ, "Southern California location" does not appear to be the most accurate phrasing and should be updated.
The Clinical Therapies section references TMS and ketamine treatment. TMS is a Neuro Wellness Spa service and not provided in CBH, and neither CBH nor NWS currently provides ketamine treatment. Please revise accordingly.
In the FAQ, the response that states clients can seamlessly transition between in-person and telehealth services is not accurate and should be removed. Let’s not ask this question.
In the insurance FAQ, rather than instructing prospective clients to verify benefits with their insurer, please indicate that our team can assist with benefit verification.`,
    action_items: [],
  },
  {
    key: 'cbh-2026-10-program-scope',
    client_id: CBH_CLIENT_ID,
    title: 'Program scope: Psychosis, Family Therapy, Parent Support Groups',
    received_at: '2026-10-09',
    raw_text: `Psychosis
When it comes to psychosis, the content would need to be reworked to support our mental health residential locations and programs. We can accept someone with minor psychosis symptoms or after they have stabilized in a hospital setting. This distinction needs to be clear, though, and if we build them out, they should only be attached to our mental health residential locations.

The family therapy and parent support group pages are very similar, but the content would need to be reworked to support our teen mental health locations and programs. These services are part of the Teen IOP program and are included as part of the treatment plan.

Family therapy is facilitated with the teen in our program and the parent(s). This is a core part of the teen program where family units work on communication skills, boundaries, and constructive ways to support each other. It is included as part of the teen's treatment plan, and we are not billing the insurance of the parents.

Parent support groups are offered for parents of the teens in our programs as a component of our multi-modal family groups. These are groups that are held once a week where the parents come and join a group session with their teen, as well as other teens in the program and their parents.

After a group discussion, the parents and teens are split up to join separate groups where they talk about what was said in the group discussion or do their own exercise. There can be a specific topic or exercise that is facilitated on a group level and then another topic, discussion, or exercise in the separate teen/parent groups. These services are included as part of the treatment plan for the teens, so we are not billing insurance for the parents as well. Topics/exercises can include communication, boundaries, and process groups.`,
    action_items: [
      {
        text: 'Offer Psychosis pages only at mental-health residential locations (service/location availability change).',
        status: 'done',
        note: 'seed.js: Psychosis groups set to mh-residential only; brief and generate now refuse a service the location does not offer.',
      },
    ],
  },
];

const ALL_STAGES = ['brief', 'writer', 'regen'];
const PAGE_STAGES = ['writer', 'regen'];

// Every rule: { key, batch_key, status, title, quote, kind, severity, scope,
// stages, instruction, checks }. See cbhFeedback.js for what each field means
// and how a check runs. Patterns are case-insensitive unless `flags` says
// otherwise, and may use {city} {service} {condition} {brand}.
const RULES = [
  {
    key: 'no-cbh-medication',
    batch_key: 'cbh-2026-10-page-review',
    title: 'CBH does not provide medication; Neuro Wellness Spa does',
    quote: 'The FAQ references medication management in a way that implies CBH provides the service. Please revise to accurately reflect services provided, including references to Neuro Wellness Spa (which provided medication) where appropriate.',
    kind: 'constraint',
    severity: 'Critical',
    scope: { services: ['*'], programGroups: [], sections: [] },
    stages: ALL_STAGES,
    instruction: 'Clear Behavioral Health does not prescribe or manage medication. Never say or imply that it offers '
      + 'medication management, prescribing or psychiatric medication, and do not plan or answer an FAQ that implies it. '
      + 'Where medication is relevant to the reader, say that medication management is available through our partner '
      + 'provider, Neuro Wellness Spa.',
    checks: [
      {
        type: 'require', unit: 'sentence',
        when: '\\b(medications?|prescri\\w*|psychiatric\\s+med\\w*)\\b',
        pattern: 'Neuro Wellness Spa',
        // The educational section describes the CONDITION, and "it is often
        // treated with therapy and medication" is a fact about the condition
        // rather than a claim about CBH. The reviewer judges those.
        exceptSections: ['educational'],
        message: 'Mentions medication without making clear it is provided by Neuro Wellness Spa',
      },
      {
        type: 'review',
        question: 'Does the page avoid saying or implying that Clear Behavioral Health itself prescribes or manages '
          + 'medication? Saying medication management is available through the partner provider Neuro Wellness Spa is '
          + 'compliant, and so is describing medication as one way the condition can be treated without implying CBH provides it.',
      },
    ],
  },
  {
    key: 'no-tms-ketamine',
    batch_key: 'cbh-2026-10-page-review',
    title: 'No TMS or ketamine as CBH care',
    quote: 'The Clinical Therapies section references TMS and ketamine treatment. TMS is a Neuro Wellness Spa service and not provided in CBH, and neither CBH nor NWS currently provides ketamine treatment. Please revise accordingly.',
    kind: 'constraint',
    severity: 'Critical',
    scope: { services: ['*'], programGroups: [], sections: [] },
    stages: ALL_STAGES,
    instruction: 'Never mention ketamine, esketamine or Spravato: neither Clear Behavioral Health nor Neuro Wellness Spa '
      + 'provides them. Never list TMS (transcranial magnetic stimulation) among the clinical therapies Clear Behavioral '
      + 'Health offers. TMS may be mentioned only as a service of our partner provider, Neuro Wellness Spa, and only where '
      + 'it is genuinely relevant.',
    checks: [
      {
        type: 'forbid', unit: 'field',
        pattern: '\\b(ketamine|esketamine|spravato)\\b',
        message: 'Mentions ketamine, which neither CBH nor Neuro Wellness Spa provides',
      },
      {
        type: 'forbid', unit: 'field', sections: ['approach.therapies'],
        pattern: '\\b(TMS|transcranial\\s+magnetic)\\b',
        message: 'Lists TMS among the clinical therapies CBH offers',
      },
      {
        type: 'require', unit: 'sentence',
        when: '\\b(TMS|transcranial\\s+magnetic)\\b',
        pattern: 'Neuro Wellness Spa',
        message: 'Mentions TMS without attributing it to Neuro Wellness Spa',
      },
    ],
  },
  {
    key: 'no-southern-california-location',
    batch_key: 'cbh-2026-10-page-review',
    title: 'Name the location by its city, not "Southern California"',
    quote: 'In the FAQ, "Southern California location" does not appear to be the most accurate phrasing and should be updated.',
    kind: 'constraint',
    severity: 'Major',
    scope: { services: ['*'], programGroups: [], sections: [] },
    stages: PAGE_STAGES,
    instruction: 'Never call this location a "Southern California location" (or office, facility or center). Refer to it '
      + 'by its city: "our {city} location".',
    checks: [
      {
        type: 'forbid', unit: 'field',
        pattern: '\\b(our|the|this|a)\\s+southern\\s+california\\b|\\bsouthern\\s+california\\s+'
          + '(locations?|offices?|facilit(y|ies)|cent(er|re)s?|teams?|clinics?|sites?|campus(es)?)\\b',
        message: 'Calls the location a "Southern California" location instead of naming {city}',
      },
    ],
  },
  {
    key: 'no-telehealth-switching',
    batch_key: 'cbh-2026-10-page-review',
    title: 'No question or claim about switching between in-person and telehealth',
    quote: 'In the FAQ, the response that states clients can seamlessly transition between in-person and telehealth services is not accurate and should be removed. Let’s not ask this question.',
    kind: 'constraint',
    severity: 'Critical',
    scope: { services: ['*'], programGroups: [], sections: [] },
    stages: ALL_STAGES,
    instruction: 'Do not ask or answer whether clients can switch, transition or move between in-person and telehealth '
      + '(virtual or online) care, and never claim they can move between them seamlessly. Do not plan an FAQ on it.',
    checks: [
      {
        type: 'forbid', unit: 'sentence',
        when: '\\b(telehealth|tele-health|virtual|online|in[- ]person)\\b',
        pattern: '\\b(switch\\w*|transition\\w*|mov(e|es|ing)\\s+between|back\\s+and\\s+forth|alternat\\w*|seamless\\w*)\\b',
        message: 'Suggests clients can switch between in-person and telehealth care',
      },
    ],
  },
  {
    key: 'insurance-team-verifies',
    batch_key: 'cbh-2026-10-page-review',
    title: 'Our team verifies benefits; never send readers to their insurer',
    quote: 'In the insurance FAQ, rather than instructing prospective clients to verify benefits with their insurer, please indicate that our team can assist with benefit verification.',
    kind: 'constraint',
    severity: 'Major',
    scope: { services: ['*'], programGroups: [], sections: [] },
    stages: ALL_STAGES,
    instruction: 'Never tell readers to check, verify or confirm their benefits with their insurer or insurance '
      + 'provider. Say instead that our team can help verify their benefits. Every FAQ answer about insurance or '
      + 'coverage must say our team can help with benefit verification.',
    checks: [
      {
        type: 'forbid', unit: 'field',
        pattern: '\\b(check|verify|confirm)\\w*\\s+with\\s+(your|their)\\s+(insurer|insurance|carrier|health\\s+plan|plan)\\b'
          + '|\\b(contact|call|ask)\\s+(your|their)\\s+(insurer|insurance\\s+(provider|company|carrier)|carrier|health\\s+plan)\\b',
        message: 'Tells readers to check their benefits with their insurer instead of offering our team\'s help',
      },
      {
        type: 'require', unit: 'faq',
        when: '\\b(insurance|insured|coverage|covered|benefits?)\\b',
        pattern: '\\b(our\\s+team|we|our\\s+staff|our\\s+admissions\\s+team)\\b[^.?!]{0,80}\\bverif\\w*',
        message: 'The insurance answer does not say our team can help verify benefits',
      },
    ],
  },
  {
    key: 'no-city-first-condition',
    batch_key: 'cbh-2026-10-page-review',
    title: 'Educational copy is not framed around the city',
    quote: 'In the "Common Causes of Burnout" section, the sentence beginning with "In Anaheim Hills, burnout..." reads awkwardly and should be avoided.',
    kind: 'constraint',
    severity: 'Major',
    scope: { services: ['*'], programGroups: [], sections: [] },
    stages: PAGE_STAGES,
    instruction: 'The educational section describes {condition} in general terms. Do not open a sentence with the city '
      + '("In {city}, ...") and do not tie the condition\'s causes or prevalence to {city}. The location belongs in '
      + 'the hero, service, Why Choose and treatment sections.',
    checks: [
      {
        type: 'forbid', unit: 'field', sections: ['educational'],
        pattern: '(^|[.!?]\\s+)(in|across|throughout|around|among|for\\s+people\\s+in)\\s+{city}\\b',
        message: 'Opens an educational sentence with the city',
      },
    ],
  },
  {
    key: 'no-studies-or-statistics',
    batch_key: 'cbh-2026-10-page-review',
    title: 'No studies, research findings or statistics',
    quote: 'In the "What is Anxiety?" section, review the reference to the cited study and determine whether it should be explicitly called out or revised.',
    kind: 'constraint',
    severity: 'Major',
    scope: { services: ['*'], programGroups: [], sections: [] },
    stages: ALL_STAGES,
    instruction: 'Do not cite studies, surveys, research findings or statistics (percentages, "1 in 5", millions), and do '
      + 'not write "according to". Describe the condition in general clinical terms. Where a section is written from a '
      + 'source, use what it says but leave out its figures and its references to research.',
    checks: [
      {
        type: 'forbid', unit: 'field',
        pattern: '\\b(a|one|recent|new|large|several|many|multiple)\\s+(stud(y|ies)|surveys?|trials?)\\b'
          + '|\\bstudies\\s+(show|suggest|have\\s+shown|find|found|indicate)\\b'
          + '|\\bresearch(ers)?\\s+(shows?|suggests?|found|finds?|indicates?|has\\s+shown|have\\s+found)\\b'
          + '|\\baccording\\s+to\\b|\\bpublished\\s+in\\b|\\bclinical\\s+trials?\\b',
        message: 'Cites a study, survey or research finding',
      },
      {
        type: 'forbid', unit: 'field',
        pattern: '\\b\\d+(\\.\\d+)?\\s?(%|percent\\b)|\\b\\d+\\s+(in|out\\s+of)\\s+\\d+\\b|\\b(millions?|billions?)\\s+of\\b|\\bstatistic(s|al|ally)?\\b',
        message: 'States a statistic',
      },
    ],
  },
  {
    key: 'no-biofeedback',
    batch_key: 'cbh-2026-10-page-review',
    title: 'Biofeedback is not offered',
    quote: 'Remove references to biofeedback-informed relaxation training, as this is not a service we offer.',
    kind: 'constraint',
    severity: 'Critical',
    scope: { services: ['*'], programGroups: [], sections: [] },
    stages: ALL_STAGES,
    instruction: 'Never mention biofeedback or biofeedback-informed relaxation training. Clear Behavioral Health does not offer it.',
    checks: [
      { type: 'forbid', unit: 'field', pattern: '\\bbio-?feedback\\b', message: 'Mentions biofeedback, which CBH does not offer' },
    ],
  },
  {
    key: 'stress-philosophy-opening',
    batch_key: 'cbh-2026-10-page-review',
    title: 'Stress pages open the philosophy section with the client\'s line',
    quote: 'In the "Our Philosophy of Compassionate Care" section, revise the opening language. Suggested wording: "We treat stress as a signal, not a flaw. It\'s the body and mind telling you something needs attention."',
    kind: 'constraint',
    severity: 'Major',
    scope: { services: ['cbh_stress', 'cbh_teen-stress'], programGroups: [], sections: ['approach.philosophy'] },
    stages: PAGE_STAGES,
    instruction: 'Open the body under "Our philosophy of compassionate care" with exactly these two sentences: "We treat '
      + 'stress as a signal, not a flaw. It\'s the body and mind telling you something needs attention." Then continue '
      + 'in your own words.',
    checks: [
      {
        type: 'require', unit: 'field',
        pattern: '^\\s*We treat stress as a signal, not a flaw\\.\\s+It[\'’]s the body and mind telling you something needs attention\\.',
        message: 'The philosophy section does not open with the client\'s wording',
      },
    ],
  },
  {
    key: 'symptoms-are-mh-indicators',
    batch_key: 'cbh-2026-10-page-review',
    title: 'Symptoms read as reasons to seek mental health care, not medical emergencies',
    quote: 'In the "Signs and Symptoms of Stress" section, much of the content appears focused on symptoms requiring immediate medical attention rather than indicators for seeking mental health treatment. Please revise accordingly.',
    kind: 'constraint',
    severity: 'Major',
    scope: { services: ['*'], programGroups: [], sections: ['educational'] },
    stages: ALL_STAGES,
    instruction: 'In any signs or symptoms subsection, describe the indicators that someone may benefit from mental health '
      + 'treatment: changes in mood, sleep, concentration, energy, irritability, withdrawal or coping. Do not centre it on '
      + 'physical symptoms that need urgent medical attention (chest pain, fainting, difficulty breathing). Where a '
      + 'physical sign is part of {condition}, describe it as part of the condition, not as an emergency.',
    checks: [
      {
        type: 'review',
        question: 'Do the signs and symptoms subsections focus on indicators that a person may benefit from mental health '
          + 'treatment, rather than on physical symptoms that would need urgent or emergency medical attention?',
      },
    ],
  },
  {
    key: 'stay-on-condition',
    batch_key: 'cbh-2026-10-page-review',
    title: 'Educational subsections stay on this condition',
    quote: 'The sections "When Stress Becomes a Concern" and "Common Causes and Triggers of Stress" appear to focus more on anxiety than stress and should be updated for better alignment.',
    kind: 'constraint',
    severity: 'Major',
    scope: { services: ['*'], programGroups: [], sections: ['educational'] },
    stages: ALL_STAGES,
    instruction: 'Every educational subsection must describe {condition} itself. The subsections on when it becomes a '
      + 'concern and on its causes and triggers must stay on {condition} and must not drift into describing a '
      + 'neighbouring condition (a stress page must not read as an anxiety page).',
    checks: [
      {
        type: 'review',
        question: 'Does every educational subsection describe {condition} itself, without drifting into describing a '
          + 'different condition (for example, anxiety on a stress page)?',
      },
    ],
  },
  {
    key: 'psychosis-residential-scope',
    batch_key: 'cbh-2026-10-program-scope',
    title: 'Psychosis: residential only, mild symptoms or post-stabilization',
    quote: 'We can accept someone with minor psychosis symptoms or after they have stabilized in a hospital setting. This distinction needs to be clear, though, and if we build them out, they should only be attached to our mental health residential locations.',
    kind: 'fact',
    severity: 'Critical',
    scope: { services: ['cbh_psychosis'], programGroups: ['mh-residential'], sections: [] },
    stages: ALL_STAGES,
    instruction: 'This page is for the residential mental health program. Clear Behavioral Health can accept people with '
      + 'mild psychosis symptoms, or people whose psychosis has first been stabilized in a hospital setting. It does not '
      + 'provide crisis, emergency or acute psychosis care. Make this distinction clear in the approach, service and FAQ '
      + 'sections, and never imply that CBH treats acute or severe psychosis or offers emergency stabilization.',
    checks: [
      {
        type: 'review',
        question: 'Does the page make clear that Clear Behavioral Health accepts people with mild psychosis symptoms, or '
          + 'after their psychosis has been stabilized in a hospital, and avoid presenting it as crisis or acute psychosis care?',
      },
    ],
  },
  {
    key: 'family-therapy-teen-iop',
    batch_key: 'cbh-2026-10-program-scope',
    title: 'Family therapy is part of Teen IOP, not billed to parents',
    quote: 'Family therapy is facilitated with the teen in our program and the parent(s). This is a core part of the teen program where family units work on communication skills, boundaries, and constructive ways to support each other. It is included as part of the teen\'s treatment plan, and we are not billing the insurance of the parents.',
    kind: 'fact',
    severity: 'Critical',
    scope: { services: ['cbh_family-therapy'], programGroups: ['teen'], sections: [] },
    stages: ALL_STAGES,
    instruction: 'Family therapy at Clear Behavioral Health is part of the Teen IOP program. Sessions are held with the '
      + 'teen in our program and their parent(s), and they are a core part of the teen program: the family works on '
      + 'communication skills, boundaries and constructive ways to support each other. It is included in the teen\'s '
      + 'treatment plan, and the parents\' insurance is not billed for it. Say so in the insurance section and any '
      + 'insurance FAQ instead of implying the family is billed separately. Do not present it as a standalone service '
      + 'for adults or couples.',
    checks: [
      {
        type: 'review',
        question: 'Does the page present family therapy as part of the Teen IOP program, held with the teen and their '
          + 'parent(s) and included in the teen\'s treatment plan, without implying the parents\' insurance is billed or '
          + 'that it is a standalone service for adults or couples?',
      },
    ],
  },
  {
    key: 'parent-support-teen-iop',
    batch_key: 'cbh-2026-10-program-scope',
    title: 'Parent support groups are weekly Teen IOP family groups, not billed to parents',
    quote: 'Parent support groups are offered for parents of the teens in our programs as a component of our multi-modal family groups. These are groups that are held once a week where the parents come and join a group session with their teen, as well as other teens in the program and their parents.',
    kind: 'fact',
    severity: 'Critical',
    scope: { services: ['cbh_parent-support-groups'], programGroups: ['teen'], sections: [] },
    stages: ALL_STAGES,
    instruction: 'Parent support groups are for parents of teens in our programs, as part of the multi-modal family '
      + 'groups in the Teen IOP program. They meet once a week: parents join a group session with their teen and the '
      + 'other teens and parents in the program, then parents and teens split into separate groups to talk about what '
      + 'came up or do their own exercise. Topics and exercises include communication, boundaries and process groups. '
      + 'They are included in the teen\'s treatment plan, and the parents\' insurance is not billed. Say so in the '
      + 'insurance section and any insurance FAQ. Do not present it as a standalone support group open to any parent.',
    checks: [
      {
        type: 'review',
        question: 'Does the page present parent support groups as weekly multi-family groups within the Teen IOP program '
          + '(a joint session with teens and parents, then separate teen and parent groups), included in the teen\'s '
          + 'treatment plan, without implying the parents\' insurance is billed or that the group is open to any parent?',
      },
    ],
  },
];

module.exports = { CBH_CLIENT_ID, BATCHES, RULES };
