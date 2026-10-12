// ── Draft rules from a pasted feedback batch ────────────────────────────────
// The SEO team pastes what the client said; one model call turns it into
// DRAFT rules in the cbhFeedback shape. Nothing it returns is live: every rule
// is saved as a draft for a person to edit, test on sample text and activate.
//
// Three kinds of output, because client feedback is three kinds of thing:
//   rules        new wording or service facts the pipeline can enforce
//   revisions    a change to a rule already in force (same key), applied by a
//                person from the batch rather than duplicated as a new rule
//   actionItems  what no rule can do: which services run at which locations,
//                the page's sections and limits, the CMS export. These need a
//                developer, and they stay on the batch, open, until one is done.

const config = require('./config');
const contract = require('./cbhContract');
const fb = require('./cbhFeedback');
const llmProviders = require('../services/llmProviders');
const { chatParams } = require('./llmParams');

const DRAFTER_MARKER = 'You turn a client\'s feedback on its web pages into enforceable content rules';

function systemPrompt() {
  return `${DRAFTER_MARKER} for ${contract.BRAND}, a behavioral health provider. The rules govern how Location + Service
pages are planned, written and checked. A person reviews every rule you draft before it goes live.

Return ONLY JSON:
{
  "rules": [RULE],
  "revisions": [{ "ruleKey": "key of a rule already in force", "rule": RULE }],
  "actionItems": ["one plain sentence each"]
}

RULE = {
  "key": "short-kebab-case-id",
  "title": "what the rule enforces, in a few words",
  "quote": "the client's own words this rule comes from, copied verbatim",
  "kind": "constraint | fact",
  "severity": "Critical | Major | Minor",
  "scope": { "services": ["*"] or [service ids], "programGroups": [] or [group keys], "sections": [] or [section keys] },
  "stages": ["brief", "writer", "regen"],
  "instruction": "what the planner and writer are told, as a direct instruction",
  "checks": [CHECK]
}

CHECK is one of:
  { "type": "forbid", "pattern": "regex", "unit": "field | sentence | faq", "when": "regex (optional)",
    "sections": [optional], "exceptSections": [optional], "message": "what is wrong when it fires" }
  { "type": "require", ...same fields... }
  { "type": "review", "question": "a yes/no question where YES means the page complies" }

How checks run:
- Patterns are JavaScript regexes, case-insensitive. Use word boundaries (\\b). Keep them NARROW: a pattern
  that also matches ordinary copy will fail good pages. Prefer the exact phrase the client objected to.
- forbid: any unit matching "pattern" (and "when", if given) fails.
- require with "when": every unit matching "when" must also match "pattern" (e.g. any sentence about
  medication must name the provider that offers it).
- require without "when": at least one unit in scope must match.
- unit "faq": "when" is tested on the question and "pattern" on the answer.
- Patterns may use {city}, {service}, {condition} and {brand}; they are filled in per page.
- Use a "review" check for anything a regex cannot judge (tone, accuracy, whether a section drifts to
  another condition). Add one only where it is needed: each costs a model call per page.

Choosing values:
- severity: Critical for a wrong claim about what the client offers or a clinical inaccuracy; Major for a
  wording rule the client stated; Minor for a preference.
- kind: "fact" for information about a service the writer must state; "constraint" for everything else.
- scope.services: ["*"] for every page, or the ids from the service list for specific pages.
- scope.programGroups: only when the rule belongs to one program (for example "teen").
- stages: "brief" if it affects which FAQs or subsections get planned; "writer" and "regen" if it affects
  the copy. Most rules need all three.
- Never use an em dash anywhere in your output.

Some feedback cannot be a rule, because it changes the system rather than the words:
- which services are offered at which locations,
- adding, removing or renaming a page section or a fixed heading, or changing a character limit,
- the CMS export or the page's structure,
- a check that neither a regex nor a review question can express.
Put each of these in "actionItems" as one plain sentence saying what has to change. If the same feedback
also has a wording side, write a rule for that part too.

If a feedback item refines a rule already in force, put it under "revisions" with that rule's key and the
full revised rule, instead of drafting a new one. Do not draft a rule that repeats one already in force.`;
}

