// ── Prompt set vocabulary and lifecycle rules ───────────────────────────────
//
// Pure — no database, no LLM client — so `store.js` can require this without
// pulling in `llmProviders`, and so the rules below are unit-testable without
// Supabase.
//
// The lifecycle mirrors modules/projects/recommendations.js on purpose: this
// product already has one "draft you write / somebody approves / a material
// edit revokes the approval" idiom, and a prompt set becoming reviewable
// should not invent a second one.
//
//   draft ──▶ approved ──▶ retired
//       └───▶ rejected ──▶ draft (re-proposed)
//                          retired ──▶ approved (restored)
//
// Only 'approved' prompts are ever measured (run.js enforces that; this file
// only says which moves are legal). 'rejected' and 'retired' are kept
// distinct on purpose: rejected means "this was never a good question",
// retired means "this was measured and we stopped" — collapsing them loses
// the ability to tell a reviewer "you already turned this phrasing down".

const STATUSES = ['draft', 'approved', 'rejected', 'retired'];

// from -> { to: capability required }
// The capability is checked by the caller (store.transitionPrompt is handed
// an access context that already knows the role) — asking twice is how two
// answers drift apart, per recommendations.js's own note on this.
const TRANSITIONS = {
  draft: { approved: 'editProjectSettings', rejected: 'editProjectSettings' },
  approved: { retired: 'editProjectSettings', draft: 'editProjectSettings' },
  rejected: { draft: 'editProjectSettings' },
  retired: { approved: 'editProjectSettings' },
};

// Editing the TEXT of an approved prompt revokes the approval — an approval
// covers specific words, and letting those change underneath it makes the
// approval meaningless, and here it also means money (0016's whole premise is
// that a trend is only meaningful against a stable, chosen set). slot/intent/
// rationale describe the prompt rather than being the question itself, so
// editing them does not revoke anything.
const MATERIAL_FIELDS = ['text'];

// Intent slots — "how the question is asked". Weight is this slot's share of
// the count budget at generation time; minCount/maxCount
// bound it regardless of weight. allowBrand marks the two slots where naming
// the brand is the point (a comparison or "alternatives to X" question is
// legitimately about the brand) — everywhere else a brand mention proves
// nothing about visibility, because the answer is about whatever was asked.
const SLOTS = {
  category_commercial: {
    label: 'Category — buying intent', weight: 5, intent: 'commercial', allowBrand: false, requires: [], minCount: 0, maxCount: null,
  },
  cluster_informational: {
    label: 'Topic — informational', weight: 4, intent: 'informational', allowBrand: false, requires: ['clusters'], minCount: 0, maxCount: null,
  },
  cost_pricing: {
    label: 'Cost & pricing', weight: 3, intent: 'commercial', allowBrand: false, requires: [], minCount: 0, maxCount: null,
  },
  local_geo: {
    label: 'Local', weight: 3, intent: 'commercial', allowBrand: false, requires: ['geo'], minCount: 0, maxCount: null,
  },
  comparison: {
    label: 'Head-to-head comparison', weight: 2, intent: 'comparison', allowBrand: true, requires: ['competitors'], minCount: 0, maxCount: 3,
  },
  navigational_alternatives: {
    label: 'Alternatives & reviews', weight: 2, intent: 'navigational', allowBrand: true, requires: ['competitors'], minCount: 0, maxCount: 3,
  },
  demand_verbatim: {
    label: 'Real search demand', weight: 1, intent: 'informational', allowBrand: false, requires: ['demand'], minCount: 0, maxCount: null,
  },
};

const SLOT_IDS = Object.keys(SLOTS);
const SLOT_LABEL = Object.fromEntries(SLOT_IDS.map((id) => [id, SLOTS[id].label]));

const INTENTS = ['commercial', 'informational', 'navigational', 'comparison'];

// Legacy source vocabulary from 0016. SOURCES.CATEGORY's value is genuinely
// 'competitor', not a typo here — it is in a live CHECK constraint and in
// existing rows, so it cannot change. SOURCE_LABELS exists so the UI never has
// to show that string to a person.
const SOURCES = {
  MANUAL: 'manual', CLUSTER: 'cluster', KEYWORD: 'keyword', CATEGORY: 'competitor',
};
const SOURCE_LABELS = {
  manual: 'Added by hand',
  cluster: 'Topic cluster',
  keyword: 'Keyword demand',
  competitor: 'Category / competitive set',
};

// Topic axis — "what the question is about". A page-backed topic carries a
// target_url; gap/service/brand topics do not, and that absence is itself the
// finding (there is no page for this topic yet, or the question is about the
// company rather than a subject).
const TOPIC_KINDS = ['page', 'cluster', 'gap', 'service', 'brand'];

// The provider's own cap (dataForSeoClient.MAX_PROMPT_CHARS) is the ceiling —
// re-declared here rather than required, so this file stays dependency-free
// for store.js. Both must move together; a test pins that they agree.
const MAX_PROMPT_CHARS = 500;
const MIN_PROMPT_CHARS = 4;

