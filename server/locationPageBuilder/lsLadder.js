// ── Fallback section ladders (template §7 "Competitor Fallback Rule", §8) ────
// The template is emphatic that competitor coverage decides which H2s a page
// gets (§7 opening, §17). These ladders are what it calls the FALLBACK: the
// rungs to fall back on when competitor pages give too little to model, and
// the reference list the planner grades the scraped headings against.
//
// They are data, not prose inside a prompt, for the same reason the dental
// ladders are: the same rungs have to drive the planner prompt AND the
// code-side repair that runs when the model returns something unusable. A
// ladder described only in a prompt cannot repair anything.
//
// Nothing here names a brand or a city — a rung takes the page's service and
// returns a heading, and §7's location-flavoured variants ("Benefits of X in
// {LOCATION}") are deliberately NOT baked in: the planner decides which single
// block carries the city, and localizing every heading is exactly the
// near-duplicate page §13.13 forbids.

const { isPluralName } = require('./dentalOutline');

// ── Grammar ────────────────────────────────────────────────────────────────
// isPluralName is imported: "does this noun phrase end in a plural noun" is
// general English and already solved. The MASS-NOUN vocabulary below is NOT
// shared, and deliberately so — dentalOutline's list is tuned to a dental
// catalogue and does not cover this vertical ("Anxiety Therapy" would take an
// article and render "What Is an Anxiety Therapy?"). Widening the dental one
// would change headings on every existing Gentle Dental page, which is a
// bigger change than keeping two short lists.
const MASS_NOUN_RE = /(ing|istry|ics|ery|ry|ment|health|care|hygiene|apnea|therapy|counseling|counselling|treatment|rehab|rehabilitation|support|wellness|medicine|psychiatry|psychology|detox|recovery)$/i;

// Condition names are the other half of this vertical's vocabulary, and almost
// all of them are uncountable in the phrasing the ladders use: "What Is
// Depression?", "What Is Anxiety?", "What Is Grief?", "What Is Bipolar
// Disorder?" — never "a Depression". Rather than list every condition, match
// the abstract-noun suffixes that make a word uncountable, plus the handful of
// bare nouns that carry no suffix at all. Acronym conditions (PTSD, OCD, ADHD)
// are already handled by isAcronym.
const ABSTRACT_NOUN_RE = /(ion|ty|ness|ia|ism|osis|itis|ance|ence|ude|sis|phobia|algia)$/i;
const MASS_NOUN_WORDS = new Set([
  'disorder', 'grief', 'loss', 'stress', 'trauma', 'burnout', 'pain', 'anger',
  'insomnia', 'abuse', 'use', 'sleep', 'mood', 'fatigue', 'guilt', 'shame',
  'withdrawal', 'relapse', 'wellbeing', 'esteem',
]);

function isProperName(name) {
  return /[®™]/.test(String(name || ''));
}

function lastWord(name) {
  return String(name || '').trim().split(/\s+/).pop() || '';
}

// Acronym services ("PHP", "IOP", "TMS", "ADHD") are read letter by letter, so
// they behave like proper nouns: "What Is IOP?", never "What Is an IOP?".
function isAcronym(name) {
  const word = lastWord(name).replace(/[^A-Za-z]/g, '');
  return word.length >= 2 && word.length <= 5 && word === word.toUpperCase();
}

function needsArticle(name, plural) {
  if (plural || isProperName(name) || isAcronym(name)) return false;
  const word = lastWord(name).replace(/[^a-z]/gi, '');
  if (MASS_NOUN_WORDS.has(word.toLowerCase())) return false;
  return !MASS_NOUN_RE.test(word) && !ABSTRACT_NOUN_RE.test(word);
}

function articleFor(name) {
  return /^[aeiou]/i.test(String(name || '').trim()) ? 'an' : 'a';
}