function userPrompt({ batch, activeRules = [], vocab = {} }) {
  const services = (vocab.services || [])
    .map(s => `- ${s.id} | ${s.name} | ${(s.groups || []).join(', ')}`).join('\n');
  const existing = activeRules.length
    ? activeRules.map(r => `- ${r.key}: ${r.title}. ${r.instruction}`).join('\n')
    : '(none)';
  return `FEEDBACK BATCH: ${batch.title || '(untitled)'}${batch.received_at ? `, received ${batch.received_at}` : ''}

THE CLIENT'S FEEDBACK, VERBATIM
${batch.raw_text || ''}

SECTION KEYS
${fb.SECTIONS.join(', ')}
(A prefix covers every key under it: ${fb.SECTION_GROUPS.join(', ')}.)

PROGRAM GROUPS
${fb.PROGRAM_GROUPS.map(g => `- ${g}: ${fb.PROGRAM_LABELS[g]}`).join('\n')}

SERVICES (id | name | program groups)
${services || '(none)'}

RULES ALREADY IN FORCE
${existing}

Return JSON only.`;
}

function clean(rule) {
  // Em dashes are house style for everything the writer is shown, and the
  // instruction is shown to it verbatim.
  const r = { ...rule };
  ['title', 'quote', 'instruction'].forEach((k) => { if (r[k]) r[k] = contract.removeEmDashes(String(r[k])); });
  return r;
}

// `activeRules`: the rules the drafter must not duplicate (any status but
// retired). `vocab.serviceIds` validates scope; `vocab.services` is shown.
async function draftRules({ batch, activeRules = [], vocab = {} }) {
  const llm = llmProviders.createLlmClient(config.llm.cbhFeedbackDraftModel);
  const messages = [
    { role: 'system', content: systemPrompt() },
    { role: 'user', content: userPrompt({ batch, activeRules, vocab }) },
  ];
  let raw = null;
  for (let attempt = 0; attempt < 2 && !raw; attempt++) {
    const completion = await llm.chat.completions.create({
      model: llm.model,
      ...chatParams(llm.model, { maxTokens: 16000 }),
      response_format: { type: 'json_object' },
      messages,
    });
    try {
      const parsed = JSON.parse(completion.choices[0].message.content);
      if (parsed && typeof parsed === 'object') raw = parsed;
    } catch { /* retry once */ }
  }
  if (!raw) throw new Error('The rule drafter returned no usable JSON. Try again, or write the rules by hand.');

  const existingKeys = new Set(activeRules.map(r => r.key));
  const rules = [];
  const revisions = [];
  const rejected = [];
  const seen = new Set();

  const addRevision = (ruleKey, rule) => {
    if (!existingKeys.has(ruleKey)) return;
    const v = fb.validateRule(clean({ ...rule, key: ruleKey }), vocab);
    if (!v.ok) { rejected.push({ key: ruleKey, title: v.rule.title, errors: v.errors }); return; }
    if (revisions.some(x => x.ruleKey === ruleKey)) return;
    revisions.push({ ruleKey, rule: v.rule, applied: false });
  };

  (Array.isArray(raw.rules) ? raw.rules : []).forEach((rule) => {
    const v = fb.validateRule(clean(rule || {}), vocab);
    // The drafter re-proposing a rule already in force is a revision, not a
    // second copy of it.
    if (v.rule.key && existingKeys.has(v.rule.key)) { addRevision(v.rule.key, rule); return; }
    if (!v.ok) { rejected.push({ key: v.rule.key, title: v.rule.title, errors: v.errors }); return; }
    if (seen.has(v.rule.key)) return;
    seen.add(v.rule.key);
    rules.push({ ...v.rule, status: 'draft' });
  });

  (Array.isArray(raw.revisions) ? raw.revisions : []).forEach((x) => {
    if (x && x.ruleKey && x.rule) addRevision(String(x.ruleKey), x.rule);
  });

  const actionItems = (Array.isArray(raw.actionItems) ? raw.actionItems : [])
    .map(a => contract.removeEmDashes(String((a && a.text) || a || '').trim()))
    .filter(Boolean)
    .map(text => ({ text, status: 'open', note: '' }));

  return { rules, revisions, actionItems, rejected };
}

module.exports = { draftRules, systemPrompt, userPrompt, DRAFTER_MARKER };