/**
 * Same normalisation the live unique index uses (0017's expression index),
 * so the two can never disagree the way 0016's index and this function did.
 */
function normalise(text) {
  return String(text || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Whether `next` is reachable from `current`, and what capability it needs.
 * Pure, so the rules are testable without a database or a session — mirrors
 * recommendations.transitionFor exactly.
 */
function transitionFor(current, next) {
  const allowed = TRANSITIONS[current];
  if (!allowed) return { ok: false, reason: `Unknown status: ${current}.` };
  const capability = allowed[next];
  if (!capability) {
    const options = Object.keys(allowed);
    return {
      ok: false,
      reason: options.length
        ? `A ${current} prompt can only move to: ${options.join(', ')}.`
        : `A ${current} prompt is final and cannot change status.`,
    };
  }
  return { ok: true, capability };
}

/** Does this patch change the question itself, as opposed to its metadata? */
function isMaterialChange(existing, patch) {
  return MATERIAL_FIELDS.some(
    (field) => patch[field] !== undefined && String(patch[field]) !== String(existing[field] ?? ''),
  );
}

function invalid(message, code) {
  return Object.assign(new Error(message), { status: 400, code });
}

/**
 * The validation 0016 never had. Throws `{status: 400, code}` so the route's
 * existing handleError passes it straight through — the same shape a bad
 * request already produces elsewhere in this module.
 *
 * Deliberately does NOT enforce the brand-exclusion rule or check for
 * near-duplicates — those need brand/competitor context and the existing set,
 * which is generation-time work (promptValidator.js). This is the cheap,
 * always-applicable shape check every prompt must pass regardless of source.
 */
function validatePrompt(input) {
  const text = String(input?.text ?? '').trim();
  if (!text) throw invalid('A prompt needs text.', 'empty_prompt');
  if (text.length < MIN_PROMPT_CHARS) {
    throw invalid(`Prompt is too short to be a real question (min ${MIN_PROMPT_CHARS} characters).`, 'prompt_too_short');
  }
  if (text.length > MAX_PROMPT_CHARS) {
    throw invalid(`Prompt is ${text.length} characters; the surfaces that measure it take at most ${MAX_PROMPT_CHARS}.`, 'prompt_too_long');
  }
  if (/[\r\n]/.test(text)) throw invalid('A prompt must be a single line.', 'prompt_too_long');

  const source = input?.source || SOURCES.MANUAL;
  if (!Object.values(SOURCES).includes(source)) {
    throw invalid(`Unknown source: ${source}. Known sources: ${Object.values(SOURCES).join(', ')}.`, 'bad_source');
  }

  let intent = input?.intent ?? null;
  if (intent != null && !INTENTS.includes(intent)) {
    throw invalid(`Unknown intent: ${intent}. Known intents: ${INTENTS.join(', ')}.`, 'bad_intent');
  }

  let slot = input?.slot ?? null;
  if (slot != null && !SLOT_IDS.includes(slot)) {
    throw invalid(`Unknown slot: ${slot}. Known slots: ${SLOT_IDS.join(', ')}.`, 'bad_slot');
  }

  let topicKind = input?.topicKind ?? null;
  if (topicKind != null && !TOPIC_KINDS.includes(topicKind)) {
    throw invalid(`Unknown topic kind: ${topicKind}. Known kinds: ${TOPIC_KINDS.join(', ')}.`, 'bad_topic_kind');
  }

  let demandVolume = input?.demandVolume ?? null;
  if (demandVolume != null) {
    demandVolume = Number(demandVolume);
    if (!Number.isFinite(demandVolume) || demandVolume < 0) {
      throw invalid('demandVolume must be a non-negative number, or omitted when unknown.', 'bad_demand_volume');
    }
  }

  return {
    text,
    source,
    sourceRef: input?.sourceRef ? String(input.sourceRef).slice(0, 200) : null,
    intent,
    slot,
    rationale: input?.rationale ? String(input.rationale).slice(0, 500) : null,
    topicKind,
    topicLabel: input?.topicLabel ? String(input.topicLabel).slice(0, 200) : null,
    targetUrl: input?.targetUrl ? String(input.targetUrl).slice(0, 2000) : null,
    demandVolume,
    demandSource: input?.demandSource ? String(input.demandSource).slice(0, 60) : null,
  };
}

module.exports = {
  STATUSES,
  TRANSITIONS,
  MATERIAL_FIELDS,
  SLOTS,
  SLOT_IDS,
  SLOT_LABEL,
  INTENTS,
  SOURCES,
  SOURCE_LABELS,
  TOPIC_KINDS,
  MAX_PROMPT_CHARS,
  MIN_PROMPT_CHARS,
  normalise,
  transitionFor,
  isMaterialChange,
  validatePrompt,
};