// The service name as it reads inside a sentence: "a Psychiatric Evaluation",
// but "Anxiety Therapy" (mass), "Group Sessions" (plural), "IOP" (acronym).
function withArticle(name, plural) {
  return needsArticle(name, plural) ? `${articleFor(name)} ${name}` : name;
}

function whatIsRung(name, plural) {
  return plural ? `What Are ${name}?` : `What Is ${withArticle(name, plural)}?`;
}

// ── Service name vs condition name ─────────────────────────────────────────
// The template keeps {{SERVICE_NAME}} and {{CONDITION}} as separate variables
// throughout §7, and the difference is not cosmetic: a service row is named
// "Anxiety Treatment", so a condition rung built from the service name reads
// "Symptoms of Anxiety Treatment" and "Treatment Options for Anxiety
// Treatment" — headings that are not about anything a patient searches for.
//
// The condition comes from the service's own conditions_treated reference data
// where the SEO team has entered it, and otherwise from the service name with
// its service words removed ("Anxiety Treatment" -> "Anxiety"). Falls back to
// the service name itself, so a row with neither still produces English.
const SERVICE_WORD_RE = /\b(treatment|treatments|therapy|therapies|counseling|counselling|care|program|programs|programme|programmes|management|services|service|rehab|rehabilitation|center|centre|clinic|support|sessions)\b/gi;

function stripServiceWords(name) {
  return String(name || '').replace(SERVICE_WORD_RE, ' ').replace(/\s+/g, ' ').trim();
}

function conditionNameOf(service = {}) {
  const listed = (service.conditions_treated || []).find(c => String(c || '').trim());
  if (listed) return String(listed).trim();
  return stripServiceWords(service.name) || service.name || 'This Condition';
}

// Everything a rung can need, computed once. Rungs take this context object
// rather than positional arguments: they need the service name, the condition
// name and the agreement of both, and five positional parameters is how you
// get a ladder where nobody can tell what `(s, p, a, c, cp)` meant.
function ladderContext(service = {}) {
  const name = service.name || 'This Service';
  const condition = conditionNameOf(service);
  return {
    name,
    plural: isPluralName(name),
    article: articleFor(name),
    condition,
    conditionPlural: isPluralName(condition),
  };
}

// ── The ladders ────────────────────────────────────────────────────────────
// One per service SHAPE, because the template's own fallback sections split
// along that line: §7's "Symptoms of {CONDITION}" and "What Causes
// {CONDITION}?" only parse for a condition page, while "Signs You May Need
// {SERVICE_NAME}" is the service-page form of the same rung.
//
// Rung order follows §7's numbering: what it is, who it is for, why it
// happens, what the options are, how it helps, when to act.
const CONDITION_LADDER = [
  c => whatIsRung(c.condition, c.conditionPlural),
  c => `Symptoms of ${c.condition}`,
  c => `What Causes ${c.condition}?`,
  c => `Types of ${c.condition}`,
  c => `Treatment Options for ${c.condition}`,
  c => `When Should You Seek Professional Help for ${c.condition}?`,
  c => `What to Expect From ${c.name}`,
];

const SERVICE_LADDER = [
  c => whatIsRung(c.name, c.plural),
  c => `Signs You May Need ${withArticle(c.name, c.plural)}`,
  c => `How Does ${withArticle(c.name, c.plural)} Work?`,
  c => `Types of ${c.name}`,
  c => `Benefits of ${withArticle(c.name, c.plural)}`,
  c => `Who May Benefit From ${withArticle(c.name, c.plural)}?`,
  () => 'What to Expect at Your First Appointment',
];

// Medication management is neither a condition nor a talk therapy: the reader
// wants to know what the medicine does, who prescribes it, and what oversight
// looks like. Safety and side effects belong on the ladder here and nowhere
// else — §13.21 forbids inventing clinical claims, so the rung exists to be
// written factually rather than skipped.
const MEDICATION_LADDER = [
  c => whatIsRung(c.name, c.plural),
  c => `Who May Benefit From ${withArticle(c.name, c.plural)}?`,
  c => `How ${c.name} Works`,
  () => 'What to Expect at Your First Appointment',
  () => 'Safety, Side Effects and Monitoring',
  () => 'Working With Your Care Team',
  c => `Conditions ${c.name} Can Support`,
];

// A programme page is about a course of care with a shape — who is eligible,
// what the steps are, how long it runs, what happens afterwards.
const PROGRAM_LADDER = [
  c => whatIsRung(c.name, c.plural),
  c => `Who Is ${withArticle(c.name, c.plural)} For?`,
  c => `What Happens During ${c.name}`,
  () => 'How Long Does Treatment Last?',
  () => 'Levels of Care and Alternatives',
  () => 'Life After Treatment',
  c => `Benefits of ${withArticle(c.name, c.plural)}`,
];

// A practitioner page names a PERSON, so none of the rungs above parse on it.
// Same reasoning as dentalOutline's practitioner ladder, different questions.
const PRACTITIONER_LADDER = [
  c => `What Does ${c.article} ${c.name} Do?`,
  c => `When Should You See ${c.article} ${c.name}?`,
  c => `Conditions ${c.name}s Treat`,
  () => 'What to Expect at Your First Appointment',
  c => `How to Choose ${c.article} ${c.name}`,
  c => `Do You Need a Referral to See ${c.article} ${c.name}?`,
  () => 'Insurance and Payment Options',
];

// Matched on the service NAME first, then on its `category` — a category typo
// must not silently put condition rungs ("Symptoms of…", "What Causes…?") on a
// practitioner or programme page, where they do not parse at all.
const PRACTITIONER_RE = /(?:ist|surgeon|hygienist|therapist|counselor|counsellor|practitioner|doctor|physician)$/i;
const PROGRAM_RE = /\b(program|programme|php|iop|partial hospitalization|intensive outpatient|inpatient|outpatient|residential|detox|rehab)\b/i;

function isPractitionerName(name) {
  return PRACTITIONER_RE.test(lastWord(name).replace(/[^a-z]/gi, ''));
}

function pickLadder(service = {}) {
  const name = service.name || '';
  // Checked first: "Psychiatrist" would also match the medication category on
  // a mis-tagged row, and the medication ladder is just as wrong for a person.
  if (isPractitionerName(name)) return PRACTITIONER_LADDER;
  if (PROGRAM_RE.test(name)) return PROGRAM_LADDER;
  const category = String(service.category || '').toLowerCase();
  if (category === 'condition') return CONDITION_LADDER;
  if (category === 'medication') return MEDICATION_LADDER;
  if (category === 'procedure' || category === 'program') return PROGRAM_LADDER;
  return SERVICE_LADDER;
}

function ladderHeadings(service = {}) {
  const ctx = ladderContext(service);
  return pickLadder(service).map(fn => fn(ctx));
}

// Template §8's list, verbatim in intent: extra topics a page MAY carry when
// competitors cover them. Shown to the planner as candidates it may choose
// from — §8 is explicit that they must NOT all be added automatically, so
// they are never used by the code-side repair, only offered to the model.
const SERVICE_SPECIFIC_TOPICS = [
  'Treatment Process', 'How Treatment Works', 'What to Expect', 'Diagnosis',
  'Treatment Approaches', 'Therapy Options', 'Procedure Steps', 'Benefits',
  'Recovery', 'Aftercare', 'Preparation', 'Candidates', 'Eligibility',
  'Prevention', 'Technology Used', 'Duration of Treatment', 'Levels of Care',
  'Insurance and Payment', 'Related Services',
];

module.exports = {
  ladderHeadings, pickLadder, ladderContext, conditionNameOf, stripServiceWords,
  SERVICE_SPECIFIC_TOPICS,
  isPractitionerName, needsArticle, withArticle, whatIsRung, isAcronym,
  CONDITION_LADDER, SERVICE_LADDER, MEDICATION_LADDER, PROGRAM_LADDER,
  PRACTITIONER_LADDER,
};
